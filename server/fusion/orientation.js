// Per-phone orientation: W3C DeviceOrientation Euler angles -> smoothed quaternion
// in the Three.js frame, with iOS's arbitrary alpha zero re-aligned to compass north.

import { fromDeviceOrientation, multiply, slerp, ENU_TO_THREE } from '../../shared/quat.js';

const wrap360 = (d) => ((d % 360) + 360) % 360;

export class OrientationTracker {
  constructor({ smoothing = 0.35, headingSmoothing = 0.05 } = {}) {
    this.smoothing = smoothing;
    this.headingSmoothing = headingSmoothing;
    this.offset = null; // unit vector [cos, sin] of the alpha -> north-referenced alpha offset
    this.q = null; // [x, y, z, w], device frame -> Three.js frame
    this.heading = null; // degrees clockwise from magnetic north
  }

  /** @param {{alpha:number, beta:number, gamma:number, heading?:number|null, headingAcc?:number|null}} m */
  update(m) {
    if (m.alpha == null || m.beta == null || m.gamma == null) return;

    // iOS: alpha is counter-clockwise from an arbitrary start; webkitCompassHeading is clockwise
    // from north and only trustworthy with the phone roughly flat. North-referenced alpha is
    // 360 − heading, so track offset = (360 − heading) − alpha with a slow circular average.
    const flat = Math.abs(m.beta) < 45 && Math.abs(m.gamma) < 45;
    if (m.heading != null && (m.headingAcc == null || m.headingAcc >= 0) && flat) {
      const target = wrap360(360 - m.heading - m.alpha) * (Math.PI / 180);
      const v = [Math.cos(target), Math.sin(target)];
      if (!this.offset) this.offset = v;
      else {
        const k = this.headingSmoothing;
        const x = this.offset[0] * (1 - k) + v[0] * k;
        const y = this.offset[1] * (1 - k) + v[1] * k;
        const n = Math.hypot(x, y) || 1;
        this.offset = [x / n, y / n];
      }
    }
    const offsetDeg = this.offset ? Math.atan2(this.offset[1], this.offset[0]) * (180 / Math.PI) : 0;
    const alphaNorth = m.alpha + offsetDeg;
    this.heading = wrap360(360 - alphaNorth);

    const q = multiply(ENU_TO_THREE, fromDeviceOrientation(alphaNorth, m.beta, m.gamma));
    this.q = this.q ? slerp(this.q, q, this.smoothing) : q;
  }

  get northAligned() {
    return this.offset !== null;
  }
}
