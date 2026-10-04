// 3D layer for the simulated airspace (state.mode === 'airspace'): every aircraft as a
// small airplane model at its position and altitude, with a trail and a drop line to the
// ground grid. Horizontal scale: 1 world unit = 1 NM. Altitudes are exaggerated
// (VERTICAL_EXAGGERATION) so the RA manoeuvres are visible. Aircraft are coloured by
// their TCAS threat level (worst of A's and B's view); A and B keep their own colours.

import * as THREE from 'three';
import { TCAS_COLORS } from '../tcas/symbols.js';

const NM = 1852;
const FT = 0.3048;
export const VERTICAL_EXAGGERATION = 4;
const GROUND_ALT = 5000 * FT; // the grid is drawn at this altitude
const MODEL_SCALE = 0.5; // world units; aircraft are drawn far larger than life
const TRAIL_POINTS = 300;
const TRAIL_STEP = 0.1; // s between trail points: 30 s of trail
const OWN_COLORS = { A: 0x3fa7ff, B: 0xc77dff };
const ORDER = { other: 0, proximate: 1, TA: 2, RA: 3 };

/** World position of an aircraft (metres, x east / y north) for the 3D scene. */
export function toWorld(a, out = new THREE.Vector3()) {
  const alt = a.alt ?? GROUND_ALT;
  return out.set(a.x / NM, ((alt - GROUND_ALT) / NM) * VERTICAL_EXAGGERATION, -a.y / NM);
}

function makeAirplane(color) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.25, emissive: color, emissiveIntensity: 0.25 });
  const s = MODEL_SCALE;
  const group = new THREE.Group();
  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(s * 0.07, s * 0.05, s, 12), mat);
  fuselage.rotation.x = Math.PI / 2; // along −z (nose) … +z (tail)
  const nose = new THREE.Mesh(new THREE.ConeGeometry(s * 0.07, s * 0.18, 12), mat);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -s * 0.59;
  const wing = new THREE.Mesh(new THREE.BoxGeometry(s * 1.05, s * 0.02, s * 0.2), mat);
  wing.position.z = -s * 0.04;
  const tailplane = new THREE.Mesh(new THREE.BoxGeometry(s * 0.4, s * 0.02, s * 0.1), mat);
  tailplane.position.z = s * 0.44;
  const fin = new THREE.Mesh(new THREE.BoxGeometry(s * 0.02, s * 0.18, s * 0.14), mat);
  fin.position.set(0, s * 0.09, s * 0.43);
  group.add(fuselage, nose, wing, tailplane, fin);
  return { group, material: mat };
}

export function createAirspaceLayer(scene, { label }) {
  const root = new THREE.Group();
  root.visible = false;
  scene.add(root);
  const planes = new Map();
  const tmp = new THREE.Vector3();

  function addPlane(a) {
    const own = OWN_COLORS[a.id];
    const { group, material } = makeAirplane(own ?? TCAS_COLORS.other);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_POINTS * 3), 3));
    trailGeo.setDrawRange(0, 0);
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: own ?? TCAS_COLORS.other, transparent: true, opacity: 0.55 }));
    const dropGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const drop = new THREE.Line(dropGeo, new THREE.LineDashedMaterial({ color: 0x8b95a1, dashSize: 0.08, gapSize: 0.08, transparent: true, opacity: 0.5 }));
    root.add(group, trail, drop);
    const p = { group, material, trail, trailCount: 0, drop, own: !!own, label: label(a.id), loop: null };
    planes.set(a.id, p);
    return p;
  }

  // Worst threat level for each aircraft across the two TCAS pictures.
  function threatsFrom(s) {
    const out = {};
    for (const pic of Object.values(s.perspectives ?? {})) {
      for (const t of pic.traffic) if (!out[t.id] || ORDER[t.threat] > ORDER[out[t.id]]) out[t.id] = t.threat;
    }
    return out;
  }

  return {
    root,
    planes,

    update(s, dt, placeLabel) {
      const air = s?.airspace;
      root.visible = !!air;
      if (!air) {
        for (const p of planes.values()) p.label.style.display = 'none';
        return;
      }
      const threats = threatsFrom(s);
      const seen = new Set();
      for (const a of air.aircraft) {
        seen.add(a.id);
        const p = planes.get(a.id) ?? addPlane(a);
        if (p.loop !== air.loop) {
          p.trailCount = 0; // scenario restarted: drop the old trail
          p.loop = air.loop;
        }
        toWorld(a, tmp);
        p.group.position.lerp(tmp, p.trailCount ? 1 - Math.exp(-dt * 12) : 1);
        p.group.rotation.set(0, 0, 0);
        p.group.rotateY((-a.trk * Math.PI) / 180);
        p.group.rotateX(Math.atan2(a.vs * VERTICAL_EXAGGERATION, a.gs)); // nose up when climbing
        const threat = threats[a.id] ?? 'other';
        if (!p.own) {
          p.material.color.set(TCAS_COLORS[threat]);
          p.material.emissive.set(TCAS_COLORS[threat]);
          p.trail.material.color.set(TCAS_COLORS[threat]);
        }

        // Trail: a point every TRAIL_STEP seconds, shifting once the buffer is full.
        p.sinceTrail = (p.sinceTrail ?? 0) + dt;
        if (!p.trailCount || p.sinceTrail >= TRAIL_STEP) {
          p.sinceTrail = 0;
          const pos = p.trail.geometry.attributes.position;
          if (p.trailCount === TRAIL_POINTS) {
            pos.array.copyWithin(0, 3);
            p.trailCount--;
          }
          pos.setXYZ(p.trailCount++, tmp.x, tmp.y, tmp.z);
          pos.needsUpdate = true;
          p.trail.geometry.setDrawRange(0, p.trailCount);
        }

        const drop = p.drop.geometry.attributes.position;
        drop.setXYZ(0, p.group.position.x, p.group.position.y, p.group.position.z);
        drop.setXYZ(1, p.group.position.x, 0, p.group.position.z);
        drop.needsUpdate = true;
        p.drop.computeLineDistances();
        p.drop.visible = a.alt !== null;

        const fl = a.alt === null ? '---' : `${Math.round(a.alt / FT / 100) * 100}`;
        const ra = a.ra ? ` RA ${a.ra === 'up' ? '↑' : '↓'}` : '';
        p.label.textContent = `${a.id} ${fl}${ra}`;
        p.label.style.color = p.own ? (a.ra ? TCAS_COLORS.RA : '#fff') : TCAS_COLORS[threat];
        tmp.copy(p.group.position).y += MODEL_SCALE * 0.6;
        placeLabel(p.label, tmp, true);
      }
      for (const [id, p] of planes) {
        const live = seen.has(id);
        p.group.visible = p.trail.visible = live;
        if (!live) p.label.style.display = 'none';
      }
    },
  };
}
