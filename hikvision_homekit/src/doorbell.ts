import type { Categories, MDNSAdvertiser } from 'hap-nodejs';
import type { Config } from './config.ts';
import { CallMonitor } from './hikvision/callMonitor.ts';
import { IsapiClient, type DeviceInfo } from './hikvision/isapi.ts';
import { SnapshotCache } from './hikvision/snapshots.ts';
import { Talkback } from './hikvision/talkback.ts';
import { createDoorbellAccessory } from './homekit/doorbell.ts';
import type { Identity } from './homekit/identity.ts';
import { qrLines } from './homekit/qr.ts';
import { addSecret, createLogger, type Logger } from './log.ts';
import type { HomeAssistantBridge } from './mqtt/homeAssistant.ts';
import { startHomeAssistant, type BrokerSettings } from './mqtt/setup.ts';
import type { PairingInfo } from './web/pairingPage.ts';

/** One running door station: HomeKit accessory, ring detection, talk-back and (optionally) MQTT. */
export interface DoorbellUnit {
  config: Config;
  pairing: PairingInfo;
  close(): Promise<void>;
}

async function fetchDeviceInfo(isapi: IsapiClient, log: Logger): Promise<DeviceInfo> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await isapi.deviceInfo();
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

  const isapi = new IsapiClient({ host: config.host, port: config.httpPort, username: config.username, password: config.password });
  const deviceInfo = await fetchDeviceInfo(isapi, log);
  if (deviceInfo.model) log.info(`door station: ${deviceInfo.model} firmware ${deviceInfo.firmwareVersion} (${config.host})`);

  const callMonitor = new CallMonitor(isapi, config.callPollMs, createLogger('call', config.label));
  callMonitor.on('online', (online) => log.info(`door station ${online ? 'online' : 'OFFLINE'}`));
  const talkback = new Talkback({
    sdkDir: config.sdkDir,
    host: config.host,
    port: config.sdkPort,
    username: config.username,
    password: config.password,
    isapi,
    ringAction: config.ringAction,
    log: createLogger('talkback', config.label),
  });

  const snapshots = new SnapshotCache(isapi);
  // Registered first, so every other 'ring' listener (HomeKit, Home Assistant) gets a new picture.
  callMonitor.on('ring', () => snapshots.invalidate());
  let ha: HomeAssistantBridge | undefined;

  const { accessory, shutdown } = createDoorbellAccessory({
    config,
    identity,
    isapi,
    talkback,
    callMonitor,
    deviceInfo,
    snapshots,
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
  callMonitor.start();

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
      isapi,
      callMonitor,
      talkback,
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
      callMonitor.stop();
      shutdown();
      await Promise.allSettled([accessory.unpublish(), talkback.shutdown(), ha?.stop()]);
    },
  };
}
