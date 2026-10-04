# Proximity demo — ESP32 ultrasonic collision warning

A real-time prototype that measures one-dimensional proximity between two nodes with **ultrasonic sensors on ESP32 boards**, and raises TCAS-style warnings on a laptop dashboard. The dashboard shows **two TCAS displays side by side, one per node (A POV and B POV)**, plus a 3D view.

The ESP32s are the hardware. The laptop does all the fusion and collision logic, and drives each board's LED and mechanism output.

> **Status.** The dashboard, the TCAS logic, the simulated airspace and the ESP32 actuator link are working. The server accepts **ultrasonic readings from the boards** over the `/device` WebSocket (see [Ultrasonic sensing](#ultrasonic-sensing)). The firmware for it is written but not yet run on real sensors. The TCAS demo can still run on the simulated airspace (`npm run mock`), and the older phone prototype still works as a second range source (see [Legacy phone prototype](#legacy-phone-prototype)).

**New here?** Follow the step-by-step [setup guide](docs/SETUP.md). It still describes the older phone-based setup for the hotspot and ESP32 steps.

## How it works

```
ESP32 A  ── ultrasonic sensor ──┐                 Laptop: Node.js server                       Laptop browser (/dashboard)
                                ├─ Wi-Fi/WebSocket ─▶  range     distance per node, Kalman filter
ESP32 B  ── ultrasonic sensor ──┘   (laptop hotspot)   collision  time-to-collision, TA/RA levels,  ──wss 30 Hz──▶  A POV | B POV (TCAS)
   ▲  ◀── alert level, every second ──────────────────           hysteresis                                       3D view · HUD
   └── ESP-NOW heartbeat + alert relay between the boards
```

1. Each board measures the distance to the other node with its ultrasonic sensor.
2. The server filters the ranges, derives closing speed and time-to-collision, and sets a threat level (`other`, `proximate`, `TA`, `RA`).
3. The dashboard shows that level as a TCAS traffic display from each node's point of view.
4. The server sends the level back to each board, which drives its LED and mechanism output. The boards also relay alerts to each other over ESP-NOW.

**What's measured vs. estimated:**

| Quantity | Source | Quality |
|---|---|---|
| Distance A↔B | Ultrasonic time of flight | ~cm, 1-D only |
| Closing speed, time-to-collision | Kalman filter over distance | good |
| Direction from A to B | **not observable** | B is drawn on a fixed axis |
| Relative altitude | **not observable** | tags omitted |

A single ultrasonic sensor gives a straight-line range and nothing else. The TCAS display therefore reports threats as no-bearing advisories in proximity mode, the way TCAS reports intruders without bearing.

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ (ES modules, no TypeScript, no framework) |
| Sensing | Ultrasonic distance sensors on ESP32 boards (see [Ultrasonic sensing](#ultrasonic-sensing)) |
| Actuators | ESP32 (Arduino C++) with `WebSockets` and `ArduinoJson` v7, plus ESP-NOW between the boards |
| Server | `ws` for WebSocket over a plain `node:https` server; self-signed certificate via `selfsigned` |
| Fusion | Kalman filter and TCAS threat logic written in-house |
| Web build | [Vite](https://vite.dev) 8 bundles the dashboard into `web/dist` |
| Dual TCAS display | Canvas 2D, drawn in code to match the TCAS II v7.1 traffic/RA display, one per node |
| 3D view | [three.js](https://threejs.org) (WebGL, `OrbitControls`) |
| Simulation | Simulated airspace (`tools/sim/airspace.js`) and simulated ESP32 boards (`tools/mock-esp32.js`) |
| Tests | `node:test` and `node:assert`, run with `node --test` |

Runtime dependencies are `fft.js`, `selfsigned` and `ws`. `three` and `vite` are dev dependencies, because they only run at build time. `fft.js` is only used by the legacy phone ranging.

## Quick start (no hardware needed)

Requires Node.js 20 or later.

```bash
npm install
npm run build        # bundle the dashboard into web/dist
npm start            # HTTPS + WSS server on :8443 (HTTP helper on :8080)
npm run mock         # in a second terminal: TCAS demo (simulated airspace)
```

Open **https://localhost:8443/dashboard**. The browser warns about the self-signed certificate; that's expected. Only the laptop opens the dashboard, so you don't need a trusted certificate.

**TCAS demo (`npm run mock`).** This runs a simulated airspace (`tools/sim/airspace.js`) and streams it to the server. The dashboard switches to aviation units while the stream is live. The scenario loops about every two minutes:

1. Aircraft A (8,000 ft, eastbound) and B (7,700 ft, westbound) start 10 NM apart, head-on at 250 kt each.
2. At about 31 s both get a **TA** (`TRAFFIC, TRAFFIC`).
3. At about 46 s, 3.5 NM apart, they get a **coordinated RA**. A is above, so A gets `CLIMB, CLIMB` and B gets the complementary `DESCEND, DESCEND`. Both fly it automatically at 1500 fpm after a 2 s response delay.
4. They pass with about 1,400 ft of vertical separation. Then comes `CLEAR OF CONFLICT`, they return to their cleared altitudes, and the scenario restarts.

Six other aircraft (C–H) are never a threat. They show the remaining symbols:
- hollow and filled diamonds;
- climbing and descending trend arrows;
- one aircraft 4,500 ft above, visible only with the `ABV` filter;
- one aircraft without altitude reporting.

The threat logic is a simplified TCAS II v7.1 at sensitivity level 5 (booklet Table 2):
- TA: range tau 40 s, DMOD 0.75 NM, ZTHR 850 ft.
- RA: range tau 25 s, DMOD 0.55 NM, ZTHR 600 ft.
- Proximate: within 6 NM and ±1200 ft.

```bash
npm run mock -- --rate 2              # run the scenario twice as fast
```

`npm run dev` rebuilds the web app and restarts the server whenever files change.

## Dashboard

- **Dual TCAS (A POV and B POV):** two side-by-side displays. Each node is own ship on its own display and sees the other as traffic. Each display is a heading-up navigation display with TCAS traffic, following the TCAS II v7.1 intro booklet (`docs/`, Fig. 2 and Fig. 3):

  | Symbol | Meaning |
  |---|---|
  | white airplane | own ship (centre, heading-up) |
  | hollow cyan diamond | other traffic |
  | filled cyan diamond | proximate traffic (within 6 NM and ±1200 ft; proximity mode: < 1.5 m) |
  | filled amber circle | **TA**, traffic advisory |
  | filled red square | **RA**, resolution advisory |

  - **Traffic:** each aircraft is drawn at its range and relative bearing. A TA or RA beyond the selected range becomes a half symbol at the edge, plus an amber or red `TRAFFIC` annunciation.
  - **Data tag:** relative altitude as a signed two-digit number in hundreds of feet (proximity mode: 0.1 m). It sits above the symbol when traffic is above and below it when traffic is below, and is omitted without altitude reporting. A trend arrow appears to the right of the symbol when the target climbs or descends faster than 500 fpm.
  - **Rim:** a heading-up compass rose, like a navigation display. It turns with own heading under a fixed lubber triangle and a `HDG` readout (`TRU` in the TCAS demo, `MAG` for the phone compass). Labels are tens of degrees (`09` = 090°), with 5° and 10° ticks.
  - **Route:** own flight plan in green (TCAS demo only): course line, waypoint stars and names from the FROM waypoint on, the active leg brighter and the active waypoint filled. Waypoints come from `perspective.nav` and are never treated as traffic.
  - **Vertical speed tape:** right edge, in thousands of fpm (`.5 1 2 4 6`), with the own-ship pointer, V/S above and altitude below. During an RA, red bands mark the rates to avoid and a green band marks the rate to fly (Climb RA: green 1500–2000 fpm, red below 1500). Descend is the mirror image.
  - **Range rings:** 3–5 thin dashed rings around own ship at round fractions of the selected range (20 NM: 5, 10, 15, 20), each labelled on the upper-left ray, the outermost with its unit. The selected range is also boxed. Rings, route and traffic share one scale, so they rescale together. Range buttons: 5, 10, 20 or 40 NM (proximity mode: 1, 2, 5 or 10 m).
  - **Altitude filter:** `ABV` shows +9900/−2700 ft, `N` (normal) ±2700 ft, `BLW` +2700/−9900 ft. TAs, RAs and traffic without altitude are always shown. Each POV remembers its range and filter.
  - **Overlay:** top-left `GS`, `TAS`, wind (`270°/5`) and a downwind arrow. Top-right: active waypoint, course to it, distance and time to go (`A2 090°`, `2.4 NM`, `00:35`). Bottom-left: POV, TCAS operating mode (`TA/RA`, `TA ONLY` or `TCAS STBY`), status and the altitude display mode (`REL` plus the filter).
  - **No bearing:** an ultrasonic sensor has no bearing, so a TA or RA is written out as a no-bearing line (`RA 0.28 +02↓`), the way TCAS reports no-bearing advisories. No range ring is drawn.
  - **Banner:** a visual stand-in for the v7.1 aural annunciations. It reads `TRAFFIC, TRAFFIC`, then `CLIMB, CLIMB` or `DESCEND, DESCEND` (the sense comes from the own ship's TCAS and stays latched for the life of the RA), then `CLEAR OF CONFLICT` when the RA ends.
- **3D:**
  - *TCAS demo:* every aircraft as a small airplane model, with a 30 s trail, a drop line to the grid and an altitude label. The grid squares are 2 NM and altitudes are exaggerated ×4. Traffic is coloured by threat level, and A and B show their RA.
  - *Proximity mode:* node A at the origin and B on +X at the measured distance. The proximate, TA and RA zones around A are drawn in TCAS colours, and B's label shows its TCAS symbol and data tag.
  - *Both:* the same advisory banner as the TCAS tab. Drag to orbit, scroll to zoom.
- **HUD:** threat level, range, closing speed and time-to-collision (TCAS demo: NM, kt and range tau). The diagnostics drawer adds the distance source and per-node link status.
- **Switching views:** use the tabs, or open `/dashboard?view=tcas` or `/dashboard?view=scene3d` directly. The 3D tab starts WebGL only when it is first opened.

Planned TCAS iterations are tracked in `web/dashboard/views/tcas/`:
- sound cues (`announce()` is stubbed)
- strengthening, weakening, reversal and preventive RAs
- auto range scaling
- bearing placement, once a bearing source exists

To add a view, implement `{ mount, update, resize, unmount }` and register it as a tab in `web/dashboard/views/index.js`.

## Ultrasonic sensing

Each ESP32 carries one ultrasonic distance sensor (for example an HC-SR04 or a waterproof JSN-SR04T) aimed at the other node.

- `firmware/esp32-actuator` triggers the sensor at 10 Hz (`TRIG_PIN` / `ECHO_PIN`, set them to your wiring), converts the echo time to metres, and sends `{t:'range', range}` to the server over the `/device` WebSocket. `range` is `null` when no echo came back.
- The server (`engine.handleRange`) feeds every reading into the same Kalman filter, with source `ultrasonic`. Both boards measure the same gap, so each reading is an independent measurement. A reading outside 2 cm to 4 m counts as no echo and is not filtered (`ultrasonic` in `server/config.js`). A board silent for 2 s shows NO SIGNAL.
- The threat logic and both TCAS displays work unchanged. The dashboard's "Ultrasonic ranging" card shows each board's latest reading in inches, "no echo" or "NO SIGNAL". The threat zones are the ones in `server/config.js`.
- Most HC-SR04 modules run on 5 V and drive `ECHO` at 5 V. Put a voltage divider (for example 1 kΩ and 2 kΩ) on `ECHO` before it reaches an ESP32 GPIO, which is 3.3 V only.

Expect these limits from ultrasonic sensing:
- Typical range is about 2 cm to 4 m, with a beam cone of roughly 15°. The sensor has to face the target.
- Soft or angled surfaces reflect badly and can drop readings.
- Speed of sound changes with temperature, about 0.6 m/s per °C. Compensate if you need centimetre accuracy.
- The sensor gives range only: no bearing, and no altitude.

## ESP32 actuators (LED / mechanism) with ESP-NOW relay

Two ESP32 boards join the **laptop's hotspot**. Each one opens a WebSocket to the server and gets the threat level from it. The boards also talk directly to each other over **ESP-NOW**:

```
laptop hotspot (2.4 GHz) ─▶ server ──WebSocket──▶ ESP32 A ⇄ ESP-NOW ⇄ ESP32 B ◀──WebSocket── server
```

- **Server → boards:** `{t:'alert', level, range, seq, epoch}`, sent the moment the level changes and again every second. `seq` counts up with every send. `epoch` identifies the server run.
- **Heartbeat:** each board broadcasts a 38-byte ESP-NOW beacon every 200 ms. If a board hears nothing from its peer for 1 s, it marks the peer **lost**. The loss shows on the LED and is reported to the dashboard.
- **Relay:** each beacon carries the sender's latest alert. A board always uses the newest copy, judged by `seq` within the same `epoch`, whether that copy came from the server or from its peer. If one board's WebSocket drops, it keeps following alerts through the other board, with a few milliseconds of extra delay.
- **Fail-safe:** if a board has no fresh alert from either path for 2.5 s, it turns the mechanism off and double-blinks. That happens if the hotspot or the PC goes down, since nothing is measuring distance anymore.
- **Shared channel:** ESP-NOW shares the radio with Wi-Fi, so it runs on the hotspot's channel. While a board is reconnecting, it retries on that channel instead of scanning all channels, so it can still hear its peer. Every 6th retry scans all channels, in case the hotspot changed channel.

| Board state | LED | Mechanism output |
|---|---|---|
| other | off (short blip every 2 s if the peer is lost) | off |
| proximate | slow blink | off |
| TA | fast blink | off |
| RA | solid | **on** (held at least 0.5 s, cut off after 5 s) |
| no fresh alert for 2.5 s | double blink | off (fail-safe) |

**Wiring** (the same on both boards; pins are set at the top of the sketch):

```
GPIO13 ── 220 Ω → LED → GND  (external LED; the onboard LED on GPIO 2 is not used)
GPIO14 ── ultrasonic TRIG
GPIO12 ── ultrasonic ECHO (through a voltage divider if the sensor runs at 5 V)
GPIO26 ── relay module IN  or  logic-level N-MOSFET gate (100 Ω series, 10 kΩ to GND)
           MOSFET drain → load (−), load (+) → external supply, flyback diode across inductive loads
GND    ── common ground with the external supply
```

Never power a motor, solenoid or relay coil straight from a GPIO pin. Use a relay module or a MOSFET with its own supply. Many relay modules are active-LOW; for those, set `MECH_ACTIVE_HIGH = false`.

**Setup:**
1. **Hotspot:** on the laptop, go to Settings › Network & internet › Mobile hotspot. Set the band to **2.4 GHz**, because a standard ESP32 can't join 5 GHz, and turn the hotspot on. The laptop's address on its own hotspot is normally `192.168.137.1`. The server prints it at startup.
2. **Firewall:** in an admin PowerShell, allow the boards to reach the server:
   ```powershell
   netsh advfirewall firewall add rule name="Proximity demo" dir=in action=allow protocol=TCP localport=8443,8080
   ```
3. **Arduino IDE:** install the **esp32** board package by Espressif. Then use the Library Manager to install **WebSockets** (Markus Sattler) and **ArduinoJson** (v7).
4. **Secrets:** copy `firmware/esp32-actuator/secrets.example.h` to `secrets.h`, which git ignores. Fill in the hotspot name and password and the laptop's hotspot IP. Use the **same `GROUP_ID`** on both boards and a **different `DEVICE_ID`** on each, e.g. `esp32-A` and `esp32-B`.
5. **Upload:** select **ESP32 Dev Module** and upload to each board, changing `DEVICE_ID` between uploads. Serial Monitor at 115200 baud shows Wi-Fi, ESP-NOW, alerts and peer status.
6. **Run:** start the server with `npm start`. Both boards appear in the dashboard's **Actuators** card with their alert source (`server` or `peer`) and ESP-NOW peer status. A board whose server link is down still shows up through its peer. **Test** pulses that board's RA output for 1 s.

Optional: run the server with `DEVICE_TOKEN=<secret>` and put the same value in `secrets.h` to reject unknown devices.

**Testing without hardware:** `npm run mock:esp32` simulates both boards, using the same relay and heartbeat rules over an in-memory radio:
- `npm run mock:esp32 -- --drop-ws esp32-B@5-15` cuts B's WebSocket from 5 s to 15 s. Watch B switch to "alert via peer".
- `npm run mock:esp32 -- --drop-peer 20-30` silences ESP-NOW from 20 s to 30 s, so both boards report their peer as lost.
- `npm run mock:esp32 -- --range` also sends simulated ultrasonic ranges from both boards (closing from 2 m to 0.15 m and back every 30 s, with occasional missed echoes). The dashboard goes through proximate, TA and RA with no phones connected.

## Threat logic

Levels follow TCAS naming. A level triggers on distance **or** time-to-collision, whichever comes first. The defaults are in `server/config.js`:

| Level | Distance | TTC |
|---|---|---|
| proximate | < 1.5 m | — |
| TA (caution) | < 0.75 m | < 2.5 s |
| RA (danger) | < 0.3 m | < 1.0 s |

A higher level takes effect immediately. A lower level only takes effect after 0.6 s, and only once the distance or TTC clears a looser release threshold (×1.15 for distance, ×1.3 for TTC), so warnings don't flicker.

## Project layout

```
shared/          protocol (JSON + binary audio frames), chirp synthesis, quaternion math
server/
  index.js       HTTPS/WSS server, static files, connection handling
  engine.js      transport-independent core: ranging, fusion, collision, state snapshot
  collision.js   threat levels with hysteresis
  devices.js     ESP32 actuator WebSocket endpoint (/device on the HTTP port)
  fusion/        range Kalman filter and related fusion (some of it phone-only)
  ranging/       legacy phone acoustic ranging (matched filter, BeepBeep)
  config.js      all tunables
web/
  phone/         legacy phone sensor page (+ public/phone/capture-worklet.js AudioWorklet)
  dashboard/     shell (connection, store, HUD) + views/scene3d + views/tcas
tools/
  sim/airspace.js  simulated airspace + simplified TCAS II logic for the demo scenario
  mock-airspace.js streams the airspace scenario to the server (npm run mock)
  mock-esp32.js    simulated ESP32 actuators
  sim/world.js, mock-phones.js  legacy phone simulators
firmware/
  esp32-actuator Arduino sketch: Wi-Fi + WebSocket client driving an LED and a relay/MOSFET
test/            node:test unit + end-to-end simulation tests
```

## Tests

```bash
npm test
```

Covered:
- the simulated airspace: the scripted TA → RA → clear-of-conflict scenario and the TCAS II v7.1 thresholds
- the advisory tracker (annunciations and the latched RA sense)
- collision hysteresis
- the range Kalman filter (tracking, gating, re-acquisition)
- an end-to-end run through the engine with the simulated acoustic world (tracking error, all four threat levels, calibration)
- the legacy phone pipeline: matched-filter accuracy and rejection, BeepBeep math, the ring buffer, the binary protocol, Euler-to-quaternion and north alignment, clock sync

## Legacy phone prototype

The first version of this project used two iPhones as sensor nodes, with no native app. The phones opened a web page at `/phone` served by the laptop and streamed motion, GPS and microphone audio. Distance came from two-way acoustic ranging ("BeepBeep") with near-ultrasonic chirps. That code is still in the repo (`server/ranging/`, `web/phone/`, `tools/sim/world.js`, `tools/mock-phones.js`) and is still what the server's proximity mode reads, until the ultrasonic link replaces it.

```bash
npm run mock:phones -- --script approach     # simulated phones: 2 m → 0.1 m, hold, retreat
npm run certs                                # trusted certificate for real phones (needs mkcert)
```

Running with real iPhones needs a trusted HTTPS certificate on each phone. The phone steps are in [docs/SETUP.md](docs/SETUP.md).

## Known limitations

- Only distance is measured, not the direction from A to B, and there is no altitude.
- Ultrasonic sensors have a narrow beam and a short range (about 4 m), and need a clear line of sight to the other node.
- Reflections from soft or angled surfaces can drop readings or bias them.
- The ultrasonic firmware has not been run on real sensors yet. The server side is tested with `npm run mock:esp32 -- --range`.
