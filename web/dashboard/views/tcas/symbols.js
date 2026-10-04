// TCAS II traffic symbology (TCAS II v7.1 intro booklet, Fig. 2), drawn on a 2D canvas.
//   own ship   white airplane symbol
//   other      hollow cyan diamond (never the own-ship colour)
//   proximate  filled cyan diamond
//   TA         filled amber circle
//   RA         filled red square
// Data tag: relative altitude as a signed two-digit number of tag units (hundreds of feet),
// above the symbol when traffic is above and below when it is below, omitted when altitude
// is unknown. A vertical-trend arrow sits immediately
// right of the symbol. Everything in the tag is drawn in the symbol's colour.
// State values are SI (m, m/s); a unit profile (UNITS) converts them for display.

export const TCAS_COLORS = {
  ownship: '#ffffff',
  ring: '#ffffff', // range markings and range annunciation use the own-ship colour
  scale: '#ffffff', // VSI scale ticks and numerals
  other: '#00e5ff',
  proximate: '#00e5ff',
  TA: '#ffbf00',
  RA: '#ff2a2a',
  vsiRed: '#ff2a2a', // RA: vertical speeds to avoid
  vsiGreen: '#2bff6a', // RA: vertical speed to fly
  clear: '#2bff6a',
  text: '#ffffff',
  data: '#00e5ff', // own-ship data and status annunciations
  dim: '#6b7680', // chrome outside the instrument
};

const NM = 1852;
const FT = 0.3048;

/**
 * Display unit profiles (one for now: the airspace in NM, feet and knots).
 *   range       metres per displayed range unit, `rangeUnit` its label
 *   relAlt      metres per data-tag unit
 *   trend       vertical rate (m/s) beyond which a trend arrow is shown
 *   vsi         m/s per VSI dial unit
 *   altFilter   display altitude bands { NORM, ABV, BLW } as [below, above] in metres
 */
export const UNITS = {
  airspace: {
    rangeUnit: 'NM',
    range: NM,
    ranges: [5, 10, 20, 40],
    defaultRange: 10,
    rangeDigits: 1,
    relAlt: 100 * FT,
    trend: 500 * (FT / 60),
    vsi: 1000 * (FT / 60),
    altFilter: { NORM: [-2700 * FT, 2700 * FT], ABV: [-2700 * FT, 9900 * FT], BLW: [-9900 * FT, 2700 * FT] },
    altitude: (m) => `${Math.round(m / FT / 10) * 10}`,
    altitudeUnit: 'FT',
    speed: (ms) => `${Math.round(ms / (NM / 3600))}`,
    speedUnit: 'KT',
    vs: (ms) => Math.round(ms / (FT / 60) / 50) * 50,
    vsUnit: 'FPM',
  },
};

const FONT = "'B612 Mono', ui-monospace, monospace";
const known = (v) => v !== null && v !== undefined && !Number.isNaN(v);
const RING_STEPS = [1, 2, 2.5, 5]; // × powers of ten

/**
 * Range ring distances, in display range units, for a selected range: evenly spaced at a
 * round step that gives 3–5 rings (4 preferred), the last at full scale.
 * 20 -> [5, 10, 15, 20], 10 -> [2.5, 5, 7.5, 10], 5 -> [1, 2, 3, 4, 5].
 */
export function rangeRings(scale) {
  let best = null;
  for (let e = -3; e <= 3; e++) {
    for (const m of RING_STEPS) {
      const step = m * 10 ** e;
      const n = scale / step;
      if (Math.abs(n - Math.round(n)) > 1e-9 || n < 3 || n > 5) continue;
      if (!best || Math.abs(n - 4) < Math.abs(best.n - 4)) best = { step, n: Math.round(n) };
    }
  }
  best ??= { step: scale / 4, n: 4 };
  return Array.from({ length: best.n }, (_, i) => Number(((i + 1) * best.step).toPrecision(12)));
}

export function drawOwnship(ctx, x, y, size, color = TCAS_COLORS.ownship) {
  const s = size;
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.5, s * 0.09);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, -s * 0.55); // nose
  ctx.lineTo(0, s * 0.55); // fuselage
  ctx.moveTo(-s * 0.55, -s * 0.05); // wings
  ctx.lineTo(s * 0.55, -s * 0.05);
  ctx.moveTo(-s * 0.22, s * 0.48); // tail
  ctx.lineTo(s * 0.22, s * 0.48);
  ctx.stroke();
  ctx.restore();
}

function tracePath(ctx, h, threat) {
  ctx.beginPath();
  switch (threat) {
    case 'RA':
      ctx.rect(-h * 0.85, -h * 0.85, h * 1.7, h * 1.7);
      break;
    case 'TA':
      ctx.arc(0, 0, h * 0.9, 0, Math.PI * 2);
      break;
    default:
      ctx.moveTo(0, -h);
      ctx.lineTo(h, 0);
      ctx.lineTo(0, h);
      ctx.lineTo(-h, 0);
      ctx.closePath();
  }
}

/** @param {'other'|'proximate'|'TA'|'RA'} threat */
export function drawTraffic(ctx, x, y, size, threat) {
  const color = TCAS_COLORS[threat];
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = Math.max(1.5, size * 0.12);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  tracePath(ctx, size / 2, threat);
  if (threat === 'other') ctx.stroke();
  else ctx.fill();
  ctx.restore();
}

/**
 * Off-scale TA/RA: the half of the symbol that lies inside the display edge, centred on
 * the edge at the traffic's bearing.
 * @param {number} bearingRad relative bearing, clockwise from up
 */
export function drawHalfSymbol(ctx, x, y, size, threat, bearingRad) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(bearingRad);
  ctx.beginPath();
  ctx.rect(-size, 0, size * 2, size); // keep the inward half (towards the centre)
  ctx.clip();
  ctx.rotate(-bearingRad);
  drawTraffic(ctx, 0, 0, size, threat);
  ctx.restore();
}

/** "+02" / "−01" / "00", or "" when altitude is unknown (nothing is shown). */
export function formatRelAlt(relAlt, units = UNITS.airspace) {
  if (!known(relAlt)) return '';
  const n = Math.min(99, Math.abs(Math.round(relAlt / units.relAlt)));
  if (n === 0) return '00';
  return `${relAlt > 0 ? '+' : '−'}${String(n).padStart(2, '0')}`;
}

/** "↑" / "↓" when the vertical rate is past the trend threshold, else "". */
export function trendGlyph(rate, units = UNITS.airspace) {
  if (!known(rate) || Math.abs(rate) < units.trend) return '';
  return rate > 0 ? '↑' : '↓';
}

/** Range in display units, e.g. "4.5" (NM). */
export function formatRange(range, units = UNITS.airspace) {
  const v = range / units.range;
  return v > 99.9 ? '>99' : v.toFixed(units.rangeDigits);
}

/** Written no-bearing advisory, e.g. "RA 4.5 +12↓". */
export function formatNoBearing({ threat, range, relAlt, relAltRate }, units = UNITS.airspace) {
  const parts = [threat, formatRange(range, units)];
  const alt = formatRelAlt(relAlt, units);
  if (alt) parts.push(alt + trendGlyph(relAltRate, units)); // the arrow needs a reported altitude
  return parts.join(' ');
}

export function drawDataTag(ctx, x, y, size, { relAlt, relAltRate }, color, units = UNITS.airspace) {
  if (!known(relAlt)) return; // altitude not reported: no tag, no arrow
  const text = formatRelAlt(relAlt, units);
  const below = relAlt < 0 && text !== '00';
  const fontPx = Math.round(size * 0.85);
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.font = `700 ${fontPx}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = below ? 'top' : 'bottom';
  ctx.fillText(text, x, below ? y + size * 0.7 : y - size * 0.7);

  const trend = trendGlyph(relAltRate, units);
  if (trend) {
    const ax = x + size * 0.95;
    const up = trend === '↑';
    const len = size * 0.9;
    const tip = y + (up ? -len / 2 : len / 2);
    const d = up ? 1 : -1;
    ctx.lineWidth = Math.max(1.5, size * 0.1);
    ctx.beginPath();
    ctx.moveTo(ax, y - (tip - y));
    ctx.lineTo(ax, tip);
    ctx.moveTo(ax - size * 0.22, tip + d * size * 0.25);
    ctx.lineTo(ax, tip);
    ctx.lineTo(ax + size * 0.22, tip + d * size * 0.25);
    ctx.stroke();
  }
  ctx.restore();
}
