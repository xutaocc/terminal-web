import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const windows = process.platform === 'win32';
const tmux = process.env.TMUX_BIN || (windows ? path.resolve('.psmux/tmux.exe') : 'tmux');
try { execFileSync(tmux, ['-V'], { stdio: 'ignore' }); } catch { console.log('SKIP: tmux/psmux is required for shares integration'); process.exit(0); }
const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-share-')));
const muxSocket = `share-test-${process.pid}`;
let mux = tmux;
if (!windows) { mux = path.join(dir, 'tmux-wrapper'); await fs.writeFile(mux, `#!/bin/sh\nexec "${tmux}" -L ${muxSocket} "$@"\n`, { mode: 0o700 }); }
const children = [], sockets = [], names = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { const s = net.createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
async function start(label, previous) {
  const folder = path.join(dir, label); await fs.mkdir(folder, { recursive: true });
  let serverMux = mux;
  if (!windows) { serverMux = path.join(folder, 'tmux-wrapper'); await fs.writeFile(serverMux, `#!/bin/sh\nexec "${tmux}" -L ${muxSocket}-${label} "$@"\n`, {mode:0o700}); }
  const port = previous?.port ?? await freePort(); const token = previous?.token ?? randomBytes(24).toString('hex');
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), AUTH_TOKEN: token, TMUX_BIN: serverMux, AGENT_STATUS_MODE: 'hooks' };
  for (const [variable, file] of Object.entries({ SESSIONS_FILE: 'sessions', SHARES_FILE: 'shares', REMOTES_FILE: 'remotes', PREFS_FILE: 'prefs', AGENT_STATUS_FILE: 'agent', VIEWER_STATE_FILE: 'viewer', PROJECTS_FILE: 'projects', QUICK_COMMANDS_FILE: 'commands', CLOSED_SESSIONS_FILE: 'closed' })) env[variable] = path.join(folder, file + '.json');
  const proc = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(proc);
  let log = ''; proc.stdout.on('data', b => log += b); proc.stderr.on('data', b => log += b);
  const server = { proc, port, token, mux: serverMux, base: `http://127.0.0.1:${port}`, folder, log: () => log };
  for (let i = 0; i < 100; i++) { if (proc.exitCode !== null) throw new Error(log); try { await fetch(server.base); return server; } catch {} await sleep(50); }
  throw new Error('startup timeout: ' + log);
}
async function request(s, route, data, cookie = `tw_auth=${s.token}`) {
  return fetch(s.base + route, { headers: { Cookie: cookie, Origin: s.base, ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }) });
}
async function api(s, route, data, cookie) { const r = await request(s, route, data, cookie); const text = await r.text(); assert.equal(r.status, 200, `${route}: ${text}`); return JSON.parse(text); }
async function ws(s, route, cookie = `tw_auth=${s.token}`) {
  const sock = new WebSocket(s.base.replace('http', 'ws') + route, { headers: { Cookie: cookie, Origin: s.base } }); sockets.push(sock); sock.on('error', () => {});
  let control = null; sock.control = () => control;
  const beat = setInterval(() => { if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({type:'control',action:'heartbeat'})); },4000);sock.once('close',()=>clearInterval(beat));
  let output = ''; sock.on('message', (b, binary) => { if (!binary) { try { const m=JSON.parse(b.toString()); if(m.type==='control') control=m; } catch {} } if (binary) { output += b.toString(); if (b.toString().includes('\x1b[c')) sock.send(Buffer.from('\x1b[?1;2c')); } }); sock.output = () => output;
  await once(sock, 'open'); return sock;
}
async function until(fn, msg) { for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(50); } throw new Error(msg); }
async function createSession(s, name, cwd) { names.push(name); const sock = await ws(s, `/ws?session=${name}&create=1&dir=${encodeURIComponent(cwd)}&cols=100&rows=30`); await until(async () => (await api(s, '/api/sessions')).tabs.some(t => t.name === name && t.cwd), 'session not registered'); await until(() => { try { return !!execFileSync(s.mux, ['display-message', '-p', '-t', `=${name}:`, '#{pane_current_path}'], {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch { return false; } }, 'live session not ready'); return sock; }
async function login(s, share) { const r = await request(s, `/share/${share.share.id}/login`, { token: share.token }, ''); assert.equal(r.status, 200); return r.headers.getSetCookie().map(s => s.split(';')[0]).join('; '); }
async function stop(s) { if (s.proc.exitCode === null) { const exited = once(s.proc, 'exit'); s.proc.kill('SIGTERM'); await exited; } }
let A, B;
try {
  const root = path.join(dir, 'project'); await fs.mkdir(root); await fs.mkdir(path.join(root, 'child'));
  await fs.writeFile(path.join(root, 'hello.txt'), 'shared file'); await fs.writeFile(path.join(dir, 'outside.txt'), 'outside');
  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><link rel="stylesheet" href="style.css"><h1 id="result">Preview</h1><script src="app.js"></script>');
  await fs.writeFile(path.join(root, 'style.css'), 'h1{color:rgb(255,0,0)}'); await fs.writeFile(path.join(root, 'app.js'), 'document.querySelector("h1").textContent="Preview script loaded"');
  if (!windows) await fs.symlink(dir, path.join(root, 'escape'));
  A = await start('A'); B = await start('B');
  const n1 = `share_local_${process.pid}`, n2 = `share_remote_${process.pid}`, n3 = `share_other_${process.pid}`;
  const admin1 = await createSession(A, n1, root); const admin2 = await createSession(B, n2, root); await createSession(A, n3, root);
  const remotes = await api(A, '/api/remotes', { action: 'add', name: '远程', url: B.base, token: B.token }); const remote = remotes.remotes[0];
  const catalog = await api(A, '/api/shares/catalog'); assert.equal(catalog.groups.length, 2); assert(catalog.groups[1].sessions.some(s => s.name === n2));
  assert.equal((await request(A, '/api/shares', { action: 'create', name: '过时目录', sessions: [{ host: '', name: n1, root: '/stale-root' }], expiresAt: null })).status, 409);
  await api(A, '/api/agent-hook', {pane:'%1',session:n1,event:'UserPromptSubmit'});
  await api(A, '/api/agent-hook', {pane:'%1',session:n1,event:'Stop'});
  const initialStatus = (await api(A, '/api/agent-status')).sessions[n1];
  const created = await api(A, '/api/shares', { action: 'create', name: '本机与远程联调', sessions: [{ host: '', name: n1 }, { host: remote.id, name: n2 }], expiresAt: null });
  assert(!JSON.stringify(await api(A, '/api/shares')).includes(created.token)); assert(!JSON.stringify(await api(A, '/api/shares')).includes('tokenHash'));
  const cookie = await login(A, created); const prefix = `/share/${created.share.id}/`;
  const viewer = prefix + 'app/api/viewer-state';
  const initialViewer = await api(A, viewer, undefined, cookie);
  assert.equal(initialViewer.reads[JSON.stringify([n1,initialStatus.instance])], initialStatus.eventSeq);
  await api(A, '/api/agent-hook', {pane:'%1',session:n1,event:'UserPromptSubmit'});
  await api(A, '/api/agent-hook', {pane:'%1',session:n1,event:'Stop'});
  const nextStatus = (await api(A, '/api/agent-status')).sessions[n1];
  assert(nextStatus.eventSeq > initialViewer.reads[JSON.stringify([n1,initialStatus.instance])]);
  assert.equal((await api(A, viewer, undefined, cookie)).reads[JSON.stringify([n1,initialStatus.instance])], initialStatus.eventSeq);
  await api(A, '/api/viewer-state', {type:'read', session:n1, instance:'test', seq:10});
  assert.equal((await api(A, viewer, undefined, cookie)).reads[JSON.stringify([n1,'test'])], undefined);
  await api(A, viewer, {type:'read', session:n1, instance:'test', seq:5}, cookie);
  assert.equal((await api(A, viewer, undefined, cookie)).reads[JSON.stringify([n1,'test'])], 5);
  assert.equal((await api(A, '/api/viewer-state')).reads[JSON.stringify([n1,'test'])], 10);
  await api(A, viewer, {type:'visit', session:`@${remote.id}/${n2}`}, cookie);
  assert.deepEqual((await api(A, viewer, undefined, cookie)).recent, [`@${remote.id}/${n2}`]);
  assert.equal((await request(A, viewer, {type:'visit',session:n3}, cookie)).status, 400);
  assert.deepEqual((await api(A, '/api/viewer-state')).recent, []);
  // File access defaults closed, toggles without logging visitors out, and works across hosts.
  assert.equal(created.share.fileWrite === true, false);
  const fileRoute = prefix + 'app/api/files/';
  const remoteFileRoute = prefix + `app/remote/${remote.id}/api/files/`;
  assert.equal((await request(A, fileRoute+'create?session='+n1, {directory:root,name:'denied.txt',kind:'file'},cookie)).status,403);
  await api(A,'/api/shares',{action:'file-access',id:created.share.id,enabled:true});
  assert.equal((await api(A,prefix+'app/api/sessions/cwd?session='+n1,undefined,cookie)).readOnly,false);
  await api(A,fileRoute+'create?session='+n1,{directory:root,name:'allowed.txt',kind:'file'},cookie);
  await api(A,remoteFileRoute+'create?session='+n2,{directory:root,name:'remote-allowed.txt',kind:'file'},cookie);
  assert.equal((await request(A,fileRoute+'create?session='+n1,{directory:dir,name:'outside-write.txt',kind:'file'},cookie)).status,403);
  assert.equal((await request(A,remoteFileRoute+'create?session='+n2,{directory:dir,name:'outside-remote.txt',kind:'file'},cookie)).status,403);
  await api(A,'/api/shares',{action:'file-access',id:created.share.id,enabled:false});
  assert.equal((await request(A,fileRoute+'create?session='+n1,{directory:root,name:'revoked.txt',kind:'file'},cookie)).status,403);
  assert.equal((await request(A,remoteFileRoute+'create?session='+n2,{directory:root,name:'revoked-remote.txt',kind:'file'},cookie)).status,403);
  assert.equal((await api(A,prefix+'app/api/sessions/cwd?session='+n1,undefined,cookie)).readOnly,true);
  const state = await api(A, prefix + 'state', undefined, cookie); assert.equal(state.sessions.length, 2); assert(!JSON.stringify(state).includes(n3));
  for (const route of ['/api/sessions', '/api/access', '/api/shares', '/api/remotes', '/api/share-peer/catalog', `/remote/${remote.id}/api/sessions`]) assert.equal((await request(A, route, undefined, cookie)).status, 401, route);
  assert.equal((await request(A, prefix + 'login', { token: 'wrong' }, '')).status, 401);
  for (const index of [0, 1]) {
    const list = await api(A, prefix + `files?index=${index}&op=list`, undefined, cookie); assert(list.entries.some(f => f.name === 'hello.txt'));
    assert.equal(await (await request(A, prefix + `files?index=${index}&op=download&path=hello.txt`, undefined, cookie)).text(), 'shared file');
    for (const p of ['../outside.txt', path.join(dir, 'outside.txt'), ...(windows ? [] : ['escape/outside.txt'])]) assert.equal((await request(A, prefix + `files?index=${index}&op=download&path=${encodeURIComponent(p)}`, undefined, cookie)).status, 403, p);
    assert.equal((await request(A, prefix + `files?index=${index}&op=delete&path=hello.txt`, {}, cookie)).status, 403);
    const preview = await request(A, prefix + `preview/${index}/index.html`, undefined, cookie); assert.equal(preview.status, 200); assert.match(preview.headers.get('content-security-policy'), /sandbox allow-scripts/);
  }
  // Shared login serves the very same application, through scoped endpoints.
  const sharedHtml = await (await request(A, prefix, undefined, cookie)).text();
  assert.match(sharedHtml, /id="topbar"/); assert.match(sharedHtml, /assets\/dist\/terminal.js/); assert(!sharedHtml.includes('shares.js'));
  assert.match(await (await request(A, prefix + 'file-browser.html', undefined, cookie)).text(), /file-browser.js/);
  assert.equal((await request(A, prefix + 'assets/dist/terminal.js', undefined, '')).status, 200);
  for (const [host, name] of [['', n1], [remote.id, n2]]) {
    const app = prefix + 'app' + (host ? `/remote/${host}` : '');
    const tabs = await api(A, app + '/api/sessions', undefined, cookie); assert.deepEqual(tabs.tabs.map(t => t.name), [name]);
    const params = new URLSearchParams({ session: name, path: root });
    const list = await api(A, app + '/api/files/list?' + params, undefined, cookie);
    assert.equal(list.directory.path, root); assert(list.entries.some(f => f.name === 'hello.txt' && typeof f.mode === 'string'));
    params.set('path', path.dirname(root)); assert.equal((await request(A, app + '/api/files/list?' + params, undefined, cookie)).status, 403);
    assert.equal((await request(A, app + '/api/files/write', {path:path.join(root,'hello.txt'),text:'bad'}, cookie)).status, 403);
    assert.equal((await request(A, app + '/api/sessions/kill', {name}, cookie)).status, 403);
    assert.equal((await request(A, app + '/api/sessions/cwd?session=unauthorized', undefined, cookie)).status, 403);
    const cwd = await api(A, app + '/api/sessions/cwd?session=' + name, undefined, cookie); assert.equal(cwd.path, root); assert(cwd.previewPrefix.startsWith(prefix));
  }
  const reconnectId = randomBytes(24).toString('hex');
  let local = await ws(A, prefix + 'app/ws?session=' + n1 + '&create=1&client=' + reconnectId, cookie);
  const distant = await ws(A, prefix + `app/remote/${remote.id}/ws?session=${n2}`, cookie);
  await until(()=>local.control() && distant.control(),'control state');
  local.send(JSON.stringify({type:'control',action:'acquire'})); distant.send(JSON.stringify({type:'control',action:'acquire'}));
  await until(()=>local.control().mine && distant.control().mine,'acquire local and remote');
  await sleep(500); local.send(Buffer.from('echo SHARE_LOCAL_OK\r')); distant.send(Buffer.from('echo SHARE_REMOTE_OK\r'));
  await until(() => local.output().includes('SHARE_LOCAL_OK') && distant.output().includes('SHARE_REMOTE_OK'), 'shared terminals must work');
  local.send(JSON.stringify({ type: 'restart' })); await sleep(100); assert.equal(local.readyState, WebSocket.OPEN);
  local.send(Buffer.from('cd ..\r')); await until(() => local.readyState === WebSocket.OPEN, 'local remains connected'); await sleep(200);
  assert.equal(execFileSync(A.mux, ['display-message', '-p', '-t', `=${n1}:`, '#{pane_current_path}'], { encoding: 'utf8' }).trim(), root);
  // Only the operator can send input or resize; administrator and share use one arbiter.
  const control = (socket, action, target) => socket.send(JSON.stringify({type:'control',action,target}));
  assert.equal(admin1.control().mine, false);
  const forbidden = path.join(root, 'observer-must-not-write');
  admin1.send(Buffer.from(`touch '${forbidden}'\r`)); await sleep(150);
  assert.equal(await fs.stat(forbidden).then(()=>true,()=>false), false, 'watcher input must be blocked server-side');
  control(admin1, 'request'); await until(()=>local.control().requests.length===1,'handover request');
  control(local, 'grant', local.control().requests[0].id);
  await until(()=>admin1.control().mine && !local.control().mine,'approved handover');
  control(local, 'takeover'); await sleep(100); assert.equal(local.control().mine,false,'share cannot force takeover');
  admin1.send(JSON.stringify({type:'resize',cols:100,rows:28}));
  const size=()=>execFileSync(A.mux,['display-message','-p','-t',`=${n1}:`,'#{window_width}x#{window_height}'],{encoding:'utf8'}).trim();
  await until(()=>size()==='100x28','owner controls dimensions');
  local.send(JSON.stringify({type:'resize',cols:40,rows:10}));
  const observer = await ws(A, `/ws?session=${n1}&cols=35&rows=8`);
  await until(()=>observer.control(),'new observer connected'); await sleep(100); assert.equal(size(),'100x28','viewer attach/resize cannot resize real terminal'); observer.close();
  control(admin1,'release'); control(local,'acquire'); await until(()=>local.control().mine,'share reclaims');
  local.terminate(); await until(()=>admin1.control().owner?.connected===false,'disconnected owner reservation');
  control(admin1,'acquire');await sleep(100);assert.equal(admin1.control().mine,false,'grace does not permit accidental takeover');
  local=await ws(A,prefix+'app/ws?session='+n1+'&client='+reconnectId,cookie);
  await until(()=>local.control()?.mine,'same tab reconnect restores operation right');
  control(admin1,'takeover');await until(()=>admin1.control().mine&&!local.control().mine,'admin force takeover');
  // Direct remote administration and a proxied share compete on the remote host itself.
  control(admin2,'takeover');await until(()=>admin2.control().mine&&!distant.control().mine,'remote arbiter');
  control(admin2,'release');control(distant,'acquire');await until(()=>distant.control().mine,'remote share reacquires');
  control(admin1,'release');control(local,'acquire');await until(()=>local.control().mine,'restore fixture operator');
  // State notifications are shared, but marking one browser read never clears the shared event.
  const pane=execFileSync(A.mux,['display-message','-p','-t',`=${n1}:`,'#{pane_id}'],{encoding:'utf8'}).trim();
  await api(A,'/api/agent-hook',{pane,session:n1,event:'UserPromptSubmit'});
  await api(A,'/api/agent-hook',{pane,session:n1,event:'Stop'});
  const beforeRead=(await api(A,'/api/agent-status')).sessions[n1];
  const sharedStatus=(await api(A,prefix+'app/api/agent-status',undefined,cookie)).sessions[n1];
  assert.equal(sharedStatus.version,beforeRead.version);assert.equal(sharedStatus.eventSeq,beforeRead.eventSeq);assert(beforeRead.eventSeq>0);
  await api(A,'/api/agent-status/read',{sessions:[n1]});
  assert.equal((await api(A,prefix+'app/api/agent-status',undefined,cookie)).sessions[n1].eventSeq,beforeRead.eventSeq,'admin read cannot erase visitor notification');
  if (process.env.SHARE_UI_FIXTURE) {
    control(local,'release'); control(distant,'release');
    await fs.writeFile('/tmp/terminal-share-ui.json', JSON.stringify({ base: A.base, adminToken: A.token, token: created.token, id: created.share.id, dir, root, pid: process.pid, localName: n1, remoteHost: remote.id, remoteName: n2 }));
    console.log('UI fixture ready /tmp/terminal-share-ui.json'); await new Promise(resolve => process.once('SIGTERM', resolve));
  } else {
    const rotated = await api(A, '/api/shares', { action: 'reset', id: created.share.id });
    await until(() => local.readyState === WebSocket.CLOSED && distant.readyState === WebSocket.CLOSED, 'rotation must disconnect both terminals');
    assert.equal((await request(A, prefix + 'state', undefined, cookie)).status, 401);
    assert.equal((await request(A, prefix + 'login', { token: created.token }, '')).status, 401);
    const nextCookie = await login(A, rotated); const l2 = await ws(A, prefix + 'ws?index=0', nextCookie); const r2 = await ws(A, prefix + 'ws?index=1', nextCookie);
    await api(A, '/api/shares', { action: 'revoke', id: created.share.id });
    await until(() => l2.readyState === WebSocket.CLOSED && r2.readyState === WebSocket.CLOSED, 'revoke must disconnect both terminals');
    assert.equal(admin1.readyState, WebSocket.OPEN); assert.equal(admin2.readyState, WebSocket.OPEN);
    assert.equal((await request(A, prefix + 'state', undefined, nextCookie)).status, 410);
    assert.equal((await request(A, prefix + 'files?index=1&op=download&path=hello.txt', undefined, nextCookie)).status, 410);
    const restored = await api(A, '/api/shares', {action:'restore', id:created.share.id, expiresAt:null});
    assert.equal(restored.share.status, 'active');
    assert.notEqual(restored.token, rotated.token);
    assert.deepEqual(restored.share.sessions, rotated.share.sessions);
    assert.equal((await request(A, prefix + 'login', {token:rotated.token}, '')).status, 401);
    assert.equal((await request(A, prefix + 'state', undefined, nextCookie)).status, 401);
    await login(A, restored);
    assert.equal((await request(A, '/api/shares', {action:'restore', id:created.share.id, expiresAt:null})).status, 409);
    await api(A, '/api/shares', {action:'revoke', id:created.share.id});
    const editable = await api(A, '/api/shares', { action: 'create', name: '范围调整', sessions: [{ host: '', name: n1 }, { host: remote.id, name: n2 }], expiresAt: null });
    const editableCookie = await login(A, editable); const ep = `/share/${editable.share.id}/`;
    const remoteEditing = await ws(A, ep + 'ws?index=1', editableCookie);
    const previewGrant = await api(A, ep + 'preview-ticket', { index: 1 }, editableCookie);
    assert.equal((await request(A, ep + previewGrant.prefix + 'app.js', undefined, '')).status, 200, 'sandbox resources use scoped preview credentials');
    assert.equal((await request(A, ep + previewGrant.prefix + '%2e%2e%2foutside.txt', undefined, '')).status, 403);
    await api(A, '/api/shares', { action: 'update', id: editable.share.id, name: '只留本机', sessions: [{ host: '', name: n1 }], expiresAt: null });
    await until(() => remoteEditing.readyState === WebSocket.CLOSED, 'removing authorization must disconnect remote');
    assert.equal((await api(A, ep + 'state', undefined, editableCookie)).sessions.length, 1, 'scope changes preserve valid login');
    assert.equal((await request(A, ep + 'files?index=1&op=list', undefined, editableCookie)).status, 403);
    assert.equal((await request(A, ep + previewGrant.prefix + 'app.js', undefined, '')).status, 403, 'old preview credential cannot switch to changed scope');
    const deleted = await api(A, '/api/shares', { action: 'create', name: '删除重建', sessions: [{ host: '', name: n3 }], expiresAt: null });
    const dc = await login(A, deleted);
    await api(A, '/api/sessions/kill', { name: n3 });
    await until(() => { try { execFileSync(A.mux, ['has-session', '-t', `=${n3}`], {stdio:'ignore'}); return false; } catch { return true; } }, 'session deleted');
    await createSession(A, n3, root);
    assert.equal((await api(A, `/share/${deleted.share.id}/state`, undefined, dc)).sessions[0].available, false, 'same-name replacement never inherits grant');
    assert.equal((await request(A, `/share/${deleted.share.id}/files?index=0&op=list`, undefined, dc)).status, 410);
    const remoteOnly = await api(A, '/api/shares', { action: 'create', name: '远端移除', sessions: [{ host: remote.id, name: n2 }], expiresAt: null });
    const rc = await login(A, remoteOnly); const rw = await ws(A, `/share/${remoteOnly.share.id}/ws?index=0`, rc);
    await api(A, '/api/remotes', { action: 'remove', id: remote.id });
    await until(() => rw.readyState === WebSocket.CLOSED, 'removed host disconnects its share sockets');
    const expiring = await api(A, '/api/shares', { action: 'create', name: '短期', sessions: [{ host: '', name: n1 }], expiresAt: Date.now() + 2000 });
    const ec = await login(A, expiring); const ew = await ws(A, `/share/${expiring.share.id}/ws?index=0`, ec); await until(() => ew.readyState === WebSocket.CLOSED, 'expiry disconnect');
    await stop(A); A = await start('A', A);
    assert.equal((await request(A, prefix + 'state', undefined, nextCookie)).status, 410);
    assert.equal((await api(A, '/api/shares')).shares.find(s => s.id === created.share.id).status, 'revoked');
    console.log('PASS: exclusive control, watcher input/resize rejection, handover, remote arbitration, reconnect, independent read events; local/remote sharing, scoped files and previews, shell cd, rotation, revocation, scope edits, session replacement, host removal, expiry and restart');
  }
} catch (e) { console.error(A?.log().replaceAll(A.token, '[test token]'), B?.log().replaceAll(B.token, '[test token]')); throw e; }
finally {
  for (const s of sockets) s.terminate();
  for (const c of children) if (c.exitCode === null) { const exited = once(c, 'exit'); c.kill('SIGTERM'); await exited; }
  if (!windows) { for (const label of ['A', 'B']) { try { execFileSync(tmux, ['-L', muxSocket + '-' + label, 'kill-server'], { stdio: 'ignore' }); } catch {} } }
  else for (const name of names) { try { execFileSync(mux, ['kill-session', '-t', name], { stdio: 'ignore' }); } catch {} }
  await fs.rm(dir, { recursive: true, force: true });
}
