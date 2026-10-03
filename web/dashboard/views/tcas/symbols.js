// TCAS II traffic symbology, drawn on a 2D canvas.
//   other      hollow diamond, cyan/white
//   proximate  filled diamond, cyan/white
//   TA         filled amber circle
//   RA         filled red square
// Data tag: relative altitude in units (default 0.1 m, "hundreds of feet" scaled down)
// with sign, above the symbol when traffic is above and below when it is below,
// plus a vertical-trend arrow.

export const TCAS_COLORS = {
  ownship: '#ffffff',
  ring: '#c8c8c8',
  other: '#00e5ff',
  proximate: '#00e5ff',
  TA: '#ffbf00',
  RA: '#ff2a2a',
  clear: '#2bff6a',
  text: '#ffffff',
  dim: '#6b7680',
};

export const RELALT_UNIT = 0.1; // metres per data-tag unit
export const TREND_THRESHOLD = 0.1; // m/s vertical rate before an arrow is shown

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

/** @param {'other'|'proximate'|'TA'|'RA'} threat */
export function drawTraffic(ctx, x, y, size, threat) {
  const h = size / 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = Math.max(1.5, size * 0.12);
  const color = TCAS_COLORS[threat];
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.beginPath();
  switch (threat) {
    case 'RA':
      ctx.rect(-h * 0.85, -h * 0.85, h * 1.7, h * 1.7);
      ctx.fill();
      break;
    case 'TA':
      ctx.arc(0, 0, h * 0.9, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'proximate':
      diamond(ctx, h);
      ctx.fill();
      break;
    default:
      diamond(ctx, h);
      ctx.stroke();
  }
  ctx.restore();
}

function diamond(ctx, h) {
  ctx.moveTo(0, -h);
  ctx.lineTo(h, 0);
  ctx.lineTo(0, h);
  ctx.lineTo(-h, 0);
  ctx.closePath();
}

/** "+02" / "-01" / "--" */
export function formatRelAlt(relAlt) {
  if (relAlt === null || relAlt === undefined) return '--';
  const units = Math.round(relAlt / RELALT_UNIT);
  const sign = units >= 0 ? '+' : '−';
  return `${sign}${String(Math.min(99, Math.abs(units))).padStart(2, '0')}`;
}

export function drawDataTag(ctx, x, y, size, { relAlt, relAltRate }, color) {
  const text = formatRelAlt(relAlt);
  const below = relAlt !== null && relAlt !== undefined && relAlt < 0;
  const fontPx = Math.round(size * 0.85);
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.font = `700 ${fontPx}px 'B612 Mono', ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = below ? 'top' : 'bottom';
  const ty = below ? y + size * 0.85 : y - size * 0.85;
  ctx.fillText(text, x, ty);

  if (relAltRate !== null && relAltRate !== undefined && Math.abs(relAltRate) >= TREND_THRESHOLD) {
    const ax = x + size * 1.15;
    const up = relAltRate > 0;
    const len = size * 0.9;
    ctx.lineWidth = Math.max(1.5, size * 0.1);
    ctx.beginPath();
    ctx.moveTo(ax, y + (up ? len / 2 : -len / 2));
    ctx.lineTo(ax, y + (up ? -len / 2 : len / 2));
    const tip = y + (up ? -len / 2 : len / 2);
    const d = up ? 1 : -1;
    ctx.moveTo(ax - size * 0.22, tip + d * size * 0.25);
    ctx.lineTo(ax, tip);
    ctx.lineTo(ax + size * 0.22, tip + d * size * 0.25);
    ctx.stroke();
  }
  ctx.restore();
}
