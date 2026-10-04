# Proximity demo — ESP32 ultrasonic collision warning

A real-time prototype with two parts:

- **Two ESP32 boards.** Each one has an ultrasonic sensor that measures the distance to the other board. Each also drives an LED and a mechanism output.
- **A TCAS dashboard on a laptop.** The laptop turns that distance into TCAS-style warnings and shows them on **two TCAS displays side by side, one per node (A POV and B POV)**, plus a 3D view.

The boards measure distance and act on the warnings. The laptop does the filtering, the threat logic and the display.

> **Status.** The dashboard, the threat logic, the simulated boards and the simulated airspace all work, and the test suite covers them. The firmware is written but has not yet run on real ultrasonic sensors. Everything can be demonstrated without hardware (see [Quick start](#quick-start-no-hardware-needed)).

**New here?** Follow the step-by-step [setup guide](docs/SETUP.md).

## How it works

```
ESP32 A ── ultrasonic sensor ──┐                  Laptop: Node.js server (:8080)                 Laptop browser
                               ├── Wi-Fi ──────▶  /device  range readings in, alerts out          /dashboard
ESP32 B ── ultrasonic sensor ──┘ (laptop hotspot)  filter   Kalman filter over the A–B distance
   ▲  ◀──────── alert level, on change + every second ─      collision  TA / RA levels, hysteresis  ──/ws 30 Hz──▶  A POV | B POV (TCAS)
   └── ESP-NOW heartbeat + alert relay between the boards                                                          3D view · HUD
```

1. Each board triggers its ultrasonic sensor 10 times a second and sends the distance to the laptop over a WebSocket.
2. The server feeds both boards' readings into one Kalman filter. It derives the closing speed and time-to-collision, and sets a threat level with TCAS names: `other`, `proximate`, `TA` or `RA`.
3. The dashboard draws the two boards as aircraft A and B, head-on, on a TCAS traffic display from each node's point of view.
4. The server sends the level back to each board, which drives its LED and mechanism output. The boards also relay alerts to each other over ESP-NOW, so a board that loses Wi-Fi still gets them.

**What's measured vs. estimated:**

| Quantity | Source | Quality |
|---|---|---|
| Distance A↔B | Ultrasonic time of flight | about 1 cm, along one axis only |
| Closing speed, time-to-collision | Kalman filter over distance | good |
| Direction from A to B | **not observable** | drawn head-on, B straight ahead of A |
| Altitude | **not observable** | sample altitudes (A at 8,000 ft, B 300 ft below) |

## Tech stack

| Layer | Technology |
|---|---|
| Boards | ESP32 DevKit (Arduino C++), HC-SR04-class ultrasonic sensor, `WebSockets` and `ArduinoJson` v7, ESP-NOW between the boards |
| Server | Node.js 20+ (ES modules, plain JavaScript, no framework), `ws` over `node:http` on one port |
| Fusion and threat logic | Kalman filter and TCAS threat logic written in-house |
| Web build | [Vite](https://vite.dev) 8 bundles the dashboard into `web/dist` |
| TCAS displays | Canvas 2D, drawn in code to match the TCAS II v7.1 traffic and RA displays, one per node |
| 3D view | [three.js](https://threejs.org) (WebGL, `OrbitControls`) |
| Simulation | Simulated boards (`tools/mock-esp32.js`) and a simulated airspace (`tools/sim/airspace.js`) |
| Tests | `node:test` and `node:assert`, run with `node --test` |

The only runtime dependency is `ws`. `three` and `vite` are dev dependencies, because they only run at build time.

## Quick start (no hardware needed)

Requires Node.js 20 or later.

```bash
npm install
npm run build              # bundle the dashboard into web/dist
npm start                  # server on :8080
npm run mock:esp32 -- --range   # in a second terminal: two simulated boards with ultrasonic ranges
```

Open **http://localhost:8080/dashboard**. The simulated boards close from 2 m to 0.15 m and back every 30 s, with occasional missed echoes. The dashboard goes through proximate, TA and RA, and the mock terminal prints what each board's LED and mechanism would do.

**Mock speed slider.** While a mock source is connected (`mock:esp32` or `mock`), the top bar shows a **Mock speed** slider from paused through 0.1× to 4×. It sets how fast the simulated boards sweep the gap and how fast the airspace scenario runs. Pause it with the gap inside the RA zone to watch the whole climb countdown. The server keeps the value (`mock` in `server/config.js`) and pushes it to each mock as it connects. Real boards never receive it.

`npm run dev` rebuilds the dashboard and restarts the server whenever files change.

### TCAS demo scenario (`npm run mock`)

`npm run mock` streams a full simulated airspace (`tools/sim/airspace.js`) instead of the boards. While it runs, it takes over the dashboard. The scenario loops about every two minutes:

1. Aircraft A (8,000 ft, eastbound) and B (7,700 ft, westbound) start 10 NM apart, head-on at 250 kt each.
2. At about 31 s both get a **TA** (`TRAFFIC, TRAFFIC`).
3. At about 46 s, 3.5 NM apart, they get a **coordinated RA**. A is above, so A gets `CLIMB, CLIMB` and B gets the complementary `DESCEND, DESCEND`. Both fly it automatically at 1500 fpm after a 2 s response delay.
4. They pass with about 1,400 ft of vertical separation. Then comes `CLEAR OF CONFLICT`, they return to their cleared altitudes, and the scenario restarts.

Six other aircraft (C–H) are never a threat. They show the remaining symbols:
- hollow and filled diamonds;
- climbing and descending trend arrows;
- one aircraft 4,500 ft above, visible only with the `ABV` filter;
- one aircraft without altitude reporting.

The simulator's threat logic is a simplified TCAS II v7.1 at sensitivity level 5 (booklet Table 2):
- TA: range tau 40 s, DMOD 0.75 NM, ZTHR 850 ft.
- RA: range tau 25 s, DMOD 0.55 NM, ZTHR 600 ft.
- Proximate: within 6 NM and ±1200 ft.

```bash
npm run mock -- --rate 2              # start twice as fast (also moves the dashboard's slider)
```

When the simulator stops, the dashboard goes back to the boards within 2 s.

## Dashboard

Open `http://localhost:8080/dashboard` on the laptop. `/` opens the dashboard too.

### TCAS displays (A POV and B POV)

There are two displays side by side. Each node is own ship on its own display and sees the other as traffic. Each display is a heading-up navigation display with TCAS traffic, following the TCAS II v7.1 intro booklet (`docs/`, Fig. 2 and Fig. 3):

| Symbol | Meaning |
|---|---|
| white airplane | own ship (centre, heading-up) |
| hollow cyan diamond | other traffic |
| filled cyan diamond | proximate traffic (inside the proximate zone) |
| filled amber circle | **TA**, traffic advisory |
| filled red square | **RA**, resolution advisory |

- **Traffic:** each aircraft is drawn at its range and relative bearing. A TA or RA beyond the selected range becomes a half symbol at the edge, plus an amber or red `TRAFFIC` annunciation. Traffic reported without a bearing is drawn straight ahead, with its distance beside it and a written advisory line (`RA 0.3 +02↓`).
- **Data tag:** relative altitude as a signed two-digit number in hundreds of feet. It sits above the symbol when traffic is above and below it when traffic is below, and is omitted without altitude reporting. A trend arrow appears to the right of the symbol when the target climbs or descends faster than 500 fpm.
- **Rim:** a heading-up compass rose, like a navigation display. It turns with own heading under a fixed lubber triangle and an `HDG … TRU` readout. Labels are tens of degrees (`09` = 090°), with 5° and 10° ticks.
- **Route:** own flight plan in green, only in the TCAS demo scenario. It shows the course line, waypoint stars and names from the FROM waypoint on, with the active leg brighter and the active waypoint filled. Waypoints are never treated as traffic.
- **Vertical speed tape:** right edge, in thousands of fpm (`.5 1 2 4 6`), with the own-ship pointer, V/S above and altitude below. During an RA, red bands mark the rates to avoid and a green band marks the rate to fly (Climb RA: green 1500–2000 fpm, red below 1500). Descend is the mirror image.
- **Range rings:** 3–5 thin dashed rings around own ship at round fractions of the selected range (20 NM: 5, 10, 15, 20). Each ring is labelled on the upper-left ray and the outermost carries the unit. The selected range is also boxed. Rings, route and traffic share one scale. Range buttons: 5, 10, 20 or 40 NM.
- **Zone rings (boards only):** faint dashed rings where each threat level starts, labelled `RA 1.1`, `TA 1.4` and `PROX 6` (see [Ultrasonic sensing](#ultrasonic-sensing)).
- **Altitude filter:** `ABV` shows +9900/−2700 ft, `N` (normal) ±2700 ft, `BLW` +2700/−9900 ft. TAs, RAs and traffic without altitude are always shown. Each POV remembers its range and filter.
- **Overlay:** top-left `GS`, `TAS`, wind (`270°/5`) and a downwind arrow. Top-right: active waypoint, course to it, distance and time to go (`A2 090°`, `2.4 NM`, `00:35`). Bottom-left: POV, TCAS operating mode (`TA/RA`, `TA ONLY` or `TCAS STBY`), status and the altitude display mode (`REL` plus the filter).
- **RA cue:** in the margin left of the display circle (opposite the vertical speed tape), green chevrons point the way to fly (up for CLIMB, down for DESCEND), with the metres still to go to safe separation counting down. At 0 the cue changes to LEVEL OFF.
- **Banner:** a visual stand-in for the v7.1 aural annunciations. It reads `TRAFFIC, TRAFFIC`, then `CLIMB, CLIMB` or `DESCEND, DESCEND`, then `CLEAR OF CONFLICT` when the RA ends. The sense comes from own ship's TCAS and stays latched for the life of the RA. With the boards, the server picks complementary senses: the higher aircraft climbs and the lower descends.

### 3D view

Every aircraft is drawn as a small airplane model, with a 30 s trail, a drop line to the grid and an altitude label. The grid squares are 2 NM and altitudes are exaggerated ×4. Traffic is coloured by threat level, and A and B show their RA. The view shows the same advisory banner as the TCAS tab. Drag to orbit, scroll to zoom.

### Top bar and diagnostics

- **Top bar:** threat level, range in NM plus the real gap in inches (`1.24 NM · 7.8 in`), closing speed in knots, tau, and each aircraft's RA (`A ▲ 42 m · B ▼ 42 m`).
- **Diagnostics drawer:**
  - **Range:** the range source (`ultrasonic`, `predicted`, `stale`, `sim`), the filter's uncertainty, and the threat reason.
  - **Ultrasonic ranging:** each board's latest reading in inches, "no echo" or "NO SIGNAL".
  - **Live demo zones:** where each threat level starts on the real gap (see below).
  - **Actuators:** each board's IP, firmware, applied level, where its alert came from (`server` or `peer`), mechanism state and ESP-NOW peer. **Test** pulses that board's RA output for 1 s.
- **Fits any window:** the page is sized in `rem` and starts at 90%. The `−` / `+` buttons in the top bar change the size (the middle button resets it) and the choice is remembered.
- **Switching views:** use the tabs, or open `/dashboard?view=tcas` or `/dashboard?view=scene3d` directly. The 3D tab starts WebGL only when it is first opened.

Planned TCAS iterations are tracked in `web/dashboard/views/tcas/`:
- sound cues (`announce()` is stubbed)
- strengthening, weakening, reversal and preventive RAs
- auto range scaling

To add a view, implement `{ mount, update, resize, unmount }` and register it as a tab in `web/dashboard/views/index.js`.

## Ultrasonic sensing

Each ESP32 carries one ultrasonic distance sensor (for example an HC-SR04 or a waterproof JSN-SR04T) aimed at the other board.

- **Firmware:** `firmware/esp32-actuator` triggers the sensor at 10 Hz (`TRIG_PIN` / `ECHO_PIN`; set them to your wiring), converts the echo time to metres, and sends `{t:'range', range}` over the `/device` WebSocket. `range` is `null` when no echo came back.
- **Filtering:** the server (`engine.handleRange`) feeds every reading into one Kalman filter (`server/fusion/rangeFilter.js`). Both boards measure the same gap, so each reading is an independent measurement. Before the filter, each board's readings are cleaned (`server/fusion/boardPrefilter.js`): a reading more than 2 in from the median of that board's last 3 echoes is a spike and is replaced by the median, and the fixed offset between the two sensors is learned and removed, so the fused range does not zig-zag between the boards. A reading outside 2 cm to 4 m counts as no echo and is not filtered (`ultrasonic` in `server/config.js`). A board shows "no echo" only after 0.5 s without one, and NO SIGNAL after 2 s of silence.
- **Drawn as a TCAS encounter:** the server draws the real gap on one axis, with A and B head-on and each straight ahead of the other (bearing 0).
- **Zones at real-world TCAS dimensions:** the scale from inches to NM is piecewise (`server/live.js`). Each zone boundary in real inches is drawn at its real-world radius: RA (6 in) at 1.1 NM, TA (10 in) at 1.4 NM and proximate (18 in) at 6 NM. Past 18 in, the last segment's scale continues. The radii and vertical limits (RA 700 ft, TA 850 ft, proximate 1200 ft) are `live.displayZones` and `live.verticalZones` in `server/config.js`.
- **Sample altitudes:** the boards measure distance only, so A flies at 8,000 ft and B 300 ft below. A's display tags B `−03`, and B's tags A `+03`. The vertical limits apply: traffic further apart vertically than a zone's limit does not raise that level, and the threat reason then reads "outside vertical limit".
- **RA guidance:** in an RA the higher aircraft climbs and the lower descends at 1500 fpm until they are 700 ft apart (safe separation), then they level off. The countdown runs from about 61 m to 0 over 11 s, then the advisory weakens to LEVEL OFF, LEVEL OFF. Once the boards move apart, the advisory clears and both aircraft return to their sample altitudes.
- **Adjustable from the dashboard:** the "Live demo zones" card sets where each threat level starts. That covers the proximate, TA and RA distances in real inches and the TA and RA time-to-collision in seconds. Changes apply immediately and are saved to `data/settings.json`. The defaults are `zones` in `server/config.js`. A changed zone is still drawn at its real-world radius.
- **5 V sensors:** most HC-SR04 modules run on 5 V and drive `ECHO` at 5 V. An ESP32 GPIO is 3.3 V only, so put a voltage divider (for example 1 kΩ and 2 kΩ) on `ECHO` first.

Expect these limits from ultrasonic sensing:
- Typical range is about 2 cm to 4 m, with a beam cone of roughly 15°. The sensor has to face the target.
- Soft or angled surfaces reflect badly and can drop readings.
- The speed of sound changes with temperature, by about 0.6 m/s per °C. Compensate for it if you need centimetre accuracy.
- The sensor gives range only: no bearing and no altitude.

## ESP32 boards and the ESP-NOW relay

Both boards join the **laptop's hotspot**. Each one opens a WebSocket to the server, sends its ultrasonic readings, and gets the threat level back. The boards also talk directly to each other over **ESP-NOW**:

```
laptop hotspot (2.4 GHz) ─▶ server ──WebSocket──▶ ESP32 A ⇄ ESP-NOW ⇄ ESP32 B ◀──WebSocket── server
```

- **Board → server:** `{t:'range', range}` at 10 Hz, and `{t:'applied', level, mechanism, source, peer}` on change and every few seconds.
- **Server → boards:** `{t:'alert', level, range, seq, epoch}`, sent the moment the level changes and again every second. `seq` counts up with every send. `epoch` identifies the server run.
- **Heartbeat:** each board broadcasts a 38-byte ESP-NOW beacon every 200 ms. If a board hears nothing from its peer for 1 s, it marks the peer **lost**. The loss shows on the LED and is reported to the dashboard.
- **Relay:** each beacon carries the sender's latest alert. A board always uses the newest copy, judged by `seq` within the same `epoch`, whether that copy came from the server or from its peer. If one board's WebSocket drops, it keeps following alerts through the other board, with a few milliseconds of extra delay.
- **Fail-safe:** if a board has no fresh alert from either path for 2.5 s, it turns the mechanism off and double-blinks. That happens if the hotspot or the laptop goes down, since nothing is turning ranges into alerts anymore.
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
GND    ── common ground with the sensor and the external supply
```

Never power a motor, solenoid or relay coil straight from a GPIO pin. Use a relay module or a MOSFET with its own supply. Many relay modules are active-LOW; for those, set `MECH_ACTIVE_HIGH = false`.

**Setup in short** (the [setup guide](docs/SETUP.md) has every step):
1. **Hotspot:** on the laptop, go to Settings › Network & internet › Mobile hotspot. Set the band to **2.4 GHz**, because a standard ESP32 can't join 5 GHz, and turn the hotspot on. The laptop's address on its own hotspot is normally `192.168.137.1`. The server prints it at startup.
2. **Firewall:** in an admin PowerShell, allow the boards to reach the server:
   ```powershell
   netsh advfirewall firewall add rule name="Proximity demo" dir=in action=allow protocol=TCP localport=8080
   ```
3. **Arduino IDE:** install the **esp32** board package by Espressif. Then use the Library Manager to install **WebSockets** (Markus Sattler) and **ArduinoJson** (v7).
4. **Secrets:** copy `firmware/esp32-actuator/secrets.example.h` to `secrets.h`, which git ignores. Fill in the hotspot name and password and the laptop's hotspot IP. Use the **same `GROUP_ID`** on both boards and a **different `DEVICE_ID`** on each, for example `esp32-A` and `esp32-B`.
5. **Upload:** select **ESP32 Dev Module** and upload to each board, changing `DEVICE_ID` between uploads. The Serial Monitor at 115200 baud shows Wi-Fi, ESP-NOW, alerts and peer status.
6. **Run:** start the server with `npm start`. Both boards appear in the dashboard's **Actuators** card and their readings in **Ultrasonic ranging**.

Optional: run the server with `DEVICE_TOKEN=<secret>` and put the same value in `secrets.h` to reject unknown devices. Set `HTTP_PORT` to use a port other than 8080; the boards' `SERVER_PORT` must match.

**Testing without hardware:** `npm run mock:esp32` simulates both boards, with the same relay and heartbeat rules over an in-memory radio:
- `npm run mock:esp32 -- --range` sends simulated ultrasonic ranges from both boards.
- `npm run mock:esp32 -- --drop-ws esp32-B@5-15` cuts B's WebSocket from 5 s to 15 s. Watch B switch to "alert via peer".
- `npm run mock:esp32 -- --drop-peer 20-30` silences ESP-NOW from 20 s to 30 s, so both boards report their peer as lost.

Don't run `mock:esp32` while real boards are connected, because the IDs would clash.

## Threat logic

Levels follow TCAS naming. A level triggers on distance **or** time-to-collision, whichever comes first. The defaults are in `server/config.js`:

| Level | Distance | TTC |
|---|---|---|
| proximate | < 18 in | — |
| TA (caution) | < 10 in | < 0.1 s |
| RA (danger) | < 6 in | < 0.1 s |

These are tuned for ultrasonic boards that read up to about 20 in. Proximate sits just inside that so it doesn't flicker at the sensor's limit. A TTC of 0.1 s is the minimum, which switches the closing-speed test off, so the levels depend on distance only. Raise the times to warn earlier when the boards close fast. The dashboard's "Live demo zones" card changes all of these live. `data/settings.json`, written by that card, overrides these defaults, so delete it to return to them.

A higher level takes effect immediately. A lower level only takes effect after 1 s, and only once the distance or TTC clears a looser release threshold (distance: ×1.15 and at least 1.5 in past the zone; TTC: ×1.3), so warnings don't flicker when a board hovers at a zone's edge. The sample altitudes then apply the TCAS vertical limits on top.

## Project layout

```
shared/          protocol (JSON messages) and route/waypoint maths, used by server, web and tools
server/
  index.js       HTTP server on one port: static dashboard, /ws (dashboard, simulator), /device (boards)
  engine.js      transport-independent core: ultrasonic ranges, filter, collision, state snapshot
  devices.js     ESP32 board endpoint: range readings in, alerts and test pulses out
  fusion/        range Kalman filter, per-board spike check and sensor offset
  collision.js   threat levels with hysteresis, RA sense selection
  live.js        zone scale (inches -> NM) and the sample altitudes
  settings.js    live demo zones, edited from the dashboard and saved to data/settings.json
  config.js      all tunables
web/dashboard/   shell (connection, store, HUD) + views/tcas + views/scene3d
tools/
  mock-esp32.js    simulated ESP32 boards (npm run mock:esp32)
  mock-airspace.js streams the TCAS demo scenario to the server (npm run mock)
  sim/airspace.js  simulated airspace + simplified TCAS II logic for the scenario
firmware/
  esp32-actuator Arduino sketch: ultrasonic sensor, Wi-Fi + WebSocket client, LED, relay/MOSFET, ESP-NOW
docs/            setup guide and the TCAS II v7.1 intro booklet
test/            node:test unit and end-to-end tests
```

## Tests

```bash
npm test
```

The suite runs without hardware. It covers:
- the engine with simulated boards: filtering, no-echo and silent boards, escalation to RA, complementary RA senses
- the live demo: the zone scale, the sample altitudes and RA guidance, and the dashboard-editable zones
- the range Kalman filter (tracking, gating, re-acquisition) and collision hysteresis
- the simulated airspace: the scripted TA → RA → clear-of-conflict scenario and the TCAS II v7.1 thresholds
- the advisory tracker (annunciations and the latched RA sense), TCAS formatting and navigation

## Known limitations

- Only distance is measured: not the direction from A to B, and not altitude.
- Ultrasonic sensors have a narrow beam and a short range (about 4 m), and need a clear line of sight to the other board.
- Reflections from soft or angled surfaces can drop readings or bias them.
- The firmware has not been run on real sensors yet. The server side is tested with `npm run mock:esp32 -- --range`.
