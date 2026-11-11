# Intercom Doorbell for HomeKit

*Українською: [документація](https://github.com/DmytryS/intercom-homekit/blob/main/intercom_homekit/DOCS.uk.md).*

Publishes a Hikvision video intercom door station as a native Apple HomeKit **Video Doorbell**:

- live video with sound in the Home app
- **two-way audio**: tap the microphone in the Home app and talk through the door station speaker
- doorbell press notifications (with snapshot) on iPhone, iPad, Apple Watch, Apple TV and HomePod chimes
- a **Door** lock tile (also shown under the live view) that opens the door relay
- a **Home Assistant device** with sensors and controls (over MQTT) for automations and dashboards

The add-on pairs with Apple Home directly. Home Assistant's built-in HomeKit Bridge cannot
forward a camera's two-way audio, so this add-on is its own HomeKit accessory, running on your
Home Assistant host.

## Installation

1. Add this repository to Home Assistant: **Settings → Apps** (called *Add-ons* before Home
   Assistant 2026.2), open the store, **⋮ → Repositories**, and add
   `https://github.com/DmytryS/intercom-homekit`.
2. Install **Intercom Doorbell for HomeKit**. Home Assistant downloads the prebuilt image
   (about 250 MB, amd64 or aarch64) from Docker Hub.
3. On the **Configuration** tab, edit the entry under **Doorbells**: name, IP address, username
   and password. Use **Add** for more door stations. Then start the add-on and check the
   [compatibility check](#supported-door-stations) in the **Log** tab.
4. Click **Open Web UI** on the add-on page (or **Doorbell** in the sidebar, if you enabled
   *Show in sidebar*). It shows a HomeKit pairing QR code and setup code for each doorbell.
5. In the Home app on your iPhone or iPad, tap **+ → Add Accessory** and scan the QR code.
   Alternatively, tap **More options…**, pick the doorbell and enter its setup code. On the
   iPhone itself, **Open in the Home app** on that page may start pairing directly.

The setup code and a text QR code are also printed in the **Log** tab while the doorbell isn't
paired. The text QR code scans reliably in a terminal (for example `ha addons logs` over SSH). The
Home Assistant log viewer adds space between lines, which can stop it from scanning there, so
use the Web UI page instead. After pairing, the page shows "Paired with Apple Home". If you
remove the doorbell from the Home app, the code appears again.

If the doorbell was previously in HomeKit through Scrypted or Homebridge, remove that accessory
from the Home app first.

### Moving from "Hikvision Doorbell for HomeKit"

Version 0.7 renamed the add-on, and Home Assistant treats it as a new one. The old one stays
installed but gets no more updates.

1. Copy your options from the old add-on's **Configuration** tab (⋮ → **Edit in YAML**).
2. Stop and uninstall the old add-on, then install this one and paste the options.
3. Start it, remove the old doorbell from the Home app, and pair again.

Your Home Assistant device and its entities stay the same, including automations that use them.

## Supported door stations

Tested on the **DS-KV6113-WPE1(B)** (firmware V2.2.53). Other Hikvision villa door stations
(DS-KV6xxx, DS-KV8xxx, DS-KD8003 modular, DS-KB8xxx) use the same interfaces and are expected to
work, but aren't confirmed yet.

Each time it starts, the add-on checks what works on your door station and writes the result to the
**Log** tab:

```
compatibility check: DS-KV6113-WPE1(B), firmware V2.2.53
  ✓ ring detection: call status works ("idle")
  ✓ snapshots: picture request works (24 KB)
  ✓ video: H.264 1920×1080
  ✓ audio: G.711 µ-law 8 kHz
  ✓ talk-back: Hikvision SDK login works
```

`!` marks something that works with a workaround, and `✗` something that doesn't work on your
model. The line says what is affected. The add-on adapts to what it finds:

- **No call status:** the door station still shows as online, and the door, live view and talk-back
  work, but rings can't be detected.
- **No audio track:** live view runs without sound.
- **H.265 video:** transcoded to H.264, which costs CPU. Set the main stream to H.264 on the door
  station to avoid that.
- **Picture request fails:** snapshots come from the video stream instead.

**Please share your result**, whether everything works or not, in a
[device report](https://github.com/DmytryS/intercom-homekit/issues/new?template=device-report.yml).
That's how models get confirmed.

Other brands can be added as drivers; see
[CONTRIBUTING.md](https://github.com/DmytryS/intercom-homekit/blob/main/CONTRIBUTING.md).

## Home Assistant entities

If the **Mosquitto broker** add-on and the **MQTT** integration are installed, the add-on also
appears in Home Assistant as a device (Settings → Devices & services → MQTT). It finds the broker
by itself; fill in the **MQTT** section only for a different broker. Each doorbell is a
separate device.

| Entity | Type | What it does |
|---|---|---|
| Doorbell | event (doorbell) | Fires `ring` when someone presses the button: use it to trigger automations |
| Call state | sensor | `idle`, `ringing` or `on_call` |
| Open door | button | Opens the door relay (one per door, see `doors`) |
| Hang up / Reject call | button | Ends a ring silently / with a busy tone |
| Take snapshot | button | Updates the Snapshot image |
| Snapshot | image | Picture from the last ring (or start-up, or Take snapshot) |
| Speaker / Talk / Microphone volume | number, 0–10 | Door station volumes: prompts and ring-back, voice during calls and talk-back, microphone |
| Test ring | button (configuration) | Rings as if someone pressed the door station button: Home app notification with snapshot, HomePod chime and the Doorbell event. To try notifications and automations without going outside |
| Restart | button | Reboots the door station |
| Connection | binary sensor (diagnostic) | Door station reachable |
| Video streams | sensor (diagnostic) | Video streams the door station is serving now (NVR, Frigate, this add-on…); the `clients` attribute lists their addresses as far as the device reports them |
| Logged-in clients | sensor (diagnostic) | Clients logged in to the door station (web UI, SDK, apps); `clients` shows user, address and login time |
| Talk-back | binary sensor (diagnostic) | The door station speaker is in use by the Home app |
| HomeKit live views | sensor (diagnostic) | Live views streaming now |
| HomeKit paired | binary sensor (diagnostic) | Paired with Apple Home |

Controls and live states show *unavailable* while the add-on is stopped or the door station is
offline. Video streams and logged-in clients are checked every 30 s. They help when live view fails
because the door station is out of sessions (see [Door station stream slots](#door-station-stream-slots)). The door station doesn't report CPU or memory load.
Its ISAPI status endpoint answers "invalid operation" and it has no SNMP.

Example: a notification with the visitor's picture (entity ids for the default name `Doorbell`).

```yaml
triggers:
  - trigger: state
    entity_id: event.doorbell
    not_from: unavailable # not when the add-on restarts
actions:
  - action: notify.mobile_app_iphone
    data:
      message: Someone is at the door
      data:
        image: /api/image_proxy/image.doorbell_snapshot
```

The snapshot is sent a moment after the ring event. If the picture in the notification is the
previous visitor, trigger on the `image.doorbell_snapshot` state instead, or add a 2-second delay.

Anyone who can publish to your MQTT broker can open the door, the same as with any MQTT lock.
The Mosquitto add-on only accepts logged-in users. The add-on ignores (and clears) commands
stored on the broker with *retain*, so a stray retained "open door" message can't replay on restart.

Entity names follow **System → language** (`en` or `uk`). Entity ids are English in either
language, so `event.doorbell` and `image.doorbell_snapshot` work as above. Changing the language
renames existing entities but keeps their ids.

To remove the devices from Home Assistant, turn **MQTT → enabled** off, restart the add-on, then
delete the devices on the MQTT integration page.

## Several door stations

Add one entry per door station under **Doorbells**. Each one becomes:

- its own HomeKit accessory. Pair each one; the **Open Web UI** page lists them all;
- its own Home Assistant device (MQTT), named after the entry;
- its own HomeKit port: the first uses `homekit.port` (51828), the next ones the following
  ports (51830 is skipped, it is the Web UI).

The door stations run independently: one that is offline or misconfigured is logged and retried,
and the others keep working. With more than one, log lines start with the doorbell's name, e.g.
`[Gate/call] doorbell pressed`.

Names must be unique. A renamed doorbell keeps its HomeKit pairing as long as its IP address
stays the same. A removed doorbell's identity is kept, so adding it back restores the pairing.

## Options

**Doorbells** (one entry per door station):

| Option | Default | Description |
|---|---|---|
| `name` | `Doorbell` | Name in the Home app and in Home Assistant |
| `type` | `hikvision` | Door station brand (driver). Only `hikvision` so far |
| `host` | – | Door station IP address |
| `username` / `password` | `admin` / – | Door station credentials |
| `doors` | `1` | Door lock tiles / Open door buttons, up to 8 (`0` hides them) |
| `door_relock_seconds` | `5` | When the HomeKit lock tile returns to "locked" |
| `homekit_pin` | random | Fixed setup code (`123-45-678` format) |
| `rtsp_url` | main stream | Alternative video source (restream) |
| `http_port` / `rtsp_port` / `sdk_port` | `80` / `554` / `8000` | Door station ports (Hikvision) |
| `reset_homekit_pairing` | `false` | Forget this doorbell's pairings and create a new accessory on next start (turn off again afterwards) |

Shared by all doorbells:

| Section | Option | Default | Description |
|---|---|---|---|
| Talk-back | `ring_action` (Hikvision) | `hangUp` | What to send when you start talking while it rings: `hangUp` (silent), `reject` (busy tone), `answer_hangup` (needs Hik-Connect), `none` |
| | `gain` | `1.5` | Loudness of your voice on top of the automatic level control |
| | `idle_seconds` | `3` | Silence before the speaker is released |
| Video | `transcode` | `false` | Always re-encode with libx264 (H.265 is transcoded without it) |
| | `max_streams` | `2` | Concurrent live views per doorbell |
| HomeKit | `port` | `51828` | HomeKit port of the first doorbell |
| | `bind` | all | Interface or IP to advertise on (try your LAN IP if pairing is flaky) |
| | `mdns_advertiser` | `ciao` | `ciao` or `bonjour-hap` |
| MQTT | `enabled` | `true` | Publish Home Assistant devices over MQTT |
| | `host` / `port` / `username` / `password` | Mosquitto add-on | Another MQTT broker |
| System | `log_level` | `info` | `debug` logs every ffmpeg/SDK detail |
| | `call_poll_interval` (Hikvision) | `1` | Seconds between ring checks |
| | `language` | `en` | Names of Home Assistant entities and HomeKit door tiles: `en` or `uk` (Ukrainian) |

## Door station stream slots

Door stations serve only a few simultaneous sessions (**6** on the DS-KV6113): RTSP viewers, the indoor station,
Hik-Connect, NVRs and talk-back all count. When they're used up, live view fails with
`ffmpeg exited … 500 Internal Server Error` in the log. To see who holds them, look at the
**Video streams** and **Logged-in clients** sensors in Home Assistant, or run:

```
curl --digest -u admin:PASSWORD http://DOORBELL_IP/ISAPI/Streaming/status
curl --digest -u admin:PASSWORD http://DOORBELL_IP/ISAPI/Security/onlineUser
```

This add-on only opens a stream while someone is watching. To save more slots, point `rtsp_url`
at a restream you already run (go2rtc, Frigate), e.g. `rtsp://homeassistant.local:8554/doorbell`.

## Faster live view start

The live view starts at the next key frame. The door station default is one key frame every
2 s (I-frame interval 50 at 25 fps). Set **Configuration → Video/Audio → I Frame Interval** to
`25` to cut the worst-case start delay to about 1 s.

## Troubleshooting

- **Accessory not shown when pairing.** HomeKit uses mDNS. Make sure your iPhone and the Home
  Assistant host are on the same network, or that your router reflects mDNS between them. Set
  **HomeKit → bind** to the host's LAN IP and restart.
- **"No Response" in the Home app.** Check the log for `door station OFFLINE` or `snapshot failed`. The
  camera tile needs a snapshot, so a failing snapshot shows "No Response" even though live video works.
- **`door station picture request failed … taking snapshots from the video stream instead`.** The door
  station can't take pictures at the moment, though its video still works. HomeKit and Home Assistant
  keep getting snapshots, but each one briefly uses one of the door station's stream slots, and
  `snapshot failed` means none was free. The add-on checks every 10 minutes whether pictures work
  again. Restarting the door station may fix it sooner.
- **No ring notifications.** Press **Test ring** on the doorbell's device page in Home Assistant.
  - No notification from the test either: check the doorbell's notification settings in the Home
    app (long-press the camera tile → settings → **Notifications**).
  - The test works but real rings don't: check the compatibility check in the log. `✗ ring
    detection` means your model doesn't report its call status. Please send a
    [device report](https://github.com/DmytryS/intercom-homekit/issues/new?template=device-report.yml).
- **Live view has no sound.** If the compatibility check says `no audio track`, set the door
  station's stream type to **Video & Audio** (web UI → **Configuration → Video/Audio → Video**).
- **No sound at the door.** After you tap the microphone in the Home app, the log should show
  `microphone on`, then `talk-back open (… ms)` when you speak, and on silence
  `talk-back closed (…): … s of speech, mic level … dBFS, gain … dB` followed by
  `voice talk stopped (N frames sent, …)`.
  - No `microphone on`: the Home app isn't sending audio (check the microphone button and iOS
    microphone permission for Home).
  - `microphone audio never reached the speech threshold`: the microphone is muted or very quiet.
  - Frames sent but nothing heard: raise the door station's talk volume (web UI →
    **Configuration → Video/Audio → Audio**, or the indoor station settings) and **Talk-back → gain**.
  - If the door station was ringing, try another **Talk-back → ring_action**.
- **No device under MQTT.** The log says `no MQTT broker found` (install Mosquitto and the MQTT
  integration, then restart the add-on) or shows the MQTT connection error.
- **Authentication errors.** The door station locks the account after repeated failed logins;
  the add-on backs off for 60 s after an authentication failure.

## Limitations

- HomeKit Secure Video recording isn't implemented. Notifications and live view are.
- amd64 and aarch64 only (the Hikvision SDK isn't available for 32-bit ARM).

## How it works

For the curious, and for anyone adding support for another model. This is the Hikvision driver;
the HomeKit and Home Assistant parts are the same for every brand.

| Function | Path |
|---|---|
| Live video | Door station RTSP H.264 → ffmpeg (passthrough; libx264 only for other codecs) → SRTP → Apple device |
| Doorbell audio | RTSP G.711 → Opus → RTP relay (fixes HomeKit's Opus timestamps) → SRTP |
| Talk-back | iPhone Opus (SRTP) → decrypted → libopus (WebAssembly) 8 kHz → automatic level control → G.711 µ-law → Hikvision SDK voice forwarding (TCP 8000) |
| Ring | `GET /ISAPI/VideoIntercom/callStatus` polled every second |
| Door | `PUT /ISAPI/AccessControl/RemoteControl/door/1` |
| Snapshot | `GET /ISAPI/Streaming/channels/101/picture`, or one frame of the RTSP stream while that fails |

Notes:

- **Talk-back uses the Hikvision SDK.** The DS-KV61xx firmware answers ISAPI two-way audio
  (`/ISAPI/System/TwoWayAudio/channels/1/open`) with `invalidOperation`. That's why ISAPI-based
  tools (Scrypted, go2rtc's `isapi://`) can't talk to this door station. The SDK's voice
  forwarding works, so the add-on runs the vendor library in a separate helper process.
- **Rings are polled.** The ISAPI event stream (`alertStream`) returns an empty document on this
  firmware, so event-stream-based integrations miss rings. `callStatus` stays `ring` for the
  whole ring period, so a 1 s poll never misses a press.
- Talk-back starts on the first speech from your iPhone microphone and stops after
  **Talk-back → idle_seconds** of silence. Just watching the live view never grabs the door station
  speaker or cancels a ring.
- Phone microphones deliver speech anywhere between about -45 and -15 dBFS. The add-on levels
  it to about -16 dBFS (times **Talk-back → gain**) so it is audible on the street, and limits peaks.
