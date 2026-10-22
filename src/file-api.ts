import type http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TEXT_LIMIT = 2 * 1024 * 1024;
const WALK_LIMIT = 50000;
const WINDOWS = process.platform === 'win32';
/**
 * Windows has no `zip`: archives are built by scripts/zip-manifest.ps1, under
 * PowerShell 7 when present — only its .NET marks names as UTF-8, so Chinese
 * names survive other unzip tools. Windows PowerShell 5.1 is the fallback.
 */
const WINDOWS_ZIP = (() => {
  const pwsh = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  return {
    shell: fs.existsSync(pwsh) ? pwsh : 'powershell.exe',
    script: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'zip-manifest.ps1'),
  };
})();
class FileError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
function absolute(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) throw new FileError('需要有效的绝对路径');
  // "\x" and "/x" are absolute on Windows too but name no drive; demand one.
  if (WINDOWS && !/^[A-Za-z]:[\\/]/.test(value)) throw new FileError('需要带盘符的绝对路径，例如 C:\\Users');
  return path.resolve(value);
}
// Windows also splits on "\" and forbids <>:"|?* in names.
const BAD_NAME = WINDOWS ? /[<>:"|?*\\/\0\x01-\x1f]/ : /[/\0]/;
function basename(value: unknown): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || BAD_NAME.test(value)) throw new FileError('名称无效');
  if (WINDOWS && /[. ]$/.test(value)) throw new FileError('名称不能以点或空格结尾');
  return value;
}
/** `p` is `ancestor` or below it. Case-insensitive on Windows, never a mere string prefix. */
export function within(p: string, ancestor: string): boolean {
  const relative = path.relative(ancestor, p);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
function paths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000) throw new FileError('请选择 1 至 1000 个条目');
  const result = [...new Set(value.map(absolute))];
  return result.filter(p => !result.some(other => other !== p && within(p, other)));
}
function mutable(p: string): void { if (p === path.parse(p).root) throw new FileError('不能修改文件系统根目录'); }
async function directory(p: string): Promise<void> { if (!(await fsp.stat(p)).isDirectory()) throw new FileError('目标路径不是目录'); }
async function unused(p: string): Promise<void> {
  try { await fsp.lstat(p); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new FileError(`目标已存在：${p}`, 409);
}
function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value));
}
async function body(req: http.IncomingMessage, limit = TEXT_LIMIT + 65536): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const data = Buffer.from(chunk); size += data.length; if (size > limit) throw new FileError('请求内容过大', 413); chunks.push(data); }
  try { const obj: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(); return obj as Record<string, unknown>; }
  catch { throw new FileError('请求 JSON 无效'); }
}
function message(error: unknown): string {
  if (error instanceof FileError) return error.message;
  const err = error as NodeJS.ErrnoException;
  const names: Record<string, string> = { ENOENT: '文件或目录不存在', EACCES: '没有访问权限', EPERM: '没有操作权限', ENOTDIR: '目标不是目录', EEXIST: '目标已存在', ENOSPC: '磁盘空间不足', EXDEV: '跨文件系统移动失败', EBUSY: '文件正在使用', ELOOP: '符号链接循环' };
  return `${names[err.code || ''] || '文件操作失败'}${err.path ? `：${err.path}` : ''}`;
}
const identities: { users: Map<number, string>; groups: Map<number, string> } = { users: new Map(), groups: new Map() };
for (const [file, mapping] of WINDOWS ? [] : [['/etc/passwd', identities.users], ['/etc/group', identities.groups]] as const) {
  try { for (const line of fs.readFileSync(file, 'utf8').split('\n')) { const parts = line.split(':'); if (parts.length >= 3) mapping.set(Number(parts[2]), parts[0]); } } catch { /* Numeric IDs are portable. */ }
}
export async function fileEntry(p: string) {
  const stat = await fsp.lstat(p);
  let isDirectory = stat.isDirectory(); let linkTarget: string | null = null;
  if (stat.isSymbolicLink()) { linkTarget = await fsp.readlink(p); try { isDirectory = (await fsp.stat(p)).isDirectory(); } catch { /* Dangling links remain visible. */ } }
  // Windows has no uid/gid (Node reports 0) and only a read-only bit for modes:
  // show the owner as unknown rather than as "0", the mode as it is reported.
  return { path: p, name: path.basename(p) || p, directory: isDirectory, symlink: stat.isSymbolicLink(), linkTarget, size: stat.size,
    modified: stat.mtime.toISOString(), accessed: stat.atime.toISOString(), created: stat.birthtimeMs > 0 ? stat.birthtime.toISOString() : null,
    mode: (stat.mode & 0o7777).toString(8).padStart(3, '0'), uid: stat.uid, gid: stat.gid,
    owner: WINDOWS ? '—' : identities.users.get(stat.uid) || String(stat.uid), group: WINDOWS ? '—' : identities.groups.get(stat.gid) || String(stat.gid) };
}
type WalkEntry = { path: string; directory: boolean; size: number; blocks: number; symlink: boolean };
// 使用 lstat 遍历，符号链接只作为条目处理，避免递归操作越过用户选择的目录。
async function walk(inputs: string[], exclusions: string[], tick?: (p: string) => void): Promise<WalkEntry[]> {
  const result: WalkEntry[] = [];
  const excluded = (p: string) => exclusions.some(e => within(p, e));
  async function visit(p: string): Promise<void> {
    if (excluded(p)) return;
    tick?.(p);
    const stat = await fsp.lstat(p);
    if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()) throw new FileError(`不支持特殊文件：${p}`);
    result.push({ path: p, directory: stat.isDirectory(), size: stat.size, blocks: stat.blocks, symlink: stat.isSymbolicLink() });
    if (result.length > WALK_LIMIT) throw new FileError(`条目超过 ${WALK_LIMIT}，请缩小选择范围`, 413);
    if (stat.isDirectory()) { for (const name of await fsp.readdir(p)) await visit(path.join(p, name)); }
  }
  for (const input of inputs) await visit(input);
  return result;
}
// 选中父子条目已去重；产物放在最外层选择的同级目录，跨分支时使用共同父目录。
export function compressionParent(inputs: string[]): string {
  if (!inputs.length || inputs.some(p => p === path.parse(p).root)) throw new FileError('不能压缩文件系统根目录');
  let parent = path.dirname(inputs[0]);
  while (!inputs.every(p => within(p, parent) && p !== parent)) {
    const up = path.dirname(parent);
    // Different drives (C:\ and D:\) share no parent at all.
    if (up === parent) throw new FileError('所选条目不在同一个磁盘上，无法一起压缩');
    parent = up;
  }
  return parent;
}
interface Job { id: string; status: 'running' | 'complete' | 'failed' | 'cancelled'; operation: string; count: number; current: string; result?: unknown; error?: string; failures: { path: string; error: string }[]; cancelled: boolean; cancel?: () => void; }
// 任务独立于 HTTP 连接运行：手机断网不会取消已启动的操作。
// 状态仅保存在服务进程内，不提供服务重启或服务器重启后的恢复保证。
const jobs = new Map<string, Job>();
function task(operation: string, run: (job: Job) => Promise<unknown>): Job {
  if ([...jobs.values()].filter(j => j.status === 'running').length >= 3) throw new FileError('后台任务繁忙，请稍后重试', 429);
  if (jobs.size > 100) for (const [id, job] of jobs) { if (job.status !== 'running') jobs.delete(id); if (jobs.size <= 80) break; }
  const job: Job = { id: crypto.randomUUID(), operation, status: 'running', count: 0, current: '', failures: [], cancelled: false };
  jobs.set(job.id, job);
  void run(job).then(result => { job.result = result; job.status = job.cancelled ? 'cancelled' : 'complete'; }).catch(error => { job.error = message(error); job.status = job.cancelled ? 'cancelled' : 'failed'; });
  return job;
}
function checkpoint(job: Job, p: string): void { if (job.cancelled) throw new FileError('操作已取消'); job.current = p; job.count++; }
// 先生成包含/排除清单供前端确认；执行时消费计划，避免重复提交创建多个压缩包。
const plans = new Map<string, { inputs: string[]; exclusions: string[]; entries: WalkEntry[]; parent: string; expires: number }>();
async function noNestedDestination(source: string, destination: string): Promise<void> {
  const stat = await fsp.lstat(source);
  if (!stat.isDirectory()) return;
  const [src, dest] = await Promise.all([fsp.realpath(source), fsp.realpath(destination)]);
  if (within(dest, src)) throw new FileError('目标目录不能是自身或子目录');
}
const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.pdf': 'application/pdf' };
// 网页服务模式下页面与终端同源运行（个人内网使用），脚本、存储与相对路径资源均按普通静态站点处理。
const siteMime: Record<string, string> = { ...mime, '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.m4a': 'audio/mp4', '.flac': 'audio/flac' };
export async function content(req: http.IncomingMessage, res: http.ServerResponse, p: string, mode: 'inline' | 'download' | 'site'): Promise<void> {
  const handle = await fsp.open(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat(); if (!stat.isFile()) throw new FileError('只能读取普通文件');
    const extension = path.extname(p).toLowerCase();
    const headers: Record<string, string | number> = mode === 'site'
      ? { 'Content-Type': siteMime[extension] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': String(res.getHeader('Cache-Control') || 'no-cache') }
      : { 'Content-Type': mode === 'download' ? 'application/octet-stream' : mime[extension] || 'text/plain; charset=utf-8', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'no-store' };
    const download = mode === 'download';
    if (download) headers['Content-Disposition'] = `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`;
    let start = 0, end = stat.size - 1, status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2]) || stat.size === 0) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
      if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = Math.max(0, end - start + 1); res.writeHead(status, headers);
    if (req.method === 'HEAD' || stat.size === 0) { res.end(); return; }
    await new Promise<void>((resolve, reject) => {
      const stream = handle.createReadStream({ start, end, autoClose: false });
      stream.on('error', reject); res.on('close', () => { stream.destroy(); resolve(); }); stream.on('end', resolve); stream.pipe(res);
    });
  } finally { await handle.close(); }
}
/**
 * Move a finished temporary file into place without ever replacing an existing
 * one. A hard link does that atomically, but FAT32 / exFAT / network shares
 * (common on Windows) refuse links: there, copy with COPYFILE_EXCL instead.
 */
async function publish(temporary: string, target: string): Promise<void> {
  try { await fsp.link(temporary, target); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!['EPERM', 'ENOTSUP', 'EXDEV', 'EINVAL', 'ENOSYS'].includes(code || '')) throw error;
    await fsp.copyFile(temporary, target, fs.constants.COPYFILE_EXCL);
  }
}
async function upload(req: http.IncomingMessage, destination: string, name: string, maxBytes: number): Promise<void> {
  await directory(destination);
  const target = path.join(destination, basename(name)); await unused(target);
  const temporary = path.join(destination, `.tw-upload-${crypto.randomUUID()}`);
  const handle = await fsp.open(temporary, 'wx', 0o600); let size = 0;
  try {
    for await (const chunk of req) { const data = Buffer.from(chunk); size += data.length; if (size > maxBytes) throw new FileError('上传超过大小限制', 413); let offset = 0; while (offset < data.length) offset += (await handle.write(data, offset, data.length - offset)).bytesWritten; }
    await handle.close(); await publish(temporary, target);
  } finally { await handle.close().catch(() => {}); await fsp.unlink(temporary).catch(() => {}); }
}
async function textFile(p: string): Promise<{ data: Buffer; version: string }> {
  const handle = await fsp.open(p, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat(); if (!stat.isFile()) throw new FileError('只能编辑普通文件');
    if (stat.size > TEXT_LIMIT) throw new FileError('文本超过 2 MB，请下载或在终端编辑', 413);
    const data = Buffer.alloc(stat.size); let offset = 0;
    while (offset < data.length) { const read = await handle.read(data, offset, data.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    const actual = data.subarray(0, offset);
    return { data: actual, version: crypto.createHash('sha256').update(actual).digest('hex') };
  } finally { await handle.close(); }
}
const writeLocks = new Set<string>();
async function writeText(p: string, text: string, version: unknown): Promise<void> {
  const real = await fsp.realpath(p); if (writeLocks.has(real)) throw new FileError('文件正在保存，请稍后重试', 409); writeLocks.add(real);
  try {
    const current = await textFile(real);
    if (version !== current.version) throw new FileError('文件已被修改，请重新加载后再保存', 409);
    if (Buffer.byteLength(text) > TEXT_LIMIT) throw new FileError('文本超过 2 MB', 413);
    // Write through the original inode to preserve ownership, modes and hard links.
    const handle = await fsp.open(real, 'r+');
    try { await handle.writeFile(text, 'utf8'); await handle.truncate(Buffer.byteLength(text)); } finally { await handle.close(); }
  } finally { writeLocks.delete(real); }
}
/**
 * The file system path a /site/… URL names. Unix: the path as is. Windows: the
 * page puts "C:\a\b" in the URL as "/C:/a/b", so a page's relative links still
 * resolve with "/" in the browser; turn it back here.
 */
export function sitePath(urlPath: string): string {
  const rest = decodeURIComponent(urlPath.slice('/site'.length)) || '/';
  if (!WINDOWS) return absolute(rest);
  const m = /^\/([A-Za-z]:)(\/.*)?$/.exec(rest);
  if (!m) throw new FileError('路径无效');
  return absolute(`${m[1]}${(m[2] || '/').replace(/\//g, '\\')}`);
}
// /site/<绝对路径>：把服务器上的文件当作静态网站提供，供浏览器新标签直接打开 HTML。
export async function handleSite(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname !== '/site' && !url.pathname.startsWith('/site/')) return false;
  const fail = (status: number, text: string) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(text); };
  if (req.method !== 'GET' && req.method !== 'HEAD') { fail(405, '不支持的请求方法'); return true; }
  let p: string;
  try { p = sitePath(url.pathname); } catch { fail(400, '路径无效'); return true; }
  try {
    if ((await fsp.stat(p)).isDirectory()) {
      // 目录需以 / 结尾，页面里的相对路径才会解析到该目录内。
      if (!url.pathname.endsWith('/')) { res.writeHead(301, { Location: url.pathname + '/' + url.search }); res.end(); return true; }
      p = path.join(p, 'index.html');
    }
    await content(req, res, p, 'site');
  } catch (error) {
    if (!res.headersSent) fail((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '') ? 403 : 400, message(error));
    else res.destroy();
  }
  return true;
}
export async function handleFileApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, options: { maxUpload: number; tmuxConf: string }): Promise<boolean> {
  if (!url.pathname.startsWith('/api/files/')) return false;
  const route = url.pathname.slice('/api/files/'.length);
  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && route === 'content') { await content(req, res, absolute(url.searchParams.get('path')), url.searchParams.get('download') === '1' ? 'download' : 'inline'); return true; }
    if (req.method === 'GET' && route === 'list') {
      const p = absolute(url.searchParams.get('path')); await directory(p);
      const names = await fsp.readdir(p); if (names.length > WALK_LIMIT) throw new FileError('目录条目过多，请使用终端处理', 413);
      const entries: Awaited<ReturnType<typeof fileEntry>>[] = []; const failures: { path: string; error: string }[] = [];
      // Bounded concurrent metadata reads, including dotfiles (visibility is a UI preference).
      for (let offset = 0; offset < names.length; offset += 32) await Promise.all(names.slice(offset, offset + 32).map(async name => { const child = path.join(p, name); try { entries.push(await fileEntry(child)); } catch (error) { failures.push({ path: child, error: message(error) }); } }));
      json(res, 200, { directory: await fileEntry(p), entries, failures }); return true;
    }
    if (req.method === 'GET' && route === 'stat') { json(res, 200, await fileEntry(absolute(url.searchParams.get('path')))); return true; }
    if (req.method === 'GET' && route === 'text') {
      const { data, version } = await textFile(absolute(url.searchParams.get('path')));
      if (data.includes(0)) throw new FileError('该文件是二进制文件，请下载或使用媒体预览', 415);
      let text: string; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); } catch { throw new FileError('文件不是 UTF-8 文本，请在终端转换编码后编辑', 415); }
      json(res, 200, { text, version }); return true;
    }
    if (req.method === 'GET' && route === 'job') { const job = jobs.get(url.searchParams.get('id') || ''); if (!job) throw new FileError('任务不存在', 404); json(res, 200, { ...job, cancel: undefined }); return true; }
    if (req.method !== 'POST') throw new FileError('不支持的请求方法', 405);
    if (route === 'upload') { await upload(req, absolute(url.searchParams.get('path')), url.searchParams.get('name') || '', options.maxUpload); json(res, 200, { ok: true }); return true; }
    const obj = await body(req);
    if (route === 'write') { if (typeof obj.text !== 'string') throw new FileError('缺少文本'); await writeText(absolute(obj.path), obj.text, obj.version); json(res, 200, { ok: true }); }
    else if (route === 'create') { const dest = absolute(obj.directory); await directory(dest); const p = path.join(dest, basename(obj.name)); if (obj.kind === 'directory') await fsp.mkdir(p); else if (obj.kind === 'file') await fsp.writeFile(p, '', { flag: 'wx', mode: 0o644 }); else throw new FileError('无效类型'); json(res, 200, await fileEntry(p)); }
    else if (route === 'rename') { const source = absolute(obj.path); mutable(source); const dest = path.join(path.dirname(source), basename(obj.name)); await unused(dest); await fsp.rename(source, dest); json(res, 200, await fileEntry(dest)); }
    else if (route === 'cancel') { const job = jobs.get(String(obj.id)); if (!job) throw new FileError('任务不存在', 404); job.cancelled = true; job.cancel?.(); json(res, 200, { ok: true }); }
    else if (route === 'open-terminal') {
      // Only checks the directory. The page names and creates the session the
      // same way as its own "新建会话" (web/session-name.ts), on first attach.
      const p = absolute(obj.path); await directory(p);
      json(res, 200, { path: p, name: path.basename(p) || p });
    }
    else if (['copy', 'move', 'remove', 'chmod', 'scan', 'compression-plan'].includes(route)) {
      const inputs = paths(obj.paths); if (route !== 'scan' && route !== 'compression-plan') inputs.forEach(mutable);
      const exclusions = Array.isArray(obj.exclude) ? obj.exclude.map(absolute) : [];
      if (exclusions.some(e => !inputs.some(p => within(e, p)))) throw new FileError('排除项必须在所选范围内');
      let destination = '';
      if (route === 'copy' || route === 'move') { destination = absolute(obj.destination); await directory(destination); const names = new Set<string>(); for (const input of inputs) { if (names.has(path.basename(input))) throw new FileError('选择包含同名条目'); names.add(path.basename(input)); await noNestedDestination(input, destination); await unused(path.join(destination, path.basename(input))); } }
      let mode = 0; if (route === 'chmod') {
        // Windows file modes only carry a read-only bit; there is nothing to set.
        if (WINDOWS) throw new FileError('Windows 不支持 Linux 权限设置，请在资源管理器中修改', 501);
        if (typeof obj.mode !== 'string' || !/^[0-7]{3,4}$/.test(obj.mode)) throw new FileError('请输入有效的八进制权限'); mode = Number.parseInt(obj.mode, 8);
      }
      const job = task(route, async current => {
        if (route === 'scan' || route === 'compression-plan') {
          const entries = await walk(inputs, exclusions, p => checkpoint(current, p));
          if (route === 'compression-plan') {
            const parent = compressionParent(inputs);
            for (const entry of entries) if (/[\r\n]/.test(entry.path)) throw new FileError('压缩暂不支持包含换行符的文件名');
            for (const [id, plan] of plans) if (plan.expires < Date.now()) plans.delete(id);
            if (plans.size >= 32) throw new FileError('压缩计划过多，请稍后再试', 429);
            const id = crypto.randomUUID(); plans.set(id, { inputs, exclusions, entries, parent, expires: Date.now() + 600000 });
            return { planId: id, parent, included: entries.map(e => e.path), excluded: exclusions, files: entries.filter(e => !e.directory).length, directories: entries.filter(e => e.directory).length };
          }
          return { files: entries.filter(e => !e.directory).length, directories: entries.filter(e => e.directory).length, bytes: entries.filter(e => !e.directory).reduce((sum, e) => sum + e.size, 0), diskBytes: entries.reduce((sum, e) => sum + e.blocks * 512, 0), excluded: exclusions };
        }
        for (const input of inputs) {
          checkpoint(current, input);
          try {
            if (route === 'remove') await fsp.rm(input, { recursive: true });
            else if (route === 'chmod') {
              const entries = obj.recursive === true ? await walk([input], [], p => checkpoint(current, p)) : [{ path: input, symlink: (await fsp.lstat(input)).isSymbolicLink() }];
              for (const entry of entries) { checkpoint(current, entry.path); if (entry.symlink) { current.failures.push({ path: entry.path, error: '跳过符号链接，避免修改链接目标' }); continue; } try { await fsp.chmod(entry.path, mode); } catch (error) { current.failures.push({ path: entry.path, error: message(error) }); } }
            } else {
              const dest = path.join(destination, path.basename(input)); await unused(dest);
              if (route === 'copy') await fsp.cp(input, dest, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true, filter: async source => { checkpoint(current, source); const stat = await fsp.lstat(source); if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()) throw new FileError('不能复制特殊文件'); return true; } });
              else { try { await fsp.rename(input, dest); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error; await fsp.cp(input, dest, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true }); if (current.cancelled) throw new FileError('任务已取消，源文件保留'); await fsp.rm(input, { recursive: true }); } }
            }
          } catch (error) { if (current.cancelled) throw error; current.failures.push({ path: input, error: message(error) }); }
        }
        return { ok: !current.failures.length };
      }); json(res, 202, { jobId: job.id });
    }
    else if (route === 'compress') {
      const id = String(obj.planId); const plan = plans.get(id); if (!plan || plan.expires < Date.now()) throw new FileError('压缩计划已过期，请重新确认', 409);
      const name = basename(obj.name); if (!name.toLowerCase().endsWith('.zip')) throw new FileError('压缩文件名必须以 .zip 结尾');
      if (!plan.entries.length) throw new FileError('没有可压缩的条目');
      const output = path.join(plan.parent, name); await unused(output);
      const job = task('compress', async current => {
        const temporary = path.join(plan.parent, `.tw-archive-${crypto.randomUUID()}.zip`);
        // Entry names inside the zip always use "/", whatever the host's separator.
        const names = plan.entries.map(entry => `${path.relative(plan.parent, entry.path).split(path.sep).join('/')}${entry.directory ? '/' : ''}`);
        const manifest = WINDOWS ? path.join(plan.parent, `.tw-archive-${crypto.randomUUID()}.txt`) : '';
        try {
          if (WINDOWS) {
            // Symlinks are listed (not followed) like on Unix; the script adds a
            // directory symlink as an empty folder rather than descending into it.
            await fsp.writeFile(manifest, names.join('\n') + '\n', 'utf8');
          }
          await new Promise<void>((resolve, reject) => {
            // Explicit manifest instead of recursive zip: exclusions and symlinks cannot expand the selection.
            const child = WINDOWS
              ? spawn(WINDOWS_ZIP.shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_ZIP.script, plan.parent, manifest, temporary], { stdio: ['ignore', 'ignore', 'pipe'] })
              : spawn('zip', ['-y', '-q', temporary, '-@'], { cwd: plan.parent, stdio: ['pipe', 'ignore', 'pipe'] });
            current.cancel = () => child.kill('SIGTERM'); let stderr = '';
            const tool = WINDOWS ? 'PowerShell' : 'zip';
            child.stderr!.on('data', data => { stderr = (stderr + String(data)).slice(-4096); }); child.on('error', error => reject((error as NodeJS.ErrnoException).code === 'ENOENT' ? new FileError(`未找到 ${tool}，请安装后重试`) : error));
            child.on('exit', code => code === 0 ? resolve() : reject(new FileError(`压缩失败${stderr.trim() ? `：${stderr.trim()}` : ''}${WINDOWS ? '' : '，请确认已安装 zip'}`)));
            if (!WINDOWS) {
              child.stdin!.on('error', () => {});
              // 显式传入已确认的条目，不使用 zip -r，防止重新递归把排除项加入归档。
              child.stdin!.end(names.map(name => `./${name}`).join('\n') + '\n');
            }
            current.count = plan.entries.length; current.current = output;
          });
          if (current.cancelled) throw new FileError('压缩已取消');
          await publish(temporary, output); return { path: output };
        } finally {
          current.cancel = undefined; await fsp.unlink(temporary).catch(() => {});
          if (manifest) await fsp.unlink(manifest).catch(() => {});
        }
      }); plans.delete(id); json(res, 202, { jobId: job.id });
    }
    else throw new FileError('接口不存在', 404);
  } catch (error) {
    if (!res.headersSent) json(res, error instanceof FileError ? error.status : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '') ? 403 : 400, { error: message(error) });
    else res.destroy();
  }
  return true;
}
