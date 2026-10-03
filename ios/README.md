# UWB Ranger (iOS app)

Measures the distance between the two iPhones with ultra-wideband (Nearby Interaction) and
sends it to the laptop server, which fuses it like any other range source and drives the
dashboard and the ESP32s. Needs two UWB iPhones (iPhone 11 or newer) on iOS 16+.

No Mac is needed: GitHub Actions builds the app, and Sideloadly signs and installs it from Windows.

## Build

1. Push this repo to GitHub. The workflow in `.github/workflows/ios.yml` runs on any change under `ios/`,
   or start it by hand from the repo's **Actions** tab (**iOS build** > **Run workflow**).
2. When the run finishes, download the **UWBRanger-ipa** artifact and unzip it to get `UWBRanger.ipa`.

If the build fails, open the failed step's log; it is the only place Swift is compiled.

## Install on each iPhone (free Apple ID)

1. Install [Sideloadly](https://sideloadly.io) on Windows, plus iTunes and iCloud from apple.com (not the Microsoft Store versions) if it asks for them.
2. Plug the iPhone in by USB and tap **Trust**. On iOS 16+, turn on **Settings > Privacy & Security > Developer Mode** and restart.
3. In Sideloadly, drag in `UWBRanger.ipa`, enter your Apple ID and press **Start**.
4. On the phone, open **Settings > General > VPN & Device Management**, tap your Apple ID and **Trust**.

A free Apple ID signature lasts **7 days**; reinstall from Sideloadly when it expires.

## Use

1. Start the server (`npm start`) with the laptop hotspot on. Both phones join the hotspot.
2. Open the app, pick **A** on one phone and **B** on the other, check the address is the laptop's
   hotspot IP (`192.168.137.1`), and tap **Start**. Allow Local Network and Nearby Interaction when asked.
3. Keep both apps in the foreground. When both are connected, each shows the distance and the
   dashboard's range source reads `uwb`.

The app talks to `ws://<laptop>:8080/uwb`, the same plain-HTTP port as the ESP32s, so the firewall rule from the setup guide already covers it.
