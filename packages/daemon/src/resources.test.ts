import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuPercent } from '../../../scripts/app-m1-metrics.ts';

test('resource CPU converts clock ticks to seconds, independently of kernel tick frequency', () => {
  assert.equal(cpuPercent(100, 1000, 100), 100);
  assert.equal(cpuPercent(500, 5000, 100), 100);
  assert.equal(cpuPercent(250, 1000, 250), 100);
  assert.equal(cpuPercent(100, 5000, 100), 20);
  assert.equal(cpuPercent(0, 1000, 100), 0);
  for (const input of [[1, 0, 100], [-1, 1000, 100], [1, 1000, 0], [NaN, 1000, 100]]) {
    assert.throws(() => cpuPercent(input[0], input[1], input[2]), /invalid CPU sample/);
  }
});
