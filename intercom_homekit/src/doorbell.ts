import type { Categories, MDNSAdvertiser } from 'hap-nodejs';
import { checkCompatibility, reportLines } from './compat.ts';
import type { Config } from './config.ts';
import { DRIVERS } from './drivers/index.ts';
import { createDoorbellAccessory } from './homekit/doorbell.ts';
import type { Identity } from './homekit/identity.ts';
import type { DeviceInfo, Intercom } from './intercom.ts';
import { qrLines } from './homekit/qr.ts';
import { addSecret, createLogger, type Logger } from './log.ts';
import { grabFrame } from './media/frameGrab.ts';
import { SnapshotCache } from './media/snapshots.ts';
import { probeStream, type StreamInfo } from './media/streamProbe.ts';
import type { HomeAssistantBridge } from './mqtt/homeAssistant.ts';
import { startHomeAssistant, type BrokerSettings } from './mqtt/setup.ts';
import type { PairingInfo } from './web/pairingPage.ts';

/** One running door station: HomeKit accessory, ring detection, talk-back and (optionally) MQTT. */
export interface DoorbellUnit {
  config: Config;
  pairing: PairingInfo;
  close(): Promise<void>;
}

async function fetchDeviceInfo(intercom: Intercom, log: Logger): Promise<DeviceInfo> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await intercom.deviceInfo();
    } catch (err) {
      if (attempt >= 6) {
        log.warn(`door station not reachable (${(err as Error).message}); continuing, it will be retried`);
        return {};
      }
      log.warn(`waiting for door station: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

export interface DoorbellOptions {
  /** MQTT broker for Home Assistant entities; none → HomeKit only. */
  broker?: BrokerSettings;
  /** The first doorbell takes over the MQTT state file of versions before 0.6. */
  adoptLegacyMqttState?: boolean;
}

export async function startDoorbell(config: Config, identity: Identity, opts: DoorbellOptions = {}): Promise<DoorbellUnit> {
  const log = createLogger('main', config.label);
  addSecret(config.password);

  const driver = DRIVERS[config.type];
  const intercom = driver.create(config, config.driverOptions, (scope) => createLogger(scope, config.label));
  const withBrand = (info: DeviceInfo): DeviceInfo => ({ ...info, manufacturer: info.manufacturer ?? driver.name });
  const deviceInfo = withBrand(await fetchDeviceInfo(intercom, log));
  if (deviceInfo.model) log.info(`door station: ${deviceInfo.manufacturer} ${deviceInfo.model} firmware ${deviceInfo.firmwareVersion} (${config.host})`);
  intercom.on('online', (online) => log.info(`door station ${online ? 'online' : 'OFFLINE'}`));

  const snapshotLog = createLogger('snapshot', config.label);
  const snapshots = new SnapshotCache({
    picture: intercom.snapshot && (() => intercom.snapshot!()),
    grabFrame: () => grabFrame(config.rtspUrl, snapshotLog),
    log: snapshotLog,
  });
  // Registered first, so every other 'ring' listener (HomeKit, Home Assistant) gets a new picture.
  intercom.on('ring', () => snapshots.invalidate());
  let ha: HomeAssistantBridge | undefined;
  let closed = false;
  // Codecs of the stream, from the compatibility check (until then: H.264 with audio, as on most models).
  let media: StreamInfo | undefined;

  const { accessory, shutdown } = createDoorbellAccessory({
    config,
    identity,
    intercom,
    deviceInfo,
    snapshots,
    media: () => media,
    onLiveViews: (count) => ha?.setLiveViews(count),
  });
  await accessory.publish({
    username: identity.username,
    pincode: identity.pincode,
    setupID: identity.setupId,
    category: 18 as Categories, // VIDEO_DOORBELL
    port: config.homekitPort,
    bind: config.homekitBind,
    advertiser: config.mdnsAdvertiser as MDNSAdvertiser,
  });
  intercom.start();

  // Once reachable: what works on this model (logged; also picks the stream's codecs).
  const missing = [!intercom.talkback && 'talk-back', !intercom.openDoor && config.doors > 0 && 'door'].filter((m): m is string => Boolean(m));
  intercom.once('online', () => {
    checkCompatibility({
      deviceInfo: () => (deviceInfo.model ? Promise.resolve(deviceInfo) : intercom.deviceInfo().then(withBrand)),
      driverChecks: intercom.checks && (() => intercom.checks!()),
      snapshot: intercom.snapshot && (() => intercom.snapshot!()),
      probeStream: () => probeStream(config.rtspUrl),
      missing,
      transcode: config.videoTranscode,
      cancelled: () => closed,
    }).then((report) => {
      media = report.stream;
      if (!closed) for (const line of reportLines(report)) log[line.level](line.msg);
    }, (err: Error) => log.warn(`compatibility check failed: ${err.message}`));
  });

  const isPaired = () => accessory._accessoryInfo?.paired() ?? false;
  const setupUri = accessory.setupURI();
  log.info(`HomeKit accessory "${config.name}" published on port ${config.homekitPort} (${isPaired() ? 'paired' : 'not paired yet'})`);
  const showPairing = () => {
    log.info(`Pair "${config.name}" in the Home app: + → Add Accessory → scan its QR code on this add-on's "Open Web UI" page`);
    log.info(`(or the one below), or More options → "${config.name}" → setup code ${identity.pincode}`);
    process.stdout.write(`${qrLines(setupUri).join('\n')}\n`);
  };
  if (!isPaired()) showPairing();
  accessory.on('paired', () => {
    log.info('paired with HomeKit');
    ha?.setPaired(true);
  });
  accessory.on('unpaired', () => {
    log.info('removed from HomeKit; ready to pair again');
    ha?.setPaired(isPaired());
    showPairing();
  });

  // Sensors and controls in Home Assistant, over MQTT (runs alongside HomeKit; never blocks it).
  if (opts.broker) {
    startHomeAssistant({
      config,
      broker: opts.broker,
      adoptLegacyState: opts.adoptLegacyMqttState,
      intercom,
      snapshots,
      deviceInfo,
      isPaired,
    }).then(
      (bridge) => {
        ha = bridge;
      },
      (err: Error) => log.error(`Home Assistant (MQTT) setup failed: ${err.message}`),
    );
  }

  return {
    config,
    pairing: { name: config.name, pincode: identity.pincode, setupUri, paired: isPaired },
    async close() {
      closed = true;
      shutdown();
      await Promise.allSettled([accessory.unpublish(), intercom.close(), ha?.stop()]);
    },
  };
}
