import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasWheelInput, isKeyboardInput } from '../src/history-input.js';

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
