// Central tunables. Override ports via env: HTTPS_PORT, HTTP_PORT.

export const config = {
  httpsPort: Number(process.env.HTTPS_PORT) || 8443,
  // Plain-HTTP port: serves the root CA for iPhone install and redirects everything else to HTTPS.
  httpPort: Number(process.env.HTTP_PORT) || 8080,

  // ESP32 / microcontroller actuators: ws://<laptop-ip>:<httpPort>/device.
  // Set DEVICE_TOKEN to require the same token in the device's hello.
  deviceToken: process.env.DEVICE_TOKEN || null,

  tickHz: 60,
  airspaceFreshSeconds: 2, // simulated airspace older than this is dropped (back to phones)
  stateBroadcastHz: 30,
  pingIntervalMs: 1000,

  ranging: {
    cycleMs: 250, // one A+B chirp exchange every cycle (4 Hz)
    delayA: 0.05, // s after command receipt that A plays its chirp
    gap: 0.1, // s between A's and B's chirps (B is commanded to play at delayA + gap)
    ownWindow: [-0.02, 0.15], // s, search window for a phone's own chirp (covers audio out+in latency)
    // ± search window for the other phone's chirp around its expected time. Kept below `gap`
    // so the window excludes the (much louder) own chirp, and below cycleMs − gap so it
    // excludes the neighbouring cycle's chirps. Absorbs network jitter between the two commands.
    crossWindow: 0.06,
    snrMin: 6, // matched-filter peak / median envelope
    cycleTimeoutMs: 1500,
    audioFreshMs: 500, // a phone must have streamed audio this recently for a cycle to start
    bufferSeconds: 4,
    temperatureC: 20,
    defaultK: 0.05, // m, speaker-to-own-mic constant until calibrated
    minDistance: -0.2,
    maxDistance: 25,
  },

  calibration: {
    samples: 8,
    defaultDistance: 0.1, // m, phones held side by side
    file: 'data/calibration.json',
  },

  // Ultrasonic sensors on the ESP32 boards (HC-SR04 class), reported over the /device WebSocket.
  ultrasonic: {
    minRange: 0.02, // m, readings outside [minRange, maxRange] are treated as "no echo"
    maxRange: 4.0,
    freshSeconds: 1, // an accepted reading this recent makes 'ultrasonic' the range source
    signalTimeoutSeconds: 2, // a board silent this long shows NO SIGNAL
  },

  filter: {
    sigmaAcoustic: 0.03, // m
    sigmaUltrasonic: 0.02, // m
    qMoving: 1.0, // (m/s²)² white-acceleration process noise while a phone is moving
    qStill: 0.02,
    gateSigma: 3,
    maxConsecutiveRejects: 4,
    maxPredictHorizon: 1.0, // s, don't extrapolate further than this past the last measurement
    staleAfter: 3.0, // s without any range measurement -> estimate is stale
  },

  gps: {
    freshMs: 3000,
    useWhenAcousticAbsentMs: 2000,
    useAboveRange: 8, // m
  },

  // Threat zones. TA ≈ "caution", RA ≈ "danger".
  zones: {
    proximate: { range: 1.5 },
    TA: { range: 0.75, ttc: 2.5 },
    RA: { range: 0.3, ttc: 1.0 },
    releaseRangeFactor: 1.15,
    releaseTtcFactor: 1.3,
    minHoldSeconds: 0.6,
    minClosingSpeed: 0.05, // m/s, below this TTC is undefined
  },

  // RA sense coordination between A and B (proximity mode): the senses are always
  // complementary. With a GPS height difference at least this large (m) the higher node
  // climbs; otherwise A climbs and B descends.
  ra: {
    senseAltThreshold: 1.0,
  },
};
