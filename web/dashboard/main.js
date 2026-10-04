// Dashboard shell: one connection + store, primary telemetry in the top bar, tabbed views
// (TCAS: two mirrored side-by-side displays, A POV and B POV; 3D: the airspace) and a
// collapsible diagnostics drawer. Every display implements
// { mount(el), update(state, dt, info), resize(), unmount() }.

import { createStore } from './store.js';
import { connect } from './connection.js';
import { createPrimaryHud, createDiagnostics } from './hud.js';
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
const primary = createPrimaryHud($('hud-primary'));
const diagnostics = createDiagnostics($('diagnostics'), {
  onDeviceTest: (id) => conn.send({ t: MSG.DEVICE_TEST, id, ms: 1000 }),
  onSettings: (settings) => conn.send({ t: MSG.SETTINGS, ...settings }),
});

// ---- interface size -----------------------------------------------------------------------
// The page is sized in rem (style.css), so --ui scales all of it. The default is a little below
// the browser's 100% so everything fits when the browser itself is zoomed in; the displays
// re-fit their windows on their own (ResizeObserver below).

const UI_SIZES = [0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
const UI_DEFAULT = 0.9;
let uiSize = Number(prefs.get('ui-size'));
if (!UI_SIZES.includes(uiSize)) uiSize = UI_DEFAULT;

function setUiSize(size) {
  uiSize = size;
  document.documentElement.style.setProperty('--ui', String(size));
  document.querySelector('#ui-size [data-ui="reset"]').textContent = `${Math.round(size * 100)}%`;
  prefs.set('ui-size', String(size));
}
const stepUi = (by) => setUiSize(UI_SIZES[Math.max(0, Math.min(UI_SIZES.length - 1, UI_SIZES.indexOf(uiSize) + by))]);
document.querySelector('#ui-size [data-ui="smaller"]').addEventListener('click', () => stepUi(-1));
document.querySelector('#ui-size [data-ui="larger"]').addEventListener('click', () => stepUi(1));
document.querySelector('#ui-size [data-ui="reset"]').addEventListener('click', () => setUiSize(UI_DEFAULT));
setUiSize(uiSize);

// ---- mock data speed --------------------------------------------------------------------
// Shown while a mock source (tools/mock-esp32.js, tools/mock-airspace.js) is connected. The
// slider moves in fixed stops; the server holds the value and pushes it to the mocks, so it
// follows the server unless it is being dragged.

const MOCK_SPEEDS = [0, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const mockSpeed = { el: $('mock-speed'), dragging: false };
mockSpeed.input = mockSpeed.el.querySelector('input');
mockSpeed.output = mockSpeed.el.querySelector('output');
mockSpeed.input.max = String(MOCK_SPEEDS.length - 1);
const speedText = (v) => (v === 0 ? 'PAUSED' : `${v}×`);
const nearestStop = (v) => MOCK_SPEEDS.reduce((best, s, i) => (Math.abs(s - v) < Math.abs(MOCK_SPEEDS[best] - v) ? i : best), 0);

mockSpeed.input.addEventListener('input', () => {
  const speed = MOCK_SPEEDS[Number(mockSpeed.input.value)];
  mockSpeed.output.textContent = speedText(speed);
  mockSpeed.el.dataset.paused = String(speed === 0);
  conn.send({ t: MSG.MOCK_SPEED, speed });
});
mockSpeed.input.addEventListener('pointerdown', () => (mockSpeed.dragging = true));
window.addEventListener('pointerup', () => (mockSpeed.dragging = false));

function updateMockSpeed(s) {
  const mock = s?.mock;
  mockSpeed.el.hidden = !mock?.sources;
  if (!mock || mockSpeed.dragging || document.activeElement === mockSpeed.input) return;
  const i = String(nearestStop(mock.speed));
  if (mockSpeed.input.value !== i) mockSpeed.input.value = i;
  mockSpeed.output.textContent = speedText(mock.speed);
  mockSpeed.el.dataset.paused = String(mock.speed === 0);
}

// ---- diagnostics drawer -------------------------------------------------------------------

const drawer = $('hud-drawer');
if (prefs.get('hud-drawer') === 'closed') drawer.open = false;
drawer.addEventListener('toggle', () => prefs.set('hud-drawer', drawer.open ? 'open' : 'closed'));

// ---- tabs and displays ------------------------------------------------------------

const mounted = {}; // tab id -> its displays, created on first visit (the 3D tab starts WebGL)
let displays = [];
let currentId = null;

function mountDisplay(el, view) {
  el.replaceChildren();
  view.mount(el);
  new ResizeObserver(() => view.resize()).observe(el);
  return view;
}

function switchView(id) {
  if (!VIEWS[id] || id === currentId) return;
  for (const [tabId, v] of Object.entries(VIEWS)) $(v.panel).hidden = tabId !== id;
  const panel = $(VIEWS[id].panel);
  if (!mounted[id]) {
    const views = VIEWS[id].create();
    const slots = panel.querySelectorAll('[data-mount]');
    mounted[id] = views.map((view, i) => mountDisplay(slots[i], view));
  }
  displays = mounted[id];
  for (const view of displays) view.resize(); // sizes were zero while the panel was hidden
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
    guard(() => updateMockSpeed(store.state));
  }
}
requestAnimationFrame(frame);
