// Run against the local service; creates only temporary, untagged tmux sessions.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const base = process.env.TEST_BASE_URL || 'http://192.168.88.119:8090';
const token = process.env.AUTH_TOKEN || readFileSync(
  process.env.AUTH_TOKEN_FILE || path.join(os.homedir(), '.config/terminal-web/auth-token'), 'utf8',
).trim();
const headers = { Cookie: `tw_auth=${encodeURIComponent(token)}` };
const name = `cwd_verify_${process.pid}`;
const directory = mkdtempSync(path.join(os.tmpdir(), 'terminal-web-cwd-'));
const unusual = path.join(directory, '中文 project trailing ');
mkdirSync(unusual);
const tmux = (...args) => execFileSync('tmux', args, { encoding: 'utf8' });
const get = session => fetch(`${base}/api/sessions/cwd?session=${encodeURIComponent(session)}`, { headers });
try {
  assert.equal((await get('bad/name')).status, 400);
  assert.equal((await fetch(`${base}/api/sessions/cwd`, { headers })).status, 400);
  tmux('new-session', '-d', '-s', `${name}_extra`, '-c', directory, 'sleep 60');
  assert.equal((await get(name)).status, 409, 'missing exact session must not resolve to a prefix match');
  tmux('new-session', '-d', '-s', name, '-c', unusual, 'sleep 60');
  const response = await get(name);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { path: unusual });
  tmux('kill-session', '-t', `=${name}`);
  tmux('new-session', '-d', '-s', name, '-c', directory, 'sleep 60');
  assert.deepEqual(await (await get(name)).json(), { path: directory }, 'fresh request reads the current directory');
  const unauthed = await fetch(`${base}/api/sessions/cwd?session=${name}`, { redirect: 'manual' });
  assert.notEqual(unauthed.status, 200, 'working directory requires authentication');
  console.log('PASS: session cwd validation, exact matching, Unicode/spaces, fresh results, no-store and authentication');
} finally {
  for (const session of [name, `${name}_extra`]) {
    try { tmux('kill-session', '-t', `=${session}`); } catch { /* already closed */ }
  }
  rmSync(directory, { recursive: true, force: true });
}
