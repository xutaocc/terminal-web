import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasWheelInput, isKeyboardInput, HistoryInputCheck } from '../src/history-input.js';

test('printable typing reuses a check for at most 250ms, without extending expiry', () => {
  const check = new HistoryInputCheck();
  assert.equal(check.allows('a', 1, 10), false);
  check.checked(1, 20);
  for (const now of [21, 50, 100, 200, 269]) {
    assert.equal(check.allows('中文abc', 1, now), true);
  }
  assert.equal(check.allows('a', 1, 270), false);
});

test('scrolling, control transfer and a stale completed check cannot reuse cached state', () => {
  const check = new HistoryInputCheck();
  check.checked(1, 20);
  assert.equal(check.allows('a', 2, 21), false);
  check.checked(1, 22); // old async check finished after scrolling started
  assert.equal(check.allows('a', 2, 23), false);
  check.checked(2, 24);
  check.invalidate();
  assert.equal(check.allows('a', 2, 25), false);
});

test('mux prefix, paste delimiters and mouse reports never use the fast path', () => {
  const check = new HistoryInputCheck();
  check.checked(1, 20);
  for (const input of ['', '\x02[', '\x03', '\x1b',
    '\x1b[200~hello\x1b[201~', '\x1b[<64;2;3M']) {
    assert.equal(check.allows(input, 1, 21), false, JSON.stringify(input));
  }
});

test('mouse events and terminal replies preserve browsing mode', () => {
  for (const input of ['\x1b[<64;2;3M'.repeat(4), '\x1b[<65;2;3M',
    '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[5;10R',
    '\x1b]11;rgb:ffff/ffff/ffff\x1b\\', '\x1b[I']) {
    assert.equal(isKeyboardInput(input), false, JSON.stringify(input));
  }
});

test('commands, Chinese input, paste and special keys leave browsing mode', () => {
  for (const input of ['ls\r', '中文', '\x1b', '\x7f', '\x1b[A',
    '\x1b[200~echo hello\x1b[201~', '\x1b[?1;2cls']) {
    assert.equal(isKeyboardInput(input), true, JSON.stringify(input));
  }
});

test('wheel reports are told apart from other mouse input', () => {
  assert.equal(hasWheelInput('\x1b[<64;10;5M'), true);
  assert.equal(hasWheelInput('\x1b[<65;10;5M\x1b[<65;10;5M'), true);
  assert.equal(hasWheelInput('\x1b[<0;10;5M'), false, 'a click');
  assert.equal(hasWheelInput('\x1b[<32;10;5M'), false, 'a drag');
  assert.equal(hasWheelInput('ls\r'), false);
});


test('editing and submission reuse a recent check without sliding expiry', () => {
  const check = new HistoryInputCheck();
  check.checked(1, 20);
  for (const key of ['\r', '\x7f', '\x08', '\x1b[A', '\x1bOD', 'echo hi\r']) {
    assert.equal(check.allows(key, 1, 269), true);
    assert.equal(check.allows(key, 1, 270), false);
    assert.equal(check.allows(key, 2, 21), false);
  }
});
