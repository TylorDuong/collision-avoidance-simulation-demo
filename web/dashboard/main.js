// Dashboard shell: one connection + store, primary telemetry in the top bar, two mirrored
// side-by-side ADS-B scopes (A POV, B POV) and a collapsible diagnostics drawer. Every display implements
// { mount(el), update(state, dt, info), resize(), unmount() }.

import { createStore } from './store.js';
import { connect } from './connection.js';
import { createPrimaryHud, createDiagnostics } from './hud.js';
import { createTcasView } from './views/tcas/tcasView.js';
import { MSG } from '../../shared/protocol.js';

const $ = (id) => document.getElementById(id);
const prefs = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const store = createStore();
const conn = connect({
  onState: (s) => store.set(s),
  onStatus: (status) => {
    $('conn').dataset.status = status;
    $('conn').textContent = status === 'open' ? 'live' : status;
  },
});
const primary = createPrimaryHud($('hud-primary'));
const diagnostics = createDiagnostics($('diagnostics'), {
  onCalibrate: (distance) => conn.send({ t: MSG.CALIBRATE, distance }),
  onDeviceTest: (id) => conn.send({ t: MSG.DEVICE_TEST, id, ms: 1000 }),
});

// ---- diagnostics drawer -------------------------------------------------------------------

const drawer = $('hud-drawer');
if (prefs.get('hud-drawer') === 'closed') drawer.open = false;
drawer.addEventListener('toggle', () => prefs.set('hud-drawer', drawer.open ? 'open' : 'closed'));

// ---- displays ---------------------------------------------------------------------

const displays = [];

function mountDisplay(el, view) {
  el.replaceChildren();
  view.mount(el);
  new ResizeObserver(() => view.resize()).observe(el);
  displays.push(view);
}

mountDisplay($('tcas-mount-a'), createTcasView({ ownId: 'A' }));
mountDisplay($('tcas-mount-b'), createTcasView({ ownId: 'B' }));

// ---- frame loop -------------------------------------------------------------------

let last = performance.now();
let hudAt = 0;
let lastError = null;
// A throwing display or HUD panel must not kill the loop; surface the error once instead.
function guard(fn) {
  try {
    fn();
  } catch (err) {
    if (String(err) !== lastError) {
      lastError = String(err);
      console.error(err);
      document.body.dataset.error = lastError;
    }
  }
}
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  for (const view of displays) guard(() => view.update(store.state, dt, { age: store.age, now }));
  if (now - hudAt > 100) {
    hudAt = now;
    guard(() => primary.update(store.state, store.age));
    guard(() => diagnostics.update(store.state, store.age));
  }
}
requestAnimationFrame(frame);
