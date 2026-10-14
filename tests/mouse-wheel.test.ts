import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mouseWheelReports } from '../web/mouse-wheel.js';

test('larger wheel steps retain their magnitude instead of all becoming two reports', () => {
  assert.equal(mouseWheelReports(40, 0, 24), 2);
  assert.equal(mouseWheelReports(120, 0, 24), 6);
  assert.equal(mouseWheelReports(-120, 0, 24), 6);
  assert.equal(mouseWheelReports(3, 1, 24), 6);
});

test('small trackpad movements preserve existing acceleration and huge steps are bounded', () => {
  assert.equal(mouseWheelReports(2, 0, 24), 2);
  assert.equal(mouseWheelReports(10000, 0, 24), 8);
  assert.equal(mouseWheelReports(1, 2, 24), 8);
  assert.equal(mouseWheelReports(0, 0, 24), 1);
  assert.equal(mouseWheelReports(NaN, 0, 24), 1);
});
