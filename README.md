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

## Quick start (no phones needed)

Requires Node.js 20 or later.

```bash
npm install
npm run build        # bundle the web app into web/dist
npm start            # HTTPS + WSS server on :8443 (HTTP helper on :8080)
npm run mock         # in a second terminal: two simulated phones
```

Open **https://localhost:8443/dashboard**. If you haven't run `npm run certs`, the browser will warn about the self-signed certificate. The mock phones stream synthesized audio in which the chirps arrive with the right delays for a scripted distance. Everything downstream, from detection to fusion to the warnings, is the real code.

```bash
npm run mock -- --script approach     # 2 m → 0.1 m, hold, retreat
npm run mock -- --script static:0.5   # fixed distance
npm run mock -- --noise 0.03          # noisier room
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

- **3D:** phone A at the origin and B on +X at the fused distance, each with its real orientation. Caution and danger rings are drawn around A. The scene tints and a banner appears on warnings. Drag to orbit, scroll to zoom.
- **TCAS:** a heading-up traffic display with phone A as own ship.

  | Symbol | Meaning |
  |---|---|
  | hollow cyan diamond | other traffic |
  | filled cyan diamond | proximate traffic (< 1.5 m) |
  | filled amber circle | **TA**, traffic advisory (caution) |
  | filled red square, flashing | **RA**, resolution advisory (danger) |

  - The data tag shows relative altitude in 0.1 m units, or `--` when unknown.
  - Bearing isn't measured. B is either plotted at 12 o'clock on a dashed ring at its known range, or shown only as a no-bearing text block (`TA 0.61m --`), the way real TCAS does.
  - The banner reads `TRAFFIC, TRAFFIC` for a TA, an RA instruction for an RA, and `CLEAR OF CONFLICT` when an RA ends.
  - Range scales: 1, 2, 4 and 8 m.
- **HUD:** threat level, distance ± uncertainty, closing speed, time-to-collision, distance source, acoustic success rate and SNR, per-phone rates and latency, and calibration.
- Switch views with the tabs, or open `/dashboard?view=tcas` directly.

The TCAS view is currently a framework. Planned iterations are tracked in `web/dashboard/views/tcas/`:
- sound cues (`announce()` is stubbed)
- real RA sense logic and a vertical speed band
- auto range scaling
- bearing placement, once a bearing source exists

To add a view, implement `{ mount, update, resize, unmount }` and register it in `web/dashboard/views/index.js`.

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
  mock-phones.js two simulated phones over WebSocket
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
- an end-to-end run through the engine with the simulated acoustic world (tracking error, all four threat levels, calibration)

## Known limitations

- Only distance is measured, not the direction from A to B.
- Acoustic ranging needs uncovered speakers and mics. It degrades in loud rooms, and a strong reflection within about 30 cm of extra path can bias the result.
- GPS only helps outdoors at tens of meters.
- iOS may route audio differently while recording. The page asks for the `play-and-record` audio session where Safari supports it.
- The phone pages must stay open in the foreground.
