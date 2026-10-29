import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { workspace, transferBase, selection, zip, digest, receive, publish, realDirectory, vacant, checkSource } from './transfer-core.mjs';
const prefix='/api/agent/v1/transfers';
export function transferConnection(host) {
  const origin=new URL(host.url);
  if(origin.protocol!=='http:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||host.pin) throw Error('File transfers currently require a configured HTTP origin without certificate pin');
  const agent=new http.Agent({keepAlive:true,maxSockets:2});
  async function send(route, method='GET', body, source, consume) {
    return new Promise((resolve,reject)=>{
      const payload=body===undefined?undefined:JSON.stringify(body);
      const req=http.request(new URL(prefix+route,origin),{agent,method,headers:{Authorization:`Bearer ${host.token}`,...(source?{'Content-Type':'application/octet-stream','Content-Length':source.bytes}:payload?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{})}},res=>{
        (async()=>{
          if(res.statusCode===200 && consume) { await consume(res); return null; }
          let count=0;const chunks=[];for await(const c of res){count+=c.length;if(count>1024*1024)throw Error('Response too large');chunks.push(c);}
          const text=Buffer.concat(chunks).toString('utf8');let value;try{value=JSON.parse(text);}catch{throw Error(`HTTP ${res.statusCode}: invalid response`);}
          if(res.statusCode!==200)throw Error(`HTTP ${res.statusCode}: ${value.error||'transfer rejected'}`);return value;
        })().then(resolve,e=>{res.destroy();reject(e);});
      });
      req.setTimeout(120000,()=>req.destroy(Error('Transfer inactivity timeout; query transfer ID before retrying')));
      req.on('error',reject);
      if(source) pipeline(fs.createReadStream(source.path),req).catch(reject); else req.end(payload);
    });
  }
  return {send,close:()=>agent.destroy()};
}
export async function transferCommand(action,options,host,config,alias,save) {
  const conn=transferConnection(host);let work,remoteId;
  try {
    if(action==='transfer-status'||action==='transfer-cleanup') {
      const id=options.transfer||config.lastTransfer?.[alias]?.id;
      if(typeof id!=='string'||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))throw Error('--transfer UUID required');
      return await conn.send('/'+id,action==='transfer-cleanup'?'DELETE':'GET');
    }
    if(typeof options.spec!=='string')throw Error('--spec LOCAL_JSON required');
    const spec=JSON.parse(await fsp.readFile(options.spec,'utf8'));
    if(spec.extract !== undefined || spec.extractTo !== undefined)throw Error('Automatic extraction is not supported; confirm the complete path and cleanup plan before a separate extraction workflow');
    if(!['push','pull'].includes(action))throw Error('Unsupported transfer action');
    const id=options['request-id']||crypto.randomUUID();
    if(typeof id!=='string'||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))throw Error('Invalid request ID');
    if(typeof spec.destination!=='string'||!spec.destination)throw Error('destination required');
    if(spec.compression!==undefined&&!['fast','store'].includes(spec.compression))throw Error('compression must be fast or store');
    config.lastTransfer??={};config.lastTransfer[alias]={id,direction:action,startedAt:new Date().toISOString()};save();
    process.stderr.write(`transferId=${id}\n`);remoteId=id;
    if(action==='push') {
      const entries=await selection(spec.root,spec.paths,spec.exclude);
      const archive=spec.pack===true||spec.paths.length!==1||['.','./'].includes(spec.paths[0])||entries.length!==1||entries[0]?.directory;
      let source;
      if(archive) {
        if(!spec.destination.toLowerCase().endsWith('.zip'))throw Error('Archive destination must end in .zip');
        work=await workspace(await transferBase(),id);process.stderr.write(`temporary=${work.dir}\n`);
        const h=await work.create('archive.zip');try{await zip(entries,h,spec.compression??'store');}finally{await h.close();}
        await work.seal('archive.zip');source=path.join(work.dir,'archive.zip');
      } else { source=entries[0].absolute; }
      const info=await digest(source);if(!archive)await checkSource(entries[0]);
      const prepared=await conn.send('','POST',{requestId:id,direction:'push',destination:spec.destination,...info});
      if(prepared.state!=='ready')throw Error(`Transfer state ${prepared.state}; inspect status instead of retransmitting`);
      const result=await conn.send('/'+id+'/content','PUT',undefined,{path:source,bytes:info.bytes});
      const localCleanup=await work?.cleanup();work=null;
      return {...result,archive,verified:true,localCleanup};
    }
    if(!path.isAbsolute(spec.destination))throw Error('Absolute local destination required');
    await transferBase();
    const parent=await realDirectory(path.dirname(spec.destination));const destination=path.join(parent,path.basename(spec.destination));await vacant(destination);
    const stagingParent=await transferBase(parent);
    const prepared=await conn.send('','POST',{...spec,compression:spec.compression??'store',requestId:id,direction:'pull'});
    if(prepared.state!=='ready')throw Error(`Transfer state ${prepared.state}; inspect status instead of retransmitting`);
    if(prepared.archive&&!destination.toLowerCase().endsWith('.zip'))throw Error('Archive destination must end in .zip');
    work=await workspace(stagingParent,id);process.stderr.write(`temporary=${work.dir}\n`);
    const h=await work.create('payload.part');
    try { await conn.send('/'+id+'/content','GET',undefined,undefined,res=>receive(res,h,prepared)); } finally { await h.close(); }
    await work.seal('payload.part');
    if(await realDirectory(parent)!==parent)throw Error('Destination parent changed');
    await publish(path.join(work.dir,'payload.part'),destination);await work.seal('payload.part');
    const localCleanup=await work.cleanup();work=null;
    let remoteCleanup;try{remoteCleanup=(await conn.send('/'+id,'DELETE')).cleanup;}catch(e){remoteCleanup={removed:false,reason:e.message,transferId:id};}
    return {transferId:id,state:'complete',path:destination,bytes:prepared.bytes,sha256:prepared.sha256,archive:prepared.archive,verified:true,localCleanup,remoteCleanup};
  } catch(e) {
    const cleanup=await work?.cleanup();
    e.message+=`\ntransferId=${remoteId??'not created'}${cleanup?.retainedPath?' retained='+cleanup.retainedPath:''}. Do not automatically repeat uncertain writes.`;
    throw e;
  } finally { conn.close(); }
}
