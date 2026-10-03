// Coarse range from two GPS fixes. Only meaningful when the phones are far apart outdoors.

const R_EARTH = 6371000;
const rad = (d) => (d * Math.PI) / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** @returns {{ range: number, variance: number } | null} */
export function gpsRange(fixA, fixB) {
  if (!fixA || !fixB) return null;
  const range = haversine(fixA.lat, fixA.lon, fixB.lat, fixB.lon);
  const variance = (fixA.acc ?? 50) ** 2 + (fixB.acc ?? 50) ** 2;
  return { range, variance };
}

/** Relative altitude B − A (m), only when both fixes report a usable vertical accuracy. */
export function gpsRelativeAltitude(fixA, fixB, maxAltAcc = 3) {
  if (!fixA || !fixB || fixA.alt == null || fixB.alt == null) return null;
  if (!(fixA.altAcc <= maxAltAcc && fixB.altAcc <= maxAltAcc)) return null;
  return fixB.alt - fixA.alt;
}
