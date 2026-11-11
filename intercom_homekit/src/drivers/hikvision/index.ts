/**
 * Hikvision video intercom door stations (DS-KV6113 tested; DS-KV8xxx, DS-KD8003, DS-KB8xxx expected).
 *
 * - Ring detection and reachability: ISAPI call status, polled (see callMonitor.ts).
 * - Door, volumes, hang up, reboot, snapshots: ISAPI over HTTP with Digest auth.
 * - Talk-back: the Hikvision SDK's voice forwarding, in a helper process (see talkback.ts).
 */
import { EventEmitter } from 'node:events';
import type { Config } from '../../config.ts';
import type {
  AudioVolumes,
  CallState,
  Check,
  CommonOptions,
  DeviceInfo,
  Driver,
  Intercom,
  IntercomEvents,
  OnlineUser,
  SharedOptions,
  StreamingStatus,
  VolumeKind,
} from '../../intercom.ts';
import type { Logger } from '../../log.ts';
import { num, str, type Options } from '../../util/options.ts';
import { CallMonitor } from './callMonitor.ts';
import { IsapiClient } from './isapi.ts';
import { RING_ACTIONS, Talkback, type RingAction } from './talkback.ts';

export interface HikvisionOptions {
  httpPort: number;
  rtspPort: number;
  sdkPort: number;
  /** `talkback.ring_action`: what to send when talk-back starts while it rings. */
  ringAction: RingAction;
  /** `system.call_poll_interval`, in ms. */
  callPollMs: number;
}

/** callStatus values → call states. */
const CALL_STATES: Record<string, CallState> = { idle: 'idle', ring: 'ringing', onCall: 'on_call' };

export function callState(status: string): CallState {
  return CALL_STATES[status] ?? status;
}

export class HikvisionIntercom extends EventEmitter<IntercomEvents> implements Intercom {
  readonly configurationUrl: string;
  readonly talkback: Talkback;
  private readonly isapi: IsapiClient;
  private readonly monitor: CallMonitor;

  constructor(config: Config, o: HikvisionOptions, logger: (scope: string) => Logger) {
    super();
    const { host, username, password } = config;
    this.configurationUrl = `http://${host}${o.httpPort === 80 ? '' : `:${o.httpPort}`}/`;
    this.isapi = new IsapiClient({ host, port: o.httpPort, username, password });
    this.monitor = new CallMonitor(this.isapi, o.callPollMs, logger('call'));
    this.talkback = new Talkback({
      sdkDir: process.env.HCNETSDK_DIR || '/opt/hcnetsdk',
      host,
      port: o.sdkPort,
      username,
      password,
      isapi: this.isapi,
      ringAction: o.ringAction,
      log: logger('talkback'),
    });
    this.monitor.on('ring', () => this.emit('ring'));
    this.monitor.on('online', (online) => this.emit('online', online));
    this.monitor.on('status', (status) => this.emit('callState', callState(status)));
  }

  get online(): boolean {
    return this.monitor.online;
  }

  get callState(): CallState | undefined {
    return this.monitor.status === undefined ? undefined : callState(this.monitor.status);
  }

  start(): void {
    this.monitor.start();
  }

  async close(): Promise<void> {
    this.monitor.stop();
    await this.talkback.shutdown();
  }

  deviceInfo(): Promise<DeviceInfo> {
    return this.isapi.deviceInfo();
  }

  snapshot(): Promise<Buffer> {
    return this.isapi.snapshot();
  }

  openDoor(door: number): Promise<void> {
    return this.isapi.openDoor(door);
  }

  hangUp(): Promise<void> {
    return this.isapi.callSignal('hangUp');
  }

  rejectCall(): Promise<void> {
    return this.isapi.callSignal('reject');
  }

  reboot(): Promise<void> {
    return this.isapi.reboot();
  }

  volumes(): Promise<AudioVolumes> {
    return this.isapi.audioVolumes();
  }

  setVolume(kind: VolumeKind, value: number): Promise<void> {
    return this.isapi.setAudioVolume(kind, value);
  }

  streamingStatus(): Promise<StreamingStatus> {
    return this.isapi.streamingStatus();
  }

  onlineUsers(): Promise<OnlineUser[]> {
    return this.isapi.onlineUsers();
  }

  async checks(): Promise<Check[]> {
    const checks: Check[] = [];
    try {
      checks.push({ name: 'ring detection', status: 'ok', detail: `call status works ("${await this.isapi.callStatus()}")` });
    } catch (err) {
      checks.push({
        name: 'ring detection',
        status: 'failed',
        detail: `call status unavailable (${(err as Error).message}): doorbell presses can't be detected`,
      });
    }
    try {
      await this.talkback.check();
      checks.push({ name: 'talk-back', status: 'ok', detail: 'Hikvision SDK login works' });
    } catch (err) {
      checks.push({
        name: 'talk-back',
        status: 'failed',
        detail: `Hikvision SDK login failed (${(err as Error).message}): talk-back won't work. Check sdk_port (default 8000).`,
      });
    }
    return checks;
  }
}

export const hikvision: Driver<HikvisionOptions> = {
  id: 'hikvision',
  name: 'Hikvision',
  parseOptions(entry: Options, shared: SharedOptions): HikvisionOptions {
    const ringAction = str(shared.talkback ?? {}, 'ring_action', 'hangUp') as RingAction;
    if (!RING_ACTIONS.includes(ringAction)) throw new Error(`"ring_action" must be one of ${RING_ACTIONS.join(', ')}`);
    return {
      httpPort: num(entry, 'http_port', 80, 1, 65535),
      rtspPort: num(entry, 'rtsp_port', 554, 1, 65535),
      sdkPort: num(entry, 'sdk_port', 8000, 1, 65535),
      ringAction,
      callPollMs: num(shared.system ?? {}, 'call_poll_interval', 1, 0.3, 10) * 1000,
    };
  },
  streamUrl({ host, username, password }: CommonOptions, o: HikvisionOptions): string {
    return `rtsp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${o.rtspPort}/Streaming/Channels/101`;
  },
  create: (config, options, logger) => new HikvisionIntercom(config, options, logger),
};
