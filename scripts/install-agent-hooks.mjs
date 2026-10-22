#!/usr/bin/env node
// One-step install of the terminal-web agent hooks for Claude Code, Codex, Kimi Code, qwen-code and opencode.
//
//   node scripts/install-agent-hooks.mjs            install (or refresh) all of them
//   node scripts/install-agent-hooks.mjs --check    report what is installed and whether the server answers
//   node scripts/install-agent-hooks.mjs --uninstall
// Options: --only=claude|codex|kimi|qwen|opencode   --url=http://HOST:PORT   --claude-dir=DIR (repeatable)
//
// Safe to run repeatedly. It only adds or removes its own entries — hooks whose
// command runs ~/.terminal-web/agent-hook.sh, and the cli.json plugin entry that
// points at ~/.terminal-web/opencode-status — and backs up every file it
// changes to <file>.bak-terminal-web first (once — the copy is the original). Agent sessions already running pick
// the hooks up when restarted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const HOOK_DIR = path.join(HOME, '.terminal-web');
// Windows has no /bin/sh for the agents to run the shell script with: there the
// hook is its Node twin, run by node on PATH in the agent's shell.
const WINDOWS = process.platform === 'win32';
const HOOK_SCRIPT = path.join(HOOK_DIR, WINDOWS ? 'agent-hook.mjs' : 'agent-hook.sh');
const HOOK_ENV = path.join(HOOK_DIR, 'agent-hook.env');
const MARK = /[/\\]\.terminal-web[/\\]agent-hook\.(sh|mjs)/;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = option('only');
const wants = (agent) => !only || only === agent;

// Events used by terminal-web to track working, waiting and completed turns.
const CLAUDE_EVENTS = [
  ['UserPromptSubmit'], ['PreToolUse', '*'], ['PostToolUse', '*'], ['PostToolUseFailure', '*'],
  ['PermissionRequest', '*'], ['Notification'], ['Stop'], ['StopFailure'], ['PostCompact'], ['SessionEnd'],
];
// qwen-code reads its hooks from settings.json exactly like Claude Code — same
// event names, same `{ matcher, hooks }` shape, and user-level command hooks are
// enabled by default with no trust entry — so it reuses Claude's event list.
const QWEN_EVENTS = CLAUDE_EVENTS;
const CODEX_EVENTS = [
  ['UserPromptSubmit', 'user_prompt_submit'], ['PreToolUse', 'pre_tool_use'], ['PostToolUse', 'post_tool_use'],
  ['PermissionRequest', 'permission_request'], ['Stop', 'stop'], ['Interrupt', 'interrupt'],
];
// Kimi Code reads its hooks from [[hooks]] tables in config.toml. It treats
// `matcher` as a regular expression (Claude's "*" would be invalid) and refuses
// a file with any key beyond event / command / timeout, so ours carry none.
const KIMI_EVENTS = [
  'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Stop', 'StopFailure',
];
// opencode 2 dropped command hooks: status comes from a CLI plugin we register
// below. It reports the same events itself, so there is only one thing to count.
const OPENCODE_PLUGINS = 1;

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
// Forward slashes on Windows too: both agents hand the command to a shell that
// would read backslashes as escapes.
const slashed = (p) => p.replace(/\\/g, '/');
const command = (agent, event) => WINDOWS
  // A quoted executable at the start fails in PowerShell and cmd /s /c.
  // Node is already required on PATH to run the supported agents on Windows.
  ? `node "${slashed(HOOK_SCRIPT)}" ${agent} ${event}`
  : `/bin/sh ${quote(HOOK_SCRIPT)} ${agent} ${event}`;
const ownHook = (hook) => typeof hook?.command === 'string' && MARK.test(hook.command);
const ours = (group) => (group?.hooks ?? []).some(ownHook);

// A group may contain other tools' hooks alongside ours. Keep those hooks and
// the group's matcher/metadata when refreshing or uninstalling our commands.
export function removeOwnHooks(groups) {
  return groups.flatMap(group => {
    if (!ours(group)) return [group];
    const hooks = group.hooks.filter(hook => !ownHook(hook));
    return hooks.length ? [{ ...group, hooks }] : [];
  });
}

export function qwenCheckRequired(onlyAgent, available) {
  return onlyAgent === 'qwen' || (!onlyAgent && available);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`${file} is not valid JSON — fix or move it, then run again (${error.message})`);
  }
}

/** Keep the file as it was before our first change; later runs leave that copy alone. */
function backup(file) {
  const copy = `${file}.bak-terminal-web`;
  if (fs.existsSync(file) && !fs.existsSync(copy)) fs.copyFileSync(file, copy);
}

/** Write through a temp file, keeping the target's mode (config.toml holds API keys); new files start private. */
function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const mode = fs.statSync(file, { throwIfNoEntry: false })?.mode ?? 0o600;
  try {
    fs.writeFileSync(temp, text, { mode });
    fs.chmodSync(temp, mode & 0o777); // writeFileSync's mode is masked by umask
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Where the server is, and its token.
// ---------------------------------------------------------------------------
function dotEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(REPO, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no .env */ }
  return { ...env, ...process.env };
}

function tokenFile(env) {
  return path.resolve(env.AUTH_TOKEN_FILE?.trim() || path.join(HOME, '.config/terminal-web/auth-token'));
}

async function probe(url, token) {
  try {
    const res = await fetch(`${url}/api/agent-status`, {
      headers: { cookie: `tw_auth=${token}` }, signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function findServer(env, token) {
  const port = env.PORT || '8090';
  const hosts = [];
  if (option('url')) return { url: option('url').replace(/\/+$/, ''), status: await probe(option('url'), token) };
  if (env.TERMINAL_WEB_URL) hosts.push(env.TERMINAL_WEB_URL.replace(/\/+$/, ''));
  if (env.HOST && !['0.0.0.0', '::'].includes(env.HOST)) hosts.push(`http://${env.HOST}:${port}`);
  try {
    const saved = fs.readFileSync(HOOK_ENV, 'utf8').match(/^TERMINAL_WEB_URL='([^'\r\n]+)'/m)?.[1];
    if (saved) hosts.push(saved.replace(/\/+$/, ''));
  } catch { /* no previous installation */ }
  hosts.push(`http://127.0.0.1:${port}`);
  try {
    const ts = execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 3000 }).split('\n')[0].trim();
    if (ts) hosts.push(`http://${ts}:${port}`);
  } catch { /* no tailscale */ }
  for (const url of hosts) {
    const status = await probe(url, token);
    if (status) return { url, status };
  }
  return { url: hosts[0], status: null };
}

// ---------------------------------------------------------------------------
// Claude Code: settings.json in every config dir — ~/.claude, $CLAUDE_CONFIG_DIR
// and any ~/.claude-* that has been used as one (a wrapper such as
// `CLAUDE_CONFIG_DIR=~/.claude-relay claude` keeps a second one).
// ---------------------------------------------------------------------------
function claudeDirs() {
  const given = args.filter(a => a.startsWith('--claude-dir=')).map(a => path.resolve(a.slice(13).replace(/^~(?=\/|$)/, HOME)));
  if (given.length) return given;
  const dirs = new Set([path.join(HOME, '.claude')]);
  if (process.env.CLAUDE_CONFIG_DIR) dirs.add(path.resolve(process.env.CLAUDE_CONFIG_DIR));
  for (const name of fs.readdirSync(HOME)) {
    const dir = path.join(HOME, name);
    if (/^\.claude[-_.]/.test(name) && fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() &&
        (fs.existsSync(path.join(dir, 'settings.json')) || fs.existsSync(path.join(dir, 'projects')))) dirs.add(dir);
  }
  return [...dirs].filter(dir => fs.existsSync(dir));
}

function claudeHooks(claudeSettings, install) {
  const settings = readJson(claudeSettings, {});
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = removeOwnHooks(hooks[event]);
    if (!hooks[event].length) delete hooks[event];
  }
  if (install) {
    for (const [event, matcher] of CLAUDE_EVENTS) {
      const group = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: command('claude', event), timeout: 5 }] };
      (hooks[event] ??= []).push(group);
    }
  }
  settings.hooks = hooks;
  if (!Object.keys(hooks).length) delete settings.hooks;
  backup(claudeSettings);
  writeFile(claudeSettings, `${JSON.stringify(settings, null, 2)}\n`);
}

function claudeInstalled(claudeSettings) {
  const hooks = readJson(claudeSettings, {}).hooks ?? {};
  return CLAUDE_EVENTS.filter(([event]) => (hooks[event] ?? []).some(ours)).length;
}

// ---------------------------------------------------------------------------
// qwen-code: the same settings.json `hooks` shape as Claude Code, but in a single
// file (~/.qwen/settings.json unless $QWEN_HOME). No trust entry: user-level
// command hooks are enabled by default.
// ---------------------------------------------------------------------------
function qwenHooksUpdate(install) {
  if (!fs.existsSync(qwenSettings) && !install) return;
  const settings = readJson(qwenSettings, {});
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = removeOwnHooks(hooks[event]);
    if (!hooks[event].length) delete hooks[event];
  }
  if (install) {
    for (const [event, matcher] of QWEN_EVENTS) {
      const group = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: command('qwen', event), timeout: 5 }] };
      (hooks[event] ??= []).push(group);
    }
  }
  settings.hooks = hooks;
  if (!Object.keys(hooks).length) delete settings.hooks;
  backup(qwenSettings);
  writeFile(qwenSettings, `${JSON.stringify(settings, null, 2)}\n`);
}

function qwenInstalled() {
  const hooks = readJson(qwenSettings, {}).hooks ?? {};
  return QWEN_EVENTS.filter(([event]) => (hooks[event] ?? []).some(ours)).length;
}

// ---------------------------------------------------------------------------
// Codex: hooks.json plus a trust entry per hook in config.toml — Codex will not
// run a hook whose hash it has not been told to trust.
// ---------------------------------------------------------------------------
const codexHome = process.env.CODEX_HOME || path.join(HOME, '.codex');
const codexHooks = path.join(codexHome, 'hooks.json');
const codexConfig = path.join(codexHome, 'config.toml');
// Kimi Code keeps one config.toml per data root: ~/.kimi-code unless KIMI_CODE_HOME says otherwise.
const kimiConfig = path.join(process.env.KIMI_CODE_HOME || path.join(HOME, '.kimi-code'), 'config.toml');
// qwen-code keeps its settings in ~/.qwen unless $QWEN_HOME says otherwise.
// Mirrors qwen-code's own resolution: `~` alone or `~/…` expands, anything else
// resolves from the current working directory.
function qwenHome() {
  const configured = process.env.QWEN_HOME;
  if (!configured) return path.join(HOME, '.qwen');
  if (configured === '~') return HOME;
  if (configured.startsWith('~/') || configured.startsWith('~\\')) return path.join(HOME, configured.slice(2));
  return path.resolve(configured);
}
const qwenSettings = path.join(qwenHome(), 'settings.json');
// opencode 2 has no command hooks. Its status comes from a CLI (TUI) plugin
// registered in cli.json: the TUI runs inside the pane, so TMUX_PANE names the
// right pane there. opencode loads a CLI plugin from a package directory with a
// `./tui` export, so scripts/opencode-status is copied to ~/.terminal-web whole.
const opencodeConfigDir = path.join(
  path.resolve(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config')), 'opencode');
const opencodeCli = path.join(opencodeConfigDir, 'cli.json');
const OPENCODE_PLUGIN = path.join(HOOK_DIR, 'opencode-status');
const OPENCODE_PLUGIN_URL = pathToFileURL(OPENCODE_PLUGIN).href;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  }
  return value;
}

/** Codex's trusted_hash: sha256 of the canonical JSON of the event and its handler. */
function codexHash(label, handler) {
  const identity = { event_name: label, hooks: [{ type: 'command', command: handler.command, timeout: handler.timeout, async: false }] };
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical(identity))).digest('hex')}`;
}

const codexTimeout = (label) => label === 'interrupt' ? 3 : 5;

/** Drop every [hooks.state."…"] table that trusts one of our hashes. */
function withoutOurTrust(toml) {
  const ourHashes = new Set(CODEX_EVENTS.flatMap(([event, label]) => {
    const commands = [command('codex', event)];
    // Refresh trust from the old Windows command as well when upgrading.
    if (WINDOWS) commands.push(`"${slashed(process.execPath)}" "${slashed(HOOK_SCRIPT)}" codex ${event}`);
    return commands.map(command => codexHash(label, { command, timeout: codexTimeout(label) }));
  }));
  const out = [];
  let block = null;
  const flush = () => {
    if (block && !block.some(line => [...ourHashes].some(h => line.includes(h)))) out.push(...block);
    block = null;
  };
  for (const line of toml.split('\n')) {
    if (/^\s*\[/.test(line)) {
      flush();
      if (/^\s*\[hooks\.state\.["']/.test(line)) { block = [line]; continue; }
    }
    if (block) block.push(line);
    else out.push(line);
  }
  flush();
  return out.join('\n');
}

function codexHooksUpdate(install) {
  const data = readJson(codexHooks, { hooks: {} });
  const hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {};
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    hooks[event] = removeOwnHooks(hooks[event]);
    if (!hooks[event].length) delete hooks[event];
  }
  const trust = [];
  if (install) {
    const source = fs.realpathSync(codexHome);
    for (const [event, label] of CODEX_EVENTS) {
      const handler = { type: 'command', command: command('codex', event), timeout: codexTimeout(label) };
      const list = (hooks[event] ??= []);
      list.push({ hooks: [handler] });
      trust.push(`[hooks.state.${JSON.stringify(`${path.join(source, 'hooks.json')}:${label}:${list.length - 1}:0`)}]`,
        'enabled = true', `trusted_hash = "${codexHash(label, handler)}"`);
    }
  }
  backup(codexHooks);
  writeFile(codexHooks, `${JSON.stringify({ hooks }, null, 2)}\n`);
  const toml = fs.existsSync(codexConfig) ? fs.readFileSync(codexConfig, 'utf8') : '';
  let next = withoutOurTrust(toml).replace(/\n+$/, '\n');
  if (trust.length) next += `${next.trim() ? '\n' : ''}${trust.join('\n')}\n`;
  if (next !== toml) {
    backup(codexConfig);
    writeFile(codexConfig, next);
  }
}

function codexInstalled() {
  const hooks = readJson(codexHooks, { hooks: {} }).hooks ?? {};
  return CODEX_EVENTS.filter(([event]) => (hooks[event] ?? []).some(ours)).length;
}

// ---------------------------------------------------------------------------
// Kimi Code: [[hooks]] tables in config.toml, carried only event / command /
// timeout. The file is TOML with other things in it, so this edits it line by
// line instead of re-serialising it, and leaves every table it does not own.
// ---------------------------------------------------------------------------
const tomlString = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The [[hooks]] tables, each as its lines. Kimi's four keys are all single-line. */
function kimiTables(toml) {
  const tables = [];
  let table = null;
  for (const line of toml.split('\n')) {
    if (/^\s*\[/.test(line)) {
      if (table) tables.push(table);
      table = /^\s*\[\[hooks\]\]\s*$/.test(line) ? [line] : null;
    } else if (table) table.push(line);
  }
  if (table) tables.push(table);
  return tables;
}

const kimiOurs = (table) => table.some(line => MARK.test(line));

function withoutOurKimiHooks(toml) {
  const out = [];
  let table = null;
  const flush = () => {
    if (table && !kimiOurs(table)) out.push(...table);
    table = null;
  };
  for (const line of toml.split('\n')) {
    if (/^\s*\[/.test(line)) {
      flush();
      if (/^\s*\[\[hooks\]\]\s*$/.test(line)) { table = [line]; continue; }
    }
    if (table) table.push(line);
    else out.push(line);
  }
  flush();
  return out.join('\n');
}

function kimiHooksUpdate(install) {
  const exists = fs.existsSync(kimiConfig);
  if (!exists && !install) return;
  const toml = exists ? fs.readFileSync(kimiConfig, 'utf8') : '';
  const eol = toml.includes('\r\n') ? '\r\n' : '\n';
  let body = withoutOurKimiHooks(toml).replace(/\s+$/, '');
  if (install) {
    const blocks = KIMI_EVENTS.map(event => [
      '[[hooks]]',
      `event = ${tomlString(event)}`,
      `command = ${tomlString(command('kimi', event))}`,
      'timeout = 5',
    ].join(eol));
    body += `${body ? eol + eol : ''}${blocks.join(eol)}`;
  }
  const next = `${body}${eol}`;
  if (next === toml) return;
  backup(kimiConfig);
  writeFile(kimiConfig, next);
}

function kimiInstalled() {
  let toml = '';
  try { toml = fs.readFileSync(kimiConfig, 'utf8'); } catch { return 0; }
  const found = new Set();
  for (const table of kimiTables(toml)) {
    if (!kimiOurs(table)) continue;
    for (const line of table) {
      const m = line.match(/^\s*event\s*=\s*"([^"]+)"/);
      if (m) found.add(m[1]);
    }
  }
  return KIMI_EVENTS.filter(event => found.has(event)).length;
}

// ---------------------------------------------------------------------------
// opencode: one CLI plugin in cli.json's `plugins` array, pointing at a copy of
// scripts/opencode-status in ~/.terminal-web. opencode 2 dropped the command
// hooks the other agents use, and a plugin in the shared `serve` process cannot
// tell which pane it runs for — a CLI plugin runs in the TUI, which is inside
// the pane. opencode 1 has no such API, so it is skipped there and the screen
// rules keep covering it.
// ---------------------------------------------------------------------------
const pluginEntryUrl = (entry) => typeof entry === 'string'
  ? entry
  : (typeof entry?.package === 'string' ? entry.package : '');

function opencodeHooksUpdate(install) {
  const exists = fs.existsSync(opencodeCli);
  if (!exists && !install) return;
  const settings = exists ? readJson(opencodeCli, {}) : {};
  const list = Array.isArray(settings.plugins) ? settings.plugins : [];
  const registered = list.some(entry => pluginEntryUrl(entry) === OPENCODE_PLUGIN_URL);
  const next = install
    ? (registered ? list : [...list, OPENCODE_PLUGIN_URL])
    : list.filter(entry => pluginEntryUrl(entry) !== OPENCODE_PLUGIN_URL);
  if (exists && next.length === list.length && next.every((entry, index) => entry === list[index])) return;
  settings.plugins = next;
  if (!next.length) delete settings.plugins;
  backup(opencodeCli);
  writeFile(opencodeCli, `${JSON.stringify(settings, null, 2)}\n`);
}

function opencodeInstalled() {
  if (!fs.existsSync(path.join(OPENCODE_PLUGIN, 'tui.js')) ||
      !fs.existsSync(path.join(OPENCODE_PLUGIN, 'package.json'))) return 0;
  const list = readJson(opencodeCli, {}).plugins;
  return Array.isArray(list) && list.some(entry => pluginEntryUrl(entry) === OPENCODE_PLUGIN_URL) ? 1 : 0;
}

/** 0 when opencode is missing or its version cannot be read. */
function opencodeMajor() {
  try {
    const version = execFileSync('opencode', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
    return Number(/(\d+)\./.exec(version)?.[1] ?? 0);
  } catch { return 0; }
}

// ---------------------------------------------------------------------------
const has = (bin) => {
  try {
    if (WINDOWS) execFileSync('where.exe', [bin], { stdio: 'ignore' });
    else execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    return true;
  } catch { return false; }
};

async function main() {
  const env = dotEnv();
  const token = (() => { try { return fs.readFileSync(tokenFile(env), 'utf8').trim(); } catch { return ''; } })();
  const server = await findServer(env, token);

  if (flag('check')) {
    console.log(`hook script     ${fs.existsSync(HOOK_SCRIPT) ? 'ok' : 'missing'}  ${HOOK_SCRIPT}`);
    console.log(`token file      ${token ? 'ok' : 'missing'}  ${tokenFile(env)}`);
    console.log(`server          ${server.status ? `ok (mode: ${server.status.mode})` : 'not reachable'}  ${server.url}`);
    const claude = claudeDirs().map(dir => path.join(dir, 'settings.json'));
    for (const file of claude) console.log(`Claude Code     ${claudeInstalled(file)}/${CLAUDE_EVENTS.length} hooks  ${file}`);
    console.log(`Codex           ${codexInstalled()}/${CODEX_EVENTS.length} hooks  ${codexHooks}`);
    console.log(`Kimi Code       ${kimiInstalled()}/${KIMI_EVENTS.length} hooks  ${kimiConfig}`);
    console.log(`qwen-code       ${qwenInstalled()}/${QWEN_EVENTS.length} hooks  ${qwenSettings}`);
    console.log(`opencode        ${opencodeInstalled()}/${OPENCODE_PLUGINS} plugin  ${opencodeCli}`);
    const ok = fs.existsSync(HOOK_SCRIPT) && token && server.status &&
      (!wants('claude') || (claude.length && claude.every(file => claudeInstalled(file) === CLAUDE_EVENTS.length))) &&
      (!wants('codex') || codexInstalled() === CODEX_EVENTS.length) &&
      (!wants('kimi') || kimiInstalled() === KIMI_EVENTS.length) &&
      (!qwenCheckRequired(only, fs.existsSync(qwenHome()) || has('qwen')) || qwenInstalled() === QWEN_EVENTS.length) &&
      (!wants('opencode') || opencodeInstalled() === OPENCODE_PLUGINS);
    process.exit(ok ? 0 : 1);
  }

  const install = !flag('uninstall');
  if (install) {
    if (!WINDOWS && !has('curl')) throw new Error('curl is required by the hook script');
    fs.mkdirSync(HOOK_DIR, { recursive: true });
    fs.copyFileSync(path.join(REPO, 'scripts', path.basename(HOOK_SCRIPT)), HOOK_SCRIPT);
    if (!WINDOWS) fs.chmodSync(HOOK_SCRIPT, 0o755);
    writeFile(HOOK_ENV, `# Written by scripts/install-agent-hooks.mjs\nTERMINAL_WEB_URL=${quote(server.url)}\nTERMINAL_WEB_TOKEN_FILE=${quote(tokenFile(env))}\n`);
  }
  if (wants('claude')) {
    for (const dir of claudeDirs()) {
      const file = path.join(dir, 'settings.json');
      claudeHooks(file, install);
      console.log(`Claude Code: ${install ? 'installed' : 'removed'} (${file})`);
    }
  }
  if (wants('codex')) {
    if (install && !fs.existsSync(codexHome) && !has('codex')) console.log('Codex: not found, skipped');
    else {
      codexHooksUpdate(install);
      console.log(`Codex: ${install ? 'installed' : 'removed'} (${codexHooks}, trust in ${codexConfig})`);
    }
  }
  if (wants('kimi')) {
    if (install && !fs.existsSync(path.dirname(kimiConfig)) && !has('kimi')) console.log('Kimi Code: not found, skipped');
    else {
      kimiHooksUpdate(install);
      console.log(`Kimi Code: ${install ? 'installed' : 'removed'} (${kimiConfig})`);
    }
  }
  if (wants('qwen')) {
    if (install && !fs.existsSync(qwenHome()) && !has('qwen')) console.log('qwen-code: not found, skipped');
    else {
      qwenHooksUpdate(install);
      console.log(`qwen-code: ${install ? 'installed' : 'removed'} (${qwenSettings})`);
    }
  }
  if (wants('opencode')) {
    const found = fs.existsSync(opencodeConfigDir) || has('opencode');
    if (install && !found) console.log('opencode: not found, skipped');
    else if (install && opencodeMajor() === 1) console.log('opencode: 1.x has no CLI plugin API, skipped (screen rules cover it)');
    else {
      if (install) {
        // The layout before this package directory was a single loose file.
        fs.rmSync(path.join(HOOK_DIR, 'opencode-status-tui.mjs'), { force: true });
        fs.cpSync(path.join(REPO, 'scripts', 'opencode-status'), OPENCODE_PLUGIN, { recursive: true });
      }
      opencodeHooksUpdate(install);
      if (!install) fs.rmSync(OPENCODE_PLUGIN, { recursive: true, force: true });
      console.log(`opencode: ${install ? 'installed' : 'removed'} (${opencodeCli}, plugin in ${OPENCODE_PLUGIN})`);
    }
  }
  if (!install) {
    if (!only) for (const file of [HOOK_SCRIPT, HOOK_ENV]) fs.rmSync(file, { force: true });
    return;
  }
  console.log(`Hooks report to ${server.url} — ${server.status ? `server reachable, mode: ${server.status.mode}` : 'server NOT reachable now (start it, or pass --url=…)'}`);
  if (server.status && server.status.mode !== 'hooks') {
    console.log(`Note: the server runs in '${server.status.mode}' mode, so hook reports are ignored. Switch 状态来源 to 钩子 in the settings sheet (⋯).`);
  }
  console.log('Restart running Claude Code / Codex / Kimi Code / qwen-code / opencode sessions to load the hooks.');
}

// Importing the helpers in tests must not run the installer.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(error => {
  console.error(`install-agent-hooks: ${error.message}`);
  process.exit(1);
});
