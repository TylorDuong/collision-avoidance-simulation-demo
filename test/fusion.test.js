import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RangeFilter } from '../server/fusion/rangeFilter.js';
import { CollisionEvaluator } from '../server/collision.js';
import { OrientationTracker } from '../server/fusion/orientation.js';
import { ClockSync } from '../server/fusion/clock.js';
import { haversine } from '../server/fusion/gps.js';
import { fromDeviceOrientation, rotate } from '../shared/quat.js';
import { config } from '../server/config.js';
import { mulberry32 } from '../tools/sim/world.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg ?? ''} ${a} vs ${b}`);

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
  for (let i = 0; i < 10; i++) f.update(1.0, 0.03 ** 2, i * 0.25, { moving: false });
  assert.equal(f.update(3.0, 0.03 ** 2, 2.5, { moving: false }).accepted, false);
  near(f.estimate(2.5).range, 1.0, 0.02);
  let res;
  for (let i = 0; i < config.filter.maxConsecutiveRejects; i++) res = f.update(3.0, 0.03 ** 2, 2.75 + i * 0.25, { moving: false });
  assert.equal(res.reinitialized, true);
  near(f.estimate(4).range, 3.0, 0.05);
});

test('range filter extrapolation is capped at the prediction horizon', () => {
  const f = new RangeFilter(config.filter);
  for (let i = 0; i <= 20; i++) f.update(2 - 0.2 * i * 0.25, 0.01 ** 2, i * 0.25);
  const capped = f.estimate(5 + 10);
  near(capped.range, f.estimate(5 + config.filter.maxPredictHorizon).range, 1e-9);
});

test('collision evaluator escalates immediately and releases with hysteresis', () => {
  const z = config.zones;
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
  const ev = new CollisionEvaluator(config.zones);
  ev.evaluate({ range: 0.2, closingSpeed: 0, valid: true }, 0);
  assert.equal(ev.evaluate({ range: null, closingSpeed: 0, valid: false }, 0.1).threat, 'RA');
  assert.equal(ev.evaluate({ range: null, closingSpeed: 0, valid: false }, 1).threat, 'other');
});

test('collision: no-data reason clears once range returns at level other', () => {
  const ev = new CollisionEvaluator(config.zones);
  assert.equal(ev.evaluate({ range: null, closingSpeed: 0, valid: false }, 0).reason, 'no-data');
  const r = ev.evaluate({ range: 2.0, closingSpeed: 0, valid: true }, 0.1);
  assert.equal(r.threat, 'other');
  assert.equal(r.reason, null);
});

test('device orientation Euler angles map to the expected rotations', () => {
  // alpha 90°: device x-axis (right edge) points north (+Y in ENU).
  const q1 = fromDeviceOrientation(90, 0, 0);
  rotate(q1, [1, 0, 0]).forEach((v, i) => near(v, [0, 1, 0][i], 1e-9));
  // beta 90°: phone stood upright, device y-axis (top) points up (+Z).
  const q2 = fromDeviceOrientation(0, 90, 0);
  rotate(q2, [0, 1, 0]).forEach((v, i) => near(v, [0, 0, 1][i], 1e-9));
  // gamma 90°: rolled right, screen normal (+z) points... +x? R_y(90) maps z -> x.
  const q3 = fromDeviceOrientation(0, 0, 90);
  rotate(q3, [0, 0, 1]).forEach((v, i) => near(v, [1, 0, 0][i], 1e-9));
});

test('orientation tracker aligns to compass north and outputs Three.js frame', () => {
  const o = new OrientationTracker({ smoothing: 1, headingSmoothing: 1 });
  // Flat phone, arbitrary alpha 30°, compass says it's pointing due east (heading 90°).
  o.update({ alpha: 30, beta: 0, gamma: 0, heading: 90, headingAcc: 10 });
  near(o.heading, 90, 1e-6, 'heading');
  // Device top (+y) should point east = +X in Three.js.
  rotate(o.q, [0, 1, 0]).forEach((v, i) => near(v, [1, 0, 0][i], 1e-6));
  // Screen normal points up = +Y in Three.js.
  rotate(o.q, [0, 0, 1]).forEach((v, i) => near(v, [0, 1, 0][i], 1e-6));
});

test('clock sync picks the lowest-RTT exchange', () => {
  const c = new ClockSync();
  c.add(1000, 5000 + 1010, 1040); // rtt 40, offset 4990
  c.add(2000, 5000 + 2002, 2004); // rtt 4,  offset 5000
  near(c.toServer(9000), 4000, 1e-9);
});

test('haversine distance', () => {
  near(haversine(0, 0, 0, 1), 111195, 1);
});
