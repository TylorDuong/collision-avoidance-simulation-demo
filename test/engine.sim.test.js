// End-to-end through the engine with the simulated acoustic world on a stepped clock:
// chirp commands -> synthesized microphone audio -> detection -> BeepBeep -> filter -> threat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../server/engine.js';
import { config } from '../server/config.js';
import { MSG, floatToInt16 } from '../shared/protocol.js';
import { AcousticWorld, SCRIPTS, mulberry32 } from '../tools/sim/world.js';

function setup(distance, { seed = 11 } = {}) {
  let simTime = 0;
  const rng = mulberry32(seed);
  const world = new AcousticWorld({ distance, seed });
  world.addPhone('A', { sampleRate: 48000, clockOffset: -12.3, outLatency: 0.031, inLatency: 0.012, selfDistance: 0.03 });
  world.addPhone('B', { sampleRate: 48000, clockOffset: -4.56, outLatency: 0.044, inLatency: 0.018, selfDistance: 0.05 });
  const engine = new Engine(config, { now: () => simTime, persist: false });
  const pending = []; // commands in flight
  const cursors = {};
  for (const id of ['A', 'B']) {
    engine.connectPhone(id, {
      sampleRate: 48000,
      send: (msg) => {
        if (msg.t === MSG.CHIRP) pending.push({ id, msg, at: simTime + 0.005 + 0.03 * rng() });
      },
    });
    cursors[id] = world.frameAt(id, 0);
  }
  const CHUNK = 1024;
  const run = (seconds, onStep) => {
    const end = simTime + seconds;
    while (simTime < end) {
      simTime += 0.005;
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i];
        if (p.at <= simTime) {
          pending.splice(i, 1);
          const frame = world.chirp(p.id, p.at, p.msg.delay);
          engine.handlePhoneMessage(p.id, { t: MSG.CHIRPED, seq: p.msg.seq, frame });
        }
      }
      for (const id of ['A', 'B']) {
        while (cursors[id] + CHUNK <= world.frameAt(id, simTime)) {
          engine.handleAudio(id, cursors[id], floatToInt16(world.render(id, cursors[id], CHUNK)));
          cursors[id] += CHUNK;
        }
      }
      engine.tick();
      onStep?.(simTime, engine);
    }
  };
  return { engine, run, now: () => simTime };
}

test('acoustic ranging tracks a moving phone within a few centimetres', () => {
  const distance = SCRIPTS.oscillate;
  const { engine, run } = setup(distance);
  engine.K = 0.04; // (0.03 + 0.05) / 2
  const errors = [];
  const threats = new Set();
  run(20, (t, e) => {
    const s = e.getState();
    threats.add(s.threat.level);
    if (t > 3 && s.range.range !== null) errors.push(Math.abs(s.range.range - distance(t)));
  });
  errors.sort((a, b) => a - b);
  const median = errors[errors.length >> 1];
  const p95 = errors[Math.floor(errors.length * 0.95)];
  const state = engine.getState();
  assert.ok(state.acoustic.successRate > 0.9, `success rate ${state.acoustic.successRate} (${state.acoustic.lastFailure})`);
  assert.ok(median < 0.05, `median error ${median}`);
  assert.ok(p95 < 0.1, `p95 error ${p95}`);
  for (const level of ['other', 'proximate', 'TA', 'RA']) assert.ok(threats.has(level), `never reached ${level}`);
  const { A, B } = state.perspectives;
  assert.equal(A.ownship.id, 'A');
  assert.equal(A.traffic[0].id, 'B');
  assert.equal(A.traffic[0].bearing, null);
  assert.equal(B.ownship.id, 'B');
  assert.equal(B.traffic[0].id, 'A');
  assert.equal(B.traffic[0].range, A.traffic[0].range);
  assert.equal(B.traffic[0].threat, A.traffic[0].threat);
});

test('calibration solves the speaker-to-mic constant at a known distance', () => {
  const { engine, run } = setup(SCRIPTS.static(0.1), { seed: 5 });
  engine.calibrate(0.1);
  run(4);
  const { calibration } = engine.getState();
  assert.equal(calibration.state, 'done');
  assert.ok(Math.abs(calibration.K - 0.04) < 0.01, `K ${calibration.K}`);
});
