// Audio ring buffer (indexed by each phone's own absolute sample index) and an
// FFT matched filter that finds a chirp's arrival with sub-sample precision.

import FFT from 'fft.js';
import { int16ToFloat } from '../../shared/protocol.js';

export class AudioRing {
  constructor(capacity) {
    this.capacity = capacity;
    this.buf = new Float32Array(capacity);
    this.end = null; // absolute index one past the newest sample
    this.first = null; // absolute index of the first sample since the last reset
  }

  get oldest() {
    return this.end === null ? null : Math.max(this.first, this.end - this.capacity);
  }

  /** @returns {boolean} true if the stream was discontinuous and the buffer was reset */
  push(firstIndex, pcm) {
    const n = pcm.length;
    let reset = false;
    if (this.end === null || firstIndex < this.end - this.capacity || firstIndex > this.end + this.capacity) {
      reset = this.end !== null;
      this.buf.fill(0);
      this.end = firstIndex;
      this.first = firstIndex;
    } else if (firstIndex > this.end) {
      for (let i = this.end; i < firstIndex; i++) this.buf[i % this.capacity] = 0;
    }
    const f = int16ToFloat(pcm);
    for (let i = 0; i < n; i++) this.buf[(firstIndex + i) % this.capacity] = f[i];
    this.end = Math.max(this.end, firstIndex + n);
    return reset;
  }

  has(start, len) {
    return this.end !== null && start >= this.oldest && start + len <= this.end;
  }

  read(start, len) {
    start = Math.floor(start);
    if (!this.has(start, len)) return null;
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = this.buf[(start + i) % this.capacity];
    return out;
  }
}

function nextPow2(n) {
  let p = 2;
  while (p < n) p <<= 1;
  return p;
}

export class MatchedFilter {
  /** @param {Float32Array} template */
  constructor(template) {
    this.template = template;
    this.cache = new Map(); // fft size -> { fft, H }
  }

  _plan(size) {
    let plan = this.cache.get(size);
    if (!plan) {
      const fft = new FFT(size);
      const padded = new Array(size).fill(0);
      for (let i = 0; i < this.template.length; i++) padded[i] = this.template[i];
      const H = fft.createComplexArray();
      fft.realTransform(H, padded);
      plan = { fft, H, input: new Array(size), X: fft.createComplexArray(), C: fft.createComplexArray(), out: fft.createComplexArray() };
      this.cache.set(size, plan);
    }
    return plan;
  }

  /**
   * Find the template in `signal`.
   * @returns {{ lag: number, peak: number, snr: number } | null} lag = fractional index in
   *   `signal` where the template starts.
   */
  detect(signal) {
    const m = this.template.length;
    const lags = signal.length - m + 1;
    if (lags < 3) return null;
    const size = nextPow2(signal.length + m);
    const { fft, H, input, X, C, out } = this._plan(size);
    for (let i = 0; i < size; i++) input[i] = i < signal.length ? signal[i] : 0;
    fft.realTransform(X, input);

    // Analytic cross-correlation: R[k] = 2·X[k]·conj(H[k]) for positive frequencies, 0 elsewhere.
    // Its magnitude is the correlation envelope, which is free of carrier-cycle ambiguity.
    C.fill(0);
    for (let k = 1; k < size / 2; k++) {
      const xr = X[2 * k], xi = X[2 * k + 1];
      const hr = H[2 * k], hi = H[2 * k + 1];
      C[2 * k] = 2 * (xr * hr + xi * hi);
      C[2 * k + 1] = 2 * (xi * hr - xr * hi);
    }
    fft.inverseTransform(out, C);

    const env = new Float32Array(lags);
    let max = 0, maxIdx = 0;
    for (let l = 0; l < lags; l++) {
      const v = Math.hypot(out[2 * l], out[2 * l + 1]);
      env[l] = v;
      if (v > max) { max = v; maxIdx = l; }
    }
    if (max === 0) return null;

    // Prefer the earliest strong peak shortly before the maximum: the direct path
    // arrives first, reflections can be stronger.
    const lookback = Math.round(m * 0.25);
    let p = maxIdx;
    for (let l = Math.max(1, maxIdx - lookback); l < maxIdx; l++) {
      if (env[l] >= 0.5 * max && env[l] >= env[l - 1] && env[l] >= env[l + 1]) { p = l; break; }
    }

    let delta = 0;
    if (p > 0 && p < lags - 1) {
      const y0 = env[p - 1], y1 = env[p], y2 = env[p + 1];
      const denom = y0 - 2 * y1 + y2;
      if (denom !== 0) delta = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom));
    }

    const sorted = Float32Array.from(env).sort();
    const noise = sorted[sorted.length >> 1] || 1e-12;
    return { lag: p + delta, peak: env[p], snr: env[p] / noise };
  }
}
