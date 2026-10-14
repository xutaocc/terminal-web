import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OutputActivityTracker, SessionReadState } from '../web/output-activity.js';

test('attach replay and unchanged redraws do not indicate work', () => {
  const tracker = new OutputActivityTracker(0);
  assert.equal(tracker.observe('old screen', 10), false);
  assert.equal(tracker.observe('complete old screen', 500), false);
  assert.equal(tracker.observe('complete old screen', 2000), false);
  assert.equal(tracker.observe('complete old screen', 65000), false);
});

test('new visible output after settling indicates work', () => {
  const tracker = new OutputActivityTracker(0);
  tracker.observe('prompt', 100);
  assert.equal(tracker.observe('prompt\nworking', 2000), true);
  assert.equal(tracker.observe('prompt\nworking', 2500), false);
  assert.equal(tracker.observe('prompt\ndone', 3000), true);
});

test('first screen and reconnect replay are never treated as new output', () => {
  const tracker = new OutputActivityTracker(10000);
  assert.equal(tracker.observe('existing output', 20000), false);
  assert.equal(tracker.observe('existing output', 21000), false);
});

test('spinner takes precedence and unread survives its completion', () => {
  const state = new SessionReadState();
  assert.equal(state.indicator(false), 'read');
  state.input('\r');
  state.output();
  assert.equal(state.indicator(true), 'working');
  assert.equal(state.indicator(false), 'unread');
  state.enter();
  assert.equal(state.indicator(false), 'read');
});

test('entering during output clears unread without stopping the spinner', () => {
  const state = new SessionReadState();
  state.input('\r');
  state.output();
  state.enter();
  assert.equal(state.indicator(true), 'working');
  assert.equal(state.indicator(false), 'read');
  state.output();
  assert.equal(state.unread, true);
});

test('entry and unsolicited redraws stay read until a prompt is submitted', () => {
  const state = new SessionReadState();
  const tracker = new OutputActivityTracker(0);
  tracker.observe('old screen', 100);
  state.enter();
  assert.equal(state.indicator(false), 'read');
  tracker.enter(10000);
  assert.equal(tracker.observe('replayed screen', 10100), false);
  assert.equal(tracker.observe('replayed screen', 12000), false);
  assert.equal(tracker.observe('new output without a prompt', 12100), true);
  assert.equal(state.output(), false);
  assert.equal(state.indicator(false), 'read');
  assert.equal(state.input('typing only'), false);
  assert.equal(state.input('\x1b[200~line one\nline two\x1b[201~'), false);
  assert.equal(state.output(), false);
  state.input('\r');
  assert.equal(state.output(), true);
  assert.equal(state.indicator(true), 'working');
  assert.equal(state.indicator(false), 'unread');
  state.enter();
  assert.equal(state.indicator(false), 'read');
  assert.equal(state.output(), true);
  assert.equal(state.unread, true);
});

test('long tasks can resume after repeated minutes of silence without resubmitting', () => {
  const state = new SessionReadState();
  const tracker = new OutputActivityTracker(0);
  tracker.observe('prompt', 100);
  state.input('\r');
  for (const time of [2000, 182000, 482000]) {
    assert.equal(tracker.observe(`output at ${time}`, time), true);
    assert.equal(state.output(), true);
    assert.equal(state.indicator(true), 'working');
    assert.equal(tracker.observe(`output at ${time}`, time + 60000), false);
    assert.equal(state.indicator(false), 'unread');
    state.enter();
    assert.equal(state.indicator(false), 'read');
  }
});

test('command submission allows prompt responses during entry settling', () => {
  const tracker = new OutputActivityTracker(0);
  tracker.observe('prompt', 100);
  tracker.input();
  assert.equal(tracker.observe('response', 200), true);
});
