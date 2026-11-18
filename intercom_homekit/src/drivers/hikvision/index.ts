/**
 * Hikvision video intercom door stations (DS-KV6113 tested; DS-KV8xxx, DS-KD8003, DS-KB8xxx expected).
 *
 * - Ring detection: the SDK's alarm channel (see alarmListener.ts) and the ISAPI call status, polled
 *   (see callMonitor.ts), whichever reports the press first. Reachability: the call status poll.
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
import { PressFilter } from './alarm.ts';
import { AlarmListener } from './alarmListener.ts';
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

/** One press reported by both the alarm channel and the call status poll counts once. */
const PRESS_WINDOW_MS = 10000;
/** How long "ringing" from the alarm channel lasts when the door station never reports the call's end. */
const ALARM_RINGING_MAX_MS = 60000;

/** The parts of the driver's sources the intercom uses; tests replace them. */
export interface HikvisionSources {
  monitor: Pick<CallMonitor, 'on' | 'start' | 'stop' | 'online' | 'status'>;
  alarm: Pick<AlarmListener, 'on' | 'start' | 'stop' | 'rearm' | 'nudge' | 'ready' | 'listening' | 'lastError'>;
}

export class HikvisionIntercom extends EventEmitter<IntercomEvents> implements Intercom {
  readonly configurationUrl: string;
  readonly talkback: Talkback;
  private readonly isapi: IsapiClient;
  private readonly monitor: HikvisionSources['monitor'];
  private readonly alarm: HikvisionSources['alarm'];
  private readonly log: Logger;
  private readonly presses = new PressFilter(PRESS_WINDOW_MS);
  /** The alarm channel reported a press, and neither its end nor a call status change yet. */
  private alarmRinging = false;
  private alarmRingingTimer?: NodeJS.Timeout;
  private wasOffline = false;
  private lastCallState?: CallState;

  constructor(config: Config, o: HikvisionOptions, logger: (scope: string) => Logger, sources: Partial<HikvisionSources> = {}) {
    super();
    const { host, username, password } = config;
    const sdkDir = process.env.HCNETSDK_DIR || '/opt/hcnetsdk';
    this.log = logger('ring');
    this.configurationUrl = `http://${host}${o.httpPort === 80 ? '' : `:${o.httpPort}`}/`;
    this.isapi = new IsapiClient({ host, port: o.httpPort, username, password });
    this.monitor = sources.monitor ?? new CallMonitor(this.isapi, o.callPollMs, logger('call'));
    this.alarm = sources.alarm ?? new AlarmListener({ sdkDir, host, port: o.sdkPort, username, password, log: this.log });
    this.talkback = new Talkback({
      sdkDir,
      host,
      port: o.sdkPort,
      username,
      password,
      isapi: this.isapi,
      ringAction: o.ringAction,
      log: logger('talkback'),
    });
    this.monitor.on('ring', () => this.pressed('call status'));
    this.alarm.on('ring', () => {
      this.setAlarmRinging(true);
      this.pressed('alarm channel');
    });
    this.alarm.on('dismissed', () => this.setAlarmRinging(false));
    this.monitor.on('status', () => {
      // The call status moved: it is reporting this call, so it takes over from the alarm channel.
      this.setAlarmRinging(false);
      this.callStateChanged();
    });
    this.monitor.on('online', (online) => {
      this.emit('online', online);
      if (!online) {
        this.wasOffline = true;
      } else if (this.wasOffline) {
        // The SDK session may not have survived the outage, and wouldn't say so.
        this.wasOffline = false;
        this.alarm.rearm('door station is back online');
      } else {
        this.alarm.nudge();
      }
    });
  }

  private pressed(source: string): void {
    if (this.presses.accept()) this.emit('ring');
    else this.log.debug(`press reported again by the ${source}: ignored`);
  }

  private setAlarmRinging(ringing: boolean): void {
    if (this.alarmRingingTimer) clearTimeout(this.alarmRingingTimer);
    this.alarmRingingTimer = ringing ? setTimeout(() => this.setAlarmRinging(false), ALARM_RINGING_MAX_MS) : undefined;
    this.alarmRingingTimer?.unref();
    this.alarmRinging = ringing;
    this.callStateChanged();
  }

  private callStateChanged(): void {
    const state = this.callState;
    if (state === undefined || state === this.lastCallState) return;
    this.lastCallState = state;
    this.emit('callState', state);
  }

  get online(): boolean {
    return this.monitor.online;
  }

  get callState(): CallState | undefined {
    const polled = this.monitor.status === undefined ? undefined : callState(this.monitor.status);
    // Some door stations keep their call status at idle while they ring; the alarm channel knows better.
    return this.alarmRinging && (polled === undefined || polled === 'idle') ? 'ringing' : polled;
  }

  start(): void {
    this.monitor.start();
    this.alarm.start();
  }

  async close(): Promise<void> {
    this.monitor.stop();
    if (this.alarmRingingTimer) clearTimeout(this.alarmRingingTimer);
    await Promise.allSettled([this.alarm.stop(), this.talkback.shutdown()]);
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
    const [listening, polled] = await Promise.all([
      this.alarm.ready(15000),
      this.isapi.callStatus().then(
        (status) => `call status works ("${status}")`,
        (err: Error) => err,
      ),
    ]);
    if (listening) {
      const detail = typeof polled === 'string' ? `SDK alarm channel open, ${polled}` : 'SDK alarm channel open (no call status)';
      checks.push({ name: 'ring detection', status: 'ok', detail });
    } else if (typeof polled === 'string') {
      checks.push({
        name: 'ring detection',
        status: 'limited',
        detail: `${polled}, but the SDK alarm channel is not open (${this.alarm.lastError ?? 'still connecting'}): some door stations don't show a press in their call status`,
      });
    } else {
      checks.push({
        name: 'ring detection',
        status: 'failed',
        detail: `no SDK alarm channel (${this.alarm.lastError ?? 'still connecting'}) and no call status (${polled.message}): doorbell presses can't be detected`,
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
