// Transport-independent core: ultrasonic ranges from the ESP32 boards, the range filter,
// collision and the dashboard state snapshot. The WebSocket layer (index.js, devices.js) and
// tests drive it. While a simulated airspace is streaming (tools/mock-airspace.js), it takes
// over: its A–B pair drives the threat and its TCAS pictures are the dashboard's perspectives.

import { MSG, THREAT } from '../shared/protocol.js';
import { RangeFilter } from './fusion/rangeFilter.js';
import { BoardPrefilter } from './fusion/boardPrefilter.js';
import { CollisionEvaluator, selectRaSenses } from './collision.js';
import { INCH, applySettings, loadSettings, readSettings, saveSettings } from './settings.js';
import { LiveVertical, liveScale } from './live.js';

const NM = 1852; // m

export class Engine {
  /**
   * @param {object} config see server/config.js
   * @param {object} [opts]
   * @param {() => number} [opts.now] seconds
   * @param {boolean} [opts.persist=true] load/save the live demo settings from disk
   */
  constructor(config, { now = () => performance.now() / 1000, persist = true } = {}) {
    // The live settings (scale and zones) are edited at runtime, so this engine gets its own
    // copy of them rather than mutating the shared config.
    this.cfg = { ...config, zones: structuredClone(config.zones) };
    this.now = now;
    this.persist = persist;
    this.settingsError = null; // why the last settings update was rejected, if it was
    if (persist) loadSettings(this.cfg, this.cfg.settings.file);
    this.filter = new RangeFilter(config.filter);
    this.prefilter = new BoardPrefilter(config.ultrasonic);
    this.collision = new CollisionEvaluator(this.cfg.zones);
    // Ultrasonic boards (ESP32, /device WebSocket): latest reading per board id, and the last
    // one that went into the filter.
    // boards: id -> { t, range, echoAt } (range: last cleaned echo); last: { t, id, range, accepted }
    this.ultrasonic = { boards: new Map(), last: null };
    this.threat = { threat: 'other', level: 0, reason: 'no-data', ttc: null };
    this.raSenses = null; // { A, B } complementary senses, latched for the life of an RA
    this.listeners = { alert: [] };
    this.airspace = null; // { data, receivedAt } from the airspace simulator
    this.vertical = new LiveVertical(this.cfg.live); // live demo's sample altitudes
    this.lastTickAt = null;
  }

  on(event, fn) {
    this.listeners[event].push(fn);
  }

  // ---- ultrasonic boards ------------------------------------------------------------

  /**
   * One ultrasonic reading from an ESP32 board. Both boards measure the same A–B gap, so each
   * reading is an independent measurement for the one range filter, after the per-board
   * spike check and offset correction (fusion/boardPrefilter.js). `range` is metres; null (or
   * outside the sensor's limits) means no echo and is recorded but not filtered.
   */
  handleRange(id, msg) {
    const t = this.now();
    const { minRange, maxRange } = this.cfg.ultrasonic;
    const r = Number.isFinite(msg.range) ? msg.range : null;
    const echo = r !== null && r >= minRange && r <= maxRange;
    const board = this.ultrasonic.boards.get(id) ?? { t, range: null, echoAt: -Infinity };
    this.ultrasonic.boards.set(id, board);
    board.t = t;
    if (!echo) return;
    const clean = this.prefilter.despike(id, r, t);
    const z = clean - this.prefilter.correction(id, t);
    const predicted = this.filter.estimate(t);
    const res = this.filter.update(z, this.cfg.filter.sigmaUltrasonic ** 2, t);
    if (res.accepted && !res.reinitialized && predicted) this.prefilter.learn(id, clean - predicted.range);
    board.range = z;
    board.echoAt = t;
    this.ultrasonic.last = { t, id, range: z, accepted: res.accepted };
  }

  // A single missed echo is normal for these sensors, so a board shows "no echo" only after
  // none has come back for a while.
  _ultrasonicStatus(b, t) {
    if (t - b.t > this.cfg.ultrasonic.signalTimeoutSeconds) return 'no-signal';
    return t - b.echoAt > this.cfg.ultrasonic.noEchoSeconds ? 'no-echo' : 'ok';
  }

  // The other node is traffic while any board is still reporting, even between accepted readings.
  _boardsReporting(t) {
    const timeout = this.cfg.ultrasonic.signalTimeoutSeconds;
    return [...this.ultrasonic.boards.values()].some((b) => t - b.t <= timeout);
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

  // ---- range ------------------------------------------------------------------------

  _rangeSource(t) {
    if (!this.filter.initialized) return 'none';
    if (t - this.filter.t > this.cfg.filter.staleAfter) return 'stale';
    const us = this.ultrasonic.last;
    if (us && us.accepted && t - us.t < this.cfg.ultrasonic.freshSeconds) return 'ultrasonic';
    return 'predicted';
  }

  // ---- main loop ------------------------------------------------------------------

  tick() {
    const t = this.now();
    const dt = this.lastTickAt === null ? 0 : t - this.lastTickAt;
    this.lastTickAt = t;

    const prev = this.threat.threat;
    if (this._airspaceLive(t)) {
      const pair = this.airspace.data.pair;
      const level = Math.max(0, THREAT.indexOf(pair.threat));
      this.threat = { threat: THREAT[level], level, reason: 'tau', ttc: pair.tau };
      this.estimate = { range: pair.range, rate: pair.rangeRate, sigma: null };
      this.source = 'sim';
      this.raSenses = null; // the simulator coordinates its own aircraft
    } else {
      const est = this.filter.estimate(t);
      const source = this._rangeSource(t);
      const valid = est !== null && source !== 'stale';
      const horizontal = this.collision.evaluate(
        { range: est ? est.range : null, closingSpeed: est ? -est.rate : 0, valid },
        t,
      );
      // The sample altitudes apply the TCAS vertical limits and pick the RA senses.
      this.threat = this.vertical.combine(horizontal);
      this.estimate = est;
      this.source = source;
      if (this.threat.threat !== 'RA') this.raSenses = null;
      else this.raSenses ??= selectRaSenses(this.vertical.relAlt, this.cfg.ra.senseAltThreshold);
      this.vertical.step(dt, this.raSenses);
    }
    if (this.threat.threat !== prev) {
      for (const fn of this.listeners.alert) fn(this.threat, prev);
    }
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
    const present = this._boardsReporting(t);

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
      traffic: present
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
    const sim = this._airspaceLive(t) ? this.airspace.data : null;
    // Real filtered range in metres.
    const real = est
      ? { range: est.range, rangeRate: est.rate, source: this.source }
      : { range: null, rangeRate: null, source: this.source ?? 'none' };
    // No simulator: the TCAS demo UI with the real ultrasonic gap scaled in.
    const live = sim ? null : this._liveFrame(real, t);
    const range = sim
      ? {
          range: sim.pair.range,
          rangeRate: sim.pair.rangeRate,
          closingSpeed: sim.pair.closingSpeed,
          sigma: null,
          ttc: sim.pair.tau,
          source: 'sim',
        }
      : live.range;

    return {
      t: MSG.STATE,
      serverTime: t * 1000,
      // 'sim': the airspace simulator drives the display. 'live': the ultrasonic boards do; the
      // real gap and the zone scale are then in `live`. Either way range, perspectives and
      // aircraft are in display units (metres of the airspace, shown in NM).
      mode: sim ? 'sim' : 'live',
      airspace: sim
        ? { simTime: sim.simTime, loop: sim.loop, aircraft: sim.aircraft }
        : { simTime: t, loop: 0, aircraft: live.aircraft },
      live: live ? live.live : null,
      settings: this._settingsState(),
      range,
      ultrasonic: {
        boards: [...this.ultrasonic.boards].map(([id, b]) => {
          const status = this._ultrasonicStatus(b, t);
          return { id, range: status === 'ok' ? b.range : null, status, ageMs: Math.round((t - b.t) * 1000) };
        }),
        last: this.ultrasonic.last
          ? { ageMs: Math.round((t - this.ultrasonic.last.t) * 1000), id: this.ultrasonic.last.id, range: this.ultrasonic.last.range, accepted: this.ultrasonic.last.accepted }
          : null,
        sigma: est && !sim ? est.sigma : null, // filter uncertainty of the real gap (m)
      },
      threat: { level: this.threat.threat, reason: this.threat.reason },
      // TCAS-style traffic pictures, one per node: that node is "own ship", the other is traffic.
      perspectives: sim ? sim.perspectives : live.perspectives,
      zones: this.cfg.zones,
    };
  }
}
