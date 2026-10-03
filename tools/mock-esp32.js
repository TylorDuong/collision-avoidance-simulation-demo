// Simulated ESP32 actuators: the same server protocol and the same ESP-NOW relay/heartbeat
// rules as firmware/esp32-actuator, with an in-memory "radio" between the boards. Prints what
// each board's LED and mechanism would do. Lets you test without hardware.
//
//   npm run mock:esp32                                   # two boards, esp32-A and esp32-B
//   npm run mock:esp32 -- --drop-ws esp32-B@5-15         # B's WebSocket is down from 5 s to 15 s
//   npm run mock:esp32 -- --drop-peer 20-30              # ESP-NOW silent from 20 s to 30 s
//   npm run mock:esp32 -- --ids esp32-A --url ws://192.168.137.1:8080/device --token secret

import WebSocket from 'ws';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: `ws://localhost:${process.env.HTTP_PORT || 8080}/device` },
    ids: { type: 'string', default: 'esp32-A,esp32-B' },
    token: { type: 'string', default: '' },
    'drop-ws': { type: 'string', multiple: true, default: [] },
    'drop-peer': { type: 'string', default: '' },
  },
});

// Same constants as the firmware.
const LINK_TIMEOUT_MS = 2500;
const PEER_BEACON_MS = 200;
const PEER_TIMEOUT_MS = 1000;
const STATUS_REFRESH_MS = 5000;
const LED = { other: 'off', proximate: 'slow blink', TA: 'fast blink', RA: 'SOLID' };

const t0 = Date.now();
const elapsed = () => (Date.now() - t0) / 1000;
const during = (spec) => {
  const [a, b] = spec.split('-').map(Number);
  return () => elapsed() >= a && elapsed() < b;
};
const wsDrops = new Map(args['drop-ws'].map((s) => [s.split('@')[0], during(s.split('@')[1])]));
const peerDropped = args['drop-peer'] ? during(args['drop-peer']) : () => false;

const boards = [];

class Board {
  constructor(id) {
    this.id = id;
    this.ws = null;
    this.wsConnected = false;
    this.alert = null; // { epoch, seq, level, range, obtainedAt, source }
    this.peer = null; // { id, lastHeard, ws }
    this.testUntil = 0;
    this.sent = '';
    this.lastStatusAt = 0;
    this.shown = '';
    this.peerWasAlive = false;
  }

  log(msg) {
    console.log(`${elapsed().toFixed(1).padStart(5)}s [${this.id}] ${msg}`);
  }

  connect() {
    if (wsDrops.get(this.id)?.()) return void setTimeout(() => this.connect(), 500);
    const ws = (this.ws = new WebSocket(args.url));
    ws.on('open', () => {
      this.wsConnected = true;
      this.sent = '';
      this.log('ws connected');
      this.send({ t: 'hello', role: 'device', id: this.id, fw: 'mock-esp32/2', ...(args.token && { token: args.token }) });
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const now = Date.now();
      if (msg.t === 'alert') {
        this.alert = { epoch: msg.epoch, seq: msg.seq, level: msg.level, range: msg.range, obtainedAt: now, source: 'server' };
        this.beacon(); // relay immediately
      } else if (msg.t === 'test') {
        this.testUntil = now + msg.ms;
        this.log(`test pulse ${msg.ms} ms`);
      }
    });
    ws.on('close', () => {
      if (this.wsConnected) this.log('ws disconnected');
      this.wsConnected = false;
      setTimeout(() => this.connect(), 1000);
    });
    ws.on('error', () => {});
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  fresh(now) {
    return this.alert && now - this.alert.obtainedAt < LINK_TIMEOUT_MS;
  }

  peerAlive(now) {
    return this.peer && now - this.peer.lastHeard < PEER_TIMEOUT_MS;
  }

  // ESP-NOW broadcast to every other board.
  beacon() {
    if (peerDropped()) return;
    const now = Date.now();
    const packet = {
      id: this.id,
      ws: this.wsConnected,
      alert: this.alert && { ...this.alert, ageMs: now - this.alert.obtainedAt },
    };
    for (const b of boards) if (b !== this) b.receive(packet);
  }

  receive(p) {
    const now = Date.now();
    this.peer = { id: p.id, lastHeard: now, ws: p.ws };
    if (!p.alert) return;
    const a = this.alert;
    const obtainedAt = now - p.alert.ageMs;
    const newer = !a ||
      (p.alert.epoch === a.epoch && p.alert.seq > a.seq) ||
      (p.alert.epoch !== a.epoch && !this.fresh(now) && obtainedAt > a.obtainedAt);
    if (newer) this.alert = { ...p.alert, obtainedAt, source: 'peer' };
  }

  tick() {
    const now = Date.now();
    // Simulated Wi-Fi/WebSocket outage.
    if (wsDrops.get(this.id)?.() && this.ws?.readyState === WebSocket.OPEN) this.ws.terminate();

    const testing = now < this.testUntil;
    const fresh = this.fresh(now);
    const level = testing ? 'RA' : fresh ? this.alert.level : 'other';
    const source = fresh ? this.alert.source : 'none';
    const peerAlive = !!this.peerAlive(now);

    const shown = `${level}|${source}`;
    if (shown !== this.shown) {
      this.shown = shown;
      const led = !fresh && !testing ? 'double blink (no fresh alert)' : LED[level];
      this.log(`LED ${led}, mechanism ${level === 'RA' ? 'ON' : 'off'}  [alert via ${source}]`);
    }
    if (peerAlive !== this.peerWasAlive && this.peer) this.log(`peer ${this.peer.id} ${peerAlive ? 'alive' : 'LOST'}`);
    this.peerWasAlive = peerAlive;

    const status = JSON.stringify([level, source, peerAlive]);
    if (this.wsConnected && (status !== this.sent || now - this.lastStatusAt > STATUS_REFRESH_MS)) {
      this.sent = status;
      this.lastStatusAt = now;
      this.send({
        t: 'applied',
        level,
        mechanism: level === 'RA',
        source,
        peer: this.peer && { id: this.peer.id, alive: peerAlive, rssi: -40, ws: this.peer.ws },
      });
    }
  }
}

for (const id of args.ids.split(',')) boards.push(new Board(id.trim()));
for (const b of boards) b.connect();
setInterval(() => boards.forEach((b) => b.beacon()), PEER_BEACON_MS);
setInterval(() => boards.forEach((b) => b.tick()), 50);
