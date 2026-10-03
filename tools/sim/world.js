// Simulated acoustic world for two phones: each phone has its own audio clock,
// audio I/O latency and speaker-to-own-mic distance; chirps propagate at the speed of
// sound over a scripted A–B distance, with background noise and one echo.
// Used by the unit tests (stepped clock) and tools/mock-phones.js (real time).

import { makeChirp, speedOfSound, CHIRP_KIND } from '../../shared/chirp.js';

export function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SCRIPTS = {
  // Smoothly oscillate between 2.0 m and 0.15 m every 16 s.
  oscillate: (t) => 1.075 + 0.925 * Math.cos((2 * Math.PI * t) / 16),
  // 2 m -> 0.1 m over 10 s, hold 3 s, back out over 5 s, repeat.
  approach: (t) => {
    const u = t % 18;
    if (u < 10) return 2 - 0.19 * u;
    if (u < 13) return 0.1;
    return 0.1 + (1.9 * (u - 13)) / 5;
  },
  static: (d) => () => d,
};

export class AcousticWorld {
  constructor({ distance, temperatureC = 20, noise = 0.01, echo = { delay: 0.0015, gain: 0.3 }, seed = 1 }) {
    this.distance = distance;
    this.c = speedOfSound(temperatureC);
    this.noise = noise;
    this.echo = echo;
    this.rng = mulberry32(seed);
    this.phones = {};
    this.emissions = [];
  }

  addPhone(id, { sampleRate = 48000, clockOffset = 0, outLatency = 0.03, inLatency = 0.02, selfDistance = 0.04 } = {}) {
    this.phones[id] = { id, sampleRate, clockOffset, outLatency, inLatency, selfDistance };
  }

  /** Phone's audio-clock frame at simulated time t. */
  frameAt(id, t) {
    const p = this.phones[id];
    return Math.floor((t - p.clockOffset) * p.sampleRate);
  }

  /** Phone `id` handles a chirp command at sim time t; returns the frame it reports. */
  chirp(id, t, delay) {
    const p = this.phones[id];
    this.emissions.push({ emitter: id, tEmit: t + delay + p.outLatency });
    this.emissions = this.emissions.filter((e) => t - e.tEmit < 5);
    return Math.round((t + delay - p.clockOffset) * p.sampleRate);
  }

  _gauss() {
    const u = Math.max(1e-12, this.rng());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rng());
  }

  /** Render `n` frames of phone `id`'s microphone starting at its frame `start`. */
  render(id, start, n) {
    const p = this.phones[id];
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.noise * this._gauss();
    for (const e of this.emissions) {
      const own = e.emitter === id;
      const d = own ? p.selfDistance : this.distance(e.tEmit);
      const gain = own ? 0.6 : Math.min(0.6, 0.2 / Math.max(d, 0.2));
      const tArr = e.tEmit + d / this.c + p.inLatency;
      this._add(out, start, p, CHIRP_KIND[e.emitter], tArr, gain);
      if (this.echo) this._add(out, start, p, CHIRP_KIND[e.emitter], tArr + this.echo.delay, gain * this.echo.gain);
    }
    return out;
  }

  _add(out, start, p, kind, tArr, gain) {
    const f = (tArr - p.clockOffset) * p.sampleRate;
    const i0 = Math.floor(f);
    const len = Math.ceil(0.02 * p.sampleRate);
    if (i0 + len < start || i0 >= start + out.length) return;
    const chirp = makeChirp(p.sampleRate, kind, { offset: f - i0, gain });
    for (let k = 0; k < chirp.length; k++) {
      const j = i0 + k - start;
      if (j >= 0 && j < out.length) out[j] += chirp[k];
    }
  }
}
