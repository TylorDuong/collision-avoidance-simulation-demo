// ADS-B style traffic scope for one phone's point of view (heading-up, own ship = phone
// `ownId` at the centre, the other phone as traffic). Reads state.perspectives[ownId].
// Fixed 5 m scale with range rings every metre.
// Bearing is not measured: traffic without one is drawn as a dashed ring at its range
// ("somewhere on this circle"); traffic with a bearing gets a positioned symbol.

import { TCAS_COLORS, drawOwnship, drawTraffic, drawDataTag, formatRelAlt } from './symbols.js';
import { AdvisoryTracker } from './advisories.js';

const SCALE_M = 5; // full-scale radius
const RING_STEP_M = 1;

export function createTcasView({ ownId = 'A' } = {}) {
  let wrap, canvas, ctx;
  let dpr = 1;
  const advisories = new AdvisoryTracker();

  function text(str, x, y, { color = TCAS_COLORS.text, size = 14, align = 'left', baseline = 'alphabetic', weight = 700 } = {}) {
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px 'B612 Mono', ui-monospace, monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.fillText(str, x, y);
  }

  function circle(cx, cy, r) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }

  function drawCompass(cx, cy, R, heading) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((-(heading ?? 0) * Math.PI) / 180);
    ctx.strokeStyle = TCAS_COLORS.ring;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    circle(0, 0, R);
    ctx.stroke();
    ctx.globalAlpha = 0.9;
    for (let deg = 0; deg < 360; deg += 10) {
      const a = (deg * Math.PI) / 180;
      const long = deg % 30 === 0;
      const r0 = R - (long ? 12 : 6);
      ctx.beginPath();
      ctx.moveTo(Math.sin(a) * r0, -Math.cos(a) * r0);
      ctx.lineTo(Math.sin(a) * R, -Math.cos(a) * R);
      ctx.stroke();
      if (heading !== null && deg % 90 === 0) {
        ctx.save();
        ctx.translate(Math.sin(a) * (R - 26), -Math.cos(a) * (R - 26));
        ctx.rotate(((heading ?? 0) * Math.PI) / 180);
        text('NESW'[deg / 90], 0, 0, { color: TCAS_COLORS.dim, size: 13, align: 'center', baseline: 'middle' });
        ctx.restore();
      }
    }
    ctx.restore();
  }

  // 1 m … 4 m rings (5 m is the compass ring), labelled along the lower-right diagonal.
  function drawRangeRings(cx, cy, ppm) {
    ctx.save();
    ctx.strokeStyle = TCAS_COLORS.ring;
    ctx.lineWidth = 1;
    for (let m = RING_STEP_M; m <= SCALE_M; m += RING_STEP_M) {
      const r = m * ppm;
      if (m < SCALE_M) {
        ctx.globalAlpha = 0.22;
        circle(cx, cy, r);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      text(`${m}m`, cx + r * Math.SQRT1_2 + 3, cy + r * Math.SQRT1_2 + 3, { color: TCAS_COLORS.dim, size: 11, baseline: 'top', weight: 400 });
    }
    ctx.restore();
  }

  // Traffic with unknown bearing: dashed ring at its range plus a boxed tag on the ring.
  function drawRangeOnlyTraffic(cx, cy, ppm, sym, t) {
    const offscale = t.range > SCALE_M;
    const r = Math.min(t.range, SCALE_M) * ppm;
    const color = TCAS_COLORS[t.threat];
    ctx.save();
    ctx.globalAlpha = offscale ? 0.5 : 0.95;
    ctx.strokeStyle = color;
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 2;
    circle(cx, cy, r);
    ctx.stroke();
    ctx.restore();

    const label = `${t.id} ${offscale ? `>${SCALE_M}` : t.range.toFixed(2)}m ${formatRelAlt(t.relAlt)}`;
    const d = Math.max(r, sym) * Math.SQRT1_2; // keep the tag clear of the own-ship symbol
    const x = cx + d + 6;
    const y = cy - d - 6;
    ctx.font = `700 13px 'B612 Mono', ui-monospace, monospace`;
    const w = ctx.measureText(label).width;
    ctx.fillStyle = 'rgb(0 0 0 / 0.75)';
    ctx.fillRect(x - 4, y - 16, w + 8, 20);
    text(label, x, y, { color, size: 13 });
  }

  function drawPositionedTraffic(cx, cy, ppm, sym, t) {
    const r = Math.min(t.range, SCALE_M) * ppm;
    const a = (t.bearing * Math.PI) / 180;
    const x = cx + Math.sin(a) * r;
    const y = cy - Math.cos(a) * r;
    ctx.save();
    if (t.range > SCALE_M) ctx.globalAlpha = 0.6;
    drawTraffic(ctx, x, y, sym, t.threat);
    drawDataTag(ctx, x, y, sym, t, TCAS_COLORS[t.threat]);
    text(t.id, x - sym * 1.1, y, { color: TCAS_COLORS.dim, size: 11, align: 'right', baseline: 'middle', weight: 400 });
    ctx.restore();
  }

  function draw(s, info) {
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H / 2 + 12;
    const R = Math.max(60, Math.min(W, H - 80) * 0.44);
    const ppm = R / SCALE_M;
    const sym = Math.max(12, Math.min(22, R * 0.07));
    const now = info.now;
    const stale = !s || info.age > 2000;
    const pic = s?.perspectives[ownId];
    const heading = pic?.ownship.heading ?? null;

    drawRangeRings(cx, cy, ppm);
    drawCompass(cx, cy, R, heading);
    drawOwnship(ctx, cx, cy, sym * 1.6);

    // Header: POV title top-left, heading and scale top-right.
    text(`${ownId} POV`, 16, 28, { size: 16 });
    text(heading === null ? 'HDG ---' : `HDG ${String(Math.round(heading) % 360).padStart(3, '0')}°`, W - 16, 28, { size: 15, align: 'right' });
    text(`${SCALE_M}m`, W - 16, 48, { color: TCAS_COLORS.dim, size: 13, align: 'right', weight: 400 });

    const traffic = stale || !pic ? [] : pic.traffic;
    const { banner } = advisories.update(traffic, now);
    const flashOn = now % 600 < 380;

    for (const t of traffic) {
      if (t.range === null) continue;
      if (t.threat === 'RA' && !flashOn) continue;
      if (t.bearing === null) drawRangeOnlyTraffic(cx, cy, ppm, sym, t);
      else drawPositionedTraffic(cx, cy, ppm, sym, t);
    }

    // Status annunciations, bottom-left.
    const sy = H - 20;
    if (stale) text('NO DATA', 16, sy, { color: TCAS_COLORS.TA, size: 15 });
    else if (!s.phones[ownId].connected) text(`OWN SHIP (${ownId}) OFFLINE`, 16, sy, { color: TCAS_COLORS.TA, size: 15 });
    else if (!traffic.length) text('NO TRAFFIC', 16, sy, { color: TCAS_COLORS.dim, size: 14 });
    else if (traffic.every((t) => t.range === null)) text('NO RANGE', 16, sy, { color: TCAS_COLORS.dim, size: 14 });

    // Advisory banner.
    if (banner) {
      const size = 22;
      ctx.font = `700 ${size}px 'B612 Mono', ui-monospace, monospace`;
      const w = ctx.measureText(banner.text).width + 28;
      const bx = cx - w / 2;
      const by = 46;
      ctx.fillStyle = '#000';
      ctx.fillRect(bx, by, w, size + 16);
      ctx.strokeStyle = banner.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(bx, by, w, size + 16);
      text(banner.text, cx, by + (size + 16) / 2 + 1, { color: banner.color, size, align: 'center', baseline: 'middle' });
    }
  }

  return {
    mount(el) {
      wrap = document.createElement('div');
      wrap.className = 'tcas-wrap';
      canvas = document.createElement('canvas');
      canvas.className = 'view-fill';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `Traffic scope, phone ${ownId} point of view`);
      ctx = canvas.getContext('2d');
      wrap.append(canvas);
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
