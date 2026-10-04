import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdvisoryTracker, resolveSense } from '../web/dashboard/views/tcas/advisories.js';
import { formatRelAlt, formatNoBearing, trendGlyph, rangeRings, UNITS } from '../web/dashboard/views/tcas/symbols.js';

const traffic = (threat, relAlt = null, extra = {}) => [{ id: 'B', range: 1, bearing: null, relAlt, relAltRate: null, threat, ...extra }];

test('advisory banner text follows the TCAS v7.1 annunciations', () => {
  const a = new AdvisoryTracker();
  assert.equal(a.update(traffic('other'), 0).banner, null);
  assert.equal(a.update(traffic('proximate'), 100).banner, null);
  assert.equal(a.update(traffic('TA'), 200).banner.text, 'TRAFFIC, TRAFFIC');
  assert.equal(a.update(traffic('RA', 0.2), 300).banner.text, 'DESCEND, DESCEND');
  // The RA ends at 400; a remaining TA outranks the clear-of-conflict message.
  assert.equal(a.update(traffic('TA'), 400).banner.text, 'TRAFFIC, TRAFFIC');
  assert.equal(a.update(traffic('other'), 500).banner.text, 'CLEAR OF CONFLICT');
  assert.equal(a.update(traffic('other'), 3399).banner.text, 'CLEAR OF CONFLICT');
  assert.equal(a.update(traffic('other'), 3400).banner, null);
});

test('RA sense moves away from the intruder and defaults to climb without altitude', () => {
  assert.equal(resolveSense({ relAlt: 0.3 }), 'down');
  assert.equal(resolveSense({ relAlt: -0.3 }), 'up');
  assert.equal(resolveSense({ relAlt: null }), 'up');
  assert.equal(resolveSense(undefined), 'up');
});

test('RA sense is latched for the life of the RA', () => {
  const a = new AdvisoryTracker();
  assert.equal(a.update(traffic('RA', -0.05), 0).banner.sense, 'up');
  assert.equal(a.update(traffic('RA', 0.05), 100).banner.sense, 'up'); // relAlt noise crosses 0
  a.update(traffic('other'), 200);
  assert.equal(a.update(traffic('RA', 0.05), 5000).banner.sense, 'down'); // a new RA re-selects
});

test('RA carries IVSI guidance: green rate to fly, red rates to avoid', () => {
  const climb = new AdvisoryTracker().update(traffic('RA', -0.1), 0).banner.vsi;
  assert.deepEqual(climb, { green: [1.5, 2], red: [[-6, 1.5]] });
  const descend = new AdvisoryTracker().update(traffic('RA', 0.1), 0).banner.vsi;
  assert.deepEqual(descend, { green: [-2, -1.5], red: [[-1.5, 6]] });
  assert.equal(new AdvisoryTracker().update(traffic('TA'), 0).banner.vsi, undefined);
});

test('the RA carries the metres still to go and weakens to Level Off at safe separation', () => {
  const a = new AdvisoryTracker();
  const climb = a.update(traffic('RA', -0.1), 0, { ra: { sense: 'up', remaining: 42.5 } }).banner;
  assert.equal(climb.text, 'CLIMB, CLIMB');
  assert.equal(climb.remaining, 42.5);
  const level = a.update(traffic('RA', -0.1), 100, { ra: { sense: 'up', remaining: 0 } }).banner;
  assert.equal(level.text, 'LEVEL OFF, LEVEL OFF');
  assert.equal(level.sense, 'up');
  assert.deepEqual(level.vsi, { green: [0, 0.3], red: [[-6, 0]] });
  assert.equal(a.update(traffic('other'), 200).banner.text, 'CLEAR OF CONFLICT');
  // The simulator reports no remaining distance: plain Climb, no count.
  assert.equal(new AdvisoryTracker().update(traffic('RA', -0.1), 0, { ra: { sense: 'up' } }).banner.remaining, null);
});

test('the own-ship TCAS sense and operating mode drive the advisory', () => {
  const a = new AdvisoryTracker();
  // Own TCAS chose "down" even though geometry alone would say "up".
  assert.equal(a.update(traffic('RA', -0.1), 0, { ra: { sense: 'down' } }).banner.text, 'DESCEND, DESCEND');
  assert.equal(a.update(traffic('RA', -0.1), 100, { ra: { sense: 'up' } }).banner.text, 'CLIMB, CLIMB'); // reversal
  const taOnly = new AdvisoryTracker().update(traffic('RA'), 0, { mode: 'TA ONLY' }).banner;
  assert.equal(taOnly.text, 'TRAFFIC, TRAFFIC');
  assert.equal(taOnly.vsi, undefined);
  assert.equal(new AdvisoryTracker().update(traffic('RA'), 0, { mode: 'STBY' }).banner, null);
});

test('aircraft units: hundreds of feet, 500 fpm trend, NM', () => {
  const ft = 0.3048;
  const fpm = ft / 60;
  const u = UNITS.airspace;
  assert.equal(formatRelAlt(500 * ft, u), '+05');
  assert.equal(formatRelAlt(-1200 * ft, u), '−12');
  assert.equal(formatRelAlt(30 * ft, u), '00');
  assert.equal(trendGlyph(400 * fpm, u), '');
  assert.equal(trendGlyph(-600 * fpm, u), '↓');
  assert.equal(formatNoBearing({ threat: 'RA', range: 4.5 * 1852, relAlt: 1200 * ft, relAltRate: -800 * fpm }, u), 'RA 4.5 +12↓');
});

test('data tag and no-bearing formatting', () => {
  assert.equal(formatRelAlt(null), '');
  assert.equal(formatRelAlt(0.02), '00');
  assert.equal(formatRelAlt(0.2), '+02');
  assert.equal(formatRelAlt(-0.5), '−05');
  assert.equal(formatRelAlt(50), '+99');
  assert.equal(trendGlyph(0.05), '');
  assert.equal(trendGlyph(0.3), '↑');
  assert.equal(trendGlyph(-0.3), '↓');
  assert.equal(formatNoBearing({ threat: 'RA', range: 0.284, relAlt: null, relAltRate: null }), 'RA 0.28');
  assert.equal(formatNoBearing({ threat: 'TA', range: 0.61, relAlt: 0.2, relAltRate: -0.2 }), 'TA 0.61 +02↓');
});

test('range rings: several evenly spaced rings, the last at the selected range', () => {
  assert.deepEqual(rangeRings(20), [5, 10, 15, 20]);
  assert.deepEqual(rangeRings(10), [2.5, 5, 7.5, 10]);
  assert.deepEqual(rangeRings(5), [1, 2, 3, 4, 5]);
  assert.deepEqual(rangeRings(40), [10, 20, 30, 40]);
  assert.deepEqual(rangeRings(1), [0.25, 0.5, 0.75, 1]); // phones, metres
  for (const r of [...UNITS.airspace.ranges, ...UNITS.phones.ranges]) {
    const rings = rangeRings(r);
    assert.ok(rings.length >= 3 && rings.length <= 5, `${r}: ${rings}`);
    assert.equal(rings.at(-1), r);
    const step = rings[0];
    rings.forEach((v, i) => assert.ok(Math.abs(v - (i + 1) * step) < 1e-9, `${r}: uneven ${rings}`));
  }
});
