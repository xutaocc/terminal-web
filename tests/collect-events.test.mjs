import test from 'node:test';
import assert from 'node:assert/strict';
import { collectEvents, readOptions } from '../remote-agent/client/collect-events.mjs';
const page = (seq, extra = {}) => ({events:[{seq,type:'output',data:'hello'}],cursor:seq,epoch:'a',alive:true,mine:true,...extra});
async function collect(pages, opts = {}) {
  const state={cursor:0,epoch:'a'}, saved=[];
  const result=await collectEvents(async () => {const p=pages.shift();if(p instanceof Error) throw p;return p;},state,()=>saved.push(state.cursor),readOptions({collect:true,wait:'1',...opts},'read'));
  return {result,state,saved};
}
test('later read failure returns acknowledged output and resumable cursor',async()=>{
  const {result,state}=await collect([page(1),new Error('offline')]);
  assert.equal(result.events[0].data,'hello'); assert.equal(result.collection.reason,'read-error');
  assert.equal(result.readError,'offline');assert.equal(state.cursor,1);
});
test('gaps, closed terminals and lost ownership stop automatic reads',async()=>{
  for(const [extra,reason] of [[{gap:true,epoch:'b'},'gap'],[{alive:false},'closed'],[{mine:false},'not-owner']]) {
    const {result,saved}=await collect([page(1,extra)]);
    assert.equal(result.collection.reason,reason);assert.deepEqual(saved,[1]);
    assert.equal(result.collection.completion,'unknown');
  }
});
test('budget stops preserve whole events rather than truncate acknowledged output',async()=>{
  const {result,state}=await collect([page(1,{events:[{seq:1,type:'output',data:'x'.repeat(2000)}]})],{'max-bytes':'1024'});
  assert.equal(result.events[0].data.length,2000);assert.equal(result.collection.reason,'byte-limit');
  assert.equal(state.cursor,1);
});
test('zero wait returns promptly with deadline, never completion',async()=>{
  const {result}=await collect([page(0,{events:[]})],{wait:'0'});
  assert.equal(result.collection.reason,'deadline');assert.equal(result.collection.completion,'unknown');
});
test('reject invalid collection options before input',()=>{
  for(const options of [{wait:true},{wait:'Infinity'},{wait:'-1'},{collect:'false'},{'max-batches':'0',collect:true},{after:'1.5'}]) {
    assert.throws(()=>readOptions(options,'read'));
  }
  assert.throws(()=>readOptions({collect:true},'exec'));
});
