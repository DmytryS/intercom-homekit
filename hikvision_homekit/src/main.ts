import { mkdirSync } from 'node:fs';
import { Accessory, HAPStorage } from 'hap-nodejs';
import { startDoorbell, type DoorbellUnit } from './doorbell.ts';
import { homekitPersistDir, loadIdentities } from './homekit/identity.ts';
import { addSecret, createLogger, setLogLevel } from './log.ts';
import { findBroker } from './mqtt/setup.ts';
import { loadAddonConfig } from './options.ts';
import { startPairingPage } from './web/pairingPage.ts';

const log = createLogger('main');

async function main(): Promise<void> {
  const config = await loadAddonConfig(log);
  setLogLevel(config.logLevel);
  for (const d of config.doorbells) addSecret(d.password);
  addSecret(config.mqtt.password);
  for (const e of config.errors) log.warn(e);
  if (!config.doorbells.length) {
    throw new Error('no doorbell configured: add one under "Doorbells" on the Configuration tab (host, username and password)');
  }

  // HomeKit pairings of all doorbells live in one directory, keyed by accessory id.
  const persistDir = homekitPersistDir(config.dataDir);
  mkdirSync(persistDir, { recursive: true });
  HAPStorage.setCustomStoragePath(persistDir);
  const { identities, notes } = loadIdentities(
    config.dataDir,
    config.doorbells.map((d) => ({ key: d.key, name: d.name, host: d.host, pin: d.homekitPin, reset: d.resetPairing })),
    (username) => Accessory.cleanupAccessoryData(username),
  );
  for (const n of notes) log.info(n);

  const broker = config.mqtt.enabled ? await findBroker(config.mqtt) : undefined;
  if (config.mqtt.enabled && !broker) {
    log.info(
      'no MQTT broker found, so no Home Assistant entities: install the Mosquitto broker add-on and the MQTT integration ' +
        '(or set the MQTT host), then restart this add-on',
    );
  }

  const units: (DoorbellUnit | undefined)[] = [];
  const web = startPairingPage(config.webPort, () => units.flatMap((u) => (u ? [u.pairing] : [])), log);

  let closing = false;
  const close = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info(`${signal} received, shutting down`);
    web.close();
    await Promise.allSettled(units.map((u) => u?.close()));
    process.exit(0);
  };
  process.on('SIGTERM', () => void close('SIGTERM'));
  process.on('SIGINT', () => void close('SIGINT'));

  // Doorbells start independently: one that is offline or misconfigured doesn't hold up the others.
  await Promise.all(
    config.doorbells.map(async (d, i) => {
      try {
        units[i] = await startDoorbell(d, identities.get(d.key)!, { broker, adoptLegacyMqttState: i === 0 });
      } catch (err) {
        createLogger('main', d.label).error(`"${d.name}" could not be started: ${(err as Error).message}`);
      }
    }),
  );
  const running = units.filter((u) => u !== undefined).length;
  if (!running) throw new Error('no doorbell could be started');
  if (config.doorbells.length > 1) log.info(`${running} of ${config.doorbells.length} doorbells running`);

}

// A stray rejected promise (one doorbell's network error nobody awaited) must not take the other
// doorbells down: log it. A thrown exception leaves unknown state: exit, the Supervisor's
// watchdog restarts the add-on.
process.on('unhandledRejection', (reason) => log.error(`unhandled error: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`));
process.on('uncaughtException', (err) => {
  log.error(`crashed: ${err.stack ?? err.message}`);
  process.exit(1);
});

main().catch((err: Error) => {
  log.error(`fatal: ${err.message}`);
  process.exit(1);
});
