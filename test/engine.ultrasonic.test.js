// Ultrasonic boards (ESP32, /device WebSocket) feeding the range filter through the engine,
// on a stepped clock with no phones connected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../server/engine.js';
import { config } from '../server/config.js';

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
