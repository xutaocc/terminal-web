import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeOsc52, forceSelectKey, shouldHintDrag, takeHintTurn } from '../web/terminal-copy.js';

test('the select modifier follows the platform', () => {
  assert.equal(forceSelectKey(true), '⌥ Option');
  assert.equal(forceSelectKey(false), 'Shift');
});

test('only a real, unmodified drag that selected nothing earns the hint', () => {
  const base = { dx: 40, dy: 0, modifier: false, selected: false, mouseTracking: true };
  assert.equal(shouldHintDrag(base), true);
  assert.equal(shouldHintDrag({ ...base, dx: 3 }), false);           // a click
  assert.equal(shouldHintDrag({ ...base, modifier: true }), false);   // Shift held
  assert.equal(shouldHintDrag({ ...base, selected: true }), false);   // it worked
  assert.equal(shouldHintDrag({ ...base, mouseTracking: false }), false); // no one took the mouse
});

test('the hint is rationed per device', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  assert.deepEqual([1, 2, 3, 4, 5].map(() => takeHintTurn(storage)), [true, true, true, false, false]);
});

test('OSC 52 writes decode to text; queries and junk do not', () => {
  const b64 = Buffer.from('复制 me\nline 2', 'utf8').toString('base64');
  assert.equal(decodeOsc52(`c;${b64}`), '复制 me\nline 2');
  assert.equal(decodeOsc52(`;${b64}`), '复制 me\nline 2');
  assert.equal(decodeOsc52('c;?'), null);
  assert.equal(decodeOsc52('c;'), null);
  assert.equal(decodeOsc52('no-separator'), null);
  assert.equal(decodeOsc52('c;not base64!'), null);
});
