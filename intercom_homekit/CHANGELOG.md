# Changelog

## 0.7.0

**Renamed** from "Hikvision Doorbell for HomeKit" to "Intercom Doorbell for HomeKit" (slug
`intercom_homekit`, image `dmytrys/intercom-homekit`). Home Assistant installs it as a new add-on:
see "Moving from Hikvision Doorbell for HomeKit" in the documentation. You'll need to pair it with
the Home app again; Home Assistant entities stay the same.

Works with more door stations:

- **Compatibility check** in the log at start-up: model, firmware, and whether ring detection, snapshots,
  video, audio and talk-back work. If your model isn't listed as tested, please share it in a
  [device report](https://github.com/DmytryS/intercom-homekit/issues/new?template=device-report.yml).
- Live view works on door stations whose stream has **no audio track** (stream type "Video"). Before,
  ffmpeg refused to start.
- **H.265** (or any non-H.264) streams are transcoded automatically, as HomeKit only plays H.264.
- Door stations without the call status endpoint are no longer shown as offline: the door, live
  view, talk-back and Home Assistant entities work, and the log says rings can't be detected.
- **Ready for other brands**: door station access is now a driver behind a common interface, and
  HomeKit, Home Assistant, snapshots and the compatibility check are shared. A new `type` option
  per doorbell picks the driver (`hikvision`, the default, so existing options keep working).
  Home Assistant only shows controls the driver supports. See CONTRIBUTING.md for adding a brand.
- **Ukrainian**: the Configuration tab follows Home Assistant's language. The new **System →
  language** option (`en` or `uk`) names the Home Assistant entities and the HomeKit door tiles.
  Entity ids stay English, so automations and the documented ids keep working. The pairing page
  follows the browser's language. Documentation in Ukrainian: DOCS.uk.md and README.uk.md.
- Doorbells with Ukrainian (Cyrillic) names: two of them are no longer rejected as having the same
  name. Their storage key changes, and they keep their HomeKit pairing (matched by IP address).
- **Test ring** button on the doorbell's device page in Home Assistant (Configuration section): rings
  like the door station button, with the Home app notification, HomePod chime and doorbell event, so
  notifications and automations can be tried from the sofa.
- Up to 8 door relays per doorbell (`doors`), was 2.
- Fixed: a talk-back helper that can't start no longer crashes the add-on.
- Store icon and logo, MIT license. The add-on is marked *experimental* until more models are confirmed.

## 0.6.4

- Fixed the camera tile showing "No Response" in the Home app, with no picture, on door stations whose
  picture request fails (`deviceError` after 30 s) while video keeps working. Snapshots for HomeKit and
  Home Assistant now come from the video stream until picture requests work again.

## 0.6.3

- Home Assistant downloads the prebuilt image (`dmytrys/hikvision-homekit`) instead of building it on
  your machine: installs and updates take seconds instead of minutes.
- Node.js 26 (LTS "Lithium", supported until April 2029) instead of 24. Same Debian 12 base,
  ffmpeg and Hikvision SDK.

## 0.6.2

- Prebuilt multi-arch image (amd64, aarch64) published to Docker Hub as `dmytrys/hikvision-homekit`
  by CI for every new version.
- Image labels for Home Assistant (`io.hass.*`).

## 0.6.1

- The Hikvision SDK is bundled in the repository (`vendor/hcnetsdk`, checksummed) instead of downloaded
  from a third-party repository at build time, so installs no longer depend on it staying online.
- CI builds the image and checks that the SDK loads.

## 0.6.0

- **Several door stations**: options now have a **Doorbells** list. Each door station is its own HomeKit
  accessory (own pairing code, all on the Web UI page) and its own Home Assistant device. Door stations
  run independently: one that is offline doesn't hold up the others.
- **Grouped options**: Talk-back, Video, HomeKit, MQTT and System sections. Options of earlier versions
  are converted and saved automatically on the first start. Your HomeKit pairing and Home Assistant
  device are kept.
- Log lines name the doorbell when there are several.
- `reset_homekit_pairing` is now per doorbell.
- An unexpected error in one doorbell is logged instead of stopping the add-on.
- CI: type-check, tests and the Home Assistant add-on linter on every push.

## 0.5.0

- Home Assistant sensors **Video streams** and **Logged-in clients** (with client addresses), to
  see what is using the door station's few sessions. Checked every 30 s.

## 0.4.0

- **Home Assistant device over MQTT** (Mosquitto add-on found automatically):
  - doorbell event and call state;
  - open door, hang up, reject call, take snapshot and restart buttons;
  - snapshot image, updated on each ring;
  - speaker, talk and microphone volume sliders;
  - diagnostics: connection, talk-back, HomeKit live views, HomeKit paired.
- HomeKit and Home Assistant share one snapshot request per ring.

## 0.3.0

- **Open Web UI** page (Home Assistant ingress) with the HomeKit pairing QR code and setup code.
  It updates itself once paired. It only answers Home Assistant's ingress proxy.
- Text QR code in the log while not paired, shown again when the doorbell is removed from the
  Home app.

## 0.2.0

- Fix talk-back that never reached the door station when the microphone was turned on more
  than ~20 s into the live view: the microphone stream is now decoded in-process (libopus via
  WebAssembly) and never times out.
- Automatic level control for your voice (speech is brought to about -16 dBFS before
  `talk_gain`), with no clipping. Quiet phone microphones were barely audible at the door.
- 60 ms jitter buffer before the door station, and speech spoken while talk-back is opening is
  kept (pauses are skipped to catch up) instead of being cut.
- Don't pin the Hikvision SDK to the host's first network address (wrong on hosts with
  Docker bridges).
- Log the microphone level and talk-back statistics at info level.

## 0.1.0

- First version: HomeKit video doorbell with live video, two-way audio (Hikvision SDK voice
  forwarding), ring notifications (ISAPI call status), snapshots and door lock.
