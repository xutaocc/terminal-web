import test from 'node:test';
import assert from 'node:assert/strict';
import { homeRelative, lastSegment, platformLabel, quotePathForShell } from '../web/platform.js';

test('a path is quoted for the shell of the server it is typed into', () => {
  // Unix: bash/zsh single quotes, '\'' for a quote inside.
  assert.equal(quotePathForShell('/tmp/a.png', 'linux'), '/tmp/a.png');
  assert.equal(quotePathForShell('/tmp/my file.png', 'darwin'), `'/tmp/my file.png'`);
  assert.equal(quotePathForShell("/tmp/it's.png", 'linux'), `'/tmp/it'\\''s.png'`);
  // Windows: PowerShell single quotes, '' for a quote inside; its specials too.
  assert.equal(quotePathForShell('C:\\Users\\a.png', 'win32'), 'C:\\Users\\a.png');
  assert.equal(quotePathForShell('C:\\My Files\\a.png', 'win32'), `'C:\\My Files\\a.png'`);
  assert.equal(quotePathForShell("C:\\it's.png", 'win32'), `'C:\\it''s.png'`);
  assert.equal(quotePathForShell('C:\\a&b.png', 'win32'), `'C:\\a&b.png'`);
  assert.equal(quotePathForShell('C:\\$x.png', 'win32'), `'C:\\$x.png'`);
  // Unknown platform (an older server that does not say): the Unix rules, as before.
  assert.equal(quotePathForShell('/tmp/my file.png', undefined), `'/tmp/my file.png'`);
});

test('the file name of a Unix or Windows path', () => {
  assert.equal(lastSegment('/home/x/report.zip'), 'report.zip');
  assert.equal(lastSegment('C:\\Users\\x\\report.zip'), 'report.zip');
  assert.equal(lastSegment('report.zip'), 'report.zip');
  assert.equal(lastSegment('sub\\report.zip'), 'report.zip');
});

test('directories under home are shown with ~, in their own separator', () => {
  assert.equal(homeRelative('/home/x/src', '/home/x'), '~/src');
  assert.equal(homeRelative('/home/x', '/home/x'), '~');
  assert.equal(homeRelative('/home/xy', '/home/x'), '/home/xy');
  assert.equal(homeRelative('C:\\Users\\Administrator\\Desktop', 'C:\\Users\\Administrator'), '~\\Desktop');
  assert.equal(homeRelative('c:\\users\\administrator\\Desktop', 'C:\\Users\\Administrator'), '~\\Desktop', 'Windows ignores case');
  assert.equal(homeRelative('C:\\Users\\Administrator', 'C:\\Users\\Administrator'), '~');
  assert.equal(homeRelative('C:\\Users\\Administrator2', 'C:\\Users\\Administrator'), 'C:\\Users\\Administrator2');
  assert.equal(homeRelative('D:\\work', 'C:\\Users\\Administrator'), 'D:\\work');
  assert.equal(homeRelative('/Home/x/src', '/home/x'), '/Home/x/src', 'Unix keeps case');
  assert.equal(homeRelative('', '/home/x'), '');
});

test('platform labels', () => {
  assert.equal(platformLabel('win32'), 'Windows');
  assert.equal(platformLabel('darwin'), 'macOS');
  assert.equal(platformLabel('linux'), 'Linux');
  assert.equal(platformLabel(undefined), '');
});
