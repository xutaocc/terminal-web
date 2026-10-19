import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanColor, cleanLabel, cleanNote, LABEL_COLORS, LABEL_MAX, sameLabel } from '../src/remotes.js';

test('a tag is at most six characters, Chinese counted as one each', () => {
  assert.equal(LABEL_MAX, 6);
  assert.equal(cleanLabel('  119桌面  '), '119桌面');
  assert.equal(cleanLabel('远航交通项目集合'), '远航交通项目');
  assert.equal(cleanLabel('abcdefgh'), 'abcdef');
  assert.equal(cleanLabel('   '), null);
  assert.equal(cleanLabel(42), null);
});

test('tags compare without case or surrounding space', () => {
  assert.equal(sameLabel('Mac', ' mac '), true);
  assert.equal(sameLabel('mac', 'mac1'), false);
});

test('six distinct colours; anything else is refused', () => {
  assert.equal(new Set(LABEL_COLORS).size, 6);
  assert.equal(cleanColor('blue'), 'blue');
  assert.equal(cleanColor('pink'), undefined);
});

test('a note keeps its text, trimmed and capped', () => {
  assert.equal(cleanNote('  公司测试机\t'), '公司测试机');
  assert.equal(cleanNote('x'.repeat(300)).length, 200);
  assert.equal(cleanNote(null), '');
});
