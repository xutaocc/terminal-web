import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextRecentVisit, touchRecent, visitCapacity } from '../web/recent-tabs.js';

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
  assert.equal(visitCapacity(undefined), 5);
  assert.equal(visitCapacity(Infinity), 5);
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
