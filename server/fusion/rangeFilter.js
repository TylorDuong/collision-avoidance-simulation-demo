// 1-D constant-velocity Kalman filter over the A–B distance.
// State x = [r, ṙ] (m, m/s). Measurements are timestamped; the filter only advances
// on measurements, and the display estimate is extrapolated from the last one.

export class RangeFilter {
  constructor({ q, gateSigma, maxConsecutiveRejects, maxPredictHorizon }) {
    this.q = q;
    this.gate2 = gateSigma * gateSigma;
    this.maxRejects = maxConsecutiveRejects;
    this.maxHorizon = maxPredictHorizon;
    this.reset();
  }

  reset() {
    this.x = null;
    this.P = null;
    this.t = null;
    this.rejects = 0;
  }

  get initialized() {
    return this.x !== null;
  }

  static _predict(x, P, dt, q) {
    const xr = x[0] + dt * x[1];
    const xv = x[1];
    const dt2 = dt * dt, dt3 = dt2 * dt;
    const p00 = P[0] + dt * (P[1] + P[2]) + dt2 * P[3] + (q * dt3) / 3;
    const p01 = P[1] + dt * P[3] + (q * dt2) / 2;
    const p10 = P[2] + dt * P[3] + (q * dt2) / 2;
    const p11 = P[3] + q * dt;
    return { x: [xr, xv], P: [p00, p01, p10, p11] };
  }

  _advance(t) {
    const dt = Math.max(0, t - this.t);
    const { x, P } = RangeFilter._predict(this.x, this.P, dt, this.q);
    this.x = x;
    this.P = P;
    this.t = Math.max(this.t, t);
  }

  // Scalar update of state component `i` (0 = range, 1 = rate).
  _update(i, z, R) {
    const S = this.P[i * 3] + R; // P00 or P11
    const y = z - this.x[i];
    const K0 = (i === 0 ? this.P[0] : this.P[1]) / S;
    const K1 = (i === 0 ? this.P[2] : this.P[3]) / S;
    this.x = [this.x[0] + K0 * y, this.x[1] + K1 * y];
    const [p00, p01, p10, p11] = this.P;
    const h0 = i === 0 ? p00 : p10;
    const h1 = i === 0 ? p01 : p11;
    this.P = [p00 - K0 * h0, p01 - K0 * h1, p10 - K1 * h0, p11 - K1 * h1];
  }

  /**
   * @param {number} z measured range (m)
   * @param {number} R measurement variance (m²)
   * @param {number} t measurement time (s)
   * @returns {{ accepted: boolean, nis?: number, reinitialized?: boolean }}
   */
  update(z, R, t) {
    if (!this.initialized) {
      this.x = [z, 0];
      this.P = [R, 0, 0, 1];
      this.t = t;
      return { accepted: true, reinitialized: true };
    }
    this._advance(t);
    const y = z - this.x[0];
    const S = this.P[0] + R;
    const nis = (y * y) / S;
    if (nis > this.gate2) {
      if (++this.rejects > this.maxRejects) {
        // Persistent disagreement: the track is lost, re-acquire from the measurement.
        this.x = [z, 0];
        this.P = [R, 0, 0, 1];
        this.rejects = 0;
        return { accepted: true, nis, reinitialized: true };
      }
      return { accepted: false, nis };
    }
    this.rejects = 0;
    this._update(0, z, R);
    if (this.x[0] < 0) this.x[0] = 0;
    return { accepted: true, nis };
  }

  /** Estimate at time `t` without mutating the filter. */
  estimate(t) {
    if (!this.initialized) return null;
    const dt = Math.min(Math.max(0, t - this.t), this.maxHorizon);
    const { x, P } = RangeFilter._predict(this.x, this.P, dt, this.q);
    return { range: Math.max(0, x[0]), rate: x[1], sigma: Math.sqrt(Math.max(0, P[0])), age: t - this.t };
  }
}
