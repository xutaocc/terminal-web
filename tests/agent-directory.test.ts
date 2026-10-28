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
  const api = new AgentApi({
    enabled: true, token: 'test-token', file: path.join(dir, 'sessions.json'), control: new TerminalControl(),
    spawn: async (_name, cwd) => {
      spawned.push(cwd);
      return { onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }) } as unknown as IPty;
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
  return { dir, spawned, create };
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
