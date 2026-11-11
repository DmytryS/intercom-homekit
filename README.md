# Intercom Doorbell for HomeKit: Home Assistant add-on

*Українською: [README](README.uk.md).*

Use your Hikvision video intercom door station as a native **Apple HomeKit video doorbell** with
**two-way audio**: ring notifications with a picture, live video with sound, talking to visitors from
the Home app, and opening the door. Home Assistant's built-in HomeKit Bridge can't forward a
camera's two-way audio, so this add-on pairs with Apple Home directly.

[![Add this repository to your Home Assistant](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FDmytryS%2Fintercom-homekit)

| Add-on | Description |
|---|---|
| [Intercom Doorbell for HomeKit](intercom_homekit) | Hikvision door station as an Apple HomeKit video doorbell with two-way audio, ring notifications and door lock |

## Features

- **Ring notifications** with a snapshot on iPhone, iPad, Apple Watch, Apple TV and HomePod chimes
- **Live video with sound** in the Home app (H.264 passed through, no transcoding)
- **Two-way audio**: tap the microphone in the Home app and talk through the door station speaker
- **Door lock tile** that opens the door relay, also shown under the live view
- **Home Assistant device** over MQTT: doorbell event for automations, snapshot, open door, hang up,
  volumes, and diagnostics such as which clients use the door station's few stream slots
- **Several door stations**, each its own HomeKit accessory and Home Assistant device
- **English and Ukrainian**: configuration, entity and tile names, pairing page and documentation

## Supported door stations

| Model | Firmware | Status |
|---|---|---|
| DS-KV6113-WPE1(B) | V2.2.53 | ✓ Tested: everything works |
| Other Hikvision villa door stations: DS-KV6xxx, DS-KV8xxx, DS-KD8003 (modular), DS-KB8xxx | | Expected to work, not confirmed yet |

The add-on talks to the door station directly over your network (ISAPI, RTSP and the Hikvision SDK).
It doesn't use Hik-Connect. A door station works fully if it supports:

| Feature | Needs |
|---|---|
| Ring detection | ISAPI `/ISAPI/VideoIntercom/callStatus` |
| Live video and sound | RTSP (H.264 is best, H.265 is transcoded automatically) |
| Talk-back | Hikvision SDK port (8000) |
| Open door | ISAPI `/ISAPI/AccessControl/RemoteControl/door/N` |

You don't need to check this by hand: at start-up the add-on logs a **compatibility check** with
what works on your model. **Have a model that isn't in the table?** Please
[send a device report](https://github.com/DmytryS/intercom-homekit/issues/new?template=device-report.yml),
whether it works or not. That's how this list grows.

Not supported: 32-bit ARM hosts (e.g. Raspberry Pi 3 running a 32-bit OS), since the Hikvision SDK only
exists for amd64 and aarch64. Cloud-only doorbells without local ISAPI/RTSP aren't supported either.

### Other brands

Hikvision is the first brand, not the only one the add-on is built for. Each brand is a small
**driver** behind a common interface. The HomeKit doorbell, Home Assistant entities, snapshots
and compatibility check are shared, so a new driver only has to talk to the door station: ring
detection, an RTSP stream, and optionally the door relay and two-way audio.
[CONTRIBUTING.md](CONTRIBUTING.md) explains how to add one, starting from a tested template.
If you'd like your intercom supported but can't write the driver, open an issue with its model and
any API documentation.

## Install

1. Click the **Add repository** button above. Or add it by hand: in Home Assistant go to
   **Settings → Apps** (called *Add-ons* before Home Assistant 2026.2), open the store,
   then **⋮ → Repositories**, and add `https://github.com/DmytryS/intercom-homekit`.
2. Install **Intercom Doorbell for HomeKit**, enter your door station's IP address and password
   on the **Configuration** tab, and start it.
3. Click **Open Web UI** and scan the QR code with the Home app.

Used the add-on when it was called "Hikvision Doorbell for HomeKit"? See
[moving from the old name](intercom_homekit/DOCS.md#moving-from-hikvision-doorbell-for-homekit).

The full guide, options and troubleshooting are in the add-on's
[documentation](intercom_homekit/DOCS.md), also shown on its **Documentation** tab.

## Development

Code layout and how to add a brand: [CONTRIBUTING.md](CONTRIBUTING.md).

```
cd intercom_homekit
npm install
npm run typecheck && npm test
# Against a real door station (credentials in ../.env, see .env.example):
node --env-file=../.env scripts/e2e-stream.ts   # drives a stream session like an iPhone would
```

To try local changes on Home Assistant, copy `intercom_homekit/` into the `/addons` share of your
Home Assistant host, remove the `image:` line from its `config.yaml` (so the Supervisor builds the
Dockerfile instead of downloading the published image), and install it from **Local add-ons**.

CI type-checks, tests, lints the add-on configuration and builds the image for both architectures on
every push. A version bump in `config.yaml` on `main` publishes the multi-arch image
`dmytrys/intercom-homekit` to Docker Hub.

## License

[MIT](LICENSE), except the Hikvision HCNetSDK (Linux glibc, amd64/aarch64) used for talk-back. It is
bundled in `intercom_homekit/vendor/hcnetsdk`, copied unchanged from
[pergolafabio/Hikvision-Addons](https://github.com/pergolafabio/Hikvision-Addons). The image build and
CI check every file against `SHA256SUMS`. The SDK is proprietary Hikvision software and isn't covered
by this repository's license. Thanks to that project for documenting the door station's SDK and ISAPI
behaviour.

This project isn't affiliated with or endorsed by Hikvision or Apple.
