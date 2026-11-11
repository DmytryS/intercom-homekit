import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeMulaw } from '../src/audio/voice.ts';
import { FRAME_BYTES, VoiceQueue } from '../src/drivers/hikvision/voiceQueue.ts';

const speech = (tag: number) => {
  const b = encodeMulaw(Float32Array.from({ length: FRAME_BYTES }, (_, i) => 0.3 * Math.sin(i / 3)));
  b[0] = tag; // identify frames
  return b;
};
const quiet = () => Buffer.alloc(FRAME_BYTES, 0xff);

test('voice queue: 60 ms prebuffer, steady output, tail flushed with padding', () => {
  const q = new VoiceQueue();
  q.push(speech(1), 0);
  assert.equal(q.next(20), undefined, 'waits for 60 ms of audio');
  q.push(speech(2), 20);
  q.push(speech(3), 40);
  assert.equal(q.next(40)?.[0], 1);
  assert.equal(q.next(60)?.[0], 2);
  assert.equal(q.next(80)?.[0], 3);
  assert.equal(q.next(100), undefined);
  // A half frame at the end of speech is played (padded with silence) once nothing more arrives.
  q.push(speech(4).subarray(0, 80), 100);
  assert.equal(q.next(120), undefined);
  const tail = q.next(200)!;
  assert.equal(tail.length, FRAME_BYTES);
  assert.equal(tail[0], 4);
  assert.equal(tail[FRAME_BYTES - 1], 0xff);
});

test('voice queue: catches up on latency by skipping quiet frames only', () => {
  const q = new VoiceQueue();
  // 0.4 s buffered while talk-back was opening: speech, a pause, speech.
  const frames = [speech(1), speech(2), quiet(), quiet(), quiet(), quiet(), quiet(), speech(3), speech(4), speech(5),
    speech(6), speech(7), speech(8), speech(9), speech(10), speech(11), speech(12), speech(13), speech(14), speech(15)];
  for (const f of frames) q.push(f, 0);
  const out: number[] = [];
  for (let t = 0; t < 20; t++) {
    const f = q.next(20 * t + 1000);
    if (f) out.push(f[0]);
  }
  assert.deepEqual(out.slice(0, 3), [1, 2, 3], 'the pause was skipped');
  assert.ok(!out.includes(0xff), 'no quiet frame played while behind');
  assert.equal(q.skippedFrames, 5);
  assert.deepEqual(out.filter((x) => x !== 0xff), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], 'no speech lost');
});

test('voice queue: hard cap drops the oldest audio beyond 800 ms', () => {
  const q = new VoiceQueue();
  for (let i = 0; i < 60; i++) q.push(speech(i), 0);
  assert.ok(q.queuedMs <= 800);
  assert.ok(q.droppedBytes > 0);
});

test('voice queue: counts underruns only while speech is flowing', () => {
  const q = new VoiceQueue();
  for (let i = 0; i < 3; i++) q.push(speech(i), 0);
  for (let t = 0; t < 3; t++) assert.ok(q.next(20 * t));
  assert.equal(q.next(60), undefined); // packet late
  assert.equal(q.underruns, 1);
  assert.equal(q.next(5000), undefined); // long silence: not an underrun
  assert.equal(q.underruns, 1);
});
