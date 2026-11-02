# Changelog

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
