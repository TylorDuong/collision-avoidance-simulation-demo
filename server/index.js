// HTTP + WebSocket entry point, all on one port. Serves the built dashboard (web/dist),
// accepts dashboard and simulator WebSockets on /ws and the ESP32 boards on /device, and runs
// the engine loop.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { Engine } from './engine.js';
import { attachDevices } from './devices.js';
import { MockSpeed } from './mockSpeed.js';
import { MSG } from '../shared/protocol.js';

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
const ROUTES = { '/': '/dashboard/index.html', '/dashboard': '/dashboard/index.html' };

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
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

const engine = new Engine(config);
const server = http.createServer(serveStatic);
const mockSpeed = new MockSpeed(config.mock);
const devices = attachDevices({ engine, token: config.deviceToken, mockSpeed });
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });

// Two WebSocket endpoints share the port: route each upgrade by path.
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  const target = pathname === '/ws' ? wss : pathname === '/device' ? devices.wss : null;
  if (!target) return void socket.destroy();
  target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
});

const dashboards = new Set();

wss.on('connection', (ws, req) => {
  let role = null;
  const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.t === MSG.HELLO) {
      if (msg.role === 'dashboard') {
        role = 'dashboard';
        dashboards.add(ws);
      } else if (msg.role === 'sim') {
        role = 'sim';
        if (msg.speed !== undefined) mockSpeed.set(msg.speed); // started with --rate
        mockSpeed.add(send);
        console.log(`airspace simulator connected from ${req.socket.remoteAddress}`);
      }
      return;
    }
    if (role === 'sim' && msg.t === MSG.AIRSPACE) engine.setAirspace(msg);
    else if (role === 'dashboard' && msg.t === MSG.SETTINGS) {
      engine.applySettings(msg);
    } else if (role === 'dashboard' && msg.t === MSG.MOCK_SPEED) {
      mockSpeed.set(msg.speed);
    } else if (role === 'dashboard' && msg.t === MSG.DEVICE_TEST) {
      devices.test(msg.id, Math.min(5000, Math.max(100, Number(msg.ms) || 1000)));
    }
  });

  ws.on('close', () => {
    dashboards.delete(ws);
    if (role === 'sim') {
      mockSpeed.remove(send);
      engine.clearAirspace();
      console.log('airspace simulator disconnected');
    }
  });
});

engine.on('alert', (now, prev) => console.log(`threat ${prev} -> ${now.threat} (${now.reason ?? '-'})`));

setInterval(() => engine.tick(), 1000 / config.tickHz);
setInterval(() => {
  if (!dashboards.size) return;
  // mock: the speed slider's value, and whether any mock source is connected to show it for.
  const mock = { speed: mockSpeed.speed, max: mockSpeed.max, sources: mockSpeed.targets.size };
  const json = JSON.stringify({ ...engine.getState(), devices: devices.list(), mock });
  for (const ws of dashboards) if (ws.readyState === ws.OPEN) ws.send(json);
}, 1000 / config.stateBroadcastHz);

server.listen(config.httpPort, () => {
  console.log(`Dashboard:  http://localhost:${config.httpPort}/dashboard`);
  for (const ip of lanAddresses()) console.log(`ESP32:      ws://${ip}:${config.httpPort}/device`);
});
