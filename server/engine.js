// Transport-independent core: per-phone state, ranging, fusion, collision and the
// dashboard state snapshot. The WebSocket layer (index.js) and tests drive it.
// While a simulated airspace is streaming (tools/mock-airspace.js), it takes over: its
// A–B pair drives the threat and its TCAS pictures are the dashboard's perspectives.

import fs from 'node:fs';
import path from 'node:path';
import { MSG, PHONE_IDS, THREAT } from '../shared/protocol.js';
import { RangingSession } from './ranging/session.js';
import { solveK } from './ranging/beepbeep.js';
import { RangeFilter } from './fusion/rangeFilter.js';
import { OrientationTracker } from './fusion/orientation.js';
import { ActivityTracker } from './fusion/activity.js';
import { ClockSync } from './fusion/clock.js';
import { gpsRange, gpsRelativeAltitude } from './fusion/gps.js';
import { CollisionEvaluator, selectRaSenses } from './collision.js';
import { INCH, applySettings, loadSettings, readSettings, saveSettings } from './settings.js';
import { LiveVertical, liveScale } from './live.js';

const NM = 1852; // m

class RateCounter {
  constructor() {
    this.events = [];
  }
  hit(t) {
    this.events.push(t);
  }
  rate(t) {
    while (this.events.length && t - this.events[0] > 1) this.events.shift();
    return this.events.length;
  }
}

function newPhone() {
  return {
    connected: false,
    send: null,
    sampleRate: null,
    ua: null,
    orientation: new OrientationTracker(),
    activity: new ActivityTracker(),
    clock: new ClockSync(),
    gps: null,
    lastMotion: null,
    lastMotionAt: -Infinity,
    latencyMs: null,
    rates: { motion: new RateCounter(), audio: new RateCounter(), gps: new RateCounter() },
  };
}

export class Engine {
  /**
   * @param {object} config see server/config.js
   * @param {object} [opts]
   * @param {() => number} [opts.now] seconds
   * @param {boolean} [opts.persist=true] load/save calibration from disk
   */
  constructor(config, { now = () => performance.now() / 1000, persist = true } = {}) {
    // The live settings (scale and zones) are edited at runtime, so this engine gets its own
    // copy of them rather than mutating the shared config.
    this.cfg = { ...config, zones: structuredClone(config.zones) };
    this.now = now;
    this.persist = persist;
    this.settingsError = null; // why the last settings update was rejected, if it was
    if (persist) loadSettings(this.cfg, this.cfg.settings.file);
    this.phones = { A: newPhone(), B: newPhone() };
    this.filter = new RangeFilter(config.filter);
    this.collision = new CollisionEvaluator(this.cfg.zones);
    this.K = config.ranging.defaultK;
    this.calibrated = false;
    this.calibration = { state: 'idle', target: null, raws: [] };
    this.lastAcoustic = null; // { t, raw, distance, snr }
    // Ultrasonic boards (ESP32, /device WebSocket): latest reading per board id, and the last
    // one that went into the filter.
    this.ultrasonic = { boards: new Map(), last: null }; // boards: id -> { t, range|null }; last: { t, id, range, accepted }
    this.lastGpsUsedAt = -Infinity;
    this.lastPingAt = -Infinity;
    this.threat = { threat: 'other', level: 0, reason: 'no-data', ttc: null };
    this.raSenses = null; // { A, B } complementary senses, latched for the life of an RA
    this.listeners = { alert: [] };
    this.airspace = null; // { data, receivedAt } from the airspace simulator
    this.vertical = new LiveVertical(this.cfg.live); // live demo's sample altitudes
    this.lastTickAt = null;

    this.ranging = new RangingSession(config.ranging, {
      send: (id, msg) => this._send(id, msg),
      now: this.now,
      onMeasurement: (m) => this._onAcoustic(m),
    });
    if (persist) this._loadCalibration();
  }

  on(event, fn) {
    this.listeners[event].push(fn);
  }

  _send(id, msg) {
    const p = this.phones[id];
    if (p.connected && p.send) p.send(msg);
  }

  // ---- phone lifecycle -----------------------------------------------------------

  connectPhone(id, { sampleRate, ua, send }) {
    const p = newPhone();
    Object.assign(p, { connected: true, send, sampleRate, ua });
    this.phones[id] = p;
    this.ranging.connect(id, sampleRate);
    send({ t: MSG.WELCOME, id });
    send({ t: MSG.ALERT, level: this.threat.threat });
  }

  disconnectPhone(id) {
    this.phones[id].connected = false;
    this.phones[id].send = null;
    this.ranging.disconnect(id);
  }

  handlePhoneMessage(id, msg) {
    const p = this.phones[id];
    const t = this.now();
    switch (msg.t) {
      case MSG.MOTION: {
        p.orientation.update(msg);
        p.activity.update(msg);
        p.lastMotion = msg;
        p.lastMotionAt = t;
        p.rates.motion.hit(t);
        const sent = p.clock.toServer(msg.ts);
        if (sent !== null) p.latencyMs = t * 1000 - sent;
        break;
      }
      case MSG.GPS:
        p.gps = { ...msg, receivedAt: t };
        p.rates.gps.hit(t);
        this._maybeUseGps();
        break;
      case MSG.CHIRPED:
        this.ranging.onChirped(id, msg.seq, msg.frame);
        break;
      case MSG.PONG:
        p.clock.add(msg.s, msg.c, t * 1000);
        break;
    }
  }

  handleAudio(id, firstSampleIndex, pcm) {
    if (!this.phones[id].connected) return;
    this.phones[id].rates.audio.hit(this.now());
    this.ranging.pushAudio(id, firstSampleIndex, pcm);
  }

  // ---- ultrasonic boards ------------------------------------------------------------

  /**
   * One ultrasonic reading from an ESP32 board. Both boards measure the same A–B gap, so each
   * reading is an independent measurement for the one range filter. `range` is metres; null
   * (or outside the sensor's limits) means no echo and is recorded but not filtered.
   */
  handleRange(id, msg) {
    const t = this.now();
    const { minRange, maxRange } = this.cfg.ultrasonic;
    const r = Number.isFinite(msg.range) ? msg.range : null;
    const echo = r !== null && r >= minRange && r <= maxRange;
    this.ultrasonic.boards.set(id, { t, range: echo ? r : null });
    if (!echo) return;
    // The boards are moved by hand, so use the moving process noise regardless of the phones.
    const res = this.filter.update(r, this.cfg.filter.sigmaUltrasonic ** 2, t, { moving: true, still: false });
    this.ultrasonic.last = { t, id, range: r, accepted: res.accepted };
  }

  _ultrasonicStatus(b, t) {
    if (t - b.t > this.cfg.ultrasonic.signalTimeoutSeconds) return 'no-signal';
    return b.range === null ? 'no-echo' : 'ok';
  }

  // ---- live demo settings (scale and zones) -----------------------------------------

  /** Apply a dashboard `settings` message; a rejected update changes nothing. */
  applySettings(input) {
    const res = applySettings(this.cfg, input);
    this.settingsError = res.ok ? null : res.error;
    if (res.ok && this.persist) saveSettings(this.cfg, this.cfg.settings.file);
    return res;
  }

  _settingsState() {
    const round = (v) => Math.round(v * 100) / 100;
    const s = readSettings(this.cfg);
    const nm = (k) => round(this.cfg.live.displayZones[k] / NM);
    return {
      proximateIn: round(s.proximateIn),
      taIn: round(s.taIn),
      raIn: round(s.raIn),
      taTtc: s.taTtc,
      raTtc: s.raTtc,
      zonesNm: { proximate: nm('proximate'), TA: nm('TA'), RA: nm('RA') }, // where each zone is drawn
      error: this.settingsError,
    };
  }

  // ---- simulated airspace -----------------------------------------------------------

  setAirspace(msg) {
    if (!msg?.pair || !msg.perspectives?.A || !msg.perspectives?.B || !Array.isArray(msg.aircraft)) return;
    this.airspace = { data: msg, receivedAt: this.now() };
  }

  clearAirspace() {
    this.airspace = null;
  }

  _airspaceLive(t = this.now()) {
    return this.airspace !== null && t - this.airspace.receivedAt < this.cfg.airspaceFreshSeconds;
  }

  // Live ultrasonic demo: boards have reported and no simulator is streaming.
  _liveActive(t = this.now()) {
    return !this._airspaceLive(t) && this.ultrasonic.boards.size > 0;
  }

  // ---- calibration ----------------------------------------------------------------

  calibrate(distance = this.cfg.calibration.defaultDistance) {
    this.calibration = { state: 'collecting', target: distance, raws: [] };
  }

  _onCalibrationSample(raw) {
    const c = this.calibration;
    c.raws.push(raw);
    if (c.raws.length < this.cfg.calibration.samples) return;
    this.K = solveK(c.raws, c.target);
    this.calibrated = true;
    this.calibration = { state: 'done', target: c.target, raws: [] };
    this.filter.reset();
    if (this.persist) this._saveCalibration();
  }

  _loadCalibration() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.cfg.calibration.file, 'utf8'));
      if (Number.isFinite(saved.K)) {
        this.K = saved.K;
        this.calibrated = true;
      }
    } catch {
      // no saved calibration yet
    }
  }

  _saveCalibration() {
    const file = this.cfg.calibration.file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ K: this.K, savedAt: new Date().toISOString() }, null, 2));
  }

  // ---- fusion ---------------------------------------------------------------------

  _motionState() {
    const { A, B } = this.phones;
    const moving = A.activity.moving || B.activity.moving;
    const still = A.activity.seen && B.activity.seen && !A.activity.moving && !B.activity.moving;
    return { moving, still };
  }

  _onAcoustic(m) {
    const { minDistance, maxDistance } = this.cfg.ranging;
    const distance = m.raw + this.K;
    if (this.calibration.state === 'collecting') this._onCalibrationSample(m.raw);
    if (distance < minDistance || distance > maxDistance) return;
    const res = this.filter.update(Math.max(0, distance), this.cfg.filter.sigmaAcoustic ** 2, m.t, this._motionState());
    this.lastAcoustic = { t: m.t, raw: m.raw, distance, snr: m.snr, accepted: res.accepted };
  }

  _maybeUseGps() {
    const t = this.now();
    const { A, B } = this.phones;
    const fresh = (p) => p.gps && t - p.gps.receivedAt < this.cfg.gps.freshMs / 1000;
    if (!fresh(A) || !fresh(B)) return;
    const acousticAge = this.lastAcoustic ? t - this.lastAcoustic.t : Infinity;
    const est = this.filter.estimate(t);
    const far = est && est.range > this.cfg.gps.useAboveRange;
    if (acousticAge * 1000 < this.cfg.gps.useWhenAcousticAbsentMs && !far) return;
    const g = gpsRange(A.gps, B.gps);
    if (!g) return;
    this.filter.update(g.range, g.variance, t, this._motionState());
    this.lastGpsUsedAt = t;
  }

  _rangeSource(t) {
    if (!this.filter.initialized) return 'none';
    if (t - this.filter.t > this.cfg.filter.staleAfter) return 'stale';
    if (this.lastAcoustic && t - this.lastAcoustic.t < 1) return 'acoustic';
    const us = this.ultrasonic.last;
    if (us && us.accepted && t - us.t < this.cfg.ultrasonic.freshSeconds) return 'ultrasonic';
    if (t - this.lastGpsUsedAt < 3) return 'gps';
    return 'predicted';
  }

  // ---- main loop ------------------------------------------------------------------

  tick() {
    const t = this.now();
    const dt = this.lastTickAt === null ? 0 : t - this.lastTickAt;
    this.lastTickAt = t;
    this.ranging.tick();

    if (t - this.lastPingAt >= this.cfg.pingIntervalMs / 1000) {
      this.lastPingAt = t;
      for (const id of PHONE_IDS) this._send(id, { t: MSG.PING, s: t * 1000 });
    }

    const prev = this.threat.threat;
    if (this._airspaceLive(t)) {
      const pair = this.airspace.data.pair;
      const level = Math.max(0, THREAT.indexOf(pair.threat));
      this.threat = { threat: THREAT[level], level, reason: 'tau', ttc: pair.tau };
      this.estimate = { range: pair.range, rate: pair.rangeRate, sigma: null };
      this.source = 'sim';
      this.raSenses = null; // the simulator coordinates its own aircraft
    } else {
      const { moving } = this._motionState();
      const est = this.filter.estimate(t, moving);
      const source = this._rangeSource(t);
      const valid = est !== null && source !== 'stale';
      const horizontal = this.collision.evaluate(
        { range: est ? est.range : null, closingSpeed: est ? -est.rate : 0, valid },
        t,
      );
      // Live demo: the sample altitudes apply the TCAS vertical limits and pick the RA senses.
      const live = this._liveActive(t);
      this.threat = live ? this.vertical.combine(horizontal) : horizontal;
      this.estimate = est;
      this.source = source;
      const relAlt = live ? this.vertical.relAlt : gpsRelativeAltitude(this.phones.A.gps, this.phones.B.gps);
      if (this.threat.threat !== 'RA') this.raSenses = null;
      else this.raSenses ??= selectRaSenses(relAlt, this.cfg.ra.senseAltThreshold);
      if (live) this.vertical.step(dt, this.raSenses);
    }
    if (this.threat.threat !== prev) {
      for (const id of PHONE_IDS) this._send(id, { t: MSG.ALERT, level: this.threat.threat });
      for (const fn of this.listeners.alert) fn(this.threat, prev);
    }
  }

  // Ultrasonic boards stand in for the phones: the other node is traffic while its phone is
  // connected or any board is still reporting, even between accepted readings.
  _nodePresent(id, t) {
    if (this.phones[id].connected) return true;
    const timeout = this.cfg.ultrasonic.signalTimeoutSeconds;
    return [...this.ultrasonic.boards.values()].some((b) => t - b.t <= timeout);
  }

  _perspective(ownId, otherId, range, relAlt, t) {
    const usable = range.source !== 'stale' && range.source !== 'none'; // no frozen positions
    return {
      ownship: {
        id: ownId,
        heading: this.phones[ownId].orientation.heading,
        mode: 'TA/RA',
        ra: this.raSenses ? { sense: this.raSenses[ownId], intruder: otherId } : null,
      },
      traffic: this._nodePresent(otherId, t)
        ? [
            {
              id: otherId,
              range: usable ? range.range : null,
              rangeRate: range.rangeRate,
              bearing: null, // not observable with range-only sensing
              relAlt,
              relAltRate: null,
              threat: this.threat.threat,
            },
          ]
        : [],
    };
  }

  /**
   * Live demo picture: the real ultrasonic gap on one axis, drawn as the TCAS demo's airspace.
   * A and B fly head-on (A east, B west), each dead ahead of the other (bearing 0). The gap is
   * drawn through liveScale, so each zone boundary sits on its real-world TCAS radius, and
   * the altitudes are the sample ones from LiveVertical. Everything here is in display units
   * (metres of the simulated airspace, like tools/sim/airspace.js); the real gap is in
   * `live.range`. Threat levels still come from the real-unit zones.
   * @param {{ range, rangeRate, source }} real the filtered real range (m, m/s)
   */
  _liveFrame(real, t) {
    const display = this.cfg.live.displayZones;
    const scale = liveScale(this.cfg.zones, display);
    const usable = real.range !== null && real.source !== 'stale' && real.source !== 'none'; // no frozen positions
    const sep = usable ? scale.toDisplay(real.range) : null;
    const rate = usable ? real.rangeRate * scale.slope(real.range) : null;
    const gs = usable ? Math.abs(rate) / 2 : null; // each node covers half the closing speed
    const senses = this.raSenses;
    const { alt, vs } = this.vertical;
    const remaining = senses ? this.vertical.remaining() : null;

    const aircraft = usable
      ? [
          { id: 'A', tcas: true, x: -sep / 2, y: 0, alt: alt.A, trk: 90, gs, vs: vs.A, ra: senses ? senses.A : null },
          { id: 'B', tcas: true, x: sep / 2, y: 0, alt: alt.B, trk: 270, gs, vs: vs.B, ra: senses ? senses.B : null },
        ]
      : [];
    const picture = (ownId, otherId, heading) => ({
      ownship: {
        id: ownId,
        heading,
        groundSpeed: gs,
        trueAirspeed: null,
        wind: null,
        altitude: alt[ownId],
        verticalSpeed: vs[ownId],
        mode: 'TA/RA',
        // remaining: metres still to climb / descend to safe separation (0: level off).
        ra: senses ? { sense: senses[ownId], intruder: otherId, remaining, target: this.vertical.safeSeparation } : null,
      },
      traffic: this._nodePresent(otherId, t)
        ? [{ id: otherId, range: sep, rangeRate: rate, bearing: 0, relAlt: alt[otherId] - alt[ownId], relAltRate: vs[otherId], threat: this.threat.threat }]
        : [],
      nav: null,
    });
    return {
      aircraft,
      perspectives: { A: picture('A', 'B', 90), B: picture('B', 'A', 270) },
      range: { range: sep, rangeRate: rate, closingSpeed: usable ? -rate : null, sigma: null, ttc: this.threat.ttc, source: real.source },
      live: {
        range: usable ? real.range : null,
        // Each zone's real start and where it is drawn, outermost first.
        zones: ['proximate', 'TA', 'RA'].map((level) => ({ level, in: this.cfg.zones[level].range / INCH, nm: display[level] / NM })),
      },
    };
  }

  getState() {
    const t = this.now();
    const est = this.estimate ?? null;
    const phoneState = (id) => {
      const p = this.phones[id];
      return {
        connected: p.connected,
        sampleRate: p.sampleRate,
        orientation: p.orientation.q,
        heading: p.orientation.heading,
        northAligned: p.orientation.northAligned,
        moving: p.activity.moving,
        motionAgeMs: Number.isFinite(p.lastMotionAt) ? Math.round((t - p.lastMotionAt) * 1000) : null,
        latencyMs: p.latencyMs === null ? null : Math.round(p.latencyMs),
        rttMs: p.clock.rtt === null ? null : Math.round(p.clock.rtt),
        rates: { motion: p.rates.motion.rate(t), audio: p.rates.audio.rate(t), gps: p.rates.gps.rate(t) },
        gps: p.gps ? { lat: p.gps.lat, lon: p.gps.lon, acc: p.gps.acc, alt: p.gps.alt } : null,
      };
    };
    const relAlt = gpsRelativeAltitude(this.phones.A.gps, this.phones.B.gps);
    const sim = this._airspaceLive(t) ? this.airspace.data : null;
    // Real filtered range in metres, whatever the source.
    const real = est
      ? {
          range: est.range,
          rangeRate: est.rate,
          closingSpeed: -est.rate,
          sigma: est.sigma,
          ttc: this.threat.ttc,
          source: this.source,
        }
      : { range: null, rangeRate: null, closingSpeed: null, sigma: null, ttc: null, source: this.source ?? 'none' };
    // Ultrasonic boards present (and no simulator): show the demo UI with the real gap scaled in.
    const live = this._liveActive(t) ? this._liveFrame(real, t) : null;
    const range = sim
      ? {
          range: sim.pair.range,
          rangeRate: sim.pair.rangeRate,
          closingSpeed: sim.pair.closingSpeed,
          sigma: null,
          ttc: sim.pair.tau,
          source: 'sim',
        }
      : live
      ? live.range
      : real;

    return {
      t: MSG.STATE,
      serverTime: t * 1000,
      // 'phones': the two phones' ranging pipeline. 'airspace': the TCAS demo, fed either by the
      // simulator or by the live ultrasonic gap (`live`); range, perspectives and aircraft are
      // then in display units and the real gap and scale are in `live`.
      mode: sim || live ? 'airspace' : 'phones',
      airspace: sim
        ? { simTime: sim.simTime, loop: sim.loop, aircraft: sim.aircraft }
        : live
        ? { simTime: t, loop: 0, aircraft: live.aircraft }
        : null,
      live: live ? live.live : null,
      settings: this._settingsState(),
      phones: { A: phoneState('A'), B: phoneState('B') },
      range,
      acoustic: {
        last: this.lastAcoustic
          ? { ageMs: Math.round((t - this.lastAcoustic.t) * 1000), distance: this.lastAcoustic.distance, snr: this.lastAcoustic.snr, accepted: this.lastAcoustic.accepted }
          : null,
        successRate: this.ranging.successRate(),
        lastFailure: this.ranging.stats.lastFailure,
        running: this.ranging.ready(),
      },
      ultrasonic: {
        boards: [...this.ultrasonic.boards].map(([id, b]) => ({
          id,
          range: b.range,
          status: this._ultrasonicStatus(b, t),
          ageMs: Math.round((t - b.t) * 1000),
        })),
        last: this.ultrasonic.last
          ? { ageMs: Math.round((t - this.ultrasonic.last.t) * 1000), id: this.ultrasonic.last.id, range: this.ultrasonic.last.range, accepted: this.ultrasonic.last.accepted }
          : null,
      },
      threat: { level: this.threat.threat, reason: this.threat.reason },
      // TCAS-style traffic pictures, one per phone: that phone is "own ship", the other is
      // traffic. Range and threat are symmetric; relative altitude flips sign.
      perspectives: sim
        ? sim.perspectives
        : live
        ? live.perspectives
        : {
            A: this._perspective('A', 'B', range, relAlt, t),
            B: this._perspective('B', 'A', range, relAlt === null ? null : -relAlt, t),
          },
      calibration: {
        state: this.calibration.state,
        progress: this.calibration.raws.length / this.cfg.calibration.samples,
        target: this.calibration.target,
        K: this.K,
        calibrated: this.calibrated,
      },
      zones: this.cfg.zones,
    };
  }
}
