import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moveTab, restoreTabOrder } from '../web/tab-order.js';

test('tabs move left and right to either side of the drop target', () => {
  assert.deepEqual(moveTab(['a', 'b', 'c'], 'c', 'a', false), ['c', 'a', 'b']);
  assert.deepEqual(moveTab(['a', 'b', 'c'], 'a', 'c', true), ['b', 'c', 'a']);
  assert.deepEqual(moveTab(['a', 'b', 'c'], 'a', 'c', false), ['b', 'a', 'c']);
  assert.deepEqual(moveTab(['a', 'b', 'c'], 'c', 'a', true), ['a', 'c', 'b']);
});
test('self drops and disappearing sessions preserve the order', () => {
  const original = ['a', 'b'];
  assert.deepEqual(moveTab(original, 'a', 'a', true), original);
  assert.deepEqual(moveTab(original, 'missing', 'b', true), original);
  assert.deepEqual(original, ['a', 'b']);
});
test('restoring order retains current server labels and appends new sessions', () => {
  const tabs = [{ name: 'a', label: '最新中文' }, { name: 'new' }, { name: 'b' }];
  const sorted = restoreTabOrder(tabs, ['closed', 'b', 'a']);
  assert.deepEqual(sorted.map(tab => tab.name), ['b', 'a', 'new']);
  assert.equal(sorted[1], tabs[0]);
});
