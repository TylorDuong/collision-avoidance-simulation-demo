import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Engine } from '../server/engine.js';
import { attachDevices } from '../server/devices.js';
import { attachUwb } from '../server/uwb.js';
import { config } from '../server/config.js';

async function setup() {
  const server = http.createServer();
  const engine = new Engine(config, { persist: false });
  attachDevices({ server, engine });
  attachUwb({ server, engine });
  server.listen(0);
  await once(server, 'listening');
  return { server, engine, port: server.address().port };
}

// Opens a socket and keeps every message so none is missed between awaits.
async function client(port, path, hello) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  ws.inbox = [];
  ws.on('message', (d) => ws.inbox.push(JSON.parse(d.toString())));
  await once(ws, 'open');
  ws.send(JSON.stringify(hello));
  return ws;
}
const until = async (fn) => {
  for (let i = 0; i < 100; i++) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('timed out');
};

test('uwb endpoint relays tokens between phones and feeds range into the engine', async () => {
  const { server, engine, port } = await setup();
  const a = await client(port, '/uwb', { t: 'hello', role: 'uwb', id: 'A' });
  a.send(JSON.stringify({ t: 'token', data: 'tokenA' }));
  const b = await client(port, '/uwb', { t: 'hello', role: 'uwb', id: 'B' }); // joins after A: gets A's token on connect
  await until(() => b.inbox.find((m) => m.t === 'peerToken' && m.data === 'tokenA'));
  b.send(JSON.stringify({ t: 'token', data: 'tokenB' }));
  await until(() => a.inbox.find((m) => m.t === 'peerToken' && m.data === 'tokenB'));

  for (let i = 0; i < 5; i++) a.send(JSON.stringify({ t: 'range', distance: 1.2, direction: [0, 0, -1] }));
  await until(() => engine.lastUwb && engine.lastUwb.id === 'A');
  assert.equal(engine.lastUwb.distance, 1.2);
  assert.deepEqual(engine.lastUwb.direction, [0, 0, -1]);
  assert.deepEqual(engine.getState().uwb.phones, { A: true, B: true });
  engine.tick();
  assert.equal(engine.getState().range.source, 'uwb');
  assert.ok(Math.abs(engine.getState().range.range - 1.2) < 0.05);

  a.close(); b.close(); server.close(); server.closeAllConnections();
});

test('uwb ignores junk distances', async () => {
  const { server, engine, port } = await setup();
  const a = await client(port, '/uwb', { t: 'hello', role: 'uwb', id: 'A' });
  for (const distance of [-1, 'x', null, 1e9]) a.send(JSON.stringify({ t: 'range', distance }));
  a.send(JSON.stringify({ t: 'range', distance: 0.5 }));
  await until(() => engine.lastUwb);
  assert.equal(engine.lastUwb.distance, 0.5);
  a.close(); server.close(); server.closeAllConnections();
});

test('/device keeps working next to /uwb', async () => {
  const { server, port } = await setup();
  const d = await client(port, '/device', { t: 'hello', role: 'device', id: 'esp32-A' });
  await until(() => d.inbox.find((m) => m.t === 'alert'));
  d.close(); server.close(); server.closeAllConnections();
});
