# Hikvision HomeKit add-ons for Home Assistant

| Add-on | Description |
|---|---|
| [Hikvision Doorbell for HomeKit](hikvision_homekit) | Hikvision door station as an Apple HomeKit video doorbell with two-way audio, ring notifications and door lock |

## Install

Add this repository in Home Assistant (**Settings → Add-ons → Add-on store → ⋮ → Repositories**),
or copy `hikvision_homekit/` into the `/addons` share of your Home Assistant host and install
it from **Local add-ons**.

## Development

```
cd hikvision_homekit
npm install
npm run typecheck && npm test
# Against a real door station (credentials in ../.env, see .env.example):
node --env-file=../.env scripts/e2e-stream.ts   # drives a stream session like an iPhone would
```

Talk-back depends on the Hikvision HCNetSDK (Linux glibc, amd64/aarch64). The Dockerfile
downloads it from [pergolafabio/Hikvision-Addons](https://github.com/pergolafabio/Hikvision-Addons)
at a pinned commit and verifies its checksum. Thanks to that project for documenting the
door station's SDK and ISAPI behaviour.
