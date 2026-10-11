import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';

const dir = mkdtempSync(path.join(os.tmpdir(), 'terminal-auth-'));
const file = path.join(dir, 'token');
const listener = net.createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const base = `http://127.0.0.1:${port}`;
const session = `auth_test_${process.pid}`;
let child;
const sockets = [];
async function start() {
  child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), AUTH_TOKEN: '', AUTH_TOKEN_FILE: file },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('server exited early');
    try { await fetch(base); return; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  throw new Error('server startup timed out');
}
async function stop() {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
}
function cookie(response) {
  return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}
async function connect(credentials, origin = base) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session=${session}`, {
    headers: { Cookie: credentials, Origin: origin },
  });
  sockets.push(ws);
  await once(ws, 'open');
  return ws;
}
async function deniedWs(credentials, origin, status) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: credentials, Origin: origin } });
  ws.on('error', () => {});
  await new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_req, response) => {
      try { assert.equal(response.statusCode, status); response.resume(); ws.terminate(); resolve(); }
      catch (error) { reject(error); }
    });
    ws.once('open', () => { ws.terminate(); reject(new Error('unexpected authenticated upgrade')); });
  });
}
try {
  await start();
  const token = readFileSync(file, 'utf8').trim();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const route of ['/', '/api/sessions', '/api/prefs', '/api/download?path=/etc/hostname']) {
    assert.equal((await fetch(base + route)).status, 401);
  }
  assert.equal((await fetch(base + '/api/sessions', { headers: { 'cf-ray': 'test' } })).status, 401);
  assert.equal((await fetch(base, { headers: { Cookie: 'tw_auth=%INVALID' } })).status, 401);
  assert.equal((await fetch(base + '/?token=wrong')).status, 401);
  assert.equal((await fetch(base)).headers.get('referrer-policy'), 'same-origin');
  assert.equal((await fetch(base + '/?token=wrong')).headers.get('referrer-policy'), 'same-origin');
  const wrongLogin = await fetch(base + '/auth/login', {
    method: 'POST', headers: { Origin: base }, body: 'token=wrong',
  });
  assert.equal(wrongLogin.status, 401);
  assert.equal(wrongLogin.headers.get('referrer-policy'), 'same-origin');
  assert.equal((await fetch(base + '/auth/login', {
    method: 'POST', headers: { Origin: 'null' }, body: 'token=wrong',
  })).status, 403);
  const login = () => fetch(base + '/auth/login', {
    method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  });
  const first = await login();
  assert.equal(first.status, 302);
  assert(first.headers.get('set-cookie').includes('HttpOnly'));
  const a = cookie(first), b = cookie(await login());
  assert.notEqual(a, b);
  const link = await fetch(base + '/?token=' + token + '&session=example', { redirect: 'manual' });
  assert.equal(link.headers.get('location'), '/?session=example');
  assert.equal(link.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await fetch(base + '/api/sessions', { headers: { Cookie: a } })).status, 200);
  assert.equal((await fetch(base + '/api/prefs', { method: 'POST', headers: { Cookie: a, Origin: 'http://evil.example' }, body: '{}' })).status, 403);
  await deniedWs('', base, 401);
  await deniedWs(a, 'http://evil.example', 403);
  const wa = await connect(a), wa2 = await connect(a), wb = await connect(b);
  const closedA = once(wa, 'close'), closedA2 = once(wa2, 'close');
  const out = await fetch(base + '/auth/logout', { method: 'POST', headers: { Cookie: a, Origin: base } });
  assert.equal(out.status, 204);
  assert(out.headers.get('set-cookie').includes('Max-Age=0'));
  assert.equal((await closedA)[0], 4001);
  assert.equal((await closedA2)[0], 4001);
  assert.equal(wb.readyState, WebSocket.OPEN);
  assert.equal((await fetch(base + '/api/sessions', { headers: { Cookie: b } })).status, 200);
  for (const ws of sockets) ws.terminate();
  await stop();
  await start();
  assert.equal(readFileSync(file, 'utf8').trim(), token);
  assert.equal((await fetch(base + '/api/sessions', { headers: { Cookie: b } })).status, 200);
  console.log('PASS: mandatory auth, login, malformed cookie, origin checks, multi-device logout, persistent token and restart');
} finally {
  for (const ws of sockets) ws.terminate();
  await stop();
  try { execFileSync('tmux', ['kill-session', '-t', '=' + session], { stdio: 'ignore' }); } catch {}
  rmSync(dir, { recursive: true, force: true });
}
