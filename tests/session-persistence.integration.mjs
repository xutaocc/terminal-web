// Fully isolated tmux socket and HOME: never touches the user's sessions.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'tw-persistence-')));
const socket = `tw-test-${process.pid}`;
const binary = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim();
const wrapper = path.join(root, 'tmux');
writeFileSync(wrapper, `#!/bin/sh\nexec '${binary}' -L '${socket}' "$@"\n`, { mode: 0o700 });
let directory = path.join(root, '中文 project');
mkdirSync(directory);
const port = 18000 + process.pid % 10000;
const base = `http://127.0.0.1:${port}`;
const token = 'persistence-test-token';
const headers = { Cookie: `tw_auth=${token}` };
let server;
let output = '';
async function start() {
  server = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
    env: { ...process.env, HOME: root, TMUX_BIN: wrapper, HOST: '127.0.0.1', PORT: String(port), AUTH_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/sessions`, { headers })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(output);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, 'exit');
  server.kill('SIGTERM');
  await exited;
}
async function tabs() { return (await (await fetch(`${base}/api/sessions`, { headers })).json()).tabs; }
async function post(route, body) {
  const response = await fetch(`${base}/api/sessions/${route}`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
}
const tmux = (...args) => execFileSync(wrapper, args, { encoding: 'utf8' });
async function attach() {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session=saved&cols=100&rows=30`, { headers });
  await once(ws, 'open');
  for (let i = 0; i < 50; i++) {
    try { if (tmux('display-message', '-p', '-t', '=saved:', '#{pane_current_path}').trim() === directory) return ws; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  ws.close();
  throw new Error('saved directory was not restored');
}
try {
  tmux('new-session', '-d', '-s', 'saved', '-c', directory);
  tmux('set-option', '-t', 'saved', '@twtab', '1');
  tmux('set-option', '-t', 'saved', '@twlabel', '旧会话名称');
  await start();
  assert.deepEqual(await tabs(), [{ name: 'saved', displayName: '旧会话名称', cwd: directory }]);
  directory = path.join(directory, '后续 cd');
  mkdirSync(directory);
  tmux('send-keys', '-t', 'saved', `cd '${directory}'`, 'Enter');
  let sampled = false;
  for (let i = 0; i < 80; i++) {
    const stored = JSON.parse(readFileSync(path.join(root, '.terminal-web/sessions.json'), 'utf8'));
    if (stored[0]?.cwd === directory) { sampled = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(sampled, 'background sampling must save cd without a browser polling');
  await post('rename', { name: 'saved', displayName: '重命名测试' });
  await stop();
  tmux('kill-server'); // simulate loss of all terminal processes at reboot
  await start();
  assert.deepEqual(await tabs(), [{ name: 'saved', displayName: '重命名测试', cwd: directory }]);
  // Legacy records can survive reboot with only a name. Browser caches may
  // fill their directory even while tmux is down, but cannot replace known
  // paths or resurrect arbitrary cached identities.
  await post('rename', { name: 'legacy', displayName: '旧目录待恢复' });
  await post('adopt', { names: [], directories: [
    { name: 'legacy', cwd: directory },
    { name: 'saved', cwd: root },
    { name: 'not_registered', cwd: directory },
  ] });
  assert.equal((await tabs()).find(t => t.name === 'legacy')?.cwd, directory);
  assert.equal((await tabs()).find(t => t.name === 'saved')?.cwd, directory);
  assert.ok(!(await tabs()).some(t => t.name === 'not_registered'));
  await stop();
  await start();
  assert.equal((await tabs()).find(t => t.name === 'legacy')?.cwd, directory,
    'repaired directory must survive server restart');
  await post('kill', { name: 'legacy' });
  await post('adopt', { names: [], directories: [{ name: 'legacy', cwd: directory }] });
  assert.ok(!(await tabs()).some(t => t.name === 'legacy'), 'cache must not revive a closed tab');
  tmux('new-session', '-d', '-s', 'legacy', '-c', directory);
  const stale = new WebSocket(`ws://127.0.0.1:${port}/ws?session=legacy`, { headers });
  const closedMessage = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('closed session accepted a stale connection')), 3000);
    stale.on('message', message => {
      try {
        if (JSON.parse(message.toString()).type === 'closed') { clearTimeout(timeout); resolve(); }
      } catch {}
    });
    stale.on('error', reject);
  });
  await closedMessage;
  stale.close();
  tmux('kill-session', '-t', '=legacy');
  const ws = await attach();
  ws.close();
  await post('kill', { name: 'saved' });
  assert.deepEqual(await tabs(), []);
  await stop();
  await start();
  assert.deepEqual(await tabs(), [], 'explicitly closed tabs must stay deleted after restart');
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, '.terminal-web/sessions.json'), 'utf8')), []);
  console.log('PASS: migration, rename, tmux/server restart, Unicode cwd restoration and permanent close');
} catch (error) {
  console.error(output);
  throw error;
} finally {
  await stop();
  try { tmux('kill-server'); } catch {}
  rmSync(root, { recursive: true, force: true });
}
