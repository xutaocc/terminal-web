// Isolated HTTP service; all created tmux sessions and directories are temporary.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const listener = net.createServer();
listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const token = crypto.randomBytes(32).toString('hex');
const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'terminal-new-session-')));
const directory = path.join(folder, '中文 project trailing ');
mkdirSync(directory);
const base = `new_session_verify_${process.pid}`;
const child = `${base}_new`;
const snapshotChild = `${base}_snapshot`;
const fallbackChild = `${base}_fallback`;
const sockets = [];
const startService = () => spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), AUTH_TOKEN: token,
    QUICK_COMMANDS_FILE: path.join(folder, 'commands.json'),
    LANG: 'C', LC_ALL: 'C' }, stdio: 'ignore',
});
let service = startService();
async function stopService() {
  if (service.exitCode !== null || service.signalCode !== null) return;
  const stopped = once(service, 'exit');
  service.kill('SIGTERM');
  await stopped;
}
const api = (route, body, authenticated = true) => fetch(`http://127.0.0.1:${port}${route}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { ...(authenticated ? { Cookie: `tw_auth=${token}` } : {}), 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const cwd = session => tmux('display-message', '-p', '-t', `=${session}:`, '#{pane_current_path}').replace(/\n$/, '');
async function until(check) {
  for (let i = 0; i < 100; i++) {
    try { if (await check()) return; } catch { /* service/session starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for service/session');
}
async function connect(name, from, directory) {
  const url = `ws://127.0.0.1:${port}/ws?session=${name}&cols=80&rows=24&create=1&from=${from}` +
    (directory !== undefined ? `&dir=${encodeURIComponent(directory)}` : '');
  const ws = new WebSocket(url, {
    headers: { Cookie: `tw_auth=${token}` },
  });
  sockets.push(ws);
  await once(ws, 'open');
  return ws;
}
try {
  await until(async () => (await fetch(`http://127.0.0.1:${port}`, {
    headers: { Cookie: `tw_auth=${token}` },
  })).status === 200);
  tmux('new-session', '-d', '-s', base, '-c', directory, 'sleep 120');
  await connect(child, base);
  assert.equal((await api('/api/sessions/rename', { name: child, displayName: '前端开发 · 验收' })).status, 200);
  try { await until(() => cwd(child) === directory); }
  catch (error) {
    console.error('Directory verification:', JSON.stringify({ expected: directory, base: cwd(base), child: cwd(child) }));
    throw error;
  }
  assert.equal(cwd(child), directory, 'new tabs inherit Unicode/space/trailing-space paths');
  await until(async () => {
    const tabs = (await (await api('/api/sessions')).json()).tabs;
    return tabs?.some(tab => tab.name === child && tab.displayName === '前端开发 · 验收');
  });

  tmux('kill-session', '-t', `=${base}`);
  tmux('new-session', '-d', '-s', base, '-c', folder, 'sleep 120');
  await connect(child, base);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(cwd(child), directory, 'existing sessions keep their directory on attach');
  await connect(snapshotChild, base, directory);
  await until(() => cwd(snapshotChild) === directory);
  assert.equal(cwd(base), folder);
  assert.equal(cwd(snapshotChild), directory, 'new sessions use the path displayed before the base changed directories');
  await connect(snapshotChild, base, folder);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(cwd(snapshotChild), directory, 'a preview path must not relocate an existing session');
  await connect(fallbackChild, base, path.join(folder, 'missing-directory'));
  await until(() => cwd(fallbackChild) === realpathSync(os.homedir()));
  assert.equal(cwd(fallbackChild), realpathSync(os.homedir()), 'invalid editable directory falls back to home');
  tmux('kill-session', '-t', `=${fallbackChild}`);
  await connect(fallbackChild, base, '');
  await until(() => cwd(fallbackChild) === realpathSync(os.homedir()));
  assert.equal(cwd(fallbackChild), realpathSync(os.homedir()), 'empty editable directory uses home instead of the base directory');
  const route = `/api/sessions/note?session=${child}`;
  const empty = await api(route);
  assert.equal(empty.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await empty.json(), { text: '', updatedAt: null });
  const text = '当前进度：完成标签菜单\n下一步：手机验收\n保留字符：<script> $HOME `echo test`';
  const saved = await api('/api/sessions/note', { name: child, text });
  assert.equal(saved.status, 200);
  const record = await saved.json();
  assert.equal(record.text, text);
  assert.ok(record.updatedAt);
  assert.deepEqual(await (await api(route)).json(), record, 'another request sees the saved note');
  assert.equal((await api('/api/sessions/note', { name: child, text: 'a'.repeat(4001) })).status, 400);
  assert.equal((await api('/api/sessions/note', null)).status, 400);
  assert.equal((await api('/api/sessions/note?session=bad/name')).status, 400);
  assert.equal((await api(`/api/sessions/note?session=${child.slice(0, -1)}`)).status, 404);
  assert.equal((await api(route, undefined, false)).status, 401);
  assert.equal((await api('/api/sessions/note', { name: child, text: 'unauthorized' }, false)).status, 401);
  const commandData = await (await api('/api/quick-commands')).json();
  assert.deepEqual(commandData.commands, []);
  const commandSave = await api('/api/quick-commands', { revision: commandData.revision,
    commands: [{ id: 'status', label: '查看状态', text: 'git status' }] });
  assert.equal(commandSave.status, 200);
  const savedCommands = await commandSave.json();
  assert.equal((await api('/api/quick-commands', { revision: commandData.revision, commands: [] })).status, 409);
  assert.equal((await api('/api/quick-commands', { revision: savedCommands.revision, commands: [null] })).status, 400);
  assert.equal((await api('/api/quick-commands', undefined, false)).status, 401);
  await stopService();
  service = startService();
  await until(async () => (await api(route)).status === 200);
  assert.deepEqual(await (await api(route)).json(), record, 'notes survive Web server restart');
  assert.deepEqual(await (await api('/api/quick-commands')).json(), savedCommands, 'commands survive service restart');
  assert.equal((await api('/api/sessions/note', { name: child, text: '' })).status, 200);
  assert.equal((await (await api(route)).json()).text, '', 'notes can be cleared');
  console.log('PASS: directory inheritance, existing-session preservation, notes round-trip, validation, authentication, restart persistence and clearing');
} finally {
  for (const ws of sockets) ws.close();
  await stopService();
  for (const name of [base, child, snapshotChild, fallbackChild]) {
    try { tmux('kill-session', '-t', `=${name}`); } catch { /* already gone */ }
  }
  rmSync(folder, { recursive: true, force: true });
}
