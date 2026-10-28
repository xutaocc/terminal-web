import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeShares, type ShareSummaryRecord } from '../web/share-summary.js';
const share = (id: string, sessions: ShareSummaryRecord['sessions'], extra = {}): ShareSummaryRecord => ({ id, status: 'active', expiresAt: null, sessions, ...extra });
test('counts active tokens, deduplicates session grants and separates hosts', () => {
  const a = share('a', [{host:'',name:'same'}, {host:'',name:'same'}, {host:'remote',name:'same'}]);
  const b = share('b', [{host:'',name:'same'}]);
  const result = summarizeShares([a,a,b], new Map(), 100);
  assert.equal(result.count, 2);
  assert.deepEqual([...result.sessions], [['same',2],['@remote/same',1]]);
});
test('revoked and expired tokens do not mark sessions', () => {
  const result = summarizeShares([
    share('a',[{host:'',name:'x'}],{status:'revoked'}),
    share('b',[{host:'',name:'x'}],{expiresAt:100}),
  ], new Map(), 100);
  assert.equal(result.count,0); assert.equal(result.sessions.size,0);
});
test('a recreated session does not inherit an old grant', () => {
  const result = summarizeShares([share('a',[{host:'',name:'x',identity:'old'}])],new Map([['x','new']]));
  assert.equal(result.count,1); assert.equal(result.sessions.size,0);
});
