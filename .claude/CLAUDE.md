# Proximity demo — ESP32 ultrasonic collision warning

Real-time prototype with two parts:
- **ESP32 boards:** two boards, each with an ultrasonic sensor, measure the distance between them and send it to a Node.js server on a Windows laptop. Each board drives an LED and a mechanism output from the threat level the server sends back.
- **Laptop TCAS UI:** the server filters the distance, raises TCAS-style warnings, and shows them on a dashboard (two TCAS displays, A POV and B POV, plus a 3D view).

See `README.md` for the full description and `docs/SETUP.md` for hardware setup.

## Tech stack

- Node.js 20+, ES modules, plain JavaScript (no TypeScript, no framework).
- Server: `ws` over `node:http`, one port (8080) for the dashboard, `/ws` and `/device`.
- Web: Vite 8 (one page, `/dashboard`, also served at `/`), three.js for the 3D view, Canvas 2D for the TCAS view.
- Firmware: Arduino C++ for ESP32 (`WebSockets`, `ArduinoJson` v7, ESP-NOW between the boards).
- Tests: `node:test`.

## Commands

```bash
npm install
npm run build                    # vite build -> web/dist (the server serves this; rebuild after web/ changes)
npm start                        # HTTP + WebSockets on :8080
npm run dev                      # rebuild web on change + restart server on change
npm run mock:esp32 -- --range    # two simulated ESP32 boards sending ultrasonic ranges
npm run mock                     # TCAS demo: simulated airspace (tools/mock-airspace.js), overrides the boards
npm test                         # node --test
```

## Layout

- `shared/` — protocol (JSON messages, threat levels) and navigation maths. Used by server, web and tools.
- `server/` — `engine.js` is the transport-independent core (ultrasonic ranges, filter, collision, state snapshot); `index.js` is the HTTP/WebSocket shell; `devices.js` is the board endpoint; `fusion/rangeFilter.js` (+ `fusion/boardPrefilter.js`: per-board spike check and offset between the sensors), `collision.js`, `live.js` (inch-to-NM zone scale, sample altitudes), `settings.js` (dashboard-editable zones); all tunables in `config.js`.
- `web/dashboard/` — shell (connection, store, HUD) plus `views/tcas` and `views/scene3d`. Add a view by implementing `{ mount, update, resize, unmount }` and registering it in `views/index.js`.
- `tools/` — `mock-esp32.js` (simulated boards), `mock-airspace.js` + `sim/airspace.js` (TCAS scenario).
- `firmware/esp32-actuator/` — Arduino sketch. `secrets.h` is git-ignored; copy it from `secrets.example.h`.

## Conventions

- Every distance reading goes through the one Kalman filter in `server/fusion/rangeFilter.js`. Put tunables in `server/config.js`, not inline.
- State sent to the dashboard is always in airspace display units (metres of the simulated airspace, shown in NM). `mode` is `live` (boards) or `sim` (simulator); the real board gap is in `state.live.range`.
- The TCAS view follows the TCAS II v7.1 intro booklet (`docs/`). Extend `web/dashboard/views/tcas/` rather than redesigning it. TCAS logic in `tools/sim/airspace.js` is simplified, sensitivity level 5.
- Threat levels use TCAS names: `other`, `proximate`, `TA`, `RA`. Raising a level is immediate; lowering uses hysteresis (release factor and inch margin, minimum hold).
- Keep `tools/mock-esp32.js` in step with the firmware's protocol and relay rules.
- Add tests in `test/` for new logic. The suite runs without hardware.

## Constraints from the user

- The system is only the two ESP32 boards with ultrasonic sensors and the laptop TCAS UI. There are no phones or other sensor nodes.
- The boards join the laptop's Windows hotspot, which must be on 2.4 GHz. The laptop is usually `192.168.137.1` on it.
- The ultrasonic sensor gives range only. Direction from A to B is not observable, so the boards are drawn head-on, B straight ahead of A. Altitude is not observable either, so A and B fly sample altitudes.
- Threat zones are in real inches and tuned by the user. Each zone is drawn at its real-world TCAS radius (`live.displayZones`).
- The firmware has not run on real sensors yet; the server side is tested with the simulated boards.
