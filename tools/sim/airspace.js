// Simulated airspace for the TCAS demo: two TCAS-equipped aircraft (A and B) on a head-on
// collision course plus surrounding transponder traffic that is never a threat, chosen to
// show every traffic symbol. Each TCAS aircraft runs a simplified TCAS II v7.1 collision
// avoidance logic (sensitivity level 5, booklet Table 2): range tau / DMOD and vertical
// tests for TAs and RAs, coordinated complementary RA senses, and an automatic response
// (climb or descend at 1500 fpm, then back to the cleared altitude after "clear of
// conflict"). The scenario loops.
// A and B also fly a mock flight plan (ROUTES) in a mock wind (WIND): they hold their
// head-on track to their second waypoint, which lies past the encounter, then turn onto
// the next leg. Navigation math lives in shared/navigation.js.
//
// Internal units are SI (metres, m/s, seconds); x = east, y = north, track clockwise
// from north. The dashboard converts to NM / hundreds of feet / fpm for display.

import { STANDARD_RATE, angleDiff, bearingTo, navPicture, sequenceRoute, trueAirspeed, wrap360 } from '../../shared/navigation.js';

export const NM = 1852;
export const FT = 0.3048;
export const KT = NM / 3600;
export const FPM = FT / 60;
const G = 9.80665;

// Sensitivity level 5 (own altitude 5000–10000 ft).
export const SL5 = {
  taTau: 40,
  raTau: 25,
  taDmod: 0.75 * NM,
  raDmod: 0.55 * NM,
  taZthr: 850 * FT,
  raZthr: 600 * FT,
  alim: 350 * FT,
};
const PROXIMATE = { range: 6 * NM, alt: 1200 * FT };
const SURVEILLANCE_RANGE = 30 * NM;
const RA_RATE = 1500 * FPM;
const RA_ACCEL = 0.25 * G;
const NORMAL_ACCEL = 0.1 * G;
const RETURN_RATE = 1000 * FPM;
const RESPONSE_DELAY = 2; // s, automatic (autopilot/flight-director) response to an RA
const TA_HOLD = 4; // s a TA/RA is held after its criteria stop being met
const LEVEL = { other: 0, proximate: 1, TA: 2, RA: 3 };
const LEVEL_NAMES = ['other', 'proximate', 'TA', 'RA'];

/**
 * Scenario, positions in NM, altitudes in ft, speeds in kt, vertical speeds in fpm.
 * alt: null = transponder without altitude reporting (Mode A).
 * levelOff: altitude where a climbing/descending aircraft levels off.
 */
export const SCENARIO = [
  // The two TCAS aircraft: head-on, 300 ft apart, 0.15 NM lateral offset.
  { id: 'A', x: -5, y: 0, trk: 90, gs: 250, alt: 8000, vs: 0, tcas: true },
  { id: 'B', x: 5, y: 0.15, trk: 270, gs: 250, alt: 7700, vs: 0, tcas: true },
  // Other traffic, never on a collision course.
  { id: 'C', x: -2, y: 5, trk: 90, gs: 240, alt: 9800, vs: 0 }, // other: level, 1800 ft above
  { id: 'D', x: -3.5, y: -3, trk: 90, gs: 230, alt: 9000, vs: 0 }, // proximate to A: 1000 ft above, parallel
  { id: 'E', x: 4, y: -4.5, trk: 200, gs: 210, alt: 10500, vs: -1000, levelOff: 9800 }, // descending, moving away
  { id: 'F', x: 1, y: -2.5, trk: 150, gs: 200, alt: 6800, vs: 800, levelOff: 7300 }, // climbing, moving away
  { id: 'G', x: 1, y: -1.5, trk: 340, gs: 180, alt: 12500, vs: 0 }, // far above: only with the ABV filter
  { id: 'H', x: -9, y: 6, trk: 300, gs: 160, alt: null, vs: 0 }, // no altitude reporting
];

/**
 * Mock flight plans for the TCAS aircraft, positions in NM in the SCENARIO frame. `active`
 * is the TO waypoint at the start; the one before it is the FROM waypoint, behind the
 * aircraft. Each first leg lies on the scenario's head-on track and its turn comes after
 * the encounter, so the TCAS geometry is unchanged. Replace with real flight-plan data
 * in the same shape (see shared/navigation.js).
 */
export const ROUTES = {
  A: { active: 1, waypoints: [{ id: 'A1', x: -9, y: 0 }, { id: 'A2', x: 1.5, y: 0 }, { id: 'A3', x: 6, y: 2 }, { id: 'A4', x: 11, y: 2.5 }] },
  B: { active: 1, waypoints: [{ id: 'B1', x: 9, y: 0.15 }, { id: 'B2', x: -1.5, y: 0.15 }, { id: 'B3', x: -6, y: -1.85 }, { id: 'B4', x: -11, y: -2.35 }] },
};

/** Mock wind, the same air mass for everyone: direction it blows from (deg), speed (kt). */
export const WIND = { direction: 270, speed: 5 };

function makeRoute(r) {
  return r ? { active: r.active, waypoints: r.waypoints.map((w) => ({ id: w.id, x: w.x * NM, y: w.y * NM })) } : null;
}

function makeAircraft(s, routes) {
  return {
    id: s.id,
    tcas: !!s.tcas,
    x: s.x * NM,
    y: s.y * NM,
    trk: s.trk,
    gs: s.gs * KT,
    alt: s.alt === null ? null : s.alt * FT,
    vs: s.vs * FPM,
    cmdVs: s.vs * FPM,
    accel: NORMAL_ACCEL,
    levelOff: s.levelOff === undefined ? null : s.levelOff * FT,
    clearedAlt: s.alt === null ? null : (s.levelOff ?? s.alt) * FT,
    ra: null, // { sense, intruder, since }
    returning: false,
    route: makeRoute(routes[s.id]),
  };
}

const navState = (a) => ({ x: a.x, y: a.y, heading: a.trk, groundSpeed: a.gs });

/** Geometry of intruder `i` seen from own ship `o`. */
export function relative(o, i) {
  const dx = i.x - o.x;
  const dy = i.y - o.y;
  const vox = o.gs * Math.sin((o.trk * Math.PI) / 180);
  const voy = o.gs * Math.cos((o.trk * Math.PI) / 180);
  const vix = i.gs * Math.sin((i.trk * Math.PI) / 180);
  const viy = i.gs * Math.cos((i.trk * Math.PI) / 180);
  const dvx = vix - vox;
  const dvy = viy - voy;
  const range = Math.hypot(dx, dy);
  const altKnown = o.alt !== null && i.alt !== null;
  const relAlt = altKnown ? i.alt - o.alt : null;
  const relAltRate = altKnown ? i.vs - o.vs : null;
  const slant = Math.hypot(range, relAlt ?? 0);
  const rangeRate = slant > 0 ? (dx * dvx + dy * dvy + (relAlt ?? 0) * (relAltRate ?? 0)) / slant : 0;
  const bearingTrue = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  const bearing = (bearingTrue - o.trk + 360) % 360; // relative to own heading
  return { range, slant, rangeRate, relAlt, relAltRate, bearing };
}

// Range test with modified tau: inside DMOD, or closing with (r² − DMOD²) / (r·ṙ) < tau.
function rangeTest(rel, tau, dmod) {
  if (rel.slant < dmod) return true;
  if (rel.rangeRate >= 0) return false;
  return (rel.slant ** 2 - dmod ** 2) / (rel.slant * -rel.rangeRate) < tau;
}

// Vertical test: within ZTHR, or converging to co-altitude within tau.
function verticalTest(rel, tau, zthr) {
  if (Math.abs(rel.relAlt) < zthr) return true;
  const converging = rel.relAlt * rel.relAltRate < 0;
  return converging && Math.abs(rel.relAlt) / Math.abs(rel.relAltRate) < tau;
}

/** Instantaneous threat class of intruder `i` for TCAS own ship `o`. */
export function classify(o, i, rel = relative(o, i), sl = SL5) {
  const altKnown = rel.relAlt !== null;
  if (altKnown && rangeTest(rel, sl.raTau, sl.raDmod) && verticalTest(rel, sl.raTau, sl.raZthr)) return 'RA';
  if (rangeTest(rel, sl.taTau, sl.taDmod) && (!altKnown || verticalTest(rel, sl.taTau, sl.taZthr))) return 'TA';
  if (rel.range < PROXIMATE.range && (!altKnown || Math.abs(rel.relAlt) < PROXIMATE.alt)) return 'proximate';
  return 'other';
}

export class Airspace {
  constructor({ scenario = SCENARIO, routes = ROUTES, wind = WIND, loopSeconds = 150 } = {}) {
    this.scenario = scenario;
    this.routes = routes;
    this.wind = wind ? { direction: wind.direction, speed: wind.speed * KT } : null;
    this.loopSeconds = loopSeconds;
    this.reset();
  }

  reset() {
    this.t = 0;
    this.loop = (this.loop ?? 0) + 1;
    this.aircraft = this.scenario.map((s) => makeAircraft(s, this.routes));
    this.byId = Object.fromEntries(this.aircraft.map((a) => [a.id, a]));
    this.pairs = new Map(); // `${own}>${intruder}` -> { level, heldUntil }
    this.minSeparation = null; // closest A–B approach of this loop
  }

  get ownships() {
    return this.aircraft.filter((a) => a.tcas);
  }

  step(dt) {
    this.t += dt;
    for (const a of this.aircraft) this._fly(a, dt);
    for (const o of this.ownships) this._cas(o);
    this._trackSeparation();
    if (this._loopDone()) this.reset();
  }

  _fly(a, dt) {
    if (a.alt !== null) {
      if (a.levelOff !== null && Math.sign(a.levelOff - a.alt) !== Math.sign(a.cmdVs) && a.cmdVs !== 0 && !a.ra) {
        a.cmdVs = 0;
        a.alt = a.levelOff;
        a.levelOff = null;
      }
      const dv = a.cmdVs - a.vs;
      a.vs += Math.sign(dv) * Math.min(Math.abs(dv), a.accel * dt);
      a.alt += a.vs * dt;
    }
    if (a.route) this._lnav(a, dt);
    a.x += a.gs * Math.sin((a.trk * Math.PI) / 180) * dt;
    a.y += a.gs * Math.cos((a.trk * Math.PI) / 180) * dt;
  }

  // Lateral navigation: sequence the route, then turn towards the TO waypoint at standard rate.
  _lnav(a, dt) {
    sequenceRoute(a.route, navState(a));
    const to = a.route.waypoints[a.route.active];
    if (!to) return; // end of route: hold the track
    const turn = angleDiff(bearingTo(a, to), a.trk);
    a.trk = wrap360(a.trk + Math.sign(turn) * Math.min(Math.abs(turn), STANDARD_RATE * dt));
  }

  _cas(o) {
    for (const i of this.aircraft) {
      if (i === o) continue;
      const rel = relative(o, i);
      const key = `${o.id}>${i.id}`;
      const pair = this.pairs.get(key) ?? { level: 'other', heldUntil: 0 };
      if (rel.range > SURVEILLANCE_RANGE) {
        this.pairs.set(key, { level: 'other', heldUntil: 0 });
        continue;
      }
      const now = classify(o, i, rel);
      let level = now;
      if (LEVEL[now] >= LEVEL[pair.level]) {
        if (LEVEL[now] >= LEVEL.TA) pair.heldUntil = this.t + TA_HOLD;
      } else if (pair.level === 'RA' && rel.rangeRate < 0) {
        level = 'RA'; // an RA stays up until the aircraft are diverging
      } else if (LEVEL[pair.level] >= LEVEL.TA && this.t < pair.heldUntil) {
        level = LEVEL_NAMES[Math.min(LEVEL[pair.level], LEVEL.TA)];
      }
      if (level === 'RA' && pair.level !== 'RA') this._startRa(o, i, rel);
      if (pair.level === 'RA' && level !== 'RA' && o.ra?.intruder === i.id) this._endRa(o);
      pair.level = level;
      this.pairs.set(key, pair);
    }
    // Automatic response once the pilot/autopilot reaction delay has passed.
    if (o.ra && this.t - o.ra.since >= RESPONSE_DELAY) {
      o.accel = RA_ACCEL;
      o.cmdVs = o.ra.sense === 'up' ? Math.max(o.vs, RA_RATE) : Math.min(o.vs, -RA_RATE);
    }
    // After clear of conflict, return to the cleared altitude, then level off.
    if (!o.ra && o.returning) {
      const err = o.clearedAlt - o.alt;
      if (Math.abs(err) < 20 * FT) {
        o.returning = false;
        o.cmdVs = 0;
        o.accel = NORMAL_ACCEL;
      } else {
        o.cmdVs = Math.sign(err) * Math.min(RETURN_RATE, Math.abs(err) * 0.2);
      }
    }
  }

  // Sense selection: coordinate with an intruder that already has an RA against us
  // (complementary sense); otherwise non-crossing, away from the intruder; at co-altitude
  // the lower Mode S address (id) climbs.
  _startRa(o, i, rel) {
    if (o.ra) return;
    let sense;
    if (i.ra && i.ra.intruder === o.id) sense = i.ra.sense === 'up' ? 'down' : 'up';
    else if (Math.abs(rel.relAlt) > 50 * FT) sense = rel.relAlt > 0 ? 'down' : 'up';
    else sense = o.id < i.id ? 'up' : 'down';
    o.ra = { sense, intruder: i.id, since: this.t };
    o.returning = false;
  }

  _endRa(o) {
    o.ra = null;
    o.returning = true;
    o.accel = NORMAL_ACCEL;
  }

  _trackSeparation() {
    const { A, B } = this.byId;
    if (!A || !B) return;
    const rel = relative(A, B);
    if (!this.minSeparation || rel.slant < this.minSeparation.slant) {
      this.minSeparation = { slant: rel.slant, range: rel.range, vertical: Math.abs(rel.relAlt), t: this.t };
    }
  }

  // Loop once A and B are well past each other and back at their cleared altitudes.
  _loopDone() {
    if (this.t > this.loopSeconds) return true;
    const { A, B } = this.byId;
    if (!A || !B) return false;
    const rel = relative(A, B);
    const settled = this.ownships.every((o) => !o.ra && !o.returning);
    return rel.rangeRate > 0 && rel.range > 5 * NM && settled;
  }

  /** Threat level of `intruderId` as seen by TCAS own ship `ownId`. */
  threat(ownId, intruderId) {
    return this.pairs.get(`${ownId}>${intruderId}`)?.level ?? 'other';
  }

  /**
   * TCAS traffic picture for one own ship (the dashboard's state.perspectives entry):
   *   ownship  own-ship state; trueAirspeed and wind ({ direction from, speed }) in SI
   *   traffic  other aircraft, range and bearing relative to own heading
   *   nav      own flight plan (shared/navigation.js navPicture), null without a route.
   *            Kept apart from `traffic`: waypoints are never TCAS targets.
   */
  picture(ownId) {
    const o = this.byId[ownId];
    const traffic = [];
    for (const i of this.aircraft) {
      if (i === o) continue;
      const rel = relative(o, i);
      if (rel.range > SURVEILLANCE_RANGE) continue;
      traffic.push({
        id: i.id,
        range: rel.range,
        rangeRate: rel.rangeRate,
        bearing: rel.bearing,
        relAlt: rel.relAlt,
        relAltRate: rel.relAltRate === null ? null : i.vs, // trend arrow: intruder's own vertical rate
        threat: this.threat(ownId, i.id),
      });
    }
    return {
      ownship: {
        id: o.id,
        heading: o.trk,
        groundSpeed: o.gs,
        trueAirspeed: trueAirspeed(o.trk, o.gs, this.wind),
        wind: this.wind,
        altitude: o.alt,
        verticalSpeed: o.vs,
        mode: 'TA/RA',
        ra: o.ra ? { sense: o.ra.sense, intruder: o.ra.intruder } : null,
      },
      traffic,
      nav: navPicture(navState(o), o.route),
    };
  }

  /** Message body sent by tools/mock-airspace.js to the server. */
  snapshot() {
    const { A, B } = this.byId;
    const rel = relative(A, B);
    const closing = -rel.rangeRate;
    return {
      simTime: this.t,
      loop: this.loop,
      aircraft: this.aircraft.map((a) => ({
        id: a.id,
        tcas: a.tcas,
        x: a.x,
        y: a.y,
        alt: a.alt,
        trk: a.trk,
        gs: a.gs,
        vs: a.vs,
        ra: a.ra ? a.ra.sense : null,
      })),
      perspectives: { A: this.picture('A'), B: this.picture('B') },
      pair: {
        range: rel.slant,
        rangeRate: rel.rangeRate,
        closingSpeed: closing,
        tau: closing > 0 ? rel.slant / closing : null,
        relAlt: rel.relAlt,
        threat: this.threat('A', 'B'),
      },
    };
  }
}
