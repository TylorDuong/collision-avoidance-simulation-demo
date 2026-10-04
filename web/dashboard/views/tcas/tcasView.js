// Combined TCAS traffic / navigation display for one aircraft's (or phone's) point of view,
// in the style of a heading-up navigation display (ND) with TCAS traffic (TCAS II v7.1
// intro booklet, Figs. 2–3): `ownId` is own ship. Reads state.perspectives[ownId]; units
// follow state.mode (UNITS in symbols.js).
//   - Rim: heading-up compass rose that turns with own heading (labels in tens of degrees,
//     "09" = 090°), fixed lubber triangle and heading readout at the top.
//   - Face: own ship fixed at the centre pointing up, each aircraft at its range and
//     relative bearing with its symbol and data tag. Dashed range rings at round fractions
//     of the selected range (labelled; full scale carries the unit); selected range boxed
//     in the upper right. Rings, route and traffic share one range scale. Off-scale TAs/RAs
//     are half symbols at the edge. Traffic without a bearing (range-only sensing) is drawn
//     at its range on a fixed straight-ahead axis with its distance written beside it, and
//     TAs/RAs are also reported in writing ("RA 0.28 +02"). Under the traffic, own route in green
//     (perspective.nav, never processed as traffic).
//   - Right edge: vertical speed tape (0 .5 1 2 4 6 thousand fpm) with the own-ship pointer.
//     During an RA, red bands mark the rates to avoid and a green band the rate to fly.
//   - Overlay: GS / TAS / wind (top left), active waypoint course, distance and time to go
//     (top right), altitude and V/S by the tape, POV / TCAS mode, altitude filter and status
//     annunciations (bottom left); the advisory banner stands in for the aural annunciation.

import { TCAS_COLORS, UNITS, drawOwnship, drawTraffic, drawHalfSymbol, drawDataTag, formatNoBearing, formatRange, rangeRings } from './symbols.js';
import { AdvisoryTracker, VSI_MAX } from './advisories.js';
import { NAV_COLORS, compassTicks, formatHeading, formatEta, windArrowAngle, drawWaypoint, drawWaypointLabel, drawArrow } from './navSymbols.js';

// Non-linear vertical speed scale: dial value -> degrees of the former IVSI arc (170° = 6).
const VSI_ANCHORS = [[0, 0], [0.5, 35], [1, 65], [2, 110], [4, 145], [6, 170]];
const VSI_TICKS = [0, 0.5, 1, 2, 4, 6];
const VSI_LABELS = [1, 2, 6];
const ALT_FILTERS = [['ABV', 'ABV'], ['NORM', 'N'], ['BLW', 'BLW']];
const ORDER = { other: 0, proximate: 1, TA: 2, RA: 3 };
const FONT = "'B612 Mono', ui-monospace, monospace";
const TOP = 112; // flight / waypoint data, advisory banner and heading readout
const BOTTOM = 66; // status annunciations + range / altitude-filter buttons
const SIDE = 48; // vertical speed tape (reserved on both sides to keep the rose centred)
const ROUTE_CLIP = 0.78; // route drawn out to this fraction of R, inside the compass numerals
const RING_LABEL_BEARING = 315; // range ring labels along the upper-left ray (deg from up)
// Range-only traffic (phones / ultrasonic boards: no bearing) is drawn at its range on this
// fixed relative bearing, straight ahead. Its direction is not observable.
const NO_BEARING_AXIS = 0;

const prefs = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

/** Position of a dial value on the vertical speed tape: −1 (6 down) … 0 … +1 (6 up). */
function vsiFraction(v) {
  const a = Math.min(Math.abs(v), VSI_MAX);
  let deg = VSI_ANCHORS.at(-1)[1];
  for (let i = 1; i < VSI_ANCHORS.length; i++) {
    const [v0, d0] = VSI_ANCHORS[i - 1];
    const [v1, d1] = VSI_ANCHORS[i];
    if (a <= v1) {
      deg = d0 + ((a - v0) / (v1 - v0)) * (d1 - d0);
      break;
    }
  }
  return (Math.sign(v) * deg) / VSI_ANCHORS.at(-1)[1];
}

// Ultrasonic boards stand in for the phones while any of them is still reporting (the
// server's Engine._nodePresent rule), even between accepted readings.
const boardsReporting = (s) => (s.ultrasonic?.boards ?? []).some((b) => b.status !== 'no-signal');
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
const known = (v) => v !== null && v !== undefined;
const DEG = Math.PI / 180;

export function createTcasView({ ownId = 'A' } = {}) {
  let wrap, canvas, ctx, controls, rangeGroup;
  let dpr = 1;
  let mode = null; // state.mode the range buttons were built for
  let units = UNITS.phones;
  let rangeScale = units.defaultRange;
  let altFilter = ['NORM', 'ABV', 'BLW'].includes(prefs.get(`tcas-alt-${ownId}`)) ? prefs.get(`tcas-alt-${ownId}`) : 'NORM';
  const advisories = new AdvisoryTracker();

  function text(str, x, y, { color = TCAS_COLORS.text, size = 14, align = 'left', baseline = 'alphabetic', weight = 700 } = {}) {
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.fillText(str, x, y);
  }

  function boxedText(str, x, y, { color, size, border = color }) {
    ctx.font = `700 ${size}px ${FONT}`;
    const w = ctx.measureText(str).width + size;
    const h = size * 1.7;
    ctx.fillStyle = '#000';
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
    if (border) {
      ctx.strokeStyle = border;
      ctx.lineWidth = Math.max(1.5, size * 0.09);
      ctx.strokeRect(x - w / 2, y - h / 2, w, h);
    }
    text(str, x, y + 1, { color, size, align: 'center', baseline: 'middle' });
  }

  function circle(cx, cy, r) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }

  // ---- controls (range and altitude-filter selection) --------------------------------

  function buttonGroup(label) {
    const group = document.createElement('div');
    group.className = 'group';
    group.innerHTML = `<span>${label}</span>`;
    controls.append(group);
    return group;
  }

  function button(group, textContent, data, onClick) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = textContent;
    Object.assign(b.dataset, data);
    b.addEventListener('click', onClick);
    group.append(b);
  }

  function syncControls() {
    for (const b of controls.querySelectorAll('[data-range]')) b.setAttribute('aria-pressed', String(Number(b.dataset.range) === rangeScale));
    for (const b of controls.querySelectorAll('[data-alt]')) b.setAttribute('aria-pressed', String(b.dataset.alt === altFilter));
  }

  function buildControls() {
    controls = document.createElement('div');
    controls.className = 'tcas-controls';
    rangeGroup = buttonGroup('RNG');
    const altGroup = buttonGroup('ALT');
    for (const [id, label] of ALT_FILTERS) {
      button(altGroup, label, { alt: id }, () => {
        altFilter = id;
        prefs.set(`tcas-alt-${ownId}`, id);
        syncControls();
      });
    }
  }

  // Range choices depend on the units, so rebuild them when the state's mode changes.
  function useMode(next) {
    if (next === mode) return;
    mode = next;
    units = UNITS[mode] ?? UNITS.phones;
    const key = `tcas-range-${mode}-${ownId}`;
    const saved = Number(prefs.get(key));
    rangeScale = units.ranges.includes(saved) ? saved : units.defaultRange;
    rangeGroup.querySelectorAll('button').forEach((b) => b.remove());
    for (const r of units.ranges) {
      button(rangeGroup, String(r), { range: String(r) }, () => {
        rangeScale = r;
        prefs.set(key, String(r));
        syncControls();
      });
    }
    rangeGroup.firstChild.textContent = `RNG ${units.rangeUnit}`;
    controls.querySelector('[data-alt]').parentElement.hidden = mode !== 'airspace'; // phones have no altitude bands
    syncControls();
  }

  // ---- instrument --------------------------------------------------------------------

  function drawBezel(cx, cy, R) {
    circle(cx, cy, R * 1.04);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.strokeStyle = '#3a3f45';
    ctx.lineWidth = Math.max(2, R * 0.02);
    ctx.stroke();
  }

  // Heading-up compass rose: 5° ticks, 10° major ticks with tens-of-degree numerals (30° ones
  // larger), turned so own heading is at the top under a fixed lubber triangle and readout.
  function drawCompass(cx, cy, R, heading, reference) {
    const rOut = R * 0.98;
    const rLabel = R * 0.855;
    const big = Math.max(10, Math.round(R * 0.085));
    const small = Math.max(9, Math.round(R * 0.065));
    ctx.save();
    ctx.strokeStyle = NAV_COLORS.compass;
    ctx.lineCap = 'butt';
    for (const t of compassTicks(heading)) {
      const a = t.angle * DEG;
      const len = t.major ? R * 0.065 : R * 0.032;
      ctx.lineWidth = t.major ? Math.max(1.5, R * 0.012) : Math.max(1, R * 0.007);
      ctx.beginPath();
      ctx.moveTo(cx + Math.sin(a) * (rOut - len), cy - Math.cos(a) * (rOut - len));
      ctx.lineTo(cx + Math.sin(a) * rOut, cy - Math.cos(a) * rOut);
      ctx.stroke();
      if (!t.label || !known(heading)) continue;
      ctx.save();
      ctx.translate(cx + Math.sin(a) * rLabel, cy - Math.cos(a) * rLabel);
      ctx.rotate(a); // numerals read outward, like a real rose
      text(t.label, 0, 0, { color: NAV_COLORS.compass, size: t.large ? big : small, align: 'center', baseline: 'middle' });
      ctx.restore();
    }

    // Lubber triangle just outside the rim, pointing at own heading.
    const tw = Math.max(6, R * 0.045);
    const tipY = cy - R * 0.985;
    ctx.fillStyle = NAV_COLORS.compass;
    ctx.beginPath();
    ctx.moveTo(cx, tipY);
    ctx.lineTo(cx - tw, tipY - tw * 1.5);
    ctx.lineTo(cx + tw, tipY - tw * 1.5);
    ctx.closePath();
    ctx.fill();

    // Heading readout above it: "HDG [090] TRU" (simulator, true) or "MAG" (phone compass).
    const size = Math.max(12, Math.min(18, Math.round(R * 0.085)));
    const by = tipY - tw * 1.5 - size * 0.95;
    boxedText(known(heading) ? formatHeading(heading) : '---', cx, by, { color: NAV_COLORS.compass, size });
    const gap = size * 2.2;
    text('HDG', cx - gap, by + 1, { color: TCAS_COLORS.data, size: size - 3, align: 'right', baseline: 'middle' });
    text(reference, cx + gap, by + 1, { color: TCAS_COLORS.data, size: size - 3, align: 'left', baseline: 'middle' });
    ctx.restore();
  }

  // Vertical speed tape (the IVSI's job on a glass cockpit's PFD): own-ship pointer, and RA
  // guidance as red (avoid) and green (fly) bands. V/S above the tape, altitude below it.
  function drawVsiTape(x, cy, half, vsi, own, fs) {
    const w = 22;
    const left = x - w / 2;
    const y = (v) => cy - vsiFraction(v) * half;
    ctx.save();
    ctx.fillStyle = '#0b0d10';
    ctx.fillRect(left, cy - half, w, half * 2);
    ctx.strokeStyle = '#3a3f45';
    ctx.lineWidth = 1;
    ctx.strokeRect(left, cy - half, w, half * 2);

    if (vsi) {
      const band = w * 0.4;
      const fill = ([lo, hi], color) => {
        ctx.fillStyle = color;
        ctx.fillRect(left, y(hi), band, y(lo) - y(hi));
      };
      for (const r of vsi.red) fill(r, TCAS_COLORS.vsiRed);
      fill(vsi.green, TCAS_COLORS.vsiGreen);
    }

    ctx.strokeStyle = TCAS_COLORS.scale;
    const labelPx = Math.max(9, fs - 3);
    for (const v of VSI_TICKS) {
      for (const s of v === 0 ? [1] : [1, -1]) {
        const ty = y(s * v);
        ctx.lineWidth = v === 0 ? 2 : 1.2;
        ctx.beginPath();
        ctx.moveTo(left + w - (v === 0 ? w * 0.6 : w * 0.35), ty);
        ctx.lineTo(left + w, ty);
        ctx.stroke();
        if (VSI_LABELS.includes(v)) text(String(v), left - 3, ty, { color: TCAS_COLORS.scale, size: labelPx, align: 'right', baseline: 'middle' });
      }
    }

    const vs = own?.verticalSpeed;
    if (known(vs)) {
      ctx.strokeStyle = TCAS_COLORS.ownship;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(left - 2, y(vs / units.vsi));
      ctx.lineTo(left + w + 4, y(vs / units.vsi));
      ctx.stroke();
    }
    const right = x + w / 2;
    text(known(vs) ? `${signed(units.vs(vs))} ${units.vsUnit}` : 'V/S ---', right, cy - half - 8, { color: TCAS_COLORS.data, size: fs - 2, align: 'right' });
    const alt = own?.altitude;
    text(known(alt) ? `${units.altitude(alt)} ${units.altitudeUnit}` : 'ALT ---', right, cy + half + fs + 4, { color: TCAS_COLORS.data, size: fs - 2, align: 'right' });
    ctx.restore();
  }

  // Half scale: ring of 12 dots. Full scale: thin ring. Both in the own-ship colour.
  // The one range scale shared by range rings, route and traffic: own ship at (cx, cy),
  // the selected range at radius Rt. `range` in metres, `bearing` in degrees relative to
  // own heading (clockwise from up).
  function toScreen(cx, cy, Rt, range, bearing) {
    const r = (range / (rangeScale * units.range)) * Rt;
    const a = bearing * DEG;
    return { x: cx + Math.sin(a) * r, y: cy - Math.cos(a) * r, r };
  }

  // Dashed range rings centred on own ship at round fractions of the selected range, each
  // labelled where it crosses the upper-left ray; the outermost (full scale) carries the unit.
  function drawRangeRings(cx, cy, Rt, fs) {
    const rings = rangeRings(rangeScale);
    const size = Math.max(9, fs - 3);
    ctx.save();
    ctx.strokeStyle = TCAS_COLORS.ring;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 5]);
    for (const v of rings) {
      ctx.globalAlpha = v === rangeScale ? 0.5 : 0.32;
      circle(cx, cy, toScreen(cx, cy, Rt, v * units.range, 0).r);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.85;
    ctx.font = `700 ${size}px ${FONT}`;
    for (const v of rings) {
      const label = v === rangeScale ? `${v} ${units.rangeUnit}` : String(v);
      const p = toScreen(cx, cy, Rt, v * units.range, RING_LABEL_BEARING);
      const w = ctx.measureText(label).width + 4;
      ctx.fillStyle = '#000'; // break the ring under its label
      ctx.fillRect(p.x - w / 2, p.y - size * 0.6, w, size * 1.2);
      text(label, p.x, p.y + 1, { color: TCAS_COLORS.ring, size, align: 'center', baseline: 'middle' });
    }
    ctx.restore();
  }

  // ---- navigation route ----------------------------------------------------------------

  // Own flight plan from the FROM waypoint on, on the same range scale as the traffic and
  // clipped inside the compass numerals. The active (FROM -> TO) leg is drawn brighter.
  function drawRoute(cx, cy, R, Rt, sym, nav) {
    if (!nav?.waypoints?.length) return;
    const pts = nav.waypoints.map((w) => ({ ...w, ...toScreen(cx, cy, Rt, w.range, w.bearing) }));
    ctx.save();
    circle(cx, cy, R * ROUTE_CLIP);
    ctx.clip();
    ctx.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      const activeLeg = pts[i].active;
      ctx.strokeStyle = activeLeg ? NAV_COLORS.activeLeg : NAV_COLORS.route;
      ctx.lineWidth = activeLeg ? Math.max(2, R * 0.016) : Math.max(1.5, R * 0.01);
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
      ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    for (const p of pts) {
      if (Math.hypot(p.x - cx, p.y - cy) > R * ROUTE_CLIP - sym * 0.6) continue; // beyond the edge: line only
      drawWaypoint(ctx, p.x, p.y, sym * 1.1, p.active);
      drawWaypointLabel(ctx, p.x, p.y, sym, p.id, p.active);
    }
    ctx.restore();
  }

  // ---- traffic -----------------------------------------------------------------------

  // Display altitude filter; TAs, RAs and traffic without altitude are always shown.
  function passesFilter(t) {
    if (t.threat === 'TA' || t.threat === 'RA' || t.relAlt === null || t.relAlt === undefined) return true;
    const [below, above] = units.altFilter[altFilter];
    return t.relAlt >= below && t.relAlt <= above;
  }

  /**
   * @param {boolean} [noBearing] range-only traffic drawn on the fixed NO_BEARING_AXIS: also
   *   gets its distance written beside the symbol, since the position only shows range
   * @returns {boolean} true when drawn as an off-scale half symbol
   */
  function drawPositionedTraffic(cx, cy, Rt, sym, t, noBearing = false) {
    const full = rangeScale * units.range;
    if (t.range > full) {
      if (t.threat !== 'TA' && t.threat !== 'RA') return false;
      const edge = toScreen(cx, cy, Rt, full, t.bearing);
      drawHalfSymbol(ctx, edge.x, edge.y, sym, t.threat, t.bearing * DEG);
      return true;
    }
    const { x, y } = toScreen(cx, cy, Rt, t.range, t.bearing);
    drawTraffic(ctx, x, y, sym, t.threat);
    drawDataTag(ctx, x, y, sym, t, TCAS_COLORS[t.threat], units);
    if (noBearing) {
      // Right of the symbol, past the trend arrow's slot; ring labels are on the left.
      text(`${formatRange(t.range, units)} ${units.rangeUnit}`, x + sym * 1.4, y, { color: TCAS_COLORS[t.threat], size: Math.round(sym * 0.85), align: 'left', baseline: 'middle' });
    }
    return false;
  }

  // ---- overlay -----------------------------------------------------------------------

  /** Small label then a larger value, ND style ("GS 250"); returns the x after it. */
  function labelled(label, value, x, y, fs) {
    text(label, x, y, { color: TCAS_COLORS.text, size: fs - 3 });
    ctx.font = `700 ${fs - 3}px ${FONT}`;
    const vx = x + ctx.measureText(label).width + fs * 0.35;
    text(value, vx, y, { color: TCAS_COLORS.text, size: fs + 2 });
    ctx.font = `700 ${fs + 2}px ${FONT}`;
    return vx + ctx.measureText(value).width;
  }

  const line = (i, fs) => 24 + i * (fs + 9);

  // Top left: ground speed, true airspeed, wind (from / speed) and a downwind arrow.
  function drawFlightData(own, fs) {
    const speed = (v) => (known(v) ? units.speed(v) : '---');
    const end = labelled('GS', speed(own?.groundSpeed), 16, line(0, fs), fs);
    labelled('TAS', speed(own?.trueAirspeed), end + fs, line(0, fs), fs);
    const wind = own?.wind;
    if (!wind) {
      text('---/---', 16, line(1, fs), { color: TCAS_COLORS.text, size: fs });
      return;
    }
    text(`${formatHeading(wind.direction)}°/${units.speed(wind.speed)}`, 16, line(1, fs), { color: TCAS_COLORS.text, size: fs });
    drawArrow(ctx, 16 + fs * 0.7, line(2, fs) - fs * 0.35, fs * 1.4, windArrowAngle(wind, own.heading), TCAS_COLORS.text);
  }

  // Top right: active (TO) waypoint with the course to it, distance and time to go.
  function drawWaypointData(W, nav, fs) {
    if (!nav) return; // no flight plan (e.g. the phones)
    const x = W - 16;
    const to = nav.active;
    if (!to) {
      text('END OF ROUTE', x, line(0, fs), { color: NAV_COLORS.label, size: fs, align: 'right' });
      return;
    }
    ctx.font = `700 ${fs}px ${FONT}`;
    const courseText = `${formatHeading(to.course)}°`;
    text(courseText, x, line(0, fs), { color: TCAS_COLORS.text, size: fs, align: 'right' });
    text(to.id, x - ctx.measureText(courseText).width - fs * 0.6, line(0, fs), { color: NAV_COLORS.activeLabel, size: fs + 2, align: 'right' });
    text(`${formatRange(to.distance, units)} ${units.rangeUnit}`, x, line(1, fs), { color: TCAS_COLORS.text, size: fs, align: 'right' });
    text(formatEta(to.eta), x, line(2, fs), { color: TCAS_COLORS.text, size: fs, align: 'right' });
  }

  // ---- frame -------------------------------------------------------------------------

  function draw(s, info) {
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    useMode(s?.mode ?? 'phones');

    const R = Math.max(60, Math.min(W - 32 - 2 * SIDE, H - TOP - BOTTOM) / 2 / 1.04);
    const cx = W / 2;
    const cy = TOP + Math.max(R * 1.04, (H - TOP - BOTTOM) / 2);
    const Rt = R * 0.64; // full-scale radius of the traffic display
    const sym = Math.max(10, Math.min(20, R * 0.065));
    const fs = Math.max(11, Math.min(15, Math.round(W / 50)));

    const now = info.now;
    const stale = !s || info.age > 2000;
    const pic = s?.perspectives[ownId];
    const own = stale ? null : pic?.ownship;
    const traffic = stale || !pic || own?.mode === 'STBY' ? [] : pic.traffic;
    const { banner } = advisories.update(traffic, now, own);

    const heading = own?.heading ?? null;
    const nav = stale ? null : pic?.nav ?? null; // flight plan: drawn, never treated as traffic

    drawBezel(cx, cy, R);
    drawCompass(cx, cy, R, heading, mode === 'airspace' ? 'TRU' : 'MAG');
    drawRangeRings(cx, cy, Rt, fs);
    drawRoute(cx, cy, R, Rt, sym, nav);
    drawOwnship(ctx, cx, cy, sym * 1.6);
    const boxAngle = (38 * Math.PI) / 180;
    boxedText(`${rangeScale}`, cx + Math.sin(boxAngle) * R * 0.71, cy - Math.cos(boxAngle) * R * 0.71, { color: TCAS_COLORS.ring, size: Math.max(11, Math.round(R * 0.07)) });

    // Least severe first, so TAs and RAs are drawn on top.
    const shown = traffic.filter((t) => t.range !== null && passesFilter(t)).sort((a, b) => ORDER[a.threat] - ORDER[b.threat]);
    const noBearing = [];
    let offscale = null;
    for (const t of shown) {
      const hasBearing = t.bearing !== null && t.bearing !== undefined;
      if (!hasBearing && (t.threat === 'TA' || t.threat === 'RA')) noBearing.push(t);
      const placed = hasBearing ? t : { ...t, bearing: NO_BEARING_AXIS };
      if (drawPositionedTraffic(cx, cy, Rt, sym, placed, !hasBearing)) {
        if (!offscale || ORDER[t.threat] > ORDER[offscale]) offscale = t.threat;
      }
    }
    const nbSize = Math.max(12, Math.min(20, Math.round(R * 0.08)));
    noBearing.forEach((t, i) => {
      boxedText(formatNoBearing(t, units), cx, cy + Rt * 0.55 + i * nbSize * 1.9, { color: TCAS_COLORS[t.threat], size: nbSize, border: null });
    });

    drawVsiTape(W - 16 - SIDE / 2 + 8, cy, Math.min(R * 0.62, (H - TOP - BOTTOM) / 2 - fs * 2), banner?.vsi, own, fs);
    drawFlightData(own, fs);
    drawWaypointData(W, nav, fs);
    if (banner) boxedText(banner.text, cx, 56, { color: banner.color, size: Math.max(14, Math.min(20, Math.round(W / 34))) });

    // Bottom-left: POV and TCAS mode, status, then altitude display mode and filter.
    const tcasMode = own?.mode ?? 'TA/RA';
    text(`${ownId} POV`, 16, H - 70, { size: fs + 1 });
    ctx.font = `700 ${fs + 1}px ${FONT}`;
    text(tcasMode === 'STBY' ? 'TCAS STBY' : tcasMode, 16 + ctx.measureText(`${ownId} POV`).width + fs, H - 70, { color: tcasMode === 'TA/RA' ? TCAS_COLORS.data : TCAS_COLORS.TA, size: fs });
    const sy = H - 44;
    if (stale) text('NO DATA', 16, sy, { color: TCAS_COLORS.TA, size: fs + 1 });
    else if (s.mode !== 'airspace' && !s.phones[ownId].connected && !boardsReporting(s)) text(`OWN SHIP (${ownId}) OFFLINE`, 16, sy, { color: TCAS_COLORS.TA, size: fs + 1 });
    else if (offscale) text('TRAFFIC', 16, sy, { color: TCAS_COLORS[offscale], size: fs + 1 }); // TA/RA beyond the selected range
    else if (!traffic.length) text('NO TRAFFIC', 16, sy, { color: TCAS_COLORS.dim, size: fs });
    if (s?.mode === 'airspace') text(`REL  ${altFilter}`,16, H - 18, { color: TCAS_COLORS.data, size: fs });
  }

  return {
    mount(el) {
      wrap = document.createElement('div');
      wrap.className = 'tcas-wrap';
      canvas = document.createElement('canvas');
      canvas.className = 'view-fill';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `TCAS traffic and navigation display, ${ownId} point of view`);
      ctx = canvas.getContext('2d');
      buildControls();
      useMode('phones');
      wrap.append(canvas, controls);
      el.append(wrap);
      this.resize();
    },

    update(s, _dt, info) {
      if (!ctx) return;
      draw(s, info);
    },

    resize() {
      if (!canvas) return;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(wrap.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(wrap.clientHeight * dpr));
    },

    unmount() {
      wrap?.remove();
      ctx = null;
    },
  };
}
