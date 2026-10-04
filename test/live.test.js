// Live demo: the real ultrasonic gap rendered through the TCAS demo UI's airspace picture, with
// the zone thresholds adjustable at runtime, the zones drawn at their real-world TCAS radii and
// sample altitudes that climb / descend apart during an RA.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../server/engine.js';
import { config } from '../server/config.js';
import { INCH, applySettings, loadSettings, readSettings, saveSettings } from '../server/settings.js';
import { LiveVertical, liveScale } from '../server/live.js';

const NM = 1852;
const FT = 0.3048;

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

test('each zone boundary is drawn at its real-world TCAS radius', () => {
  const { zones, live } = config;
  const scale = liveScale(zones, live.displayZones);
  assert.ok(Math.abs(scale.toDisplay(zones.RA.range) - 1.1 * NM) < 1e-6);
  assert.ok(Math.abs(scale.toDisplay(zones.TA.range) - 1.4 * NM) < 1e-6);
  assert.ok(Math.abs(scale.toDisplay(zones.proximate.range) - 6 * NM) < 1e-6);
  assert.equal(scale.toDisplay(0), 0);
  // Monotonic, and past the proximate zone it keeps the last segment's slope.
  let prev = -1;
  for (let r = 0; r <= 1; r += 0.005) {
    assert.ok(scale.toDisplay(r) > prev);
    prev = scale.toDisplay(r);
  }
  const last = scale.slope(zones.proximate.range);
  assert.ok(Math.abs(scale.toDisplay(zones.proximate.range + 0.1) - (6 * NM + 0.1 * last)) < 1e-6);
});

test('ultrasonic data is drawn in the demo UI: head-on on one axis at the zone scale', () => {
  const { engine, hold } = setup();
  hold(0.5); // 19.7 in
  const s = engine.getState();
  assert.equal(s.mode, 'airspace');
  assert.equal(s.range.source, 'ultrasonic');
  assert.ok(Math.abs(s.live.range - 0.5) < 0.02);
  const expected = liveScale(config.zones, config.live.displayZones).toDisplay(s.live.range);
  assert.ok(Math.abs(s.range.range - expected) < 1e-6, `${s.range.range / NM} NM vs ${expected / NM}`);
  assert.deepEqual(
    s.live.zones.map((z) => [z.level, Math.round(z.in), z.nm]),
    [['proximate', 18, 6], ['TA', 10, 1.4], ['RA', 6, 1.1]],
  );

  const [a, b] = s.airspace.aircraft;
  assert.deepEqual([a.id, a.trk, b.id, b.trk], ['A', 90, 'B', 270]);
  assert.ok(Math.abs(b.x - a.x - s.range.range) < 1e-6); // on one axis, apart by the display range
  assert.equal(a.y, 0);
  assert.ok(Math.abs(a.alt - b.alt - 300 * FT) < 1e-6); // sample altitudes: B 300 ft below A

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

test('moving a zone keeps it on its real-world radius', () => {
  const { engine, hold } = setup();
  hold(8 * INCH);
  const before = engine.getState();
  assert.ok(before.range.range > 1.1 * NM && before.range.range < 1.4 * NM); // between RA and TA
  assert.deepEqual(engine.applySettings({ raIn: 8 }), { ok: true });
  const after = engine.getState();
  assert.ok(Math.abs(after.range.range - 1.1 * NM) < 0.05 * NM); // 8 in is now the RA boundary
  assert.ok(Math.abs(after.live.range - before.live.range) < 1e-9);
  assert.equal(after.settings.zonesNm.RA, 1.1);
});

test('data tags carry the sample relative altitude in each point of view', () => {
  const { engine, hold } = setup();
  hold(0.5);
  const s = engine.getState();
  assert.ok(Math.abs(s.perspectives.A.traffic[0].relAlt + 300 * FT) < 1e-6); // A sees B "−03"
  assert.ok(Math.abs(s.perspectives.B.traffic[0].relAlt - 300 * FT) < 1e-6); // B sees A "+03"
  assert.ok(Math.abs(s.perspectives.A.ownship.altitude - config.live.sample.altitude) < 1e-6);
  assert.equal(s.perspectives.A.ownship.verticalSpeed, 0);
  assert.equal(s.perspectives.A.ownship.ra, null);
});

test('in an RA the aircraft climb / descend apart to safe separation, count down, then level off', () => {
  const { engine, hold } = setup();
  hold(4 * INCH, 0.5);
  let s = engine.getState();
  assert.equal(s.threat.level, 'RA');
  const target = config.live.verticalZones.RA;
  const raA = s.perspectives.A.ownship.ra;
  assert.deepEqual([raA.sense, s.perspectives.B.ownship.ra.sense], ['up', 'down']); // B is lower
  assert.equal(raA.target, target);
  let last = raA.remaining;
  assert.ok(last > 0 && last <= (target - 300 * FT) / 2 + 1e-6);

  // The countdown only goes down while A climbs and B descends.
  for (let i = 0; i < 40; i++) {
    hold(4 * INCH, 0.5);
    s = engine.getState();
    assert.equal(s.threat.level, 'RA'); // reaching separation does not cancel the RA
    const r = s.perspectives.A.ownship.ra.remaining;
    assert.ok(r <= last + 1e-9);
    last = r;
  }
  assert.equal(last, 0);
  const relAlt = s.perspectives.A.traffic[0].relAlt;
  assert.ok(relAlt <= -target, `relAlt ${relAlt / FT} ft`);
  assert.ok(s.perspectives.A.ownship.altitude > config.live.sample.altitude);
  assert.ok(Math.abs(s.perspectives.A.ownship.verticalSpeed) < 0.01); // levelled off
  assert.ok(Math.abs(s.perspectives.B.ownship.verticalSpeed) < 0.01);

  // Boards apart: the RA ends and both return to the sample altitudes.
  hold(0.8, 1);
  assert.notEqual(engine.threat.threat, 'RA');
  hold(0.8, 60);
  s = engine.getState();
  assert.equal(s.perspectives.A.ownship.ra, null);
  assert.ok(Math.abs(s.perspectives.A.traffic[0].relAlt + 300 * FT) < 1, `relAlt ${s.perspectives.A.traffic[0].relAlt / FT} ft`);
});

test('vertical limits: no new RA, and only a TA, when already vertically separated', () => {
  const v = new LiveVertical(config.live);
  const horizontal = (level) => ({ threat: ['other', 'proximate', 'TA', 'RA'][level], level, reason: 'range', ttc: null });
  assert.equal(v.combine(horizontal(3)).threat, 'RA'); // 300 ft: inside the 700 ft RA limit
  v.raActive = false;
  v.alt.B = v.alt.A - 800 * FT;
  assert.equal(v.combine(horizontal(3)).threat, 'TA'); // 800 ft: outside RA, inside TA (850 ft)
  assert.equal(v.combine(horizontal(3)).reason, 'vertical');
  v.alt.B = v.alt.A - 1000 * FT;
  assert.equal(v.combine(horizontal(3)).threat, 'proximate');
  v.alt.B = v.alt.A - 1300 * FT;
  assert.equal(v.combine(horizontal(2)).threat, 'other');
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
  for (const bad of [{ taIn: 5, raIn: 10 }, { proximateIn: 0 }, { raIn: -3 }, { taIn: 'abc' }, { raTtc: 99, taTtc: 1 }]) {
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
  const defaults = structuredClone(config.zones);
  engine.applySettings({ proximateIn: 50, taIn: 40, raIn: 30 });
  assert.deepEqual(config.zones, defaults);
});

test('settings round-trip through the saved file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxdemo-'));
  const file = path.join(dir, 'settings.json');
  const a = { zones: structuredClone(config.zones) };
  assert.deepEqual(applySettings(a, { proximateIn: 30, taIn: 15, raIn: 8, taTtc: 3, raTtc: 1.5 }), { ok: true });
  saveSettings(a, file);

  const b = { zones: structuredClone(config.zones) };
  loadSettings(b, file);
  assert.deepEqual(readSettings(b), readSettings(a));
  assert.ok(Math.abs(b.zones.RA.range - 8 * INCH) < 1e-12);

  // A missing or corrupt file leaves the defaults.
  const c = { zones: structuredClone(config.zones) };
  fs.writeFileSync(file, '{not json');
  loadSettings(c, file);
  loadSettings(c, path.join(dir, 'missing.json'));
  assert.deepEqual(readSettings(c), readSettings({ zones: config.zones }));
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
