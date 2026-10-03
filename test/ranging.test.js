import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeChirp, speedOfSound } from '../shared/chirp.js';
import { encodeAudioFrame, decodeAudioFrame, floatToInt16 } from '../shared/protocol.js';
import { AudioRing, MatchedFilter } from '../server/ranging/detector.js';
import { rawRange, range, solveK } from '../server/ranging/beepbeep.js';
import { mulberry32 } from '../tools/sim/world.js';

const FS = 48000;

function noisySignal(len, at, kind, { gain = 0.3, noise = 0.02, seed = 7 } = {}) {
  const rng = mulberry32(seed);
  const sig = new Float32Array(len);
  for (let i = 0; i < len; i++) sig[i] = noise * Math.sqrt(-2 * Math.log(Math.max(1e-12, rng()))) * Math.cos(2 * Math.PI * rng());
  if (at !== null) {
    const i0 = Math.floor(at);
    const chirp = makeChirp(FS, kind, { offset: at - i0, gain });
    for (let k = 0; k < chirp.length && i0 + k < len; k++) sig[i0 + k] += chirp[k];
  }
  return sig;
}

test('matched filter locates a chirp to sub-sample precision', () => {
  const mf = new MatchedFilter(makeChirp(FS, 'up'));
  for (const at of [1000, 1234.25, 3000.5, 5555.8]) {
    const hit = mf.detect(noisySignal(8000, at, 'up', { seed: Math.round(at) }));
    assert.ok(hit, `no detection at ${at}`);
    assert.ok(Math.abs(hit.lag - at) < 1, `lag ${hit.lag} vs ${at}`);
    assert.ok(hit.snr > 20, `snr ${hit.snr}`);
  }
});

test('matched filter rejects noise and the opposite chirp direction', () => {
  const mf = new MatchedFilter(makeChirp(FS, 'up'));
  const noiseOnly = mf.detect(noisySignal(8000, null, 'up'));
  assert.ok(noiseOnly.snr < 6, `noise snr ${noiseOnly.snr}`);
  const down = mf.detect(noisySignal(8000, 2000, 'down', { gain: 0.3 }));
  const up = mf.detect(noisySignal(8000, 2000, 'up', { gain: 0.3 }));
  assert.ok(down.snr < up.snr / 2, `down ${down.snr} vs up ${up.snr}`);
});

test('matched filter prefers the direct path over a stronger echo', () => {
  const mf = new MatchedFilter(makeChirp(FS, 'up'));
  const sig = noisySignal(7000, 2000, 'up', { gain: 0.2 });
  const echo = makeChirp(FS, 'up', { gain: 0.35 });
  for (let k = 0; k < echo.length; k++) sig[2000 + 150 + k] += echo[k]; // 3 ms (~1 m extra path) later, stronger
  const hit = mf.detect(sig);
  assert.ok(Math.abs(hit.lag - 2000) < 1.5, `lag ${hit.lag}`);
});

test('BeepBeep cancels clock offsets and latencies', () => {
  const c = speedOfSound(20);
  const d = 1.37, dAA = 0.03, dBB = 0.05;
  const tA = 10.0, tB = 10.12; // emission times (true time)
  const offA = 3.3, offB = -7.1; // phone clock offsets
  const inA = 0.021, inB = 0.034; // input latencies
  const at = (t, off, inLat, fs) => (t + inLat - off) * fs;
  const arrivals = {
    a1: at(tA + dAA / c, offA, inA, FS),
    a2: at(tB + d / c, offA, inA, FS),
    b1: at(tA + d / c, offB, inB, 44100),
    b2: at(tB + dBB / c, offB, inB, 44100),
    fsA: FS,
    fsB: 44100,
  };
  assert.ok(Math.abs(range(arrivals, c, (dAA + dBB) / 2) - d) < 1e-9);
  assert.ok(Math.abs(solveK([rawRange(arrivals, c)], d) - (dAA + dBB) / 2) < 1e-9);
});

test('audio ring buffer reads, fills gaps and resets on discontinuity', () => {
  const ring = new AudioRing(1000);
  ring.push(500, new Int16Array(100).fill(1000));
  assert.equal(ring.end, 600);
  assert.equal(ring.read(450, 10), null);
  ring.push(700, new Int16Array(100).fill(2000)); // gap 600..700 filled with zeros
  const gap = ring.read(590, 20);
  assert.ok(gap[0] > 0 && gap[15] === 0);
  assert.equal(ring.push(50_000, new Int16Array(10)), true);
  assert.equal(ring.end, 50_010);
});

test('audio frames round-trip through the binary protocol', () => {
  const pcm = floatToInt16(Float32Array.from([0, 0.5, -0.5, 1, -1]));
  const buf = encodeAudioFrame('B', 123456789.0, pcm);
  // Simulate Node delivering a Buffer at an odd offset inside a larger pool.
  const pool = new Uint8Array(buf.byteLength + 3);
  pool.set(new Uint8Array(buf), 3);
  const frame = decodeAudioFrame(pool.subarray(3));
  assert.equal(frame.id, 'B');
  assert.equal(frame.firstSampleIndex, 123456789);
  assert.deepEqual([...frame.pcm], [...pcm]);
});
