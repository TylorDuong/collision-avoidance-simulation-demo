// Ultrasonic boards (ESP32, /device WebSocket) feeding the range filter through the engine,
// on a stepped clock with no phones connected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../server/engine.js';
import { config } from '../server/config.js';
import { selectRaSenses } from '../server/collision.js';

function setup() {
  let simTime = 0;
  const engine = new Engine(config, { now: () => simTime, persist: false });
  // Advance the clock in 20 ms steps; `onStep(t)` runs before each tick.
  const run = (seconds, onStep) => {
    const end = simTime + seconds;
    while (simTime < end) {
      simTime += 0.02;
      onStep?.(simTime);
      engine.tick();
    }
  };
  return { engine, run, now: () => simTime };
}

// Both boards report the same gap, 10 Hz each, offset by half a period.
const bothBoards = (engine, range) => {
  engine.handleRange('1', { range });
  engine.handleRange('2', { range });
};

test('two boards produce an ultrasonic range estimate with no phones connected', () => {
  const { engine, run } = setup();
  let n = 0;
  run(2, () => {
    if (n++ % 5 === 0) bothBoards(engine, 1.2);
  });
  const s = engine.getState();
  assert.equal(s.range.source, 'ultrasonic');
  assert.ok(Math.abs(s.range.range - 1.2) < 0.05, `range ${s.range.range}`);
  assert.deepEqual(s.ultrasonic.boards.map((b) => [b.id, b.status]), [['1', 'ok'], ['2', 'ok']]);
  // The other node is traffic in both TCAS perspectives even though no phone is connected.
  assert.equal(s.perspectives.A.traffic.length, 1);
  assert.equal(s.perspectives.B.traffic.length, 1);
});

test('a closing approach escalates to RA', () => {
  const { engine, run, now } = setup();
  const seen = new Set();
  let n = 0;
  const t0 = now();
  run(4, (t) => {
    if (n++ % 5 === 0) bothBoards(engine, Math.max(0.1, 1.8 - 0.45 * (t - t0)));
    seen.add(engine.threat.threat);
  });
  assert.ok(seen.has('TA'), [...seen].join());
  assert.equal(engine.threat.threat, 'RA');
});

test('no-echo and out-of-range readings do not move the filter', () => {
  const { engine, run } = setup();
  let n = 0;
  run(1, () => {
    if (n++ % 5 === 0) bothBoards(engine, 1.0);
  });
  const before = engine.getState().range.range;
  engine.handleRange('1', { range: null });
  engine.handleRange('2', { range: 9 }); // beyond the sensor's maxRange
  engine.handleRange('2', { range: Number.NaN });
  const s = engine.getState();
  assert.equal(s.range.range, before);
  assert.deepEqual(s.ultrasonic.boards.map((b) => [b.id, b.status, b.range]), [['1', 'no-echo', null], ['2', 'no-echo', null]]);
});

test('a silent board shows no-signal and the range goes stale', () => {
  const { engine, run } = setup();
  let n = 0;
  run(1, () => {
    if (n++ % 5 === 0) bothBoards(engine, 1.0);
  });
  run(config.ultrasonic.signalTimeoutSeconds + 0.5);
  const s = engine.getState();
  assert.ok(s.ultrasonic.boards.every((b) => b.status === 'no-signal'));
  run(config.filter.staleAfter);
  assert.equal(engine.getState().range.source, 'stale');
  assert.equal(engine.getState().perspectives.A.traffic.length, 0);
});

test('RA senses are complementary: one node climbs, the other descends', () => {
  const { engine, run, now } = setup();
  let n = 0;
  const t0 = now();
  const senses = new Set();
  run(4, (t) => {
    if (n++ % 5 === 0) bothBoards(engine, Math.max(0.1, 1.8 - 0.45 * (t - t0)));
    const { A, B } = engine.getState().perspectives;
    if (A.ownship.ra || B.ownship.ra) senses.add(`${A.ownship.ra?.sense}/${B.ownship.ra?.sense}`);
  });
  assert.equal(engine.threat.threat, 'RA');
  assert.deepEqual([...senses], ['up/down']); // never both climbing, never flipping mid-RA
  const { A, B } = engine.getState().perspectives;
  assert.equal(A.ownship.ra.intruder, 'B');
  assert.equal(B.ownship.ra.intruder, 'A');

  // Moving apart clears the RA and its senses.
  n = 0;
  run(4, () => {
    if (n++ % 5 === 0) bothBoards(engine, 2.5);
  });
  assert.notEqual(engine.threat.threat, 'RA');
  assert.equal(engine.getState().perspectives.A.ownship.ra, null);
  assert.equal(engine.getState().perspectives.B.ownship.ra, null);
});

test('sense selection: the higher node climbs; without altitude A climbs and B descends', () => {
  assert.deepEqual(selectRaSenses(null, 1), { A: 'up', B: 'down' });
  assert.deepEqual(selectRaSenses(0.4, 1), { A: 'up', B: 'down' }); // inside GPS noise: tie-break
  assert.deepEqual(selectRaSenses(3, 1), { A: 'down', B: 'up' }); // B is 3 m higher
  assert.deepEqual(selectRaSenses(-3, 1), { A: 'up', B: 'down' });
});

test('the other node stays on both displays between accepted readings', () => {
  const { engine, run } = setup();
  let n = 0;
  run(1, () => {
    if (n++ % 5 === 0) bothBoards(engine, 1.0);
  });
  // Boards still reporting but with no echo for a while: no longer 'ultrasonic', still present.
  n = 0;
  run(1.5, () => {
    if (n++ % 5 === 0) bothBoards(engine, null);
  });
  const s = engine.getState();
  assert.notEqual(s.range.source, 'ultrasonic');
  for (const [own, other] of [['A', 'B'], ['B', 'A']]) {
    assert.equal(s.perspectives[own].traffic.length, 1);
    assert.equal(s.perspectives[own].traffic[0].id, other);
    assert.ok(Math.abs(s.perspectives[own].traffic[0].range - 1.0) < 0.1); // same distance on both
  }
});
