# Proximity demo — phone-to-phone collision warning

Real-time prototype: two iPhones stream sensors to a Node.js server on a Windows laptop, which measures distance and raises TCAS-style warnings on a dashboard (3D view + TCAS traffic display). See `README.md` for the full description and `docs/SETUP.md` for hardware setup.

## Tech stack

- Node.js 20+, ES modules, plain JavaScript (no TypeScript, no framework).
- Server: `ws` over `node:https`, `selfsigned`/mkcert certificates, `fft.js` for the matched filter.
- Web: Vite 8 (three pages: `/`, `/phone`, `/dashboard`), three.js for the 3D view, Canvas 2D for the TCAS view.
- Tests: `node:test`. Firmware: Arduino C++ for ESP32.

## Commands

```bash
npm install
npm run build          # vite build -> web/dist (the server serves this; rebuild after web/ changes)
npm start              # HTTPS+WSS on :8443, HTTP helper on :8080
npm run dev            # rebuild web on change + restart server on change
npm run mock           # TCAS demo: simulated airspace (tools/mock-airspace.js)
npm run mock:phones    # two simulated phones with synthesized chirp audio
npm run mock:esp32     # two simulated ESP32 actuators
npm test               # node --test
```

## Layout

- `shared/` — protocol (JSON + binary audio frames), chirp synthesis, quaternion math. Used by server, web and tools.
- `server/` — `engine.js` is the transport-independent core (phones, ranging, fusion, collision, state snapshot); `index.js` is the HTTPS/WSS shell; `ranging/`, `fusion/`, `collision.js`, `devices.js`; all tunables in `config.js`.
- `web/phone/` — sensor page. `web/dashboard/` — shell (connection, store, HUD) plus `views/scene3d` and `views/tcas`. Add a view by implementing `{ mount, update, resize, unmount }` and registering it in `views/index.js`.
- `tools/` — simulators and mocks (`sim/world.js` acoustic world, `sim/airspace.js` TCAS scenario).
- `firmware/esp32-actuator/` — Arduino sketch. `secrets.h` is git-ignored; copy from `secrets.example.h`.

## Conventions

- Keep the server range-source-agnostic: any distance source feeds the same Kalman filter in `server/fusion/rangeFilter.js`. Put tunables in `server/config.js`, not inline.
- The TCAS view follows the TCAS II v7.1 intro booklet (`docs/`). Extend `web/dashboard/views/tcas/` rather than redesigning it. TCAS logic in `tools/sim/airspace.js` is simplified, sensitivity level 5.
- Threat levels use TCAS names: `other`, `proximate`, `TA`, `RA`. Raising a level is immediate; lowering uses hysteresis.
- Add tests in `test/` for new logic. The suite runs without hardware or phones.

## Constraints from the user

- No Mac is available, so don't assume Xcode. Phones run Safari pages served by the laptop (no native app on this branch). The `ois` branch holds separate iOS/UWB work.
- Phone cameras are blocked and no spatial markers are allowed, which rules out ARKit.
- iOS Safari needs HTTPS with a *trusted* certificate for motion sensors and microphone.
- Direction from A to B is not observable with acoustic ranging; B is drawn on a fixed axis.
