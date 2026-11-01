import { HAPStorage, type Categories, type MDNSAdvertiser } from 'hap-nodejs';
import { loadConfig } from './config.ts';
import { CallMonitor } from './hikvision/callMonitor.ts';
import { IsapiClient, type DeviceInfo } from './hikvision/isapi.ts';
import { Talkback } from './hikvision/talkback.ts';
import { createDoorbellAccessory } from './homekit/doorbell.ts';
import { loadIdentity } from './homekit/identity.ts';
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

  const { accessory, shutdown } = createDoorbellAccessory({ config, identity, isapi, talkback, callMonitor, deviceInfo });
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

  const paired = accessory._accessoryInfo?.paired() ?? false;
  log.info(`HomeKit accessory "${config.name}" published on port ${config.homekitPort} (${paired ? 'paired' : 'not paired yet'})`);
  if (!paired) {
    log.info(`Pair in the Home app: + → Add Accessory → More options → "${config.name}" → setup code ${identity.pincode}`);
    log.info(`Setup URI (for a QR code): ${accessory.setupURI()}`);
  }

  let closing = false;
  const close = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info(`${signal} received, shutting down`);
    callMonitor.stop();
    shutdown();
    await Promise.allSettled([accessory.unpublish(), talkback.shutdown()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void close('SIGTERM'));
  process.on('SIGINT', () => void close('SIGINT'));
}

main().catch((err: Error) => {
  log.error(`fatal: ${err.message}`);
  process.exit(1);
});
