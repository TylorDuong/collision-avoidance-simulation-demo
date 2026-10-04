import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangeFilter } from '../server/fusion/rangeFilter.js';
import { CollisionEvaluator } from '../server/collision.js';
import { config } from '../server/config.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg ?? ''} ${a} vs ${b}`);

// Small seeded PRNG so the noisy filter test is repeatable.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fixed zones for the evaluator tests, so they do not depend on the demo defaults in
// server/config.js, which are tuned for the ultrasonic boards.
const ZONES = {
  proximate: { range: 1.5 },
  TA: { range: 0.75, ttc: 2.5 },
  RA: { range: 0.3, ttc: 1.0 },
  releaseRangeFactor: 1.15,
  releaseTtcFactor: 1.3,
  minHoldSeconds: 0.6,
  minClosingSpeed: 0.05,
};

test('range filter tracks a closing target and estimates its rate', () => {
  const f = new RangeFilter(config.filter);
  const rng = mulberry32(3);
  for (let i = 0; i <= 40; i++) {
    const t = i * 0.25;
    f.update(2 - 0.15 * t + (rng() - 0.5) * 0.06, 0.03 ** 2, t);
  }
  const est = f.estimate(10);
  near(est.range, 0.5, 0.05, 'range');
  near(est.rate, -0.15, 0.1, 'rate');
});

test('range filter gates outliers, then re-acquires after persistent disagreement', () => {
  const f = new RangeFilter(config.filter);
  for (let i = 0; i < 10; i++) f.update(1.0, 0.03 ** 2, i * 0.25);
  assert.equal(f.update(3.0, 0.03 ** 2, 2.5).accepted, false);
  near(f.estimate(2.5).range, 1.0, 0.02);
  let res;
  for (let i = 0; i < config.filter.maxConsecutiveRejects; i++) res = f.update(3.0, 0.03 ** 2, 2.55 + i * 0.05);
  assert.equal(res.reinitialized, true);
  near(f.estimate(2.8).range, 3.0, 0.05);
});

test('range filter extrapolation is capped at the prediction horizon', () => {
  const f = new RangeFilter(config.filter);
  for (let i = 0; i <= 20; i++) f.update(2 - 0.2 * i * 0.25, 0.01 ** 2, i * 0.25);
  const capped = f.estimate(5 + 10);
  near(capped.range, f.estimate(5 + config.filter.maxPredictHorizon).range, 1e-9);
});

test('collision evaluator escalates immediately and releases with hysteresis', () => {
  const z = ZONES;
  const ev = new CollisionEvaluator(z);
  let t = 0;
  const step = (range, closingSpeed = 0) => ev.evaluate({ range, closingSpeed, valid: true }, (t += 0.1));
  assert.equal(step(2.0).threat, 'other');
  assert.equal(step(1.2).threat, 'proximate');
  assert.equal(step(0.6).threat, 'TA');
  assert.equal(step(0.25).threat, 'RA');
  // Just outside the RA range but inside the release band: stays RA.
  for (let i = 0; i < 10; i++) assert.equal(step(z.RA.range * 1.1).threat, 'RA');
  // Beyond the release band (after min hold): drops.
  assert.equal(step(z.RA.range * 1.2).threat, 'TA');
  // TTC-triggered RA while still far away: 1.5 m closing at 2 m/s = 0.75 s.
  const ev2 = new CollisionEvaluator(z);
  const r = ev2.evaluate({ range: 1.5, closingSpeed: 2, valid: true }, 0);
  assert.equal(r.threat, 'RA');
  assert.equal(r.reason, 'ttc');
});

test('collision evaluator holds a level for the minimum time, then decays without data', () => {
  const ev = new CollisionEvaluator(ZONES);
  ev.evaluate({ range: 0.2, closingSpeed: 0, valid: true }, 0);
  assert.equal(ev.evaluate({ range: null, closingSpeed: 0, valid: false }, 0.1).threat, 'RA');
  assert.equal(ev.evaluate({ range: null, closingSpeed: 0, valid: false }, 1).threat, 'other');
});

test('collision: no-data reason clears once range returns at level other', () => {
  const ev = new CollisionEvaluator(ZONES);
  assert.equal(ev.evaluate({ range: null, closingSpeed: 0, valid: false }, 0).reason, 'no-data');
  const r = ev.evaluate({ range: 2.0, closingSpeed: 0, valid: true }, 0.1);
  assert.equal(r.threat, 'other');
  assert.equal(r.reason, null);
});
