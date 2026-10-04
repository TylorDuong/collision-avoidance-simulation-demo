// Copy this file to secrets.h (git-ignored) and fill it in. Use a different DEVICE_ID per board.
#pragma once

#define WIFI_SSID "YourHotspotName"     // Windows Mobile Hotspot, band set to 2.4 GHz
#define WIFI_PASS "YourHotspotPassword"
#define SERVER_HOST "192.168.137.1"     // laptop's address on its own hotspot (Windows default)
#define SERVER_PORT 8080                // the server's plain-HTTP port (config.httpPort)
#define DEVICE_ID "esp32-A"             // e.g. esp32-A / esp32-B; max 15 characters
#define GROUP_ID "proxdemo"             // same on both boards; ESP-NOW packets from other groups are ignored
#define DEVICE_TOKEN ""                 // must match DEVICE_TOKEN on the server, or leave empty
