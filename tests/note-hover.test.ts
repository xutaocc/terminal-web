import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NoteHover } from '../web/note-hover.js';

test('passing briefly over a tab never opens notes', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 0;
  const hover = new NoteHover(() => { count++; return true; });
  hover.enter(); t.mock.timers.tick(200); hover.leave(); t.mock.timers.tick(1000);
  assert.equal(count, 0);
});

test('leaving never closes or reopens an editor until explicit close', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let count = 0;
  const hover = new NoteHover(() => { count++; return true; });
  hover.enter(); t.mock.timers.tick(450);
  hover.leave(); t.mock.timers.tick(5000); hover.enter(); t.mock.timers.tick(1000);
  assert.equal(count, 1);
  hover.reset(); hover.enter(); t.mock.timers.tick(450);
  assert.equal(count, 2);
});
