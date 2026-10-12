import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newSessionName, newSessionId, sessionIdPrefix } from '../web/session-name.js';

const now = new Date(2026, 9, 12, 2, 6);
test('new names use the base and local month/day/hour/minute', () => {
  assert.equal(newSessionName('macpro-tel', [], now), 'macpro-tel-10120206');
});
test('same-minute collisions keep distinct sessions', () => {
  assert.equal(newSessionName('macpro', ['macpro-10120206', 'macpro-10120206-2'], now),
    'macpro-10120206-3');
});
test('long base names retain the complete timestamp within the name limit', () => {
  const name = newSessionName('a'.repeat(64), [], now);
  assert.equal(name.length, 64);
  assert.ok(name.endsWith('-10120206'));
  const next = newSessionName('a'.repeat(64), [name], now);
  assert.equal(next.length, 64);
  assert.ok(next.endsWith('-10120206-2'));
});

test('Chinese display names remain intact in default label suggestions', () => {
  assert.equal(newSessionName('前端开发', [], now), '前端开发-10120206');
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
