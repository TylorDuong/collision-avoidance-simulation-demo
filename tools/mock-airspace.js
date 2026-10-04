// TCAS demo scenario: runs the simulated airspace (tools/sim/airspace.js) in real time and
// streams it to the running server, which shows it on the dashboard. Two TCAS aircraft (A
// and B) slowly close head-on, get a TA, then a coordinated RA they fly automatically
// (A climbs, B descends), are clear of conflict, return to their altitudes, and the
// scenario loops. Surrounding traffic shows the other symbols but is never a threat.
//
//   npm run mock                        # real time
//   npm run mock -- --rate 2            # twice as fast
//   npm run mock -- --url wss://192.168.1.50:8443/ws

import WebSocket from 'ws';
import { parseArgs } from 'node:util';
import { MSG } from '../shared/protocol.js';
import { Airspace, NM, FT } from './sim/airspace.js';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: `wss://localhost:${process.env.HTTPS_PORT || 8443}/ws` },
    rate: { type: 'string', default: '1' },
  },
});
const rate = Math.max(0.1, Number(args.rate) || 1);

const sim = new Airspace();
const STEP_HZ = 50;
const SEND_HZ = 20;
let ws = null;

function connect() {
  ws = new WebSocket(args.url, { rejectUnauthorized: false });
  ws.on('open', () => {
    console.log(`airspace sim connected to ${args.url}`);
    ws.send(JSON.stringify({ t: MSG.HELLO, role: 'sim' }));
  });
  ws.on('close', () => {
    console.log('airspace sim disconnected, retrying…');
    setTimeout(connect, 1000);
  });
  ws.on('error', (err) => console.error(`airspace sim: ${err.message}`));
}

// Step by elapsed wall-clock time (timers drift under load), in slices of at most 1/STEP_HZ.
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  let remaining = Math.min(1, (now - last) / 1000) * rate;
  last = now;
  while (remaining > 1e-6) {
    const dt = Math.min(remaining, 1 / STEP_HZ);
    sim.step(dt);
    remaining -= dt;
  }
}, 1000 / STEP_HZ);
setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...sim.snapshot(), t: MSG.AIRSPACE }));
}, 1000 / SEND_HZ);

setInterval(() => {
  const { A, B } = sim.byId;
  const s = sim.snapshot().pair;
  const ra = (a) => (a.ra ? ` RA ${a.ra.sense}` : '');
  console.log(
    `loop ${sim.loop} t=${sim.t.toFixed(0).padStart(3)}s  A–B ${(s.range / NM).toFixed(2)} NM  ${s.threat.padEnd(9)}` +
      `  A ${Math.round(A.alt / FT)} ft${ra(A)}  B ${Math.round(B.alt / FT)} ft${ra(B)}`,
  );
}, 2000);

connect();
