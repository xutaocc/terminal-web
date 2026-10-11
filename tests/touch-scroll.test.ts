import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TouchScrollMotion } from '../web/touch-scroll.js';

test('quick drags accelerate while slow drags stay precise', () => {
  const slow = new TouchScrollMotion();
  const fast = new TouchScrollMotion();
  slow.start(0); fast.start(0);
  slow.move(60, 300); fast.move(60, 30);
  assert.equal(slow.frame(300), 3);
  assert.equal(fast.frame(30), 4);
});

test('a fling continues, is bounded, and settles within a second', () => {
  const motion = new TouchScrollMotion();
  motion.start(0); motion.move(45, 30); motion.frame(30); motion.release(30);
  let ticks = 0;
  for (let time = 62; time <= 1000; time += 32) {
    const step = motion.frame(time);
    assert.ok(step >= 0 && step <= 4);
    ticks += step;
  }
  assert.ok(ticks > 0 && ticks < 30);
  assert.equal(motion.active, false);
});

test('new touches and cancellation discard all queued inertia', () => {
  const motion = new TouchScrollMotion();
  motion.start(0); motion.move(100, 20); motion.release(20);
  motion.cancel();
  assert.equal(motion.frame(52), 0);
  assert.equal(motion.active, false);
  motion.move(100, 70); motion.start(80);
  assert.equal(motion.frame(112), 0);
});

test('reversing direction does not fight queued motion', () => {
  const motion = new TouchScrollMotion();
  motion.start(0); motion.move(100, 30); motion.move(-40, 60);
  assert.ok(motion.frame(62) < 0);
});

test('a pause before lifting prevents a stale fling', () => {
  const motion = new TouchScrollMotion();
  motion.start(0); motion.move(30, 30); motion.frame(30); motion.release(300);
  assert.equal(motion.frame(332), 0);
  assert.equal(motion.active, false);
});
