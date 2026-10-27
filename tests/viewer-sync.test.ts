import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewerStateSync } from '../web/viewer-state.js';
import { ViewerStateStore } from '../src/viewer-state.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const settle = () => new Promise(resolve => setTimeout(resolve, 30));
test('PC/phone synchronize within a token, another token remains unread; retries and new events are safe', async () => {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'viewer-sync-'));
 try {
  const store=new ViewerStateStore(path.join(dir,'state.json'));
  let offline=false;
  const request=(scope:string):typeof fetch => async (_url,init) => {
   if(offline) throw new Error('offline');
   return Response.json(init?.method==='POST' ? await store.update(scope,JSON.parse(String(init.body)),()=>true) : await store.snapshot(scope));
  };
  const pc=new ViewerStateSync(()=>{},request('admin')),phone=new ViewerStateSync(()=>{},request('admin')),share=new ViewerStateSync(()=>{},request('share'));
  await Promise.all([pc.refresh(),phone.refresh(),share.refresh()]);
  const first={instance:'session-one',version:10,eventSeq:10,unread:true};
  assert(pc.unread('s',first)); pc.read('s',first); assert(!pc.unread('s',first));
  await settle(); await phone.refresh(); assert(!phone.unread('s',first)); assert(share.unread('s',first));
  const second={...first,version:20,eventSeq:20}; assert(phone.unread('s',second));
  offline=true; phone.read('s',second); await settle(); assert(!phone.unread('s',second));
  offline=false; await phone.refresh(); await settle(); await pc.refresh(); assert(!pc.unread('s',second));
  assert(pc.unread('s',{...second,instance:'recreated'}));
  assert(pc.unread('s',{...second,eventSeq:21}));
  assert(share.unread('s',second));
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
