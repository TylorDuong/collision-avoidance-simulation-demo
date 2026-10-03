// TCAS-style traffic display (heading-up, ownship = phone A at the centre).
// Framework stage: the layout, symbology, range scales and advisory banner are in place.
// Bearing is not measured, so traffic is either drawn at a nominal 12 o'clock bearing with
// a dashed "somewhere on this circle" range ring, or shown only as a no-bearing text block.

import { TCAS_COLORS, drawOwnship, drawTraffic, drawDataTag, formatRelAlt } from './symbols.js';
import { AdvisoryTracker } from './advisories.js';

const RANGES = [1, 2, 4, 8]; // metres, full-scale radius
const prefs = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

export function createTcasView() {
  let wrap, canvas, ctx, controls;
  let dpr = 1;
  let rangeScale = RANGES.includes(Number(prefs.get('tcas-range'))) ? Number(prefs.get('tcas-range')) : 2;
  let bearingMode = prefs.get('tcas-bearing') === 'off' ? 'off' : 'nominal';
  const advisories = new AdvisoryTracker();

  function button(text, onClick, title) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = text;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function buildControls() {
    controls = document.createElement('div');
    controls.className = 'tcas-controls';

    const rangeGroup = document.createElement('div');
    rangeGroup.className = 'group';
    rangeGroup.innerHTML = '<span>RNG</span>';
    for (const r of RANGES) {
      const b = button(`${r} m`, () => {
        rangeScale = r;
        prefs.set('tcas-range', String(r));
        sync();
      });
      b.dataset.range = String(r);
      rangeGroup.append(b);
    }
    const auto = button('AUTO', () => {}, 'Automatic range scaling (coming later)');
    auto.disabled = true;
    auto.style.opacity = '0.4';
    rangeGroup.append(auto);

    const bearingGroup = document.createElement('div');
    bearingGroup.className = 'group';
    bearingGroup.innerHTML = '<span>NO-BRG</span>';
    for (const [mode, text] of [['nominal', 'PLOT 12 O\'CLK'], ['off', 'TEXT ONLY']]) {
      const b = button(text, () => {
        bearingMode = mode;
        prefs.set('tcas-bearing', mode);
        sync();
      });
      b.dataset.mode = mode;
      bearingGroup.append(b);
    }
    controls.append(rangeGroup, bearingGroup);

    function sync() {
      for (const b of controls.querySelectorAll('[data-range]')) b.setAttribute('aria-pressed', String(Number(b.dataset.range) === rangeScale));
      for (const b of controls.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === bearingMode));
    }
    sync();
  }

  function text(str, x, y, { color = TCAS_COLORS.text, size = 14, align = 'left', baseline = 'alphabetic', weight = 700 } = {}) {
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px 'B612 Mono', ui-monospace, monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.fillText(str, x, y);
  }

  function drawCompass(cx, cy, R, heading) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((-(heading ?? 0) * Math.PI) / 180);
    ctx.strokeStyle = TCAS_COLORS.ring;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
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

  function drawRangeDots(cx, cy, r) {
    ctx.fillStyle = TCAS_COLORS.ring;
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6;
      ctx.beginPath();
      ctx.arc(cx + Math.sin(a) * r, cy - Math.cos(a) * r, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function draw(s, info) {
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H / 2 + 18;
    const R = Math.max(60, Math.min(W, H - 90) * 0.44);
    const sym = Math.max(12, Math.min(22, R * 0.07));
    const now = info.now;
    const stale = !s || info.age > 2000;

    drawCompass(cx, cy, R, s?.ownship.heading ?? null);
    drawRangeDots(cx, cy, R / 2);
    text(`${rangeScale / 2}`, cx + R / 2 * Math.SQRT1_2 + 6, cy + R / 2 * Math.SQRT1_2 + 6, { color: TCAS_COLORS.dim, size: 12, weight: 400 });
    drawOwnship(ctx, cx, cy, sym * 1.6);

    // Header labels.
    text('TCAS', 16, 28, { color: TCAS_COLORS.other, size: 15 });
    text('TA/RA', 16, 48, { color: TCAS_COLORS.other, size: 13, weight: 400 });
    text(`RNG ${rangeScale} m`, W - 16, 28, { color: TCAS_COLORS.text, size: 15, align: 'right' });
    const hdg = s?.ownship.heading;
    text(hdg === null || hdg === undefined ? 'HDG ---' : `HDG ${String(Math.round(hdg) % 360).padStart(3, '0')}`, cx, 28, { size: 15, align: 'center' });

    const traffic = stale ? [] : s.traffic;
    const { banner } = advisories.update(traffic, now);
    const flashOn = now % 600 < 380;
    const noBearing = [];

    for (const t of traffic) {
      if (t.range === null) continue;
      const color = TCAS_COLORS[t.threat];
      let bearing = t.bearing;
      if (bearing === null) {
        if (t.threat === 'TA' || t.threat === 'RA' || bearingMode === 'off') noBearing.push(t);
        if (bearingMode === 'off') continue;
        // Range is known, bearing isn't: show the circle the target lies on.
        const rr = Math.min(t.range / rangeScale, 1) * R;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.35;
        ctx.setLineDash([4, 6]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        bearing = 0;
      }
      const offscale = t.range > rangeScale;
      const rr = Math.min(t.range / rangeScale, 1) * R;
      const a = (bearing * Math.PI) / 180;
      const x = cx + Math.sin(a) * rr;
      const y = cy - Math.cos(a) * rr;
      if (t.threat === 'RA' && !flashOn) continue;
      ctx.save();
      if (offscale) ctx.globalAlpha = 0.6;
      drawTraffic(ctx, x, y, sym, t.threat);
      drawDataTag(ctx, x, y, sym, t, color);
      text(t.id, x - sym * 1.1, y, { color: TCAS_COLORS.dim, size: 11, align: 'right', baseline: 'middle', weight: 400 });
      ctx.restore();
    }

    // No-bearing advisories, bottom-left, as real TCAS shows them.
    let ny = H - 20;
    for (const t of noBearing) {
      const label = t.threat === 'other' ? 'OTH' : t.threat === 'proximate' ? 'PRX' : t.threat;
      text(`${label} ${t.range.toFixed(2)}m ${formatRelAlt(t.relAlt)}`, 16, ny, { color: TCAS_COLORS[t.threat], size: 15 });
      ny -= 22;
    }

    // Status annunciations.
    if (stale) text('TCAS FAIL', 16, ny, { color: TCAS_COLORS.TA, size: 15 });
    else if (!s.phones.A.connected) text('OWN SHIP (A) OFFLINE', 16, ny, { color: TCAS_COLORS.TA, size: 15 });
    else if (!traffic.length) text('NO TRAFFIC', 16, ny, { color: TCAS_COLORS.dim, size: 14 });
    else if (traffic.every((t) => t.range === null)) text('NO RANGE', 16, ny, { color: TCAS_COLORS.dim, size: 14 });

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
      canvas.setAttribute('aria-label', 'TCAS-style traffic display');
      ctx = canvas.getContext('2d');
      buildControls();
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
