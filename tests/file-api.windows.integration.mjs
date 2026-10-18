// Windows twin of file-api.integration.mjs: the same file API, driven against
// C:\ paths. Isolated filesystem and service; never touches the running
// terminal's files or sessions. Run on Windows: node tests/file-api.windows.integration.mjs
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import crypto from 'node:crypto';

if (process.platform !== 'win32') { console.log('SKIP: Windows only'); process.exit(0); }
const workspace = await mkdtemp(path.join(os.tmpdir(), 'terminal-files-win-'));
const token = crypto.randomBytes(32).toString('hex');
const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const port = server.address().port; await new Promise(resolve => server.close(resolve));
const base = `http://127.0.0.1:${port}`;
const headers = { Cookie: `tw_auth=${token}` };
const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/server.ts'], { env: { ...process.env, AUTH_TOKEN: token, HOST: '127.0.0.1', PORT: String(port) }, stdio: 'ignore' });
const get = (route, params, extra = {}) => fetch(`${base}/api/files/${route}?${new URLSearchParams(params)}`, { headers: { ...headers, ...extra } });
const post = (route, data) => fetch(`${base}/api/files/${route}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
async function ok(response) { const res = await response; const data = await res.json(); assert.ok(res.ok, JSON.stringify(data)); return data; }
async function job(route, payload) { const { jobId } = await ok(post(route, payload)); for (let i = 0; i < 300; i++) { const result = await ok(get('job', { id: jobId })); if (result.status !== 'running') return result; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('job timed out'); }
async function success(route, payload) { const result = await job(route, payload); assert.equal(result.status, 'complete', JSON.stringify(result)); assert.deepEqual(result.failures, []); return result.result; }
/** Entry names of a zip, read from its central directory, plus whether each is flagged UTF-8. */
function zipNames(buffer) {
  const out = []; let i = 0;
  while ((i = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), i)) >= 0) { const n = buffer.readUInt16LE(i + 28); out.push({ name: buffer.subarray(i + 46, i + 46 + n).toString('utf8'), utf8: !!(buffer.readUInt16LE(i + 8) & 0x800) }); i += 4; }
  return out;
}
try {
  for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw new Error('server exited'); try { await fetch(base); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); } }
  const src = path.join(workspace, '中文 folder'); const dest = path.join(workspace, 'destination'); await mkdir(src); await mkdir(dest);
  const text = path.join(src, '笔记.txt'); await writeFile(text, 'first\r\n中文\r\n');
  await mkdir(path.join(src, 'nested')); await writeFile(path.join(src, 'nested', 'exclude.txt'), 'exclude'); await writeFile(path.join(src, 'nested', 'keep.txt'), 'keep');

  // Paths: drive-letter absolute paths only, either slash accepted.
  assert.equal((await get('list', { path: 'relative' })).status, 400);
  assert.equal((await get('list', { path: '\\Windows' })).status, 400, 'a path with no drive is refused');
  const listed = await ok(get('list', { path: src.replace(/\\/g, '/') })); assert.equal(listed.directory.path, src, 'forward slashes resolve to the same directory');
  assert.ok(listed.entries.some(item => item.name === '笔记.txt'));
  const root = await ok(get('stat', { path: path.parse(workspace).root })); assert.equal(root.name, path.parse(workspace).root, 'a drive root is named by its root, not "/"');
  assert.equal(listed.directory.owner, '—', 'no Unix owner names on Windows');

  // Names Windows forbids are refused up front, with a clear error.
  for (const bad of ['a:b', 'a?b', 'a*b', 'a|b', 'a"b', 'a<b', 'a>b', 'a\\b', 'trail.', 'trail ']) assert.equal((await post('create', { directory: src, name: bad, kind: 'file' })).status, 400, bad);
  assert.equal((await post('create', { directory: src, name: '..\\escape', kind: 'file' })).status, 400);
  await ok(post('create', { directory: src, name: 'new', kind: 'directory' })); await ok(post('create', { directory: src, name: 'new.txt', kind: 'file' }));

  // Text editing keeps CRLF line endings and refuses stale writes.
  const loaded = await ok(get('text', { path: text })); assert.equal(loaded.text, 'first\r\n中文\r\n');
  await ok(post('write', { path: text, text: 'short\r\n', version: loaded.version })); assert.equal(await readFile(text, 'utf8'), 'short\r\n');
  assert.equal((await post('write', { path: text, text: 'stale', version: loaded.version })).status, 409);

  // Upload: the finished file is published without replacing an existing one.
  const uploaded = await fetch(`${base}/api/files/upload?${new URLSearchParams({ path: src, name: 'uploaded.txt' })}`, { method: 'POST', headers, body: 'upload content' }); assert.equal(uploaded.status, 200);
  assert.equal(await readFile(path.join(src, 'uploaded.txt'), 'utf8'), 'upload content');
  assert.equal((await fetch(`${base}/api/files/upload?${new URLSearchParams({ path: src, name: 'uploaded.txt' })}`, { method: 'POST', headers, body: 'overwrite' })).status, 409);
  assert.ok(!(await readdir(src)).some(name => name.startsWith('.tw-upload-')), 'no temporary upload left behind');

  // Copy / move, including the "into itself" guard with differing case.
  assert.equal((await post('copy', { paths: [src], destination: path.join(src, 'nested') })).status, 400);
  assert.equal((await post('copy', { paths: [src], destination: path.join(src, 'NESTED') })).status, 400, 'case-insensitive self-nesting check');
  await success('copy', { paths: [text], destination: dest }); assert.equal(await readFile(path.join(dest, '笔记.txt'), 'utf8'), 'short\r\n');
  await ok(post('rename', { path: path.join(dest, '笔记.txt'), name: 'renamed.txt' }));
  await success('move', { paths: [path.join(dest, 'renamed.txt')], destination: src }); assert.ok((await readdir(src)).includes('renamed.txt'));

  // chmod has no meaning here: refused clearly instead of silently doing nothing.
  const chmod = await post('chmod', { paths: [text], mode: '755' }); assert.equal(chmod.status, 501); assert.match((await chmod.json()).error, /Windows/);

  // Size scan honours exclusions.
  const report = await success('scan', { paths: [src], exclude: [path.join(src, 'nested')] }); assert.ok(report.files > 0);

  // ZIP: built from the confirmed manifest; exclusions stay out; Chinese names marked UTF-8.
  const nested = path.join(src, 'nested'), excluded = path.join(nested, 'exclude.txt');
  await writeFile(path.join(nested, '中文.txt'), 'c');
  const plan = await success('compression-plan', { paths: [nested], exclude: [excluded] }); assert.equal(plan.parent, src); assert.ok(!plan.included.includes(excluded));
  const zipped = await success('compress', { planId: plan.planId, name: 'bundle.zip' }); assert.equal(zipped.path, path.join(src, 'bundle.zip'));
  const names = zipNames(await readFile(zipped.path));
  assert.deepEqual(names.map(n => n.name).sort(), ['nested/', 'nested/keep.txt', 'nested/中文.txt'].sort(), JSON.stringify(names));
  assert.ok(names.find(n => n.name === 'nested/中文.txt').utf8, 'UTF-8 flag set on Chinese names');
  const extracted = path.join(workspace, 'extracted'); await mkdir(extracted);
  execFileSync('C:\\Windows\\System32\\tar.exe', ['-x', '-f', zipped.path], { cwd: extracted });
  assert.equal(await readFile(path.join(extracted, 'nested', '中文.txt'), 'utf8'), 'c');
  assert.ok(!(await readdir(src)).some(name => name.startsWith('.tw-archive-')), 'no temporary archive or manifest left behind');
  assert.equal((await post('compress', { planId: plan.planId, name: 'again.zip' })).status, 409);
  assert.equal((await post('compression-plan', { paths: ['C:\\'] })).status, 202, 'plan request accepted; the job itself refuses the root');

  // Removing a drive root is refused.
  assert.equal((await post('remove', { paths: [path.parse(workspace).root] })).status, 400);
  await success('remove', { paths: [path.join(src, 'new'), path.join(src, 'new.txt')] });

  // /site/: a Windows path travels as /site/C:/…; relative assets resolve under it.
  const site = path.join(workspace, '网页 site'); await mkdir(path.join(site, 'js'), { recursive: true });
  await writeFile(path.join(site, 'index.html'), '<script src="js/app.js"></script>'); await writeFile(path.join(site, 'js', 'app.js'), 'console.log(1)');
  const siteUrl = p => `${base}/site/${p[0]}:/${p.slice(3).split('\\').map(encodeURIComponent).join('/')}`;
  const page = await fetch(siteUrl(path.join(site, 'index.html')), { headers }); assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /^text\/html/);
  const asset = new URL('js/app.js', siteUrl(path.join(site, 'index.html'))).href;
  assert.match((await fetch(asset, { headers })).headers.get('content-type'), /^text\/javascript/, 'relative asset resolves');
  const folder = await fetch(siteUrl(site), { headers, redirect: 'manual' }); assert.equal(folder.status, 301);
  assert.equal(await (await fetch(siteUrl(site) + '/', { headers })).text(), '<script src="js/app.js"></script>');
  assert.equal((await fetch(`${base}/site/no-drive/x`, { headers })).status, 400);

  const opened = await ok(post('open-terminal', { path: src })); assert.equal(opened.path, src); assert.equal(opened.name, '中文 folder');
  console.log('PASS (Windows): drive paths, forbidden names, CRLF editing, upload, copy/move, chmod refused, scan, UTF-8 ZIP with exclusions, /site/C:/…, open terminal');
} finally {
  if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  await rm(workspace, { recursive: true, force: true });
}
