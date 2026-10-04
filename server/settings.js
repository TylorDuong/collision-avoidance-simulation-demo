// User-adjustable live-demo settings: the ratio that maps the real ultrasonic gap onto the TCAS
// display, and where the threat levels start. Defaults live in server/config.js (`live`,
// `zones`); the dashboard edits them over the WebSocket and they are saved to a JSON file.
// Distances are inches in the UI and in this file's wire format, metres inside `cfg.zones`.

import fs from 'node:fs';
import path from 'node:path';

export const INCH = 0.0254; // m

const LIMITS = {
  nmPerInch: [0.001, 10],
  proximateIn: [0.1, 1000],
  taIn: [0.1, 1000],
  raIn: [0.1, 1000],
  taTtc: [0.1, 600],
  raTtc: [0.1, 600],
};

/** Current settings of `cfg` in UI units: { nmPerInch, proximateIn, taIn, raIn, taTtc, raTtc }. */
export function readSettings(cfg) {
  const z = cfg.zones;
  return {
    nmPerInch: cfg.live.nmPerInch,
    proximateIn: z.proximate.range / INCH,
    taIn: z.TA.range / INCH,
    raIn: z.RA.range / INCH,
    taTtc: z.TA.ttc,
    raTtc: z.RA.ttc,
  };
}

/**
 * Validate `input` (any subset of the settings; missing fields keep their current value) and,
 * if it is valid, apply it to `cfg`. Nothing changes when it is rejected.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function applySettings(cfg, input) {
  const next = readSettings(cfg);
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    if (input?.[key] === undefined || input[key] === null || input[key] === '') continue;
    const v = Number(input[key]);
    if (!Number.isFinite(v) || v < min || v > max) return { ok: false, error: `${key} must be between ${min} and ${max}` };
    next[key] = v;
  }
  if (!(next.raIn < next.taIn && next.taIn < next.proximateIn)) {
    return { ok: false, error: 'distances must satisfy RA < TA < proximate' };
  }
  if (next.raTtc > next.taTtc) return { ok: false, error: 'RA time must not exceed TA time' };

  cfg.live.nmPerInch = next.nmPerInch;
  cfg.zones.proximate.range = next.proximateIn * INCH;
  cfg.zones.TA.range = next.taIn * INCH;
  cfg.zones.RA.range = next.raIn * INCH;
  cfg.zones.TA.ttc = next.taTtc;
  cfg.zones.RA.ttc = next.raTtc;
  return { ok: true };
}

export function loadSettings(cfg, file) {
  try {
    applySettings(cfg, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    // no saved settings yet, or unreadable: keep the defaults
  }
}

export function saveSettings(cfg, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...readSettings(cfg), savedAt: new Date().toISOString() }, null, 2));
}
