// How fast the mock data plays (tools/mock-esp32.js --range, tools/mock-airspace.js): one value
// for the whole server, set from the dashboard's speed slider and pushed to every connected
// mock source as { t: 'mockSpeed', speed }. 1 = real time, 0 = paused. Real boards never
// register here, so they never receive it.

import { MSG } from '../shared/protocol.js';

export class MockSpeed {
  /** @param {{ speed: number, maxSpeed: number }} cfg config.mock */
  constructor(cfg) {
    this.max = cfg.maxSpeed;
    this.speed = cfg.speed;
    this.targets = new Set(); // send functions of the connected mock sources
  }

  /**
   * Set the speed, clamped to [0, max], and push it to every mock source.
   * @returns {boolean} false when `value` is not a number (nothing changes)
   */
  set(value) {
    const v = Number(value);
    if (value === null || value === '' || !Number.isFinite(v)) return false;
    const speed = Math.round(Math.min(this.max, Math.max(0, v)) * 100) / 100;
    if (speed !== this.speed) {
      this.speed = speed;
      for (const send of this.targets) send(this.message());
    }
    return true;
  }

  /** A mock source connected: it gets the current speed now and every change after. */
  add(send) {
    this.targets.add(send);
    send(this.message());
  }

  remove(send) {
    this.targets.delete(send);
  }

  message() {
    return { t: MSG.MOCK_SPEED, speed: this.speed };
  }
}
