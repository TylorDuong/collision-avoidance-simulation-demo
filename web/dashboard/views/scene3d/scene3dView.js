// 3D view with two scenes, picked by state.mode:
//   phones    phone A at the origin, phone B on +X at the fused distance (bearing is not
//             observable), each with its real orientation. Threat zones are drawn around
//             A in TCAS colours; B carries its TCAS traffic symbol and data tag as seen
//             from A.
//   airspace  the TCAS demo simulator's aircraft (airspace3d.js).
// The advisory banner comes from the same AdvisoryTracker as the TCAS display (A's view).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TCAS_COLORS, drawTraffic, drawDataTag } from '../tcas/symbols.js';
import { AdvisoryTracker } from '../tcas/advisories.js';
import { createAirspaceLayer, VERTICAL_EXAGGERATION } from './airspace3d.js';

const PHONE_SIZE = { w: 0.072, h: 0.15, d: 0.008 }; // iPhone-sized, metres
const HEIGHT = 0.12; // phones float slightly above the grid
const COLORS = { A: 0x3fa7ff, B: 0xc77dff };
const THREAT_TINT = { other: 0x0b0d10, proximate: 0x0b1416, TA: 0x1f1604, RA: 0x2a0709 };
const ZONE_COLORS = { proximate: TCAS_COLORS.proximate, TA: TCAS_COLORS.TA, RA: TCAS_COLORS.RA };
const SYMBOL_PX = 44; // B's traffic-symbol label, CSS pixels
const CAMERA = {
  phones: { position: [0.9, 2.1, 2.9], target: [0.9, 0, 0] }, // A at the origin through ~2 m on +X
  airspace: { position: [1.5, 9, 15], target: [0, 1, 0] }, // the ~20 × 20 NM around the encounter
};

function makePhone(color) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(PHONE_SIZE.w, PHONE_SIZE.h, PHONE_SIZE.d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2 }),
  );
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(PHONE_SIZE.w * 0.9, PHONE_SIZE.h * 0.92),
    new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.2 }),
  );
  screen.position.z = PHONE_SIZE.d / 2 + 0.0005;
  // Small marker at the top edge so orientation is readable.
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(PHONE_SIZE.w * 0.35, 0.008, PHONE_SIZE.d * 1.2),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x444444 }),
  );
  top.position.y = PHONE_SIZE.h / 2 - 0.006;
  group.add(body, screen, top);
  return group;
}

function makeZone(radius, color) {
  const group = new THREE.Group();
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(1, 96),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.06, depthWrite: false }),
  );
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.985, 1, 128),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, depthWrite: false }),
  );
  group.add(disc, ring);
  group.rotation.x = -Math.PI / 2;
  group.position.y = 0.001;
  group.scale.setScalar(radius);
  return group;
}

export function createScene3dView() {
  let root, renderer, scene, camera, controls, labels, banner, hint;
  let phoneScene, airspace;
  let mode = null;
  const phones = {};
  const zones = {};
  let line;
  let shownRange = null;
  const tint = new THREE.Color(THREAT_TINT.other);
  const tmp = new THREE.Vector3();
  const advisories = new AdvisoryTracker();
  let symbolCanvas = null;
  let symbolKey = '';

  function label(text) {
    const div = document.createElement('div');
    div.className = 'label3d';
    div.textContent = text;
    labels.append(div);
    return div;
  }

  // Label holding a TCAS traffic symbol + data tag next to the phone id.
  function symbolLabel(text) {
    const div = label('');
    div.classList.add('label3d-symbol');
    symbolCanvas = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    symbolCanvas.width = symbolCanvas.height = SYMBOL_PX * dpr;
    symbolCanvas.style.width = symbolCanvas.style.height = `${SYMBOL_PX}px`;
    symbolCanvas.getContext('2d').scale(dpr, dpr);
    const span = document.createElement('span');
    span.textContent = text;
    div.append(symbolCanvas, span);
    return div;
  }

  function drawSymbol(t) {
    const key = t ? `${t.threat}|${t.relAlt?.toFixed(2)}|${t.relAltRate?.toFixed(2)}` : '';
    if (key === symbolKey) return;
    symbolKey = key;
    const ctx = symbolCanvas.getContext('2d');
    ctx.clearRect(0, 0, SYMBOL_PX, SYMBOL_PX);
    if (!t) return;
    const c = SYMBOL_PX / 2;
    drawTraffic(ctx, c - 4, c, 14, t.threat);
    drawDataTag(ctx, c - 4, c, 14, t, TCAS_COLORS[t.threat]);
  }

  function placeLabel(div, pos, visible = true) {
    tmp.copy(pos).project(camera);
    const behind = tmp.z > 1;
    div.style.display = visible && !behind ? '' : 'none';
    div.style.left = `${((tmp.x + 1) / 2) * root.clientWidth}px`;
    div.style.top = `${((1 - tmp.y) / 2) * root.clientHeight}px`;
  }

  return {
    mount(el) {
      root = document.createElement('div');
      root.className = 'view-fill';
      el.append(root);

      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
      root.append(renderer.domElement);
      labels = document.createElement('div');
      labels.className = 'view-fill';
      labels.style.pointerEvents = 'none';
      root.append(labels);
      banner = document.createElement('div');
      banner.className = 'view-banner';
      banner.hidden = true;
      root.append(banner);
      hint = document.createElement('div');
      hint.className = 'empty-hint';
      root.append(hint);

      scene = new THREE.Scene();
      scene.background = tint;
      camera = new THREE.PerspectiveCamera(45, 1, 0.01, 200);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;

      scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x101418, 1.6));
      const sun = new THREE.DirectionalLight(0xffffff, 1.4);
      sun.position.set(2, 4, 3);
      scene.add(sun);

      // Phone scene: 10 m grid (0.1 m / 1 m), zones, the two phones.
      phoneScene = new THREE.Group();
      scene.add(phoneScene);
      const fine = new THREE.GridHelper(10, 100, 0x1a2028, 0x141920);
      const coarse = new THREE.GridHelper(10, 10, 0x2b3440, 0x2b3440);
      coarse.position.y = 0.0005;
      phoneScene.add(fine, coarse);

      for (const [name, color] of Object.entries(ZONE_COLORS)) {
        zones[name] = makeZone(1, color);
        phoneScene.add(zones[name]);
      }

      for (const id of ['A', 'B']) {
        const mesh = makePhone(COLORS[id]);
        mesh.position.set(0, HEIGHT, 0);
        phoneScene.add(mesh);
        phones[id] = { mesh, label: id === 'B' ? symbolLabel(id) : label(id), q: new THREE.Quaternion() };
      }
      line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]),
        new THREE.LineDashedMaterial({ color: 0xe6e9ee, dashSize: 0.03, gapSize: 0.02 }),
      );
      phoneScene.add(line);
      phones.distLabel = label('');

      // Airspace scene: 40 NM grid (2 NM squares) and the simulated aircraft.
      airspace = createAirspaceLayer(scene, { label });
      airspace.root.add(new THREE.GridHelper(40, 20, 0x2b3440, 0x1d242c));
      this.resize();
    },

    update(s, dt, { age, now }) {
      if (!renderer) return;
      const nextMode = s?.mode === 'airspace' ? 'airspace' : 'phones';
      if (nextMode !== mode) {
        mode = nextMode;
        camera.position.set(...CAMERA[mode].position);
        controls.target.set(...CAMERA[mode].target);
        controls.update();
      }
      const air = mode === 'airspace';
      phoneScene.visible = !air;
      const connected = (id) => !air && s?.phones[id]?.connected;

      if (s) {
        for (const name of Object.keys(ZONE_COLORS)) zones[name].scale.setScalar(s.zones[name].range);
      }

      // Orientation: slerp toward the latest server quaternion every frame.
      for (const id of ['A', 'B']) {
        const p = phones[id];
        const o = s?.phones[id]?.orientation;
        if (o) p.q.set(o[0], o[1], o[2], o[3]);
        p.mesh.quaternion.slerp(p.q, 1 - Math.exp(-dt * 20));
        p.mesh.visible = !!connected(id);
      }

      const range = s?.range.range ?? null;
      if (range !== null) shownRange = shownRange === null ? range : shownRange + (range - shownRange) * (1 - Math.exp(-dt * 15));
      const r = shownRange ?? 1;
      phones.B.mesh.position.set(r, HEIGHT, 0);
      const pos = line.geometry.attributes.position;
      pos.setXYZ(0, 0, HEIGHT, 0);
      pos.setXYZ(1, r, HEIGHT, 0);
      pos.needsUpdate = true;
      line.computeLineDistances();
      line.visible = connected('A') && connected('B') && range !== null;

      // Tint the scene toward the threat colour.
      const fresh = s && age < 2000;
      const level = fresh ? s.threat.level : 'other';
      tint.lerp(new THREE.Color(THREAT_TINT[level]), 1 - Math.exp(-dt * 8));

      // TCAS picture with A as own ship: advisory banner + B's symbol.
      const traffic = fresh ? s.perspectives.A.traffic : [];
      const { banner: adv } = advisories.update(traffic, now, fresh ? s.perspectives.A.ownship : null);
      banner.hidden = !adv;
      if (adv) {
        banner.dataset.level = adv.level;
        banner.style.color = adv.color;
        banner.textContent = adv.text;
      }
      drawSymbol(traffic.find((t) => t.id === 'B' && t.range !== null));

      hint.textContent = !s
        ? 'Waiting for server…'
        : air
          ? `Drag to orbit · scroll to zoom · grid squares are 2 NM · altitudes ×${VERTICAL_EXAGGERATION}`
          : !connected('A') || !connected('B')
          ? `Waiting for phone${!connected('A') && !connected('B') ? 's A and B' : !connected('A') ? ' A' : ' B'}… (or run npm run mock)`
          : range === null
            ? 'Phones connected; waiting for the first range…'
            : 'Drag to orbit · scroll to zoom · B is drawn on +X (bearing unknown)';

      controls.update();
      airspace.update(air ? s : null, dt, placeLabel); // a stale feed keeps its last picture
      renderer.render(scene, camera);

      for (const id of ['A', 'B']) {
        tmp.copy(phones[id].mesh.position).setY(HEIGHT + 0.12);
        placeLabel(phones[id].label, tmp, connected(id));
      }
      tmp.set(r / 2, HEIGHT + 0.03, 0);
      phones.distLabel.textContent = range === null ? '' : `${range.toFixed(2)} m${s.range.sigma ? ` ±${(s.range.sigma * 100).toFixed(0)} cm` : ''}`;
      placeLabel(phones.distLabel, tmp, line.visible);
    },

    resize() {
      if (!renderer || !root) return;
      const w = root.clientWidth || 1;
      const h = root.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },

    unmount() {
      controls?.dispose();
      scene?.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
      renderer?.dispose();
      root?.remove();
      renderer = null;
    },
  };
}
