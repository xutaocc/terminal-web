import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baseName, childPath, crumbs, isAbsolutePath, isRoot, isWithin, normalizePath, parentPath, rootOf, samePath, segments,
} from '../web/file-path.js';

test('breadcrumbs split Windows paths into clickable segments', () => {
  assert.deepEqual(crumbs('C:\\Users\\Administrator\\Desktop'), [
    { label: 'C:\\', path: 'C:\\' },
    { label: 'Users', path: 'C:\\Users' },
    { label: 'Administrator', path: 'C:\\Users\\Administrator' },
    { label: 'Desktop', path: 'C:\\Users\\Administrator\\Desktop' },
  ]);
  assert.deepEqual(crumbs('C:\\'), [{ label: 'C:\\', path: 'C:\\' }]);
});

test('breadcrumbs for Unix paths are unchanged', () => {
  assert.deepEqual(crumbs('/home/x'), [
    { label: '/', path: '/' }, { label: 'home', path: '/home' }, { label: 'x', path: '/home/x' },
  ]);
  assert.deepEqual(crumbs('/'), [{ label: '/', path: '/' }]);
});

test('parent stops at the root, never above it', () => {
  assert.equal(parentPath('C:\\Users\\Administrator'), 'C:\\Users');
  assert.equal(parentPath('C:\\Users'), 'C:\\');
  assert.equal(parentPath('C:\\'), 'C:\\');
  assert.equal(parentPath('/home/x'), '/home');
  assert.equal(parentPath('/home'), '/');
  assert.equal(parentPath('/'), '/');
});

test('child paths use the path\'s own separator', () => {
  assert.equal(childPath('C:\\Users', 'a.txt'), 'C:\\Users\\a.txt');
  assert.equal(childPath('C:\\', 'Users'), 'C:\\Users');
  assert.equal(childPath('/home', 'x'), '/home/x');
  assert.equal(childPath('/', 'home'), '/home');
});

test('names, roots and absolute checks', () => {
  assert.equal(baseName('C:\\Users\\a.txt'), 'a.txt');
  assert.equal(baseName('/home/a.txt'), 'a.txt');
  assert.equal(baseName('C:\\'), 'C:\\');
  assert.equal(rootOf('D:\\x'), 'D:\\');
  assert.equal(isRoot('C:\\'), true);
  assert.equal(isRoot('/'), true);
  assert.equal(isRoot('C:\\x'), false);
  for (const ok of ['/x', 'C:\\x', 'c:/x', 'D:\\']) assert.equal(isAbsolutePath(ok), true, ok);
  for (const bad of ['x', '.\\x', '', 'C:x', '\\x']) assert.equal(isAbsolutePath(bad), false, bad);
});

test('typed Windows paths are normalised: forward slashes, drive case, doubles', () => {
  assert.equal(normalizePath('c:/Users//Administrator/'), 'C:\\Users\\Administrator');
  assert.equal(normalizePath('C:'), 'C:\\');
  assert.equal(normalizePath('/home//x/'), '/home/x');
});

test('containment: case-insensitive on Windows, never a mere prefix', () => {
  assert.equal(isWithin('C:\\Users\\a', 'C:\\Users'), true);
  assert.equal(isWithin('c:\\users\\A', 'C:\\Users'), true);
  assert.equal(isWithin('C:\\Users2', 'C:\\Users'), false);
  assert.equal(isWithin('C:\\anything', 'C:\\'), true);
  assert.equal(isWithin('D:\\x', 'C:\\'), false);
  assert.equal(isWithin('/home/x', '/home'), true);
  assert.equal(isWithin('/home2', '/home'), false);
  assert.equal(isWithin('/Home/x', '/home'), false);
  assert.equal(isWithin('/x', 'C:\\'), false);
  assert.equal(samePath('C:\\Users', 'c:/users/'), true);
});

test('segments below the root, for hidden-entry checks', () => {
  assert.deepEqual(segments('C:\\Users\\.cache\\x'), ['Users', '.cache', 'x']);
  assert.deepEqual(segments('/home/.cache'), ['home', '.cache']);
  assert.deepEqual(segments('C:\\'), []);
});
