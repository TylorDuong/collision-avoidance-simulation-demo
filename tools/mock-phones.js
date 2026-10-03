// Two simulated phones that connect to the running server exactly like real ones:
// motion at 60 Hz, GPS at 1 Hz, and synthesized 48 kHz microphone audio in which the
// chirps arrive with the delay implied by a scripted A–B distance.
//
//   npm run mock                         # oscillate 2.0 m <-> 0.15 m
//   npm run mock -- --script approach    # approach, hold, retreat
//   npm run mock -- --script static:0.5  # fixed distance
//   npm run mock -- --url wss://192.168.1.50:8443/ws --noise 0.02

import WebSocket from 'ws';
import { parseArgs } from 'node:util';
import { MSG, encodeAudioFrame, floatToInt16 } from '../shared/protocol.js';
import { AcousticWorld, SCRIPTS } from './sim/world.js';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: `wss://localhost:${process.env.HTTPS_PORT || 8443}/ws` },
    script: { type: 'string', default: 'oscillate' },
    noise: { type: 'string', default: '0.01' },
  },
});

function scriptFor(name) {
  if (name.startsWith('static:')) return SCRIPTS.static(Number(name.split(':')[1]));
  if (SCRIPTS[name] && name !== 'static') return SCRIPTS[name];
  throw new Error(`Unknown script "${name}". Use oscillate, approach or static:<metres>.`);
}

const distance = scriptFor(args.script);
const world = new AcousticWorld({ distance, noise: Number(args.noise), seed: Date.now() & 0xffff });
world.addPhone('A', { clockOffset: -1234.5, outLatency: 0.03, inLatency: 0.015, selfDistance: 0.03 });
world.addPhone('B', { clockOffset: -987.6, outLatency: 0.045, inLatency: 0.02, selfDistance: 0.05 });

const t0 = performance.now() / 1000;
const simNow = () => performance.now() / 1000 - t0;
const phoneMs = (id) => (simNow() - world.phones[id].clockOffset) * 1000;
const CHUNK = 1024;
const BASE = { lat: 37.4275, lon: -122.1697 };

// Scripted orientations (degrees). Compass heading is consistent with alpha + a fixed offset.
const ORIENT = {
  A: (t) => ({ alpha: 15 * Math.sin(t * 0.3), beta: 8 * Math.sin(t * 0.7), gamma: 4 }),
  B: (t) => ({ alpha: 180 + 35 * Math.sin(t * 0.5), beta: 50 + 25 * Math.sin(t * 0.9), gamma: 15 * Math.sin(t * 1.3) }),
};
const HEADING_OFFSET = { A: 40, B: 40 };

const phones = {};

function startPhone(id) {
  const ws = new WebSocket(args.url, { rejectUnauthorized: false });
  const phone = { ws, cursor: null, last: null };
  phones[id] = phone;
  const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

  ws.on('open', () => {
    console.log(`mock ${id} connected`);
    phone.cursor = world.frameAt(id, simNow());
    send({ t: MSG.HELLO, role: 'phone', id, sampleRate: world.phones[id].sampleRate, ua: 'mock-phone' });
  });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.t === MSG.CHIRP) {
      // Simulated network + scheduling jitter before the phone acts on the command.
      setTimeout(() => {
        const frame = world.chirp(id, simNow(), msg.delay);
        send({ t: MSG.CHIRPED, seq: msg.seq, frame });
      }, 5 + Math.random() * 20);
    } else if (msg.t === MSG.PING) {
      send({ t: MSG.PONG, s: msg.s, c: phoneMs(id) });
    } else if (msg.t === MSG.ALERT && msg.level !== phone.alert) {
      phone.alert = msg.level;
    }
  });
  ws.on('close', () => {
    console.log(`mock ${id} disconnected, retrying…`);
    setTimeout(() => startPhone(id), 1000);
  });
  ws.on('error', (err) => console.error(`mock ${id}: ${err.message}`));
}

// Audio: stream whole chunks as the simulated clock advances.
setInterval(() => {
  const t = simNow();
  for (const [id, p] of Object.entries(phones)) {
    if (p.ws.readyState !== WebSocket.OPEN || p.cursor === null) continue;
    while (p.cursor + CHUNK <= world.frameAt(id, t)) {
      p.ws.send(encodeAudioFrame(id, p.cursor, floatToInt16(world.render(id, p.cursor, CHUNK))));
      p.cursor += CHUNK;
    }
  }
}, 20);

// Motion at 60 Hz.
setInterval(() => {
  const t = simNow();
  const dt = 1 / 60;
  const speed = (distance(t + dt) - distance(t - dt)) / (2 * dt);
  const accel = (distance(t + dt) - 2 * distance(t) + distance(t - dt)) / (dt * dt);
  for (const [id, p] of Object.entries(phones)) {
    if (p.ws.readyState !== WebSocket.OPEN) continue;
    const o = ORIENT[id](t);
    const prev = ORIENT[id](t - dt);
    const moving = id === 'B' && Math.abs(speed) > 0.02;
    const jitter = () => (Math.random() - 0.5) * 0.04;
    p.ws.send(JSON.stringify({
      t: MSG.MOTION,
      ts: phoneMs(id),
      ...o,
      heading: (((360 - o.alpha - HEADING_OFFSET[id]) % 360) + 360) % 360,
      headingAcc: 10,
      ax: (moving ? accel + Math.sign(speed) * 0.5 : 0) + jitter(),
      ay: jitter(),
      az: jitter(),
      rotRate: [(o.alpha - prev.alpha) / dt, (o.beta - prev.beta) / dt, (o.gamma - prev.gamma) / dt],
    }));
  }
}, 1000 / 60);

// GPS at 1 Hz: B is east of A by the scripted distance, with metre-level noise.
setInterval(() => {
  const d = distance(simNow());
  const mPerDegLon = 111320 * Math.cos((BASE.lat * Math.PI) / 180);
  for (const [id, p] of Object.entries(phones)) {
    if (p.ws.readyState !== WebSocket.OPEN) continue;
    const east = (id === 'B' ? d : 0) + (Math.random() - 0.5) * 4;
    const north = (Math.random() - 0.5) * 4;
    p.ws.send(JSON.stringify({
      t: MSG.GPS,
      ts: phoneMs(id),
      lat: BASE.lat + north / 111320,
      lon: BASE.lon + east / mPerDegLon,
      alt: 30 + Math.random() * 6,
      acc: 5,
      altAcc: 8,
    }));
  }
}, 1000);

setInterval(() => {
  const a = phones.A?.alert ?? '-';
  console.log(`t=${simNow().toFixed(1)}s  true distance ${distance(simNow()).toFixed(3)} m  alert ${a}`);
}, 2000);

startPhone('A');
startPhone('B');
