// Wire protocol shared by server, phone page, dashboard and simulator.
//
// JSON text frames carry control, motion, GPS and state messages (field `t` = type).
// Binary frames carry microphone audio:
//
//   offset  size  field
//   0       u8    magic 0x41 ('A')
//   1       u8    phone index (0 = A, 1 = B)
//   2       u16   reserved
//   4       f64   absolute sample index of the first sample (phone's own audio clock)
//   12      i16[] mono PCM samples, little-endian

export const PHONE_IDS = ['A', 'B'];

export const MSG = {
  // any client -> server
  HELLO: 'hello', // { role: 'phone'|'dashboard'|'sim', id?: 'A'|'B', sampleRate?, ua? }
  // airspace simulator -> server (tools/mock-airspace.js)
  AIRSPACE: 'airspace', // { simTime, loop, aircraft[], perspectives: { A, B }, pair } — see tools/sim/airspace.js
  // phone -> server
  MOTION: 'motion', // { ts, alpha, beta, gamma, heading, headingAcc, ax, ay, az, rotRate }
  GPS: 'gps', // { ts, lat, lon, alt, acc, altAcc }
  CHIRPED: 'chirped', // { seq, frame } — sample index the chirp was scheduled at
  PONG: 'pong', // { s, c }
  // server -> phone
  WELCOME: 'welcome', // { id }
  CHIRP: 'chirp', // { seq, delay } — play own chirp `delay` seconds from now
  PING: 'ping', // { s }
  ALERT: 'alert', // { level }
  // server -> dashboard
  STATE: 'state',
  // dashboard -> server
  CALIBRATE: 'calibrate', // { distance }
  DEVICE_TEST: 'deviceTest', // { id?, ms? } — pulse an actuator's RA output
  SETTINGS: 'settings', // { proximateIn?, taIn?, raIn?, taTtc?, raTtc? } — live demo zones
  // actuator device <-> server (see server/devices.js)
  APPLIED: 'applied', // device -> server { level, mechanism }
  TEST: 'test', // server -> device { ms }
  RANGE: 'range', // device -> server { range } — ultrasonic distance in metres, null = no echo
};

export const AUDIO_MAGIC = 0x41;
export const AUDIO_HEADER_BYTES = 12;

/** @param {'A'|'B'} id @param {number} firstSampleIndex @param {Int16Array} pcm */
export function encodeAudioFrame(id, firstSampleIndex, pcm) {
  const buf = new ArrayBuffer(AUDIO_HEADER_BYTES + pcm.length * 2);
  const view = new DataView(buf);
  view.setUint8(0, AUDIO_MAGIC);
  view.setUint8(1, PHONE_IDS.indexOf(id));
  view.setUint16(2, 0, true);
  view.setFloat64(4, firstSampleIndex, true);
  new Int16Array(buf, AUDIO_HEADER_BYTES).set(pcm);
  return buf;
}

/**
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {{ id: 'A'|'B', firstSampleIndex: number, pcm: Int16Array } | null}
 */
export function decodeAudioFrame(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < AUDIO_HEADER_BYTES || (bytes.byteLength - AUDIO_HEADER_BYTES) % 2) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== AUDIO_MAGIC) return null;
  const id = PHONE_IDS[view.getUint8(1)];
  if (!id) return null;
  const firstSampleIndex = view.getFloat64(4, true);
  // Copy into a fresh, exactly-sized buffer: keeps the Int16Array aligned and avoids
  // aliasing Node's pooled Buffer memory.
  const pcm = new Int16Array(new Uint8Array(bytes.subarray(AUDIO_HEADER_BYTES)).buffer);
  return { id, firstSampleIndex, pcm };
}

export function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function int16ToFloat(i16, out = new Float32Array(i16.length)) {
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 0x8000;
  return out;
}

/** Threat levels, ordered. Names follow TCAS: other < proximate < TA < RA. */
export const THREAT = ['other', 'proximate', 'TA', 'RA'];
