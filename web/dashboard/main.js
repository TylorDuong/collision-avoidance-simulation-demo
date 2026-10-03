// Dashboard shell: one connection + store, a HUD, and swappable views.
// Every view implements { mount(el), update(state, dt, info), resize(), unmount() }.

import { createStore } from './store.js';
import { connect } from './connection.js';
import { createHud } from './hud.js';
import { VIEWS } from './views/index.js';
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
const hud = createHud($('hud'), {
  onCalibrate: (distance) => conn.send({ t: MSG.CALIBRATE, distance }),
  onDeviceTest: (id) => conn.send({ t: MSG.DEVICE_TEST, id, ms: 1000 }),
});

// ---- views ------------------------------------------------------------------------

const viewEl = $('view');
let current = null;
let currentId = null;

function switchView(id) {
  if (!VIEWS[id] || id === currentId) return;
  current?.unmount();
  viewEl.replaceChildren();
  current = VIEWS[id].create();
  current.mount(viewEl);
  currentId = id;
  prefs.set('dashboard-view', id);
  for (const b of $('tabs').children) b.setAttribute('aria-selected', String(b.dataset.view === id));
}

for (const [id, v] of Object.entries(VIEWS)) {
  const b = document.createElement('button');
  b.role = 'tab';
  b.dataset.view = id;
  b.textContent = v.label;
  b.addEventListener('click', () => switchView(id));
  $('tabs').append(b);
}
const requested = new URLSearchParams(location.search).get('view') ?? prefs.get('dashboard-view');
switchView(VIEWS[requested] ? requested : Object.keys(VIEWS)[0]);

new ResizeObserver(() => current?.resize()).observe(viewEl);

// ---- frame loop -------------------------------------------------------------------

let last = performance.now();
let hudAt = 0;
let lastError = null;
// A throwing view or HUD must not kill the loop; surface the error once instead.
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
  guard(() => current?.update(store.state, dt, { age: store.age, now }));
  if (now - hudAt > 100) {
    hudAt = now;
    guard(() => hud.update(store.state, store.age));
  }
}
requestAnimationFrame(frame);
