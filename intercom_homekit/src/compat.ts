/**
 * Compatibility check, run once per door station at start-up: the driver's own checks (ring
 * detection, talk-back…) plus the ones every door station gets (snapshots, video, audio). The log
 * shows what works on this model, and users can paste it into a device report.
 */
import type { Check, CheckStatus, DeviceInfo } from './intercom.ts';
import type { StreamInfo } from './media/streamProbe.ts';

export type { Check, CheckStatus } from './intercom.ts';

export const DEVICE_REPORT_URL = 'https://github.com/DmytryS/intercom-homekit/issues/new?template=device-report.yml';

export interface CompatReport {
  device: string;
  checks: Check[];
  /** Codecs of the stream, when it could be probed. */
  stream?: StreamInfo;
}

export interface CompatProbes {
  deviceInfo: () => Promise<DeviceInfo>;
  /** The driver's own checks (Intercom.checks). */
  driverChecks?: () => Promise<Check[]>;
  /** The door station's picture request, if the driver has one. */
  snapshot?: () => Promise<Buffer>;
  probeStream: () => Promise<StreamInfo>;
  /** Features the driver lacks, e.g. ["talk-back", "door"]: listed so the report is complete. */
  missing?: string[];
  /** Video → Transcode is on. */
  transcode: boolean;
  /** Stop early (the add-on is shutting down). */
  cancelled?: () => boolean;
}

const CODECS: Record<string, string> = {
  h264: 'H.264',
  hevc: 'H.265',
  mjpeg: 'MJPEG',
  pcm_mulaw: 'G.711 µ-law',
  pcm_alaw: 'G.711 A-law',
  adpcm_g726: 'G.726',
  adpcm_g726le: 'G.726',
  g722: 'G.722',
  aac: 'AAC',
  opus: 'Opus',
  mp2: 'MP2',
};
const codecName = (c: string) => CODECS[c] ?? c;
const message = (err: unknown) => (err as Error).message;

export function videoCheck(info: StreamInfo, transcode: boolean): Check {
  const v = info.video!;
  const size = v.width && v.height ? ` ${v.width}×${v.height}` : '';
  const desc = `${codecName(v.codec)}${size}`;
  if (v.codec === 'h264') return { name: 'video', status: 'ok', detail: `${desc}${transcode ? ', transcoded (Video → Transcode is on)' : ''}` };
  return {
    name: 'video',
    status: 'limited',
    detail:
      `${desc}: HomeKit needs H.264, so the add-on transcodes it (uses CPU). ` +
      "Set the door station's main stream to H.264 to avoid that.",
  };
}

export function audioCheck(info: StreamInfo): Check {
  const a = info.audio;
  if (!a) {
    return {
      name: 'audio',
      status: 'limited',
      detail: 'the stream has no audio track, so live view is silent. Set the stream type to "Video & Audio" on the door station.',
    };
  }
  const rate = a.sampleRate ? ` ${a.sampleRate / 1000} kHz` : '';
  return { name: 'audio', status: 'ok', detail: `${codecName(a.codec)}${rate}` };
}

export async function checkCompatibility(p: CompatProbes): Promise<CompatReport> {
  const info = await p.deviceInfo().catch((): DeviceInfo => ({}));
  const device = [info.model ?? 'unknown model', info.firmwareVersion && `firmware ${info.firmwareVersion}`].filter(Boolean).join(', ');
  const checks: Check[] = [];
  const report: CompatReport = { device, checks };
  const stop = () => p.cancelled?.() ?? false;

  // One at a time: door stations have few sessions and slow CPUs.
  if (p.driverChecks) {
    try {
      checks.push(...(await p.driverChecks()));
    } catch (err) {
      checks.push({ name: 'driver checks', status: 'failed', detail: message(err) });
    }
    if (stop()) return report;
  }

  if (p.snapshot) {
    try {
      const jpeg = await p.snapshot();
      checks.push({ name: 'snapshots', status: 'ok', detail: `picture request works (${Math.round(jpeg.length / 1024)} KB)` });
    } catch (err) {
      checks.push({ name: 'snapshots', status: 'limited', detail: `picture request failed (${message(err)}); frames from the video stream are used instead` });
    }
    if (stop()) return report;
  } else {
    checks.push({ name: 'snapshots', status: 'ok', detail: 'frames from the video stream' });
  }

  try {
    const stream = await p.probeStream();
    report.stream = stream;
    checks.push(videoCheck(stream, p.transcode), audioCheck(stream));
  } catch (err) {
    checks.push({
      name: 'video',
      status: 'failed',
      detail: `RTSP stream not readable (${message(err)}). "500 Internal Server Error" means no free stream slot.`,
    });
  }
  for (const feature of p.missing ?? []) {
    checks.push({ name: feature, status: 'limited', detail: 'not supported for this door station type yet' });
  }
  return report;
}

const MARKS: Record<CheckStatus, string> = { ok: '✓', limited: '!', failed: '✗' };

export function reportLines(r: CompatReport): { level: 'info' | 'warn'; msg: string }[] {
  const lines: { level: 'info' | 'warn'; msg: string }[] = [{ level: 'info', msg: `compatibility check: ${r.device}` }];
  for (const c of r.checks) lines.push({ level: c.status === 'ok' ? 'info' : 'warn', msg: `  ${MARKS[c.status]} ${c.name}: ${c.detail}` });
  lines.push({
    level: 'info',
    msg: `  Model not listed as tested in the documentation, or something fails? Please share this check: ${DEVICE_REPORT_URL}`,
  });
  return lines;
}
