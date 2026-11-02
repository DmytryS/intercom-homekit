import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { DigestAuth, parseAuthParams } from '../src/hikvision/digest.ts';
import { xmlValue } from '../src/hikvision/isapi.ts';
import { buildStreamArgs, opusFrameDuration, opusPacketDuration } from '../src/homekit/ffmpegArgs.ts';
import { randomPin } from '../src/homekit/identity.ts';
import { redact, addSecret } from '../src/log.ts';

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

test('config: defaults, encoding of credentials in the RTSP URL, validation', () => {
  const c = parseConfig({ host: '192.168.88.21', password: 'p@ss:w/rd' }, {});
  assert.equal(c.username, 'admin');
  assert.equal(c.rtspUrl, 'rtsp://admin:p%40ss%3Aw%2Frd@192.168.88.21:554/Streaming/Channels/101');
  assert.equal(c.ringAction, 'hangUp');
  assert.equal(c.callPollMs, 1000);
  assert.equal(c.doors, 1);
  assert.equal(c.mdnsAdvertiser, 'ciao');
  assert.equal(parseConfig({ host: 'h', password: 'p', rtsp_url: 'rtsp://go2rtc:8554/door' }, {}).rtspUrl, 'rtsp://go2rtc:8554/door');
  assert.equal(parseConfig({ host: 'h', password: 'p', max_streams: 99 }, {}).maxStreams, 4);
  assert.throws(() => parseConfig({ password: 'p' }, {}), /host/);
  assert.throws(() => parseConfig({ host: 'h' }, {}), /password/);
  assert.throws(() => parseConfig({ host: 'h', password: 'p', homekit_pin: '1234' }, {}), /homekit_pin/);
  assert.throws(() => parseConfig({ host: 'h', password: 'p', ring_action: 'explode' }, {}), /ring_action/);
});

test('digest: parses Hikvision challenge and computes RFC 2617 response', () => {
  const header = 'Digest qop="auth", realm="DS-4D1BDE8E", nonce="MGFmMDk0ZjEw", stale="false", opaque="", domain="::"';
  assert.deepEqual(parseAuthParams(header), { qop: 'auth', realm: 'DS-4D1BDE8E', nonce: 'MGFmMDk0ZjEw', stale: 'false', opaque: '', domain: '::' });
  const d = new DigestAuth('admin', 'secret');
  assert.equal(d.authorization('GET', '/x'), undefined);
  assert.equal(d.setChallenge('Basic realm="x"'), false);
  assert.equal(d.setChallenge(header), true);
  const auth = d.authorization('GET', '/ISAPI/System/deviceInfo')!;
  const p = parseAuthParams(auth);
  assert.equal(p.nc, '00000001');
  const ha1 = md5('admin:DS-4D1BDE8E:secret');
  const ha2 = md5('GET:/ISAPI/System/deviceInfo');
  assert.equal(p.response, md5(`${ha1}:MGFmMDk0ZjEw:00000001:${p.cnonce}:auth:${ha2}`));
  assert.equal(parseAuthParams(d.authorization('GET', '/y')!).nc, '00000002');
});

test('xmlValue extracts first element text', () => {
  assert.equal(xmlValue('<a><model>DS-KV6113</model><model>x</model></a>', 'model'), 'DS-KV6113');
  assert.equal(xmlValue('<id attr="1">7</id>', 'id'), '7');
  assert.equal(xmlValue('<a/>', 'model'), undefined);
});

test('stream args: copy mode, SRTP target, audio relay, IPv6', () => {
  const base = {
    rtspUrl: 'rtsp://u:p@cam/101',
    transcode: false,
    video: { pt: 99, ssrc: 0xdeadbeef, width: 1280, height: 720, fps: 30, maxBitrate: 299, mtu: 1378, profile: 2, level: 2 },
    target: { host: '192.168.1.5', port: 50000, srtpParams: 'KEY' },
    audio: { pt: 110, sampleRate: 16000, bitrate: 24, ptimeMs: 30, relayPort: 40000 },
  };
  const a = buildStreamArgs(base);
  assert.ok(a.includes('copy'));
  assert.equal(a[a.indexOf('-ssrc') + 1], String(0xdeadbeef | 0), 'ffmpeg wants a signed 32-bit ssrc');
  assert.ok(a.includes('srtp://192.168.1.5:50000?rtcpport=50000&pkt_size=1378'));
  assert.ok(a.includes('rtp://127.0.0.1:40000?pkt_size=1316'));
  assert.equal(a[a.indexOf('-frame_duration') + 1], '20', '30 ms is not a libopus frame size');
  const t = buildStreamArgs({ ...base, transcode: true, target: { ...base.target, host: 'fe80::1' } });
  assert.ok(t.includes('libx264') && t.includes('high') && t.includes('4.0'));
  assert.ok(t.some((x) => x.startsWith('srtp://[fe80::1]:50000')));
  assert.equal(opusFrameDuration(60), 60);
});

test('Opus TOC durations (RFC 6716)', () => {
  assert.equal(opusPacketDuration(Buffer.from([(16 + 3) << 3])), 0.02); // CELT 20 ms, 1 frame
  assert.equal(opusPacketDuration(Buffer.from([((16 + 3) << 3) | 3, 3])), 0.06); // 3 × 20 ms
  assert.equal(opusPacketDuration(Buffer.from([(9 << 3) | 1])), 0.04); // SILK WB 20 ms × 2
  assert.equal(opusPacketDuration(Buffer.alloc(0)), 0);
});

test('setup codes avoid HomeKit-forbidden patterns', () => {
  for (let i = 0; i < 200; i++) assert.match(randomPin(), /^\d{3}-\d{2}-\d{3}$/);
});

test('redact hides passwords and URL credentials', () => {
  addSecret('Sup3r$ecret');
  assert.equal(redact('pw=Sup3r$ecret'), 'pw=***');
  assert.equal(redact('rtsp://admin:xyz@1.2.3.4/x'), 'rtsp://admin:***@1.2.3.4/x');
});
