# Setup guide: server, ESP32s, phones

This guide is for someone new to the ESP32 but comfortable with servers and terminals. It goes in the order that catches problems earliest: the software alone, then the network, then one ESP32, then the second, then the mechanism, then the phones.

It assumes a classic **ESP32 DevKit (ESP32-WROOM-32)** board and that you run commands from the project folder.

---

## 0. What you need

- The Windows laptop with Node.js 20 or newer.
- **2 × ESP32 DevKit boards**, plus **USB cables that carry data**. Many cheap cables are charge-only and the board won't show up.
- 2 iPhones.
- Later, for the mechanism: a relay module or a logic-level MOSFET, and a separate power supply for whatever it switches.

---

## Phase 1: Run everything simulated (no hardware)

This proves the server side works before you touch any hardware.

```powershell
npm install
npm run build
npm start
```

**Check:** the terminal prints `Dashboard: https://localhost:8443/dashboard` and an `ESP32: ws://…:8080/device` line.

- In a **second terminal**: `npm run mock` (two fake phones).
- In a **third terminal**: `npm run mock:esp32` (two fake ESP32s).

Open https://localhost:8443/dashboard. The browser warns about the certificate; click Advanced → Continue. That's expected until Phase 2.

**Check:**
- The distance cycles between 2 m and 0.15 m.
- The threat level goes CLEAR → PROXIMATE → CAUTION → DANGER and back.
- The **Actuators** card lists `esp32-A` and `esp32-B` with "alert via server" and the peer "alive".
- The mock ESP32 terminal prints LED and mechanism changes.

Optional: restart the board mock with `npm run mock:esp32 -- --drop-ws esp32-B@5-15`. Between 5 s and 15 s, B should switch to "alert via peer". That's the ESP-NOW relay working.

Stop all three terminals with Ctrl+C. Don't run `mock:esp32` once the real boards are connected, because the IDs would clash.

---

## Phase 2: Network (hotspot, firewall, certificates)

### 2.1 Turn on the laptop hotspot

1. Go to Settings → Network & internet → **Mobile hotspot**.
2. Click **Edit** and set a name, a password, and **Band: 2.4 GHz**. The ESP32 can't see 5 GHz networks.
3. Turn the hotspot **On**. Windows usually needs the laptop itself connected to the internet (school Wi-Fi or Ethernet) to allow this.
4. Run `ipconfig` and find the adapter named like `Local Area Connection* 2`. The `*` and the number vary by machine, and newer Windows versions may call it `Microsoft Wi-Fi Direct Virtual Adapter`. Its IPv4 address is usually **192.168.137.1**. Write it down; it's the laptop's address on your hotspot, and it goes in `SERVER_HOST` and in the phone URLs.

   ```
   Wireless LAN adapter Local Area Connection* 2:      <- the hotspot
      IPv4 Address. . . . . . . . . . . : 192.168.137.1   <- use this one

   Wireless LAN adapter Wi-Fi:                         <- your normal internet connection
      IPv4 Address. . . . . . . . . . . : 192.168.0.136   <- ignore this one
   ```

   Adapters that say "Media disconnected" are inactive; ignore them. If no adapter shows `192.168.137.x`, the hotspot isn't on. Leave any VPN (e.g. Surfshark) off while using the hotspot, because it can interfere with connection sharing.

### 2.2 Open the firewall (admin PowerShell, one time)

```powershell
netsh advfirewall firewall add rule name="Proximity demo" dir=in action=allow protocol=TCP localport=8443,8080
```

### 2.3 Make a trusted certificate (needed for the phones)

```powershell
winget install FiloSottile.mkcert
```

**Close and reopen your terminal** so `mkcert` is on PATH, then make sure the hotspot is on and run:

```powershell
npm run certs
```

Click **Yes** if Windows asks to install a certificate authority.

**Check:** the output lists `192.168.137.1` among the certificate addresses. If it doesn't, the hotspot wasn't on; turn it on and run the command again.

Run `npm start` again. The dashboard should now open without a certificate warning.

---

## Phase 3: First ESP32

### 3.1 Install the Arduino IDE

1. Download **Arduino IDE 2.x** from arduino.cc and install it.
2. Go to **File → Preferences → Additional boards manager URLs** and paste:
   ```
   https://espressif.github.io/arduino-esp32/package_esp32_index.json
   ```
3. Open **Tools → Board → Boards Manager**, search **esp32**, and install **"esp32 by Espressif Systems"**. It's a large download.
4. Open **Tools → Manage Libraries** and install:
   - **WebSockets** by **Markus Sattler**. Several libraries have similar names; pick this one.
   - **ArduinoJson** by **Benoit Blanchon**, version 7.x.

### 3.2 Plug in the board and find its port

1. Connect the ESP32 by USB.
2. Open **Device Manager → Ports (COM & LPT)**. You should see something like **"Silicon Labs CP210x (COM5)"** or **"USB-SERIAL CH340 (COM5)"**.
3. If nothing appears:
   - Try another cable; it may be charge-only.
   - Or install the driver for the chip printed on your board near the USB port: **CP2102** (Silicon Labs "CP210x VCP driver") or **CH340** (WCH driver).

### 3.3 Sanity test with Blink

Do this before the real firmware, so you know uploading works.

1. Open **File → Examples → 01.Basics → Blink**.
2. Choose **Tools → Board → esp32 → ESP32 Dev Module** and **Tools → Port → COM5**, or whatever your port is.
3. Click **Upload** (the → arrow).
4. If it stalls on `Connecting........_____`, **hold the BOOT button** on the board until the upload percentage starts, then release.

**Check:** the small LED on the board blinks once per second. Some boards have no LED wired to that pin, so it's fine if it doesn't blink as long as the upload said "Done uploading".

### 3.4 Configure and flash the actuator firmware

1. Create your secrets file (git ignores it):
   ```powershell
   Copy-Item firmware\esp32-actuator\secrets.example.h firmware\esp32-actuator\secrets.h
   ```
2. Edit `secrets.h`:
   ```cpp
   #define WIFI_SSID   "YourHotspotName"
   #define WIFI_PASS   "YourHotspotPassword"
   #define SERVER_HOST "192.168.137.1"   // from step 2.1
   #define SERVER_PORT 8080
   #define DEVICE_ID   "esp32-A"         // B for the second board
   #define GROUP_ID    "proxdemo"        // same on both boards
   #define DEVICE_TOKEN ""
   ```
3. In the Arduino IDE, use **File → Open** to open `firmware\esp32-actuator\esp32-actuator.ino`. Arduino needs the folder name to match the sketch name, which it already does.
4. **Upload**, holding BOOT if needed.
5. Open **Tools → Serial Monitor** and set the speed to **115200 baud**. Press the **EN/RST** button on the board to restart it and see the full log.

**Check:** the Serial Monitor shows:

```
[wifi] connecting to YourHotspotName.....
[wifi] connected, ip 192.168.137.xx, channel 6, mac AA:BB:...
[esp-now] ready on channel 6
[ws] connected
[alert] other  range=-1.00 m
```

(`range=-1.00` means "no distance yet", which is expected without phones.)

**Check:** with `npm start` running, the dashboard's **Actuators** card shows **esp32-A** with "alert via server" and "ESP-NOW peer: none heard". Click **Test**. The LED goes solid for 1 s and the Serial Monitor prints `[test] pulse` and `[mech] ON`.

### 3.5 Watch it react without phones

Keep the server running and start `npm run mock` (fake phones only, **not** `mock:esp32`).

**Check:** the real board's LED follows the levels:

| Level | LED |
|---|---|
| clear | off |
| proximate | slow blink |
| caution (TA) | fast blink |
| danger (RA) | solid |

---

## Phase 4: Second ESP32 and the ESP-NOW link

1. In `secrets.h`, change only `#define DEVICE_ID "esp32-B"`.
2. Plug in the second board, pick **its** COM port in Tools → Port, and upload.
3. Change `DEVICE_ID` back to `esp32-A`, so you don't later reflash board A with B's ID by accident.

**Check:** each board's Serial Monitor prints `[peer] esp32-A alive (rssi -40)` or the reverse. In the dashboard, each board shows the other as the ESP-NOW peer with "alive".

### Test the failure modes

| Test | How | Expected |
|---|---|---|
| **Heartbeat** | Unplug board A's USB (power off) | Within about 1 s, B prints `[peer] esp32-A LOST`. When clear, B's LED gives a short blip every 2 s, and the dashboard shows "LOST". Plug A back in and it recovers. |
| **Fail-safe** | Stop the server (Ctrl+C) | After 2.5 s both boards **double-blink** and the mechanism stays off. Restart the server and they recover within a few seconds. |
| **Relay** | Block one board from the server only (below) | The blocked board keeps following alerts and the dashboard shows it as "server link down, ESP-NOW alive (via esp32-A)". |

The relay test needs board B's IP from its Serial Monitor. In an admin PowerShell:

```powershell
New-NetFirewallRule -DisplayName "block esp32-B" -Direction Inbound -Protocol TCP -LocalPort 8080 -RemoteAddress 192.168.137.xx -Action Block
```

Restart the server so B's existing connection drops. When finished, remove the rule:

```powershell
Remove-NetFirewallRule -DisplayName "block esp32-B"
```

---

## Phase 5: Wire the mechanism (after the LEDs work)

**Unplug USB before wiring.** Never power a motor, solenoid or relay coil from a GPIO pin.

**Option A, relay module.** This is the easiest. Pick a module that says it works with **3.3 V logic**; some 5 V modules won't switch reliably from an ESP32.

```
ESP32 GPIO26 → relay IN
ESP32 GND    → relay GND
ESP32 VIN(5V)→ relay VCC   (or as the module's label says)
Relay COM/NO → switches your load's own power circuit
```

**Option B, logic-level N-MOSFET** (e.g. IRLZ44N, AO3400) for a DC motor, solenoid or LED strip:

```
GPIO26 → 100 Ω → MOSFET gate;   10 kΩ from gate to GND
MOSFET source → GND (shared with the external supply's −)
MOSFET drain  → load (−);  load (+) → external supply (+)
Flyback diode across a motor/solenoid (stripe toward +)
```

**Test it:**

1. Click **Test** in the dashboard. The mechanism should run for 1 s.
2. If it's **on when it should be off and off during Test**, your relay module switches on a LOW signal. Set `const bool MECH_ACTIVE_HIGH = false;` near the top of the sketch and re-upload.

The safety timing lives at the top of the sketch:

- `MECH_MIN_ON_MS` (500 ms) is the shortest time it stays on once triggered.
- `MECH_MAX_ON_MS` (5 s) is the safety cut-off.

---

## Phase 6: Phones

1. Connect both iPhones to the laptop hotspot.
2. Trust the certificate (one time per phone):
   1. In Safari, open `http://192.168.137.1:8080/ca` and allow the download.
   2. Go to **Settings → General → VPN & Device Management**, open the profile and tap **Install**.
   3. Go to **Settings → General → About → Certificate Trust Settings** and turn the mkcert root **on**.
3. Open `https://192.168.137.1:8443/phone`. Pick **A** on one phone and **B** on the other, tap **Start sensors**, and allow motion, microphone and location.
4. **Calibrate:**
   1. Hold the phones side by side, 10 cm apart, with speakers and mics uncovered.
   2. In the dashboard, press **Calibrate**.
   3. Wait until it says "calibrated".

**Check:** with no mock running, move the phones together and apart. The dashboard distance follows, and both ESP32s react together.

---

## Every session after setup (checklist)

1. Turn on the laptop **Mobile hotspot**.
2. Run `npm start`. Its printed addresses should include 192.168.137.1.
3. Power both ESP32s. Each should show "alert via server" and its peer "alive" on the dashboard.
4. Connect the phones to the hotspot, open `/phone`, and tap Start.
5. Open the dashboard and check that the Acoustic ranging success rate is high.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| No COM port appears | Charge-only cable, or a missing CP210x/CH340 driver |
| Upload stuck on `Connecting…` | Hold **BOOT** during the upload |
| `[wifi] connecting.....` forever | Hotspot not set to 2.4 GHz, wrong password, or hotspot off. SSID and password are case-sensitive. |
| Wi-Fi works but no `[ws] connected` | Wrong `SERVER_HOST`, server not running, or the firewall rule missing for port 8080 |
| Peers never see each other | Different `GROUP_ID`s, the same `DEVICE_ID` on both boards, or one board not on the hotspot |
| Hotspot toggle greyed out | The laptop needs its own internet connection; otherwise use a cheap travel router |
| `npm run certs` says "mkcert was not found on PATH" | Install it with `winget install FiloSottile.mkcert` (or `choco install mkcert`), then **close and reopen the terminal** and run it again |
| Phone page says it needs HTTPS / certificate error | Redo the certificate trust steps. If the hotspot was off during `npm run certs`, run it again with the hotspot on. |
| Board resets when the mechanism fires | The load is pulling power from the ESP32. Give it its own supply, with a shared GND. |

See the [README](../README.md) for how the system works (acoustic ranging, fusion, threat logic, ESP-NOW relay protocol).
