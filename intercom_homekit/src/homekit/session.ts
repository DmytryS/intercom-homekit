import type dgram from 'node:dgram';
import { randomInt } from 'node:crypto';
import type { PrepareStreamRequest, PrepareStreamResponse, StartStreamRequest } from 'hap-nodejs';
import { CameraController } from 'hap-nodejs';
import type { Config } from '../config.ts';
import type { Talkback } from '../intercom.ts';
import type { StreamInfo } from '../media/streamProbe.ts';
import { runFfmpeg, type FfmpegProcess } from '../ffmpeg.ts';
import { createLogger, isDebug, type Logger } from '../log.ts';
import { SrtpSession, isRtcp, senderReport } from '../rtp/srtp.ts';
import { bindUdp } from '../util/net.ts';
import { buildStreamArgs, opusFrameDuration, opusPacketDuration } from './ffmpegArgs.ts';
import { ReturnAudio } from './returnAudio.ts';

/** Stop if the controller has sent nothing (RTP or RTCP) for this long. */
const CONTROLLER_TIMEOUT_MS = 30000;

export interface SessionDeps {
  config: Config;
  /** Undefined when the driver has no two-way audio: the microphone stream is then ignored. */
  talkback?: Talkback;
  /** The door station stream's codecs, once probed (undefined: assume H.264 with audio). */
  media: () => StreamInfo | undefined;
  /** Called when the session dies on its own (ffmpeg exit, controller gone). */
  onEnded: (sessionId: string, reason: string) => void;
}

/**
 * One live view from one Apple device.
 *
 * Video: ffmpeg copies the door station's H.264 and sends SRTP straight to the controller.
 * Audio out: ffmpeg encodes Opus as plain RTP to a local relay that rewrites the RTP
 *   timestamps to the negotiated sample-rate clock (HomeKit requirement; ffmpeg uses
 *   48 kHz for Opus) and encrypts from the port we announced (symmetric RTP).
 * Audio in: the controller's SRTP microphone stream arrives on that same port, is
 *   decrypted here and fed to ReturnAudio -> Talkback -> door station speaker.
 */
export class StreamSession {
  readonly id: string;
  private readonly deps: SessionDeps;
  private readonly log: Logger;
  private readonly target: string;
  private readonly videoPort: number;
  private readonly audioPort: number;
  private readonly videoSrtpParams: string;
  private readonly audioSrtp: SrtpSession;
  private readonly videoSocket: dgram.Socket;
  private readonly audioSocket: dgram.Socket;
  private readonly relaySocket: dgram.Socket;
  readonly videoSsrc = CameraController.generateSynchronisationSource();
  readonly audioSsrc = CameraController.generateSynchronisationSource();

  private ffmpeg?: FfmpegProcess;
  private returnAudio?: ReturnAudio;
  private watchdog?: NodeJS.Timeout;
  private rtcpTimer?: NodeJS.Timeout;
  private lastRx = Date.now();
  private stopped = false;
  private startedAt = 0;

  // Outgoing audio relay state
  private audioPt = 110;
  private outClock = 16000;
  private lastInTs?: number;
  private outTs = randomInt(0, 0x7fffffff);
  private outPackets = 0;
  private outOctets = 0;
  private lastSendAt = 0;
  private authFailures = 0;

  private constructor(
    request: PrepareStreamRequest,
    deps: SessionDeps,
    sockets: { video: dgram.Socket; audio: dgram.Socket; relay: dgram.Socket },
  ) {
    this.id = request.sessionID;
    this.deps = deps;
    this.log = createLogger(`stream ${request.sessionID.slice(0, 8)}`, deps.config.label);
    this.target = request.targetAddress;
    this.videoPort = request.video.port;
    this.audioPort = request.audio.port;
    this.videoSrtpParams = Buffer.concat([request.video.srtp_key, request.video.srtp_salt]).toString('base64');
    this.audioSrtp = new SrtpSession(request.audio.srtp_key, request.audio.srtp_salt);
    this.videoSocket = sockets.video;
    this.audioSocket = sockets.audio;
    this.relaySocket = sockets.relay;
  }

  static async prepare(request: PrepareStreamRequest, deps: SessionDeps): Promise<{ session: StreamSession; response: PrepareStreamResponse }> {
    const type = request.addressVersion === 'ipv6' ? 'udp6' : 'udp4';
    const [video, audio, relay] = await Promise.all([bindUdp(type), bindUdp(type), bindUdp('udp4', '127.0.0.1')]);
    const session = new StreamSession(request, deps, { video, audio, relay });
    session.listen();
    const response: PrepareStreamResponse = {
      video: { port: video.address().port, ssrc: session.videoSsrc, srtp_key: request.video.srtp_key, srtp_salt: request.video.srtp_salt },
      audio: { port: audio.address().port, ssrc: session.audioSsrc, srtp_key: request.audio.srtp_key, srtp_salt: request.audio.srtp_salt },
    };
    session.log.debug(`prepared for ${request.targetAddress} (video ${request.video.port}, audio ${request.audio.port})`);
    return { session, response };
  }

  private listen(): void {
    this.videoSocket.on('message', () => {
      this.lastRx = Date.now();
    });
    this.audioSocket.on('message', (msg) => {
      this.lastRx = Date.now();
      if (isRtcp(msg)) return;
      const rtp = this.audioSrtp.unprotectRtp(msg);
      if (!rtp) {
        if (this.authFailures++ % 100 === 0) this.log.warn('dropping controller audio packet that failed SRTP authentication');
        return;
      }
      this.returnAudio?.push(rtp);
    });
    this.relaySocket.on('message', (msg) => this.relayAudio(msg));
    for (const s of [this.videoSocket, this.audioSocket, this.relaySocket]) {
      s.on('error', (err) => this.log.debug(`socket error: ${err.message}`));
    }
  }

  async start(request: StartStreamRequest): Promise<void> {
    const { config } = this.deps;
    const v = request.video;
    const a = request.audio;
    this.startedAt = Date.now();
    this.audioPt = a.pt;
    this.outClock = a.sample_rate * 1000;
    const ptime = opusFrameDuration(a.packet_time);
    this.log.info(
      `start ${v.width}x${v.height}@${v.fps} ≤${v.max_bit_rate}kbps, audio ${a.codec} ${a.sample_rate}kHz ${ptime}ms → ${this.target}`,
    );
    if (a.codec !== 'OPUS') this.log.warn(`controller selected ${a.codec}; only Opus is supported`);

    // ffmpeg refuses an audio output when the stream has no audio track, and HomeKit only plays H.264.
    const media = this.deps.media();
    const hasAudio = !media || media.audio !== undefined;
    const transcode = config.videoTranscode || (media?.video !== undefined && media.video.codec !== 'h264');
    const args = buildStreamArgs({
      rtspUrl: config.rtspUrl,
      transcode,
      video: { pt: v.pt, ssrc: this.videoSsrc, width: v.width, height: v.height, fps: v.fps, maxBitrate: v.max_bit_rate, mtu: v.mtu, profile: v.profile, level: v.level },
      target: { host: this.target, port: this.videoPort, srtpParams: this.videoSrtpParams },
      audio: hasAudio
        ? { pt: a.pt, sampleRate: this.outClock, bitrate: Math.max(16, a.max_bit_rate || 24), ptimeMs: ptime, relayPort: this.relaySocket.address().port }
        : undefined,
      verbose: isDebug(),
    });
    const ff = runFfmpeg(args, 'stream', this.log);
    this.ffmpeg = ff;
    void ff.exited.then((code) => {
      if (this.stopped) return;
      const reason = `ffmpeg exited (${code}): ${ff.tail() || 'no output'}`;
      this.log.error(reason);
      this.deps.onEnded(this.id, reason);
    });

    const talkback = this.deps.talkback;
    if (talkback) {
      this.returnAudio = new ReturnAudio({ talkback, gain: config.talkGain, idleMs: config.talkIdleMs, log: this.log });
      talkback.acquire();
      await this.returnAudio.start();
    }

    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastRx > CONTROLLER_TIMEOUT_MS) {
        this.log.warn('controller stopped sending RTCP; ending stream');
        this.deps.onEnded(this.id, 'controller timeout');
      }
    }, 5000);
    this.rtcpTimer = setInterval(() => this.sendAudioReport(), Math.max(1000, (a.rtcp_interval || 2) * 1000));
  }

  /** Rewrite ffmpeg's Opus RTP for HomeKit and send it, encrypted, from the announced port. */
  private relayAudio(msg: Buffer): void {
    if (this.stopped || msg.length < 13 || isRtcp(msg)) return;
    const inTs = msg.readUInt32BE(4);
    const hl = 12 + (msg[0] & 0x0f) * 4;
    // Advance by the exact Opus packet duration (HomeKit expects precise sample-rate
    // increments; ffmpeg's own timestamps are 48 kHz and jitter by a few samples).
    let step = Math.round(opusPacketDuration(msg.subarray(hl)) * this.outClock);
    if (this.lastInTs !== undefined) {
      // Preserve real gaps (e.g. the RTSP source stalled) using ffmpeg's 48 kHz clock.
      const gap = Math.round(((inTs - this.lastInTs) >>> 0) / (48000 / this.outClock));
      if (step === 0 || (gap > step * 3 && gap < this.outClock * 10)) step = gap;
      this.outTs = (this.outTs + step) >>> 0;
    }
    this.lastInTs = inTs;
    const pkt = Buffer.from(msg);
    pkt[1] = (pkt[1] & 0x80) | (this.audioPt & 0x7f);
    pkt.writeUInt32BE(this.outTs, 4);
    pkt.writeUInt32BE(this.audioSsrc >>> 0, 8);
    this.audioSocket.send(this.audioSrtp.protectRtp(pkt), this.audioPort, this.target);
    this.outPackets++;
    this.outOctets += pkt.length - 12;
    this.lastSendAt = Date.now();
    if (this.outPackets === 1) this.log.debug(`first audio packet after ${Date.now() - this.startedAt} ms`);
  }

  private sendAudioReport(): void {
    if (this.stopped || this.outPackets === 0) return;
    const ts = (this.outTs + Math.round(((Date.now() - this.lastSendAt) * this.outClock) / 1000)) >>> 0;
    const sr = senderReport(this.audioSsrc, ts, this.outPackets, this.outOctets);
    this.audioSocket.send(this.audioSrtp.protectRtcp(sr), this.audioPort, this.target);
  }

  stop(reason = 'stopped'): void {
    if (this.stopped) return;
    this.stopped = true;
    this.log.info(`stop (${reason}) after ${this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0} s`);
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.rtcpTimer) clearInterval(this.rtcpTimer);
    this.ffmpeg?.stop();
    if (this.returnAudio) {
      this.returnAudio.stop();
      this.deps.talkback?.release();
    }
    for (const s of [this.videoSocket, this.audioSocket, this.relaySocket]) {
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
  }
}
