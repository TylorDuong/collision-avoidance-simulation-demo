// TCAS advisory state: turns the threat level of the most severe traffic into the
// on-screen advisory text and fires sound cues on transitions.
// Placeholder logic, refined in later iterations (real RA sense selection, VSI band,
// "ADJUST VERTICAL SPEED", RA strengthening/weakening, etc.).

import { TCAS_COLORS } from './symbols.js';

const CLEAR_OF_CONFLICT_MS = 3000;

/** Sound cue hook. No-op for now; wire up Web Audio / speechSynthesis later. */
export function announce(type) {
  console.debug('[tcas] announce', type);
}

/**
 * Pick an RA sense. Without vertical information, ask for separation.
 * @returns {string}
 */
export function resolveSense(traffic) {
  if (traffic?.relAlt === null || traffic?.relAlt === undefined) return 'INCREASE SEPARATION';
  return traffic.relAlt > 0 ? 'DESCEND, DESCEND' : 'CLIMB, CLIMB';
}

export class AdvisoryTracker {
  constructor() {
    this.level = 'other';
    this.clearUntil = 0;
  }

  /**
   * @param {Array} traffic state.traffic
   * @param {number} now ms
   * @returns {{ banner: {text: string, color: string, level: string} | null, primary: object | null }}
   */
  update(traffic, now) {
    const order = { other: 0, proximate: 1, TA: 2, RA: 3 };
    let primary = null;
    for (const t of traffic) if (!primary || order[t.threat] > order[primary.threat]) primary = t;
    const level = primary?.threat ?? 'other';

    if (level !== this.level) {
      if (level === 'TA' && order[this.level] < order.TA) announce('TRAFFIC');
      if (level === 'RA') announce('RA');
      if (this.level === 'RA' && level !== 'RA') {
        announce('CLEAR_OF_CONFLICT');
        this.clearUntil = now + CLEAR_OF_CONFLICT_MS;
      }
      this.level = level;
    }

    let banner = null;
    if (level === 'RA') banner = { text: resolveSense(primary), color: TCAS_COLORS.RA, level };
    else if (level === 'TA') banner = { text: 'TRAFFIC, TRAFFIC', color: TCAS_COLORS.TA, level };
    else if (now < this.clearUntil) banner = { text: 'CLEAR OF CONFLICT', color: TCAS_COLORS.clear, level: 'clear' };
    return { banner, primary };
  }
}
