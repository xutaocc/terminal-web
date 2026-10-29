import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {AgentTasks,AgentFiles} from '../src/agent-work.js';
import {AgentApi} from '../src/agent-api.js';
import {TerminalControl} from '../src/terminal-control.js';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean,ms=10000){const end=Date.now()+ms;while(!fn()){if(Date.now()>end)throw Error('condition timeout');await sleep(30);}}
function fixture(t:any){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-work-')), tasks=new AgentTasks(path.join(dir,'tasks')), files=new AgentFiles(path.join(dir,'receipts.json'));
 t.after(async()=>{for(const task of tasks.list().tasks)if(['starting','running','cancelling'].includes(task.status))tasks.cancel(task.taskId);await until(()=>tasks.list().tasks.every(s=>!['starting','running','cancelling'].includes(s.status)));fs.rmSync(dir,{recursive:true,force:true});});
 const create=(code:string,extra:any={})=>tasks.create({requestId:crypto.randomUUID(),cwd:dir,executable:process.execPath,args:['-e',code],...extra});
 return {dir,tasks,files,create};
}
test('task has real exit code, cwd, separated output and survives API object recreation',async t=>{
 const {dir,tasks,create}=fixture(t), task=create("console.log(process.cwd());console.error('failure text');process.exitCode=7");
 const restored=new AgentTasks(path.join(dir,'tasks'));
 await until(()=>restored.get(task.taskId).status==='failed');
 const result=restored.get(task.taskId);assert.equal(result.exitCode,7);assert.ok(result.startedAt);assert.ok(result.finishedAt);
 const logs=tasks.logs(task.taskId);assert.ok(logs.events.some(e=>e.stream==='stdout'&&e.data.includes(dir)));assert.ok(logs.events.some(e=>e.stream==='stderr'&&e.data.includes('failure text')));
 assert.equal(tasks.logs(task.taskId,logs.nextCursor).events.length,0);
 tasks.remove(task.taskId);assert.equal(tasks.list().total,0);assert.equal(tasks.remove(task.taskId).deleted,true);
});
test('durable task dedupe never reexecutes after deletion; conflict rejected',async t=>{
 const {dir,tasks}=fixture(t), requestId=crypto.randomUUID();
 const spec={requestId,cwd:dir,executable:process.execPath,args:['-e',"console.log('once')"]};
 const a=tasks.create(spec), b=tasks.create(spec);assert.equal(a.taskId,b.taskId);
 assert.throws(()=>tasks.create({...spec,args:['-e','0']}),/REQUEST_CONFLICT/);
 await until(()=>tasks.get(a.taskId).status==='succeeded');tasks.remove(a.taskId);
 assert.throws(()=>tasks.create(spec),/TASK_DELETED/);
});
test('timeout and explicit cancel terminate owned process trees, not other tasks',async t=>{
 const {tasks,create}=fixture(t);
 const other=create('setTimeout(()=>{},10000)');
 const timed=create('setTimeout(()=>{},10000)',{timeoutMs:200});
 await until(()=>tasks.get(timed.taskId).status==='timed_out');
 assert.equal(tasks.get(other.taskId).status,'running');
 assert.throws(()=>tasks.remove(other.taskId),/TASK_NOT_FINISHED/);
 tasks.cancel(other.taskId);await until(()=>tasks.get(other.taskId).status==='cancelled');
});
test('cancellation kills a running descendant before it can write',async t=>{
 const {dir,tasks,create}=fixture(t), marker=path.join(dir,'descendant.txt');
 const childCode=`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'alive'),1800);setTimeout(()=>{},10000)`;
 const task=create(`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});console.log('READY');setTimeout(()=>{},10000)`);
 await until(()=>tasks.logs(task.taskId).events.some(e=>e.data.includes('READY')));
 tasks.cancel(task.taskId);await until(()=>tasks.get(task.taskId).status==='cancelled');await sleep(2100);
 assert.equal(fs.existsSync(marker),false);
});
test('missing executable, output cap and stale worker status are explicit',async t=>{
 const {dir,tasks,create}=fixture(t);
 const bad=create('',{executable:path.join(dir,'not-an-executable')});await until(()=>tasks.get(bad.taskId).status==='start_failed');
 const loud=create("process.stdout.write('x'.repeat(6*1024*1024))");await until(()=>tasks.get(loud.taskId).status==='succeeded');
 assert.equal(tasks.get(loud.taskId).outputTruncated,true);
 assert.ok(fs.statSync(path.join(dir,'tasks',loud.taskId,'output.jsonl')).size<=4*1024*1024);
 const file=path.join(dir,'tasks',bad.taskId,'state.json'), state=JSON.parse(fs.readFileSync(file,'utf8'));
 fs.writeFileSync(file,JSON.stringify({...state,status:'running',heartbeatAt:'2000-01-01T00:00:00Z'}));
 assert.equal(tasks.get(bad.taskId).status,'unknown');assert.throws(()=>tasks.cancel(bad.taskId),/TASK_STATE_UNKNOWN/);
 tasks.remove(bad.taskId,true);
});
test('file create/read/patch are hash guarded, idempotent and preserve CRLF',t=>{
 const {dir,files}=fixture(t), body={root:dir,path:'hello.txt',expectedHash:null,requestId:crypto.randomUUID(),content:'first\r\nsecond\r\n'};
 const made=files.mutate(body);assert.equal(made.state,'written');assert.deepEqual(files.mutate(body),made);
 const read=files.read({root:dir,path:'hello.txt',startLine:2,lineCount:1});assert.equal(read.content,'second\r');assert.equal(read.hash,made.hash);
 const changed=files.mutate({root:dir,path:'hello.txt',expectedHash:made.hash,requestId:crypto.randomUUID(),edits:[{oldText:'second',newText:'updated'}]},true);
 assert.equal(fs.readFileSync(path.join(dir,'hello.txt'),'utf8'),'first\r\nupdated\r\n');assert.notEqual(changed.hash,made.hash);
 assert.throws(()=>files.mutate({...body,requestId:crypto.randomUUID(),expectedHash:made.hash}),/FILE_CONFLICT/);
 assert.throws(()=>files.mutate({...body,content:'changed'}),/REQUEST_CONFLICT/);
 assert.equal(files.result(body.requestId).hash,made.hash);
});
test('file patches reject ambiguous text; traversal, symlinks and binary are rejected',async t=>{
 const {dir,files}=fixture(t);fs.writeFileSync(path.join(dir,'same.txt'),'a a');
 const r=files.read({root:dir,path:'same.txt'});
 assert.throws(()=>files.mutate({root:dir,path:'same.txt',expectedHash:r.hash,requestId:crypto.randomUUID(),edits:[{oldText:'a',newText:'b'}]},true),/PATCH_NOT_UNIQUE/);
 assert.throws(()=>files.read({root:dir,path:'../outside'}),/PATH_OUTSIDE_ROOT/);
 fs.writeFileSync(path.join(dir,'binary'),Buffer.from([0,255]));assert.throws(()=>files.read({root:dir,path:'binary'}),/UTF8_REQUIRED|TEXT_FILE_REQUIRED/);
 fs.mkdirSync(path.join(dir,'actual'));fs.writeFileSync(path.join(dir,'actual','a.txt'),'hidden');
 try {fs.symlinkSync(path.join(dir,'actual'),path.join(dir,'link'),process.platform==='win32'?'junction':'dir');assert.throws(()=>files.read({root:dir,path:'link/a.txt'}),/SYMLINK_NOT_ALLOWED/);}catch(e:any){if(e.code!=='EPERM')throw e;}
 const search=await files.search({root:dir,query:'a a'});assert.equal(search.matches[0].line,1);assert.equal(search.matches[0].path,'same.txt');
});
test('new HTTP routes retain auth and reject browser origin',async t=>{
 const {dir}=fixture(t);
 const api=new AgentApi({enabled:true,token:'test',file:path.join(dir,'sessions.json'),control:new TerminalControl(),spawn:async()=>{throw Error('unused');},prepareInput:async()=>{},register(){},remove:async()=>{}});
 const server=http.createServer((req,res)=>void api.http(req,res,new URL(req.url!,'http://localhost')));
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const base=`http://127.0.0.1:${(server.address() as any).port}/api/agent/v1`;
 for(const route of ['/tasks','/files/search','/transfers']){
  assert.equal((await fetch(base+route,{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(base+route,{method:'POST',headers:{Authorization:'Bearer test',Origin:'https://elsewhere'},body:'{}'})).status,403);
 }
 assert.equal((await fetch(base+'/tasks',{headers:{Authorization:'Bearer test'}})).status,200);
 const info=await (await fetch(base+'/info',{headers:{Authorization:'Bearer test'}})).json();assert.ok(info.capabilities.includes('tasks-v1'));assert.equal(info.completion,false);
});


test('CLI task and file workflows operate through authenticated HTTP',async t=>{
 const {dir}=fixture(t);
 const api=new AgentApi({enabled:true,token:'test',file:path.join(dir,'http-sessions.json'),control:new TerminalControl(),spawn:async()=>{throw Error('unused');},prepareInput:async()=>{},register(){},remove:async()=>{}});
 const server=http.createServer((req,res)=>void api.http(req,res,new URL(req.url!,'http://localhost')));
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const {runClient}=await import('../remote-agent/client/twssh.mjs');
 const cli=async(args:string[])=>{let out='';await runClient(args,{home:path.join(dir,'client'),alias:'test',host:{url:`http://127.0.0.1:${(server.address() as any).port}`,token:'test'},write:(text:string)=>out+=text});return JSON.parse(out);};
 const spec=path.join(dir,'spec.json');fs.writeFileSync(spec,JSON.stringify({cwd:dir,executable:process.execPath,args:['-e',"console.log('CLI_OK')"]}));
 const task=await cli(['task','create','test','--spec',spec]);
 const done=await cli(['task','wait','test','--task',task.taskId,'--wait','5']);assert.equal(done.status,'succeeded');assert.equal(done.exitCode,0);
 const logs=await cli(['task','logs','test','--task',task.taskId]);assert.ok(logs.events.some((e:any)=>e.data.includes('CLI_OK')));
 await cli(['task','delete','test','--task',task.taskId]);
 const content=path.join(dir,'content.txt');fs.writeFileSync(content,'hello world');
 const written=await cli(['file','write','test','--root',dir,'--path','target.txt','--file',content,'--expected-hash','missing']);assert.equal(written.state,'written');
 const read=await cli(['file','read','test','--root',dir,'--path','target.txt']);assert.equal(read.hash,written.hash);assert.equal(read.content,'hello world');
 const edits=path.join(dir,'edits.json');fs.writeFileSync(edits,JSON.stringify([{oldText:'world',newText:'agent'}]));
 const patched=await cli(['file','patch','test','--root',dir,'--path','target.txt','--edits',edits,'--expected-hash',read.hash]);assert.equal(patched.state,'written');
 assert.equal(fs.readFileSync(path.join(dir,'target.txt'),'utf8'),'hello agent');
});


test('transfer CLI uses real Agent API auth, hash verification and safe cleanup',async t=>{
 const {dir}=fixture(t);
 const api=new AgentApi({enabled:true,token:'test',file:path.join(dir,'transfer-sessions.json'),control:new TerminalControl(),spawn:async()=>{throw Error('unused');},prepareInput:async()=>{},register(){},remove:async()=>{}});
 const server=http.createServer((req,res)=>void api.http(req,res,new URL(req.url!,'http://localhost')));
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise<void>(r=>server.close(()=>r())));
 const {runClient}=await import('../remote-agent/client/twssh.mjs');
 const cli=async(args:string[])=>{let out='';await runClient(args,{home:path.join(dir,'client'),alias:'test',host:{url:`http://127.0.0.1:${(server.address() as any).port}`,token:'test'},write:(text:string)=>out+=text});return JSON.parse(out);};
 const source=path.join(dir,'input.bin');fs.writeFileSync(source,crypto.randomBytes(8192));
 const spec=path.join(dir,'transfer.json'),destination=path.join(dir,'remote.bin');fs.writeFileSync(spec,JSON.stringify({root:dir,paths:['input.bin'],destination}));
 const pushed=await cli(['file','push','test','--spec',spec]);assert.equal(pushed.verified,true);assert.equal(pushed.cleanup.removed,true);assert.deepEqual(fs.readFileSync(destination),fs.readFileSync(source));
 const status=await cli(['file','transfer-status','test','--transfer',pushed.transferId]);assert.equal(status.state,'complete');
 fs.writeFileSync(spec,JSON.stringify({root:dir,paths:['remote.bin'],destination:path.join(dir,'returned.bin')}));
 const pulled=await cli(['file','pull','test','--spec',spec]);assert.equal(pulled.verified,true);assert.deepEqual(fs.readFileSync(pulled.path),fs.readFileSync(source));
});
