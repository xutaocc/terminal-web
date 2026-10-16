import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupByDirectory, groupByProject, projectKeyOf, shortCwd } from '../web/project-groups.js';

const projects = [
  { path: '/work/app', name: 'app' },
  { path: '/work/app/packages/ui', name: 'ui' },
  { path: '/srv', name: 'srv' },
];

test('a directory belongs to the deepest project containing it', () => {
  assert.equal(projectKeyOf('/work/app', projects), '/work/app');
  assert.equal(projectKeyOf('/work/app/src', projects), '/work/app');
  assert.equal(projectKeyOf('/work/app/packages/ui/src', projects), '/work/app/packages/ui');
  assert.equal(projectKeyOf('/work/application', projects), '');
  assert.equal(projectKeyOf(null, projects), '');
  assert.equal(projectKeyOf('/anything', [{ path: '/', name: 'root' }]), '/');
});

test('groups keep project order, include empty projects and end with the unclaimed', () => {
  const sessions = [
    { name: 'a', cwd: '/srv/x' },
    { name: 'b', cwd: '/tmp' },
    { name: 'c', cwd: '/work/app' },
    { name: 'd', cwd: '/srv' },
  ];
  const groups = groupByProject(sessions, s => s.cwd, projects);
  assert.deepEqual(groups.map(g => [g.key, g.items.map(s => s.name)]), [
    ['/work/app', ['c']],
    ['/work/app/packages/ui', []],
    ['/srv', ['a', 'd']],
    ['', ['b']],
  ]);
  assert.equal(groupByProject([{ cwd: '/srv' }], s => s.cwd, projects).at(-1)?.key, '/srv');
});

test('card subtitles are relative to the project, else to home', () => {
  assert.equal(shortCwd('/work/app', '/work/app', '/home/me'), 'app');
  assert.equal(shortCwd('/work/app/src/lib', '/work/app', '/home/me'), './src/lib');
  assert.equal(shortCwd('/home/me/notes', '', '/home/me'), '~/notes');
  assert.equal(shortCwd('/tmp', '', '/home/me'), '/tmp');
  assert.equal(shortCwd(null, '', '/home/me'), '');
});

test('sessions sharing a directory share a card, in order of first appearance', () => {
  const items = [{ n: 'a', cwd: '/p' }, { n: 'b', cwd: '/p/src' }, { n: 'c', cwd: '/p' }, { n: 'd', cwd: null }];
  assert.deepEqual(groupByDirectory(items, i => i.cwd).map(g => [g.cwd, g.items.map(i => i.n)]), [
    ['/p', ['a', 'c']],
    ['/p/src', ['b']],
    ['', ['d']],
  ]);
});
