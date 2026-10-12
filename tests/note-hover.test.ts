import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NoteHover } from '../web/note-hover.js';

test('briefly passing over a tab never opens its notes', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let opened = 0;
  const hover = new NoteHover(() => { opened++; return true; }, () => true);
  hover.enter(); t.mock.timers.tick(200); hover.leave(); t.mock.timers.tick(500);
  assert.equal(opened, 0);
});

test('moving from tab to popup keeps it open without fetching again', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let opened = 0;
  let closed = 0;
  const hover = new NoteHover(() => { opened++; return true; }, () => { closed++; return true; });
  hover.enter(); t.mock.timers.tick(450);
  hover.leave(); t.mock.timers.tick(100); hover.enter(); t.mock.timers.tick(1000);
  assert.equal(opened, 1);
  assert.equal(closed, 0);
  hover.leave(); t.mock.timers.tick(299);
  assert.equal(closed, 0);
  t.mock.timers.tick(1);
  assert.equal(closed, 1);
});

test('an editor with unsaved changes or focus can refuse automatic dismissal', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let protectedEditor = true;
  let closed = 0;
  const hover = new NoteHover(() => true, () => {
    if (protectedEditor) return false;
    closed++; return true;
  });
  hover.enter(); t.mock.timers.tick(450); hover.leave(); t.mock.timers.tick(300);
  assert.equal(closed, 0);
  protectedEditor = false;
  hover.enter(); hover.leave(); t.mock.timers.tick(300);
  assert.equal(closed, 1);
});

test('closing the editor clears pending dismissal before another editor opens', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let closed = 0;
  const hover = new NoteHover(() => true, () => { closed++; return true; });
  hover.enter(); t.mock.timers.tick(450); hover.leave(); hover.reset();
  t.mock.timers.tick(500);
  assert.equal(closed, 0);
});
