// Combined TCAS traffic / RA display in the IVSI format (TCAS II v7.1 intro booklet, Fig. 3)
// for one aircraft's (or phone's) point of view: `ownId` is own ship. Reads
// state.perspectives[ownId]; units follow state.mode (UNITS in symbols.js).
//   - Rim: vertical speed scale (0 at 9 o'clock, 0 .5 1 2 4 6 thousand fpm up and down)
//     with the own-ship needle. During an RA, red arcs mark the rates to avoid and a green
//     arc the rate to fly.
//   - Face: heading-up traffic display, own ship at the centre, each aircraft at its range
//     and relative bearing with its symbol and data tag. Range markings at half scale
//     (ring of 12 dots) and full scale; selected range boxed in the upper right.
//     Off-scale TAs/RAs are half symbols at the edge. Traffic without a bearing is only
//     reported in writing, for TAs/RAs ("RA 4.5 +12").
//   - Overlay: own-ship data (GS, heading, altitude, V/S), TCAS mode, altitude filter and
//     status annunciations; the advisory banner stands in for the aural annunciation.

import { TCAS_COLORS, UNITS, drawOwnship, drawTraffic, drawHalfSymbol, drawDataTag, formatNoBearing } from './symbols.js';
import { AdvisoryTracker, VSI_MAX } from './advisories.js';

// Non-linear IVSI scale: dial value -> degrees clockwise from 9 o'clock.
const VSI_ANCHORS = [[0, 0], [0.5, 35], [1, 65], [2, 110], [4, 145], [6, 170]];
const VSI_MAJOR = [0, 0.5, 1, 2, 4, 6];
const VSI_MINOR = [0.25, 0.75, 1.5, 3, 5];
const ALT_FILTERS = [['ABV', 'ABV'], ['NORM', 'N'], ['BLW', 'BLW']];
const ORDER = { other: 0, proximate: 1, TA: 2, RA: 3 };
const FONT = "'B612 Mono', ui-monospace, monospace";
const TOP = 80; // own-ship data + advisory banner
const BOTTOM = 66; // status annunciations + range / altitude-filter buttons

const prefs = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

/** Canvas angle (radians, as used by ctx.arc) of a dial value. */
function vsiAngle(v) {
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
  return Math.PI + (Math.sign(v) * deg * Math.PI) / 180;
}

const fmtScale = (v) => (v === 0.5 ? '.5' : String(v));
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');

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

  function drawRaArcs(cx, cy, R, vsi) {
    if (!vsi) return;
    const band = Math.max(5, R * 0.065);
    ctx.save();
    ctx.lineWidth = band;
    ctx.lineCap = 'butt';
    const arc = ([lo, hi], color) => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, R - band / 2, vsiAngle(lo), vsiAngle(hi));
      ctx.stroke();
    };
    for (const r of vsi.red) arc(r, TCAS_COLORS.vsiRed);
    arc(vsi.green, TCAS_COLORS.vsiGreen);
    ctx.restore();
  }

  function drawVsiScale(cx, cy, R) {
    const r1 = R * 0.9;
    const fontPx = Math.max(10, Math.round(R * 0.085));
    ctx.save();
    ctx.strokeStyle = TCAS_COLORS.scale;
    ctx.lineCap = 'round';
    const tick = (v, len, width) => {
      const a = vsiAngle(v);
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (r1 - len), cy + Math.sin(a) * (r1 - len));
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    };
    for (const v of VSI_MINOR) for (const s of [1, -1]) tick(s * v, R * 0.045, Math.max(1, R * 0.008));
    for (const v of VSI_MAJOR) {
      for (const s of v === 0 ? [1] : [1, -1]) {
        tick(s * v, R * 0.08, Math.max(1.5, R * 0.014));
        const a = vsiAngle(s * v);
        const rl = R * 0.75;
        text(fmtScale(v), cx + Math.cos(a) * rl, cy + Math.sin(a) * rl, { color: TCAS_COLORS.scale, size: fontPx, align: 'center', baseline: 'middle' });
      }
    }
    ctx.restore();
  }

  function drawNeedle(cx, cy, R, verticalSpeed) {
    if (verticalSpeed === null || verticalSpeed === undefined) return; // no own-ship vertical speed source
    const a = vsiAngle(verticalSpeed / units.vsi);
    ctx.save();
    ctx.strokeStyle = TCAS_COLORS.scale;
    ctx.fillStyle = TCAS_COLORS.scale;
    ctx.lineWidth = Math.max(2.5, R * 0.025);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * R * 0.81, cy + Math.sin(a) * R * 0.81);
    ctx.lineTo(cx + Math.cos(a) * R * 0.98, cy + Math.sin(a) * R * 0.98);
    ctx.stroke();
    ctx.restore();
  }

  // Half scale: ring of 12 dots. Full scale: thin ring. Both in the own-ship colour.
  function drawRangeMarkings(cx, cy, Rt) {
    ctx.save();
    ctx.fillStyle = TCAS_COLORS.ring;
    const dot = Math.max(1.5, Rt * 0.016);
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      circle(cx + Math.sin(a) * (Rt / 2), cy - Math.cos(a) * (Rt / 2), dot);
      ctx.fill();
    }
    ctx.strokeStyle = TCAS_COLORS.ring;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    circle(cx, cy, Rt);
    ctx.stroke();
    ctx.restore();
  }

  // ---- traffic -----------------------------------------------------------------------

  // Display altitude filter; TAs, RAs and traffic without altitude are always shown.
  function passesFilter(t) {
    if (t.threat === 'TA' || t.threat === 'RA' || t.relAlt === null || t.relAlt === undefined) return true;
    const [below, above] = units.altFilter[altFilter];
    return t.relAlt >= below && t.relAlt <= above;
  }

  /** @returns {boolean} true when drawn as an off-scale half symbol */
  function drawPositionedTraffic(cx, cy, Rt, sym, t) {
    const a = (t.bearing * Math.PI) / 180;
    const full = rangeScale * units.range;
    if (t.range > full) {
      if (t.threat !== 'TA' && t.threat !== 'RA') return false;
      drawHalfSymbol(ctx, cx + Math.sin(a) * Rt, cy - Math.cos(a) * Rt, sym, t.threat, a);
      return true;
    }
    const r = (t.range / full) * Rt;
    const x = cx + Math.sin(a) * r;
    const y = cy - Math.cos(a) * r;
    drawTraffic(ctx, x, y, sym, t.threat);
    drawDataTag(ctx, x, y, sym, t, TCAS_COLORS[t.threat], units);
    return false;
  }

  // ---- overlay -----------------------------------------------------------------------

  function drawOwnshipData(W, own, fs) {
    const line = (i) => 22 + i * (fs + 7);
    text(`${ownId} POV`, 16, line(0), { size: fs + 3 });
    const gs = own?.groundSpeed;
    text(gs === null || gs === undefined ? `GS ---` : `GS ${units.speed(gs)} ${units.speedUnit}`, 16, line(1), { color: TCAS_COLORS.data, size: fs });
    const tcasMode = own?.mode ?? 'TA/RA';
    text(tcasMode === 'STBY' ? 'TCAS STBY' : tcasMode, 16, line(2), { color: tcasMode === 'TA/RA' ? TCAS_COLORS.data : TCAS_COLORS.TA, size: fs });

    const heading = own?.heading ?? null;
    text(heading === null ? 'HDG ---' : `HDG ${String(Math.round(heading) % 360).padStart(3, '0')}°`, W - 16, line(0), { size: fs + 1, align: 'right' });
    const alt = own?.altitude;
    text(alt === null || alt === undefined ? 'ALT ---' : `ALT ${units.altitude(alt)} ${units.altitudeUnit}`, W - 16, line(1), { color: TCAS_COLORS.data, size: fs, align: 'right' });
    const vs = own?.verticalSpeed;
    text(vs === null || vs === undefined ? 'V/S ---' : `V/S ${signed(units.vs(vs))} ${units.vsUnit}`, W - 16, line(2), { color: TCAS_COLORS.data, size: fs, align: 'right' });
  }

  // ---- frame -------------------------------------------------------------------------

  function draw(s, info) {
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    useMode(s?.mode ?? 'phones');

    const R = Math.max(60, Math.min(W - 32, H - TOP - BOTTOM) / 2 / 1.04);
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

    drawBezel(cx, cy, R);
    drawRaArcs(cx, cy, R, banner?.vsi);
    drawVsiScale(cx, cy, R);
    drawRangeMarkings(cx, cy, Rt);
    drawNeedle(cx, cy, R, own?.verticalSpeed);
    drawOwnship(ctx, cx, cy, sym * 1.6);
    const boxAngle = (38 * Math.PI) / 180;
    boxedText(`${rangeScale}`, cx + Math.sin(boxAngle) * R * 0.71, cy - Math.cos(boxAngle) * R * 0.71, { color: TCAS_COLORS.ring, size: Math.max(11, Math.round(R * 0.07)) });

    // Least severe first, so TAs and RAs are drawn on top.
    const shown = traffic.filter((t) => t.range !== null && passesFilter(t)).sort((a, b) => ORDER[a.threat] - ORDER[b.threat]);
    const noBearing = [];
    let offscale = null;
    for (const t of shown) {
      if (t.bearing === null || t.bearing === undefined) {
        if (t.threat === 'TA' || t.threat === 'RA') noBearing.push(t);
      } else if (drawPositionedTraffic(cx, cy, Rt, sym, t)) {
        if (!offscale || ORDER[t.threat] > ORDER[offscale]) offscale = t.threat;
      }
    }
    const nbSize = Math.max(12, Math.min(20, Math.round(R * 0.08)));
    noBearing.forEach((t, i) => {
      boxedText(formatNoBearing(t, units), cx, cy + Rt * 0.55 + i * nbSize * 1.9, { color: TCAS_COLORS[t.threat], size: nbSize, border: null });
    });

    drawOwnshipData(W, own, fs);
    if (banner) boxedText(banner.text, cx, 60, { color: banner.color, size: Math.max(14, Math.min(20, Math.round(W / 34))) });

    // Bottom-left: status, then altitude display mode and filter.
    const sy = H - 44;
    if (stale) text('NO DATA', 16, sy, { color: TCAS_COLORS.TA, size: fs + 1 });
    else if (s.mode !== 'airspace' && !s.phones[ownId].connected) text(`OWN SHIP (${ownId}) OFFLINE`, 16, sy, { color: TCAS_COLORS.TA, size: fs + 1 });
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
      canvas.setAttribute('aria-label', `TCAS traffic and resolution advisory display, ${ownId} point of view`);
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
