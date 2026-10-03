// HTTPS + WSS entry point. Serves the built web app (web/dist), accepts phone and
// dashboard WebSocket connections on /ws, and runs the engine loop.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { Engine } from './engine.js';
import { attachDevices } from './devices.js';
import { loadOrCreateCerts, lanAddresses, ROOT_CA } from './certs.js';
import { MSG, PHONE_IDS, decodeAudioFrame } from '../shared/protocol.js';

const DIST = path.resolve('web/dist');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};
const ROUTES = { '/': '/index.html', '/phone': '/phone/index.html', '/dashboard': '/dashboard/index.html' };

function serveStatic(req, res) {
  const url = new URL(req.url, 'https://x');
  let p = url.pathname.replace(/\/+$/, '') || '/';
  p = ROUTES[p] ?? p;
  const file = path.join(DIST, path.normalize(p));
  if (!file.startsWith(DIST)) return void res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) {
      if (!fs.existsSync(DIST)) {
        res.writeHead(503, { 'content-type': 'text/plain' }).end('web/dist missing: run `npm run build` first.');
      } else res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

const tls = await loadOrCreateCerts();
const engine = new Engine(config);
const httpsServer = https.createServer({ cert: tls.cert, key: tls.key }, serveStatic);

// Plain HTTP: root CA download for iPhones (/ca), everything else redirects to HTTPS.
const httpServer = http.createServer((req, res) => {
  const host = (req.headers.host ?? 'localhost').split(':')[0];
  if (req.url.startsWith('/ca')) {
    if (!fs.existsSync(ROOT_CA)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('No root CA in certs/. Run `npm run certs` (mkcert) first.');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/x-x509-ca-cert',
      'content-disposition': 'attachment; filename="collision-demo-rootCA.pem"',
    });
    fs.createReadStream(ROOT_CA).pipe(res);
    return;
  }
  res.writeHead(302, { location: `https://${host}:${config.httpsPort}${req.url}` }).end();
});

// ESP32 actuators connect over plain WS on the HTTP port (no TLS on the microcontroller).
const devices = attachDevices({ server: httpServer, engine, token: config.deviceToken });

const wss = new WebSocketServer({ server: httpsServer, path: '/ws', perMessageDeflate: false });
const dashboards = new Set();
const phoneSockets = new Map();

wss.on('connection', (ws, req) => {
  let role = null;
  let phoneId = null;
  const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (role !== 'phone') return;
      const frame = decodeAudioFrame(data);
      if (frame && frame.id === phoneId) engine.handleAudio(phoneId, frame.firstSampleIndex, frame.pcm);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.t === MSG.HELLO) {
      if (msg.role === 'phone' && PHONE_IDS.includes(msg.id) && msg.sampleRate > 0) {
        role = 'phone';
        phoneId = msg.id;
        const prev = phoneSockets.get(phoneId);
        if (prev && prev !== ws) prev.close(4000, 'replaced');
        phoneSockets.set(phoneId, ws);
        engine.connectPhone(phoneId, { sampleRate: msg.sampleRate, ua: msg.ua, send });
        console.log(`phone ${phoneId} connected from ${req.socket.remoteAddress} @ ${msg.sampleRate} Hz`);
      } else if (msg.role === 'dashboard') {
        role = 'dashboard';
        dashboards.add(ws);
      }
      return;
    }
    if (role === 'phone') engine.handlePhoneMessage(phoneId, msg);
    else if (role === 'dashboard' && msg.t === MSG.CALIBRATE) {
      const d = Number(msg.distance);
      engine.calibrate(Number.isFinite(d) && d > 0 ? d : undefined);
    } else if (role === 'dashboard' && msg.t === MSG.DEVICE_TEST) {
      devices.test(msg.id, Math.min(5000, Math.max(100, Number(msg.ms) || 1000)));
    }
  });

  ws.on('close', () => {
    dashboards.delete(ws);
    if (role === 'phone' && phoneSockets.get(phoneId) === ws) {
      phoneSockets.delete(phoneId);
      engine.disconnectPhone(phoneId);
      console.log(`phone ${phoneId} disconnected`);
    }
  });
});

engine.on('alert', (now, prev) => console.log(`threat ${prev} -> ${now.threat} (${now.reason ?? '-'})`));

setInterval(() => engine.tick(), 1000 / config.tickHz);
setInterval(() => {
  if (!dashboards.size) return;
  const json = JSON.stringify({ ...engine.getState(), devices: devices.list() });
  for (const ws of dashboards) if (ws.readyState === ws.OPEN) ws.send(json);
}, 1000 / config.stateBroadcastHz);

httpsServer.listen(config.httpsPort, () => {
  const ips = lanAddresses();
  console.log(`TLS: ${tls.kind}`);
  console.log(`Dashboard:  https://localhost:${config.httpsPort}/dashboard`);
  for (const ip of ips) {
    console.log(`Phones:     https://${ip}:${config.httpsPort}/phone`);
  }
  if (fs.existsSync(ROOT_CA)) for (const ip of ips) console.log(`Root CA:    http://${ip}:${config.httpPort}/ca`);
  for (const ip of ips) console.log(`ESP32:      ws://${ip}:${config.httpPort}/device`);
});
httpServer.listen(config.httpPort);
