import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardPrefilter } from '../server/fusion/boardPrefilter.js';

const OPTS = { medianWindow: 3, medianMaxAge: 0.5, spikeThreshold: 0.05, offsetAlpha: 0.5, maxOffset: 0.03, freshSeconds: 1 };

test('prefilter passes readings near the median unchanged and replaces spikes', () => {
  const p = new BoardPrefilter(OPTS);
  assert.equal(p.despike('A', 1.0, 0), 1.0);
  assert.equal(p.despike('A', 1.01, 0.1), 1.01);
  assert.equal(p.despike('A', 1.02, 0.2), 1.02); // a steady ramp is not delayed
  assert.equal(p.despike('A', 0.2, 0.3), 1.01); // spike -> median of 1.01, 1.02, 0.2
  assert.equal(p.despike('A', 1.03, 0.4), 1.03);
  // Echoes older than medianMaxAge leave the window.
  assert.equal(p.despike('A', 2.0, 5), 2.0);
});

test('prefilter corrects each board by its offset from the boards average, capped', () => {
  const p = new BoardPrefilter(OPTS);
  p.despike('A', 1, 0);
  assert.equal(p.correction('A', 0), 0); // one board: nothing to compare with
  p.despike('B', 1, 0);
  for (let i = 0; i < 20; i++) {
    p.learn('A', 0.01);
    p.learn('B', -0.01);
  }
  assert.ok(Math.abs(p.correction('A', 0) - 0.01) < 1e-4);
  assert.ok(Math.abs(p.correction('B', 0) + 0.01) < 1e-4);
  for (let i = 0; i < 20; i++) p.learn('A', 0.2);
  assert.equal(p.correction('A', 0), OPTS.maxOffset);
  // A board that stopped reporting no longer counts.
  assert.equal(p.correction('A', 5), 0);
});
