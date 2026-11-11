# Contributing

Device reports are the most useful contribution: they show which door stations work. Use the
[device report form](https://github.com/DmytryS/intercom-homekit/issues/new?template=device-report.yml)
and paste the compatibility check from the add-on log.

## Adding a door station brand

The add-on has a brand-neutral core (HomeKit doorbell, live video and audio, snapshots,
Home Assistant over MQTT, the compatibility check) and one **driver** per brand. A driver only
talks to the door station. Everything users see in the Home app and Home Assistant comes from the
core, so a new driver gets all of it.

```
intercom_homekit/src/
  intercom.ts             the driver contract: read this first
  drivers/index.ts        registry: `type` option → driver
  drivers/hikvision/      Hikvision: ISAPI over HTTP, call status polling, SDK for talk-back
  drivers/example/        a small, tested template driver for an imaginary HTTP API
  media/                  snapshots, frame grabs, stream probing (any RTSP source)
  homekit/  mqtt/         HomeKit accessory and Home Assistant device (brand-neutral)
```

### What the door station needs

| Feature | Driver must provide | Required? |
|---|---|---|
| Ring notifications | a `ring` event per button press (polling, an event stream, a webhook, SIP…) | yes |
| Live video and sound | an RTSP URL (H.264 is best; other codecs are transcoded) | yes |
| Online state | `online` and the `online` event | yes |
| Device info | `deviceInfo()`; the MAC or serial number names the Home Assistant device | yes |
| Door lock tile, Open door button | `openDoor(n)` | no |
| Two-way audio | `talkback`: receives G.711 µ-law 8 kHz, already levelled | no |
| Snapshots | `snapshot()`; without it, frames come from the RTSP stream | no |
| Hang up, Reject call, Restart, volume sliders, session sensors | `hangUp`, `rejectCall`, `reboot`, `volumes`/`setVolume`, `streamingStatus`/`onlineUsers` | no |
| Start-up compatibility check lines | `checks()` (for example ring detection, talk-back login) | no, but recommended |

If the door station only has a cloud API, or no RTSP, it can't be supported. If it has a stream
in another format, a [go2rtc](https://github.com/AlexxIT/go2rtc) restream plus the `rtsp_url`
option may cover video.

### Steps

1. Copy `src/drivers/example/` to `src/drivers/<brand>/` and rename `example`/`Example`. The
   `id` is what users put in the `type` option: lower case, and never change it later.
2. Replace the HTTP calls with your device's API. Keep these rules:
   - Emit `ring` once per press, and not for a ring already in progress at start-up.
   - Emit `online` on changes, and count a device that answers (even with an error) as online.
   - Mark wrong-credential errors with `authFailure = true` and back off: most door stations lock
     the account after a few failed logins, and the core never retries these errors.
   - Use the call states `idle`, `ringing` and `on_call` where they fit.
   - Run native vendor libraries in a child process (see `drivers/hikvision/talkback.ts`), so a
     crash in them can't take the add-on down.
3. Register the driver in `src/drivers/index.ts`.
4. In `config.yaml`, add the id to `type: list(hikvision|<brand>)?`. Add any driver-specific
   option to the doorbell schema as **optional** (`?`), and describe it in `translations/en.yaml`.
   Read it in your driver's `parseOptions`, and throw an `Error` with a readable message for bad
   values.
5. If the driver needs system packages or libraries, add them to the `Dockerfile`, and say in the
   PR which architectures they exist for.
6. Test:
   - `npm run typecheck && npm test`. Add a test against a fake device; the example driver's test
     in `test/drivers.test.ts` shows how.
   - On real hardware, run the add-on and check the compatibility check, a ring, live view,
     talk-back and the door.
7. Update the supported devices table in `README.md` and `intercom_homekit/DOCS.md`, and add a
   `CHANGELOG.md` entry.

Open a draft PR early if you're unsure about something: it's easier to discuss with code.

## Translations

The add-on speaks English and Ukrainian. Users see text in three places:

- **Configuration tab:** `intercom_homekit/translations/<code>.yaml`. Home Assistant picks it by each
  user's language. A test checks it has the same keys as `en.yaml`.
- **Entity names, HomeKit tiles, pairing page:** `intercom_homekit/src/i18n.ts`. The compiler checks
  that each language has every text.
- **Documentation:** `DOCS.md` and `README.md`, with `DOCS.uk.md` and `README.uk.md`. Home Assistant
  shows only `DOCS.md`, which links to the translation.

When you change a text, change it in every language (or say in the PR which one you couldn't).
Logs stay English, so they can be searched and shared in issues. To add a language, see the
comment at the top of `src/i18n.ts`.

## Development

```
cd intercom_homekit
npm install
npm run typecheck && npm test
```

Scripts in `intercom_homekit/scripts/` exercise a real Hikvision door station (credentials in
`../.env`, see `.env.example`).

## Releasing

1. Bump `version` in `intercom_homekit/config.yaml` and `intercom_homekit/package.json` (and run
   `npm install` there to update `package-lock.json`).
2. Add a `## <version>` section at the top of `intercom_homekit/CHANGELOG.md`.
3. Merge to `main`. CI builds and tests the image for amd64 and aarch64, publishes it to Docker
   Hub, then creates the GitHub release `v<version>`, with that changelog section as its notes.
   Home Assistant sees the new version as soon as `config.yaml` changes on `main`, but the image
   arrives a few minutes later, when CI finishes. An update started in between fails to download and works
   when retried.

CI fails on any push where the two versions differ or the changelog has no section for the
version, so a half-done bump can't be published.
