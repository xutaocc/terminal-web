import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {handleFileApi} from '../src/file-api.js';
import {checkFileScope} from '../src/file-scope.js';
test('scoped file operations, job isolation, root protection and live permission revocation', async () => {
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'file-scope-'))),root=path.join(base,'shared');await fs.mkdir(root);await fs.writeFile(path.join(base,'secret'),'secret');await fs.writeFile(path.join(root,'a.txt'),'a');
 let enabled=true,owner='one';
 const scope=()=>({root,owner,writable:true,authorize:()=>enabled});
 const server=http.createServer((req,res)=>{void handleFileApi(req,res,new URL(req.url!,'http://localhost'),{maxUpload:10000,tmuxConf:'',scope:scope()});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/api/files/`;
 const request=async(route:string,data?:unknown,params:Record<string,string>={})=>{const r=await fetch(url+route+'?'+new URLSearchParams(params),data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});return {status:r.status,data:await r.json() as any};};
 try {
  assert.equal((await request('text',undefined,{path:path.join(base,'secret')})).status,403);
  assert.equal((await request('create',{directory:root,name:'child',kind:'directory'})).status,200);
  const text=await request('text',undefined,{path:path.join(root,'a.txt')});
  assert.equal((await request('write',{path:path.join(root,'a.txt'),text:'changed',version:text.data.version})).status,200);
  assert.equal((await request('rename',{path:root,name:'renamed'})).status,403);
  assert.equal((await request('compression-plan',{paths:[root]})).status,202);
  const scan=await request('scan',{paths:[path.join(root,'a.txt')]});assert.equal(scan.status,202);
  owner='two';assert.equal((await request('job',undefined,{id:scan.data.jobId})).status,403);owner='one';
  const cp=await request('copy',{paths:[path.join(root,'a.txt')],destination:path.join(root,'child')});assert.equal(cp.status,202);
  for(let i=0;i<50;i++){const job=await request('job',undefined,{id:cp.data.jobId});if(job.data.status!=='running'){assert.equal(job.data.status,'complete');break;}await new Promise(r=>setTimeout(r,10));}
  assert.equal(await fs.readFile(path.join(root,'child','a.txt'),'utf8'),'changed');
  assert.equal((await request('move',{paths:[path.join(root,'a.txt')],destination:base})).status,403);
  if(process.platform!=='win32') {
   await fs.symlink(base,path.join(root,'escape'));
   await assert.rejects(checkFileScope(scope(),path.join(root,'escape','secret')));
   await assert.rejects(checkFileScope(scope(),root,true,true));
   await fs.link(path.join(base,'secret'),path.join(root,'hardlink'));
   await assert.rejects(checkFileScope(scope(),path.join(root,'hardlink'),true));
  }
  enabled=false;assert.equal((await request('write',{path:path.join(root,'a.txt'),text:'bad',version:text.data.version})).status,403);
  assert.equal(await fs.readFile(path.join(base,'secret'),'utf8'),'secret');
 } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await fs.rm(base,{recursive:true,force:true});}
});
