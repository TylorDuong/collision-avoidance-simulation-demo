// Live demo: the real ultrasonic gap rendered through the TCAS demo UI's airspace picture, with
// the ratio and the zone thresholds adjustable at runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../server/engine.js';
import { config } from '../server/config.js';
import { INCH, applySettings, loadSettings, readSettings, saveSettings } from '../server/settings.js';

const NM = 1852;

function setup() {
  let simTime = 0;
  const engine = new Engine(config, { now: () => simTime, persist: false });
  const run = (seconds, onStep) => {
    const end = simTime + seconds;
    while (simTime < end) {
      simTime += 0.02;
      onStep?.(simTime);
      engine.tick();
    }
  };
  // Hold both boards at a distance (m) for a while.
  const hold = (metres, seconds = 1.5) => {
    let n = 0;
    run(seconds, () => {
      if (n++ % 5 === 0) {
        engine.handleRange('1', { range: metres });
        engine.handleRange('2', { range: metres });
      }
    });
  };
  return { engine, run, hold };
}

test('ultrasonic data is drawn in the demo UI: head-on on one axis at the configured scale', () => {
  const { engine, hold } = setup();
  hold(0.5); // 19.7 in
  const s = engine.getState();
  assert.equal(s.mode, 'airspace');
  assert.equal(s.range.source, 'ultrasonic');
  const k = (config.live.nmPerInch * NM) / INCH; // displayed m per real m
  assert.ok(Math.abs(s.live.scale - k) < 1e-6);
  assert.ok(Math.abs(s.live.range - 0.5) < 0.02);
  // Display range is the real gap times the ratio (0.5 m = 19.7 in, in NM per inch).
  const expectedNm = (0.5 / INCH) * config.live.nmPerInch;
  assert.ok(Math.abs(s.range.range / NM - expectedNm) < 0.05 * expectedNm, `${s.range.range / NM} NM vs ${expectedNm}`);

  const [a, b] = s.airspace.aircraft;
  assert.deepEqual([a.id, a.trk, b.id, b.trk], ['A', 90, 'B', 270]);
  assert.ok(Math.abs(b.x - a.x - s.range.range) < 1e-6); // on one axis, apart by the display range
  assert.equal(a.y, 0);
  assert.equal(a.alt, null);

  for (const [own, other] of [['A', 'B'], ['B', 'A']]) {
    const pic = s.perspectives[own];
    assert.equal(pic.ownship.id, own);
    assert.equal(pic.nav, null);
    assert.equal(pic.traffic.length, 1);
    assert.equal(pic.traffic[0].id, other);
    assert.equal(pic.traffic[0].bearing, 0); // straight ahead
    assert.ok(Math.abs(pic.traffic[0].range - s.range.range) < 1e-6);
  }
  assert.equal(s.perspectives.A.ownship.heading, 90);
  assert.equal(s.perspectives.B.ownship.heading, 270);
});

test('changing the ratio rescales the picture but not the real gap or the threat', () => {
  const { engine, hold } = setup();
  hold(0.6);
  const before = engine.getState();
  assert.deepEqual(engine.applySettings({ nmPerInch: config.live.nmPerInch * 2 }), { ok: true });
  const after = engine.getState();
  assert.ok(Math.abs(after.range.range / before.range.range - 2) < 0.01);
  assert.ok(Math.abs(after.live.range - before.live.range) < 1e-9);
  assert.equal(after.threat.level, before.threat.level);
});

test('zone thresholds are in real inches and take effect immediately', () => {
  const { engine, hold } = setup();
  hold(0.4); // 15.7 in: outside the default RA zone (0.3 m)
  assert.notEqual(engine.threat.threat, 'RA');
  assert.deepEqual(engine.applySettings({ proximateIn: 40, taIn: 25, raIn: 20 }), { ok: true });
  hold(0.4, 1);
  assert.equal(engine.threat.threat, 'RA'); // 15.7 in is now inside RA at 20 in
  const s = engine.getState();
  assert.equal(s.threat.level, 'RA');
  assert.equal(s.settings.raIn, 20);
  assert.equal(s.perspectives.A.ownship.ra.sense, 'up'); // complementary senses
  assert.equal(s.perspectives.B.ownship.ra.sense, 'down');
  assert.equal(s.airspace.aircraft[0].ra, 'up');
});

test('an invalid settings update is rejected and changes nothing', () => {
  const { engine } = setup();
  const before = engine.getState().settings;
  for (const bad of [{ taIn: 5, raIn: 10 }, { nmPerInch: 0 }, { raIn: -3 }, { nmPerInch: 'abc' }, { raTtc: 99, taTtc: 1 }]) {
    const res = engine.applySettings(bad);
    assert.equal(res.ok, false, JSON.stringify(bad));
    const now = engine.getState().settings;
    assert.equal(typeof now.error, 'string');
    assert.deepEqual({ ...now, error: null }, { ...before, error: null });
  }
  assert.deepEqual(engine.applySettings({}), { ok: true }); // a valid (empty) update clears the error
  assert.equal(engine.getState().settings.error, null);
});

test("an engine's settings do not leak into the shared config", () => {
  const { engine } = setup();
  const defaults = structuredClone({ live: config.live, zones: config.zones });
  engine.applySettings({ nmPerInch: 1, proximateIn: 50, taIn: 40, raIn: 30 });
  assert.deepEqual({ live: config.live, zones: config.zones }, defaults);
});

test('settings round-trip through the saved file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxdemo-'));
  const file = path.join(dir, 'settings.json');
  const a = { live: { ...config.live }, zones: structuredClone(config.zones) };
  assert.deepEqual(applySettings(a, { nmPerInch: 0.25, proximateIn: 30, taIn: 15, raIn: 8, taTtc: 3, raTtc: 1.5 }), { ok: true });
  saveSettings(a, file);

  const b = { live: { ...config.live }, zones: structuredClone(config.zones) };
  loadSettings(b, file);
  assert.deepEqual(readSettings(b), readSettings(a));
  assert.ok(Math.abs(b.zones.RA.range - 8 * INCH) < 1e-12);

  // A missing or corrupt file leaves the defaults.
  const c = { live: { ...config.live }, zones: structuredClone(config.zones) };
  fs.writeFileSync(file, '{not json');
  loadSettings(c, file);
  loadSettings(c, path.join(dir, 'missing.json'));
  assert.deepEqual(readSettings(c), readSettings({ live: config.live, zones: config.zones }));
  fs.rmSync(dir, { recursive: true });
});

test('with the boards silent the live picture has no frozen aircraft', () => {
  const { engine, run, hold } = setup();
  hold(0.5);
  run(config.filter.staleAfter + config.ultrasonic.signalTimeoutSeconds + 0.5);
  const s = engine.getState();
  assert.equal(s.mode, 'airspace'); // the layout does not jump back
  assert.equal(s.range.range, null);
  assert.equal(s.live.range, null);
  assert.deepEqual(s.airspace.aircraft, []);
  assert.equal(s.perspectives.A.traffic.length, 0);
});
