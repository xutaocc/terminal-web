import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextRecentVisit, touchRecent, visitCapacity, sortRecentEntries, storedVisitCapacity } from '../web/recent-tabs.js';

test('cycles through all five without mutating MRU order, including remotes', () => {
  const list = ['a', '@mac/b', 'c', '@pc/d', 'e'];
  let current: string | null = 'a';
  const seen = Array.from({ length: 6 }, () => current = nextRecentVisit(list, current, () => true));
  assert.deepEqual(seen, ['@mac/b', 'c', '@pc/d', 'e', 'a', '@mac/b']);
  assert.deepEqual(list, ['a', '@mac/b', 'c', '@pc/d', 'e']);
});
test('offline entries keep their slots but are skipped until available', () => {
  const list = ['a', '@mac/b', 'c'];
  assert.equal(nextRecentVisit(list, 'a', n => n !== '@mac/b'), 'c');
  assert.equal(nextRecentVisit(list, 'a', () => true), '@mac/b');
  assert.equal(nextRecentVisit(list, 'a', () => false), null);
});
test('deleted current, unknown current, empty and single lists are safe', () => {
  assert.equal(nextRecentVisit(['b', 'c'], 'a', () => true), 'b');
  assert.equal(nextRecentVisit([], null, () => true), null);
  assert.equal(nextRecentVisit(['a'], 'a', () => true), 'a');
});
test('capacity changes and normal picks preserve uniqueness and evict the oldest', () => {
  assert.equal(visitCapacity(undefined), 8);
  assert.equal(visitCapacity(Infinity), 8);
  assert.equal(visitCapacity(0), 1);
  assert.equal(visitCapacity(100), 50);
  let list = ['a', 'b', 'c', 'd', 'e'];
  list = touchRecent(list, 'f', 5);
  assert.deepEqual(list, ['f', 'a', 'b', 'c', 'd']);
  list = touchRecent(list, 'c', 5);
  assert.deepEqual(list, ['c', 'f', 'a', 'b', 'd']);
  list = list.slice(0, 2);
  assert.deepEqual(touchRecent(list, 'g', 8), ['g', 'c', 'f']);
});

test('name sorting is stable across visits and leaves eviction order untouched', () => {
  const items = [{ name: 'b', title: '任务10' }, { name: 'a', title: '任务2' }, { name: 'c', title: '任务2' }];
  assert.deepEqual(sortRecentEntries(items).map(e => e.name), ['a', 'c', 'b']);
  assert.deepEqual(sortRecentEntries([...items].reverse()).map(e => e.name), ['a', 'c', 'b']);
  assert.deepEqual(items.map(e => e.name), ['b', 'a', 'c']);
});
test('migrates the old default once, preserving later custom choices', () => {
  assert.equal(storedVisitCapacity(5, undefined), 8);
  assert.equal(storedVisitCapacity(5, 2), 5);
  assert.equal(storedVisitCapacity(12, undefined), 12);
});
