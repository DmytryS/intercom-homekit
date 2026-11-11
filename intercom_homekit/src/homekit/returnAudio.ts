import { OpusDecoder } from 'opus-decoder';
import type { Talkback } from '../intercom.ts';
import type { Logger } from '../log.ts';
import { rtpHeaderLength } from '../rtp/srtp.ts';
import { VoiceLeveler, encodeMulaw } from '../audio/voice.ts';

/** RTP payload without header, CSRCs, extension and padding. */
export function rtpPayload(rtp: Buffer): Buffer {
  const hl = rtpHeaderLength(rtp);
  let end = rtp.length;
  if (rtp[0] & 0x20 && end > hl) end -= rtp[end - 1];
  return end > hl ? rtp.subarray(hl, end) : Buffer.alloc(0);
}

export interface ReturnAudioOptions {
  talkback: Talkback;
  /** `talk_gain`: loudness multiplier on top of the automatic level control. */
  gain: number;
  idleMs: number;
  log: Logger;
}

interface TalkStats {
  voicedFrames: number;
  voicedMs: number;
  levelSum: number;
  peakDb: number;
  gainDb: number;
}

/**
 * The iPhone's microphone: decrypted Opus RTP in, decoded in-process (libopus/WASM) straight
 * to 8 kHz, levelled, encoded as G.711 µ-law and handed to the door station.
 *
 * The Home app only sends audio while the microphone button is on, so there can be minutes
 * without a packet; nothing here times out. Talk-back opens on the first speech and closes
 * after `idleMs` without it, so merely watching never grabs the door station speaker (or
 * cancels a ring).
 */
export class ReturnAudio {
  private readonly o: ReturnAudioOptions;
  private readonly leveler: VoiceLeveler;
  private decoder?: OpusDecoder<8000>;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private opening = false;
  private retryAt = 0;
  private lastVoice = 0;
  private lastPacketAt = 0;
  private packets = 0;
  private decodeErrors = 0;
  private loudestDb = -100;
  private talks = 0;
  private stats?: TalkStats;

  constructor(o: ReturnAudioOptions) {
    this.o = o;
    this.leveler = new VoiceLeveler({ userGain: o.gain });
  }

  async start(): Promise<void> {
    const decoder = new OpusDecoder({ channels: 1, sampleRate: 8000 });
    await decoder.ready;
    if (this.stopped) {
      decoder.free();
      return;
    }
    this.decoder = decoder;
    this.timer = setInterval(() => this.checkIdle(), 250);
  }

  /** Decrypted RTP packet from the controller. */
  push(rtp: Buffer): void {
    if (this.stopped || !this.decoder) return;
    const now = Date.now();
    if (now - this.lastPacketAt > 2000) {
      this.o.log.info(this.packets === 0 ? 'microphone on (receiving audio from the Home app)' : 'microphone on again');
    }
    this.lastPacketAt = now;
    this.packets++;
    const payload = rtpPayload(rtp);
    if (payload.length === 0) return;
    const out = this.decoder.decodeFrame(payload);
    if (out.errors.length > 0 && this.decodeErrors++ % 100 === 0) {
      this.o.log.warn(`microphone audio decode error: ${out.errors[0].message}`);
    }
    const pcm = out.channelData[0];
    if (!pcm || out.samplesDecoded === 0) return;
    this.onAudio(pcm.subarray(0, out.samplesDecoded), now);
  }

  private onAudio(pcm: Float32Array, now: number): void {
    const tb = this.o.talkback;
    const r = this.leveler.process(pcm);
    if (r.rmsDb > this.loudestDb) this.loudestDb = r.rmsDb;
    if (r.voiced) {
      this.lastVoice = now;
      if (!tb.active && !this.opening && now >= this.retryAt) this.open();
    }
    const s = this.stats;
    if (s && (tb.active || this.opening)) {
      if (r.voiced) {
        s.voicedFrames++;
        s.voicedMs += (pcm.length / 8000) * 1000;
        s.levelSum += r.rmsDb;
        s.peakDb = Math.max(s.peakDb, r.peakDb);
        s.gainDb = r.gainDb;
      }
    }
    tb.write(encodeMulaw(pcm));
  }

  private open(): void {
    this.opening = true;
    this.talks++;
    this.stats = { voicedFrames: 0, voicedMs: 0, levelSum: 0, peakDb: -100, gainDb: 0 };
    this.o.talkback
      .start()
      .catch((err: Error) => {
        this.retryAt = Date.now() + 10000;
        this.stats = undefined;
        this.o.log.warn(`talk-back failed to start: ${err.message}`);
      })
      .finally(() => {
        this.opening = false;
      });
  }

  private summary(reason: string): void {
    const s = this.stats;
    this.stats = undefined;
    if (!s) return;
    const level = s.voicedFrames > 0 ? (s.levelSum / s.voicedFrames).toFixed(0) : '–';
    this.o.log.info(
      `talk-back closed (${reason}): ${(s.voicedMs / 1000).toFixed(1)} s of speech, ` +
        `mic level ${level} dBFS (peak ${s.peakDb.toFixed(0)}), gain ${s.gainDb >= 0 ? '+' : ''}${s.gainDb.toFixed(0)} dB`,
    );
  }

  private checkIdle(): void {
    const tb = this.o.talkback;
    if (tb.active && Date.now() - this.lastVoice > this.o.idleMs) {
      this.summary('microphone idle');
      void tb.stop();
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.o.talkback.active || this.opening) this.summary('stream ended');
    if (this.packets > 0 && this.talks === 0) {
      this.o.log.info(
        `microphone audio never reached the speech threshold (loudest ${this.loudestDb.toFixed(0)} dBFS, ` +
          `threshold ${this.leveler.gateDb} dBFS)`,
      );
    }
    this.decoder?.free();
    this.decoder = undefined;
    void this.o.talkback.stop();
  }
}
