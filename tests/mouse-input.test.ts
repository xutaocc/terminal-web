import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withoutMouseHover } from '../src/mouse-input.js';

test('drops the reported Windows hover flood, including modifier combinations', () => {
  const flood = Array.from({length: 100}, (_, i) => `\x1b[<35;${i + 1};25M`).join('');
  assert.equal(withoutMouseHover(flood), '');
  for (let modifiers = 0; modifiers <= 28; modifiers += 4) {
    assert.equal(withoutMouseHover(`\x1b[<${35 | modifiers};4;25M`), '');
  }
});

test('preserves clicking, release, dragging and scrolling in a mouse batch', () => {
  const reports = [0, 1, 2, 32, 33, 34, 64, 65, 66, 67, 128].map(code => `\x1b[<${code};4;25M`).join('')
    + '\x1b[<0;4;25m';
  assert.equal(withoutMouseHover('\x1b[<35;1;1M' + reports + '\x1b[<35;2;2M'), reports);
});

test('does not rewrite keyboard input, terminal replies or bracketed paste', () => {
  for (const text of ['中文abc\r', '\x1b[A', '\x1b[?1;2c', '[<35;4;25M',
    '\x1b[200~\x1b[<35;4;25M\x1b[201~', 'echo \x1b[<35;4;25M']) {
    assert.equal(withoutMouseHover(text), text);
  }
});
