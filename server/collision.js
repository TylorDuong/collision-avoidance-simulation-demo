// Threat classification with hysteresis. Levels follow TCAS naming:
// other < proximate < TA (caution) < RA (danger).

import { THREAT } from '../shared/protocol.js';

export function timeToCollision(range, closingSpeed, minClosingSpeed) {
  return closingSpeed > minClosingSpeed ? range / closingSpeed : null;
}

/**
 * Coordinated RA senses for A and B, always complementary so they never both climb or
 * both descend (TCAS coordination). With usable vertical separation the higher node climbs
 * and the lower descends; otherwise A climbs and B descends (fixed tie-break, like the lower
 * Mode S address climbing in tools/sim/airspace.js).
 * @param {number|null} relAlt B's altitude minus A's (m), null when unknown
 * @param {number} threshold minimum |relAlt| (m) to choose by altitude
 * @returns {{ A: 'up'|'down', B: 'up'|'down' }}
 */
export function selectRaSenses(relAlt, threshold) {
  if (relAlt !== null && relAlt !== undefined && Math.abs(relAlt) >= threshold) {
    return relAlt > 0 ? { A: 'down', B: 'up' } : { A: 'up', B: 'down' };
  }
  return { A: 'up', B: 'down' };
}

export class CollisionEvaluator {
  constructor(zones) {
    this.z = zones;
    this.level = 0;
    this.reason = null;
    this.enteredAt = -Infinity;
  }

  // Highest level whose range or TTC threshold (scaled by fr / ft) is violated.
  _levelFor(range, ttc, fr, ft) {
    const { RA, TA, proximate } = this.z;
    const hit = (zone) => {
      if (range < zone.range * fr) return 'range';
      if (zone.ttc != null && ttc != null && ttc < zone.ttc * ft) return 'ttc';
      return null;
    };
    let r;
    if ((r = hit(RA))) return { level: 3, reason: r };
    if ((r = hit(TA))) return { level: 2, reason: r };
    if ((r = hit(proximate))) return { level: 1, reason: r };
    return { level: 0, reason: null };
  }

  /**
   * @param {{ range: number|null, closingSpeed: number, valid: boolean }} input
   * @param {number} t seconds
   */
  evaluate({ range, closingSpeed, valid }, t) {
    const ttc = valid && range != null ? timeToCollision(range, closingSpeed, this.z.minClosingSpeed) : null;
    const target = valid && range != null ? this._levelFor(range, ttc, 1, 1) : { level: 0, reason: 'no-data' };

    if (target.level > this.level) {
      this.level = target.level;
      this.reason = target.reason;
      this.enteredAt = t;
    } else if (target.level < this.level) {
      // De-escalate only after the minimum hold, and only as far as the looser
      // release thresholds allow.
      const held = t - this.enteredAt < this.z.minHoldSeconds;
      const released =
        valid && range != null
          ? this._levelFor(range, ttc, this.z.releaseRangeFactor, this.z.releaseTtcFactor)
          : target;
      if (!held && released.level < this.level) {
        this.level = released.level;
        this.reason = released.reason;
        this.enteredAt = t;
      }
    } else {
      // Same level: follow the current reason, which also clears a stale 'no-data' at level 0.
      this.reason = target.reason;
    }
    return { threat: THREAT[this.level], level: this.level, reason: this.reason, ttc };
  }
}
