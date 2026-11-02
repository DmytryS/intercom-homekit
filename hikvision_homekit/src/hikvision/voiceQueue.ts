import { mulawLevelDb } from '../audio/voice.ts';

export const FRAME_BYTES = 160; // 20 ms of 8 kHz G.711 — the frame size the door station plays cleanly
export const FRAME_MS = 20;

// Jitter buffer: the iPhone's packets arrive in bursts over Wi-Fi, but the door station plays
// whatever it gets immediately. Start (and restart after running dry) with 60 ms queued.
const PREBUFFER_BYTES = FRAME_BYTES * 3;
// End of speech: play out a short tail instead of waiting for the next burst.
const FLUSH_AFTER_MS = 60;
// Speech captured while talk-back was opening is queued, not thrown away; the latency it adds
// is won back by skipping quiet frames (pauses between words) whenever more than this is queued.
const CATCH_UP_BYTES = FRAME_BYTES * 5;
const QUIET_DB = -40;
const MAX_QUEUE_BYTES = FRAME_BYTES * 40; // hard latency cap (800 ms); drop older audio beyond it

/** Turns bursty µ-law audio into a steady one-frame-per-20-ms feed for the door station. */
export class VoiceQueue {
  private queue = Buffer.alloc(0);
  private buffering = true;
  private lastAudioAt = -Infinity;
  underruns = 0;
  skippedFrames = 0;
  droppedBytes = 0;

  push(data: Uint8Array, now: number): void {
    this.queue = Buffer.concat([this.queue, data]);
    this.lastAudioAt = now;
    if (this.queue.length > MAX_QUEUE_BYTES) {
      const drop = this.queue.length - CATCH_UP_BYTES;
      this.droppedBytes += drop;
      this.queue = this.queue.subarray(drop);
    }
  }

  /** Called every 20 ms; returns the frame to play now, if any. */
  next(now: number): Buffer | undefined {
    const idle = now - this.lastAudioAt > FLUSH_AFTER_MS;
    if (this.buffering && (this.queue.length >= PREBUFFER_BYTES || (this.queue.length > 0 && idle))) this.buffering = false;
    if (this.buffering) return undefined;
    if (this.queue.length > 0 && this.queue.length < FRAME_BYTES && idle) {
      this.queue = Buffer.concat([this.queue, Buffer.alloc(FRAME_BYTES - this.queue.length, 0xff)]); // pad the tail
    }
    if (this.queue.length < FRAME_BYTES) {
      if (this.queue.length === 0 && now - this.lastAudioAt < 200) this.underruns++; // ran dry mid-speech
      this.buffering = true;
      return undefined;
    }
    while (this.queue.length >= CATCH_UP_BYTES && mulawLevelDb(this.queue.subarray(0, FRAME_BYTES)) < QUIET_DB) {
      this.queue = this.queue.subarray(FRAME_BYTES);
      this.skippedFrames++;
    }
    const frame = this.queue.subarray(0, FRAME_BYTES);
    this.queue = this.queue.subarray(FRAME_BYTES);
    return frame;
  }

  get queuedMs(): number {
    return (this.queue.length / FRAME_BYTES) * FRAME_MS;
  }
}
