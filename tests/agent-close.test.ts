import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentApi } from '../src/agent-api.js';
import { TerminalControl } from '../src/terminal-control.js';

test('browser closure preserves history, rejects busy/invalid names and unlocks after failure', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-close-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const file = path.join(dir, 'sessions.json'), name = 'agent_' + 'a'.repeat(32);
  fs.writeFileSync(file, JSON.stringify({sessions:[{id:'a', name, label:'test', cwd:dir, generation:'g', requests:{r:{hash:'h',result:{input:'hello'}}}}]}));
  const control = new TerminalControl(); let fail = false, removals = 0;
  const api = new AgentApi({file, control, enabled:true, token:'test', spawn: async()=>{throw Error('must not spawn');}, prepareInput:async()=>{}, register:()=>{},
    remove:async (_name, cleanup) => { assert(control.isClosing(name)); if(fail) throw Error('unavailable'); assert.equal(cleanup, true); removals++; }});
  const c = control.join(name, {resume:'r',principal:'p',label:'owner',admin:false,valid:()=>true,send:()=>{}});
  control.action(name,c,'acquire');
  await assert.rejects(api.closeFromBrowser(name), /SESSION_BUSY/);
  await assert.rejects(api.closeFromBrowser('ordinary', true), /INVALID_AGENT_SESSION/);
  fail = true;
  await assert.rejects(api.closeFromBrowser(name, true, true), /unavailable/);
  assert.equal(control.isClosing(name), false);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).sessions[0].ended, undefined);
  fail = false;
  await api.closeFromBrowser(name, false, true);
  const saved = JSON.parse(fs.readFileSync(file,'utf8')).sessions[0];
  assert.equal(saved.ended,true); assert(saved.closedAt); assert.equal(saved.requests.r.result.input,'hello');
  assert(api.history(name)); assert.equal(removals,1);
  api.flushHistory();
});

test('delete after close removes command and output data, keeps tombstone and does not touch project files', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-purge-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'sessions.json'), journal=file+'.history';
  const id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name='agent_'+id.replaceAll('-','');
  fs.mkdirSync(journal);
  fs.writeFileSync(path.join(journal,id+'.json'),JSON.stringify({next:2,truncated:false,events:[{seq:1,time:'t',type:'output',data:'private output'}]}));
  fs.writeFileSync(path.join(journal,id+'.json.tmp'),'temporary output');
  fs.writeFileSync(path.join(dir,'app.py'),'project content');
  fs.writeFileSync(file,JSON.stringify({sessions:[{id,name,label:'test',cwd:dir,generation:'g',requests:{r:{hash:'h',result:{input:'secret command',decodedInput:'decoded command'}}}}]}));
  let failClose=true;
  const backend={file,enabled:true,token:'t',control:new TerminalControl(),spawn:async()=>{throw Error('must not spawn');},prepareInput:async()=>{},register:()=>{},remove:async()=>{if(failClose)throw Error('close failed');}};
  const api=new AgentApi(backend);
  await assert.rejects(api.closeFromBrowser(name,false,false,true),/close failed/);
  assert(fs.existsSync(path.join(journal,id+'.json')));
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).sessions[0].requests.r.result.input,'secret command');
  failClose=false;
  const result=await api.closeFromBrowser(name,false,false,true);
  assert.equal(result.historyDeleted,true);
  api.flushHistory();
  assert(!fs.existsSync(path.join(journal,id+'.json')));
  assert(!fs.existsSync(path.join(journal,id+'.json.tmp')));
  assert.equal(fs.readFileSync(path.join(dir,'app.py'),'utf8'),'project content');
  const saved=JSON.parse(fs.readFileSync(file,'utf8')).sessions[0];
  assert(saved.ended && saved.historyClearedAt); assert.deepEqual(saved.requests,{});
  const restarted=new AgentApi(backend);
  assert.equal(restarted.closedHistory().count,0);
  assert.deepEqual((restarted.history(name) as {records:unknown[]}).records,[]);
  assert.equal(restarted.isAgent(name),true);
});

test('bulk validates every closed ID before deleting and exposes failed cleanup for retry', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-purge-retry-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'sessions.json'),journal=file+'.history';
  const id='cccccccc-cccc-cccc-cccc-cccccccccccc',open='dddddddd-dddd-dddd-dddd-dddddddddddd';
  fs.mkdirSync(journal);
  // A directory at the journal path simulates a filesystem deletion failure on every OS.
  fs.mkdirSync(path.join(journal,id+'.json'));
  fs.writeFileSync(file,JSON.stringify({sessions:[id,open].map(i=>({id:i,name:'agent_'+i.replaceAll('-',''),label:'test',cwd:dir,generation:'g',ended:i===id,requests:{r:{hash:'h',result:{input:'command'}}}}))}));
  const api=new AgentApi({file,enabled:true,token:'t',control:new TerminalControl(),spawn:async()=>{throw Error();},prepareInput:async()=>{},register:()=>{},remove:async()=>{}});
  assert.throws(()=>api.purgeClosedHistory([id,open]),/SESSION_NOT_CLOSED/);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).sessions[0].requests.r.result.input,'command');
  const first=api.purgeClosedHistory([id]); assert.deepEqual(first.failed,[id]);
  assert.equal(api.closedHistory().count,1);
  fs.rmdirSync(path.join(journal,id+'.json'));
  assert.deepEqual(api.purgeClosedHistory([id]).deleted,[id]);
  assert.equal(api.closedHistory().count,0);
  assert.equal((api.history('agent_'+open.replaceAll('-','')) as {records:unknown[]}).records.length,1);
});

test('legacy unregistered closure exposes cleanup failures for bulk retry', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-orphan-purge-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'sessions.json'),id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',name='agent_'+id.replaceAll('-','');
  fs.mkdirSync(file+'.history'); fs.mkdirSync(path.join(file+'.history',id+'.json'));
  const api=new AgentApi({file,enabled:true,token:'t',control:new TerminalControl(),spawn:async()=>{throw Error();},prepareInput:async()=>{},register:()=>{},remove:async()=>{}});
  const result=await api.closeFromBrowser(name,false,false,true);
  assert.equal(result.closed,true); assert.equal(result.historyDeleted,false); assert.equal(result.cleanupError,'HISTORY_CLEANUP_FAILED');
  assert.equal(api.closedHistory().sessions[0].id,id);
  fs.rmdirSync(path.join(file+'.history',id+'.json'));
  assert.deepEqual(api.purgeClosedHistory([id]).deleted,[id]);
});
