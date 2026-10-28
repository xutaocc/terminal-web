import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';
import { AgentApi, isAgentApiEnabled } from '../src/agent-api.js';
import { TerminalControl } from '../src/terminal-control.js';

test('Agent API defaults on only for Windows and respects explicit overrides', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    assert.equal(isAgentApiEnabled('', platform), platform === 'win32');
    assert.equal(isAgentApiEnabled('  ', platform), platform === 'win32');
    assert.equal(isAgentApiEnabled('0', platform), false);
    assert.equal(isAgentApiEnabled('1', platform), true);
    assert.equal(isAgentApiEnabled(' 1 ', platform), true);
    assert.equal(isAgentApiEnabled('invalid', platform), false);
  }
});

async function fixture(t: { after: (fn: () => unknown) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-directory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spawned: string[] = [];
  let currentCwd: string | null = dir;
  const writes: string[] = [];
  const api = new AgentApi({
    enabled: true, token: 'test-token', file: path.join(dir, 'sessions.json'), control: new TerminalControl(),
    cwd: async () => currentCwd,
    spawn: async (_name, cwd) => {
      spawned.push(cwd);
      return { write: (text: string) => writes.push(text), onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) } as unknown as IPty;
    },
    prepareInput: async () => {}, register: () => {}, remove: async () => {}
  });
  const server = http.createServer((req, res) => { void api.http(req, res, new URL(req.url!, 'http://localhost')); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const create = async (cwd: string, requestId = randomUUID()) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/agent/v1/sessions`, {
      method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, label: 'directory test', cwd })
    });
    return { status: response.status, body: await response.json() };
  };
  t.after(() => api.flushHistory());
  return { dir, spawned, create, api, port, writes, setCwd: (cwd: string | null) => { currentCwd = cwd; } };
}
test('explicit directories must exist; valid creates remain idempotent', async t => {
  const { dir, spawned, create } = await fixture(t);
  const absent = path.join(dir, 'missing');
  const invalid = await create(absent);
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, 'INVALID_DIRECTORY');
  assert.equal(fs.existsSync(absent), false);
  assert.equal(spawned.length, 0);
  const id = randomUUID();
  const first = await create(dir, id), retry = await create(dir, id);
  assert.equal(first.status, 200);
  assert.equal(retry.body.sessionId, first.body.sessionId);
  assert.deepEqual(spawned, [dir]);
});
test('Windows default scratch directory is provisioned on first use', { skip: process.platform !== 'win32' ? 'Requires Windows filesystem and directory permissions' : false }, async t => {
  const cwd = 'C:/twsshProjecTemp';
  const existed = fs.existsSync(cwd);
  if (!existed) t.after(() => { if (fs.existsSync(cwd)) fs.rmdirSync(cwd); });
  const { create, spawned } = await fixture(t);
  const result = await create(cwd);
  assert.equal(result.status, 200);
  assert.equal(fs.statSync(cwd).isDirectory(), true);
  assert.deepEqual(spawned, [cwd]);
});

test('rename API and browser path preserve identity and persist across restart', async t => {
  const { dir, spawned, create, api, port } = await fixture(t);
  const created = (await create(dir)).body;
  const url = `http://127.0.0.1:${port}/api/agent/v1/sessions/${created.sessionId}`;
  const patch = (label: unknown, generation = created.generation, token = 'test-token') => fetch(url, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, generation })
  });
  assert.equal((await patch('new', created.generation, 'wrong')).status, 401);
  assert.equal((await patch('new', randomUUID())).status, 409);
  for (const label of ['', '  ', 'x'.repeat(65), 'bad\nname']) assert.equal((await patch(label)).status, 400);
  const renamed = await (await patch('电脑维护')).json();
  assert.equal(renamed.sessionId, created.sessionId);
  assert.equal(renamed.name, created.name);
  assert.equal(renamed.label, '电脑维护');
  assert.equal(api.rename(created.name, '浏览器标签'), true);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')).sessions[0];
  assert.equal(stored.label, '浏览器标签');
  assert.equal(stored.id, created.sessionId);
  assert.equal(spawned.length, 1);
  const restored = new AgentApi({ enabled: true, token: 'test-token', file: path.join(dir, 'sessions.json'),
    control: new TerminalControl(), spawn: async () => { throw Error('must not spawn'); },
    register() {}, prepareInput: async () => {}, remove: async () => {} });
  assert.equal((restored.history(created.name) as {label: string}).label, '浏览器标签');
});

test('history records input-time directory changes and inspection never sends input', async t => {
  const { dir, create, port, setCwd, writes, api } = await fixture(t);
  const session = (await create(dir)).body;
  const base = `http://127.0.0.1:${port}/api/agent/v1`;
  const call = async (route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + route, { method, headers: { Authorization: 'Bearer test-token',
      'X-Terminal-Client': 'a'.repeat(48), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  const prefix = `/sessions/${session.sessionId}`;
  const owner = (await call(prefix + '/control', 'POST', { generation: session.generation, action: 'acquire' })).data;
  const send = (text: string, sensitive = false) => call(prefix + '/input', 'POST', {
    generation: session.generation, controlEpoch: owner.epoch, requestId: randomUUID(), text, sensitive });
  assert.equal((await send('pwd\r')).status, 200);
  setCwd(path.join(dir, 'other'));
  assert.equal((await send('secret\r', true)).status, 200);
  const history = (await call(prefix + '/history?limit=1')).data;
  assert.equal(history.records[0].directoryBeforeInput.cwd, dir);
  assert.ok(history.records[0].directoryBeforeInput.observedAt);
  assert.ok(history.records[0].time);
  assert.equal(history.hasMore, true);
  const second = (await call(prefix + '/history?after=1')).data.records[0];
  assert.equal(second.directoryBeforeInput.cwd, path.join(dir, 'other'));
  assert.equal(second.input, '[sensitive input]');
  const list = (await call('/sessions')).data;
  assert.equal(list.total, 1);
  assert.equal(list.sessions[0].initialCwd, dir);
  assert.equal(list.sessions[0].currentDirectory.cwd, path.join(dir, 'other'));
  assert.ok(list.sessions[0].createdAt);
  setCwd(null);
  assert.equal((await call(prefix)).data.currentDirectory.cwd, null);
  assert.equal((await call(prefix + '/history?limit=101')).status, 400);
  assert.equal((await call(prefix + '/history?kind=invalid')).status, 400);
  assert.equal(writes.length, 2);
  const encoded = 'powershell -EncodedCommand ' + Buffer.from('Get-Location', 'utf16le').toString('base64') + '\r';
  const requestId = randomUUID();
  const payload = { generation: session.generation, controlEpoch: owner.epoch, requestId, text: encoded };
  const first = await call(prefix + '/input', 'POST', payload);
  const duplicate = await call(prefix + '/input', 'POST', payload);
  assert.equal(first.data.decodedInput, 'Get-Location');
  assert.deepEqual(duplicate.data, first.data);
  assert.equal(writes.length, 3);
  assert.equal(writes[2], encoded);
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8')).sessions[0];
  assert.equal(stored.requests[requestId].result.decodedInput, 'Get-Location');
  assert.equal(stored.requests[requestId].result.input, encoded);
  const sensitive = await send(encoded, true);
  assert.equal(sensitive.data.input, '[sensitive input]');
  assert.equal(sensitive.data.decodedInput, undefined);
  assert.equal((await call(prefix + '/history?after=2&limit=1')).data.records[0].decodedInput, 'Get-Location');
  api.flushHistory();
  assert.equal(JSON.stringify((await call(prefix + '/history?kind=output')).data).includes('secret'), false);
});
