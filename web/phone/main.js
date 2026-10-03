// Phone sensor page: a "dumb" node that streams motion, GPS and raw microphone audio
// to the laptop and plays its ranging chirp when told to.

import { makeChirp, CHIRP_KIND } from '../../shared/chirp.js';
import { MSG, encodeAudioFrame } from '../../shared/protocol.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ?silent=1: no microphone, no chirps. The server only starts ranging cycles once both
// phones stream audio, so this leaves distance to GPS + motion (coarse; see README).
const SILENT = new URLSearchParams(location.search).has('silent');

let role = store.get('phone-role') === 'B' ? 'B' : 'A';
let ctx = null;
let chirpBuffer = null;
let ws = null;
let wakeLock = null;
const latest = { orientation: null };
const counters = { motion: 0, audio: 0, dropped: 0 };
const status = { conn: 'connecting…', gps: '—', chirp: '—' };

// ---- setup UI ---------------------------------------------------------------------

function renderRole() {
  for (const b of document.querySelectorAll('.role')) b.setAttribute('aria-checked', String(b.dataset.role === role));
}
for (const b of document.querySelectorAll('.role')) {
  b.addEventListener('click', () => {
    role = b.dataset.role;
    store.set('phone-role', role);
    renderRole();
  });
}
renderRole();

if (!window.isSecureContext) {
  showSetupError('This page must be opened over HTTPS, or iOS will block the motion sensors and microphone. See the README for certificate setup.');
}

function showSetupError(msg) {
  $('setup-error').textContent = msg;
  $('setup-error').hidden = false;
}

$('start').addEventListener('click', async () => {
  $('start').disabled = true;
  try {
    // Everything that needs a user gesture is started synchronously here, before any await.
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!SILENT) try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch { /* Safari < 16.4 */ }
    ctx = new AC({ latencyHint: 'interactive' });
    const resumed = ctx.resume();
    const motionPerm = typeof DeviceMotionEvent?.requestPermission === 'function' ? DeviceMotionEvent.requestPermission() : 'granted';
    const orientPerm = typeof DeviceOrientationEvent?.requestPermission === 'function' ? DeviceOrientationEvent.requestPermission() : 'granted';

    if ((await motionPerm) !== 'granted' || (await orientPerm) !== 'granted') {
      throw new Error('Motion & orientation access was denied. Allow it in Safari settings for this site, then reload.');
    }
    if (!SILENT) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      await resumed;
      await startAudio(stream);
    }
    startMotion();
    startGps();
    await requestWakeLock();
    connect();
    document.body.dataset.stage = 'running';
    $('badge-role').textContent = role;
    setInterval(renderStatus, 500);
  } catch (err) {
    console.error(err);
    showSetupError(err.message || String(err));
    $('start').disabled = false;
  }
});

// ---- audio ------------------------------------------------------------------------

async function startAudio(stream) {
  // Served as a plain file from web/public (Safari won't load an inlined data: URL worklet).
  await ctx.audioWorklet.addModule('/phone/capture-worklet.js');
  const node = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  ctx.createMediaStreamSource(stream).connect(node).connect(mute).connect(ctx.destination);
  node.port.onmessage = ({ data }) => {
    counters.audio++;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Under backpressure drop chunks; the server fills gaps with silence.
    if (ws.bufferedAmount > 256 * 1024) {
      counters.dropped++;
      return;
    }
    ws.send(encodeAudioFrame(role, data.firstFrame, data.pcm));
  };

  const samples = makeChirp(ctx.sampleRate, CHIRP_KIND[role]);
  chirpBuffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  chirpBuffer.copyToChannel(samples, 0);
}

function playChirp(seq, delay) {
  if (!ctx || !chirpBuffer) return;
  const when = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = chirpBuffer;
  src.connect(ctx.destination);
  src.start(when);
  send({ t: MSG.CHIRPED, seq, frame: Math.round(when * ctx.sampleRate) });
  status.chirp = `#${seq}`;
}

// ---- motion & GPS -----------------------------------------------------------------

function startMotion() {
  window.addEventListener('deviceorientation', (e) => {
    latest.orientation = {
      alpha: e.alpha,
      beta: e.beta,
      gamma: e.gamma,
      heading: e.webkitCompassHeading ?? null,
      headingAcc: e.webkitCompassAccuracy ?? null,
    };
  });
  window.addEventListener('devicemotion', (e) => {
    counters.motion++;
    const a = e.acceleration || {};
    const r = e.rotationRate || {};
    send({
      t: MSG.MOTION,
      ts: performance.now(),
      ...(latest.orientation ?? {}),
      ax: a.x, ay: a.y, az: a.z,
      rotRate: [r.alpha, r.beta, r.gamma],
    });
  });
}

function startGps() {
  if (!navigator.geolocation) {
    status.gps = 'unavailable';
    return;
  }
  navigator.geolocation.watchPosition(
    (p) => {
      const c = p.coords;
      status.gps = `±${Math.round(c.accuracy)} m`;
      send({ t: MSG.GPS, ts: performance.now(), lat: c.latitude, lon: c.longitude, alt: c.altitude, acc: c.accuracy, altAcc: c.altitudeAccuracy });
    },
    (err) => { status.gps = err.code === 1 ? 'denied' : 'no fix'; },
    { enableHighAccuracy: true, maximumAge: 0 },
  );
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* not supported or denied: user must keep the screen on */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!wakeLock || wakeLock.released) requestWakeLock();
    ctx?.resume();
  }
});

// ---- server connection ------------------------------------------------------------

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  ws = new WebSocket(`wss://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  status.conn = 'connecting…';
  ws.onopen = () => {
    status.conn = 'connected';
    send({ t: MSG.HELLO, role: 'phone', id: role, sampleRate: ctx.sampleRate, ua: navigator.userAgent });
  };
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.t) {
      case MSG.CHIRP: playChirp(msg.seq, msg.delay); break;
      case MSG.PING: send({ t: MSG.PONG, s: msg.s, c: performance.now() }); break;
      case MSG.ALERT: setAlert(msg.level); break;
    }
  };
  ws.onclose = (ev) => {
    status.conn = ev.code === 4000 ? 'replaced by another phone' : 'reconnecting…';
    setAlert('other');
    if (ev.code !== 4000) setTimeout(connect, 1000);
  };
}

const ALERT_TEXT = { other: 'CLEAR', proximate: 'PROXIMATE', TA: 'TRAFFIC', RA: 'TOO CLOSE' };
function setAlert(level) {
  document.body.dataset.alert = level;
  $('badge-alert').textContent = ALERT_TEXT[level] ?? level;
}

// ---- status -----------------------------------------------------------------------

let lastCounts = { motion: 0, audio: 0, at: performance.now() };
function renderStatus() {
  const now = performance.now();
  const dt = (now - lastCounts.at) / 1000;
  const motionHz = Math.round((counters.motion - lastCounts.motion) / dt);
  const audioHz = ((counters.audio - lastCounts.audio) / dt).toFixed(1);
  lastCounts = { motion: counters.motion, audio: counters.audio, at: now };

  $('s-conn').textContent = status.conn;
  $('s-audio').textContent = SILENT ? 'off (silent mode)' : `${ctx.sampleRate} Hz · ${audioHz} chunks/s${counters.dropped ? ` · ${counters.dropped} dropped` : ''}`;
  $('s-motion').textContent = latest.orientation ? `${motionHz} Hz` : 'waiting…';
  $('s-gps').textContent = status.gps;
  $('s-chirp').textContent = status.chirp;

  const warn = !SILENT && ctx.state !== 'running' ? 'Audio is suspended. Tap the screen.' : motionHz === 0 && latest.orientation === null ? 'No motion data yet.' : '';
  $('run-warning').textContent = warn;
  $('run-warning').hidden = !warn;
}
document.addEventListener('click', () => ctx?.resume());
