import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PinchZoom, WheelZoom, zoomKey } from '../web/font-zoom.js';

const key = (k: string, code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }>) =>
  ({ key: k, code, ctrlKey: false, metaKey: false, altKey: false, ...mods });

test('⌘ on a Mac and Ctrl elsewhere zoom with = + and −; 0 is left to the browser', () => {
  assert.equal(zoomKey(key('=', 'Equal', { metaKey: true }), true), 1);
  assert.equal(zoomKey(key('+', 'Equal', { metaKey: true }), true), 1);
  assert.equal(zoomKey(key('-', 'Minus', { metaKey: true }), true), -1);
  assert.equal(zoomKey(key('=', 'Equal', { ctrlKey: true }), false), 1);
  assert.equal(zoomKey(key('-', 'NumpadSubtract', { ctrlKey: true }), false), -1);
  assert.equal(zoomKey(key('0', 'Digit0', { metaKey: true }), true), null);
  assert.equal(zoomKey(key('0', 'Digit0', { ctrlKey: true }), false), null);
});

test('the terminal keeps its own chords: Ctrl on a Mac, ⌘ elsewhere, Alt, plain keys', () => {
  assert.equal(zoomKey(key('=', 'Equal', { ctrlKey: true }), true), null);
  assert.equal(zoomKey(key('-', 'Minus', { metaKey: true }), false), null);
  assert.equal(zoomKey(key('=', 'Equal', { ctrlKey: true, altKey: true }), false), null);
  assert.equal(zoomKey(key('=', 'Equal', {}), false), null);
  assert.equal(zoomKey(key('c', 'KeyC', { ctrlKey: true }), false), null);
});

test('a mouse notch is one step; a trackpad pinch adds up slowly', () => {
  const wheel = new WheelZoom();
  assert.equal(wheel.feed(-100, 0, 0), 1); // wheel up: bigger
  assert.equal(wheel.feed(100, 0, 1000), -1);
  const pinch = new WheelZoom();
  let steps = 0;
  for (let i = 0; i < 10; i++) steps += pinch.feed(-5, 0, 2000 + i * 16);
  assert.equal(steps, 0); // 50 px of pinch: not yet a step
  for (let i = 0; i < 10; i++) steps += pinch.feed(-5, 0, 2200 + i * 16);
  assert.equal(steps, 1);
});

test('a pinch moves one step per 15% change in finger distance', () => {
  const pinch = new PinchZoom();
  pinch.start(100);
  assert.equal(pinch.move(110), 0);
  assert.equal(pinch.move(116), 1);
  assert.equal(pinch.move(120), 0); // counted from where the last step was taken
  assert.equal(pinch.move(70), -3); // 115 -> 70 is three 15% steps down
  pinch.end();
  assert.equal(pinch.active, false);
  assert.equal(pinch.move(200), 0);
});
