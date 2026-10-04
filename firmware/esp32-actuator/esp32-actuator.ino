// ESP32 actuator for the proximity demo.
//
// Joins the laptop's hotspot, opens a WebSocket to ws://<laptop>:8080/device and drives an
// LED + a mechanism output (relay / MOSFET) from the server's threat level. Two boards also
// talk to each other over ESP-NOW (same radio, same channel as the hotspot):
//   - heartbeat: each board broadcasts a small beacon every 200 ms, so each knows if the
//     other is alive;
//   - relay: the beacon carries the board's latest alert (server seq + epoch). A board whose
//     WebSocket drops keeps getting alerts from its peer, and always uses the newest copy.
//
//   other      LED off                     mechanism off
//   proximate  LED slow blink              mechanism off
//   TA         LED fast blink              mechanism off
//   RA         LED solid                   mechanism ON (min on-time, max on-time cut-off)
//   no fresh alert from server or peer -> LED double-blink, mechanism off (fail-safe)
//   peer silent (while clear)          -> short blip every 2 s
//
// Libraries (Arduino Library Manager):
//   - "WebSockets" by Markus Sattler (links2004/arduinoWebSockets)
//   - "ArduinoJson" by Benoit Blanchon, v7
// Board: "ESP32 Dev Module" (esp32 core by Espressif, 2.x or 3.x).
// Copy secrets.example.h to secrets.h and fill it in (different DEVICE_ID per board).

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <esp_arduino_version.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include "secrets.h"

// ---- pins --------------------------------------------------------------------------
const int LED_PIN = 2;                 // onboard LED on most ESP32 DevKit boards
const int MECH_PIN = 26;               // to MOSFET gate / relay module IN
const bool MECH_ACTIVE_HIGH = true;    // many relay modules are active-LOW: set false
// Ultrasonic sensor (HC-SR04 class) aimed straight at the other plane (one axis).
// HC-SR04 drives ECHO at 5 V: put a voltage divider (e.g. 1k + 2k) before the ESP32 pin.
// GPIO 12 is a boot-strapping pin: ECHO idles low so it is fine, but never hold it high at reset.
const int TRIG_PIN = 14;
const int ECHO_PIN = 12;

// ---- behaviour ---------------------------------------------------------------------
const uint32_t MECH_MIN_ON_MS = 500;   // once triggered, hold at least this long
const uint32_t MECH_MAX_ON_MS = 5000;  // safety cut-off (solenoids/motors overheat)
const uint32_t LINK_TIMEOUT_MS = 2500; // server sends ≥1 Hz; older than this -> fail-safe
const uint32_t PEER_BEACON_MS = 200;   // ESP-NOW heartbeat period
const uint32_t PEER_TIMEOUT_MS = 1000; // peer considered lost after this much silence
const bool PEER_EXPECTED = true;       // show the "peer lost" blip
const uint32_t WIFI_RETRY_MS = 5000;
const uint32_t STATUS_REFRESH_MS = 5000;
const uint32_t RANGE_PERIOD_MS = 100;    // ultrasonic reading rate (10 Hz)
const uint32_t ECHO_TIMEOUT_US = 30000;  // no echo within this (30 ms, ~5 m) -> "no echo"
const float CM_PER_US = 0.0343f;         // speed of sound at 20 °C, cm per microsecond

enum Level : uint8_t { OTHER, PROXIMATE, TA, RA };
enum Source : uint8_t { SRC_NONE, SRC_SERVER, SRC_PEER };
const char *LEVEL_NAMES[] = {"other", "proximate", "TA", "RA"};
const char *SOURCE_NAMES[] = {"none", "server", "peer"};

// ---- ESP-NOW packet ----------------------------------------------------------------
const uint32_t PACKET_MAGIC = 0x31445850; // "PXD1"
const uint8_t FLAG_WS = 1, FLAG_MECH = 2, FLAG_ALERT = 4;
const uint8_t BROADCAST[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};

struct __attribute__((packed)) PeerPacket {
  uint32_t magic;
  uint32_t group;       // FNV-1a of GROUP_ID: ignore other people's ESP-NOW traffic
  char id[16];          // sender DEVICE_ID (not necessarily NUL-terminated)
  uint32_t epoch;       // server run the alert below came from
  uint32_t seq;         // server alert sequence number
  uint8_t level;
  int16_t rangeCm;      // -1 = unknown
  uint16_t alertAgeMs;  // age of that alert at the sender when sent
  uint8_t flags;        // FLAG_*
};

// ---- state -------------------------------------------------------------------------
struct Alert {
  bool valid;
  uint32_t epoch, seq;
  Level level;
  int16_t rangeCm;
  uint32_t obtainedAt; // local millis() when the server produced it (approx.)
  Source source;
} alert = {};

struct Peer {
  bool seen;
  char id[17];
  uint32_t lastHeard;
  int rssi;
  uint8_t flags;
} peer = {};

WebSocketsClient ws;
bool wsConnected = false;
bool espNowReady = false;
uint32_t groupHash = 0;
uint8_t wifiChannel = 0;
uint32_t testUntil = 0;
bool mechOn = false, mechTimedOut = false;
uint32_t mechOnAt = 0;
uint32_t lastBeaconAt = 0, lastStatusAt = 0;
int sentLevel = -1, sentMech = -1, sentSource = -1, sentPeerAlive = -1;

// Packets arrive on the Wi-Fi task; hand the latest one to loop() through this slot.
portMUX_TYPE rxMux = portMUX_INITIALIZER_UNLOCKED;
volatile bool rxPending = false;
PeerPacket rxPacket;
int rxRssi = 0;

uint32_t fnv1a(const char *s) {
  uint32_t h = 2166136261u;
  while (*s) {
    h ^= (uint8_t)*s++;
    h *= 16777619u;
  }
  return h;
}

Level parseLevel(const char *s) {
  if (!strcmp(s, "RA")) return RA;
  if (!strcmp(s, "TA")) return TA;
  if (!strcmp(s, "proximate")) return PROXIMATE;
  return OTHER;
}

bool alertFresh(uint32_t now) { return alert.valid && now - alert.obtainedAt < LINK_TIMEOUT_MS; }
bool peerAlive(uint32_t now) { return peer.seen && now - peer.lastHeard < PEER_TIMEOUT_MS; }

// ---- ESP-NOW -----------------------------------------------------------------------

void handleRecv(const uint8_t *data, int len, int rssi) {
  if (len != (int)sizeof(PeerPacket)) return;
  PeerPacket p;
  memcpy(&p, data, sizeof p);
  if (p.magic != PACKET_MAGIC || p.group != groupHash) return;
  if (!strncmp(p.id, DEVICE_ID, sizeof p.id)) return; // our own id: misconfigured twin
  portENTER_CRITICAL(&rxMux);
  rxPacket = p;
  rxRssi = rssi;
  rxPending = true;
  portEXIT_CRITICAL(&rxMux);
}

#if ESP_ARDUINO_VERSION_MAJOR >= 3
void onEspNowRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  handleRecv(data, len, info->rx_ctrl ? info->rx_ctrl->rssi : 0);
}
#else
void onEspNowRecv(const uint8_t *mac, const uint8_t *data, int len) {
  handleRecv(data, len, 0);
}
#endif

void setupEspNow() {
  if (esp_now_init() != ESP_OK) {
    Serial.println("[esp-now] init failed");
    return;
  }
  esp_now_peer_info_t info = {};
  memcpy(info.peer_addr, BROADCAST, 6);
  info.channel = 0; // 0 = whatever channel the radio is on (the hotspot's)
  info.ifidx = WIFI_IF_STA;
  info.encrypt = false;
  if (esp_now_add_peer(&info) != ESP_OK) {
    Serial.println("[esp-now] add broadcast peer failed");
    return;
  }
  esp_now_register_recv_cb(onEspNowRecv);
  espNowReady = true;
  Serial.printf("[esp-now] ready on channel %u\n", wifiChannel);
}

void sendBeacon(uint32_t now) {
  if (!espNowReady) return;
  PeerPacket p = {};
  p.magic = PACKET_MAGIC;
  p.group = groupHash;
  strncpy(p.id, DEVICE_ID, sizeof p.id);
  p.flags = (wsConnected ? FLAG_WS : 0) | (mechOn ? FLAG_MECH : 0) | (alert.valid ? FLAG_ALERT : 0);
  if (alert.valid) {
    p.epoch = alert.epoch;
    p.seq = alert.seq;
    p.level = alert.level;
    p.rangeCm = alert.rangeCm;
    uint32_t age = now - alert.obtainedAt;
    p.alertAgeMs = age > 65535 ? 65535 : age;
  }
  esp_now_send(BROADCAST, (const uint8_t *)&p, sizeof p);
  lastBeaconAt = now;
}

// Adopt the peer's alert if it is newer than ours.
void processPeerPacket(uint32_t now) {
  if (!rxPending) return;
  PeerPacket p;
  int rssi;
  portENTER_CRITICAL(&rxMux);
  p = rxPacket;
  rssi = rxRssi;
  rxPending = false;
  portEXIT_CRITICAL(&rxMux);

  if (!peer.seen || strncmp(peer.id, p.id, 16)) {
    memcpy(peer.id, p.id, 16);
    peer.id[16] = 0;
  }
  peer.seen = true;
  peer.lastHeard = now;
  peer.rssi = rssi;
  peer.flags = p.flags;

  if (!(p.flags & FLAG_ALERT) || p.level > RA) return;
  uint32_t obtainedAt = now - p.alertAgeMs;
  bool newer = !alert.valid ||
               (p.epoch == alert.epoch && (int32_t)(p.seq - alert.seq) > 0) ||
               // Different server run (it restarted): only trust the peer if our own copy is stale.
               (p.epoch != alert.epoch && !alertFresh(now) && (int32_t)(obtainedAt - alert.obtainedAt) > 0);
  if (!newer) return;
  if (!alert.valid || alert.level != p.level) Serial.printf("[alert] %s (via peer %s)\n", LEVEL_NAMES[p.level], peer.id);
  alert = {true, p.epoch, p.seq, (Level)p.level, p.rangeCm, obtainedAt, SRC_PEER};
}

// ---- WebSocket to the server -------------------------------------------------------

void sendJson(JsonDocument &doc) {
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

void onWsEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED: {
      wsConnected = true;
      sentLevel = sentMech = sentSource = sentPeerAlive = -1; // re-report everything
      Serial.println("[ws] connected");
      JsonDocument hello;
      hello["t"] = "hello";
      hello["role"] = "device";
      hello["id"] = DEVICE_ID;
      hello["fw"] = "esp32-actuator/5";
      if (strlen(DEVICE_TOKEN)) hello["token"] = DEVICE_TOKEN;
      sendJson(hello);
      break;
    }
    case WStype_DISCONNECTED:
      if (wsConnected) Serial.println("[ws] disconnected");
      wsConnected = false;
      break;
    case WStype_TEXT: {
      JsonDocument doc;
      if (deserializeJson(doc, payload, length)) return;
      const char *t = doc["t"] | "";
      uint32_t now = millis();
      if (!strcmp(t, "alert")) {
        Level next = parseLevel(doc["level"] | "other");
        float range = doc["range"] | -1.0f;
        int16_t rangeCm = range < 0 ? -1 : (int16_t)min(32767.0f, range * 100.0f + 0.5f);
        if (!alert.valid || next != alert.level) Serial.printf("[alert] %s  range=%.2f m\n", LEVEL_NAMES[next], range);
        alert = {true, doc["epoch"] | 0u, doc["seq"] | 0u, next, rangeCm, now, SRC_SERVER};
        sendBeacon(now); // relay immediately rather than waiting for the next heartbeat
      } else if (!strcmp(t, "test")) {
        testUntil = now + (uint32_t)(doc["ms"] | 1000);
        Serial.println("[test] pulse");
      }
      break;
    }
    default:
      break;
  }
}

// ---- outputs -----------------------------------------------------------------------

void setMech(bool on) {
  if (on == mechOn) return;
  mechOn = on;
  if (on) mechOnAt = millis();
  digitalWrite(MECH_PIN, on == MECH_ACTIVE_HIGH ? HIGH : LOW);
  Serial.printf("[mech] %s\n", on ? "ON" : "off");
}

void updateOutputs(uint32_t now) {
  bool testing = (int32_t)(testUntil - now) > 0;
  bool fresh = alertFresh(now);
  Level eff = testing ? RA : (fresh ? alert.level : OTHER);

  // Mechanism: on in RA, held for a minimum time, cut off after a maximum time until RA clears.
  if (eff != RA) mechTimedOut = false;
  bool want = eff == RA && !mechTimedOut;
  if (mechOn && !want && now - mechOnAt < MECH_MIN_ON_MS) want = true;
  if (mechOn && want && now - mechOnAt > MECH_MAX_ON_MS) {
    want = false;
    mechTimedOut = true;
    Serial.println("[mech] max on-time reached, cutting off");
  }
  setMech(want);

  bool led;
  if (!fresh && !testing) {
    uint32_t p = now % 1000; // double blink: no fresh alert from server or peer
    led = p < 80 || (p > 200 && p < 280);
  } else {
    switch (eff) {
      case RA: led = true; break;
      case TA: led = now % 250 < 125; break;
      case PROXIMATE: led = now % 1000 < 100; break;
      default: led = PEER_EXPECTED && !peerAlive(now) && now % 2000 < 30; // peer-lost blip
    }
  }
  digitalWrite(LED_PIN, led ? HIGH : LOW);
}

void reportStatus(uint32_t now) {
  if (!wsConnected) return;
  bool testing = (int32_t)(testUntil - now) > 0;
  bool fresh = alertFresh(now);
  int eff = testing ? RA : (fresh ? alert.level : OTHER);
  int source = fresh ? alert.source : SRC_NONE;
  int pAlive = peerAlive(now);
  bool changed = eff != sentLevel || (int)mechOn != sentMech || source != sentSource || pAlive != sentPeerAlive;
  if (!changed && now - lastStatusAt < STATUS_REFRESH_MS) return;
  sentLevel = eff;
  sentMech = mechOn;
  sentSource = source;
  sentPeerAlive = pAlive;
  lastStatusAt = now;

  JsonDocument doc;
  doc["t"] = "applied";
  doc["level"] = LEVEL_NAMES[eff];
  doc["mechanism"] = mechOn;
  doc["source"] = SOURCE_NAMES[source];
  if (peer.seen) {
    JsonObject p = doc["peer"].to<JsonObject>();
    p["id"] = peer.id;
    p["alive"] = (bool)pAlive;
    p["rssi"] = peer.rssi;
    p["ws"] = (bool)(peer.flags & FLAG_WS);
  }
  sendJson(doc);
}

// ---- ultrasonic range --------------------------------------------------------------

// Same measurement as the bench sketch: distance to the other plane in inches,
// or -1 when no echo came back in time.
float measureInches() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);

  unsigned long duration = pulseIn(ECHO_PIN, HIGH, ECHO_TIMEOUT_US);
  if (duration == 0) return -1.0f; // no echo
  float cm = duration * CM_PER_US / 2.0f;
  return cm / 2.54f;
}

// Sends {t:'range', range} (metres, null = no echo); the server feeds it to the range filter.
void reportRange(uint32_t now) {
  static uint32_t lastAt = 0;
  if (now - lastAt < RANGE_PERIOD_MS) return;
  lastAt = now;
  float inches = measureInches(); // blocks up to ECHO_TIMEOUT_US

  // Bench check without the server: inches readout 4 times a second.
  static uint32_t lastPrintAt = 0;
  if (now - lastPrintAt >= 250) {
    lastPrintAt = now;
    if (inches < 0) Serial.println("[range] no echo");
    else Serial.printf("[range] %.1f in\n", inches);
  }

  if (!wsConnected) return;
  JsonDocument doc;
  doc["t"] = "range";
  if (inches < 0) doc["range"] = nullptr;
  else doc["range"] = roundf(inches * 0.0254f * 1000.0f) / 1000.0f; // metres, mm resolution
  sendJson(doc);
}

// ---- Wi-Fi -------------------------------------------------------------------------

// ESP-NOW shares the radio with Wi-Fi, so while off the hotspot we retry on the hotspot's
// channel instead of letting the station scan every channel (which would make us deaf to
// the peer). Every 6th try does a full scan in case the hotspot moved channel.
void maintainWifi(uint32_t now) {
  static uint32_t lastTry = 0;
  static uint8_t tries = 0;
  if (WiFi.status() == WL_CONNECTED) {
    tries = 0;
    uint8_t ch = WiFi.channel();
    if (ch != wifiChannel) {
      wifiChannel = ch;
      Serial.printf("[wifi] channel %u\n", ch);
    }
    return;
  }
  if (now - lastTry < WIFI_RETRY_MS) return;
  lastTry = now;
  bool fullScan = ++tries % 6 == 0 || wifiChannel == 0;
  Serial.printf("[wifi] reconnecting (%s)\n", fullScan ? "full scan" : "hotspot channel");
  WiFi.begin(WIFI_SSID, WIFI_PASS, fullScan ? 0 : wifiChannel);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(MECH_PIN, OUTPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);
  digitalWrite(MECH_PIN, MECH_ACTIVE_HIGH ? LOW : HIGH); // mechanism off at boot
  groupHash = fnv1a(GROUP_ID);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false); // modem sleep adds latency and makes ESP-NOW reception unreliable
  WiFi.setAutoReconnect(false); // maintainWifi() handles it, channel-aware
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[wifi] connecting to %s", WIFI_SSID);
  while (WiFi.status() != WL_CONNECTED) {
    digitalWrite(LED_PIN, !digitalRead(LED_PIN));
    delay(250);
    Serial.print('.');
  }
  wifiChannel = WiFi.channel();
  Serial.printf("\n[wifi] connected, ip %s, channel %u, mac %s\n", WiFi.localIP().toString().c_str(), wifiChannel, WiFi.macAddress().c_str());

  setupEspNow();

  ws.begin(SERVER_HOST, SERVER_PORT, "/device");
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(1000);
  ws.enableHeartbeat(2000, 1500, 2); // ping every 2 s; drop after 2 missed pongs
}

void loop() {
  uint32_t now = millis();
  maintainWifi(now);
  ws.loop();
  processPeerPacket(now);
  if (now - lastBeaconAt >= PEER_BEACON_MS) sendBeacon(now);
  updateOutputs(now);
  reportStatus(now);
  reportRange(now);

  static bool wasAlive = false;
  bool alive = peerAlive(now);
  if (alive != wasAlive) Serial.printf("[peer] %s %s (rssi %d)\n", peer.id, alive ? "alive" : "LOST", peer.rssi);
  wasAlive = alive;
}
