import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../remote-agent/skills/twssh/', import.meta.url));
function run(script, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd,
      env: { ...process.env, TWSSH_HOME: path.join(cwd, 'ignored-global-config') } });
    let out = '', err = '';
    child.stdout.on('data', b => out += b);
    child.stderr.on('data', b => err += b);
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
  });
}
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twssh skill '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const requests = [], sessions = new Map(), eventPages = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ url: req.url, auth: req.headers.authorization, body, port: req.socket.remotePort });
    res.setHeader('Content-Type', 'application/json');
    const route = req.url.replace('/api/agent/v1', '');
    let value = { version: 1 };
    if (route === '/sessions' && req.method === 'POST') {
      value = { sessionId: randomUUID(), generation: randomUUID() };
      sessions.set(value.sessionId, { ...value, cwd: body.cwd, label: body.label });
    } else if (route === '/sessions') value = { sessions: [...sessions.values()] };
    else if (route.split('?')[0].endsWith('/history')) value = { records: [], total: 0, nextCursor: 0, hasMore: false };
    else if (route.endsWith('/control')) value = { mine: true, epoch: 1 };
    else if (route.endsWith('/input')) value = { state: 'sent', completion: 'unknown', requestId: body.requestId };
    else if (route.split('?')[0].endsWith('/events')) {
      value = eventPages.shift() || { events: [], cursor: 0, epoch: 'test', alive: true, mine: true };
      if (value.error) res.statusCode = 503;
    }
    else if (route.startsWith('/sessions/')) {
      value = sessions.get(route.split('/')[2]);
      if (!value) { res.statusCode = 404; value = { error: 'SESSION_NOT_FOUND' }; }
      else if (req.method === 'PATCH') value.label = body.label;
    }
    res.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const token = path.join(dir, 'token'); fs.writeFileSync(token, 'test-secret');
  const cfg = { name: '8845h', url: `http://127.0.0.1:${server.address().port}`, tokenFile: token };
  const script = path.join(root, 'scripts/twssh.mjs');
  assert.equal((await run(script, ['init'], dir)).code, 0);
  const settings = path.join(dir, '.twssh/connections.json');
  const set = connections => fs.writeFileSync(settings, JSON.stringify({ version: 1, connections }));
  set([cfg]);
  return { dir, requests, sessions, cfg, script, settings, set, eventPages };
}
test('standalone install, idempotent project setup, default directory and credential refresh', async t => {
  const f = await fixture(t);
  const { dir, requests, cfg, settings } = f;
  const install = path.join(root, 'scripts/install.mjs');
  const skills = path.join(dir, 'skills');
  assert.equal((await run(install, ['dir', skills], dir)).code, 0);
  const script = path.join(skills, 'twssh/scripts/twssh.mjs');
  assert.equal((await run(script, ['init'], dir)).code, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings)), { version: 1, connections: [cfg] });
  assert.match(fs.readFileSync(path.join(dir, '.twssh/.gitignore'), 'utf8'), /state\//);
  const check = await run(script, ['doctor'], dir);
  assert.equal(check.code, 0, check.err);
  assert.ok(!(check.out + check.err).includes('test-secret'));
  const create = await run(script, ['session', 'create', '--name', 'task'], dir);
  assert.equal(create.code, 0, create.err);
  assert.equal(requests.at(-1).body.cwd, 'C:/twsshProjecTemp');
  const id = JSON.parse(create.out).sessionId;
  const local = JSON.parse((await run(script, ['session', 'local'], dir)).out);
  assert.equal(local.sessions[id].name, 'task');
  assert.equal((await run(script, ['exec', '--session', id, '--command', 'echo hello'], dir)).code, 0);
  assert.equal(requests.at(-1).body.text, 'echo hello\r');
  fs.writeFileSync(cfg.tokenFile, 'changed-secret');
  assert.equal((await run(script, ['doctor'], dir)).code, 0);
  assert.equal(requests.at(-1).auth, 'Bearer changed-secret');
  f.set([{ ...cfg, cwd: 'D:/project with spaces' }]);
  assert.equal((await run(script, ['session', 'create'], dir)).code, 0);
  assert.equal(requests.at(-1).body.cwd, 'D:/project with spaces');
  assert.equal((await run(script, ['session', 'create', '--cwd', 'E:/override'], dir)).code, 0);
  assert.equal(requests.at(-1).body.cwd, 'E:/override');
  const before = fs.readFileSync(settings, 'utf8');
  assert.equal((await run(install, ['dir', skills], dir)).code, 0);
  assert.equal(fs.readFileSync(settings, 'utf8'), before);
  assert.equal(fs.readdirSync(path.join(dir, 'skill-backups')).length, 1);
});
test('multiple targets require explicit selection before any network access', async t => {
  const { dir, requests, cfg, script, set } = await fixture(t);
  set([cfg, { ...cfg, name: '14700' }]);
  assert.equal((await run(script, ['doctor'], dir)).code, 1);
  assert.equal((await run(script, ['doctor', '--target', 'missing'], dir)).code, 1);
  assert.equal(requests.length, 0);
  set([cfg, cfg]);
  assert.match((await run(script, ['doctor', '--target', '8845h'], dir)).err, /重复/);
  assert.equal(requests.length, 0);
  set([cfg, { ...cfg, name: '14700' }]);
  const created = await run(script, ['--target', '8845h', 'session', 'create'], dir);
  const id = JSON.parse(created.out).sessionId;
  const count = requests.length;
  assert.equal((await run(script, ['--target', '14700', 'exec', '--session', id, '--command', 'echo wrong'], dir)).code, 1);
  assert.equal(requests.length, count);
  // Explicit adoption verifies an existing session; automatic cross-target reuse is blocked.
  assert.equal((await run(script, ['--target', '14700', 'session', 'adopt', '--session', id], dir)).code, 0);
  assert.equal((await run(script, ['--target', '14700', 'status', '--session', id], dir)).code, 0);
  assert.equal((await run(script, ['--target', '14700', 'session', 'adopt', '--session', randomUUID()], dir)).code, 1);
});
test('workspaces and changed endpoints cannot silently inherit sessions or parent/global config', async t => {
  const { dir, cfg, script, set, requests } = await fixture(t);
  const created = await run(script, ['session', 'create'], dir);
  const id = JSON.parse(created.out).sessionId;
  const child = path.join(dir, 'another project'); fs.mkdirSync(child);
  const count = requests.length;
  assert.equal((await run(script, ['doctor'], child)).code, 1);
  assert.equal(requests.length, count);
  assert.equal((await run(script, ['--project', dir, 'status', '--session', id], child)).code, 0);
  assert.equal((await run(script, ['init'], child)).code, 0);
  fs.writeFileSync(path.join(child, '.twssh/connections.json'), JSON.stringify({ version: 1, connections: [cfg] }));
  const before = requests.length;
  assert.equal((await run(script, ['exec', '--session', id, '--command', 'echo wrong'], child)).code, 1);
  assert.equal(requests.length, before);
  set([{ ...cfg, url: 'http://127.0.0.1:1' }]);
  assert.equal((await run(script, ['exec', '--session', id, '--command', 'echo wrong'], dir)).code, 1);
  assert.equal(requests.length, before);
});
test('bundled client matches canonical CLI', () => {
  // Git may check out identical sources with CRLF or LF on different platforms.
  const normalizeEol = text => text.replace(/\r\n/g, '\n');
  for (const file of ['twssh.mjs', 'transport.mjs', 'output-view.mjs', 'collect-events.mjs']) {
    assert.equal(normalizeEol(fs.readFileSync(path.join(root, 'scripts/client', file), 'utf8')),
      normalizeEol(fs.readFileSync(new URL(`../remote-agent/client/${file}`, import.meta.url), 'utf8')),
      `${file}: bundled client must match canonical CLI apart from CRLF/LF line endings`);
  }
});

test('rename updates registered label and identity without terminal input', async t => {
  const { dir, requests, script } = await fixture(t);
  const created = JSON.parse((await run(script, ['session', 'create', '--name', 'before'], dir)).out);
  const before = requests.length;
  const renamed = await run(script, ['session', 'rename', '--session', created.sessionId, '--name', '电脑维护'], dir);
  assert.equal(renamed.code, 0, renamed.err);
  assert.equal(JSON.parse(renamed.out).label, '电脑维护');
  assert.equal(requests.slice(before).some(r => /input|control/.test(r.url)), false);
  const identity = await run(script, ['session', 'identity', '--session', created.sessionId], dir);
  assert.equal(JSON.parse(identity.out).displayName, '电脑维护');
  assert.equal(JSON.parse(identity.out).sessionId, created.sessionId);
  const local = JSON.parse((await run(script, ['session', 'local'], dir)).out);
  assert.equal(local.sessions[created.sessionId].name, '电脑维护');
});

test('inspect another remote session without adopting or taking control', async t => {
  const { dir, sessions, script, requests } = await fixture(t);
  const id = randomUUID();
  sessions.set(id, { id, label: 'other', generation: randomUUID(), cwd: 'C:/' });
  const history = await run(script, ['session', 'history', '--session', id], dir);
  assert.equal(history.code, 0, history.err);
  const identity = await run(script, ['session', 'identity', '--session', id], dir);
  assert.equal(identity.code, 0, identity.err);
  assert.equal(JSON.parse(identity.out).sessionId, id);
  assert.deepEqual(JSON.parse((await run(script, ['session', 'local'], dir)).out).sessions, {});
  assert.equal(requests.some(r => /control|input/.test(r.url)), false);
});


test('exec waits in one invocation, reuses connection, and never claims completion', async t => {
  const f = await fixture(t);
  const id = JSON.parse((await run(f.script, ['session', 'create'], f.dir)).out).sessionId;
  f.eventPages.push(
    {events:[{seq:1,type:'output',data:'hello'}],cursor:1,epoch:'test',alive:true,mine:true},
    {events:[],cursor:1,epoch:'test',alive:true,mine:true});
  const before = f.requests.length;
  const result = await run(f.script, ['exec','--session',id,'--command','echo hello','--wait','1'], f.dir);
  assert.equal(result.code,0,result.err);
  const data = JSON.parse(result.out);
  assert.equal(data.state,'sent'); assert.equal(data.completion,'unknown');
  assert.equal(data.observation.events[0].data,'hello');
  assert.equal(data.observation.collection.reason,'quiet');
  const requests = f.requests.slice(before);
  assert.equal(requests.filter(r=>r.url.endsWith('/info')).length,0);
  assert.equal(requests.filter(r=>r.url.endsWith('/input')).length,1);
  assert.equal(new Set(requests.map(r=>r.port)).size,1);
  const count = f.requests.length;
  assert.equal((await run(f.script,['exec','--session',id,'--command','echo wrong','--wait','NaN'],f.dir)).code,1);
  assert.equal(f.requests.length,count);
});

test('read limits preserve cursor and accepted sends survive observation failure', async t => {
  const f = await fixture(t);
  const id = JSON.parse((await run(f.script,['session','create'],f.dir)).out).sessionId;
  f.eventPages.push({events:[{seq:1,type:'output',data:'first'}],cursor:1,epoch:'test',alive:true,mine:true});
  const first = JSON.parse((await run(f.script,['read','--session',id,'--collect','--wait','1','--max-batches','1'],f.dir)).out);
  assert.equal(first.collection.reason,'batch-limit');
  assert.equal(first.collection.mayHaveMore,true);
  f.eventPages.push({events:[{seq:2,type:'output',data:'second'}],cursor:2,epoch:'test',alive:true,mine:true});
  const next = JSON.parse((await run(f.script,['read','--session',id],f.dir)).out);
  assert.equal(next.events[0].data,'second'); assert.equal(next.observation,undefined);
  assert.match(f.requests.at(-1).url,/after=1/);
  f.eventPages.push({error:'READ_UNAVAILABLE'});
  const before = f.requests.length;
  const sent = JSON.parse((await run(f.script,['exec','--session',id,'--command','echo once','--wait','1'],f.dir)).out);
  assert.equal(sent.state,'sent'); assert.match(sent.observationError,/503/);
  assert.match(sent.nextAction,/do-not-resend/);
  assert.equal(f.requests.slice(before).filter(r=>r.url.endsWith('/input')).length,1);
});
