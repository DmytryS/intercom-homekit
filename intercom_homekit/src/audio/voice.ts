/**
 * Voice processing for talk-back: level measurement, automatic gain and G.711 µ-law encoding.
 * Samples are 32-bit floats in [-1, 1] at 8 kHz (the door station's talk-back format).
 */

const SILENCE_DB = -100;

/** 20·log10 of a linear amplitude, floored at -100 dBFS. */
export function toDb(amplitude: number): number {
  return amplitude > 1e-5 ? 20 * Math.log10(amplitude) : SILENCE_DB;
}

export function frameLevel(pcm: Float32Array): { rmsDb: number; peakDb: number } {
  if (pcm.length === 0) return { rmsDb: SILENCE_DB, peakDb: SILENCE_DB };
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const x = pcm[i];
    sum += x * x;
    const a = Math.abs(x);
    if (a > peak) peak = a;
  }
  return { rmsDb: toDb(Math.sqrt(sum / pcm.length)), peakDb: toDb(peak) };
}

/** ITU-T G.711 µ-law encoding of one 16-bit sample (matches ffmpeg's pcm_mulaw). */
export function linearToMulaw(sample: number): number {
  let s = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > 32635) s = 32635;
  s += 0x84;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  return ~(sign | (exponent << 4) | ((s >> (exponent + 3)) & 0x0f)) & 0xff;
}

const MULAW_DECODE = new Int16Array(256).map((_, i) => {
  const u = ~i & 0xff;
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  return u & 0x80 ? 0x84 - t : t - 0x84;
});

export function mulawToLinear(byte: number): number {
  return MULAW_DECODE[byte & 0xff];
}

/** RMS level of µ-law audio in dBFS. */
export function mulawLevelDb(frame: Uint8Array): number {
  if (frame.length === 0) return SILENCE_DB;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const x = MULAW_DECODE[frame[i]];
    sum += x * x;
  }
  return toDb(Math.sqrt(sum / frame.length) / 32768);
}

export function encodeMulaw(pcm: Float32Array): Buffer {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = linearToMulaw(pcm[i] * 32767);
  return out;
}

export interface LevelerOptions {
  /** Speech level to aim for, before `userGain` (dBFS RMS). */
  targetDb?: number;
  /** Frames quieter than this are not speech: they don't open talk-back or move the gain. */
  gateDb?: number;
  maxGainDb?: number;
  minGainDb?: number;
  /** Extra multiplier on top of the automatic gain (the `talk_gain` option). */
  userGain?: number;
}

export interface FrameResult {
  voiced: boolean;
  rmsDb: number;
  peakDb: number;
  /** Total gain applied to this frame, including `userGain`. */
  gainDb: number;
}

/**
 * Automatic gain control tuned for a phone microphone feeding a small outdoor speaker.
 * The Home app delivers speech anywhere from about -45 to -15 dBFS; the door station
 * needs it near full scale to be audible on the street. Gain adapts only on speech
 * frames (fast down, ~20 dB/s up), is ramped across each frame to avoid clicks, and is
 * capped so peaks never clip.
 */
export class VoiceLeveler {
  readonly targetDb: number;
  readonly gateDb: number;
  private readonly maxGainDb: number;
  private readonly minGainDb: number;
  private readonly userGain: number;
  private gainDb: number | undefined;
  private applied = 1;

  constructor(o: LevelerOptions = {}) {
    this.targetDb = o.targetDb ?? -16;
    this.gateDb = o.gateDb ?? -48;
    this.maxGainDb = o.maxGainDb ?? 30;
    this.minGainDb = o.minGainDb ?? -6;
    this.userGain = o.userGain ?? 1;
  }

  /** Processes a frame in place. */
  process(pcm: Float32Array): FrameResult {
    const { rmsDb, peakDb } = frameLevel(pcm);
    const voiced = rmsDb >= this.gateDb;
    if (voiced) {
      const want = Math.min(this.maxGainDb, Math.max(this.minGainDb, this.targetDb - rmsDb));
      const frameMs = (pcm.length / 8000) * 1000;
      if (this.gainDb === undefined) this.gainDb = want;
      else if (want < this.gainDb) this.gainDb += (want - this.gainDb) * Math.min(1, 0.5 * (frameMs / 20));
      else this.gainDb = Math.min(want, this.gainDb + 0.4 * (frameMs / 20));
    }
    // Never let a peak clip: cap the gain for the whole frame, including the ramp from the
    // previous frame's gain (a sudden shout after quiet speech would otherwise clip at once).
    const peak = 10 ** (peakDb / 20);
    const cap = peak > 0 ? 0.95 / peak : Infinity;
    const target = Math.min(10 ** ((this.gainDb ?? 0) / 20) * this.userGain, cap);
    const from = this.applied;
    const n = pcm.length;
    for (let i = 0; i < n; i++) {
      const y = pcm[i] * Math.min(cap, from + ((target - from) * (i + 1)) / n);
      pcm[i] = y > 1 ? 1 : y < -1 ? -1 : y;
    }
    this.applied = target;
    return { voiced, rmsDb, peakDb, gainDb: toDb(target) };
  }
}
