import { HAPStorage, type Categories, type MDNSAdvertiser } from 'hap-nodejs';
import { loadConfig } from './config.ts';
import { CallMonitor } from './hikvision/callMonitor.ts';
import { IsapiClient, type DeviceInfo } from './hikvision/isapi.ts';
import { SnapshotCache } from './hikvision/snapshots.ts';
import { Talkback } from './hikvision/talkback.ts';
import { createDoorbellAccessory } from './homekit/doorbell.ts';
import { loadIdentity } from './homekit/identity.ts';
import { qrLines } from './homekit/qr.ts';
import type { HomeAssistantBridge } from './mqtt/homeAssistant.ts';
import { startHomeAssistant } from './mqtt/setup.ts';
import { startPairingPage } from './web/pairingPage.ts';
import { addSecret, createLogger, setLogLevel } from './log.ts';

const log = createLogger('main');

async function fetchDeviceInfo(isapi: IsapiClient): Promise<DeviceInfo> {
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

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  addSecret(config.password);

  const { identity, persistDir } = loadIdentity(config.dataDir, config.homekitPin, config.resetPairing);
  if (config.resetPairing) log.warn('HomeKit pairing was reset. Turn "reset_homekit_pairing" off again, then pair the new accessory.');
  HAPStorage.setCustomStoragePath(persistDir);

  const isapi = new IsapiClient({ host: config.host, port: config.httpPort, username: config.username, password: config.password });
  const deviceInfo = await fetchDeviceInfo(isapi);
  if (deviceInfo.model) log.info(`door station: ${deviceInfo.model} firmware ${deviceInfo.firmwareVersion} (${config.host})`);

  const callMonitor = new CallMonitor(isapi, config.callPollMs);
  callMonitor.on('online', (online) => log.info(`door station ${online ? 'online' : 'OFFLINE'}`));
  const talkback = new Talkback({
    sdkDir: config.sdkDir,
    host: config.host,
    port: config.sdkPort,
    username: config.username,
    password: config.password,
    isapi,
    ringAction: config.ringAction,
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
  const paired = isPaired();
  log.info(`HomeKit accessory "${config.name}" published on port ${config.homekitPort} (${paired ? 'paired' : 'not paired yet'})`);
  const web = startPairingPage(config.webPort, { name: config.name, pincode: identity.pincode, setupUri: accessory.setupURI(), paired: isPaired }, log);
  const showPairing = () => {
    log.info(`Pair in the Home app: + → Add Accessory → scan the QR code on this add-on's "Open Web UI" page`);
    log.info(`(or the one below), or More options → "${config.name}" → setup code ${identity.pincode}`);
    process.stdout.write(`${qrLines(accessory.setupURI()).join('\n')}\n`);
  };
  if (!paired) showPairing();
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
  if (config.mqtt) {
    startHomeAssistant({ config, isapi, callMonitor, talkback, snapshots, deviceInfo, isPaired }).then(
      (bridge) => {
        ha = bridge;
      },
      (err: Error) => log.error(`Home Assistant (MQTT) setup failed: ${err.message}`),
    );
  }

  let closing = false;
  const close = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info(`${signal} received, shutting down`);
    callMonitor.stop();
    shutdown();
    web.close();
    await Promise.allSettled([accessory.unpublish(), talkback.shutdown(), ha?.stop()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void close('SIGTERM'));
  process.on('SIGINT', () => void close('SIGINT'));
}

main().catch((err: Error) => {
  log.error(`fatal: ${err.message}`);
  process.exit(1);
});
