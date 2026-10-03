// Orchestrates acoustic ranging cycles: commands both phones to chirp, waits for
// enough audio from each, runs the matched filters and emits raw range measurements.

import { makeChirp, speedOfSound, CHIRP_KIND } from '../../shared/chirp.js';
import { MSG } from '../../shared/protocol.js';
import { AudioRing, MatchedFilter } from './detector.js';
import { rawRange } from './beepbeep.js';

export class RangingSession {
  /**
   * @param {object} cfg config.ranging
   * @param {object} hooks
   * @param {(id: 'A'|'B', msg: object) => void} hooks.send
   * @param {() => number} hooks.now seconds
   * @param {(m: object) => void} hooks.onMeasurement
   */
  constructor(cfg, { send, now, onMeasurement }) {
    this.cfg = cfg;
    this.send = send;
    this.now = now;
    this.onMeasurement = onMeasurement;
    this.c = speedOfSound(cfg.temperatureC);
    this.phones = { A: null, B: null };
    this.cycles = new Map(); // seq -> cycle
    this.seq = 0;
    this.lastCycleAt = -Infinity;
    this.stats = { attempts: 0, successes: 0, lastFailure: null, recent: [] };
  }

  connect(id, sampleRate) {
    const ring = new AudioRing(Math.ceil(sampleRate * this.cfg.bufferSeconds));
    const own = new MatchedFilter(makeChirp(sampleRate, CHIRP_KIND[id]));
    const otherId = id === 'A' ? 'B' : 'A';
    const other = new MatchedFilter(makeChirp(sampleRate, CHIRP_KIND[otherId]));
    this.phones[id] = { sampleRate, ring, own, other, lastAudioAt: -Infinity };
    this.cycles.clear();
  }

  disconnect(id) {
    this.phones[id] = null;
    this.cycles.clear();
  }

  pushAudio(id, firstIndex, pcm) {
    const p = this.phones[id];
    if (!p) return;
    if (p.ring.push(firstIndex, pcm)) this.cycles.clear();
    p.lastAudioAt = this.now();
    this._processReady();
  }

  onChirped(id, seq, frame) {
    const cycle = this.cycles.get(seq);
    if (!cycle) return;
    cycle.frames[id] = frame;
    this._processReady();
  }

  ready() {
    const t = this.now();
    const fresh = (p) => p && t - p.lastAudioAt < this.cfg.audioFreshMs / 1000;
    return fresh(this.phones.A) && fresh(this.phones.B);
  }

  tick() {
    const t = this.now();
    for (const [seq, cycle] of this.cycles) {
      if (t - cycle.startedAt > this.cfg.cycleTimeoutMs / 1000) {
        this.cycles.delete(seq);
        this._fail(cycle.frames.A === null || cycle.frames.B === null ? 'no-ack' : 'audio-timeout');
      }
    }
    if (this.ready() && t - this.lastCycleAt >= this.cfg.cycleMs / 1000) {
      this.lastCycleAt = t;
      const seq = ++this.seq;
      this.cycles.set(seq, { seq, startedAt: t, frames: { A: null, B: null } });
      this.stats.attempts++;
      this.send('A', { t: MSG.CHIRP, seq, delay: this.cfg.delayA });
      this.send('B', { t: MSG.CHIRP, seq, delay: this.cfg.delayA + this.cfg.gap });
    }
  }

  successRate() {
    const r = this.stats.recent;
    return r.length ? r.filter(Boolean).length / r.length : 0;
  }

  _record(ok) {
    this.stats.recent.push(ok);
    if (this.stats.recent.length > 20) this.stats.recent.shift();
  }

  _fail(reason) {
    this.stats.lastFailure = reason;
    this._record(false);
  }

  _processReady() {
    for (const [seq, cycle] of this.cycles) {
      const result = this._tryProcess(cycle);
      if (result === null) continue; // still waiting for audio
      this.cycles.delete(seq);
      if (result.ok) {
        this.stats.successes++;
        this._record(true);
        this.onMeasurement(result.measurement);
      } else {
        this._fail(result.reason);
      }
    }
  }

  /**
   * Runs detection in stages, each as soon as its audio has arrived, caching hits on the
   * cycle so a stage never waits on audio that only a later stage needs.
   * @returns {null | {ok: true, measurement} | {ok: false, reason: string}}
   */
  _tryProcess(cycle) {
    const { A, B } = this.phones;
    if (!A || !B || cycle.frames.A === null || cycle.frames.B === null) return null;
    const { ownWindow, crossWindow, gap, snrMin } = this.cfg;
    const hits = (cycle.hits ??= {});

    // Detect `filter`'s chirp in [start, start + span) of `phone`'s audio, once available.
    const stage = (key, phone, filter, start, span, failName) => {
      if (hits[key]) return hits[key];
      const len = Math.ceil(span * phone.sampleRate) + filter.template.length;
      if (phone.ring.end === null || phone.ring.end < start + len) return null;
      const sig = phone.ring.read(start, len);
      if (!sig) return { error: `${failName}-evicted` };
      const hit = filter.detect(sig);
      if (!hit || hit.snr < snrMin) return { error: `${failName}-weak` };
      return (hits[key] = { index: Math.floor(start) + hit.lag, snr: hit.snr });
    };
    const ownSpan = ownWindow[1] - ownWindow[0];

    // a1: A's own chirp in A's recording; b2: B's own chirp in B's recording.
    const a1 = stage('a1', A, A.own, cycle.frames.A + ownWindow[0] * A.sampleRate, ownSpan, 'A-own');
    const b2 = stage('b2', B, B.own, cycle.frames.B + ownWindow[0] * B.sampleRate, ownSpan, 'B-own');
    // a2: B's chirp in A's recording, ~gap after a1. b1: A's chirp in B's recording, ~gap before b2.
    const a2 = a1?.index !== undefined
      ? stage('a2', A, A.other, a1.index + (gap - crossWindow) * A.sampleRate, 2 * crossWindow, 'B-in-A')
      : null;
    const b1 = b2?.index !== undefined
      ? stage('b1', B, B.other, b2.index - (gap + crossWindow) * B.sampleRate, 2 * crossWindow, 'A-in-B')
      : null;

    for (const r of [a1, b2, a2, b1]) if (r?.error) return { ok: false, reason: r.error };
    if (!a1 || !a2 || !b1 || !b2) return null;

    const raw = rawRange(
      { a1: a1.index, a2: a2.index, fsA: A.sampleRate, b1: b1.index, b2: b2.index, fsB: B.sampleRate },
      this.c,
    );
    return {
      ok: true,
      measurement: {
        seq: cycle.seq,
        raw,
        t: cycle.startedAt + this.cfg.delayA + gap / 2,
        snr: { a1: a1.snr, a2: a2.snr, b1: b1.snr, b2: b2.snr },
      },
    };
  }
}
