// Navigation math (shared/navigation.js), the ND heading scale and waypoint formatting
// (web/dashboard/views/tcas/navSymbols.js), and the simulator's mock flight plans.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrap360, angleDiff, bearingTo, trueAirspeed, sequenceRoute, navPicture } from '../shared/navigation.js';
import { compassTicks, headingLabel, formatHeading, formatEta, windArrowAngle } from '../web/dashboard/views/tcas/navSymbols.js';
import { Airspace, NM, KT } from '../tools/sim/airspace.js';

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);
const tick = (ticks, deg) => ticks.find((t) => t.deg === deg);

test('angles wrap through north', () => {
  assert.equal(wrap360(-10), 350);
  assert.equal(wrap360(370), 10);
  assert.equal(angleDiff(10, 350), 20); // 350 -> 010 is a 20° right turn
  assert.equal(angleDiff(350, 10), -20);
  close(bearingTo({ x: 0, y: 0 }, { x: 1, y: 0 }), 90);
  close(bearingTo({ x: 0, y: 0 }, { x: -1, y: 1 }), 315);
});

test('heading scale labels are tens of degrees, own heading at the top', () => {
  assert.equal(headingLabel(90), '09');
  assert.equal(headingLabel(130), '13');
  assert.equal(headingLabel(0), '00');
  assert.equal(headingLabel(360), '00');
  assert.equal(formatHeading(90), '090');
  assert.equal(formatHeading(359.6), '000');

  const at090 = compassTicks(90);
  assert.equal(at090.length, 72); // every 5°
  assert.equal(tick(at090, 90).angle, 0);
  assert.equal(tick(at090, 90).label, '09');
  assert.equal(tick(at090, 100).angle, 10); // 10 to the right of 09
  assert.equal(tick(at090, 80).angle, 350); // 08 to the left
  assert.equal(tick(at090, 95).label, null); // minor tick
  assert.ok(tick(at090, 90).large && !tick(at090, 100).large);

  const at130 = compassTicks(130);
  assert.equal(tick(at130, 130).angle, 0);
  assert.equal(tick(at130, 140).angle, 10);
  assert.equal(tick(at130, 120).angle, 350);
});

test('heading scale wraps 350 -> 000 -> 010', () => {
  const ticks = compassTicks(355);
  assert.equal(tick(ticks, 350).angle, 355); // just left of the top
  assert.equal(tick(ticks, 0).angle, 5); // just right of the top
  assert.equal(tick(ticks, 0).label, '00');
  assert.equal(tick(ticks, 10).angle, 15);
  assert.equal(tick(compassTicks(-5), 0).angle, 5); // headings outside [0, 360) are wrapped
  assert.equal(tick(compassTicks(null), 0).angle, 0); // unknown heading: north up
});

test('true airspeed removes the wind from the ground velocity', () => {
  const gs = 250 * KT;
  const wind = { direction: 270, speed: 5 * KT };
  close(trueAirspeed(90, gs, wind) / KT, 245, 1e-9); // tailwind
  close(trueAirspeed(270, gs, wind) / KT, 255, 1e-9); // headwind
  close(trueAirspeed(0, gs, wind) / KT, Math.hypot(250, 5), 1e-9); // crosswind
  assert.equal(trueAirspeed(90, gs, null), gs);
  assert.equal(trueAirspeed(90, null, wind), null);
  assert.equal(windArrowAngle(wind, 90), 0); // tailwind: arrow points straight ahead
  assert.equal(windArrowAngle(wind, 0), 90); // wind from the left: arrow points right
});

test('nav picture: waypoints relative to own heading, active waypoint course, distance and time', () => {
  const route = { active: 1, waypoints: [{ id: 'W1', x: -1000, y: 0 }, { id: 'W2', x: 3000, y: 0 }, { id: 'W3', x: 3000, y: 4000 }] };
  const pic = navPicture({ x: 0, y: 0, heading: 90, groundSpeed: 100 }, route);
  assert.deepEqual(pic.waypoints.map((w) => w.id), ['W1', 'W2', 'W3']);
  assert.deepEqual(pic.waypoints.map((w) => w.active), [false, true, false]);
  close(pic.waypoints[0].bearing, 180); // FROM waypoint behind
  close(pic.waypoints[1].bearing, 0); // TO waypoint dead ahead
  close(pic.waypoints[2].range, 5000);
  assert.equal(pic.active.id, 'W2');
  close(pic.active.course, 90);
  close(pic.active.distance, 3000);
  close(pic.active.eta, 30);

  assert.equal(navPicture({ x: 0, y: 0, heading: 90, groundSpeed: 0 }, route).active.eta, null);
  assert.equal(navPicture({ x: 0, y: 0, heading: 90 }, null), null);
  const done = navPicture({ x: 0, y: 0, heading: 0, groundSpeed: 100 }, { ...route, active: 3 });
  assert.equal(done.active, null); // end of route
  assert.deepEqual(done.waypoints.map((w) => w.id), ['W3']);
});

test('route sequencing: fly-by turn anticipation, or passing the waypoint', () => {
  const wps = [{ id: 'W1', x: -1000, y: 0 }, { id: 'W2', x: 3000, y: 0 }, { id: 'W3', x: 3000, y: 4000 }];
  // 90° turn at W2, 100 m/s: radius 1910 m, anticipation 1910 m.
  const route = { active: 1, waypoints: wps };
  assert.equal(sequenceRoute(route, { x: 0, y: 0, groundSpeed: 100 }), false);
  assert.equal(sequenceRoute(route, { x: 1200, y: 0, groundSpeed: 100 }), true);
  assert.equal(route.active, 2);
  // Last waypoint: no anticipation, sequenced once passed.
  assert.equal(sequenceRoute(route, { x: 3000, y: 3990, groundSpeed: 100 }), false);
  assert.equal(sequenceRoute(route, { x: 3000, y: 4010, groundSpeed: 100 }), true);
  assert.equal(route.active, 3);
  // Passing several waypoints in one step sequences them all.
  const skip = { active: 1, waypoints: wps };
  sequenceRoute(skip, { x: 3000, y: 5000, groundSpeed: 0 });
  assert.equal(skip.active, 3);
});

test('time to go is shown as MM:SS', () => {
  assert.equal(formatEta(35), '00:35');
  assert.equal(formatEta(125.4), '02:05');
  assert.equal(formatEta(null), '--:--');
  assert.equal(formatEta(Infinity), '--:--');
});

test('simulated A and B fly their own routes; waypoints never appear as traffic', () => {
  const sim = new Airspace();
  const a = sim.picture('A');
  const b = sim.picture('B');
  assert.equal(a.nav.active.id, 'A2');
  close(a.nav.active.course, 90);
  close(a.nav.active.distance / NM, 6.5);
  close(a.nav.active.eta, (6.5 / 250) * 3600);
  close(a.ownship.trueAirspeed / KT, 245, 1e-9); // 250 kt GS with a 5 kt tailwind
  assert.deepEqual(a.ownship.wind, { direction: 270, speed: 5 * KT });
  assert.equal(b.nav.active.id, 'B2');
  close(b.nav.active.course, 270);
  close(b.ownship.trueAirspeed / KT, 255, 1e-9); // headwind
  const waypointIds = new Set([...a.nav.waypoints, ...b.nav.waypoints].map((w) => w.id));
  for (const t of [...a.traffic, ...b.traffic]) assert.ok(!waypointIds.has(t.id));

  // Within one loop, A passes A2 (after the encounter) and turns towards A3.
  const firstLoop = sim.loop;
  let sequenced = false;
  while (sim.loop === firstLoop && !sequenced) {
    sim.step(0.05);
    sequenced = sim.picture('A').nav.active.id === 'A3';
  }
  assert.ok(sequenced);
  assert.ok(sim.minSeparation.range < 0.5 * NM); // the encounter happened first
});
