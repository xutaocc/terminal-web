import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePins } from '../web/pin-order.js';

const order = ['', 'h1', 'w2'];

test('the same answers in any order give the same pinned list', () => {
  // Each server's answer, applied in two different arrival orders.
  const replies: [string, string[]][] = [['', ['a1', 'a2']], ['h1', ['b1', 'b2']], ['w2', ['c1']]];
  const apply = (seq: [string, string[]][]): string[] =>
    seq.reduce<string[]>((pins, [host, list]) => mergePins(pins, host, list, order), []);
  const forward = apply(replies);
  const backward = apply([...replies].reverse());
  assert.deepEqual(forward, backward);
  assert.deepEqual(forward, ['a1', 'a2', '@h1/b1', '@h1/b2', '@w2/c1']);
});

test('re-syncing one server does not move another server’s pins', () => {
  let pins = mergePins([], 'h1', ['b1'], order);
  pins = mergePins(pins, '', ['a1'], order);
  // h1 answers again, possibly after '' did: still the same place.
  pins = mergePins(pins, 'h1', ['b1'], order);
  assert.deepEqual(pins, ['a1', '@h1/b1']);
});

test('a server dropped from the sidebar order still has its pins, after the ordered ones', () => {
  const pins = mergePins(['@gone/x', 'a1'], '', ['a1'], ['', 'h1']);
  assert.deepEqual(pins, ['a1', '@gone/x']);
});

test('clearing one server’s pins leaves the others', () => {
  const pins = mergePins(['a1', '@h1/b1'], 'h1', [], order);
  assert.deepEqual(pins, ['a1']);
});
