// Per-board clean-up of the ultrasonic readings before they reach the range filter.
//   - Spike check against the median of each board's last few echoes: a one-off spike (missed
//     or doubled echo, crosstalk from the other board's ping) is replaced by that median and
//     never reaches the filter. Readings near the median pass unchanged, so there is no lag.
//   - Offset between the boards: two sensors rarely read the same gap identically (mounting,
//     sensor tolerance). With the readings interleaved, a constant offset makes the fused range
//     zig-zag at the reading rate. Each board's mean residual against the filter's prediction
//     is learned, and its difference from the boards' average is removed, so the boards agree
//     with each other while their average is kept.

export class BoardPrefilter {
  /**
   * @param {object} opts config.ultrasonic: medianWindow, medianMaxAge (s), spikeThreshold (m),
   *   offsetAlpha, maxOffset (m), freshSeconds (boards heard within this take part in the
   *   average offset)
   */
  constructor({ medianWindow, medianMaxAge, spikeThreshold, offsetAlpha, maxOffset, freshSeconds }) {
    this.window = medianWindow;
    this.maxAge = medianMaxAge;
    this.spike = spikeThreshold;
    this.alpha = offsetAlpha;
    this.maxOffset = maxOffset;
    this.fresh = freshSeconds;
    this.boards = new Map(); // id -> { echoes: [{ t, range }], offset, t }
  }

  _board(id) {
    let b = this.boards.get(id);
    if (!b) this.boards.set(id, (b = { echoes: [], offset: 0, t: -Infinity }));
    return b;
  }

  /** `range` taken at `t`, or the median of the board's recent echoes when it is a spike (m). */
  despike(id, range, t) {
    const b = this._board(id);
    b.t = t;
    b.echoes = [...b.echoes.filter((e) => t - e.t <= this.maxAge), { t, range }].slice(-this.window);
    const sorted = b.echoes.map((e) => e.range).sort((x, y) => x - y);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return Math.abs(range - median) > this.spike ? median : range;
  }

  /** This board's offset from the average of the boards currently reporting (m, capped). */
  correction(id, t) {
    const offsets = [...this.boards.values()].filter((b) => t - b.t <= this.fresh).map((b) => b.offset);
    if (offsets.length < 2) return 0;
    const mean = offsets.reduce((a, v) => a + v, 0) / offsets.length;
    const c = this._board(id).offset - mean;
    return Math.max(-this.maxOffset, Math.min(this.maxOffset, c));
  }

  /** Learn from an accepted reading: `residual` is its despiked value minus the filter's prediction. */
  learn(id, residual) {
    const b = this._board(id);
    b.offset += this.alpha * (residual - b.offset);
  }

  reset() {
    this.boards.clear();
  }
}
