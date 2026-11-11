import { spawn } from 'node:child_process';
import { redact } from '../log.ts';

/** What the door station's RTSP stream carries. */
export interface StreamInfo {
  video?: { codec: string; width?: number; height?: number };
  /** Undefined when the stream has no audio track (stream type "Video" on the door station). */
  audio?: { codec: string; sampleRate?: number };
}

const PROBE_TIMEOUT_MS = 10000;

export function probeArgs(rtspUrl: string): string[] {
  return [
    '-hide_banner', '-v', 'error',
    '-rtsp_transport', 'tcp', '-timeout', '5000000',
    '-show_entries', 'stream=codec_type,codec_name,width,height,sample_rate',
    '-of', 'json',
    rtspUrl,
  ];
}

/** Parse `ffprobe -of json -show_entries stream=…` output. */
export function parseProbe(json: string): StreamInfo {
  const streams = (JSON.parse(json) as { streams?: Record<string, unknown>[] }).streams ?? [];
  const num = (v: unknown) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
  const info: StreamInfo = {};
  for (const s of streams) {
    const codec = String(s.codec_name ?? 'unknown');
    if (s.codec_type === 'video' && !info.video) info.video = { codec, width: num(s.width), height: num(s.height) };
    if (s.codec_type === 'audio' && !info.audio) info.audio = { codec, sampleRate: num(s.sample_rate) };
  }
  return info;
}

/** Codecs and audio presence of the stream. Holds one of the door station's stream slots for about a second. */
export function probeStream(rtspUrl: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<StreamInfo> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.env.FFPROBE_PATH || 'ffprobe', probeArgs(rtspUrl), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.once('close', (code, signal) => {
      clearTimeout(timer);
      const detail = redact(err.trim().split('\n').slice(-2).join(' | '));
      if (signal) return reject(new Error(`no answer within ${timeoutMs / 1000} s`));
      if (code !== 0) return reject(new Error(detail || `ffprobe exited with ${code}`));
      try {
        const info = parseProbe(out);
        if (!info.video) return reject(new Error(`no video track${detail ? ` (${detail})` : ''}`));
        resolve(info);
      } catch {
        reject(new Error(`unreadable ffprobe output${detail ? ` (${detail})` : ''}`));
      }
    });
  });
}
