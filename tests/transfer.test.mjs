import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {workspace,transferBase,selection,zip,receive,digest,publish} from '../remote-agent/client/transfer-core.mjs';
import {AgentTransfers} from '../remote-agent/transfer-service.mjs';
import {transferCommand} from '../remote-agent/client/transfer-command.mjs';
async function fixture(t){const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'twssh-transfer-test-'));t.after(()=>fsp.rm(dir,{recursive:true,force:true}));return dir;}
function validateZip(file) {
 if(process.platform==='win32') execFileSync('pwsh',['-NoProfile','-NonInteractive','-Command','$file=$env:TWSSH_TEST_ZIP; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::OpenRead($file); try { foreach($e in $z.Entries) {$s=$e.Open(); try {$s.CopyTo([IO.Stream]::Null)} finally {$s.Dispose()}} } finally {$z.Dispose()}'],{env:{...process.env,TWSSH_TEST_ZIP:file}});
 else execFileSync('unzip',['-t',file]);
}
function extractZip(file,out) {
 if(process.platform==='win32') execFileSync('pwsh',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:TWSSH_TEST_ZIP -DestinationPath $env:TWSSH_TEST_OUT'],{env:{...process.env,TWSSH_TEST_ZIP:file,TWSSH_TEST_OUT:out}});
 else execFileSync('unzip',['-q',file,'-d',out]);
}
async function member(w,data='owned'){const h=await w.create('payload.part');await h.writeFile(data);await h.close();await w.seal('payload.part');return path.join(w.dir,'payload.part');}
test('platform staging home and explicit extraction rejection',async t=>{
 const dir=await fixture(t);const base=await transferBase(dir);
 if(process.platform==='win32') assert.equal(base.toLowerCase(),(await fsp.realpath('C:/twsshProjecTemp')).toLowerCase());
 else assert.equal(base,await fsp.realpath(dir));
 const service=new AgentTransfers();
 await assert.rejects(service.prepare({requestId:crypto.randomUUID(),direction:'pull',extractTo:'unapproved'}),/Automatic extraction is not supported/);
 assert.equal(service.records.size,0);
});
test('cleanup removes only recorded files, leaves similarly named neighbors',async t=>{
 const dir=await fixture(t);await assert.rejects(workspace(dir,'../../other'),/UUID/);const neighbor=path.join(dir,'.twssh-transfer-user');await fsp.mkdir(neighbor);await fsp.writeFile(path.join(neighbor,'mine'),'keep');
 const w=await workspace(dir);await member(w);assert.equal((await w.cleanup()).removed,true);assert.equal(await fsp.readFile(path.join(neighbor,'mine'),'utf8'),'keep');
});
test('unknown member blocks ALL cleanup',async t=>{const dir=await fixture(t),w=await workspace(dir);const own=await member(w);await fsp.writeFile(path.join(w.dir,'user.txt'),'keep');assert.equal((await w.cleanup()).removed,false);assert.equal(await fsp.readFile(own,'utf8'),'owned');assert.ok(fs.existsSync(path.join(w.dir,'owner.json')));});
test('changed owned member, symlink replacement and replaced directory are retained',{skip:process.platform==='win32'?'file symlinks need developer mode':false},async t=>{
 const dir=await fixture(t); const w=await workspace(dir),p=await member(w);await fsp.writeFile(p,'edited by user');assert.equal((await w.cleanup()).removed,false);assert.equal(await fsp.readFile(p,'utf8'),'edited by user');
 const other=path.join(dir,'outside');await fsp.writeFile(other,'outside');const w2=await workspace(dir);const p2=await member(w2);await fsp.unlink(p2);await fsp.symlink(other,p2);assert.equal((await w2.cleanup()).removed,false);assert.equal(await fsp.readFile(other,'utf8'),'outside');
 const w3=await workspace(dir);await member(w3);await fsp.rename(w3.dir,w3.dir+'-moved');await fsp.mkdir(w3.dir);await fsp.writeFile(path.join(w3.dir,'mine'),'keep');assert.equal((await w3.cleanup()).removed,false);assert.ok(fs.existsSync(path.join(w3.dir,'mine')));
});
test('partial unsealed files retained; checksum mismatch does not publish',async t=>{
 const dir=await fixture(t),w=await workspace(dir),h=await w.create('payload.part');await assert.rejects(receive(Readable.from([Buffer.from('wrong')]),h,{bytes:5,sha256:'0'.repeat(64)}),/checksum/);await h.close();assert.equal((await w.cleanup()).removed,false);assert.ok(fs.existsSync(path.join(w.dir,'payload.part')));
});
test('publication is no-clobber and cleanup preserves published destination',async t=>{
 const dir=await fixture(t),w=await workspace(dir),p=await member(w),dest=path.join(dir,'result');await publish(p,dest);await w.seal('payload.part');assert.equal((await w.cleanup()).removed,true);assert.equal(await fsp.readFile(dest,'utf8'),'owned');
 const w2=await workspace(dir),p2=await member(w2,'new');await assert.rejects(publish(p2,dest),/already exists/);assert.equal(await fsp.readFile(dest,'utf8'),'owned');
});
test('selection excludes explicit subtrees, refuses links and traversal, detects source edits',{skip:process.platform==='win32'?'file symlinks need developer mode':false},async t=>{
 const dir=await fixture(t);await fsp.mkdir(path.join(dir,'cache'));await fsp.writeFile(path.join(dir,'cache','a'),'a');await fsp.writeFile(path.join(dir,'a.txt'),'a');
 const entries=await selection(dir,['.'],['cache']);assert.deepEqual(entries.map(e=>e.rel),['a.txt']);await assert.rejects(selection(dir,['../bad']),/traversal/);await fsp.symlink(path.join(dir,'a.txt'),path.join(dir,'link'));await assert.rejects(selection(dir,['link']),/links/);
 await fsp.writeFile(path.join(dir,'a.txt'),'changed');const w=await workspace(dir),h=await w.create('archive.zip');await assert.rejects(zip(entries,h),/Source changed/);await h.close();
});
test('ZIP fast and store: standard unzip validates Unicode, nested, empty and binary files',async t=>{
 const dir=await fixture(t),root=path.join(dir,'input');await fsp.mkdir(root);await fsp.mkdir(path.join(root,'空目录'));await fsp.mkdir(path.join(root,'folder'));await fsp.writeFile(path.join(root,'中文.txt'),'你好\n'.repeat(100));const binary=crypto.randomBytes(25000);await fsp.writeFile(path.join(root,'folder','data.bin'),binary);
 for(const compression of ['fast','store']){const w=await workspace(dir),h=await w.create('archive.zip');await zip(await selection(root,['.']),h,compression);await h.close();await w.seal('archive.zip');const file=path.join(w.dir,'archive.zip');validateZip(file);const out=path.join(dir,compression);extractZip(file,out);assert.deepEqual(await fsp.readFile(path.join(out,'folder','data.bin')),binary);assert.equal(await fsp.readFile(path.join(out,'中文.txt'),'utf8'),'你好\n'.repeat(100));assert.ok((await fsp.stat(path.join(out,'空目录'))).isDirectory());assert.equal((await w.cleanup()).removed,true);}
});
test('HTTP push/pull binary and folder ZIP, receipts and no-clobber',async t=>{
 const dir=await fixture(t),local=path.join(dir,'local'),remote=path.join(dir,'remote');await fsp.mkdir(local);await fsp.mkdir(remote);await fsp.writeFile(path.join(local,'binary'),crypto.randomBytes(50000));
 const service=new AgentTransfers();const server=http.createServer(async(req,res)=>{try{assert.equal(req.headers.authorization,'Bearer test');const route=new URL(req.url,'http://test').pathname.replace('/api/agent/v1/transfers','');let result;if(!route){let text='';for await(const c of req)text+=c;result=await service.prepare(JSON.parse(text));}else{const [,id,content]=route.split('/');if(content&&req.method==='GET'){await service.download(id,res);return;}result=content?await service.upload(id,req):req.method==='DELETE'?await service.cleanup(id):service.status(service.get(id));}res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));}catch(e){if(!res.headersSent){res.writeHead(400);res.end(JSON.stringify({error:e.message}));}else res.destroy(e);}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const host={url:`http://127.0.0.1:${server.address().port}`,token:'test'};const config={};
 async function run(action,spec){const file=path.join(dir,'spec.json');await fsp.writeFile(file,JSON.stringify(spec));return transferCommand(action,{spec:file},host,config,'test',()=>{});}
 const target=path.join(remote,'binary');const pushed=await run('push',{root:local,paths:['binary'],destination:target});assert.equal(pushed.verified,true);assert.equal(pushed.cleanup.removed,true);if(process.platform==='win32')assert.equal(path.dirname(pushed.tempPath).toLowerCase(),(await fsp.realpath('C:/twsshProjecTemp')).toLowerCase());assert.deepEqual(await digest(target),await digest(path.join(local,'binary')));
 await assert.rejects(run('push',{root:local,paths:['binary'],destination:target}),/already exists/);
 const downloaded=path.join(local,'back');const pulled=await run('pull',{root:remote,paths:['binary'],destination:downloaded});assert.equal(pulled.verified,true);assert.equal(pulled.localCleanup.removed,true);assert.deepEqual(await digest(downloaded),await digest(target));
 const packed=await run('push',{root:local,paths:['.'],exclude:['back'],destination:path.join(remote,'bundle.zip'),compression:'store'});assert.equal(packed.archive,true);validateZip(path.join(remote,'bundle.zip'));
 const got=await run('pull',{root:remote,paths:['.'],destination:path.join(local,'remote.zip')});assert.equal(got.archive,true);assert.equal(got.remoteCleanup.removed,true);validateZip(path.join(local,'remote.zip'));
});
