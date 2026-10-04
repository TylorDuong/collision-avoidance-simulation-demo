// TCAS demo scenario (tools/sim/airspace.js) and its path through the engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Airspace, SL5, NM, FT, FPM } from '../tools/sim/airspace.js';
import { Engine } from '../server/engine.js';
import { config } from '../server/config.js';
import { MSG } from '../shared/protocol.js';

const LEVELS = ['other', 'proximate', 'TA', 'RA'];

/** Run one full loop of the scenario, collecting what each TCAS aircraft saw. */
function runLoop(dt = 0.05) {
  const sim = new Airspace();
  const firstLoop = sim.loop;
  const seen = { A: {}, B: {} }; // own -> intruder -> worst level
  const timeline = []; // A's threat for B, de-duplicated
  const senses = { A: new Set(), B: new Set() };
  const symbols = new Set();
  const trends = new Set();
  let minSep = null;
  while (sim.loop === firstLoop) {
    sim.step(dt);
    if (sim.loop !== firstLoop) break;
    for (const own of ['A', 'B']) {
      const pic = sim.picture(own);
      for (const t of pic.traffic) {
        const prev = seen[own][t.id] ?? 'other';
        if (LEVELS.indexOf(t.threat) > LEVELS.indexOf(prev)) seen[own][t.id] = t.threat;
        symbols.add(t.threat);
        if (t.relAltRate !== null && Math.abs(t.relAltRate) >= 500 * FPM) trends.add(t.id);
      }
      if (pic.ownship.ra) senses[own].add(pic.ownship.ra.sense);
    }
    const level = sim.threat('A', 'B');
    if (timeline.at(-1) !== level) timeline.push(level);
    minSep = sim.minSeparation;
  }
  return { sim, seen, timeline, senses, symbols, trends, minSep };
}

test('A and B close head-on: TA, then a coordinated RA, then clear of conflict', () => {
  const { timeline, senses, minSep } = runLoop();
  assert.deepEqual(timeline, ['other', 'proximate', 'TA', 'RA', 'other', 'proximate', 'other']);
  assert.deepEqual([...senses.A], ['up']); // A is above: climbs
  assert.deepEqual([...senses.B], ['down']); // complementary sense
  assert.ok(minSep.vertical > SL5.alim, `vertical separation at closest approach ${minSep.vertical / FT} ft`);
  assert.ok(minSep.range < 0.5 * NM, 'they really were on a collision course');
});

test('surrounding traffic shows every symbol but is never a threat', () => {
  const { seen, symbols, trends } = runLoop();
  for (const own of ['A', 'B']) {
    for (const [id, level] of Object.entries(seen[own])) {
      if (id === 'A' || id === 'B') continue;
      assert.ok(LEVELS.indexOf(level) <= LEVELS.indexOf('proximate'), `${own} sees ${id} as ${level}`);
    }
  }
  assert.deepEqual([...symbols].sort(), ['RA', 'TA', 'other', 'proximate']);
  assert.ok(trends.has('E') && trends.has('F'), 'climbing and descending traffic shows trend arrows');
});

test('the scenario loops back to its start', () => {
  const sim = new Airspace();
  const start = sim.snapshot();
  let t = 0;
  while (sim.loop === 1 && t < 200) {
    sim.step(0.05);
    t += 0.05;
  }
  assert.equal(sim.loop, 2);
  assert.ok(t < sim.loopSeconds + 1, `loop length ${t.toFixed(1)} s`);
  assert.deepEqual(sim.snapshot().aircraft.map((a) => [a.id, Math.round(a.x)]), start.aircraft.map((a) => [a.id, Math.round(a.x)]));
});

test('engine relays a live airspace and falls back to the boards when it stops', () => {
  let now = 0;
  const engine = new Engine(config, { now: () => now, persist: false });
  const alerts = [];
  engine.on('alert', (a) => alerts.push(a.threat));
  const sim = new Airspace();
  while (sim.threat('A', 'B') !== 'TA') sim.step(0.1);
  const msg = { ...sim.snapshot(), t: MSG.AIRSPACE }; // as tools/mock-airspace.js sends it
  assert.equal(sim.snapshot().t, undefined, 'snapshot fields must not clobber the message type');
  engine.setAirspace(msg);
  engine.tick();

  const s = engine.getState();
  assert.equal(s.mode, 'sim');
  assert.equal(s.threat.level, 'TA');
  assert.equal(s.range.source, 'sim');
  assert.equal(s.perspectives.A.traffic.length, sim.aircraft.length - 1);
  assert.equal(s.airspace.aircraft.length, sim.aircraft.length);
  assert.deepEqual(alerts, ['TA']);

  now += config.airspaceFreshSeconds + 0.1;
  engine.tick();
  assert.equal(engine.getState().mode, 'live');
  engine.setAirspace({ nonsense: true }); // ignored
  assert.equal(engine.getState().mode, 'live');
});
