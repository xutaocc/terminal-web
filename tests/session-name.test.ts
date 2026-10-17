import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nameStart, newSessionName, newSessionId, sessionIdPrefix, stripTimestamps } from '../web/session-name.js';

const now = new Date(2026, 9, 12, 2, 6);
test('the time goes first, the real name after it', () => {
  assert.equal(newSessionName('macpro-tel', [], now), '10120206-macpro-tel');
  assert.equal(newSessionName('前端开发', [], now), '10120206-前端开发');
});

test('old timestamps are dropped, wherever they were', () => {
  // The old style: stamp at the end — the case in the screenshot.
  assert.equal(newSessionName('macpro-tel-c-10151422', [], now), '10120206-macpro-tel-c');
  // The new style: stamp at the front, from a tab already made this way.
  assert.equal(newSessionName('10151422-macpro-tel', [], now), '10120206-macpro-tel');
  // Copied more than once, old and new mixed, with same-minute counters.
  assert.equal(newSessionName('10161729-交工-视频没有开启-10161527-2', [], now), '10120206-交工-视频没有开启');
  assert.equal(newSessionName('远航交通项目集合-数据清理 2-10161527-10161807', [], now),
    '10120206-远航交通项目集合-数据清理 2');
});

test('numbers that only look like a time stay part of the name', () => {
  assert.equal(stripTimestamps('交工-成本智能管控-熟悉V3-10151935'), '交工-成本智能管控-熟悉V3');
  assert.equal(stripTimestamps('report-2026'), 'report-2026');          // a year, 4 digits
  assert.equal(stripTimestamps('build-13010000'), 'build-13010000');      // month 13
  assert.equal(stripTimestamps('job-10322500'), 'job-10322500');          // day 32
  assert.equal(stripTimestamps('ticket-123456789'), 'ticket-123456789');  // 9 digits
  assert.equal(stripTimestamps('abc10151422'), 'abc10151422');            // not on its own
  assert.equal(stripTimestamps('ruoyigo001'), 'ruoyigo001');
});

test('a name with no timestamp is kept as it is', () => {
  assert.equal(newSessionName('aTempKong', [], now), '10120206-aTempKong');
});

test('a base that was only a timestamp gives the time alone', () => {
  assert.equal(newSessionName('10151422', [], now), '10120206');
  assert.equal(newSessionName('', [], now), '10120206');
});

test('same-minute names count on from the time, leaving the name alone', () => {
  assert.equal(newSessionName('macpro', ['10120206-macpro'], now), '10120206-2-macpro');
  assert.equal(newSessionName('macpro', ['10120206-macpro', '10120206-2-macpro'], now), '10120206-3-macpro');
  // ... and a new tab from one of those still reads its real name.
  assert.equal(newSessionName('10120206-2-macpro', [], new Date(2026, 9, 12, 3, 0)), '10120300-macpro');
});

test('long names keep the whole timestamp, within the label limit', () => {
  const name = newSessionName('a'.repeat(80), [], now);
  assert.equal(name.length, 64);
  assert.ok(name.startsWith('10120206-'));
});

test('the real name starts after the timestamp, for selecting it', () => {
  assert.equal(nameStart('10120206-macpro-tel'), 9);
  assert.equal(nameStart('10120206-2-macpro'), 11);
  assert.equal(nameStart('10120206'), 0);
  assert.equal(nameStart('macpro'), 0);
});

test('internal IDs come from the real name, not the label timestamp', async () => {
  assert.match(await newSessionId('10120206-macpro-tel', [], now), /^macpro-tel-20261012020600000-[0-9a-f]{12}$/);
});

test('internal IDs use unaccented pinyin while preserving Latin and numbers', async () => {
  const id = await newSessionId('前端开发-test2', [], now);
  assert.match(id, /^qianduankaifa-test2-20261012020600000-[0-9a-f]{12}$/);
  assert.equal(await sessionIdPrefix('绿茶'), 'lvcha');
});
test('conversion failures, unresolved Han and unusable names use the default base', async () => {
  assert.equal(await sessionIdPrefix('中文', () => { throw new Error('dictionary unavailable'); }), 'web');
  assert.equal(await sessionIdPrefix('中文', () => 'zhong文'), 'web');
  assert.match(await newSessionId('🚀', [], now), /^web-20261012020600000-[0-9a-f]{12}$/);
});
test('English IDs also carry time and random entropy across same-time creations', async () => {
  const first = await newSessionId('work', [], now);
  const second = await newSessionId('work', [], now);
  assert.match(first, /^work-20261012020600000-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});
test('long internal IDs reserve room for split sessions without truncating uniqueness', async () => {
  const id = await newSessionId('长'.repeat(64), [], now);
  assert.equal(id.length, 61);
  assert.equal((id + '__b').length, 64);
  assert.match(id, /^[A-Za-z0-9_-]+-20261012020600000-[0-9a-f]{12}$/);
});
test('a timestamp and entropy collision still creates a distinct bounded ID', async t => {
  t.mock.method(crypto, 'getRandomValues', (bytes: Uint8Array) => bytes.fill(0));
  const first = await newSessionId('长'.repeat(64), [], now);
  const second = await newSessionId('长'.repeat(64), [first], now);
  assert.notEqual(first, second);
  assert.equal(second.length, 61);
  assert.ok(second.endsWith('-000000000000-2'));
});
