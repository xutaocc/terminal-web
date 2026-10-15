// Isolated filesystem and service; never touches the running terminal's files or sessions.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import crypto from 'node:crypto';

const workspace = await mkdtemp(path.join(os.tmpdir(), 'terminal-files-'));
const token = crypto.randomBytes(32).toString('hex');
const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve));
const base = `http://127.0.0.1:${port}`;
const headers = { Cookie: `tw_auth=${token}` };
const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], { env: { ...process.env, AUTH_TOKEN: token, HOST: '127.0.0.1', PORT: String(port) }, stdio: 'ignore' });
const sessions = [];
const get = (route, params, auth = true, extra = {}) => fetch(`${base}/api/files/${route}?${new URLSearchParams(params)}`, { headers: { ...(auth ? headers : {}), ...extra } });
const post = (route, data, extra = {}) => fetch(`${base}/api/files/${route}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(data) });
async function ok(response) { const res = await response; const data = await res.json(); assert.ok(res.ok, JSON.stringify(data)); return data; }
async function job(route, payload) { const { jobId } = await ok(post(route, payload)); for (let i = 0; i < 150; i++) { const result = await ok(get('job', { id: jobId })); if (result.status !== 'running') return result; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('job timed out'); }
async function success(route, payload) { const result = await job(route, payload); assert.equal(result.status, 'complete', JSON.stringify(result)); assert.deepEqual(result.failures, []); return result.result; }
try {
  for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw new Error('server exited'); try { await fetch(base); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); } }
  const src = path.join(workspace, '中文 folder'); const dest = path.join(workspace, 'destination'); await mkdir(src); await mkdir(dest);
  const text = path.join(src, '笔记.txt'); await writeFile(text, 'first\n中文\n'); await writeFile(path.join(src, '.hidden'), 'secret'); await mkdir(path.join(src, '.config'));
  await mkdir(path.join(src, 'nested')); await writeFile(path.join(src, 'nested', 'exclude.txt'), 'exclude'); await writeFile(path.join(src, 'nested', 'keep.txt'), 'keep');
  const outside = path.join(workspace, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'keep-safe'), 'safe'); await symlink(outside, path.join(src, 'outside-link'));
  for (const route of ['list', 'stat', 'text', 'content']) assert.equal((await get(route, { path: src }, false)).status, 401);
  assert.equal((await fetch(`${base}/file-browser.html`)).status, 401);
  assert.equal((await post('create', { directory: src, kind: 'file', name: 'blocked' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${base}/api/files/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  const embeddedPage = await fetch(`${base}/file-browser.html`, { headers }); assert.equal(embeddedPage.status, 200); assert.match(await embeddedPage.text(), /file-browser\.js\?v=[a-f0-9]{12}/);
  assert.match(await (await fetch(base, { headers })).text(), /terminal\.js\?v=[a-f0-9]{12}/);
  assert.equal((await get('list', { path: 'relative' })).status, 400);
  const list = await ok(get('list', { path: src })); assert.ok(list.entries.some(item => item.name === '.hidden')); assert.ok(list.entries.some(item => item.name === '.config' && item.directory));
  assert.ok(list.entries.find(item => item.name === 'outside-link').symlink);
  await ok(post('create', { directory: src, name: 'new', kind: 'directory' })); await ok(post('create', { directory: src, name: 'new.txt', kind: 'file' }));
  assert.equal((await post('create', { directory: src, name: '../escape', kind: 'file' })).status, 400);
  assert.equal((await post('create', { directory: src, name: 'new.txt', kind: 'file' })).status, 400);
  const loaded = await ok(get('text', { path: text })); assert.equal(loaded.text, 'first\n中文\n');
  await ok(post('write', { path: text, text: 'short', version: loaded.version })); assert.equal(await readFile(text, 'utf8'), 'short');
  assert.equal((await post('write', { path: text, text: 'stale', version: loaded.version })).status, 409);
  await writeFile(path.join(src, 'binary'), Buffer.from([0, 1, 2])); assert.equal((await get('text', { path: path.join(src, 'binary') })).status, 415);
  await writeFile(path.join(src, 'large.txt'), 'a'.repeat(2 * 1024 * 1024 + 1)); assert.equal((await get('text', { path: path.join(src, 'large.txt') })).status, 413);
  await writeFile(path.join(src, 'bom.txt'), Buffer.from([0xef, 0xbb, 0xbf, 65])); const bom = await ok(get('text', { path: path.join(src, 'bom.txt') })); assert.equal(bom.text.charCodeAt(0), 0xfeff);
  const range = await get('content', { path: text }, true, { Range: 'bytes=1-3' }); assert.equal(range.status, 206); assert.equal(await range.text(), 'hor');
  assert.equal((await get('content', { path: text }, true, { Range: 'bytes=99-100' })).status, 416);
  const download = await get('content', { path: text, download: '1' }); assert.ok(download.headers.get('content-disposition').includes('attachment'));
  const uploaded = await fetch(`${base}/api/files/upload?${new URLSearchParams({ path: src, name: 'uploaded.txt' })}`, { method: 'POST', headers, body: 'upload content' }); assert.equal(uploaded.status, 200); assert.equal(await readFile(path.join(src, 'uploaded.txt'), 'utf8'), 'upload content');
  assert.equal((await fetch(`${base}/api/files/upload?${new URLSearchParams({ path: src, name: 'uploaded.txt' })}`, { method: 'POST', headers, body: 'overwrite' })).status, 409);
  assert.equal((await post('copy', { paths: [src], destination: path.join(src, 'nested') })).status, 400);
  assert.equal((await post('copy', { paths: [text], destination: path.join(workspace, 'missing') })).status, 404);
  await success('copy', { paths: [text], destination: dest }); assert.equal(await readFile(path.join(dest, '笔记.txt'), 'utf8'), 'short');
  assert.equal((await post('copy', { paths: [text], destination: dest })).status, 409);
  await ok(post('rename', { path: path.join(dest, '笔记.txt'), name: 'renamed.txt' }));
  await success('move', { paths: [path.join(dest, 'renamed.txt')], destination: outside }); assert.ok((await readdir(outside)).includes('renamed.txt'));
  await success('chmod', { paths: [path.join(src, 'nested')], mode: '700', recursive: true }); assert.equal((await stat(path.join(src, 'nested', 'keep.txt'))).mode & 0o777, 0o700);
  assert.equal((await post('chmod', { paths: [text], mode: '888' })).status, 400);
  const report = await success('scan', { paths: [src, text], exclude: [path.join(src, 'large.txt')] }); assert.ok(report.files > 0); assert.ok(report.bytes < 1024); assert.ok(report.diskBytes >= report.bytes);
  const nested = path.join(src, 'nested'), excluded = path.join(nested, 'exclude.txt');
  const plan = await success('compression-plan', { paths: [nested, path.join(nested, 'keep.txt')], exclude: [excluded] }); assert.equal(plan.parent, src); assert.ok(!plan.included.includes(excluded));
  assert.ok(!(await readdir(src)).includes('bundle.zip'), 'planning does not create archive');
  const zipped = await success('compress', { planId: plan.planId, name: 'bundle.zip' }); assert.equal(zipped.path, path.join(src, 'bundle.zip'));
  const archive = execFileSync('unzip', ['-Z1', zipped.path], { encoding: 'utf8' }); assert.ok(archive.includes('nested/keep.txt')); assert.ok(!archive.includes('exclude.txt'));
  assert.equal((await post('compress', { planId: plan.planId, name: 'again.zip' })).status, 409);
  const linkPlan = await success('compression-plan', { paths: [path.join(src, 'outside-link')] }); const linkZip = await success('compress', { planId: linkPlan.planId, name: 'link.zip' }); assert.ok(!execFileSync('unzip', ['-Z1', linkZip.path], { encoding: 'utf8' }).includes('keep-safe'));
  const opened = await ok(post('open-terminal', { path: src })); sessions.push(opened.name);
  assert.match(opened.name, /^[A-Za-z0-9_-]{1,64}$/); assert.match(opened.displayName, /^中文 folder\d{17}$/);
  assert.equal(execFileSync('tmux', ['display-message', '-p', '-t', `=${opened.name}:`, '#{pane_current_path}'], { encoding: 'utf8' }).trim(), src);
  const tabs = await (await fetch(`${base}/api/sessions`, { headers })).json(); assert.ok(tabs.tabs.some(tab => tab.name === opened.name && tab.displayName === opened.displayName));
  await success('remove', { paths: [path.join(src, 'outside-link')] }); assert.equal(await readFile(path.join(outside, 'keep-safe'), 'utf8'), 'safe');
  assert.equal((await post('remove', { paths: ['/'] })).status, 400);
  await success('remove', { paths: [path.join(src, 'new'), path.join(src, 'new.txt')] });
  const site = path.join(workspace, '网页 site'); await mkdir(path.join(site, 'js'), { recursive: true });
  await writeFile(path.join(site, 'index.html'), '<script src="js/app.js"></script>'); await writeFile(path.join(site, 'js', 'app.js'), 'console.log(1)');
  const siteUrl = p => `${base}/site${p.split('/').map(encodeURIComponent).join('/')}`;
  assert.equal((await fetch(siteUrl(path.join(site, 'index.html')))).status, 401);
  const loginForm = await (await fetch(siteUrl(path.join(site, 'index.html')))).text(); assert.ok(!loginForm.includes('js/app.js')); assert.ok(loginForm.includes(`value="${new URL(siteUrl(path.join(site, 'index.html'))).pathname}"`));
  const login = next => fetch(`${base}/auth/login`, { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, next }) });
  assert.equal((await login(new URL(siteUrl(path.join(site, 'index.html'))).pathname)).headers.get('location'), new URL(siteUrl(path.join(site, 'index.html'))).pathname);
  for (const unsafe of ['//evil.example', 'https://evil.example', '/\\evil.example']) assert.equal((await login(unsafe)).headers.get('location'), '/');
  const page = await fetch(siteUrl(path.join(site, 'index.html')), { headers }); assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /^text\/html/); assert.equal(page.headers.get('content-security-policy'), null);
  assert.match((await fetch(siteUrl(path.join(site, 'js', 'app.js')), { headers })).headers.get('content-type'), /^text\/javascript/);
  const folder = await fetch(siteUrl(site), { headers, redirect: 'manual' }); assert.equal(folder.status, 301); assert.ok(folder.headers.get('location').endsWith('/'));
  assert.equal(await (await fetch(siteUrl(site) + '/', { headers })).text(), '<script src="js/app.js"></script>');
  assert.equal((await fetch(siteUrl(path.join(site, 'missing.css')), { headers })).status, 404);
  console.log('PASS: auth/CSRF, static site, listing, UTF-8/versioned editing, ranges, upload, create/rename, copy/move, recursive chmod, exclusions/ZIP, symlink safety, directory terminal');
} finally {
  for (const name of sessions) try { execFileSync('tmux', ['kill-session', '-t', `=${name}`]); } catch {}
  if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  await rm(workspace, { recursive: true, force: true });
}
