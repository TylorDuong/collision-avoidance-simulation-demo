// HUD in two parts: primary telemetry pinned in the top bar (threat, range, closing speed,
// TTC) and the technical diagnostics in the collapsible bottom drawer. In airspace mode
// (TCAS demo simulator) the top bar shows the A–B pair in NM, knots and range tau.

const LEVEL_TEXT = { other: 'OTHER', proximate: 'PROXIMATE', TA: 'TA', RA: 'RA' };
const REASON_TEXT = { range: 'inside distance threshold', ttc: 'time-to-collision threshold', tau: 'TCAS tau / DMOD (simulator)', 'no-data': 'no range data' };
const NM = 1852;
const KT = NM / 3600;
const STALE_MS = 2000;

const fmt = (v, digits = 2, unit = '') => {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const text = v.toFixed(digits);
  return `${Number(text) === 0 ? (0).toFixed(digits) : text}${unit}`; // no "-0.00"
};

function bind(root) {
  const el = {};
  for (const node of root.querySelectorAll('[data-k]')) el[node.dataset.k] = node;
  const set = (k, text) => {
    if (el[k].textContent !== text) el[k].textContent = text;
  };
  return { el, set };
}

export function createPrimaryHud(root) {
  root.innerHTML = `
    <div class="metric threat" data-level="other"><span class="k">Threat</span><span class="v" data-k="level">—</span></div>
    <div class="metric"><span class="k">Range</span><span class="v" data-k="range">—</span></div>
    <div class="metric"><span class="k">Closing</span><span class="v" data-k="closing">—</span></div>
    <div class="metric"><span class="k" data-k="ttc-k">TTC</span><span class="v" data-k="ttc">—</span></div>`;
  const { el, set } = bind(root);
  const threat = root.querySelector('.threat');

  return {
    update(s, age) {
      if (!s) return;
      const stale = age > STALE_MS;
      threat.dataset.level = stale ? 'stale' : s.threat.level;
      set('level', stale ? 'NO DATA' : LEVEL_TEXT[s.threat.level]);
      const air = s.mode === 'airspace';
      // `fmt(null / x)` would print 0, so scale only known values. With live ultrasonic data the
      // display is in NM at the configured scale; the real gap is written beside it in inches.
      const per = (v, unit) => (v === null || v === undefined ? null : v / unit);
      const inches = s.live && s.live.range !== null ? ` · ${fmt(s.live.range / 0.0254, 1, ' in')}` : '';
      set('range', air ? `${fmt(per(s.range.range, NM), 2, ' NM')}${inches}` : fmt(s.range.range, 2, ' m'));
      set('closing', air ? fmt(per(s.range.closingSpeed, KT), 0, ' kt') : fmt(s.range.closingSpeed, 2, ' m/s'));
      set('ttc-k', air ? 'Tau' : 'TTC');
      set('ttc', s.range.ttc === null ? '—' : fmt(s.range.ttc, 1, ' s'));
    },
  };
}

// Live demo settings form: field -> [label, input step]. Names match the server's `settings` message.
const SETTING_FIELDS = {
  nmPerInch: ['NM per inch', 0.01],
  proximateIn: ['Proximate at (in)', 1],
  taIn: ['TA at (in)', 1],
  raIn: ['RA at (in)', 1],
  taTtc: ['TA time (s)', 0.1],
  raTtc: ['RA time (s)', 0.1],
};

export function createDiagnostics(root, { onDeviceTest, onSettings }) {
  root.innerHTML = `
    <section class="card">
      <h2>Range</h2>
      <dl class="kv">
        <dt>Source</dt><dd><span class="badge" data-k="source">—</span></dd>
        <dt>Uncertainty</dt><dd data-k="sigma">—</dd>
        <dt>Threat reason</dt><dd data-k="reason">—</dd>
      </dl>
    </section>
    <section class="card">
      <h2>Ultrasonic ranging</h2>
      <dl class="kv" data-k="us-boards"><dt>Boards</dt><dd>waiting for data</dd></dl>
    </section>
    <section class="card settings">
      <h2>Live demo scale and zones</h2>
      <p class="note">Maps the real gap between the planes onto the TCAS display, and sets where each threat level starts.</p>
      <div class="fields">${Object.entries(SETTING_FIELDS).map(([name, [label, step]]) => `
        <label>${label}<input type="number" min="0" step="${step}" data-k="set-${name}" data-field="${name}" /></label>`).join('')}
      </div>
      <div class="row"><button class="btn" data-k="set-apply">Apply</button><span class="note" data-k="set-msg"></span></div>
    </section>
    <section class="card">
      <h2>Actuators</h2>
      <div class="devices" data-k="devices"><p class="note">No ESP32 connected.</p></div>
    </section>`;

  const { el, set } = bind(root);

  // Settings form: follows the server's values until the user starts editing; Apply sends the
  // fields and the form goes back to following the server (which also reports a rejection).
  let editing = false;
  const settingInputs = Object.keys(SETTING_FIELDS).map((name) => el[`set-${name}`]);
  for (const input of settingInputs) input.addEventListener('input', () => (editing = true));
  el['set-apply'].addEventListener('click', () => {
    onSettings(Object.fromEntries(settingInputs.map((i) => [i.dataset.field, i.value === '' ? undefined : Number(i.value)])));
    editing = false;
  });

  function renderSettings(cfg) {
    if (!cfg) return;
    if (!editing) {
      for (const input of settingInputs) {
        const v = String(cfg[input.dataset.field]);
        if (input.value !== v && document.activeElement !== input) input.value = v;
      }
    }
    // Where each level starts on the display, so the scale can be checked at a glance.
    const nm = (inches) => fmt(inches * cfg.nmPerInch, 2, ' NM');
    set('set-msg', cfg.error ?? `proximate ${nm(cfg.proximateIn)} · TA ${nm(cfg.taIn)} · RA ${nm(cfg.raIn)}`);
    el['set-msg'].dataset.error = String(!!cfg.error);
  }

  el.devices.addEventListener('click', (e) => {
    const id = e.target.closest('[data-test]')?.dataset.test;
    if (id) onDeviceTest(id);
  });
  let devicesKey = '';

  function renderDevices(list = []) {
    const key = JSON.stringify(list);
    if (key === devicesKey) return;
    devicesKey = key;
    el.devices.replaceChildren();
    if (!list.length) {
      el.devices.innerHTML = '<p class="note">No ESP32 connected.</p>';
      return;
    }
    for (const d of list) {
      const row = document.createElement('div');
      row.className = 'device';
      const kv = (pairs) => pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
      const esc = (v) => String(v ?? '—').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
      if (d.connected) {
        const peer = d.peer
          ? `${esc(d.peer.id)} · ${d.peer.alive ? `alive${d.peer.rssi ? ` ${d.peer.rssi} dBm` : ''}` : 'LOST'}`
          : 'none heard';
        row.innerHTML = `
          <header><i class="dot" data-on="true"></i><span></span><button class="btn" data-test="">Test</button></header>
          <dl class="kv">${kv([
            ['ip', esc((d.ip ?? '').replace(/^::ffff:/, ''))],
            ['firmware', esc(d.fw)],
            ['applied', esc(d.applied)],
            ['alert via', esc(d.source)],
            ['mechanism', d.mechanism ? 'ON' : 'off'],
            ['ESP-NOW peer', peer],
          ])}</dl>`;
        row.querySelector('[data-test]').dataset.test = d.id;
      } else {
        // Board known only through its peer's ESP-NOW reports: its WebSocket is down.
        row.innerHTML = `
          <header><i class="dot" data-on="false"></i><span></span></header>
          <dl class="kv">${kv([
            ['server link', 'down'],
            ['ESP-NOW', `${d.peerAlive ? 'alive' : 'LOST'} (via ${esc(d.seenBy)})`],
          ])}</dl>`;
      }
      row.querySelector('header span').textContent = d.id;
      el.devices.append(row);
    }
  }

  // One row per board: "5.1 in", "no echo" or "NO SIGNAL", the way esp32test/test.py prints them.
  const US_TEXT = { 'no-echo': 'no echo (check sensor wiring)', 'no-signal': 'NO SIGNAL' };
  function renderUltrasonic(boards = []) {
    const rows = boards.length
      ? boards.map((b) => [`Board ${b.id}`, b.status === 'ok' ? fmt(b.range / 0.0254, 1, ' in') : US_TEXT[b.status]])
      : [['Boards', 'waiting for data']];
    const nodes = rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = k; // board ids come from the device, so never inject them as HTML
      dd.textContent = v;
      return [dt, dd];
    });
    if (nodes.map((n) => n.textContent).join('|') !== [...el['us-boards'].children].map((n) => n.textContent).join('|')) {
      el['us-boards'].replaceChildren(...nodes);
    }
  }

  return {
    update(s, age) {
      if (!s) return;
      const stale = age > STALE_MS;

      el.source.dataset.v = s.range.source;
      set('source', s.range.source);
      set('sigma', s.range.sigma === null || s.range.sigma === undefined ? '—' : `±${fmt(s.range.sigma * 100, 1)} cm`);
      set('reason', stale ? 'server state is stale' : REASON_TEXT[s.threat.reason] ?? '—');

      renderUltrasonic(s.ultrasonic?.boards);
      renderSettings(s.settings);
      renderDevices(s.devices);
    },
  };
}
