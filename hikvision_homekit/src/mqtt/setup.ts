import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Config, MqttSettings } from '../config.ts';
import type { CallMonitor } from '../hikvision/callMonitor.ts';
import type { DeviceInfo, IsapiClient } from '../hikvision/isapi.ts';
import type { SnapshotCache } from '../hikvision/snapshots.ts';
import type { Talkback } from '../hikvision/talkback.ts';
import { addSecret, createLogger, type Logger } from '../log.ts';
import { supervisorApi } from '../supervisor.ts';
import { MqttClient } from './client.ts';
import { HomeAssistantBridge, deviceId } from './homeAssistant.ts';

const log = createLogger('mqtt');
const LEGACY_STATE_FILE = 'mqtt-discovery.json';
/** Door stations already published by this process (one MQTT device per physical station). */
const claimedIds = new Set<string>();

export interface BrokerSettings {
  host: string;
  port: number;
  ssl: boolean;
  username?: string;
  password?: string;
  /** Where the settings came from, for the log. */
  source: string;
}

interface SupervisorMqttService {
  host?: string;
  port?: number;
  ssl?: boolean;
  username?: string;
  password?: string;
  addon?: string;
}

/** Broker from the add-on options, or the one Home Assistant's Supervisor provides (Mosquitto add-on). */
export async function findBroker(mqtt: MqttSettings, env: NodeJS.ProcessEnv = process.env): Promise<BrokerSettings | undefined> {
  if (mqtt.host) {
    return { host: mqtt.host, port: mqtt.port, ssl: false, username: mqtt.username, password: mqtt.password, source: 'add-on options' };
  }
  if (!env.SUPERVISOR_TOKEN) return undefined;
  let d: SupervisorMqttService;
  try {
    d = await supervisorApi<SupervisorMqttService>('GET', '/services/mqtt', undefined, env);
  } catch (err) {
    log.debug(`Supervisor has no MQTT service: ${(err as Error).message}`);
    return undefined;
  }
  if (!d?.host) return undefined;
  return {
    host: d.host,
    port: d.port ?? 1883,
    ssl: d.ssl ?? false,
    username: d.username,
    password: d.password,
    source: d.addon ? `${d.addon} add-on` : 'Supervisor',
  };
}

function addonVersion(): string {
  try {
    return (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

export interface HomeAssistantDeps {
  config: Config;
  broker: BrokerSettings;
  /** Take over the discovery state file of versions before 0.6 (single doorbell). */
  adoptLegacyState?: boolean;
  isapi: IsapiClient;
  callMonitor: CallMonitor;
  talkback: Talkback;
  snapshots: SnapshotCache;
  deviceInfo: DeviceInfo;
  isPaired: () => boolean;
}

/** The door station's MAC/serial names the MQTT device; wait until it has answered once. */
async function waitForDeviceInfo(deps: HomeAssistantDeps, log: Logger): Promise<DeviceInfo> {
  if (deviceId(deps.deviceInfo)) return deps.deviceInfo;
  log.info('waiting for the door station before publishing to Home Assistant');
  for (;;) {
    if (!deps.callMonitor.online) await new Promise((r) => deps.callMonitor.once('online', r));
    try {
      const info = await deps.isapi.deviceInfo();
      if (deviceId(info)) return info;
    } catch {
      /* retried below */
    }
    await new Promise((r) => setTimeout(r, 30000));
  }
}

/** Connect to MQTT and publish one door station as a Home Assistant device. */
export async function startHomeAssistant(deps: HomeAssistantDeps): Promise<HomeAssistantBridge> {
  const { config, broker, isapi, callMonitor, talkback, snapshots } = deps;
  const log = createLogger('mqtt', config.label);
  addSecret(broker.password);
  const deviceInfo = await waitForDeviceInfo(deps, log);
  const id = deviceId(deviceInfo)!;
  if (claimedIds.has(id)) throw new Error(`same door station (${id}) as another configured doorbell; not published twice`);
  claimedIds.add(id);
  const stateFile = join(config.dataDir, `mqtt-${id}.json`);
  const legacyState = join(config.dataDir, LEGACY_STATE_FILE);
  if (deps.adoptLegacyState && !existsSync(stateFile) && existsSync(legacyState)) renameSync(legacyState, stateFile);
  const t = `hikvision_homekit/${id}`;

  const client = new MqttClient({
    host: broker.host,
    port: broker.port,
    ssl: broker.ssl,
    username: broker.username,
    password: broker.password,
    clientId: `hikvision_homekit_${id}`,
    keepaliveSec: 60,
    will: { topic: `${t}/status`, payload: 'offline', retain: true },
    // A host-network add-on may not resolve add-on hostnames (core-mosquitto); the Mosquitto
    // add-on also listens on the host's port 1883.
    fallbackHosts: broker.source.endsWith('add-on') ? ['127.0.0.1'] : [],
  });
  let lastError = '';
  client.on('error', (err) => {
    // Log each distinct problem once instead of on every reconnect attempt.
    if (err.message === lastError) return;
    lastError = err.message;
    log.warn(`MQTT (${client.address}, from ${broker.source}): ${err.message}`);
  });
  client.on('connect', () => {
    lastError = '';
  });
  client.on('close', () => log.warn('MQTT connection lost; reconnecting'));

  const bridge = new HomeAssistantBridge({
    client,
    id,
    name: config.name,
    host: config.host,
    httpPort: config.httpPort,
    deviceInfo,
    doors: config.doors,
    version: addonVersion(),
    stateFile,
    log,
    actions: {
      openDoor: (door) => isapi.openDoor(door),
      callSignal: (cmd) => isapi.callSignal(cmd),
      reboot: () => isapi.reboot(),
      snapshot: (fresh) => (fresh ? snapshots.fresh() : snapshots.get()),
      volumes: () => isapi.audioVolumes(),
      setVolume: (kind, value) => isapi.setAudioVolume(kind, value),
      streamingStatus: () => isapi.streamingStatus(),
      onlineUsers: () => isapi.onlineUsers(),
    },
  });

  bridge.setOnline(callMonitor.online);
  if (callMonitor.status) bridge.setCallStatus(callMonitor.status);
  bridge.setTalking(talkback.active);
  bridge.setPaired(deps.isPaired());
  callMonitor.on('online', (online) => bridge.setOnline(online));
  callMonitor.on('status', (status) => bridge.setCallStatus(status));
  callMonitor.on('ring', () => bridge.ring());
  talkback.on('active', (active) => bridge.setTalking(active));
  bridge.start();
  return bridge;
}
