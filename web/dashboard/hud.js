// HUD in two parts: primary telemetry pinned in the top bar (threat, range, closing speed,
// TTC) and the technical diagnostics in the collapsible bottom drawer.

const LEVEL_TEXT = { other: 'OTHER', proximate: 'PROXIMATE', TA: 'TA', RA: 'RA' };
const REASON_TEXT = { range: 'inside distance threshold', ttc: 'time-to-collision threshold', 'no-data': 'no range data' };
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
    <div class="metric"><span class="k">TTC</span><span class="v" data-k="ttc">—</span></div>`;
  const { el, set } = bind(root);
  const threat = root.querySelector('.threat');

  return {
    update(s, age) {
      if (!s) return;
      const stale = age > STALE_MS;
      threat.dataset.level = stale ? 'stale' : s.threat.level;
      set('level', stale ? 'NO DATA' : LEVEL_TEXT[s.threat.level]);
      set('range', fmt(s.range.range, 2, ' m'));
      set('closing', fmt(s.range.closingSpeed, 2, ' m/s'));
      set('ttc', s.range.ttc === null ? '—' : fmt(s.range.ttc, 1, ' s'));
    },
  };
}

export function createDiagnostics(root, { onCalibrate, onDeviceTest }) {
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
      <h2>Acoustic ranging</h2>
      <dl class="kv">
        <dt>Status</dt><dd data-k="ac-run">—</dd>
        <dt>Success (last 20)</dt><dd data-k="ac-rate">—</dd>
        <dt>Last raw</dt><dd data-k="ac-last">—</dd>
        <dt>Weakest SNR</dt><dd data-k="ac-snr">—</dd>
        <dt>Last failure</dt><dd data-k="ac-fail">—</dd>
      </dl>
    </section>
    <section class="card">
      <h2>Phones</h2>
      <div class="phones">
        ${['A', 'B'].map((id) => `
          <div class="phone" data-phone="${id}">
            <header><i class="dot" data-k="${id}-on"></i>${id}</header>
            <dl class="kv">
              <dt>motion</dt><dd data-k="${id}-motion">—</dd>
              <dt>audio</dt><dd data-k="${id}-audio">—</dd>
              <dt>gps</dt><dd data-k="${id}-gps">—</dd>
              <dt>latency</dt><dd data-k="${id}-lat">—</dd>
              <dt>rtt</dt><dd data-k="${id}-rtt">—</dd>
              <dt>state</dt><dd data-k="${id}-moving">—</dd>
              <dt>north</dt><dd data-k="${id}-north">—</dd>
            </dl>
          </div>`).join('')}
      </div>
    </section>
    <section class="card">
      <h2>Actuators</h2>
      <div class="devices" data-k="devices"><p class="note">No ESP32 connected.</p></div>
    </section>
    <section class="card calib">
      <h2>Calibration</h2>
      <p class="note">Hold the phones side by side, speakers and mics uncovered, at the distance below. Then press Calibrate.</p>
      <div class="row">
        <input type="number" step="0.01" min="0.01" value="0.10" aria-label="Calibration distance in metres" data-k="cal-d" /> m
        <button class="btn" data-k="cal-btn">Calibrate</button>
      </div>
      <div class="bar"><i data-k="cal-bar"></i></div>
      <dl class="kv">
        <dt>State</dt><dd data-k="cal-state">—</dd>
        <dt>K (speaker↔mic)</dt><dd data-k="cal-k">—</dd>
      </dl>
    </section>`;

  const { el, set } = bind(root);

  el['cal-btn'].addEventListener('click', () => onCalibrate(Number(el['cal-d'].value)));
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

  return {
    update(s, age) {
      if (!s) return;
      const stale = age > STALE_MS;

      el.source.dataset.v = s.range.source;
      set('source', s.range.source);
      set('sigma', s.range.sigma === null ? '—' : `±${fmt(s.range.sigma * 100, 1)} cm`);
      set('reason', stale ? 'server state is stale' : REASON_TEXT[s.threat.reason] ?? '—');

      const ac = s.acoustic;
      set('ac-run', ac.running ? 'running' : 'waiting for both phones');
      set('ac-rate', `${Math.round(ac.successRate * 100)}%`);
      set('ac-last', ac.last ? `${fmt(ac.last.distance, 3, ' m')} · ${ac.last.ageMs} ms ago` : '—');
      set('ac-snr', ac.last ? fmt(Math.min(...Object.values(ac.last.snr)), 1) : '—');
      set('ac-fail', ac.lastFailure ?? '—');

      for (const id of ['A', 'B']) {
        const p = s.phones[id];
        el[`${id}-on`].dataset.on = String(p.connected);
        set(`${id}-motion`, p.connected ? `${p.rates.motion} Hz` : '—');
        set(`${id}-audio`, p.connected ? `${p.rates.audio}/s` : '—');
        set(`${id}-gps`, p.gps ? `±${Math.round(p.gps.acc)} m` : '—');
        set(`${id}-lat`, p.latencyMs === null ? '—' : `${p.latencyMs} ms`);
        set(`${id}-rtt`, p.rttMs === null ? '—' : `${p.rttMs} ms`);
        set(`${id}-moving`, p.connected ? (p.moving ? 'moving' : 'still') : '—');
        set(`${id}-north`, p.connected ? (p.northAligned ? 'aligned' : 'no compass') : '—');
      }

      renderDevices(s.devices);

      const c = s.calibration;
      set('cal-state', c.state === 'collecting' ? `collecting ${Math.round(c.progress * 100)}%` : c.calibrated ? 'calibrated' : 'default K');
      el['cal-bar'].style.width = `${(c.state === 'collecting' ? c.progress : c.calibrated ? 1 : 0) * 100}%`;
      set('cal-k', `${fmt(c.K * 100, 1)} cm`);
    },
  };
}
