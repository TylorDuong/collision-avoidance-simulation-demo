// Threat classification with hysteresis. Levels follow TCAS naming:
// other < proximate < TA (caution) < RA (danger).

import { THREAT } from '../shared/protocol.js';

export function timeToCollision(range, closingSpeed, minClosingSpeed) {
  return closingSpeed > minClosingSpeed ? range / closingSpeed : null;
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
