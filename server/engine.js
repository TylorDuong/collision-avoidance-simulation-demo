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
import { CollisionEvaluator } from './collision.js';

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
    this.cfg = config;
    this.now = now;
    this.persist = persist;
    this.phones = { A: newPhone(), B: newPhone() };
    this.filter = new RangeFilter(config.filter);
    this.collision = new CollisionEvaluator(config.zones);
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
    this.listeners = { alert: [] };
    this.airspace = null; // { data, receivedAt } from the airspace simulator

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
    } else {
      const { moving } = this._motionState();
      const est = this.filter.estimate(t, moving);
      const source = this._rangeSource(t);
      const valid = est !== null && source !== 'stale';
      this.threat = this.collision.evaluate(
        { range: est ? est.range : null, closingSpeed: est ? -est.rate : 0, valid },
        t,
      );
      this.estimate = est;
      this.source = source;
    }
    if (this.threat.threat !== prev) {
      for (const id of PHONE_IDS) this._send(id, { t: MSG.ALERT, level: this.threat.threat });
      for (const fn of this.listeners.alert) fn(this.threat, prev);
    }
  }

  _perspective(ownId, otherId, range, relAlt) {
    return {
      ownship: { id: ownId, heading: this.phones[ownId].orientation.heading, mode: 'TA/RA' },
      // Ultrasonic boards stand in for the phones: the other node is traffic whenever a live
      // ultrasonic range exists, even with no phone connected.
      traffic: this.phones[otherId].connected || range.source === 'ultrasonic'
        ? [
            {
              id: otherId,
              range: range.range,
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
    const range = sim
      ? {
          range: sim.pair.range,
          rangeRate: sim.pair.rangeRate,
          closingSpeed: sim.pair.closingSpeed,
          sigma: null,
          ttc: sim.pair.tau,
          source: 'sim',
        }
      : est
      ? {
          range: est.range,
          rangeRate: est.rate,
          closingSpeed: -est.rate,
          sigma: est.sigma,
          ttc: this.threat.ttc,
          source: this.source,
        }
      : { range: null, rangeRate: null, closingSpeed: null, sigma: null, ttc: null, source: this.source ?? 'none' };

    return {
      t: MSG.STATE,
      serverTime: t * 1000,
      // 'phones': the two phones' ranging pipeline. 'airspace': the TCAS demo simulator.
      mode: sim ? 'airspace' : 'phones',
      airspace: sim ? { simTime: sim.simTime, loop: sim.loop, aircraft: sim.aircraft } : null,
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
        : {
            A: this._perspective('A', 'B', range, relAlt),
            B: this._perspective('B', 'A', range, relAlt === null ? null : -relAlt),
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
