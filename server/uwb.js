// Native iOS app (ios/) endpoint: UWB ranging via Nearby Interaction. Plain WebSocket on the
// HTTP port, ws://<laptop>:<httpPort>/uwb — no TLS, so the app needs no certificate trust.
//
// app -> server  { t: 'hello', role: 'uwb', id: 'A'|'B' }
//                { t: 'token', data }                 base64 NIDiscoveryToken of this phone's session
//                { t: 'range', distance, direction? } metres; direction = unit vector [x,y,z] if available
// server -> app  { t: 'peerToken', data }             the other phone's latest token (on connect + on change)
//                { t: 'alert', level }                threat level, same values as the web phone page
//
// The server only relays tokens; each app builds its own NINearbyPeerConfiguration from the
// peer's token and the two phones range each other directly over UWB.

import { WebSocketServer } from 'ws';
import { MSG, PHONE_IDS } from '../shared/protocol.js';

export function attachUwb({ server, engine, path = '/uwb' }) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  // Several WebSocket endpoints share this HTTP server, so each claims only its own path
  // (a path-filtered WebSocketServer would otherwise abort the others' upgrades).
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== path) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  const clients = { A: null, B: null }; // id -> { ws, token }
  const other = (id) => (id === 'A' ? 'B' : 'A');
  const send = (ws, msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

  engine.uwbPhones = () => ({ A: !!clients.A, B: !!clients.B });
  engine.on('alert', (now) => {
    for (const id of PHONE_IDS) if (clients[id]) send(clients[id].ws, { t: MSG.ALERT, level: now.threat });
  });

  wss.on('connection', (ws, req) => {
    let id = null;

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.t === MSG.HELLO) {
        if (msg.role !== 'uwb' || !PHONE_IDS.includes(msg.id)) return;
        id = msg.id;
        clients[id]?.ws.close(4000, 'replaced');
        clients[id] = { ws, token: null };
        console.log(`uwb ${id} connected from ${req.socket.remoteAddress}`);
        send(ws, { t: MSG.ALERT, level: engine.threat.threat });
        // Hand over the peer's token if it is already waiting.
        const peer = clients[other(id)];
        if (peer?.token) send(ws, { t: 'peerToken', data: peer.token });
      } else if (id && msg.t === 'token' && typeof msg.data === 'string') {
        clients[id].token = msg.data;
        const peer = clients[other(id)];
        if (peer) send(peer.ws, { t: 'peerToken', data: msg.data });
      } else if (id && msg.t === 'range') {
        const dir = Array.isArray(msg.direction) && msg.direction.length === 3 && msg.direction.every(Number.isFinite) ? msg.direction : null;
        engine.handleUwb(id, { distance: Number(msg.distance), direction: dir });
      }
    });

    ws.on('close', () => {
      if (id && clients[id]?.ws === ws) {
        clients[id] = null;
        console.log(`uwb ${id} disconnected`);
      }
    });
  });
}
