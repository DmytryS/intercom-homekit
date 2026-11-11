// Dev helper: drives a StreamSession like an iPhone would, against the real door station RTSP stream.
// Talk-back is replaced by a recorder, so nothing is played at the door.
// Usage: node --env-file=../.env scripts/e2e-stream.ts [seconds]
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { PrepareStreamRequest, StartStreamRequest } from 'hap-nodejs';
import { parseConfig } from '../src/config.ts';
import type { Talkback } from '../src/drivers/hikvision/talkback.ts';
import { StreamSession } from '../src/homekit/session.ts';
import { addSecret, setLogLevel } from '../src/log.ts';
import { SrtpSession, isRtcp } from '../src/rtp/srtp.ts';
import { allocPortPair, bindUdp } from '../src/util/net.ts';

setLogLevel((process.env.LOG_LEVEL as 'debug') || 'info');
addSecret(process.env.HIK_PASS);
const seconds = Number(process.argv[2]) || 8;
const config = parseConfig({ host: process.env.HIK_HOST, username: process.env.HIK_USER, password: process.env.HIK_PASS, talk_idle_seconds: 1 });

// --- Talk-back recorder ---------------------------------------------------
const talk = { starts: 0, stops: 0, bytes: 0, bytesBeforeStart: 0, active: false, acquired: 0 };
const fakeTalkback = {
  get active() { return talk.active; },
  acquire() { talk.acquired++; },
  release() { talk.acquired--; },
  async start() { if (!talk.active) { talk.starts++; talk.active = true; console.log(`[talk] START at +${since()}ms`); } },
  async stop() { if (talk.active) { talk.stops++; talk.active = false; console.log(`[talk] STOP at +${since()}ms`); } },
  write(b: Buffer) { if (talk.active) talk.bytes += b.length; else talk.bytesBeforeStart += b.length; },
} as unknown as Talkback;

// --- Fake controller --------------------------------------------------------
const vKey = randomBytes(16), vSalt = randomBytes(14), aKey = randomBytes(16), aSalt = randomBytes(14);
const videoPort = await allocPortPair();
// Proxy in front of the ffmpeg receiver so we can time NAL units: accessory -> proxyPort -> videoPort.
const proxy = await bindUdp('udp4', '127.0.0.1');
const nal = { first: 0, sps: 0, idr: 0 };
const vSrtpTap = { s: undefined as SrtpSession | undefined };
const audioSock = await bindUdp('udp4', '127.0.0.1');
const t0 = Date.now();
const since = () => Date.now() - t0;

let ended = '';
const prepareReq: PrepareStreamRequest = {
  sessionID: 'e2e-' + randomBytes(4).toString('hex'), sourceAddress: '127.0.0.1', targetAddress: '127.0.0.1', addressVersion: 'ipv4',
  video: { port: proxy.address().port, srtpCryptoSuite: 0 as never, srtp_key: vKey, srtp_salt: vSalt },
  audio: { port: audioSock.address().port, srtpCryptoSuite: 0 as never, srtp_key: aKey, srtp_salt: aSalt },
};
const { session, response } = await StreamSession.prepare(prepareReq, { config, talkback: fakeTalkback, media: () => undefined, onEnded: (_id, r) => { ended = r; } });
const accVideoPort = (response.video as { port: number }).port;
const accAudioPort = (response.audio as { port: number }).port;
console.log(`accessory ports: video ${accVideoPort}, audio ${accAudioPort}`);

vSrtpTap.s = new SrtpSession(vKey, vSalt);
proxy.on('message', (m) => {
  proxy.send(m, videoPort, '127.0.0.1');
  if (isRtcp(m)) return;
  const p = vSrtpTap.s!.unprotectRtp(m);
  if (!p) return;
  if (!nal.first) nal.first = since();
  const h = 12 + (p[0] & 0x0f) * 4;
  let type = p[h] & 0x1f;
  if (type === 28) type = p[h + 1] & 0x1f; // FU-A
  if (type === 24) type = p[h + 3] & 0x1f; // STAP-A (first NAL)
  if (type === 7 && !nal.sps) nal.sps = since();
  if (type === 5 && !nal.idr) nal.idr = since();
});
// Video receiver: ffmpeg decrypts + decodes, reports progress.
const vParams = Buffer.concat([vKey, vSalt]).toString('base64');
const sdp = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=e2e', 'c=IN IP4 127.0.0.1', 't=0 0', `m=video ${videoPort} RTP/SAVP 99`, 'a=rtpmap:99 H264/90000', `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${vParams}`, ''].join('\r\n');
const vrx = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe,udp,rtp,srtp,crypto', '-f', 'sdp', '-i', 'pipe:0', '-progress', 'pipe:1', '-f', 'null', '-']);
vrx.stdin.end(sdp);
let frames = 0, firstFrameAt = 0, vErr = '';
vrx.stdout.on('data', (d: Buffer) => { const m = /frame=(\d+)/g; let x; while ((x = m.exec(d.toString()))) { frames = Number(x[1]); if (frames > 0 && !firstFrameAt) firstFrameAt = since(); } });
vrx.stderr.on('data', (d: Buffer) => { vErr += d; });

// Audio receiver: check what the relay sends us.
const rxSrtp = new SrtpSession(aKey, aSalt);
const audio = { packets: 0, bad: 0, rtcp: 0, deltas: new Map<number, number>(), firstAt: 0, ssrcOk: true, ptOk: true };
let lastTs: number | undefined;
audioSock.on('message', (m) => {
  if (isRtcp(m)) { audio.rtcp++; return; }
  const p = rxSrtp.unprotectRtp(m);
  if (!p) { audio.bad++; return; }
  audio.packets++;
  if (!audio.firstAt) audio.firstAt = since();
  if ((p[1] & 0x7f) !== 110) audio.ptOk = false;
  if (p.readUInt32BE(8) !== (response.audio as { ssrc: number }).ssrc >>> 0) audio.ssrcOk = false;
  const ts = p.readUInt32BE(4);
  if (lastTs !== undefined) { const d = (ts - lastTs) >>> 0; audio.deltas.set(d, (audio.deltas.get(d) ?? 0) + 1); }
  lastTs = ts;
});

// RTCP keepalive towards the accessory, like iOS does.
const keepalive = setInterval(() => { const rr = Buffer.alloc(8); rr[0] = 0x80; rr[1] = 201; rr.writeUInt16BE(1, 2); audioSock.send(rr, accVideoPort, '127.0.0.1'); }, 500);

const startReq: StartStreamRequest = {
  sessionID: prepareReq.sessionID, type: 'start' as never,
  video: { codec: 0 as never, profile: 2 as never, level: 2 as never, packetizationMode: 0 as never, width: 1280, height: 720, fps: 30, pt: 99, ssrc: 1, max_bit_rate: 299, rtcp_interval: 0.5, mtu: 1378 },
  audio: { codec: 'OPUS' as never, channel: 1, bit_rate: 0, sample_rate: 16 as never, packet_time: 20, pt: 110, ssrc: 2, max_bit_rate: 24, rtcp_interval: 5, comfort_pt: 13, comfortNoiseEnabled: false },
};
await session.start(startReq);

// Microphone: 1.5 s silence, then a tone, Opus 16 kHz, re-stamped at 16 kHz and encrypted like iOS.
const micSrtp = new SrtpSession(aKey, aSalt);
const micRelay = await bindUdp('udp4', '127.0.0.1');
micRelay.on('message', (m) => {
  const p = Buffer.from(m);
  p.writeUInt32BE((p.readUInt32BE(4) / 3) >>> 0, 4);
  p.writeUInt32BE(0xabcdef01, 8);
  audioSock.send(micSrtp.protectRtp(p), accAudioPort, '127.0.0.1');
});
await new Promise((r) => setTimeout(r, 1000));
const micStart = since();
const mic = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-readrate_initial_burst', '0', '-f', 'lavfi', '-i', "aevalsrc='if(lt(t,1.5),0,0.2*sin(2*PI*300*t))':s=48000:d=3.5",
  '-c:a', 'libopus', '-ar', '16000', '-ac', '1', '-frame_duration', '20', '-payload_type', '110', '-f', 'rtp', `rtp://127.0.0.1:${micRelay.address().port}`]);
console.log(`[mic] silence 1.5s then tone 2s starting at +${micStart}ms (expect talk START ≈ +${micStart + 1500}ms, STOP ≈ +${micStart + 3500 + 1000}ms)`);

await new Promise((r) => setTimeout(r, seconds * 1000));
mic.kill();
clearInterval(keepalive);
session.stop('e2e done');
vrx.kill();
micRelay.close();
proxy.close();
audioSock.close();

const deltas = [...audio.deltas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d, n]) => `${d}×${n}`).join(', ');
console.log('\n=== RESULT ===');
console.log(`video: ${frames} frames decoded (receiver ffmpeg reported first at +${firstFrameAt}ms); first RTP +${nal.first}ms, first SPS +${nal.sps}ms, first IDR +${nal.idr}ms ${vErr ? `errors: ${vErr.slice(0, 300)}` : ''}`);
console.log(`audio→controller: ${audio.packets} packets (auth failures ${audio.bad}, SRTCP ${audio.rtcp}), first at +${audio.firstAt}ms, ts deltas ${deltas} (want 320 @16k/20ms), pt ok ${audio.ptOk}, ssrc ok ${audio.ssrcOk}`);
console.log(`talk-back: starts ${talk.starts}, stops ${talk.stops}, µ-law bytes while open ${talk.bytes} (≈${(talk.bytes / 8000).toFixed(1)} s), bytes before open ${talk.bytesBeforeStart}`);
console.log(`session ended by itself: ${ended || 'no'}`);
process.exit(0);
