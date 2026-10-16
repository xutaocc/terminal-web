import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupByDirectory, groupByFolder, orderCards, reorderCards, shortCwd, wouldEmpty } from '../web/project-groups.js';

const folders = [{ id: 'f1', name: 'Alpha' }, { id: 'f2', name: 'Beta' }];

test('sessions go where the user put them, not where they are working', () => {
  const sessions = [
    { name: 'a', cwd: '/work/x' },
    { name: 'b', cwd: '/work/x' },
    { name: 'c', cwd: '/tmp' },
    { name: 'd', cwd: '/work/x' },
  ];
  const members = { a: 'f2', b: 'f1', d: 'f2' };
  const groups = groupByFolder(sessions, s => s.name, folders, members);
  assert.deepEqual(groups.map(g => [g.key, g.items.map(s => s.name)]), [
    ['f1', ['b']],
    ['f2', ['a', 'd']],
    ['', ['c']],
  ]);
});

test('the same directory can sit in two folders', () => {
  const sessions = [{ name: 'a', cwd: '/p' }, { name: 'b', cwd: '/p' }];
  const groups = groupByFolder(sessions, s => s.name, folders, { a: 'f1', b: 'f2' });
  assert.deepEqual(groups.map(g => g.items.map(s => s.cwd)), [['/p'], ['/p']]);
});

test('no loose group when every session has a folder; unknown folders count as none', () => {
  assert.equal(groupByFolder([{ name: 'a' }], s => s.name, folders, { a: 'f1' }).at(-1)?.key, 'f2');
  assert.equal(groupByFolder([{ name: 'a' }], s => s.name, folders, { a: 'gone' }).at(-1)?.key, '');
});

test('moving the last sessions out empties a folder', () => {
  const members = { a: 'f1', b: 'f1', c: 'f2' };
  assert.equal(wouldEmpty('f1', ['a'], members), false);
  assert.equal(wouldEmpty('f1', ['a', 'b'], members), true);
  assert.equal(wouldEmpty('f2', ['c'], members), true);
  assert.equal(wouldEmpty('', ['a'], members), false);
});

test('card subtitles abbreviate home', () => {
  assert.equal(shortCwd('/home/me/notes', '/home/me'), '~/notes');
  assert.equal(shortCwd('/home/menu', '/home/me'), '/home/menu');
  assert.equal(shortCwd('/tmp', '/home/me'), '/tmp');
  assert.equal(shortCwd(null, '/home/me'), '');
});

test('sessions sharing a directory share a card, in order of first appearance', () => {
  const items = [{ n: 'a', cwd: '/p' }, { n: 'b', cwd: '/p/src' }, { n: 'c', cwd: '/p' }, { n: 'd', cwd: null }];
  assert.deepEqual(groupByDirectory(items, i => i.cwd).map(g => [g.cwd, g.items.map(i => i.n)]), [
    ['/p', ['a', 'c']],
    ['/p/src', ['b']],
    ['', ['d']],
  ]);
});

test('cards follow the saved order; unmentioned cards keep their place after', () => {
  const cards = ['/a', '/b', '/c', '/d'].map(cwd => ({ cwd }));
  assert.deepEqual(orderCards(cards, undefined).map(c => c.cwd), ['/a', '/b', '/c', '/d']);
  assert.deepEqual(orderCards(cards, ['/c', '/a']).map(c => c.cwd), ['/c', '/a', '/b', '/d']);
  assert.deepEqual(orderCards(cards, ['/gone', '/d']).map(c => c.cwd), ['/d', '/a', '/b', '/c']);
});

test('dropping a card before or after another reorders around it', () => {
  const order = ['/a', '/b', '/c', '/d'];
  assert.deepEqual(reorderCards(order, '/d', '/a', false), ['/d', '/a', '/b', '/c']);
  assert.deepEqual(reorderCards(order, '/a', '/c', true), ['/b', '/c', '/a', '/d']);
  assert.deepEqual(reorderCards(order, '/b', '/b', true), order);
  assert.deepEqual(reorderCards(order, '/x', '/b', false), ['/a', '/x', '/b', '/c', '/d']);
  assert.deepEqual(order, ['/a', '/b', '/c', '/d']);
});
