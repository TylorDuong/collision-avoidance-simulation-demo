// Microcontroller actuators (e.g. ESP32s driving an LED or a relay/servo).
// They connect as plain-WebSocket clients to ws://<laptop>:<httpPort>/device — no TLS,
// which keeps the firmware simple; it's LAN-only, optionally guarded by a shared token.
// Boards also relay alerts to each other over ESP-NOW (firmware/esp32-actuator), so a board
// whose WebSocket drops keeps receiving alerts through its peer.
//
// device -> server  { t: 'hello', role: 'device', id, fw?, token? }
//                   { t: 'applied', level, mechanism, source, peer }   on change + every few s
//                     source: 'server' | 'peer' | 'none'  (where the board's current alert came from)
//                     peer:   { id, alive, rssi, ws } | null   (what it hears from its ESP-NOW peer)
//                   { t: 'range', range }   ultrasonic distance in metres to the other node;
//                     null = no echo. Feeds the same range filter as the phones (engine.handleRange).
// server -> device  { t: 'alert', level, range, seq, epoch }  on every threat change + 1 Hz refresh.
//                     seq increases on every send; epoch identifies this server run, so boards
//                     can tell a fresher relayed copy from a stale one.
//                   { t: 'test', ms }                          run the RA output for `ms`

import { randomInt } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { MSG } from '../shared/protocol.js';

export function attachDevices({ server, engine, path = '/device', token = null, heartbeatMs = 2000 }) {
  const wss = new WebSocketServer({ server, path, perMessageDeflate: false });
  const devices = new Map(); // ws -> info
  const epoch = randomInt(1, 2 ** 31);
  let seq = 0;

  const alertMsg = () => ({
    t: MSG.ALERT,
    level: engine.threat.threat,
    range: engine.estimate ? Math.round(engine.estimate.range * 1000) / 1000 : null,
    seq: ++seq,
    epoch,
  });
  const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

  wss.on('connection', (ws, req) => {
    const info = { id: null, ip: req.socket.remoteAddress, fw: null, applied: null, mechanism: false, source: null, peer: null, alive: true };
    ws.on('pong', () => (info.alive = true));
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.t === MSG.HELLO && msg.role === 'device') {
        if (token && msg.token !== token) return void ws.close(4001, 'bad token');
        info.id = String(msg.id ?? 'device').slice(0, 32);
        info.fw = msg.fw ?? null;
        devices.set(ws, info);
        console.log(`device ${info.id} connected from ${info.ip}`);
        send(ws, alertMsg());
      } else if (msg.t === MSG.RANGE && devices.has(ws)) {
        engine.handleRange(info.id, msg);
      } else if (msg.t === MSG.APPLIED && devices.has(ws)) {
        info.applied = msg.level ?? null;
        info.mechanism = !!msg.mechanism;
        info.source = msg.source ?? null;
        const prevPeerAlive = info.peer?.alive;
        info.peer = msg.peer && msg.peer.id ? { id: String(msg.peer.id).slice(0, 32), alive: !!msg.peer.alive, rssi: msg.peer.rssi ?? null, ws: !!msg.peer.ws } : null;
        if (info.peer && prevPeerAlive !== undefined && prevPeerAlive !== info.peer.alive) {
          console.log(`device ${info.id}: peer ${info.peer.id} ${info.peer.alive ? 'back' : 'LOST'}`);
        }
      }
    });
    ws.on('close', () => {
      if (devices.delete(ws)) console.log(`device ${info.id} disconnected`);
    });
  });

  // Drop devices that stop answering pings (Wi-Fi loss without a clean close).
  setInterval(() => {
    for (const [ws, info] of devices) {
      if (!info.alive) {
        ws.terminate();
        continue;
      }
      info.alive = false;
      ws.ping();
    }
  }, heartbeatMs);

  const broadcast = () => {
    const msg = alertMsg();
    for (const ws of devices.keys()) send(ws, msg);
  };
  engine.on('alert', broadcast);
  setInterval(broadcast, 1000);

  return {
    /**
     * Boards connected over WebSocket, plus boards only heard of through a peer's ESP-NOW
     * reports (connected: false), so a board that lost Wi-Fi still shows up.
     */
    list() {
      const direct = [...devices.values()].map(({ id, ip, fw, applied, mechanism, source, peer }) => ({ id, ip, fw, applied, mechanism, source, peer, connected: true }));
      const known = new Set(direct.map((d) => d.id));
      const viaPeer = [];
      for (const d of direct) {
        if (d.peer && !known.has(d.peer.id)) {
          known.add(d.peer.id);
          viaPeer.push({ id: d.peer.id, ip: null, fw: null, applied: null, mechanism: null, source: null, peer: null, connected: false, seenBy: d.id, peerAlive: d.peer.alive });
        }
      }
      return [...direct, ...viaPeer];
    },
    test(id, ms = 1000) {
      for (const [ws, info] of devices) if (!id || info.id === id) send(ws, { t: MSG.TEST, ms });
    },
  };
}
