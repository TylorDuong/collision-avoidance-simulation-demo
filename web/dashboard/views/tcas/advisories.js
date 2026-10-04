// TCAS advisory state: turns the threat level of the most severe traffic into the
// advisory text (TCAS II v7.1 aural annunciations, booklet Table 4), the RA guidance for
// the vertical speed indicator (red = rates to avoid, green = rate to fly, Table 3) and
// sound cues on transitions.
// Still simplified: the initial Climb / Descend RA, and its weakening to Level Off once the
// own ship reports safe separation reached (ownship.ra.remaining === 0, live demo); no
// strengthening or preventive RAs.

import { TCAS_COLORS } from './symbols.js';

const CLEAR_OF_CONFLICT_MS = 3000;
const ORDER = { other: 0, proximate: 1, TA: 2, RA: 3 };

// VSI dial units (1 = 1000 fpm on a real IVSI). Climb RA: fly 1500–2000 fpm, avoid
// anything below 1500 fpm. Descend RA is the mirror image.
export const VSI_MAX = 6;
const RA_VSI = {
  up: { green: [1.5, 2], red: [[-VSI_MAX, 1.5]] },
  down: { green: [-2, -1.5], red: [[-1.5, VSI_MAX]] },
};
const RA_TEXT = { up: 'CLIMB, CLIMB', down: 'DESCEND, DESCEND' };
// Level Off after a climb: hold about level, avoid descending back toward the intruder.
const LEVEL_OFF_VSI = {
  up: { green: [0, 0.3], red: [[-VSI_MAX, 0]] },
  down: { green: [-0.3, 0], red: [[0, VSI_MAX]] },
};

/** Sound cue hook. No-op for now; wire up Web Audio / speechSynthesis later. */
export function announce(type) {
  console.debug('[tcas] announce', type);
}

/**
 * Pick an RA sense: away from the intruder vertically. Without vertical information the
 * sense is an arbitrary choice; climb is used.
 * @returns {'up'|'down'}
 */
export function resolveSense(traffic) {
  const relAlt = traffic?.relAlt;
  if (relAlt === null || relAlt === undefined) return 'up';
  return relAlt > 0 ? 'down' : 'up';
}

export class AdvisoryTracker {
  constructor() {
    this.level = 'other';
    this.sense = null; // latched for the life of an RA
    this.levelOff = false; // the RA has weakened to Level Off
    this.clearUntil = 0;
  }

  /**
   * @param {Array} traffic perspective traffic list
   * @param {number} now ms
   * @param {object} [ownship] perspective own ship: `ra.sense` (the sense its TCAS selected)
   *   is used when present, `ra.remaining` (m still to climb / descend, 0 = level off) is
   *   passed on, and mode 'TA ONLY' downgrades RAs to TAs, 'STBY' shows nothing.
   * @returns {{ banner: {text: string, color: string, level: string, vsi?: object, remaining?: number|null} | null, primary: object | null }}
   */
  update(traffic, now, ownship = null) {
    const mode = ownship?.mode ?? 'TA/RA';
    const cap = (threat) => (mode === 'STBY' ? 'other' : mode === 'TA ONLY' && threat === 'RA' ? 'TA' : threat);
    let primary = null;
    for (const t of traffic) if (!primary || ORDER[cap(t.threat)] > ORDER[cap(primary.threat)]) primary = t;
    const level = primary ? cap(primary.threat) : 'other';

    if (level === 'RA' && this.level === 'RA' && ownship?.ra?.sense && ownship.ra.sense !== this.sense) {
      this.sense = ownship.ra.sense; // sense reversal from own TCAS
      announce(this.sense === 'up' ? 'CLIMB' : 'DESCEND');
    }
    if (level !== this.level) {
      if (level === 'TA' && ORDER[this.level] < ORDER.TA) announce('TRAFFIC');
      if (level === 'RA') {
        this.sense = ownship?.ra?.sense ?? resolveSense(primary);
        announce(this.sense === 'up' ? 'CLIMB' : 'DESCEND');
      }
      if (this.level === 'RA' && level !== 'RA') {
        this.sense = null;
        announce('CLEAR_OF_CONFLICT');
        this.clearUntil = now + CLEAR_OF_CONFLICT_MS;
      }
      this.level = level;
    }

    const remaining = level === 'RA' ? ownship?.ra?.remaining ?? null : null;
    if (level === 'RA' && remaining === 0 && !this.levelOff) announce('LEVEL_OFF');
    this.levelOff = level === 'RA' && remaining === 0;

    let banner = null;
    if (level === 'RA') {
      banner = this.levelOff
        ? { text: 'LEVEL OFF, LEVEL OFF', color: TCAS_COLORS.RA, level, sense: this.sense, vsi: LEVEL_OFF_VSI[this.sense], remaining }
        : { text: RA_TEXT[this.sense], color: TCAS_COLORS.RA, level, sense: this.sense, vsi: RA_VSI[this.sense], remaining };
    } else if (level === 'TA') banner = { text: 'TRAFFIC, TRAFFIC', color: TCAS_COLORS.TA, level };
    else if (now < this.clearUntil) banner = { text: 'CLEAR OF CONFLICT', color: TCAS_COLORS.clear, level: 'clear' };
    return { banner, primary };
  }
}
