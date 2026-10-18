#!/usr/bin/env node
// One-step install of the terminal-web agent hooks for Claude Code and Codex.
//
//   node scripts/install-agent-hooks.mjs            install (or refresh) both
//   node scripts/install-agent-hooks.mjs --check    report what is installed and whether the server answers
//   node scripts/install-agent-hooks.mjs --uninstall
// Options: --only=claude|codex   --url=http://HOST:PORT   --claude-dir=DIR (repeatable)
//
// Safe to run repeatedly. It only adds or removes its own entries — those whose
// command runs ~/.terminal-web/agent-hook.sh — and backs up every file it
// changes to <file>.bak-terminal-web first (once — the copy is the original). Agent sessions already running pick
// the hooks up when restarted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const HOOK_DIR = path.join(HOME, '.terminal-web');
// Windows has no /bin/sh for the agents to run the shell script with: there the
// hook is its Node twin, run by the node that runs this installer.
const WINDOWS = process.platform === 'win32';
const HOOK_SCRIPT = path.join(HOOK_DIR, WINDOWS ? 'agent-hook.mjs' : 'agent-hook.sh');
const HOOK_ENV = path.join(HOOK_DIR, 'agent-hook.env');
const MARK = /[/\\]\.terminal-web[/\\]agent-hook\.(sh|mjs)/;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = option('only');
const wants = (agent) => !only || only === agent;

// Same events Orca registers, minus the ones that only feed its dashboards.
const CLAUDE_EVENTS = [
  ['UserPromptSubmit'], ['PreToolUse', '*'], ['PostToolUse', '*'], ['PostToolUseFailure', '*'],
  ['PermissionRequest', '*'], ['Notification'], ['Stop'], ['StopFailure'], ['PostCompact'], ['SessionEnd'],
];
const CODEX_EVENTS = [
  ['UserPromptSubmit', 'user_prompt_submit'], ['PreToolUse', 'pre_tool_use'], ['PostToolUse', 'post_tool_use'],
  ['PermissionRequest', 'permission_request'], ['Stop', 'stop'], ['Interrupt', 'interrupt'],
];

const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
// Forward slashes on Windows too: both agents hand the command to a shell that
// would read backslashes as escapes.
const slashed = (p) => p.replace(/\\/g, '/');
const command = (agent, event) => WINDOWS
  ? `"${slashed(process.execPath)}" "${slashed(HOOK_SCRIPT)}" ${agent} ${event}`
  : `/bin/sh ${quote(HOOK_SCRIPT)} ${agent} ${event}`;
const ours = (group) => (group?.hooks ?? []).some(h => typeof h?.command === 'string' && MARK.test(h.command));

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

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
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
    hooks[event] = hooks[event].filter(group => !ours(group));
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
// Codex: hooks.json plus a trust entry per hook in config.toml — Codex will not
// run a hook whose hash it has not been told to trust.
// ---------------------------------------------------------------------------
const codexHome = process.env.CODEX_HOME || path.join(HOME, '.codex');
const codexHooks = path.join(codexHome, 'hooks.json');
const codexConfig = path.join(codexHome, 'config.toml');

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
  const ourHashes = new Set(CODEX_EVENTS.map(([event, label]) =>
    codexHash(label, { command: command('codex', event), timeout: codexTimeout(label) })));
  const out = [];
  let block = null;
  const flush = () => {
    if (block && !block.some(line => [...ourHashes].some(h => line.includes(h)))) out.push(...block);
    block = null;
  };
  for (const line of toml.split('\n')) {
    if (/^\s*\[/.test(line)) {
      flush();
      if (/^\s*\[hooks\.state\."/.test(line)) { block = [line]; continue; }
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
    hooks[event] = hooks[event].filter(group => !ours(group));
    if (!hooks[event].length) delete hooks[event];
  }
  const trust = [];
  if (install) {
    const source = fs.realpathSync(codexHome);
    for (const [event, label] of CODEX_EVENTS) {
      const handler = { type: 'command', command: command('codex', event), timeout: codexTimeout(label) };
      const list = (hooks[event] ??= []);
      list.push({ hooks: [handler] });
      trust.push(`[hooks.state."${path.join(source, 'hooks.json')}:${label}:${list.length - 1}:0"]`,
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
    const ok = fs.existsSync(HOOK_SCRIPT) && token && server.status &&
      (!wants('claude') || (claude.length && claude.every(file => claudeInstalled(file) === CLAUDE_EVENTS.length))) &&
      (!wants('codex') || codexInstalled() === CODEX_EVENTS.length);
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
  if (!install) {
    if (!only) for (const file of [HOOK_SCRIPT, HOOK_ENV]) fs.rmSync(file, { force: true });
    return;
  }
  console.log(`Hooks report to ${server.url} — ${server.status ? `server reachable, mode: ${server.status.mode}` : 'server NOT reachable now (start it, or pass --url=…)'}`);
  if (server.status && server.status.mode !== 'hooks') {
    console.log(`Note: the server runs in '${server.status.mode}' mode, so hook reports are ignored. Switch 状态来源 to 钩子 in the settings sheet (⋯).`);
  }
  console.log('Restart running Claude Code / Codex sessions to load the hooks.');
}

main().catch(error => {
  console.error(`install-agent-hooks: ${error.message}`);
  process.exit(1);
});
