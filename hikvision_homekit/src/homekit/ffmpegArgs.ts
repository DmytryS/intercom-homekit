/** Pure builders for the ffmpeg command lines used by a HomeKit stream session. */

export interface VideoParams {
  pt: number;
  ssrc: number;
  width: number;
  height: number;
  fps: number;
  maxBitrate: number; // kbps
  mtu: number;
  profile: number; // HAP H264Profile: 0 baseline, 1 main, 2 high
  level: number; // HAP H264Level: 0 3.1, 1 3.2, 2 4.0
}

export interface StreamArgsOptions {
  rtspUrl: string;
  transcode: boolean;
  video: VideoParams;
  target: { host: string; port: number; srtpParams: string };
  audio?: { pt: number; sampleRate: number; bitrate: number; ptimeMs: number; relayPort: number };
  verbose?: boolean;
}

const PROFILES = ['baseline', 'main', 'high'];
const LEVELS = ['3.1', '3.2', '4.0'];

function hostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

/** libopus only supports these frame durations; HomeKit asks for 20/30/40/60 ms. */
export function opusFrameDuration(ptimeMs: number): number {
  return [20, 40, 60].includes(ptimeMs) ? ptimeMs : 20;
}

/** Duration in seconds of an Opus packet, from its TOC byte (RFC 6716 §3.1); 0 if unparseable. */
export function opusPacketDuration(payload: Buffer): number {
  if (payload.length < 1) return 0;
  const toc = payload[0];
  const config = toc >> 3;
  let frameMs: number;
  if (config < 12) frameMs = [10, 20, 40, 60][config & 3];
  else if (config < 16) frameMs = [10, 20][config & 1];
  else frameMs = [2.5, 5, 10, 20][config & 3];
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? (payload.length > 1 ? payload[1] & 0x3f : 0) : 2;
  return (frames * frameMs) / 1000;
}

export function buildStreamArgs(o: StreamArgsOptions): string[] {
  const v = o.video;
  const args = [
    '-hide_banner', '-nostats', '-loglevel', o.verbose ? 'level+verbose' : 'level+warning',
    // Start fast: the RTSP SDP already carries codec parameters (sprop-parameter-sets, PCMU).
    '-fflags', '+genpts+discardcorrupt+nobuffer', '-flags', 'low_delay',
    '-probesize', '65536', '-analyzeduration', '500000',
    '-rtsp_transport', 'tcp', '-timeout', '10000000',
    '-i', o.rtspUrl,
    '-map', '0:v:0', '-an', '-sn', '-dn',
  ];
  if (o.transcode) {
    const gop = Math.max(1, Math.round(v.fps * 2));
    args.push(
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
      '-profile:v', PROFILES[v.profile] ?? 'main', '-level:v', LEVELS[v.level] ?? '3.1',
      '-vf', `scale=${v.width}:${v.height}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
      '-r', String(v.fps), '-g', String(gop), '-bf', '0',
      '-b:v', `${v.maxBitrate}k`, '-maxrate', `${v.maxBitrate}k`, '-bufsize', `${v.maxBitrate * 2}k`,
    );
  } else {
    // Hikvision sends H.264 Baseline already; pass it through untouched (lowest latency/CPU).
    args.push('-c:v', 'copy', '-bsf:v', 'dump_extra=freq=keyframe');
  }
  args.push(
    '-payload_type', String(v.pt), '-ssrc', String(v.ssrc | 0), '-f', 'rtp',
    '-srtp_out_suite', 'AES_CM_128_HMAC_SHA1_80', '-srtp_out_params', o.target.srtpParams,
    `srtp://${hostForUrl(o.target.host)}:${o.target.port}?rtcpport=${o.target.port}&pkt_size=${v.mtu}`,
  );
  if (o.audio) {
    const a = o.audio;
    args.push(
      '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-c:a', 'libopus', '-application', 'lowdelay', '-frame_duration', String(opusFrameDuration(a.ptimeMs)),
      '-ar', String(a.sampleRate), '-ac', '1', '-b:a', `${a.bitrate}k`,
      '-payload_type', String(a.pt), '-f', 'rtp',
      // Plain RTP to our local relay, which fixes timestamps for HomeKit and encrypts.
      `rtp://127.0.0.1:${a.relayPort}?pkt_size=1316`,
    );
  }
  return args;
}

/** SDP for decoding the controller's (iPhone's) Opus microphone stream, already decrypted by us. */
export function talkbackSdp(port: number, pt: number, sampleRate: number): string {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=HomeKit talk-back',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=audio ${port} RTP/AVP ${pt}`,
    // HomeKit stamps Opus RTP at the negotiated sample rate rather than RFC 7587's 48 kHz.
    `a=rtpmap:${pt} opus/${sampleRate}/2`,
    '',
  ].join('\r\n');
}

export function buildTalkbackArgs(gain: number): string[] {
  return [
    '-hide_banner', '-nostats', '-loglevel', 'level+warning',
    '-protocol_whitelist', 'pipe,udp,rtp,file',
    '-fflags', '+nobuffer', '-flags', 'low_delay', '-probesize', '32', '-analyzeduration', '0',
    '-f', 'sdp', '-i', 'pipe:0',
    '-af', `volume=${gain}`, '-ac', '1', '-ar', '8000', '-c:a', 'pcm_mulaw',
    '-flush_packets', '1', '-f', 'mulaw', 'pipe:1',
  ];
}
