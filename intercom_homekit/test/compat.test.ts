import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { checkCompatibility, reportLines, type CompatProbes } from '../src/compat.ts';
import { CallMonitor } from '../src/drivers/hikvision/callMonitor.ts';
import { IsapiAuthError, IsapiError } from '../src/drivers/hikvision/isapi.ts';
import { parseProbe, probeStream } from '../src/media/streamProbe.ts';
import { buildStreamArgs } from '../src/homekit/ffmpegArgs.ts';
import type { Logger } from '../src/log.ts';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function recorder() {
  const warnings: string[] = [];
  const log: Logger = { ...quiet, warn: (m) => void warnings.push(m) };
  return { log, warnings };
}

describe('CallMonitor', () => {
  it('emits a ring when the call status changes to ring', async () => {
    const states = ['idle', 'idle', 'ring', 'ring', 'idle'];
    const m = new CallMonitor({ callStatus: async () => states.shift() ?? 'idle' }, 2, quiet);
    let rings = 0;
    m.on('ring', () => rings++);
    m.start();
    await wait(60);
    m.stop();
    assert.equal(rings, 1);
    assert.equal(m.online, true);
  });

  it('stays online when the door station has no call status, and says rings are not detected', async () => {
    const { log, warnings } = recorder();
    let polls = 0;
    const m = new CallMonitor(
      {
        callStatus: async () => {
          polls++;
          throw new IsapiError('HTTP 404', 404);
        },
      },
      2,
      log,
      { unsupportedAfter: 3, unsupportedPollMs: 60000 },
    );
    m.start();
    await wait(60);
    m.stop();
    assert.equal(m.online, true, 'it answers, so it is reachable');
    assert.equal(m.ringDetection, false);
    assert.equal(polls, 3, 'then polls slowly');
    assert.ok(warnings.some((w) => w.includes("doesn't report its call status")));
  });

  it('goes offline when the door station does not answer, but not on auth errors alone', async () => {
    const m = new CallMonitor({ callStatus: async () => Promise.reject(new IsapiError('timed out')) }, 2, quiet);
    m.start();
    await wait(80);
    m.stop();
    assert.equal(m.online, false);
    assert.equal(m.ringDetection, true, 'no answer says nothing about support');

    const a = new CallMonitor({ callStatus: async () => Promise.reject(new IsapiAuthError('locked')) }, 2, recorder().log);
    a.start();
    await wait(20);
    a.stop();
    assert.equal(a.ringDetection, true);
  });
});

describe('stream probe', () => {
  it('parses codecs and notices a missing audio track', () => {
    const both = parseProbe(
      JSON.stringify({
        streams: [
          { codec_name: 'h264', codec_type: 'video', width: 1920, height: 1080 },
          { codec_name: 'pcm_mulaw', codec_type: 'audio', sample_rate: '8000' },
        ],
      }),
    );
    assert.deepEqual(both, { video: { codec: 'h264', width: 1920, height: 1080 }, audio: { codec: 'pcm_mulaw', sampleRate: 8000 } });
    assert.deepEqual(parseProbe('{"streams":[{"codec_name":"hevc","codec_type":"video"}]}'), {
      video: { codec: 'hevc', width: undefined, height: undefined },
    });
  });

  const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

  it('a stream without audio gives video-only ffmpeg arguments that ffmpeg accepts', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'probe-'));
    try {
      const file = join(dir, 'video-only.mkv');
      const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '1', '-c:v', 'mpeg4', '-y', file]);
      assert.equal(made.status, 0, made.stderr.toString());
      const info = await probeStream(file);
      assert.equal(info.audio, undefined);
      assert.equal(info.video?.codec, 'mpeg4');

      const args = buildStreamArgs({
        rtspUrl: file,
        transcode: false,
        video: { pt: 99, ssrc: 1, width: 320, height: 240, fps: 25, maxBitrate: 300, mtu: 1378, profile: 0, level: 0 },
        target: { host: '127.0.0.1', port: 9, srtpParams: Buffer.alloc(30, 7).toString('base64') },
      }).filter((a) => !['-rtsp_transport', 'tcp', '-timeout', '10000000'].includes(a));
      assert.ok(!args.includes('0:a:0'), 'no audio output for a stream without audio');
      const run = spawnSync('ffmpeg', args, { timeout: 20000 });
      assert.equal(run.status, 0, run.stderr.toString());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('compatibility check', () => {
  const working: CompatProbes = {
    deviceInfo: async () => ({ model: 'DS-KV6113-WPE1(B)', firmwareVersion: 'V2.2.53' }),
    driverChecks: async () => [
      { name: 'ring detection', status: 'ok', detail: 'call status works ("idle")' },
      { name: 'talk-back', status: 'ok', detail: 'Hikvision SDK login works' },
    ],
    snapshot: async () => Buffer.alloc(2048),
    probeStream: async () => ({ video: { codec: 'h264', width: 1920, height: 1080 }, audio: { codec: 'pcm_mulaw', sampleRate: 8000 } }),
    transcode: false,
  };

  it('reports a fully working door station', async () => {
    const r = await checkCompatibility(working);
    assert.equal(r.device, 'DS-KV6113-WPE1(B), firmware V2.2.53');
    assert.deepEqual(
      r.checks.map((c) => [c.name, c.status]),
      [['ring detection', 'ok'], ['talk-back', 'ok'], ['snapshots', 'ok'], ['video', 'ok'], ['audio', 'ok']],
    );
    const lines = reportLines(r);
    assert.ok(lines.every((l) => l.level === 'info'));
    assert.match(lines.at(-1)!.msg, /issues\/new\?template=device-report\.yml/);
  });

  it('explains what is missing on other models, and keeps going after failures', async () => {
    const r = await checkCompatibility({
      ...working,
      deviceInfo: async () => Promise.reject(new Error('offline')),
      driverChecks: async () => Promise.reject(new Error('driver bug')),
      snapshot: async () => Promise.reject(new IsapiError('HTTP 400: deviceError', 400)),
      probeStream: async () => ({ video: { codec: 'hevc', width: 2560, height: 1440 } }),
    });
    assert.equal(r.device, 'unknown model');
    const byName = Object.fromEntries(r.checks.map((c) => [c.name, c]));
    assert.equal(byName['driver checks'].status, 'failed');
    assert.equal(byName.snapshots.status, 'limited');
    assert.match(byName.video.detail, /H\.265 2560×1440: HomeKit needs H\.264/);
    assert.match(byName.audio.detail, /no audio track/);
    assert.ok(reportLines(r).some((l) => l.level === 'warn'));
  });

  it('covers drivers without a picture request, driver checks or talk-back', async () => {
    const r = await checkCompatibility({ ...working, driverChecks: undefined, snapshot: undefined, missing: ['talk-back'] });
    assert.deepEqual(
      r.checks.map((c) => [c.name, c.status]),
      [['snapshots', 'ok'], ['video', 'ok'], ['audio', 'ok'], ['talk-back', 'limited']],
    );
  });
});
