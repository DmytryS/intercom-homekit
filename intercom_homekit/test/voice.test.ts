import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { test } from 'node:test';
import { encodeMulaw, frameLevel, linearToMulaw, mulawLevelDb, mulawToLinear, VoiceLeveler } from '../src/audio/voice.ts';
import type { Talkback } from '../src/intercom.ts';
import { ReturnAudio, rtpPayload } from '../src/homekit/returnAudio.ts';
import { createLogger } from '../src/log.ts';

const sine = (n: number, amp: number, hz = 440, offset = 0) =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * (i + offset)) / 8000));
const dbToAmp = (db: number) => 10 ** (db / 20);

test('G.711 µ-law: silence, full scale and round trip within one quantisation step', () => {
  assert.equal(linearToMulaw(0), 0xff);
  assert.equal(mulawLevelDb(Buffer.alloc(160, 0xff)), -100);
  assert.ok(mulawLevelDb(Buffer.alloc(160, 0x80)) > -0.5); // ±32124 = -0.18 dBFS
  for (let x = -32768; x <= 32767; x += 37) {
    const back = mulawToLinear(linearToMulaw(x));
    assert.ok(Math.abs(back - x) <= Math.max(16, Math.abs(x) / 16), `${x} -> ${back}`);
  }
  const level = mulawLevelDb(encodeMulaw(sine(800, dbToAmp(-20) * Math.SQRT2)));
  assert.ok(Math.abs(level - -20) < 0.5, `sine at -20 dBFS RMS measured ${level}`);
});

test('voice leveler: lifts quiet speech to the target, never clips, ignores noise', () => {
  const lv = new VoiceLeveler({ userGain: 1 });
  // Background noise below the gate: not speech, no gain change.
  const noise = sine(160, dbToAmp(-60));
  assert.equal(lv.process(noise).voiced, false);
  // Quiet speech at -40 dBFS RMS -> about -16 dBFS after the leveler settles.
  let out = 0;
  for (let f = 0; f < 100; f++) {
    const frame = sine(160, dbToAmp(-40) * Math.SQRT2, 440, f * 160);
    const r = lv.process(frame);
    assert.ok(r.voiced);
    out = frameLevel(frame).rmsDb;
    assert.ok(frameLevel(frame).peakDb <= 0);
  }
  assert.ok(Math.abs(out - -16) < 1, `settled at ${out} dBFS`);
  // A sudden loud burst (gain was +24 dB) is pulled down at once, with no sample clipped.
  const loud = sine(160, 0.9, 440);
  const r = lv.process(loud);
  assert.ok(r.gainDb < 1, `gain ${r.gainDb}`);
  assert.ok(Math.max(...loud.map(Math.abs)) <= 0.951, 'no clipping during the gain ramp');
  // talk_gain scales the target.
  const lv2 = new VoiceLeveler({ userGain: 2 });
  for (let f = 0; f < 100; f++) {
    const frame = sine(160, dbToAmp(-40) * Math.SQRT2, 440, f * 160);
    lv2.process(frame);
    out = frameLevel(frame).rmsDb;
  }
  assert.ok(Math.abs(out - -10) < 1, `talk_gain 2 settled at ${out} dBFS`);
});

test('rtpPayload strips header, CSRCs, extension and padding', () => {
  const pkt = Buffer.concat([
    Buffer.from([0xb1, 110, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1]), // V=2 P=1 X=1 CC=1
    Buffer.alloc(4), // CSRC
    Buffer.from([0xbe, 0xde, 0, 1, 1, 2, 3, 4]), // one-word extension
    Buffer.from([7, 8, 9]),
    Buffer.from([0, 0, 3]), // 3 bytes of padding
  ]);
  assert.deepEqual([...rtpPayload(pkt)], [7, 8, 9]);
  assert.equal(rtpPayload(Buffer.alloc(12)).length, 0);
});

test('return audio: real Opus RTP from the Home app path opens talk-back at the right level', async () => {
  const written: Buffer[] = [];
  let starts = 0;
  let active = false;
  const talkback = {
    get active() { return active; },
    async start() { starts++; active = true; },
    async stop() { active = false; },
    write(b: Buffer) { if (active) written.push(b); },
  } as unknown as Talkback;
  const ra = new ReturnAudio({ talkback, gain: 1, idleMs: 3000, log: createLogger('test') });
  await ra.start();

  // 0.5 s of silence then 2 s of a quiet (-36 dBFS RMS) tone, as the Home app would send it:
  // 24 kHz mono Opus, 20 ms packets. Mic silence must not open talk-back.
  const sock = dgram.createSocket('udp4');
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  let packets = 0;
  sock.on('message', (m) => { packets++; ra.push(m); });
  const amp = (dbToAmp(-36) * Math.SQRT2).toFixed(4);
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `aevalsrc='if(lt(t,0.5),0,${amp}*sin(2*PI*300*t))':s=48000:d=2.5`,
    '-c:a', 'libopus', '-ar', '24000', '-ac', '1', '-application', 'voip', '-frame_duration', '20', '-b:a', '24k',
    '-payload_type', '110', '-f', 'rtp', `rtp://127.0.0.1:${sock.address().port}`]);
  await new Promise((r) => ff.on('exit', r));
  await new Promise((r) => setTimeout(r, 300));
  sock.close();
  ra.stop();

  assert.ok(packets >= 120, `packets ${packets}`);
  assert.equal(starts, 1);
  const audio = Buffer.concat(written);
  assert.ok(audio.length >= 8000 * 1.5, `${audio.length} bytes of µ-law`);
  const tail = audio.subarray(audio.length - 8000 * 0.5); // settled part of the tone
  const level = mulawLevelDb(tail);
  assert.ok(level > -20 && level < -12, `talk-back level ${level.toFixed(1)} dBFS (target -16)`);
});
