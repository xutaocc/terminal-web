import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ViewerStateStore, cursorKey } from '../src/viewer-state.js';
import { combineStatus } from '../web/agent-indicator.js';

test('credential isolation, durable monotonic reads, concurrent visits and replacement sessions', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-state-'));
  try {
    const file = path.join(dir, 'state.json'), store = new ViewerStateStore(file);
    const allowed = (name: string) => ['one', '@remote/two'].includes(name);
    const events: string[] = []; const off = store.subscribe(scope => events.push(scope));
    await Promise.all([20, 10, 30].map(seq => store.update('admin', {type: 'read', session: 'one', instance: 'a', seq}, allowed)));
    assert.equal((await store.snapshot('admin')).reads[cursorKey('one', 'a')], 30);
    assert.deepEqual((await store.snapshot('share')).reads, {});
    assert.equal((await store.snapshot('admin')).reads[cursorKey('one', 'b')], undefined);
    await store.update('share', {type: 'read', session: 'one', instance: 'a', seq: 15}, allowed);
    assert.equal((await store.snapshot('admin')).reads[cursorKey('one', 'a')], 30);
    await Promise.all(['one', '@remote/two'].map(session => store.update('admin', {type: 'visit', session}, allowed)));
    assert.deepEqual((await store.snapshot('admin')).recent, ['@remote/two', 'one']);
    await store.update('admin', {type: 'remove', session: 'one'}, allowed);
    await store.update('admin', {type: 'limit', limit: 1}, allowed);
    assert.deepEqual(await new ViewerStateStore(file).snapshot('admin'), await store.snapshot('admin'));
    await assert.rejects(store.update('share', {type: 'visit', session: 'secret'}, allowed));
    await assert.rejects(store.update('share', {type: 'read', session: 'one', instance: 'a', seq: -1}, allowed));
    assert.deepEqual((await store.snapshot('reset-token')).recent, []);
    assert(events.includes('admin') && events.includes('share')); off();
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('one mutually exclusive indicator; waiting and running retain semantic priority', () => {
  assert.equal(combineStatus([{state:'working', unread:true}]), 'working');
  assert.equal(combineStatus([{state:'done', unread:true}]), 'unread');
  assert.equal(combineStatus([{state:'done', unread:false}]), 'done');
  assert.equal(combineStatus([{state:'waiting', unread:false}]), 'waiting');
  assert.equal(combineStatus([{state:'working', unread:true}, {state:'waiting', unread:true}]), 'waiting');
});
