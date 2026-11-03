# Hikvision Doorbell for HomeKit

Publishes a Hikvision villa door station (tested: **DS-KV6113-WPE1(B)**, firmware V2.2.53) as a
native Apple HomeKit **Video Doorbell**:

- live video with sound in the Home app
- **two-way audio**: tap the microphone in the Home app and talk through the door station speaker
- doorbell press notifications (with snapshot) on iPhone, iPad, Apple Watch, Apple TV and HomePod chimes
- a **Door** lock tile (also shown under the live view) that opens the door relay
- a **Home Assistant device** with sensors and controls (over MQTT) for automations and dashboards

The add-on pairs with Apple Home directly. Home Assistant's built-in HomeKit Bridge cannot
forward a camera's two-way audio, so this add-on is its own HomeKit accessory, running on your
Home Assistant host.

## How it works

| Function | Path |
|---|---|
| Live video | Door station RTSP H.264 → ffmpeg (passthrough, no transcoding) → SRTP → Apple device |
| Doorbell audio | RTSP G.711 → Opus → RTP relay (fixes HomeKit's Opus timestamps) → SRTP |
| Talk-back | iPhone Opus (SRTP) → decrypted → libopus (WebAssembly) 8 kHz → automatic level control → G.711 µ-law → Hikvision SDK voice forwarding (TCP 8000) |
| Ring | `GET /ISAPI/VideoIntercom/callStatus` polled every second |
| Door | `PUT /ISAPI/AccessControl/RemoteControl/door/1` |
| Snapshot | `GET /ISAPI/Streaming/channels/101/picture` |

Notes:

- **Talk-back uses the Hikvision SDK.** The DS-KV61xx firmware answers ISAPI two-way audio
  (`/ISAPI/System/TwoWayAudio/channels/1/open`) with `invalidOperation`. That's why ISAPI-based
  tools (Scrypted, go2rtc's `isapi://`) can't talk to this door station. The SDK's voice
  forwarding works, so the add-on runs the vendor library in a separate helper process.
- **Rings are polled.** The ISAPI event stream (`alertStream`) returns an empty document on this
  firmware, so event-stream-based integrations miss rings. `callStatus` stays `ring` for the
  whole ring period, so a 1 s poll never misses a press.
- Talk-back starts on the first speech from your iPhone microphone and stops after
  `talk_idle_seconds` of silence. Just watching the live view never grabs the door station
  speaker or cancels a ring.
- Phone microphones deliver speech anywhere between about -45 and -15 dBFS. The add-on levels
  it to about -16 dBFS (times `talk_gain`) so it is audible on the street, and limits peaks.

## Installation

1. Add this repository to Home Assistant (**Settings → Add-ons → Add-on store → ⋮ →
   Repositories**), or copy the `hikvision_homekit` folder into the `/addons` share. With the
   copy, it appears under **Local add-ons**.
2. Install **Hikvision Doorbell for HomeKit**. The first build downloads ffmpeg and the
   Hikvision SDK, which takes a few minutes.
3. Configure at least `host` and `password`, then start the add-on.
4. Click **Open Web UI** on the add-on page (or **Doorbell** in the sidebar, if you enabled
   *Show in sidebar*). It shows the HomeKit pairing QR code and setup code.
5. In the Home app on your iPhone or iPad, tap **+ → Add Accessory** and scan the QR code.
   Alternatively, tap **More options…**, pick **Doorbell** and enter the setup code. On the
   iPhone itself, **Open in the Home app** on that page may start pairing directly.

The setup code and a text QR code are also printed in the **Log** tab while the doorbell isn't
paired. The text QR code scans reliably in a terminal (for example `ha addons logs` over SSH). The
Home Assistant log viewer adds space between lines, which can stop it from scanning there, so
use the Web UI page instead. After pairing, the page shows "Paired with Apple Home". If you
remove the doorbell from the Home app, the code appears again.

If the doorbell was previously in HomeKit through Scrypted or Homebridge, remove that accessory
from the Home app first.

## Door station stream slots

The DS-KV6113 serves at most **6 simultaneous sessions**: RTSP viewers, the indoor station,
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

## Home Assistant entities

If the **Mosquitto broker** add-on and the **MQTT** integration are installed, the add-on also
appears in Home Assistant as a device (Settings → Devices & services → MQTT). It finds the broker
by itself; set `mqtt_host` and friends only for a different broker.

| Entity | Type | What it does |
|---|---|---|
| Doorbell | event (doorbell) | Fires `ring` when someone presses the button: use it to trigger automations |
| Call state | sensor | `idle`, `ringing` or `on_call` |
| Open door | button | Opens the door relay (one per door, see `doors`) |
| Hang up / Reject call | button | Ends a ring silently / with a busy tone |
| Take snapshot | button | Updates the Snapshot image |
| Snapshot | image | Picture from the last ring (or start-up, or Take snapshot) |
| Speaker / Talk / Microphone volume | number, 0–10 | Door station volumes: prompts and ring-back, voice during calls and talk-back, microphone |
| Restart | button | Reboots the door station |
| Connection | binary sensor (diagnostic) | Door station reachable |
| Video streams | sensor (diagnostic) | Video streams the door station is serving now (NVR, Frigate, this add-on…); the `clients` attribute lists their addresses as far as the device reports them |
| Logged-in clients | sensor (diagnostic) | Clients logged in to the door station (web UI, SDK, apps); `clients` shows user, address and login time |
| Talk-back | binary sensor (diagnostic) | The door station speaker is in use by the Home app |
| HomeKit live views | sensor (diagnostic) | Live views streaming now |
| HomeKit paired | binary sensor (diagnostic) | Paired with Apple Home |

Controls and live states show *unavailable* while the add-on is stopped or the door station is
offline. Video streams and logged-in clients are checked every 30 s. They help when live view fails
because the door station is out of sessions (see below). The door station doesn't report CPU or memory load.
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

To remove the device from Home Assistant, turn `mqtt` off, restart the add-on, then delete the
device on the MQTT integration page.

## Options

| Option | Default | Description |
|---|---|---|
| `name` | `Doorbell` | Name in the Home app |
| `host` | – | Door station IP address |
| `username` / `password` | `admin` / – | Door station credentials |
| `ring_action` | `hangUp` | What to send when you start talking while it rings: `hangUp` (silent), `reject` (busy tone), `answer_hangup` (needs Hik-Connect), `none` |
| `talk_gain` | `1.5` | Loudness of your voice on top of the automatic level control |
| `mqtt` | `true` | Publish the Home Assistant device over MQTT |
| `log_level` | `info` | `debug` logs every ffmpeg/SDK detail |
| `homekit_pin` | random | Fixed setup code (`123-45-678` format) |
| `rtsp_url` | main stream | Alternative video source (restream) |
| `video_transcode` | `false` | Re-encode with libx264 (only for H.265 sources) |
| `max_streams` | `2` | Concurrent live views |
| `talk_idle_seconds` | `3` | Silence before the speaker is released |
| `doors` | `1` | Door lock tiles to expose (`0` hides them) |
| `door_relock_seconds` | `5` | When the lock tile returns to "locked" |
| `call_poll_interval` | `1` | Seconds between ring checks |
| `http_port` / `rtsp_port` / `sdk_port` | `80` / `554` / `8000` | Door station ports |
| `homekit_port` | `51828` | TCP port of the HomeKit server |
| `homekit_bind` | all | Interface or IP to advertise on (try your LAN IP if pairing is flaky) |
| `mdns_advertiser` | `ciao` | `ciao` or `bonjour-hap` |
| `reset_homekit_pairing` | `false` | Forget pairings and create a new accessory on next start (turn off again afterwards) |
| `mqtt_host` / `mqtt_port` / `mqtt_username` / `mqtt_password` | Mosquitto add-on | Another MQTT broker |

## Troubleshooting

- **Accessory not shown when pairing.** HomeKit uses mDNS. Make sure your iPhone and the Home
  Assistant host are on the same network, or that your router reflects mDNS between them. Set
  `homekit_bind` to the host's LAN IP and restart.
- **"No Response" in the Home app.** Check the log for `door station OFFLINE` or snapshot errors.
- **No sound at the door.** After you tap the microphone in the Home app, the log should show
  `microphone on`, then `talk-back open (… ms)` when you speak, and on silence
  `talk-back closed (…): … s of speech, mic level … dBFS, gain … dB` followed by
  `voice talk stopped (N frames sent, …)`.
  - No `microphone on`: the Home app isn't sending audio (check the microphone button and iOS
    microphone permission for Home).
  - `microphone audio never reached the speech threshold`: the microphone is muted or very quiet.
  - Frames sent but nothing heard: raise the door station's talk volume (web UI →
    **Configuration → Video/Audio → Audio**, or the indoor station settings) and `talk_gain`.
  - If the door station was ringing, try another `ring_action`.
- **No device under MQTT.** The log says `no MQTT broker found` (install Mosquitto and the MQTT
  integration, then restart the add-on) or shows the MQTT connection error.
- **Authentication errors.** The door station locks the account after repeated failed logins;
  the add-on backs off for 60 s after an authentication failure.

## Limitations

- HomeKit Secure Video recording isn't implemented. Notifications and live view are.
- amd64 and aarch64 only (the Hikvision SDK isn't available for 32-bit ARM).
- One door station per add-on instance.
