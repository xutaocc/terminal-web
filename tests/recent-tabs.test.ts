import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepRecent, RECENT_TABS_MAX, recentStrength, touchRecent } from '../web/recent-tabs.js';

test('the most recent comes first; picking one again moves it up, never doubles it', () => {
  let list: string[] = [];
  for (const n of ['a', 'b', 'c']) list = touchRecent(list, n);
  assert.deepEqual(list, ['c', 'b', 'a']);
  assert.deepEqual(touchRecent(list, 'a'), ['a', 'c', 'b']);
});

test(`at most ${RECENT_TABS_MAX}: the oldest one drops off`, () => {
  assert.equal(RECENT_TABS_MAX, 10);
  let list: string[] = [];
  for (const n of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']) list = touchRecent(list, n);
  assert.deepEqual(list, ['11', '10', '9', '8', '7', '6', '5', '4', '3', '2']);
  assert.deepEqual(touchRecent(['b', 'a'], 'c', 2), ['c', 'b']);
});

test('closed sessions leave the list', () => {
  assert.deepEqual(keepRecent(['a', 'b', 'c'], n => n !== 'b'), ['a', 'c']);
});

test('the underline fades with age: full for the newest, faint for the sixth, none outside', () => {
  const list = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
  assert.equal(recentStrength(list, '1'), 1);
  assert.ok(Math.abs(recentStrength(list, '10') - 0.3) < 1e-9);
  assert.ok(recentStrength(list, '2') > recentStrength(list, '3'));
  assert.equal(recentStrength(list, 'x'), 0);
});
