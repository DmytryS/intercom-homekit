import dgram from 'node:dgram';
import type { Talkback } from '../hikvision/talkback.ts';
import { runFfmpeg, type FfmpegProcess } from '../ffmpeg.ts';
import type { Logger } from '../log.ts';
import { allocPortPair } from '../util/net.ts';
import { buildTalkbackArgs, talkbackSdp } from './ffmpegArgs.ts';

/** µ-law byte -> linear PCM magnitude (G.711). */
const MULAW_TO_LINEAR = new Int16Array(256).map((_, i) => {
  const u = ~i & 0xff;
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  return u & 0x80 ? 0x84 - t : t - 0x84;
});

/** RMS above this (≈ -46 dBFS) counts as someone talking. */
const VOICE_RMS = 160;

export function mulawRms(chunk: Buffer): number {
  if (chunk.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) {
    const s = MULAW_TO_LINEAR[chunk[i]];
    sum += s * s;
  }
  return Math.sqrt(sum / chunk.length);
}

export interface ReturnAudioOptions {
  talkback: Talkback;
  pt: number;
  sampleRate: number;
  gain: number;
  idleMs: number;
  log: Logger;
}

/**
 * The iPhone's microphone stream: decrypted RTP in, decoded by ffmpeg to G.711 µ-law,
 * then handed to the door station. Talk-back opens on the first non-silent audio and
 * closes after `idleMs` without voice, so merely watching the live view never grabs
 * the door station speaker (or cancels a ring).
 */
export class ReturnAudio {
  private readonly o: ReturnAudioOptions;
  private decoder?: FfmpegProcess;
  private port = 0;
  private readonly out = dgram.createSocket('udp4');
  private lastVoice = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private packets = 0;
  private opening = false;
  private retryAt = 0;

  constructor(o: ReturnAudioOptions) {
    this.o = o;
  }

  async start(): Promise<void> {
    this.port = await allocPortPair();
    const dec = runFfmpeg(buildTalkbackArgs(this.o.gain), 'talkback-decode', this.o.log);
    this.decoder = dec;
    dec.proc.stdin.end(talkbackSdp(this.port, this.o.pt, this.o.sampleRate));
    dec.proc.stdout.on('data', (chunk: Buffer) => this.onAudio(chunk));
    void dec.exited.then((code) => {
      if (!this.stopped) this.o.log.warn(`talk-back decoder exited (${code}): ${dec.tail()}`);
    });
    this.timer = setInterval(() => this.checkIdle(), 250);
  }

  /** Decrypted RTP packet from the controller. */
  push(rtp: Buffer): void {
    if (this.stopped || !this.port) return;
    if (this.packets++ === 0) this.o.log.debug('first microphone packet from controller');
    this.out.send(rtp, this.port, '127.0.0.1');
  }

  private onAudio(chunk: Buffer): void {
    const tb = this.o.talkback;
    if (mulawRms(chunk) >= VOICE_RMS) {
      this.lastVoice = Date.now();
      if (!tb.active && !this.opening && Date.now() >= this.retryAt) {
        this.opening = true;
        tb.start()
          .catch((err: Error) => {
            this.retryAt = Date.now() + 10000;
            this.o.log.warn(`talk-back failed to start: ${err.message}`);
          })
          .finally(() => {
            this.opening = false;
          });
      }
    }
    tb.write(chunk);
  }

  private checkIdle(): void {
    const tb = this.o.talkback;
    if (tb.active && Date.now() - this.lastVoice > this.o.idleMs) {
      this.o.log.info('microphone idle; closing talk-back');
      void tb.stop();
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.decoder?.stop();
    this.out.close();
    void this.o.talkback.stop();
  }
}
