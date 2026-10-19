// With five remotes added, open the page in several tabs of one real Chrome on
// the same address: every tab must load, and each page must hold only one
// long-lived stream (no per-remote /remote/<id>/api/agent-status/events).
// Run on Windows: node tests/remote-hosts.ui.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const WINDOWS = process.platform === 'win32';
const chromeBinary = process.env.BROWSER_BIN || (WINDOWS ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome');
if (!fs.existsSync(chromeBinary)) { console.log('SKIP: set BROWSER_BIN to installed Chrome'); process.exit(0); }
const T = process.env.TMUX_BIN || (WINDOWS ? path.join(root, '.psmux', 'tmux.exe') : 'tmux');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-remotes-ui-'));
const servers = [];
async function startServer(label) {
  const port = await freePort(), token = crypto.randomBytes(16).toString('hex');
  const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), AUTH_TOKEN: token, REMOTES_FILE: path.join(folder, `${label}.json`),
    PATH: (WINDOWS ? path.dirname(T) + path.delimiter : '') + process.env.PATH };
  const child = spawn(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'src/server.ts'], { cwd: root, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(base); break; } catch { await sleep(100); } }
  const s = { port, token, base, child }; servers.push(s); return s;
}
let chrome;
try {
  const A = await startServer('A');
  for (let i = 0; i < 5; i++) {
    const r = await startServer(`R${i}`);
    const res = await fetch(`${A.base}/api/remotes`, { method: 'POST', headers: { Cookie: `tw_auth=${A.token}`, Origin: A.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', name: `R${i}`, url: r.base, token: r.token }) });
    assert.equal(res.status, 200);
  }
  const debugPort = await freePort();
  chrome = spawn(chromeBinary, ['--headless=new', '--no-first-run', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(folder, 'chrome')}`, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  const json = async (p, method = 'GET') => { for (let i = 0; i < 100; i++) { try { return await (await fetch(`http://127.0.0.1:${debugPort}${p}`, { method })).json(); } catch { await sleep(100); } } };
  await json('/json');
  const tabs = 3;
  for (let i = 0; i < tabs; i++) {
    const t = await json('/json/new?about:blank', 'PUT');
    const ws = new WebSocket(t.webSocketDebuggerUrl); await once(ws, 'open');
    let id = 0; const pending = new Map(); const streams = new Set();
    ws.on('message', raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } if (m.method === 'Network.requestWillBeSent' && m.params.type === 'EventSource') streams.add(new URL(m.params.request.url).pathname); });
    const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
    await send('Network.enable'); await send('Runtime.enable');
    await send('Network.setCookie', { name: 'tw_auth', value: A.token, url: A.base, path: '/', httpOnly: true, sameSite: 'Lax' });
    await send('Page.navigate', { url: `${A.base}/` });
    let loaded = false;
    for (let k = 0; k < 60 && !loaded; k++) {
      const r = await send('Runtime.evaluate', { expression: `document.querySelectorAll('.ps-host').length >= 6 || document.querySelectorAll('.ps-host-head, .ps-host').length >= 6`, returnByValue: true });
      loaded = r.result.value === true; if (!loaded) await sleep(200);
    }
    const sessionsLoaded = (await send('Runtime.evaluate', { expression: `!!document.querySelector('.tab')`, returnByValue: true })).result.value;
    console.log(`tab ${i + 1}: page ${sessionsLoaded ? 'loaded' : 'BLANK'}; streams ${JSON.stringify([...streams])}`);
    assert.ok(sessionsLoaded, `tab ${i + 1} loaded`);
    assert.deepEqual([...streams], ['/api/agent-status/events'], 'one stream per page, none per remote');
  }
  console.log(`PASS  ${tabs} tabs on one address with 5 remotes all load; one long-lived stream each`);
} finally {
  if (chrome) try { execFileSync(WINDOWS ? 'taskkill' : 'kill', WINDOWS ? ['/PID', String(chrome.pid), '/T', '/F'] : [String(chrome.pid)], { stdio: 'ignore' }); } catch {}
  for (const s of servers) try { if (WINDOWS) execFileSync('taskkill', ['/PID', String(s.child.pid), '/T', '/F'], { stdio: 'ignore' }); else s.child.kill(); } catch {}
  await sleep(500);
  fs.rmSync(folder, { recursive: true, force: true });
}
