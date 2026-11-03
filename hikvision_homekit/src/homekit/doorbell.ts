import {
  Accessory,
  Characteristic,
  DoorbellController,
  HapStatusError,
  Service,
  uuid,
  type AudioStreamingCodecType,
  type AudioStreamingSamplerate,
  type CameraStreamingDelegate,
  type H264Level,
  type H264Profile,
  type HAPStatus,
  type PrepareStreamCallback,
  type PrepareStreamRequest,
  type SnapshotRequest,
  type SnapshotRequestCallback,
  type SRTPCryptoSuites,
  type StreamingRequest,
  type StreamRequestCallback,
} from 'hap-nodejs';
import type { Config } from '../config.ts';
import type { CallMonitor } from '../hikvision/callMonitor.ts';
import type { DeviceInfo, IsapiClient } from '../hikvision/isapi.ts';
import type { SnapshotCache } from '../hikvision/snapshots.ts';
import type { Talkback } from '../hikvision/talkback.ts';
import { createLogger, type Logger } from '../log.ts';
import type { Identity } from './identity.ts';
import { StreamSession } from './session.ts';


// hap-nodejs exposes these as `const enum`s; spell out the wire values.
const AES_CM_128_HMAC_SHA1_80 = 0 as SRTPCryptoSuites;
const PROFILES = [0, 1, 2] as H264Profile[]; // baseline, main, high
const LEVELS = [0, 1, 2] as H264Level[]; // 3.1, 3.2, 4.0
const OPUS = 'OPUS' as AudioStreamingCodecType;
const KHZ_16 = 16 as AudioStreamingSamplerate;
const KHZ_24 = 24 as AudioStreamingSamplerate;
const SERVICE_COMMUNICATION_FAILURE = -70402 as HAPStatus;

export interface DoorbellDeps {
  config: Config;
  identity: Identity;
  isapi: IsapiClient;
  talkback: Talkback;
  callMonitor: CallMonitor;
  deviceInfo: DeviceInfo;
  snapshots: SnapshotCache;
  /** Number of HomeKit live views streaming right now. */
  onLiveViews?: (count: number) => void;
}

class StreamingDelegate implements CameraStreamingDelegate {
  controller?: DoorbellController;
  private readonly deps: DoorbellDeps;
  private readonly pending = new Map<string, StreamSession>();
  private readonly sessions = new Map<string, StreamSession>();

  private readonly log: Logger;

  constructor(deps: DoorbellDeps, log: Logger) {
    this.deps = deps;
    this.log = log;
  }

  private changed(): void {
    this.deps.onLiveViews?.(this.sessions.size);
  }

  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    const t = Date.now();
    this.deps.snapshots.get().then(
      (jpeg) => {
        this.log.debug(`snapshot ${request.width}x${request.height} → ${jpeg.length} bytes in ${Date.now() - t} ms`);
        callback(undefined, jpeg);
      },
      (err: Error) => {
        this.log.warn(`snapshot failed: ${err.message}`);
        callback(err);
      },
    );
  }

  private readonly onEnded = (sessionId: string, reason: string): void => {
    const s = this.sessions.get(sessionId) ?? this.pending.get(sessionId);
    this.sessions.delete(sessionId);
    this.pending.delete(sessionId);
    s?.stop(reason);
    this.controller?.forceStopStreamingSession(sessionId);
    this.changed();
  };

  prepareStream(request: PrepareStreamRequest, callback: PrepareStreamCallback): void {
    StreamSession.prepare(request, { config: this.deps.config, talkback: this.deps.talkback, onEnded: this.onEnded }).then(
      ({ session, response }) => {
        this.pending.set(request.sessionID, session);
        callback(undefined, response);
      },
      (err: Error) => {
        this.log.error(`prepareStream failed: ${err.message}`);
        callback(err);
      },
    );
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    const id = request.sessionID;
    switch (request.type as string) {
      case 'start': {
        const session = this.pending.get(id);
        this.pending.delete(id);
        if (!session || request.type !== 'start') {
          callback(new Error('unknown session'));
          return;
        }
        this.sessions.set(id, session);
        this.changed();
        session.start(request).then(
          () => callback(),
          (err: Error) => {
            this.log.error(`stream start failed: ${err.message}`);
            this.sessions.delete(id);
            this.changed();
            session.stop('start failed');
            callback(err);
          },
        );
        return;
      }
      case 'reconfigure':
        // Video is passed through untouched, so bitrate/resolution changes are ignored.
        this.log.debug(`reconfigure request ignored: ${JSON.stringify((request as { video?: unknown }).video)}`);
        callback();
        return;
      case 'stop': {
        const session = this.sessions.get(id) ?? this.pending.get(id);
        this.sessions.delete(id);
        this.pending.delete(id);
        session?.stop('closed by controller');
        this.changed();
        callback();
        return;
      }
      default:
        callback();
    }
  }

  stopAll(): void {
    for (const s of [...this.sessions.values(), ...this.pending.values()]) s.stop('shutdown');
    this.sessions.clear();
    this.pending.clear();
    this.changed();
  }
}

export function createDoorbellAccessory(deps: DoorbellDeps): { accessory: Accessory; controller: DoorbellController; shutdown: () => void } {
  const { config, identity, deviceInfo, isapi, callMonitor } = deps;
  const log = createLogger('homekit', config.label);
  const accessory = new Accessory(config.name, uuid.generate(`hikvision-homekit:${identity.username}`));

  accessory
    .getService(Service.AccessoryInformation)!
    .setCharacteristic(Characteristic.Manufacturer, 'Hikvision')
    .setCharacteristic(Characteristic.Model, deviceInfo.model ?? 'Door Station')
    .setCharacteristic(Characteristic.SerialNumber, deviceInfo.serialNumber ?? identity.username)
    .setCharacteristic(Characteristic.FirmwareRevision, (deviceInfo.firmwareVersion ?? '1.0.0').replace(/^V/i, ''));
  accessory.on('identify', (paired, cb) => {
    log.info(`identify requested (paired=${paired})`);
    cb();
  });

  const delegate = new StreamingDelegate(deps, log);
  const controller = new DoorbellController({
    cameraStreamCount: config.maxStreams,
    delegate,
    streamingOptions: {
      supportedCryptoSuites: [AES_CM_128_HMAC_SHA1_80],
      video: {
        codec: { profiles: PROFILES, levels: LEVELS },
        resolutions: [
          [1920, 1080, 30], [1280, 960, 30], [1280, 720, 30], [1024, 768, 30], [640, 480, 30],
          [640, 360, 30], [480, 360, 30], [480, 270, 30], [320, 240, 30], [320, 240, 15], [320, 180, 30],
        ],
      },
      audio: {
        twoWayAudio: true,
        codecs: [{ type: OPUS, samplerate: [KHZ_16, KHZ_24], audioChannels: 1 }],
      },
    },
  });
  delegate.controller = controller;
  accessory.configureController(controller);

  // Door relays as lock tiles; they also show up under the live view in the Home app.
  const SECURED = Characteristic.LockCurrentState.SECURED;
  const UNSECURED = Characteristic.LockCurrentState.UNSECURED;
  for (let door = 1; door <= config.doors; door++) {
    const name = config.doors === 1 ? 'Door' : `Door ${door}`;
    const lock = accessory.addService(Service.LockMechanism, name, `door-${door}`);
    let relock: NodeJS.Timeout | undefined;
    lock.setCharacteristic(Characteristic.LockCurrentState, SECURED);
    lock.setCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.SECURED);
    lock.getCharacteristic(Characteristic.LockTargetState).onSet(async (value) => {
      if (value !== Characteristic.LockTargetState.UNSECURED) {
        lock.updateCharacteristic(Characteristic.LockCurrentState, SECURED);
        return;
      }
      try {
        await isapi.openDoor(door);
        log.info(`${name} opened from HomeKit`);
      } catch (err) {
        log.error(`opening ${name} failed: ${(err as Error).message}`);
        setTimeout(() => lock.updateCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.SECURED), 500);
        throw new HapStatusError(SERVICE_COMMUNICATION_FAILURE);
      }
      lock.updateCharacteristic(Characteristic.LockCurrentState, UNSECURED);
      if (relock) clearTimeout(relock);
      relock = setTimeout(() => {
        lock.updateCharacteristic(Characteristic.LockTargetState, Characteristic.LockTargetState.SECURED);
        lock.updateCharacteristic(Characteristic.LockCurrentState, SECURED);
      }, config.doorRelockMs);
    });
  }

  callMonitor.on('ring', () => {
    controller.ringDoorbell();
    // The notification fetches a snapshot right away; start fetching it now (the cache was
    // invalidated by the ring, see main.ts).
    deps.snapshots.get().catch(() => {});
  });

  return { accessory, controller, shutdown: () => delegate.stopAll() };
}
