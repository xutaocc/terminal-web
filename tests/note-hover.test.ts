import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NoteHover, NoteDismiss } from '../web/note-hover.js';

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

test('crossing the popup gap and reentering cancels dismissal', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let closes = 0;
  const dismiss = new NoteDismiss(() => { closes++; });
  dismiss.leave(); t.mock.timers.tick(650);
  assert.equal(closes, 0);
  dismiss.enter(); t.mock.timers.tick(1000);
  assert.equal(closes, 0);
  dismiss.leave(); t.mock.timers.tick(700);
  assert.equal(closes, 1);
});

test('pointer movement outside does not keep postponing dismissal', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let closes = 0;
  const dismiss = new NoteDismiss(() => { closes++; });
  dismiss.leave(); t.mock.timers.tick(400); dismiss.leave(); t.mock.timers.tick(300);
  assert.equal(closes, 1);
});

test('starting editing cancels pending dismissal and stays pinned across IME focus changes', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let closes = 0;
  const dismiss = new NoteDismiss(() => { closes++; });
  dismiss.leave(); t.mock.timers.tick(650); dismiss.edit();
  dismiss.leave(); t.mock.timers.tick(5000);
  dismiss.enter(); dismiss.leave(); t.mock.timers.tick(5000);
  assert.equal(closes, 0);
});

test('disposing the editor cancels pending dismissal', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let closes = 0;
  const dismiss = new NoteDismiss(() => { closes++; });
  dismiss.leave(); dismiss.dispose(); t.mock.timers.tick(1000);
  assert.equal(closes, 0);
});
