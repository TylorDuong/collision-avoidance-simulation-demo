// Wire protocol shared by server, dashboard, ESP32 boards and simulators.
// JSON text frames only (field `t` = type).

export const MSG = {
  // any client -> server
  HELLO: 'hello', // { role: 'dashboard'|'sim'|'device', id?, fw?, token?, mock?, speed? }
  // airspace simulator -> server (tools/mock-airspace.js)
  AIRSPACE: 'airspace', // { simTime, loop, aircraft[], perspectives: { A, B }, pair } — see tools/sim/airspace.js
  // server -> dashboard
  STATE: 'state',
  // dashboard -> server
  DEVICE_TEST: 'deviceTest', // { id?, ms? } — pulse an actuator's RA output
  SETTINGS: 'settings', // { proximateIn?, taIn?, raIn?, taTtc?, raTtc? } — live demo zones
  // dashboard -> server, then server -> airspace simulator and mock boards (hello with mock: true)
  MOCK_SPEED: 'mockSpeed', // { speed } — how fast the mock data plays: 1 = real time, 0 = paused
  // ESP32 board <-> server (see server/devices.js)
  ALERT: 'alert', // server -> device { level, range, seq, epoch }
  APPLIED: 'applied', // device -> server { level, mechanism, source, peer }
  TEST: 'test', // server -> device { ms }
  RANGE: 'range', // device -> server { range } — ultrasonic distance in metres, null = no echo
};

/** Threat levels, ordered. Names follow TCAS: other < proximate < TA < RA. */
export const THREAT = ['other', 'proximate', 'TA', 'RA'];
