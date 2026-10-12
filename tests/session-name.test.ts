import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newSessionName } from '../web/session-name.js';

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
