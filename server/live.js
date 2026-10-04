// Live ultrasonic demo, drawn as the TCAS demo's airspace (see Engine._liveFrame):
//   - liveScale: maps the real board gap onto display distance so that each threat zone's
//     boundary (real inches, user-editable) lands on its real-world TCAS radius (NM).
//   - LiveVertical: sample altitudes for A and B, since the boards measure distance only. The
//     two fly 300 ft apart; during an RA they climb / descend apart at 1500 fpm until they
//     reach the RA's vertical limit (safe separation), then level off, and return to their
//     sample altitudes once the RA is over. It also applies the TCAS vertical limits to the
//     horizontal threat level.
// Display units are SI metres of the simulated airspace, like tools/sim/airspace.js.

import { THREAT } from '../shared/protocol.js';

const LEVEL = { other: 0, proximate: 1, TA: 2, RA: 3 };

/**
 * Piecewise-linear, monotonic map from the real gap (m) to display distance (m) through the
 * anchors 0 -> 0, RA, TA and proximate zone -> their display radii. Past the proximate zone
 * it continues with the last segment's slope.
 * @param {{ RA: {range}, TA: {range}, proximate: {range} }} zones real zones (m)
 * @param {{ RA: number, TA: number, proximate: number }} displayZones display radii (m)
 * @returns {{ toDisplay: (m: number) => number, slope: (m: number) => number }}
 */
export function liveScale(zones, displayZones) {
  const pts = [[0, 0], ...['RA', 'TA', 'proximate'].map((k) => [zones[k].range, displayZones[k]])];
  const segment = (r) => {
    for (let i = 1; i < pts.length - 1; i++) if (r <= pts[i][0]) return i;
    return pts.length - 1;
  };
  const slope = (r) => {
    const i = segment(r);
    return (pts[i][1] - pts[i - 1][1]) / (pts[i][0] - pts[i - 1][0]);
  };
  return {
    toDisplay: (r) => {
      const i = segment(r);
      return pts[i - 1][1] + (r - pts[i - 1][0]) * slope(r);
    },
    slope,
  };
}

export class LiveVertical {
  /** @param {object} live config.live: `verticalZones` and `sample` */
  constructor(live) {
    this.v = live.verticalZones;
    this.s = live.sample;
    this.cleared = { A: this.s.altitude, B: this.s.altitude + this.s.relAlt };
    this.alt = { ...this.cleared };
    this.vs = { A: 0, B: 0 };
    this.raActive = false;
  }

  /** B's altitude minus A's (m). */
  get relAlt() {
    return this.alt.B - this.alt.A;
  }

  /** Vertical separation an RA climbs / descends to (m): the RA's vertical limit. */
  get safeSeparation() {
    return this.v.RA;
  }

  /** Metres each aircraft still has to climb or descend during an RA (both manoeuvre). */
  remaining() {
    return Math.max(0, (this.safeSeparation - Math.abs(this.relAlt)) / 2);
  }

  /**
   * Cap the horizontal threat by the vertical limits: proximate, TA and a new RA each need
   * the vertical separation inside their limit. An RA already in progress stays while the
   * horizontal level is RA, so climbing away does not cancel it.
   * @param {{ threat, level, reason, ttc }} horizontal CollisionEvaluator result
   */
  combine(horizontal) {
    const sep = Math.abs(this.relAlt);
    const h = horizontal.level;
    let level = LEVEL.other;
    if (h >= LEVEL.RA && (this.raActive || sep < this.v.RA)) level = LEVEL.RA;
    else if (h >= LEVEL.TA && sep < this.v.TA) level = LEVEL.TA;
    else if (h >= LEVEL.proximate && sep < this.v.proximate) level = LEVEL.proximate;
    this.raActive = level === LEVEL.RA;
    return { ...horizontal, threat: THREAT[level], level, reason: level < h ? 'vertical' : horizontal.reason };
  }

  /**
   * Advance the sample altitudes by `dt` seconds.
   * @param {{ A: 'up'|'down', B: 'up'|'down' } | null} senses RA senses, null outside an RA
   */
  step(dt, senses) {
    if (!(dt > 0)) return;
    const remaining = this.remaining();
    for (const id of ['A', 'B']) {
      let target;
      let accel;
      if (senses) {
        // Climb / descend at the RA rate, levelling off one stopping distance before the
        // separation is safe so it settles on it.
        accel = this.s.raAccel;
        const stopping = this.vs[id] ** 2 / (2 * accel);
        target = remaining > stopping ? (senses[id] === 'up' ? 1 : -1) * this.s.raRate : 0;
      } else {
        // Back to the sample altitude, easing in so it does not overshoot.
        const diff = this.cleared[id] - this.alt[id];
        target = Math.sign(diff) * Math.min(this.s.returnRate, Math.abs(diff) * 0.5);
        accel = this.s.normalAccel;
      }
      const dv = target - this.vs[id];
      this.vs[id] += Math.sign(dv) * Math.min(Math.abs(dv), accel * dt);
      this.alt[id] += this.vs[id] * dt;
    }
  }
}
