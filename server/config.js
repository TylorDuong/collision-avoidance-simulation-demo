// Central tunables. Override the port via env: HTTP_PORT.

const IN = 0.0254; // m per inch
const NM = 1852; // m
const FT = 0.3048; // m
const FPM = FT / 60; // m/s
const G = 9.80665; // m/s²

export const config = {
  // One plain-HTTP port for everything: the dashboard (/dashboard), its WebSocket (/ws, also
  // used by the airspace simulator) and the ESP32 boards (/device).
  httpPort: Number(process.env.HTTP_PORT) || 8080,

  // ESP32 boards: ws://<laptop-ip>:<httpPort>/device.
  // Set DEVICE_TOKEN to require the same token in the device's hello.
  deviceToken: process.env.DEVICE_TOKEN || null,

  tickHz: 60,
  airspaceFreshSeconds: 2, // simulated airspace older than this is dropped (back to the boards)
  stateBroadcastHz: 30,

  // Mock data (tools/mock-esp32.js --range, tools/mock-airspace.js): how fast it plays, set
  // from the dashboard's speed slider. 1 = real time, 0 = paused.
  mock: {
    speed: 1,
    maxSpeed: 4,
  },

  // Ultrasonic sensors on the ESP32 boards (HC-SR04 class), reported over the /device WebSocket.
  ultrasonic: {
    minRange: 0.02, // m, readings outside [minRange, maxRange] are treated as "no echo"
    maxRange: 4.0,
    freshSeconds: 1, // an accepted reading this recent makes 'ultrasonic' the range source
    signalTimeoutSeconds: 2, // a board silent this long shows NO SIGNAL
    noEchoSeconds: 0.5, // a board shows "no echo" only after this long without one (single misses are normal)
    // Per-board clean-up before the range filter (server/fusion/boardPrefilter.js).
    medianWindow: 3, // a reading further than spikeThreshold from the median of the board's
    spikeThreshold: 2 * IN, // last 3 echoes is a spike and is replaced by that median
    medianMaxAge: 0.5, // s, older echoes leave the median
    offsetAlpha: 0.05, // per reading: how fast each board's offset against the other is learned
    maxOffset: 0.03, // m, cap on that correction
  },

  // Live demo: the real ultrasonic gap between A and B is drawn on the TCAS demo display (NM,
  // kt, head-on on one axis). The scale is piecewise (server/live.js): each zone in `zones`
  // (real inches) lands on its real-world TCAS radius here, so the picture shows TCAS
  // dimensions while the boards keep zones that work by hand.
  live: {
    // Real-world TCAS zones (horizontal radius, vertical limit): RA 0.3–1.1 NM / 300–700 ft,
    // TA 0.55–1.4 NM / 600–1200 ft, proximate 6 NM / ±1200 ft. The upper ends are used so the
    // RA and TA zones are visible on the display.
    displayZones: { proximate: 6 * NM, TA: 1.4 * NM, RA: 1.1 * NM },
    verticalZones: { proximate: 1200 * FT, TA: 850 * FT, RA: 700 * FT },
    // Sample altitudes (the boards measure distance only): A at `altitude`, B `relAlt` from
    // it. An RA climbs / descends them apart to the RA vertical limit, then they return.
    sample: {
      altitude: 8000 * FT, // like tools/sim/airspace.js, so the 3D view frames it
      relAlt: -300 * FT, // B 300 ft below A: A sees "−03", B sees "+03"
      raRate: 1500 * FPM,
      raAccel: 0.25 * G,
      returnRate: 1000 * FPM,
      normalAccel: 0.1 * G,
    },
  },
  settings: {
    file: 'data/settings.json',
  },

  filter: {
    // Two boards at 10 Hz each. Tuned so a gap held still reads steady (about ±0.15 in of
    // jitter with ±0.4 in sensor noise) while a hand-moved board is still followed closely.
    sigmaUltrasonic: 0.03, // m
    q: 0.1, // (m/s²)² white-acceleration process noise (the boards are moved by hand)
    gateSigma: 3,
    maxConsecutiveRejects: 4,
    maxPredictHorizon: 1.0, // s, don't extrapolate further than this past the last measurement
    staleAfter: 3.0, // s without any range measurement -> estimate is stale
  },

  // Threat zones (metres, written as inches). TA ≈ "caution", RA ≈ "danger". Tuned for the
  // ultrasonic boards, which read up to about 20 in: proximate sits just inside that so it
  // does not flicker at the sensor's limit. The times (s) are the minimum allowed, which
  // switches the closing-speed test off, so the levels depend on distance only. Raise them to
  // warn earlier when the planes close fast. Editable live from the dashboard.
  zones: {
    proximate: { range: 18 * IN },
    TA: { range: 10 * IN, ttc: 0.1 },
    RA: { range: 6 * IN, ttc: 0.1 },
    // Hysteresis: a level is entered at once but left only once the range is past the zone by
    // both releaseRangeFactor and releaseMargin, and not before minHoldSeconds, so sensor noise
    // at a zone's edge does not blink the warning in and out.
    releaseRangeFactor: 1.15,
    releaseMargin: 1.5 * IN, // m
    releaseTtcFactor: 1.3,
    minHoldSeconds: 1.0,
    minClosingSpeed: 0.05, // m/s, below this TTC is undefined
  },

  // RA sense coordination between A and B: the senses are always complementary. With a
  // sample-altitude difference at least this large (m) the higher node climbs; otherwise A
  // climbs and B descends.
  ra: {
    senseAltThreshold: 1.0,
  },
};
