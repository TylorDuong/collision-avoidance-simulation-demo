# Setup guide: server, ESP32 boards, ultrasonic sensors

This guide is for someone new to the ESP32 but comfortable with servers and terminals. It goes in the order that catches problems earliest: the software alone, then the network, then one ESP32 with its sensor, then the second, then the mechanism.

It assumes a classic **ESP32 DevKit (ESP32-WROOM-32)** board and that you run commands from the project folder.

---

## 0. What you need

- The Windows laptop with Node.js 20 or newer. It runs the server and the TCAS dashboard, and hosts the hotspot.
- **2 × ESP32 DevKit boards**, plus **USB cables that carry data**. Many cheap cables are charge-only and the board won't show up.
- **2 × ultrasonic sensors** (HC-SR04 or JSN-SR04T). If they run on 5 V, you also need 2 voltage dividers for `ECHO`, for example a 1 kΩ and a 2 kΩ resistor each.
- 2 LEDs with 220 Ω resistors.
- Later, for the mechanism: a relay module or a logic-level MOSFET, and a separate power supply for whatever it switches.

---

## Phase 1: Run everything simulated (no hardware)

This proves the server side works before you touch any hardware.

```powershell
npm install
npm run build
npm start
```

**Check:** the terminal prints `Dashboard:  http://localhost:8080/dashboard` and one `ESP32:  ws://…:8080/device` line per network address.

In a **second terminal**, run `npm run mock:esp32 -- --range`. That starts two simulated boards that send ultrasonic ranges.

Open http://localhost:8080/dashboard.

**Check:**
- The **Ultrasonic ranging** card shows both boards' distances in inches, closing and opening every 30 s.
- The threat level goes OTHER → PROXIMATE → TA → RA and back, and the two TCAS displays show the other board as traffic.
- The **Actuators** card lists `esp32-A` and `esp32-B` with "alert via server" and the peer "alive".
- The mock terminal prints LED and mechanism changes.

Optional: restart the mock with `npm run mock:esp32 -- --range --drop-ws esp32-B@5-15`. Between 5 s and 15 s, B should switch to "alert via peer". That's the ESP-NOW relay working.

Optional: `npm run mock` plays the full TCAS demo scenario instead of the boards.

Stop both terminals with Ctrl+C. Don't run `mock:esp32` once the real boards are connected, because the IDs would clash.

---

## Phase 2: Network (hotspot and firewall)

### 2.1 Turn on the laptop hotspot

1. Go to Settings → Network & internet → **Mobile hotspot**.
2. Click **Edit** and set a name, a password, and **Band: 2.4 GHz**. The ESP32 can't see 5 GHz networks.
3. Turn the hotspot **On**. Windows usually needs the laptop itself connected to the internet (school Wi-Fi or Ethernet) to allow this.
4. Run `ipconfig` and find the adapter named like `Local Area Connection* 2`. The `*` and the number vary by machine, and newer Windows versions may call it `Microsoft Wi-Fi Direct Virtual Adapter`. Its IPv4 address is usually **192.168.137.1**. Write it down; it's the laptop's address on your hotspot, and it goes in `SERVER_HOST`.

   ```
   Wireless LAN adapter Local Area Connection* 2:      <- the hotspot
      IPv4 Address. . . . . . . . . . . : 192.168.137.1   <- use this one

   Wireless LAN adapter Wi-Fi:                         <- your normal internet connection
      IPv4 Address. . . . . . . . . . . : 192.168.0.136   <- ignore this one
   ```

   Adapters that say "Media disconnected" are inactive; ignore them. If no adapter shows `192.168.137.x`, the hotspot isn't on. Leave any VPN (e.g. Surfshark) off while using the hotspot, because it can interfere with connection sharing.

### 2.2 Open the firewall (admin PowerShell, one time)

```powershell
netsh advfirewall firewall add rule name="Proximity demo" dir=in action=allow protocol=TCP localport=8080
```

The dashboard runs on the laptop itself, so only the boards need this rule.

---

## Phase 3: First ESP32 and its sensor

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

### 3.4 Wire the LED and the ultrasonic sensor

**Unplug USB before wiring.**

```
GPIO13 ── 220 Ω → LED (+, long leg) → LED (−) → GND
GPIO14 ── sensor TRIG
GPIO12 ── sensor ECHO   (5 V sensor: ECHO → 1 kΩ → GPIO12, and GPIO12 → 2 kΩ → GND)
5V/VIN ── sensor VCC    (3.3 V if your sensor is a 3.3 V model)
GND    ── sensor GND
```

GPIO 12 is a boot-strapping pin. `ECHO` idles low, so this works, but never hold it high while the board resets. The pins are set at the top of the sketch (`TRIG_PIN`, `ECHO_PIN`, `LED_PIN`) if you need different ones.

### 3.5 Configure and flash the firmware

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
   #define DEVICE_ID   "esp32-A"         // esp32-B for the second board
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
[range] 12.4 in
```

`range=-1.00` on the alert line means the server has no distance yet. The `[range]` lines are the sensor's own readings, 4 times a second. Move your hand in front of the sensor and they should follow it. `[range] no echo` means nothing reflected back within range; if it never changes, check the `TRIG`/`ECHO` wiring and the voltage divider.

**Check:** with `npm start` running, the dashboard shows:
- **Actuators:** **esp32-A** with "alert via server" and "ESP-NOW peer: none heard". Click **Test**. The LED goes solid for 1 s and the Serial Monitor prints `[test] pulse` and `[mech] ON`.
- **Ultrasonic ranging:** esp32-A's reading in inches.
- The TCAS displays draw the other aircraft at the measured distance. Bring your hand closer than 18, 10 and 6 in and the LED follows the levels:

| Level | LED |
|---|---|
| other | off |
| proximate | slow blink |
| TA | fast blink |
| RA | solid |

---

## Phase 4: Second ESP32 and the ESP-NOW link

1. Wire the second board the same way (step 3.4).
2. In `secrets.h`, change only `#define DEVICE_ID "esp32-B"`.
3. Plug in the second board, pick **its** COM port in Tools → Port, and upload.
4. Change `DEVICE_ID` back to `esp32-A`, so you don't later reflash board A with B's ID by accident.
5. Point the two sensors at each other along one axis.

**Check:**
- Each board's Serial Monitor prints `[peer] esp32-A alive (rssi -40)` or the reverse. In the dashboard, each board shows the other as the ESP-NOW peer with "alive".
- The **Ultrasonic ranging** card shows two similar readings, and the Range source reads `ultrasonic`.
- Moving the boards together takes both displays through proximate, TA and RA, and both LEDs follow.

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

Restart the server so B's existing connection drops. While B is blocked, only A's readings reach the server. When finished, remove the rule:

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

## Every session after setup (checklist)

1. Turn on the laptop **Mobile hotspot**.
2. Run `npm start`. Its printed `ESP32:` addresses should include 192.168.137.1.
3. Power both ESP32s. Each should show "alert via server" and its peer "alive" on the dashboard.
4. Open http://localhost:8080/dashboard. The "Ultrasonic ranging" card should show each board's distance in inches, and the Range source should read `ultrasonic`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| No COM port appears | Charge-only cable, or a missing CP210x/CH340 driver |
| Upload stuck on `Connecting…` | Hold **BOOT** during the upload |
| `[wifi] connecting.....` forever | Hotspot not set to 2.4 GHz, wrong password, or hotspot off. SSID and password are case-sensitive. |
| Wi-Fi works but no `[ws] connected` | Wrong `SERVER_HOST`, server not running, or the firewall rule missing for port 8080 |
| `[range] no echo` all the time | `TRIG`/`ECHO` swapped or loose, missing voltage divider, sensor without power, or nothing within about 4 m in front of it |
| Readings jump around | The sensors aren't facing each other, or a soft or angled surface is reflecting. Keep about a 15° cone clear in front of each sensor. |
| Board won't boot with the sensor attached | `ECHO` is holding GPIO 12 high at reset. Check the divider, or move `ECHO` to another pin and change `ECHO_PIN`. |
| Peers never see each other | Different `GROUP_ID`s, the same `DEVICE_ID` on both boards, or one board not on the hotspot |
| Hotspot toggle greyed out | The laptop needs its own internet connection; otherwise use a cheap travel router |
| Dashboard says `web/dist missing` | Run `npm run build` |
| Board resets when the mechanism fires | The load is pulling power from the ESP32. Give it its own supply, with a shared GND. |

See the [README](../README.md) for how the system works (filtering, threat logic, the TCAS displays and the ESP-NOW relay protocol).
