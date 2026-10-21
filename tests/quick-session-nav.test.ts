import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuickSessionNavigator, type QuickSessionEntry } from '../web/quick-session-nav.js';
const entry = (name: string, kind: QuickSessionEntry['kind'] = 'unread'): QuickSessionEntry => ({ name, kind });

test('cycles across local and multiple remotes in supplied sidebar order', () => {
  const nav = new QuickSessionNavigator();
  const entries = [entry('@two/pinned'), entry('local'), entry('@one/task')];
  assert.deepEqual(Array.from({ length: 4 }, () => nav.next('unread', entries)), ['@two/pinned', 'local', '@one/task', '@two/pinned']);
});
test('reading removes a candidate without skipping the following unread session', () => {
  const nav = new QuickSessionNavigator();
  assert.equal(nav.next('unread', [entry('a'), entry('b'), entry('c')]), 'a');
  assert.equal(nav.next('unread', [entry('a', null), entry('b'), entry('c')]), 'b');
  assert.equal(nav.next('unread', [entry('a', null), entry('b', null), entry('c')]), 'c');
  assert.equal(nav.next('unread', [entry('a', null), entry('b', null), entry('c', null)]), null);
});
test('closing the cursor continues at the next surviving candidate', () => {
  const nav = new QuickSessionNavigator();
  assert.equal(nav.next('unread', [entry('a'), entry('b'), entry('c')]), 'a');
  assert.equal(nav.next('unread', [entry('b'), entry('c')]), 'b');
});
test('working and unread maintain independent cursors and skip other states', () => {
  const nav = new QuickSessionNavigator();
  const entries = [entry('a'), entry('b', 'working'), entry('waiting', null), entry('c'), entry('d', 'working')];
  assert.equal(nav.next('unread', entries), 'a');
  assert.equal(nav.next('working', entries), 'b');
  assert.equal(nav.next('unread', entries), 'c');
  assert.equal(nav.next('working', entries), 'd');
});
test('single candidate repeats, empty list is safe, and reordering takes effect', () => {
  const nav = new QuickSessionNavigator();
  assert.equal(nav.next('working', []), null);
  assert.equal(nav.next('working', [entry('a', 'working')]), 'a');
  assert.equal(nav.next('working', [entry('a', 'working')]), 'a');
  assert.equal(nav.next('working', [entry('a', 'working'), entry('c', 'working'), entry('b', 'working')]), 'c');
  assert.equal(nav.next('working', [entry('b', 'working'), entry('c', 'working'), entry('a', 'working')]), 'a');
});
test('new candidates remain reachable when all previous candidates disappear', () => {
  const nav = new QuickSessionNavigator();
  nav.next('unread', [entry('old')]);
  assert.equal(nav.next('unread', [entry('new')]), 'new');
});
