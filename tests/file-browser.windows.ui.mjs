// Windows UI check, in a real Chrome against an isolated server:
//  1) file browser: the path shows as clickable segments (C:\ › Users › …) and
//     each segment, ↑ 上一级 and 根目录 navigate correctly on C:\ paths;
//  2) sidebar: clicking a directory card whose dot is unread goes to the
//     unread session, not to the one last used there.
// Run on Windows: node tests/file-browser.windows.ui.mjs  (BROWSER_BIN to override Chrome)
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';

if (process.platform !== 'win32') { console.log('SKIP: Windows only'); process.exit(0); }
const chromeBinary = process.env.BROWSER_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!fs.existsSync(chromeBinary)) { console.log('SKIP: set BROWSER_BIN to installed Chrome'); process.exit(0); }
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const T = process.env.TMUX_BIN || path.join(root, '.psmux', 'tmux.exe');
if (!fs.existsSync(T)) { console.log('SKIP: psmux not found in .psmux\\ (or set TMUX_BIN)'); process.exit(0); }
async function freePort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const folder = await mkdtemp(path.join(os.tmpdir(), 'terminal-files-win-ui-'));
const fixture = path.join(folder, 'workspace', 'deeper'); await mkdir(fixture, { recursive: true });
await writeFile(path.join(fixture, 'note.txt'), 'hello');
const token = crypto.randomBytes(32).toString('hex');
const port = await freePort(), debugPort = await freePort();
const base = `http://127.0.0.1:${port}`;
const statusFile = path.join(folder, 'agent-status.json'); await writeFile(statusFile, JSON.stringify({ mode: 'hooks' }));
const server = spawn(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'src/server.ts'], {
  cwd: root, stdio: 'ignore',
  env: { ...process.env, AUTH_TOKEN: token, HOST: '127.0.0.1', PORT: String(port), AGENT_STATUS_FILE: statusFile, PATH: path.dirname(T) + path.delimiter + process.env.PATH },
});
const tag = `wui${process.pid}`;
const names = [`${tag}a`, `${tag}b`];
let chrome, cdp;
try {
  for (let i = 0; i < 100; i++) { try { await fetch(base); break; } catch { await sleep(100); } }
  // Two sessions in the same directory, so they share one sidebar card.
  const H = { Cookie: `tw_auth=${token}`, Origin: base };
  for (const name of names) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session=${name}&create=1&cols=100&rows=24&dir=${encodeURIComponent(fixture)}`, { headers: H });
    ws.on('message', (d, bin) => { if (bin && d.toString().includes('\x1b[c')) ws.send(Buffer.from('\x1b[?1;2c')); });
    await once(ws, 'open'); await sleep(2500); ws.close();
  }

  chrome = spawn(chromeBinary, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(folder, 'chrome')}`, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 100 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find(t => t.type === 'page'); } catch { await sleep(100); } }
  cdp = new WebSocket(target.webSocketDebuggerUrl); await once(cdp, 'open');
  let id = 0; const pending = new Map();
  cdp.on('message', raw => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); cdp.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression, frame) => {
    const r = await send('Runtime.evaluate', { expression: `(async()=>{${frame ? `const doc=document.querySelector('#file-browser-frame, iframe')?.contentDocument;` : 'const doc=document;'} ${expression}})()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r.result?.result?.value;
  };
  const until = async (expression, frame, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await evaluate(expression, frame); if (v) return v; await sleep(150); } throw new Error(`timed out: ${expression}`); };
  await send('Page.enable'); await send('Runtime.enable');

  // --- 1) file browser breadcrumbs -----------------------------------------
  await send('Network.setCookie', { name: 'tw_auth', value: token, url: base, path: '/', httpOnly: true, sameSite: 'Lax' });
  await send('Page.navigate', { url: `${base}/file-browser.html?session=${names[0]}` });
  await until(`return doc.querySelectorAll('#breadcrumbs .crumb').length > 1`);
  const crumbLabels = await evaluate(`return [...doc.querySelectorAll('#breadcrumbs .crumb')].map(b => b.textContent)`);
  const expected = [path.parse(fixture).root, ...fixture.slice(path.parse(fixture).root.length).split('\\')];
  assert.deepEqual(crumbLabels, expected, 'one breadcrumb per path segment');
  const currentLabel = await evaluate(`return doc.querySelector('#breadcrumbs .crumb.current')?.textContent`);
  assert.equal(currentLabel, 'deeper', 'last segment is the current one');
  // Click the "workspace" segment: the browser moves there.
  await evaluate(`[...doc.querySelectorAll('#breadcrumbs .crumb')].find(b => b.textContent === 'workspace').click(); return true`);
  await until(`return doc.querySelector('#breadcrumbs .crumb.current')?.textContent === 'workspace'`);
  const afterCrumb = await evaluate(`return doc.querySelector('.row.active .name')?.childNodes[0]?.textContent`);
  assert.equal(afterCrumb, 'workspace');
  // ↑ 上一级 goes one level up; 根目录 goes to the drive root.
  await evaluate(`doc.querySelector('#up').click(); return true`);
  await until(`return doc.querySelector('#breadcrumbs .crumb.current')?.textContent === ${JSON.stringify(path.basename(folder))}`);
  await evaluate(`doc.querySelector('#go-root').click(); return true`);
  await until(`return doc.querySelector('#breadcrumbs .crumb.current')?.textContent === ${JSON.stringify(path.parse(fixture).root)}`);
  assert.equal(await evaluate(`return doc.querySelector('#up').disabled`), true, '上一级 disabled at the drive root');
  // 返回 restores the previous directory.
  await evaluate(`doc.querySelector('#directory-back').click(); return true`);
  await until(`return doc.querySelector('#breadcrumbs .crumb.current')?.textContent === ${JSON.stringify(path.basename(folder))}`);
  console.log('PASS  file browser: C:\\ breadcrumbs are separate clickable segments; segment / 上一级 / 根目录 / 返回 navigate');

  // --- 2) sidebar card goes to the unread session ---------------------------
  // Mark the second session done+unread through the hook endpoint (as Claude's Stop does).
  const hookFire = await fetch(`${base}/api/agent-hook`, { method: 'POST', headers: { Cookie: `tw_auth=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pane: '%1', session: names[1], event: 'Stop' }) });
  assert.equal((await hookFire.json()).used, true, 'hook accepted');
  await send('Page.navigate', { url: `${base}/?session=${names[0]}` });
  await until(`return document.querySelectorAll('.ps-card').length > 0 && !!document.querySelector('.ps-chip.active')`);
  await until(`return [...document.querySelectorAll('.ps-chip')].some(c => c.textContent.includes(${JSON.stringify(names[1])}) && c.querySelector('.tab-dot.unread'))`);
  const activeBefore = await evaluate(`return document.querySelector('.ps-chip.active .ps-chip-name')?.textContent`);
  assert.equal(activeBefore, names[0], 'starts on the read session');
  // Click the card itself (its blank area), not a chip.
  await evaluate(`const card = [...document.querySelectorAll('.ps-card')].find(c => c.textContent.includes(${JSON.stringify(names[1])})); card.querySelector('.ps-card-sub, .ps-card-row').click(); return true`);
  const activeAfter = await until(`const a = document.querySelector('.ps-chip.active .ps-chip-name')?.textContent; return a === ${JSON.stringify(names[1])} ? a : ''`);
  assert.equal(activeAfter, names[1], 'card click went to the unread session');
  console.log('PASS  sidebar: clicking a card with an unread session goes to that session');
} finally {
  try { cdp?.close(); } catch {}
  if (chrome) try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  for (const name of names) try { execFileSync(T, ['kill-session', '-t', `=${name}`], { stdio: 'ignore' }); } catch {}
  try { execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  await sleep(500);
  await rm(folder, { recursive: true, force: true }).catch(() => {});
}
