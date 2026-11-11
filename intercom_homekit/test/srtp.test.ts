import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { SrtpSession, isRtcp, rtpHeaderLength } from '../src/rtp/srtp.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function bind(address = '127.0.0.1'): Promise<dgram.Socket> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, address, () => resolve(s));
  });
}

async function freePortPair(): Promise<number> {
  for (;;) {
    const a = await bind();
    const port = a.address().port;
    if (port % 2 === 0) {
      const b = dgram.createSocket('udp4');
      const ok = await new Promise<boolean>((r) => {
        b.once('error', () => r(false));
        b.bind(port + 1, '127.0.0.1', () => r(true));
      });
      a.close();
      if (ok) {
        b.close();
        return port;
      }
    } else a.close();
  }
}

test('key derivation matches RFC 3711 B.3 test vectors', () => {
  const key = Buffer.from('E1F97A0D3E018BE0D64FA32C06DE4139', 'hex');
  const salt = Buffer.from('0EC675AD498AFEEBB6960B3AABE6', 'hex');
  const s = new SrtpSession(key, salt) as unknown as { rtpKey: Buffer; rtpSalt: Buffer; rtpAuth: Buffer };
  assert.equal(s.rtpKey.toString('hex').toUpperCase(), 'C61E7A93744F39EE10734AFE3FF7A087');
  assert.equal(s.rtpSalt.toString('hex').toUpperCase(), '30CBBC08863D8C85D49DB34A9AE1');
  assert.equal(s.rtpAuth.toString('hex').toUpperCase(), 'CEBE321F6FF7716B6FD4AB49AF256A156D38BAA4');
});

test('protect/unprotect round trip incl. sequence rollover and tamper detection', () => {
  const key = randomBytes(16);
  const salt = randomBytes(14);
  const tx = new SrtpSession(key, salt);
  const rx = new SrtpSession(key, salt);
  for (let i = 0; i < 70000; i += 7) {
    const p = Buffer.alloc(12 + 40);
    p[0] = 0x80;
    p[1] = 110;
    p.writeUInt16BE((65000 + i) & 0xffff, 2);
    p.writeUInt32BE(i * 320, 4);
    p.writeUInt32BE(0x12345678, 8);
    p.fill(i & 0xff, 12);
    const enc = tx.protectRtp(p);
    assert.equal(enc.length, p.length + 10);
    assert.deepEqual(rx.unprotectRtp(enc), p);
  }
  const p = Buffer.alloc(30, 1);
  p[0] = 0x80;
  const enc = new SrtpSession(key, salt).protectRtp(p);
  enc[20] ^= 1;
  assert.equal(new SrtpSession(key, salt).unprotectRtp(enc), null);
});

test('RTP/RTCP helpers', () => {
  assert.equal(isRtcp(Buffer.from([0x80, 200])), true);
  assert.equal(isRtcp(Buffer.from([0x80, 0xe0])), false);
  assert.equal(isRtcp(Buffer.from([0x80, 110])), false);
  const ext = Buffer.alloc(24);
  ext[0] = 0x90; // X bit
  ext.writeUInt16BE(1, 14); // 1 word of extension
  assert.equal(rtpHeaderLength(ext), 20);
});

test('decrypts SRTP produced by ffmpeg', { skip: !hasFfmpeg }, async () => {
  const key = randomBytes(16);
  const salt = randomBytes(14);
  const sock = await bind();
  const srtp = new SrtpSession(key, salt);
  let ok = 0;
  let bad = 0;
  sock.on('message', (m) => {
    if (isRtcp(m)) return;
    const plain = srtp.unprotectRtp(m);
    if (plain) ok++;
    else bad++;
  });
  const params = Buffer.concat([key, salt]).toString('base64');
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-t', '1',
    '-c:a', 'libopus', '-ar', '16000', '-ac', '1', '-payload_type', '110', '-f', 'rtp',
    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80', '-srtp_out_params', params,
    `srtp://127.0.0.1:${sock.address().port}?pkt_size=1316`,
  ]);
  await new Promise((r) => ff.on('exit', r));
  await new Promise((r) => setTimeout(r, 100));
  sock.close();
  assert.equal(bad, 0);
  assert.ok(ok >= 40, `expected ≥40 packets, got ${ok}`);
});

test('ffmpeg decrypts SRTP produced by us', { skip: !hasFfmpeg }, async () => {
  const key = randomBytes(16);
  const salt = randomBytes(14);
  const params = Buffer.concat([key, salt]).toString('base64');
  const inPort = await freePortPair();
  const relay = await bind();
  const srtp = new SrtpSession(key, salt);
  const out = await bind();
  // ffmpeg A: plain Opus RTP -> our relay
  // ffmpeg B: SRTP receiver (SDP with crypto) -> decodes to PCM on stdout
  const sdp = [
    'v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=test', 'c=IN IP4 127.0.0.1', 't=0 0',
    `m=audio ${inPort} RTP/SAVP 110`, 'a=rtpmap:110 opus/48000/2',
    `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${params}`, '',
  ].join('\r\n');
  const rx = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'pipe,udp,rtp,srtp,crypto,file',
    '-f', 'sdp', '-i', 'pipe:0', '-t', '0.8', '-f', 's16le', '-ar', '8000', '-ac', '1', 'pipe:1',
  ]);
  let pcmBytes = 0;
  let stderr = '';
  rx.stdout.on('data', (d: Buffer) => (pcmBytes += d.length));
  rx.stderr.on('data', (d: Buffer) => (stderr += d));
  rx.stdin.end(sdp);
  await new Promise((r) => setTimeout(r, 500));
  relay.on('message', (m) => out.send(srtp.protectRtp(m), inPort, '127.0.0.1'));
  const tx = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-re', '-f', 'lavfi', '-i', 'sine=f=440:r=48000', '-t', '2',
    '-c:a', 'libopus', '-ar', '48000', '-ac', '1', '-payload_type', '110', '-f', 'rtp',
    `rtp://127.0.0.1:${relay.address().port}`,
  ]);
  await new Promise((r) => rx.on('exit', r));
  tx.kill();
  relay.close();
  out.close();
  assert.equal(stderr.includes('auth') || stderr.includes('HMAC'), false, stderr);
  assert.ok(pcmBytes > 8000, `expected decoded audio, got ${pcmBytes} bytes; ${stderr}`);
});
