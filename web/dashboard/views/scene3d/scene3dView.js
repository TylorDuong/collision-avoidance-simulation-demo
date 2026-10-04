// 3D view of the airspace (airspace3d.js): the simulator's aircraft, or A and B from the live
// ultrasonic boards drawn head-on at the zone scale. The advisory banner comes from the same
// AdvisoryTracker as the TCAS display (A's view).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AdvisoryTracker } from '../tcas/advisories.js';
import { createAirspaceLayer, VERTICAL_EXAGGERATION } from './airspace3d.js';

const THREAT_TINT = { other: 0x0b0d10, proximate: 0x0b1416, TA: 0x1f1604, RA: 0x2a0709 };
const CAMERA = { position: [1.5, 9, 15], target: [0, 1, 0] }; // the ~20 × 20 NM around the encounter

export function createScene3dView() {
  let root, renderer, scene, camera, controls, labels, banner, hint;
  let airspace;
  const tint = new THREE.Color(THREAT_TINT.other);
  const tmp = new THREE.Vector3();
  const advisories = new AdvisoryTracker();

  function label(text) {
    const div = document.createElement('div');
    div.className = 'label3d';
    div.textContent = text;
    labels.append(div);
    return div;
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
      camera.position.set(...CAMERA.position);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.target.set(...CAMERA.target);
      controls.update();

      scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x101418, 1.6));
      const sun = new THREE.DirectionalLight(0xffffff, 1.4);
      sun.position.set(2, 4, 3);
      scene.add(sun);

      // 40 NM grid (2 NM squares) and the aircraft.
      airspace = createAirspaceLayer(scene, { label });
      airspace.root.add(new THREE.GridHelper(40, 20, 0x2b3440, 0x1d242c));
      this.resize();
    },

    update(s, dt, { age, now }) {
      if (!renderer) return;

      // Tint the scene toward the threat colour.
      const fresh = s && age < 2000;
      const level = fresh ? s.threat.level : 'other';
      tint.lerp(new THREE.Color(THREAT_TINT[level]), 1 - Math.exp(-dt * 8));

      // TCAS picture with A as own ship: advisory banner.
      const traffic = fresh ? s.perspectives.A.traffic : [];
      const { banner: adv } = advisories.update(traffic, now, fresh ? s.perspectives.A.ownship : null);
      banner.hidden = !adv;
      if (adv) {
        banner.dataset.level = adv.level;
        banner.style.color = adv.color;
        banner.textContent = adv.text;
      }

      hint.textContent = !s
        ? 'Waiting for server…'
        : !s.airspace.aircraft.length
          ? 'Waiting for the ultrasonic boards… (or run npm run mock)'
          : `Drag to orbit · scroll to zoom · grid squares are 2 NM · altitudes ×${VERTICAL_EXAGGERATION}`;

      controls.update();
      airspace.update(s, dt, placeLabel); // a stale feed keeps its last picture
      renderer.render(scene, camera);
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
