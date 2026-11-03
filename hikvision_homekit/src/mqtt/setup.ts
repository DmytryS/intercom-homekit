import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { CallMonitor } from '../hikvision/callMonitor.ts';
import type { DeviceInfo, IsapiClient } from '../hikvision/isapi.ts';
import type { SnapshotCache } from '../hikvision/snapshots.ts';
import type { Talkback } from '../hikvision/talkback.ts';
import { addSecret, createLogger } from '../log.ts';
import { MqttClient } from './client.ts';
import { HomeAssistantBridge, deviceId } from './homeAssistant.ts';

const log = createLogger('mqtt');

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
export async function findBroker(config: Config, env: NodeJS.ProcessEnv = process.env): Promise<BrokerSettings | undefined> {
  if (config.mqttHost) {
    return {
      host: config.mqttHost,
      port: config.mqttPort,
      ssl: false,
      username: config.mqttUsername,
      password: config.mqttPassword,
      source: 'add-on options',
    };
  }
  const token = env.SUPERVISOR_TOKEN;
  if (!token) return undefined;
  let res: Response;
  try {
    res = await fetch('http://supervisor/services/mqtt', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    log.warn(`cannot ask the Supervisor for the MQTT broker: ${(err as Error).message}`);
    return undefined;
  }
  const body = (await res.json().catch(() => ({}))) as { result?: string; message?: string; data?: SupervisorMqttService };
  if (!res.ok || body.result !== 'ok' || !body.data?.host) {
    log.debug(`Supervisor has no MQTT service: HTTP ${res.status} ${body.message ?? ''}`);
    return undefined;
  }
  const d = body.data;
  return {
    host: d.host!,
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
  isapi: IsapiClient;
  callMonitor: CallMonitor;
  talkback: Talkback;
  snapshots: SnapshotCache;
  deviceInfo: DeviceInfo;
  isPaired: () => boolean;
}

/** The door station's MAC/serial names the MQTT device; wait until it has answered once. */
async function waitForDeviceInfo(deps: HomeAssistantDeps): Promise<DeviceInfo> {
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

/**
 * Connect to MQTT and publish the door station as a Home Assistant device. Resolves to
 * undefined (and logs why) when there is no broker; never throws.
 */
export async function startHomeAssistant(deps: HomeAssistantDeps): Promise<HomeAssistantBridge | undefined> {
  const { config, isapi, callMonitor, talkback, snapshots } = deps;
  const broker = await findBroker(config);
  if (!broker) {
    log.info(
      'no MQTT broker found, so no Home Assistant entities: install the Mosquitto broker add-on and the MQTT integration ' +
        '(or set mqtt_host), then restart this add-on',
    );
    return undefined;
  }
  addSecret(broker.password);
  const deviceInfo = await waitForDeviceInfo(deps);
  const id = deviceId(deviceInfo)!;
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
    stateFile: join(config.dataDir, 'mqtt-discovery.json'),
    log,
    actions: {
      openDoor: (door) => isapi.openDoor(door),
      callSignal: (cmd) => isapi.callSignal(cmd),
      reboot: () => isapi.reboot(),
      snapshot: (fresh) => (fresh ? snapshots.fresh() : snapshots.get()),
      volumes: () => isapi.audioVolumes(),
      setVolume: (kind, value) => isapi.setAudioVolume(kind, value),
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
