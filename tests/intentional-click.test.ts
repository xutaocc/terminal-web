import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindIntentionalClick } from '../web/intentional-click.js';

function setup() {
  const button = new EventTarget() as HTMLElement;
  const scroller = Object.assign(new EventTarget(), { scrollLeft: 0, scrollTop: 0 }) as HTMLElement;
  let calls = 0;
  bindIntentionalClick(button, () => { calls++; }, scroller);
  const emit = (type: string, extra = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerId: 1, isPrimary: true, button: 0, clientX: 20, clientY: 20, ...extra,
    });
    button.dispatchEvent(event);
    return event;
  };
  return { emit, scroller, calls: () => calls };
}

test('press and release do not act until the actual click', () => {
  const s = setup();
  s.emit('pointerdown'); s.emit('pointerup');
  assert.equal(s.calls(), 0);
  s.emit('click');
  assert.equal(s.calls(), 1);
});

test('a swipe returning to its starting point still cannot activate', () => {
  const s = setup();
  s.emit('pointerdown'); s.emit('pointermove', { clientY: 70 });
  s.emit('pointermove'); s.emit('pointerup');
  assert.equal(s.emit('click').defaultPrevented, true);
  assert.equal(s.calls(), 0);
});

test('scrolling, including scrolling back, invalidates the click', () => {
  const s = setup();
  s.emit('pointerdown');
  s.scroller.scrollTop = 30; s.scroller.dispatchEvent(new Event('scroll'));
  s.scroller.scrollTop = 0;
  s.emit('pointerup'); s.emit('click');
  assert.equal(s.calls(), 0);
});

test('cancelled or multi-touch gestures cannot open dialogs', () => {
  for (const extraTouch of [false, true]) {
    const s = setup(); s.emit('pointerdown');
    if (extraTouch) s.emit('pointerdown', { pointerId: 2, isPrimary: false });
    else s.emit('pointercancel');
    s.emit('pointerup'); s.emit('click');
    assert.equal(s.calls(), 0);
  }
});

test('large release displacement is rejected even without move events', () => {
  const s = setup();
  s.emit('pointerdown'); s.emit('pointerup', { clientY: 90 }); s.emit('click');
  assert.equal(s.calls(), 0);
});

test('a fresh tap works after a cancelled swipe', () => {
  const s = setup();
  s.emit('pointerdown'); s.emit('pointercancel'); s.emit('click');
  s.emit('pointerdown'); s.emit('pointerup', { clientY: 23 }); s.emit('click');
  assert.equal(s.calls(), 1);
});

test('keyboard and accessibility clicks work without pointer gestures', () => {
  const s = setup();
  s.emit('click');
  s.emit('pointerdown'); s.emit('pointercancel');
  s.emit('keydown', { key: 'Enter' }); s.emit('click');
  assert.equal(s.calls(), 2);
});
