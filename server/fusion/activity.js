// Is a phone being moved? Drives the range filter's process noise and the
// zero-velocity pseudo-measurement when both phones are still.

export class ActivityTracker {
  constructor({ accelOn = 0.35, accelOff = 0.15, rotOn = 25, rotOff = 10, ema = 0.15 } = {}) {
    Object.assign(this, { accelOn, accelOff, rotOn, rotOff, ema });
    this.accel = 0; // m/s², smoothed |linear acceleration|
    this.rot = 0; // deg/s, smoothed |rotation rate|
    this.moving = true; // unknown counts as moving (conservative)
    this.seen = false;
  }

  update({ ax, ay, az, rotRate }) {
    if (ax == null) return;
    const a = Math.hypot(ax, ay ?? 0, az ?? 0);
    const r = rotRate ? Math.hypot(rotRate[0] ?? 0, rotRate[1] ?? 0, rotRate[2] ?? 0) : 0;
    this.accel += this.ema * (a - this.accel);
    this.rot += this.ema * (r - this.rot);
    if (!this.seen) {
      this.seen = true;
      this.moving = a > this.accelOn || r > this.rotOn;
    } else if (this.moving) {
      if (this.accel < this.accelOff && this.rot < this.rotOff) this.moving = false;
    } else if (this.accel > this.accelOn || this.rot > this.rotOn) {
      this.moving = true;
    }
  }
}
