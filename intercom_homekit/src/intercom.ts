/**
 * The contract between the brand-neutral core (HomeKit, Home Assistant/MQTT, snapshots, the
 * compatibility check) and a door station driver. Supporting another brand means implementing
 * `Intercom` and registering a `Driver` in drivers/index.ts. See CONTRIBUTING.md.
 *
 * Required: device info, reachability, ring detection and a video stream (RTSP).
 * Everything else is optional; the core leaves out what a driver doesn't implement (no lock tile
 * without openDoor, no Home Assistant volume sliders without volumes, and so on).
 */
import type { EventEmitter } from 'node:events';
import type { Config } from './config.ts';
import type { Logger } from './log.ts';
import type { Options } from './util/options.ts';

export interface DeviceInfo {
  /** Brand shown in the Home app and Home Assistant; defaults to the driver's name. */
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  /** Also names the Home Assistant device: keep it stable. */
  macAddress?: string;
  firmwareVersion?: string;
}

/** Call states, shown by the Home Assistant "Call state" sensor. Use these three where they fit. */
export type CallState = 'idle' | 'ringing' | 'on_call' | (string & {});

export type VolumeKind = 'speaker' | 'talk' | 'microphone';
/** 0–10 each; leave a kind out when the device doesn't have it. */
export type AudioVolumes = Partial<Record<VolumeKind, number>>;

/** Video streams the device serves now (it may allow only a few). */
export interface StreamingStatus {
  total: number;
  clients: string[];
}

/** A client logged in to the device. */
export interface OnlineUser {
  name?: string;
  type?: string;
  address?: string;
  loginTime?: string;
}

export interface IntercomEvents {
  /** Someone pressed the call button. Emit once per press. */
  ring: [];
  /** The call state changed. */
  callState: [state: CallState];
  /** The device became reachable or unreachable. */
  online: [online: boolean];
}

/**
 * Your voice from the Home app to the door station speaker.
 * Audio arrives as G.711 µ-law, 8 kHz mono (160 bytes per 20 ms), already levelled.
 */
export interface Talkback extends EventEmitter<{ active: [active: boolean] }> {
  /** The speaker is open and playing what write() sends. */
  readonly active: boolean;
  /** A live view started: a chance to prepare (log in) so start() is quick. */
  acquire(): void;
  /** A live view ended. */
  release(): void;
  /** Open the speaker. Audio written while it opens may be buffered or dropped. */
  start(): Promise<void>;
  write(mulaw: Buffer): void;
  stop(): Promise<void>;
}

export type CheckStatus = 'ok' | 'limited' | 'failed';

/** One line of the start-up compatibility check. */
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface Intercom extends EventEmitter<IntercomEvents> {
  /** Reachable right now. Emit 'online' on every change. */
  readonly online: boolean;
  /** Last known call state, if the device reports one. */
  readonly callState?: CallState;

  /** Start ring detection and reachability monitoring. */
  start(): void;
  /** Stop everything and log out. */
  close(): Promise<void>;
  /** Ask the device who it is. Throws when unreachable. */
  deviceInfo(): Promise<DeviceInfo>;

  // --- optional -----------------------------------------------------------------------------

  /** Web page of the device, linked from Home Assistant. */
  readonly configurationUrl?: string;
  /** A JPEG from the device. Without it (or when it fails), snapshots come from the video stream. */
  snapshot?(): Promise<Buffer>;
  /** Open door relay `door` (1-based). Without it there is no lock tile or open door button. */
  openDoor?(door: number): Promise<void>;
  /** Two-way audio. Without it the Home app's microphone does nothing. */
  readonly talkback?: Talkback;
  hangUp?(): Promise<void>;
  rejectCall?(): Promise<void>;
  reboot?(): Promise<void>;
  volumes?(): Promise<AudioVolumes>;
  setVolume?(kind: VolumeKind, value: number): Promise<void>;
  streamingStatus?(): Promise<StreamingStatus>;
  onlineUsers?(): Promise<OnlineUser[]>;
  /**
   * Driver-specific lines for the start-up compatibility check, typically ring detection and
   * talk-back. Snapshots, video and audio are checked by the core.
   */
  checks?(): Promise<Check[]>;
}

/** Shared option sections the driver may read its settings from (talkback, system…). */
export type SharedOptions = Record<string, Options>;

/** Doorbell settings every driver gets: name, address and credentials. */
export interface CommonOptions {
  host: string;
  username: string;
  password: string;
}

export interface Driver<O = unknown> {
  /** Value of the doorbell's `type` option. Lower case, stable: it is stored in users' options. */
  id: string;
  /** Brand, used as manufacturer when the device doesn't report one. */
  name: string;
  /** Read and validate this driver's options from the doorbell entry. Throw an Error with a readable message. */
  parseOptions(entry: Options, shared: SharedOptions, common: CommonOptions): O;
  /** Default live video source, used unless the user sets `rtsp_url`. */
  streamUrl(common: CommonOptions, options: O): string;
  create(config: Config, options: O, logger: (scope: string) => Logger): Intercom;
}

/** Marks errors caused by wrong credentials, so the core never retries them (devices lock accounts). */
export function isAuthError(err: unknown): boolean {
  return (err as { authFailure?: unknown } | undefined)?.authFailure === true;
}
