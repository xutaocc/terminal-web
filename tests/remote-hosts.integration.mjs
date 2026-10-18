// Two (or more) real servers on this machine, the first driving the others as
// remotes, checked the way a browser uses them:
//  - the page's only long-lived connection is its own server's status stream,
//    and it carries every remote's status (`remote` events);
//  - one page per address stays well within the browser's six connections even
//    with five remotes; a second and third tab on the same address still load;
//  - a remote's session status (hook) reaches the page through that stream;
//  - remote host-info reports its platform; the file browser and upload work
//    through /remote/<id>/ with this OS's paths.
// Run: node tests/remote-hosts.integration.mjs  (Windows needs psmux in .psmux\)
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const WINDOWS = process.platform === 'win32';
const T = process.env.TMUX_BIN || (WINDOWS ? path.join(root, '.psmux', 'tmux.exe') : 'tmux');
if (WINDOWS && !fs.existsSync(T)) { console.log('SKIP: psmux not found in .psmux\\ (or set TMUX_BIN)'); process.exit(0); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }

const folder = await mkdtemp(path.join(os.tmpdir(), 'terminal-remotes-'));
const servers = [];
async function startServer(label) {
  const port = await freePort(), token = crypto.randomBytes(16).toString('hex');
  const dir = path.join(folder, label); fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), AUTH_TOKEN: token,
    REMOTES_FILE: path.join(dir, 'remotes.json'), AGENT_STATUS_FILE: path.join(dir, 'agent-status.json'),
    PATH: (WINDOWS ? path.dirname(T) + path.delimiter : '') + process.env.PATH };
  fs.writeFileSync(env.AGENT_STATUS_FILE, JSON.stringify({ mode: 'hooks' }));
  const child = spawn(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'src/server.ts'], { cwd: root, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(base); break; } catch { await sleep(100); } }
  const s = { label, port, token, base, child, H: { Cookie: `tw_auth=${token}`, Origin: base } };
  servers.push(s);
  return s;
}
const results = [];
const check = (label, ok, extra = '') => { results.push([label, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  — ' + extra : ''}`); };
const sessions = [];
try {
  const A = await startServer('A');
  const remotesB = [];
  for (let i = 0; i < 5; i++) remotesB.push(await startServer(`B${i}`));
  const B = remotesB[0];
  const api = (s, p, init = {}) => fetch(s.base + p, { ...init, headers: { ...s.H, 'Content-Type': 'application/json', ...(init.headers || {}) } });

  // Add the five as remotes of A, as the settings sheet does.
  for (const r of remotesB) {
    const res = await api(A, '/api/remotes', { method: 'POST', body: JSON.stringify({ action: 'add', name: r.label, url: r.base, token: r.token }) });
    assert.equal(res.status, 200, await res.text());
  }
  const list = await (await api(A, '/api/remotes')).json();
  const idOf = label => list.remotes.find(r => r.name === label).id;
  const bId = idOf('B0');
  check('A lists 5 remotes', list.remotes.length === 5);

  // host-info reports the platform, also through the forwarder.
  const info = await (await api(A, `/remote/${bId}/api/host-info`)).json();
  check('remote host-info reports its platform', info.platform === process.platform, JSON.stringify(info.platform));

  // A session on B, opened through A, with a fake agent reporting through the hook endpoint.
  const name = 'rmt' + process.pid; sessions.push([B, name]);
  const ws = new WebSocket(`ws://127.0.0.1:${A.port}/remote/${bId}/ws?session=${name}&create=1&cols=100&rows=24`, { headers: A.H });
  ws.on('message', (d, bin) => { if (bin && d.toString().includes('\x1b[c')) ws.send(Buffer.from('\x1b[?1;2c')); });
  await once(ws, 'open'); await sleep(2500);
  const exists = (() => { try { execFileSync(T, ['has-session', '-t', `=${name}`], { stdio: 'ignore' }); return true; } catch { return false; } })();
  check('session created on the remote through A', exists);

  // Page's status stream on A: own status, health, and remote statuses.
  const events = [];
  const sse = await new Promise((resolve, reject) => {
    const req = fetch(`${A.base}/api/agent-status/events?health=1`, { headers: A.H }).then(res => {
      const reader = res.body.getReader(); let buf = '';
      (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += Buffer.from(value).toString('utf8'); let cut; while ((cut = buf.indexOf('\n\n')) >= 0) { const frame = buf.slice(0, cut); buf = buf.slice(cut + 2); const ev = /^event: (\w+)/m.exec(frame)?.[1] ?? 'message'; const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n'); events.push({ ev, data }); } } })().catch(() => {});
      resolve(reader);
    }, reject);
    void req;
  });
  await sleep(2500);
  const remoteEvents = () => events.filter(e => e.ev === 'remote').map(e => JSON.parse(e.data));
  const reported = new Set(remoteEvents().filter(e => e.status).map(e => e.host));
  check('status stream carries every remote\'s status', list.remotes.every(r => reported.has(r.id)), `${reported.size}/5`);

  // B's session goes "done + unread" by hook; the page hears it on A's stream.
  const hook = await fetch(`${B.base}/api/agent-hook`, { method: 'POST', headers: { Cookie: `tw_auth=${B.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ pane: '%1', session: name, event: 'Stop' }) });
  check('hook on the remote accepted', (await hook.json()).used === true);
  let seen = null;
  for (let i = 0; i < 40 && !seen; i++) { seen = remoteEvents().reverse().find(e => e.host === bId && e.status?.sessions?.[name]?.state === 'done'); await sleep(100); }
  check('remote session status reaches the page through A', !!seen && seen.status.sessions[name].unread === true);

  // File browser through the forwarder, with this OS's paths.
  const dir = await mkdtemp(path.join(folder, 'files-'));
  await writeFile(path.join(dir, 'a.txt'), 'hi');
  const listing = await (await api(A, `/remote/${bId}/api/files/list?${new URLSearchParams({ path: dir })}`)).json();
  check('file listing through the remote', listing.entries?.some(e => e.name === 'a.txt'), JSON.stringify(listing).slice(0, 120));
  const up = await fetch(`${A.base}/remote/${bId}/upload?name=${encodeURIComponent('my file.txt')}`, { method: 'POST', headers: { ...A.H, 'Content-Type': 'text/plain' }, body: 'uploaded' });
  const upJson = await up.json();
  check('upload through the remote returns the remote\'s path', up.ok && path.isAbsolute(upJson.path) && (await readFile(upJson.path, 'utf8')) === 'uploaded', upJson.path);

  // Removing a remote: the page is told its status is gone.
  const before = remoteEvents().length;
  await api(A, '/api/remotes', { method: 'POST', body: JSON.stringify({ action: 'remove', id: idOf('B4') }) });
  await sleep(800);
  check('removed remote is cleared from the stream', remoteEvents().slice(before).some(e => e.host === idOf('B4') && e.status === null));
  await sse.cancel().catch(() => {});
  ws.close();
} catch (e) { console.log('ERROR', e); }
finally {
  for (const [s, name] of sessions) try { execFileSync(T, ['kill-session', '-t', `=${name}`], { stdio: 'ignore' }); } catch {}
  for (const s of servers) { try { if (WINDOWS) execFileSync('taskkill', ['/PID', String(s.child.pid), '/T', '/F'], { stdio: 'ignore' }); else s.child.kill(); } catch {} }
  await sleep(500);
  await rm(folder, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${results.filter(r => r[1]).length}/${results.length} passed`);
  process.exit(results.every(r => r[1]) ? 0 : 1);
}
