// Navigation-display symbology layered on the TCAS view: the heading-up compass rose, the
// flight-plan route and its waypoints, and the formatting of the flight / waypoint data.
// Waypoints have their own green styling and never use the TCAS traffic symbols.
// Geometry comes from shared/navigation.js (state.perspectives[id].nav).

import { wrap360 } from '../../../../shared/navigation.js';

export const NAV_COLORS = {
  route: '#35d860', // course line and waypoint symbols
  activeLeg: '#5dff86', // FROM -> TO leg, drawn brighter and thicker
  label: '#35d860',
  activeLabel: '#ffffff', // active (TO) waypoint name
  compass: '#ffffff', // heading scale ticks and numerals
};

const FONT = "'B612 Mono', ui-monospace, monospace";

/** Heading scale label for a heading: tens of degrees, two digits ("09" = 090°, "00" = 360°). */
export function headingLabel(deg) {
  return String(Math.round(wrap360(deg) / 10) % 36).padStart(2, '0');
}

/** Three-digit heading, "090"; 359.6 rounds to "000". */
export function formatHeading(deg) {
  return String(Math.round(wrap360(deg)) % 360).padStart(3, '0');
}

/**
 * Compass rose ticks for a heading-up display: one per `step` degrees, with `angle` the
 * screen angle clockwise from straight up (the own heading sits at 0). Every 10° is a major
 * tick with a label; every 30° label is drawn larger. Wraps through north (350, 000, 010).
 * @param {number|null} heading own heading (deg); null draws the rose north-up, unlabelled
 */
export function compassTicks(heading, step = 5) {
  const h = heading === null || heading === undefined ? 0 : wrap360(heading);
  const ticks = [];
  for (let deg = 0; deg < 360; deg += step) {
    const major = deg % 10 === 0;
    ticks.push({ deg, angle: wrap360(deg - h), major, label: major ? headingLabel(deg) : null, large: deg % 30 === 0 });
  }
  return ticks;
}

/** Screen angle (clockwise from up) the wind arrow points: downwind, relative to own heading. */
export function windArrowAngle(wind, heading) {
  return wrap360(wind.direction + 180 - (heading ?? 0));
}

/** Time to go, "MM:SS" ("00:35"); "--:--" when unknown. */
export function formatEta(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '--:--';
  const t = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Four-pointed waypoint star; filled for the active (TO) waypoint. */
export function drawWaypoint(ctx, x, y, size, active) {
  const s = size / 2;
  const w = s * 0.28;
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = NAV_COLORS.route;
  ctx.fillStyle = NAV_COLORS.route;
  ctx.lineWidth = Math.max(1.5, size * 0.1);
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.lineTo(w, -w);
  ctx.lineTo(s, 0);
  ctx.lineTo(w, w);
  ctx.lineTo(0, s);
  ctx.lineTo(-w, w);
  ctx.lineTo(-s, 0);
  ctx.lineTo(-w, -w);
  ctx.closePath();
  if (active) ctx.fill();
  else ctx.stroke();
  ctx.restore();
}

export function drawWaypointLabel(ctx, x, y, size, id, active) {
  ctx.save();
  ctx.fillStyle = active ? NAV_COLORS.activeLabel : NAV_COLORS.label;
  ctx.font = `700 ${Math.round(size * 0.85)}px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(id, x + size * 0.75, y - size * 0.55);
  ctx.restore();
}

/** Arrow centred on (x, y), pointing `angleDeg` clockwise from up. */
export function drawArrow(ctx, x, y, len, angleDeg, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, len * 0.1);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, len / 2);
  ctx.lineTo(0, -len / 2);
  ctx.moveTo(-len * 0.25, -len * 0.22);
  ctx.lineTo(0, -len / 2);
  ctx.lineTo(len * 0.25, -len * 0.22);
  ctx.stroke();
  ctx.restore();
}
