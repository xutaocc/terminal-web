import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { workspace, transferBase, selection, zip, digest, receive, publish, realDirectory, vacant, checkSource, MAX_BYTES } from './client/transfer-core.mjs';
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
export class AgentTransfers {
  records = new Map();
  constructor() {}
  get(id) { const r=this.records.get(id); if(!r) throw Error('Transfer not found; after restart inspect destination, do not blindly repeat'); return r; }
  status(r) { return {transferId:r.id,state:r.state,direction:r.spec.direction,verified:r.verified===true,path:r.destination,bytes:r.bytes,sha256:r.sha256,archive:r.archive,tempPath:r.work?.dir,cleanup:r.cleanup,error:r.error}; }
  async prepare(spec) {
    if(spec.extract !== undefined || spec.extractTo !== undefined) throw Error('Automatic extraction is not supported; confirm the complete path and cleanup plan before a separate extraction workflow');
    if(!uuid(spec.requestId)) throw Error('UUID requestId required');
    const old=this.records.get(spec.requestId);
    if(old) { if(JSON.stringify(spec)!==JSON.stringify(old.spec)) throw Error('Transfer request conflict'); return this.status(old); }
    if(this.records.size>=200) {
      const expired=[...this.records.values()].find(r=>r.state==='cleaned'||r.cleanup?.removed);
      if(expired)this.records.delete(expired.id);
      else throw Error('Transfer record limit reached; clean completed transfers first');
    }
    if([...this.records.values()].filter(r=>['preparing','ready','receiving','sending'].includes(r.state)).length>=4) throw Error('Transfer concurrency limit');
    if(!['push','pull'].includes(spec.direction)) throw Error('Invalid direction');
    const r={id:spec.requestId,spec,state:'preparing'}; this.records.set(r.id,r);
    try {
      if(spec.direction==='push') {
        if(typeof spec.destination!=='string'||!path.isAbsolute(spec.destination)) throw Error('Absolute destination required');
        await transferBase();
        const parent=await realDirectory(path.dirname(spec.destination));
        const name=path.basename(spec.destination);
        if(!name || /[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw Error('Invalid destination name');
        if(!Number.isSafeInteger(spec.bytes)||spec.bytes<0||spec.bytes>MAX_BYTES||!/^[a-f0-9]{64}$/.test(spec.sha256)) throw Error('Invalid size/hash');
        r.destination=path.join(parent,name); await vacant(r.destination);
        r.work=await workspace(await transferBase(parent),r.id); r.bytes=spec.bytes; r.sha256=spec.sha256;
      } else {
        const entries=await selection(spec.root,spec.paths,spec.exclude);
        r.archive=spec.pack===true||spec.paths.length!==1||['.','./'].includes(spec.paths[0])||entries.length!==1||entries[0]?.directory;
        if(r.archive) {
          r.work=await workspace(await transferBase(),r.id);
          const h=await r.work.create('archive.zip');
          try { await zip(entries,h,spec.compression??'store'); } finally { await h.close(); }
          await r.work.seal('archive.zip'); r.source=path.join(r.work.dir,'archive.zip');
        } else { r.entry=entries[0]; r.source=r.entry.absolute; }
        Object.assign(r,await digest(r.source)); if(r.entry) await checkSource(r.entry);
      }
      r.state='ready'; return this.status(r);
    } catch(e) { r.state='failed'; r.error=e.message; r.cleanup=await r.work?.cleanup(); throw e; }
  }
  async upload(id, input) {
    const r=this.get(id); if(r.state!=='ready'||r.spec.direction!=='push') throw Error('Transfer is not ready for upload');
    r.state='receiving'; let h;
    try {
      h=await r.work.create('payload.part'); await receive(input,h,r); await h.close(); h=null;
      await r.work.seal('payload.part');
      if(await realDirectory(path.dirname(r.destination))!==path.dirname(r.destination)) throw Error('Destination parent changed');
      await publish(path.join(r.work.dir,'payload.part'),r.destination);
      // link changes ctime on the owned inode; renew only after our successful publication.
      await r.work.seal('payload.part'); r.state='complete'; r.verified=true; r.cleanup=await r.work.cleanup(); return this.status(r);
    } catch(e) { if(h) await h.close().catch(()=>{}); r.state='failed'; r.error=e.message; r.cleanup=await r.work.cleanup(); throw e; }
  }
  async download(id,res) {
    const r=this.get(id); if(r.state!=='ready'||r.spec.direction!=='pull') throw Error('Transfer is not ready for download');
    r.state='sending';
    try {
      if(r.entry) await checkSource(r.entry);
      res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':r.bytes,'X-Content-SHA256':r.sha256,'Cache-Control':'no-store'});
      await pipeline(fs.createReadStream(r.source),res);
      r.state='sent'; // Stream finished; only the receiving client can verify its final local file.
    } catch(e) { r.state='failed'; r.error=e.message; throw e; }
  }
  async cleanup(id) {
    const r=this.get(id); if(['preparing','receiving','sending'].includes(r.state)) throw Error('Transfer is busy');
    r.cleanup= r.cleanup?.removed ? r.cleanup : r.work ? await r.work.cleanup() : {removed:true};
    r.state = r.cleanup.removed ? 'cleaned' : r.state;
    return this.status(r);
  }
}
