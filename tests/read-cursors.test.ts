import test from 'node:test';
import assert from 'node:assert/strict';
import { newerStatus } from '../web/read-cursors.js';
test('ignore older snapshots of the same instance; accept equal versions for refreshed reads', () => {
 const first={instance:'one',version:10,eventSeq:10,unread:true};
 assert(!newerStatus({...first,version:11},first));
 assert(newerStatus(first,{...first,unread:false}));
});
test('a replacement instance starts a new sequence', () => {
 assert(newerStatus({instance:'old',version:100,unread:false},{instance:'new',version:1,unread:true}));
});
