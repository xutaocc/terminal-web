import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindTabContext } from '../web/tab-context.js';

function setup() {
  const element = Object.assign(new EventTarget(), { isConnected: true }) as HTMLElement;
  const scroller = Object.assign(new EventTarget(), { scrollLeft: 0, scrollTop: 0 }) as HTMLElement;
  const opened: number[][] = [];
  bindTabContext(element, (x, y) => opened.push([x, y]), scroller);
  const emit = (type: string, extra = {}) => {
    const e = Object.assign(new Event(type, { cancelable: true }), {
      isPrimary: true, button: 0, pointerId: 1, pointerType: 'touch',
      clientX: 25, clientY: 30, ...extra,
    });
    element.dispatchEvent(e);
    return e;
  };
  return { element, scroller, opened, emit };
}

test('right-click opens once and prevents the native menu', () => {
  const s = setup();
  assert.equal(s.emit('contextmenu').defaultPrevented, true);
  assert.deepEqual(s.opened, [[25, 30]]);
});

test('stationary hold opens after 550ms and consumes release', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  s.emit('pointerdown'); t.mock.timers.tick(549);
  assert.equal(s.opened.length, 0);
  t.mock.timers.tick(1);
  assert.equal(s.opened.length, 1);
  assert.equal(s.emit('pointerup').defaultPrevented, true);
  assert.equal(s.emit('touchend').defaultPrevented, true);
  s.emit('contextmenu');
  assert.equal(s.opened.length, 1, 'native long-press must not reopen the menu');
});

test('tap, swipe, scrolling, cancellation and mouse holds do not open', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['tap', 'swipe', 'scroll', 'cancel', 'mouse', 'secondary', 'removed']) {
    const s = setup();
    s.emit('pointerdown', action === 'mouse' ? { pointerType: 'mouse' } :
      action === 'secondary' ? { isPrimary: false } : {});
    if (action === 'tap') s.emit('pointerup');
    if (action === 'swipe') { s.emit('pointermove', { clientX: 60 }); s.emit('pointermove'); }
    if (action === 'scroll') s.scroller.dispatchEvent(new Event('scroll'));
    if (action === 'cancel') s.emit('pointercancel');
    if (action === 'removed') Object.assign(s.element, { isConnected: false });
    t.mock.timers.tick(600);
    assert.equal(s.opened.length, 0, action);
  }
});

test('a new normal tap after a hold is not consumed', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup();
  s.emit('pointerdown'); t.mock.timers.tick(550); s.emit('pointerup');
  s.emit('pointerdown');
  assert.equal(s.emit('pointerup').defaultPrevented, false);
});
