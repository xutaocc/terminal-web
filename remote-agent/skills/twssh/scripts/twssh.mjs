#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runClient } from './client/twssh.mjs';

const DEFAULT_CWD = 'C:/twsshProjecTemp';
const fail = message => { console.error(message); process.exit(1); };
if (Number(process.versions.node.split('.')[0]) < 20) fail('需要 Node.js 20+。');
const args = [];
let project = process.cwd(), target;
const input = process.argv.slice(2);
for (let i = 0; i < input.length; i++) {
  const arg = input[i];
  if (arg === '--project' || arg === '--target') {
    const value = input[++i];
    if (!value || value.startsWith('--')) fail(`${arg} 需要值。`);
    if (arg === '--project') project = path.resolve(value);
    else if (target !== undefined) fail('只能指定一个 --target。');
    else target = value;
  } else {
    args.push(arg);
    // Preserve values verbatim, including command strings, instead of parsing them as wrapper flags.
    if (arg.startsWith('--') && input[i + 1] && !input[i + 1].startsWith('--')) args.push(input[++i]);
  }
}
try { project = fs.realpathSync(project); if (!fs.statSync(project).isDirectory()) throw Error(); }
catch { fail('控制端工作目录不存在。请检查 --project。'); }
const home = path.join(project, '.twssh');
const projectSettings = path.join(home, 'connections.json');
const globalSettings = path.join(os.homedir(), '.config', 'twssh', 'connections.json');
function protectState() {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const ignore = path.join(home, '.gitignore');
  const existing = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  const missing = ['connections.json', 'state/'].filter(line => !existing.split(/\r?\n/).includes(line));
  if (missing.length) fs.appendFileSync(ignore, `${existing && !existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}
if (args[0] === 'init') {
  protectState();
  if (!fs.existsSync(projectSettings)) fs.writeFileSync(projectSettings,
    JSON.stringify({ version: 1, connections: [] }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(`项目配置：${projectSettings}\n全局配置：${globalSettings}\n同名目标由项目配置完整覆盖。默认远程目录：${DEFAULT_CWD}。Token 单独保存于控制端文件。`);
  process.exit(0);
}
function readConnections(file) {
  if (!fs.existsSync(file)) return [];
  let document;
  try { document = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail(`配置不是有效 JSON，请编辑 ${file}`); }
  if (document?.version !== 1 || !Array.isArray(document.connections)) fail(`请在 ${file} 设置 version: 1 和 connections 数组。`);
  const names = new Set();
  for (const connection of document.connections) {
    if (!connection || typeof connection.name !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(connection.name)) fail(`连接 name 必须为字母、数字、下划线或短横线：${file}`);
    if (names.has(connection.name)) fail(`连接名字重复：${connection.name}。请修改 ${file}`);
    names.add(connection.name);
  }
  return document.connections;
}
const merged = new Map();
for (const file of [globalSettings, projectSettings]) {
  for (const connection of readConnections(file)) merged.set(connection.name, { connection, file });
}
if (args[0] === 'config') {
  console.log(JSON.stringify({ project, file: projectSettings, globalFile: globalSettings,
    targets: [...merged.values()].map(({ connection: c, file }) => ({ name: c.name, description: c.description || '', source: file })) }));
  process.exit(0);
}
const names = [...merged.keys()];
if (!names.length) fail(`尚无连接，请编辑 ${globalSettings} 或 ${projectSettings}。`);
if (!target && names.length !== 1) fail(`配置了多个远程，必须指定 --target NAME。可选：${names.join(', ')}。`);
const selected = merged.get(target || names[0]);
if (!selected) fail(`目标不存在。可选：${names.join(', ')}。`);
const { connection: cfg, file: settings } = selected;
let origin;
try {
  const url = new URL(cfg.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error();
  origin = url.origin;
} catch { fail(`请在 ${settings} 为 ${cfg.name} 设置 url，例如 http://192.168.1.20:8090`); }
if (cfg.cwd != null && typeof cfg.cwd !== 'string') fail(`请在 ${settings} 将 cwd 设置为字符串。`);
const endpoint = createHash('sha256').update(origin).digest('hex').slice(0, 16);
protectState();
const stateHome = path.join(home, 'state', `${cfg.name}-${endpoint}`);
const registryFile = path.join(stateHome, 'sessions.json');
let registry = {};
try { if (fs.existsSync(registryFile)) registry = JSON.parse(fs.readFileSync(registryFile, 'utf8')); }
catch { fail(`会话记录无法读取：${registryFile}。请修复后继续，不自动丢弃旧记录。`); }
function saveRegistry() {
  fs.mkdirSync(stateHome, { recursive: true, mode: 0o700 });
  const tmp = `${registryFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, registryFile);
}
if (args[0] === 'session' && args[1] === 'local') {
  console.log(JSON.stringify({ project, target: cfg.name, sessions: registry }));
  process.exit(0);
}
const sidIndex = args.indexOf('--session');
const sid = sidIndex < 0 ? undefined : args[sidIndex + 1];
const adopting = args[0] === 'session' && args[1] === 'adopt';
if (adopting && (!sid || sid.startsWith('--'))) fail('session adopt 需要 --session ID。');
const inspecting = args[0] === 'status' || (args[0] === 'session' && ['identity', 'history'].includes(args[1]));
if (sid && !adopting && !inspecting && !Object.hasOwn(registry, sid)) fail(`该会话未绑定到当前工作目录的 ${cfg.name}。请先 session list 核对，明确选择后用 session adopt --session ID 登记；不要跨目标沿用 ID。`);
if (typeof cfg.tokenFile !== 'string' || !cfg.tokenFile) fail(`请在 ${settings} 设置 tokenFile。`);
const tokenFile = cfg.tokenFile.startsWith('~/') ? path.join(os.homedir(), cfg.tokenFile.slice(2)) : cfg.tokenFile;
if (!path.isAbsolute(tokenFile) || !fs.existsSync(tokenFile)) fail(`tokenFile 必须指向已存在的控制端绝对路径文件。请修改 ${settings}；不要把 Token 发到对话中。`);
async function run(argv, capture = false) {
  let result = '';
  try {
    await runClient(argv, { home: stateHome, alias: cfg.name,
      host: { url: origin, token: fs.readFileSync(tokenFile, 'utf8').trim(), pin: cfg.pin || undefined },
      write: text => { if (capture) result += text; else process.stdout.write(text); } });
  } catch (error) {
    console.error(error.message);
    fail(`连接配置：${settings}；目标：${cfg.name}。输入结果不明先查 result，不要重发。`);
  }
  return result;
}
console.error(`工作目录：${project}；目标：${cfg.name}；配置：${settings}`);
if (sid && registry[sid]) console.error(`会话：${cfg.name} → ${registry[sid].name || '未命名'} · #${sid.slice(0, 8)}（本地登记名称）；sessionId=${sid}`);
if (args[0] === 'session' && args[1] === 'identity') {
  if (!sid) fail('session identity 需要 --session ID。');
  const info = JSON.parse(await run(['status', cfg.name, '--session', sid], true));
  const displayName = info.label || registry[sid]?.name || info.name;
  if (registry[sid]) { registry[sid].name = displayName; saveRegistry(); }
  console.log(JSON.stringify({ target: cfg.name, displayName, shortId: sid.slice(0, 8), sessionId: sid, internalName: info.name, initialCwd: info.initialCwd ?? info.cwd, currentDirectory: info.currentDirectory ?? null, createdAt: info.createdAt ?? null, lastActivityAt: info.lastActivityAt ?? null, ended: info.ended ?? false }));
} else if (!args.length || args[0] === 'doctor') await run(['doctor', cfg.name]);
else if (adopting) {
  const info = JSON.parse(await run(['status', cfg.name, '--session', sid], true));
  if (info.ended) fail('该远程会话已关闭，不能恢复。');
  registry[sid] = { name: info.label, initialCwd: info.cwd, lastUsed: new Date().toISOString() };
  saveRegistry(); console.log(JSON.stringify(info));
} else if (args[0] === 'session' && args[1] === 'rename') {
  if (!sid) fail('session rename 需要 --session ID。');
  const output = await run(['session', 'rename', cfg.name, ...args.slice(2)], true);
  const info = JSON.parse(output);
  registry[sid].name = info.label;
  saveRegistry(); process.stdout.write(output);
} else if (args[0] === 'session' && args[1] === 'create') {
  const rest = args.slice(2);
  if (!rest.includes('--cwd')) rest.push('--cwd', cfg.cwd || DEFAULT_CWD);
  const output = await run(['session', 'create', cfg.name, ...rest], true);
  const info = JSON.parse(output);
  if (info.sessionId) {
    registry[info.sessionId] = { name: rest.includes('--name') ? rest[rest.indexOf('--name') + 1] : 'agent', initialCwd: rest[rest.indexOf('--cwd') + 1], lastUsed: new Date().toISOString() };
    saveRegistry();
  }
  process.stdout.write(output);
} else {
  if (['session','task','file'].includes(args[0])) await run([args[0], args[1], cfg.name, ...args.slice(2)]);
  else await run([args[0], cfg.name, ...args.slice(1)]);
  if (sid && registry[sid]) {
    registry[sid].lastUsed = new Date().toISOString();
    if (args[0] === 'session' && args[1] === 'close') registry[sid].closed = true;
    saveRegistry();
  }
}
