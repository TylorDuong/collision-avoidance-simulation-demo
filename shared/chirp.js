// Near-ultrasonic linear chirps used for acoustic two-way ranging.
// Phone A emits an up-chirp, phone B a down-chirp, so each recording can tell
// the two apart by matched filtering. Shared by the phone page (playback),
// the server (matched-filter templates) and the simulator (synthesis).

export const CHIRP = {
  fLow: 17500, // Hz — above most adults' hearing, within iPhone speaker/mic response
  fHigh: 19500, // Hz
  duration: 0.02, // s — time-bandwidth product 40: enough processing gain to tell up from down
  gain: 0.8,
};

export const CHIRP_KIND = { A: 'up', B: 'down' };

/**
 * Synthesise a Hann-windowed linear chirp.
 * @param {number} sampleRate
 * @param {'up'|'down'} kind
 * @param {object} [opts]
 * @param {number} [opts.offset=0] fractional-sample delay (0..1) applied analytically,
 *   so simulated arrivals are not quantised to whole samples.
 * @param {number} [opts.gain=CHIRP.gain]
 * @returns {Float32Array} length = ceil(duration * sampleRate) + 1
 */
export function makeChirp(sampleRate, kind, { offset = 0, gain = CHIRP.gain } = {}) {
  const T = CHIRP.duration;
  const n = Math.ceil(T * sampleRate) + 1;
  const [f0, f1] = kind === 'down' ? [CHIRP.fHigh, CHIRP.fLow] : [CHIRP.fLow, CHIRP.fHigh];
  const k = (f1 - f0) / T;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i - offset) / sampleRate;
    if (t < 0 || t > T) continue;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / T);
    out[i] = gain * w * Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
  }
  return out;
}

/** Speed of sound in air (m/s) at a given temperature (°C). */
export function speedOfSound(temperatureC = 20) {
  return 331.3 + 0.606 * temperatureC;
}
