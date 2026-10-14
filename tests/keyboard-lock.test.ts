import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerminalKeyboardLock } from '../web/keyboard-lock.js';

class Textarea extends EventTarget {
  readOnly = false;
  inputMode = 'text';
  focused = false;
  focus(): void {
    if (this.focused) return;
    this.focused = true;
    this.dispatchEvent(new Event('focus'));
  }
  blur(): void {
    if (!this.focused) return;
    this.focused = false;
    this.dispatchEvent(new Event('blur'));
  }
}
function setup(touch = true) {
  const textarea = new Textarea();
  const interactions = new EventTarget();
  const gate = new TerminalKeyboardLock(
    textarea as unknown as HTMLTextAreaElement, touch, () => textarea.focus(),
    interactions,
  );
  return { textarea, gate, interactions };
}

test('an outside tap restores the lock even when dismissing the IME retained focus', () => {
  const { textarea, gate, interactions } = setup();
  gate.setLocked(true);
  gate.open();
  assert.equal(textarea.focused, true);
  interactions.dispatchEvent(new Event('pointerdown'));
  assert.equal(textarea.focused, false);
  assert.equal(textarea.readOnly, true);
  assert.equal(textarea.inputMode, 'none');
  textarea.focus(); // A later xterm tap must not reopen the IME.
  assert.equal(textarea.focused, false);
  gate.open(); // The explicit keyboard button still works.
  assert.equal(textarea.focused, true);
  assert.equal(textarea.readOnly, false);
});

test('outside taps do not restrict unlocked or desktop typing', () => {
  for (const touch of [true, false]) {
    const { textarea, gate, interactions } = setup(touch);
    gate.setLocked(!touch);
    gate.open();
    interactions.dispatchEvent(new Event('pointerdown'));
    assert.equal(textarea.focused, true);
    assert.equal(textarea.readOnly, false);
  }
});

test('default and unchecked states preserve ordinary focus and typing', () => {
  const { textarea, gate } = setup();
  gate.focus();
  assert.equal(textarea.focused, true);
  assert.equal(textarea.readOnly, false);
  assert.equal(textarea.inputMode, 'text');
  gate.setLocked(true);
  gate.setLocked(false);
  gate.focus();
  assert.equal(textarea.focused, true);
  assert.equal(textarea.readOnly, false);
  assert.equal(textarea.inputMode, 'text');
});

test('locking blurs an active terminal and blocks both app and xterm automatic focus', () => {
  const { textarea, gate } = setup();
  textarea.focus();
  gate.setLocked(true);
  assert.equal(textarea.focused, false);
  assert.equal(textarea.readOnly, true);
  assert.equal(textarea.inputMode, 'none');
  gate.focus();
  assert.equal(textarea.focused, false);
  textarea.focus(); // xterm's own mouse handler bypasses Session.focus().
  assert.equal(textarea.focused, false);
});

test('keyboard button opens a writable terminal synchronously', () => {
  const { textarea, gate } = setup();
  gate.setLocked(true);
  gate.open();
  assert.equal(textarea.focused, true);
  assert.equal(textarea.readOnly, false);
  assert.equal(textarea.inputMode, 'text');
});

test('blur revokes permission, so tab/dialog/reconnect focus cannot reopen input', () => {
  const { textarea, gate } = setup();
  gate.setLocked(true);
  gate.open();
  textarea.blur();
  assert.equal(textarea.readOnly, true);
  gate.focus();
  textarea.focus();
  assert.equal(textarea.focused, false);
  gate.open();
  assert.equal(textarea.focused, true);
});

test('button can refocus when the OS dismissed the keyboard but retained textarea focus', () => {
  const { textarea, gate } = setup();
  gate.setLocked(true);
  gate.open();
  gate.open();
  assert.equal(textarea.focused, true);
  assert.equal(textarea.readOnly, false);
});

test('desktop physical-keyboard focus remains normal even when the preference is on', () => {
  const { textarea, gate } = setup(false);
  gate.setLocked(true);
  gate.focus();
  assert.equal(textarea.focused, true);
  assert.equal(textarea.readOnly, false);
  assert.equal(textarea.inputMode, 'text');
});
