# Intercom Doorbell for HomeKit

Turns a Hikvision video intercom door station into a native **Apple HomeKit video doorbell**, with
**two-way audio**. It's the one thing Home Assistant's own HomeKit Bridge can't do.

- Ring notifications with a picture on iPhone, iPad, Apple Watch, Apple TV and HomePod chimes
- Live video with sound in the Home app
- Talk to visitors: tap the microphone and your voice comes out of the door station speaker
- Open the door from the Home app (a lock tile, also shown under the live view)
- A Home Assistant device over MQTT: doorbell event, snapshot, open door button, volumes, diagnostics

**Supported door stations:** tested on the DS-KV6113-WPE1(B). Other Hikvision villa door stations
(DS-KV6xxx, DS-KV8xxx, DS-KD8003 modular, DS-KB8xxx) use the same interfaces and are expected to work,
but aren't confirmed yet. At start-up the add-on logs a compatibility check that shows what works
on your model. Please [share it](https://github.com/DmytryS/intercom-homekit/issues/new?template=device-report.yml).

**Requirements:** a 64-bit Home Assistant OS or Supervised install (amd64 or aarch64, e.g. a
Raspberry Pi 4/5, Home Assistant Green or an Intel/AMD PC). Your iPhone and Home Assistant must be on
the same network, or your router must forward mDNS between them. For the Home Assistant device,
also install the Mosquitto broker add-on and the MQTT integration (optional).

Open the **Documentation** tab for setup, options and troubleshooting.

**Українською:** налаштування, назви сутностей і сторінка підключення доступні українською (виберіть
**Система → Мова → uk**). [Документація українською](https://github.com/DmytryS/intercom-homekit/blob/main/intercom_homekit/DOCS.uk.md).
