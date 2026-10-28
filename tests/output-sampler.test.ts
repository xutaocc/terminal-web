import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OutputSampler } from '../web/output-sampler.js';

test('a continuous output flood is sampled periodically, including its final update', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let samples = 0;
  const sampler = new OutputSampler(() => samples++);
  for (let i = 0; i < 1000; i++) { sampler.schedule(); t.mock.timers.tick(1); }
  assert.equal(samples, 10);
  sampler.schedule(); t.mock.timers.tick(100);
  assert.equal(samples, 11);
  sampler.schedule(); sampler.dispose(); t.mock.timers.tick(100);
  sampler.schedule(); t.mock.timers.tick(100);
  assert.equal(samples, 11);
});
