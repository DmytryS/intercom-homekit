import { runFfmpeg } from '../ffmpeg.ts';
import type { Logger } from '../log.ts';

/** Well inside the 17 s after which hap-nodejs gives up on a snapshot. */
const GRAB_TIMEOUT_MS = 8000;

export function frameGrabArgs(rtspUrl: string): string[] {
  return [
    '-hide_banner', '-nostats', '-nostdin', '-loglevel', 'level+warning',
    '-rtsp_transport', 'tcp', '-timeout', '5000000',
    '-i', rtspUrl,
    // Not -skip_frame nokey: it takes 5.4 s instead of 1.45 s on a DS-KV6113, and the first
    // decoded frame is already clean.
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-frames:v', '1', '-q:v', '3', '-f', 'mjpeg', 'pipe:1',
  ];
}

/** One JPEG from the video stream. Holds one of the door station's stream slots while it runs. */
export async function grabFrame(rtspUrl: string, log: Logger, timeoutMs = GRAB_TIMEOUT_MS): Promise<Buffer> {
  const ff = runFfmpeg(frameGrabArgs(rtspUrl), 'snapshot', log);
  const chunks: Buffer[] = [];
  ff.proc.stdout.on('data', (c: Buffer) => chunks.push(c));
  // 'close', not ff.exited: 'exit' can fire before stdout has been read to the end.
  const closed = new Promise<void>((resolve) => ff.proc.once('close', () => resolve()));
  const timer = setTimeout(() => ff.stop(), timeoutMs);
  const [code] = await Promise.all([ff.exited, closed]);
  clearTimeout(timer);
  const jpeg = Buffer.concat(chunks);
  if (code !== 0 || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error(`frame grab failed (ffmpeg exit ${code}, ${jpeg.length} bytes): ${ff.tail() || 'no output'}`);
  }
  return jpeg;
}
