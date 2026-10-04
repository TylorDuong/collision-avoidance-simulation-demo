# Proximity Demo — phone-to-phone collision warning

A real-time prototype that measures the distance between two iPhones, tracks their orientation, and raises proximity warnings on a laptop dashboard. The dashboard has a **3D view** and a **TCAS-style traffic display**.

There's no native app. The phones open a web page served by the laptop. They work as "dumb" sensor nodes: they stream raw motion, GPS and microphone audio. The laptop does all the signal processing, fusion and collision logic.

**New here?** Follow the step-by-step [setup guide](docs/SETUP.md): simulation first, then the hotspot, the ESP32 boards and the phones.

## How it works

```
iPhone Safari (/phone, HTTPS)               Laptop: Node.js server                         Laptop browser (/dashboard)
 DeviceOrientation/Motion ~60 Hz ──┐        ranging   chirp scheduling, FFT matched filter,
 Geolocation ~1 Hz ────────────────┼─wss─▶            two-way acoustic ranging ("BeepBeep")
 Microphone PCM 48 kHz (binary) ───┘        fusion    range Kalman filter, GPS fallback,      ──wss 30 Hz──▶  3D view · TCAS view · HUD
 ◀── "play your chirp now" ─────────                  orientation (quaternions, north-aligned)
                                            collision zones + time-to-collision, hysteresis
```

**Distance comes from sound.** Four times a second, the server tells phone A to play a short near-ultrasonic up-chirp (17.5→19.5 kHz). Phone B plays a down-chirp 100 ms later. Both phones record both chirps, and the server finds each arrival with sub-sample precision. Each phone's timings are measured on its own audio clock, so clock offsets and audio latencies cancel:

```
d = c/2 · [(a2 − a1)/fsA − (b2 − b1)/fsB] + K
```

`K` is the speaker-to-own-mic distance, found by calibration. In simulation the error is about 1–2 cm median and about 5 cm at p95.

**Why not ARKit or UWB?** The cameras are covered, which rules out ARKit tracking. iPhone 14 and later only give UWB direction with camera assistance. A browser can't reach UWB at all, and this project avoids native apps.

**What's measured vs. estimated:**

| Quantity | Source | Quality |
|---|---|---|
| Distance A↔B | Acoustic ranging (GPS fallback when far apart outdoors) | ~cm |
| Closing speed, time-to-collision | Kalman filter over distance | good |
| Each phone's orientation | DeviceOrientation, aligned to compass north | good |
| Direction from A to B | **not observable** | B is drawn on a fixed axis |

## Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ (ES modules, no TypeScript, no framework) |
| Server | `ws` for WebSocket over a plain `node:https` server; self-signed certificates via `selfsigned`, trusted ones via [mkcert](https://github.com/FiloSottile/mkcert) |
| Signal processing | `fft.js` for the FFT matched filter; Kalman filter, quaternion math and TCAS logic written in-house |
| Web build | [Vite](https://vite.dev) 8 bundles three pages (`/`, `/phone`, `/dashboard`) into `web/dist` |
| 3D view | [three.js](https://threejs.org) (WebGL, `OrbitControls`) |
| TCAS view | Canvas 2D, drawn in code to match the TCAS II v7.1 traffic/RA display |
| Phone | Plain JS in iOS Safari: DeviceOrientation/Motion, Geolocation, `getUserMedia` + an AudioWorklet for 48 kHz capture |
| Simulation | In-house simulated acoustic world (`tools/sim/world.js`) and simulated airspace (`tools/sim/airspace.js`) |
| Actuators | ESP32 (Arduino C++) with `WebSockets` and `ArduinoJson` v7, plus ESP-NOW |
| Tests | `node:test` and `node:assert`, run with `node --test` |

Runtime dependencies are `fft.js`, `selfsigned` and `ws`. `three` and `vite` are dev dependencies, because they only run at build time.

## Quick start (no phones needed)

Requires Node.js 20 or later.

```bash
npm install
npm run build        # bundle the web app into web/dist
npm start            # HTTPS + WSS server on :8443 (HTTP helper on :8080)
npm run mock         # in a second terminal: TCAS demo (simulated airspace)
```

Open **https://localhost:8443/dashboard**. If you haven't run `npm run certs`, the browser will warn about the self-signed certificate.

**TCAS demo (`npm run mock`).** This runs a simulated airspace (`tools/sim/airspace.js`) and streams it to the server. The dashboard switches to aviation units while the stream is live, and falls back to the phones 2 s after it stops. The scenario loops about every two minutes:

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

**Phone pipeline (`npm run mock:phones`).** Two simulated phones stream synthesized audio in which the chirps arrive with the right delays for a scripted distance. Everything downstream, from detection to fusion to the warnings, is the real code.

```bash
npm run mock:phones -- --script approach     # 2 m → 0.1 m, hold, retreat
npm run mock:phones -- --script static:0.5   # fixed distance
npm run mock:phones -- --noise 0.03          # noisier room
```

`npm run dev` rebuilds the web app and restarts the server whenever files change.

## Running with real iPhones (Windows laptop)

iOS Safari only allows the motion sensors and microphone on HTTPS pages with a **trusted** certificate.

1. **Make a trusted certificate** with [mkcert](https://github.com/FiloSottile/mkcert):
   ```powershell
   winget install FiloSottile.mkcert   # or: choco install mkcert
   npm run certs                       # cert for localhost + this PC's LAN IPs, copies rootCA.pem to certs/
   ```
   If your laptop's IP address changes, run `npm run certs` again.
2. **Open the firewall.** In an admin PowerShell:
   ```powershell
   netsh advfirewall firewall add rule name="Proximity demo" dir=in action=allow protocol=TCP localport=8443,8080
   ```
3. **Start the server** with `npm start`. It prints the phone URL, e.g. `https://192.168.1.50:8443/phone`. Find the LAN IP with `ipconfig` if needed.
4. **Trust the certificate on each iPhone.** This is a one-time step.
   1. In Safari, open `http://<laptop-ip>:8080/ca` and allow the profile download.
   2. Go to Settings › General › VPN & Device Management and install the profile.
   3. Go to Settings › General › About › Certificate Trust Settings and turn on full trust for the mkcert root.
5. **Open `https://<laptop-ip>:8443/phone`** on both phones. Pick **A** on one and **B** on the other, then tap **Start sensors** and allow motion, microphone and location.
6. **Calibrate.** Hold the phones side by side at the distance shown in the dashboard's Calibration card (default 0.10 m). Press **Calibrate**. The result is saved in `data/calibration.json`.

Keep both pages in the foreground with the screen on, and don't cover the speakers or bottom microphones. All devices must be on the same Wi-Fi network.

## Dashboard

- **TCAS:** two side-by-side displays, A POV and B POV. Each aircraft (or phone) is own ship on its own display and sees everything else as traffic. Each display follows the combined TCAS traffic/RA instrument (IVSI) in the TCAS II v7.1 intro booklet (`docs/`, Fig. 2 and Fig. 3):

  | Symbol | Meaning |
  |---|---|
  | white airplane | own ship (centre, heading-up) |
  | hollow cyan diamond | other traffic |
  | filled cyan diamond | proximate traffic (within 6 NM and ±1200 ft; phones: < 1.5 m) |
  | filled amber circle | **TA**, traffic advisory |
  | filled red square | **RA**, resolution advisory |

  - **Traffic:** each aircraft is drawn at its range and relative bearing. A TA or RA beyond the selected range becomes a half symbol at the edge, plus an amber or red `TRAFFIC` annunciation.
  - **Data tag:** relative altitude as a signed two-digit number in hundreds of feet (phones: 0.1 m). It sits above the symbol when traffic is above and below it when traffic is below, and is omitted without altitude reporting. A trend arrow appears to the right of the symbol when the target climbs or descends faster than 500 fpm.
  - **Rim:** a vertical speed scale in thousands of fpm (`0 .5 1 2 4 6`, with 0 at 9 o'clock), with the own-ship needle. During an RA, red arcs mark the rates to avoid and a green arc marks the rate to fly (Climb RA: green 1500–2000 fpm, red below 1500). Descend is the mirror image.
  - **Range markings:** a ring of 12 dots at half scale and a thin ring at full scale, with the selected range boxed. Range buttons: 5, 10, 20 or 40 NM (phones: 1, 2, 5 or 10 m).
  - **Altitude filter:** `ABV` shows +9900/−2700 ft, `N` (normal) ±2700 ft, `BLW` +2700/−9900 ft. TAs, RAs and traffic without altitude are always shown. Each POV remembers its range and filter.
  - **Overlay:** own-ship data top-left and top-right (`GS`, `HDG`, `ALT`, `V/S`). The TCAS operating mode (`TA/RA`, `TA ONLY` or `TCAS STBY`) and the altitude display mode (`REL` plus the filter) are on the left.
  - **No bearing:** phones have no bearing, so a TA or RA is written out as a no-bearing line (`RA 0.28 +02↓`), the way TCAS reports no-bearing advisories. No range ring is drawn.
  - **Banner:** a visual stand-in for the v7.1 aural annunciations. It reads `TRAFFIC, TRAFFIC`, then `CLIMB, CLIMB` or `DESCEND, DESCEND` (the sense comes from the own ship's TCAS and stays latched for the life of the RA), then `CLEAR OF CONFLICT` when the RA ends.
- **3D:**
  - *TCAS demo:* every aircraft as a small airplane model, with a 30 s trail, a drop line to the grid and an altitude label. The grid squares are 2 NM and altitudes are exaggerated ×4. Traffic is coloured by threat level, and A and B show their RA.
  - *Phones:* phone A at the origin and B on +X at the fused distance, each with its real orientation. The proximate, TA and RA zones around A are drawn in TCAS colours, and B's label shows its TCAS symbol and data tag.
  - *Both:* the same advisory banner as the TCAS tab. Drag to orbit, scroll to zoom.
- **HUD:** threat level, range, closing speed and time-to-collision (TCAS demo: NM, kt and range tau). The diagnostics drawer adds the distance source, acoustic success rate and SNR, per-phone rates and latency, and calibration.
- **Switching views:** use the tabs, or open `/dashboard?view=tcas` or `/dashboard?view=scene3d` directly. The 3D tab starts WebGL only when it is first opened.

Planned TCAS iterations are tracked in `web/dashboard/views/tcas/`:
- sound cues (`announce()` is stubbed)
- strengthening, weakening, reversal and preventive RAs
- own-ship vertical speed from the phones for the IVSI needle
- auto range scaling
- bearing placement, once a bearing source exists

To add a view, implement `{ mount, update, resize, unmount }` and register it as a tab in `web/dashboard/views/index.js`.

## ESP32 actuators (LED / mechanism) with ESP-NOW relay

Two ESP32 boards join the **laptop's hotspot**. Each one opens a WebSocket to the server and gets the threat level from it. The boards also talk directly to each other over **ESP-NOW**:

```
iPhones ─┐
         ├─ laptop hotspot (2.4 GHz) ─▶ server ──WebSocket──▶ ESP32 A ⇄ ESP-NOW ⇄ ESP32 B ◀──WebSocket── server
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
GPIO2  ── onboard LED (or GPIO → 220 Ω → LED → GND)
GPIO26 ── relay module IN  or  logic-level N-MOSFET gate (100 Ω series, 10 kΩ to GND)
           MOSFET drain → load (−), load (+) → external supply, flyback diode across inductive loads
GND    ── common ground with the external supply
```

Never power a motor, solenoid or relay coil straight from a GPIO pin. Use a relay module or a MOSFET with its own supply. Many relay modules are active-LOW; for those, set `MECH_ACTIVE_HIGH = false`.

**Setup:**
1. **Hotspot:** on the laptop, go to Settings › Network & internet › Mobile hotspot. Set the band to **2.4 GHz**, because a standard ESP32 can't join 5 GHz, and turn the hotspot on. Connect both iPhones to it too. The laptop's address on its own hotspot is normally `192.168.137.1`. The server prints it at startup. Turn the hotspot on **before** running `npm run certs`, so the phones' certificate includes the hotspot address.
2. **Arduino IDE:** install the **esp32** board package by Espressif. Then use the Library Manager to install **WebSockets** (Markus Sattler) and **ArduinoJson** (v7).
3. **Secrets:** copy `firmware/esp32-actuator/secrets.example.h` to `secrets.h`, which git ignores. Fill in the hotspot name and password and the laptop's hotspot IP. Use the **same `GROUP_ID`** on both boards and a **different `DEVICE_ID`** on each, e.g. `esp32-A` and `esp32-B`.
4. **Upload:** select **ESP32 Dev Module** and upload to each board, changing `DEVICE_ID` between uploads. Serial Monitor at 115200 baud shows Wi-Fi, ESP-NOW, alerts and peer status.
5. **Run:** start the server with `npm start` and make sure port 8080 is allowed through the firewall. Both boards appear in the dashboard's **Actuators** card with their alert source (`server` or `peer`) and ESP-NOW peer status. A board whose server link is down still shows up through its peer. **Test** pulses that board's RA output for 1 s.

Optional: run the server with `DEVICE_TOKEN=<secret>` and put the same value in `secrets.h` to reject unknown devices.

**Testing without hardware:** `npm run mock:esp32` simulates both boards, using the same relay and heartbeat rules over an in-memory radio:
- `npm run mock:esp32 -- --drop-ws esp32-B@5-15` cuts B's WebSocket from 5 s to 15 s. Watch B switch to "alert via peer".
- `npm run mock:esp32 -- --drop-peer 20-30` silences ESP-NOW from 20 s to 30 s, so both boards report their peer as lost.

## Threat logic

Levels follow TCAS naming. A level triggers on distance **or** time-to-collision, whichever comes first. The defaults are in `server/config.js`:

| Level | Distance | TTC |
|---|---|---|
| proximate | < 1.5 m | — |
| TA (caution) | < 0.75 m | < 2.5 s |
| RA (danger) | < 0.3 m | < 1.0 s |

A higher level takes effect immediately. A lower level only takes effect after 0.6 s, and only once the distance or TTC clears a looser release threshold (×1.15 for distance, ×1.3 for TTC), so warnings don't flicker. The phones' screens change color with the current level.

## Project layout

```
shared/          protocol (JSON + binary audio frames), chirp synthesis, quaternion math
server/
  index.js       HTTPS/WSS server, static files, connection handling
  engine.js      transport-independent core: phones, ranging, fusion, collision, state snapshot
  ranging/       audio ring buffer + FFT matched filter, BeepBeep, ranging cycle scheduler
  fusion/        range Kalman filter, orientation, motion activity, GPS, clock sync
  collision.js   threat levels with hysteresis
  devices.js     ESP32 actuator WebSocket endpoint (/device on the HTTP port)
  config.js      all tunables
web/
  phone/         sensor page (+ public/phone/capture-worklet.js AudioWorklet)
  dashboard/     shell (connection, store, HUD) + views/scene3d + views/tcas
tools/
  sim/world.js   simulated acoustic world (clocks, latencies, propagation, noise, echo)
  sim/airspace.js simulated airspace + simplified TCAS II logic for the demo scenario
  mock-airspace.js streams the airspace scenario to the server (npm run mock)
  mock-phones.js two simulated phones over WebSocket (npm run mock:phones)
  mock-esp32.js  simulated ESP32 actuator
firmware/
  esp32-actuator Arduino sketch: Wi-Fi + WebSocket client driving an LED and a relay/MOSFET
test/            node:test unit + end-to-end simulation tests
```

## Tests

```bash
npm test
```

Covered:
- matched-filter accuracy and rejection
- BeepBeep math
- the ring buffer
- the binary protocol
- the Kalman filter (tracking, gating, re-acquisition)
- collision hysteresis
- Euler-to-quaternion and north alignment
- clock sync
- the simulated airspace: the scripted TA → RA → clear-of-conflict scenario and the TCAS II v7.1 thresholds
- the advisory tracker (annunciations and the latched RA sense)
- an end-to-end run through the engine with the simulated acoustic world (tracking error, all four threat levels, calibration)

## Known limitations

- Only distance is measured, not the direction from A to B.
- Acoustic ranging needs uncovered speakers and mics. It degrades in loud rooms, and a strong reflection within about 30 cm of extra path can bias the result.
- GPS only helps outdoors at tens of meters.
- iOS may route audio differently while recording. The page asks for the `play-and-record` audio session where Safari supports it.
- The phone pages must stay open in the foreground.
