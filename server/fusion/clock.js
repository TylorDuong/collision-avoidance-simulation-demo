// Ping/pong clock-offset estimate between the server and one phone.
// offset = phoneClock − serverClock (ms), taken from the lowest-RTT recent exchange.

export class ClockSync {
  constructor(window = 8) {
    this.window = window;
    this.samples = [];
  }

  /** @param {number} s server send time (ms) @param {number} c phone time (ms) @param {number} r server receive time (ms) */
  add(s, c, r) {
    const rtt = r - s;
    if (rtt < 0) return;
    this.samples.push({ rtt, offset: c - (s + rtt / 2) });
    if (this.samples.length > this.window) this.samples.shift();
  }

  get best() {
    let best = null;
    for (const s of this.samples) if (!best || s.rtt < best.rtt) best = s;
    return best;
  }

  get rtt() {
    return this.samples.length ? this.samples[this.samples.length - 1].rtt : null;
  }

  /** Convert a phone timestamp (ms) to server time (ms), or null before the first exchange. */
  toServer(phoneMs) {
    const b = this.best;
    return b ? phoneMs - b.offset : null;
  }
}
