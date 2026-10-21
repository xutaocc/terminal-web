// Run: node tests/prefs.integration.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
const dir = await mkdtemp(path.join(os.tmpdir(), 'tw-prefs-'));
const file = path.join(dir, 'prefs.json');
const socket = net.createServer().listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise(r => socket.close(r));
const base = `http://127.0.0.1:${port}`;
let child;
async function start() {
  child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), AUTH_TOKEN: 'prefs-test-token', PREFS_FILE: file,
      REMOTES_FILE: path.join(dir, 'remotes.json'), AGENT_STATUS_FILE: path.join(dir, 'status.json') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try { await fetch(base); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('server startup timed out');
}
async function stop() { const done = once(child, 'exit'); child.kill(); await done; }
const api = (suffix, body) => fetch(base + '/api/prefs' + suffix, {
  method: body ? 'POST' : 'GET',
  headers: { Cookie: 'tw_auth=prefs-test-token', Origin: base, 'Content-Type': 'application/json' },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
async function get(scope) { const r = await api(`?scope=${scope}`); assert.equal(r.status, 200); return (await r.json()).prefs; }
async function post(body) { const r = await api('', body); assert.equal(r.status, 200, await r.text()); }
try {
  await writeFile(file, JSON.stringify({ desktop: { hostOrder: ['aaa', ''], fontSize: 14, tabOrder: ['first', 'second'] }, touch: { hostOrder: ['', 'aaa'], fontSize: 20 } }));
  await start();
  assert.deepEqual((await get('touch')).hostOrder, ['aaa', '']);
  assert.deepEqual((await get('touch')).tabOrder, ['first', 'second']);
  await post({ scope: 'touch', tabOrder: ['second', 'first'] });
  assert.deepEqual((await get('desktop')).tabOrder, ['second', 'first']);
  await post({ scope: 'desktop', tabOrder: ['first', 'third', 'second'] });
  assert.deepEqual((await get('touch')).tabOrder, ['first', 'third', 'second']);
  await post({ scope: 'touch', hostOrder: ['', 'bbb', 'aaa'] });
  assert.deepEqual((await get('desktop')).hostOrder, ['', 'bbb', 'aaa']);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).shared.hostOrder, ['', 'bbb', 'aaa']);
  await Promise.all([post({ scope: 'desktop', fontSize: 16 }), post({ scope: 'touch', zoomKeys: false })]);
  assert.equal((await get('desktop')).fontSize, 16);
  assert.equal((await get('touch')).fontSize, 20);
  assert.equal((await get('touch')).zoomKeys, false);
  // Two connected clients receive the same activity and read transitions.
  const statusRequest = (route, body) => fetch(base + '/api/agent-status' + route, {
    method: body ? 'POST' : 'GET',
    headers: { Cookie: 'tw_auth=prefs-test-token', Origin: base, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal((await statusRequest('/mode', { mode: 'legacy' })).status, 200);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 5000);
  const streams = await Promise.all([0, 1].map(async () => {
    const response = await fetch(base + '/api/agent-status/events', {
      headers: { Cookie: 'tw_auth=prefs-test-token' }, signal: abort.signal,
    });
    const reader = response.body.getReader();
    let buffer = '';
    return async () => {
      while (!buffer.includes('\n\n')) {
        const { value, done } = await reader.read();
        assert.equal(done, false);
        buffer += new TextDecoder().decode(value);
      }
      const end = buffer.indexOf('\n\n');
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      return JSON.parse(frame.split('\n').find(line => line.startsWith('data:')).slice(5));
    };
  }));
  try {
    await Promise.all(streams.map(next => next()));
    await statusRequest('/read', { output: 'shared-session' });
    for (const snapshot of await Promise.all(streams.map(next => next()))) {
      assert.equal(snapshot.sessions['shared-session'].state, 'working');
      assert.equal(snapshot.sessions['shared-session'].unread, true);
    }
    await statusRequest('/read', { sessions: ['shared-session'] });
    for (const snapshot of await Promise.all(streams.map(next => next()))) {
      assert.equal(snapshot.sessions['shared-session'].unread, false);
      assert.equal(snapshot.sessions['shared-session'].state, 'working');
    }
    await statusRequest('/read', { output: 'shared-session' });
    for (const snapshot of await Promise.all(streams.map(next => next()))) {
      assert.equal(snapshot.sessions['shared-session'].unread, true);
    }
  } finally { clearTimeout(timeout); abort.abort(); }
  await stop(); await start();
  assert.deepEqual((await get('touch')).tabOrder, ['first', 'third', 'second']);
  assert.deepEqual((await get('desktop')).hostOrder, ['', 'bbb', 'aaa']);
  assert.deepEqual((await get('touch')).hostOrder, ['', 'bbb', 'aaa']);
  await stop();
  // A directory cannot be replaced with the JSON file: persistence must fail.
  await rm(file); await (await import('node:fs/promises')).mkdir(file);
  await start();
  assert.equal((await api('', { scope: 'desktop', hostOrder: ['aaa', ''] })).status, 500);
  assert.equal((await get('desktop')).hostOrder, undefined);
  console.log('PASS: legacy migration, shared order, scoped settings, concurrent updates, two-client unread events, restart persistence, write failure');
} finally {
  if (child && child.exitCode === null && child.signalCode === null) await stop();
  await rm(dir, { recursive: true, force: true });
}
