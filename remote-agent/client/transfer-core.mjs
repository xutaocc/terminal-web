// Shared by the HTTP service and the standalone skill. No shell or npm dependency.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw } from 'node:zlib';
export const MAX_BYTES = 1024 * 1024 * 1024;
const identity = s => [s.dev, s.ino, s.birthtimeMs].join(':');
const version = s => [identity(s), s.size, s.mtimeMs, s.ctimeMs].join(':');
export async function realDirectory(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw Error('Absolute directory required');
  const real = await fsp.realpath(p);
  if (!(await fsp.stat(real)).isDirectory()) throw Error('Not a directory');
  return real;
}
// Windows uses a stable, user-visible TWSSH home for both staging and work.
export const WINDOWS_TWSSH_HOME = 'C:/twsshProjecTemp';
export async function transferBase(destinationParent) {
  if (process.platform !== 'win32') return realDirectory(destinationParent ?? os.tmpdir());
  await fsp.mkdir(WINDOWS_TWSSH_HOME, { recursive: true });
  const homeStat = await fsp.lstat(WINDOWS_TWSSH_HOME);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) throw Error('TWSSH home must be a real directory, not a link');
  const home = await realDirectory(WINDOWS_TWSSH_HOME);
  if (destinationParent) {
    const parent = await realDirectory(destinationParent);
    const parentStat = await fsp.stat(parent);
    if (parentStat.dev !== homeStat.dev || path.parse(parent).root.toLowerCase() !== path.parse(home).root.toLowerCase()) {
      throw Error('Destination must be on the same volume as C:/twsshProjecTemp; no silent staging-directory fallback');
    }
  }
  return home;
}
export async function vacant(p) {
  try { await fsp.lstat(p); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  throw Error('Destination already exists; overwrite is not supported');
}
export async function digest(p) {
  const hash = crypto.createHash('sha256'); let bytes = 0;
  for await (const chunk of fs.createReadStream(p)) { bytes += chunk.length; if (bytes > MAX_BYTES) throw Error('Transfer exceeds 1 GiB'); hash.update(chunk); }
  return { bytes, sha256: hash.digest('hex') };
}
export async function workspace(parent, id = crypto.randomUUID()) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw Error('Invalid temporary workspace UUID');
  const base = await realDirectory(parent);
  const dir = await fsp.mkdtemp(path.join(base, `.twssh-transfer-${id}-`));
  await fsp.chmod(dir, 0o700);
  const dirIdentity = identity(await fsp.lstat(dir));
  const files = new Map();
  async function validDir() {
    const s = await fsp.lstat(dir);
    if (!s.ino || !s.isDirectory() || s.isSymbolicLink() || identity(s) !== dirIdentity || await fsp.realpath(dir) !== dir) throw Error('Temporary directory ownership changed');
  }
  async function create(name) {
    if (!['owner.json', 'payload.part', 'archive.zip'].includes(name) || files.has(name)) throw Error('Invalid temporary member');
    await validDir(); const h = await fsp.open(path.join(dir, name), 'wx', 0o600);
    files.set(name, { identity: identity(await h.stat()), sealed: null }); return h;
  }
  async function seal(name) {
    await validDir(); const s = await fsp.lstat(path.join(dir, name)); const owned = files.get(name);
    if (!owned || !s.isFile() || s.isSymbolicLink() || identity(s) !== owned.identity) throw Error('Temporary file ownership changed');
    owned.sealed = version(s);
  }
  const marker = await create('owner.json');
  await marker.writeFile(JSON.stringify({ kind: 'twssh-transfer', version: 1, id, createdAt: new Date().toISOString() }));
  await marker.close(); await seal('owner.json');
  return { dir, create, seal, async cleanup() {
    // Never enumerate other transfer directories; never recurse or follow links.
    // Lost in-memory ownership after restart deliberately means no automatic cleanup.
    try {
      await validDir(); const names = await fsp.readdir(dir);
      if (names.length !== files.size || names.some(n => !files.has(n))) throw Error('Unexpected temporary directory contents');
      for (const [name, owned] of files) {
        const s = await fsp.lstat(path.join(dir, name));
        if (!owned.sealed || !s.isFile() || s.isSymbolicLink() || version(s) !== owned.sealed) throw Error('Temporary file changed or unfinished');
      }
      for (const [name, owned] of files) {
        await validDir(); const p = path.join(dir, name); const s = await fsp.lstat(p);
        if (!s.isFile() || s.isSymbolicLink() || version(s) !== owned.sealed) throw Error('Temporary file changed');
        await fsp.unlink(p);
      }
      await validDir(); await fsp.rmdir(dir);
      return { removed: true };
    } catch (e) { return { removed: false, retainedPath: dir, reason: e.message }; }
  } };
}
export async function selection(root, paths, exclude = []) {
  root = await realDirectory(root);
  if (!Array.isArray(paths) || !paths.length || paths.length > 1000 || !Array.isArray(exclude) || exclude.some(x => typeof x !== 'string' || !x)) throw Error('Invalid paths/exclude');
  const entries = new Map(); let total = 0;
  const relative = value => {
    if (typeof value !== 'string' || !value || value.includes('\\') || /[\x00-\x1f]/.test(value) || path.isAbsolute(value) || value.split('/').includes('..') || value.includes(':')) throw Error('Use relative paths with /; traversal is forbidden');
    return path.posix.normalize(value).replace(/\/$/, '') || '.';
  };
  exclude = exclude.map(relative);
  const skipped = rel => exclude.some(x => rel === x || rel.startsWith(x + '/'));
  async function visit(rel) {
    relative(rel);
    if (skipped(rel) || entries.has(rel)) return;
    const absolute = path.join(root, rel), stat = await fsp.lstat(absolute);
    if (stat.isSymbolicLink()) throw Error(`Symbolic links are not transferred: ${rel}`);
    if (await fsp.realpath(absolute) !== absolute) throw Error('Linked parent path refused');
    if (!stat.isDirectory() && !stat.isFile()) throw Error('Special files are not transferred');
    if (entries.size >= 60000) throw Error('Too many entries (ZIP32 limit)');
    entries.set(rel, { rel, absolute, directory: stat.isDirectory(), version: version(stat), size: stat.size });
    if (stat.isDirectory()) { for (const name of await fsp.readdir(absolute)) await visit(rel === '.' ? name : rel + '/' + name); }
    else { total += stat.size; if (total > MAX_BYTES) throw Error('Selected files exceed 1 GiB'); }
  }
  for (const item of paths) await visit(relative(item));
  return [...entries.values()].filter(e => e.rel !== '.');
}
export async function checkSource(entry) {
  const s = await fsp.lstat(entry.absolute);
  if (s.isSymbolicLink() || version(s) !== entry.version || await fsp.realpath(entry.absolute) !== entry.absolute) throw Error(`Source changed: ${entry.rel}`);
}
const crcTable = Array.from({length:256}, (_, n) => { for(let k=0;k<8;k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
// ZIP32, UTF-8 names, streaming data descriptors; explicit limits avoid malformed ZIP64 archives.
export async function zip(entries, handle, compression = 'fast') {
  if (!['fast','store'].includes(compression)) throw Error('compression must be fast or store');
  let position = 0; const central = [];
  const write = async data => { if(position + data.length > MAX_BYTES) throw Error('Archive exceeds 1 GiB'); let off=0; while(off<data.length) off+=(await handle.write(data,off,data.length-off)).bytesWritten; position+=data.length; };
  for (const entry of entries) {
    await checkSource(entry);
    const name = Buffer.from(entry.rel + (entry.directory ? '/' : ''), 'utf8');
    if(name.length>60000) throw Error('Archive name too long');
    let nameCrc=0xffffffff; for(const b of name) nameCrc=crcTable[(nameCrc^b)&255]^(nameCrc>>>8);
    const extra=Buffer.alloc(9+name.length); extra.writeUInt16LE(0x7075); extra.writeUInt16LE(5+name.length,2); extra[4]=1; extra.writeUInt32LE((nameCrc^0xffffffff)>>>0,5); name.copy(extra,9);
    const method = entry.directory || compression === 'store' ? 0 : 8, offset = position;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt16LE(0x808,6); local.writeUInt16LE(method,8); local.writeUInt16LE(33,12); local.writeUInt16LE(name.length,26); local.writeUInt16LE(extra.length,28);
    await write(local); await write(name); await write(extra); const start = position; let crc=0xffffffff, size=0;
    if (!entry.directory) {
      const source = fs.createReadStream(entry.absolute);
      const meter = new Transform({transform(chunk, enc, cb) { size+=chunk.length; if(size>MAX_BYTES) return cb(Error('Source grew beyond limit')); for(const b of chunk) crc=crcTable[(crc ^ b)&255] ^ (crc>>>8); cb(null,chunk); }});
      const sink = async function*(input) { for await(const chunk of input) { await write(chunk); } };
      if(method===8) await pipeline(source,meter,createDeflateRaw({level:1}),sink); else await pipeline(source,meter,sink);
    }
    await checkSource(entry); crc=(crc^0xffffffff)>>>0; const compressed=position-start;
    const descriptor=Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc,4); descriptor.writeUInt32LE(compressed,8); descriptor.writeUInt32LE(size,12); await write(descriptor);
    const c=Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(0x0314,4); c.writeUInt16LE(20,6); c.writeUInt16LE(0x808,8); c.writeUInt16LE(method,10); c.writeUInt16LE(33,14); c.writeUInt32LE(crc,16); c.writeUInt32LE(compressed,20); c.writeUInt32LE(size,24); c.writeUInt16LE(name.length,28); c.writeUInt16LE(extra.length,30); c.writeUInt32LE(((entry.directory?0o40755:0o100644)*65536+(entry.directory?16:0))>>>0,38); c.writeUInt32LE(offset,42); central.push(c,name,extra);
  }
  const start=position; for(const c of central) await write(c);
  const end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10); end.writeUInt32LE(position-start,12); end.writeUInt32LE(start,16); await write(end);
}
export async function receive(input, handle, expected) {
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes<0 || expected.bytes>MAX_BYTES || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw Error('Invalid size/hash');
  const hash=crypto.createHash('sha256'); let bytes=0;
  for await (const data of input) { bytes+=data.length; if(bytes>expected.bytes) throw Error('Received too many bytes'); hash.update(data); let offset=0; while(offset<data.length) offset+=(await handle.write(data,offset,data.length-offset)).bytesWritten; }
  if(bytes!==expected.bytes || hash.digest('hex')!==expected.sha256) throw Error('Transfer checksum mismatch');
  await handle.sync();
}
export async function publish(source, destination) {
  // Same-volume staging allows atomic no-clobber publication. No copy/overwrite fallback.
  await vacant(destination); await fsp.link(source, destination);
}
