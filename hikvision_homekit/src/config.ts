import { readFileSync } from 'node:fs';
import type { LogLevel } from './log.ts';

/** What to send to the door station when talk-back starts while it is still ringing. */
export type RingAction = 'none' | 'hangUp' | 'reject' | 'answer_hangup';

export interface Config {
  name: string;
  host: string;
  httpPort: number;
  sdkPort: number;
  username: string;
  password: string;
  /** RTSP source for live video; defaults to the door station main stream. */
  rtspUrl: string;
  videoTranscode: boolean;
  maxStreams: number;
  talkGain: number;
  talkIdleMs: number;
  ringAction: RingAction;
  doors: number;
  doorRelockMs: number;
  callPollMs: number;
  homekitPin?: string;
  homekitPort: number;
  /** Interface name or IP to advertise HomeKit on (default: all). */
  homekitBind?: string;
  mdnsAdvertiser: 'ciao' | 'bonjour-hap' | 'avahi';
  resetPairing: boolean;
  logLevel: LogLevel;
  sdkDir: string;
  dataDir: string;
  /** Web UI (Home Assistant ingress) port; must match `ingress_port` in config.yaml. */
  webPort: number;
  /** Publish entities to Home Assistant over MQTT. */
  mqtt: boolean;
  /** Broker override; default is the one the Supervisor provides (Mosquitto add-on). */
  mqttHost?: string;
  mqttPort: number;
  mqttUsername?: string;
  mqttPassword?: string;
}

type Options = Record<string, unknown>;

function str(o: Options, key: string, def = ''): string {
  const v = o[key];
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? def : String(v);
}

function num(o: Options, key: string, def: number, min: number, max: number): number {
  const v = o[key];
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Option "${key}" must be a number`);
  return Math.min(max, Math.max(min, n));
}

function bool(o: Options, key: string, def: boolean): boolean {
  const v = o[key];
  return typeof v === 'boolean' ? v : v === undefined || v === null ? def : String(v) === 'true';
}

export function parseConfig(o: Options, env: NodeJS.ProcessEnv = process.env): Config {
  const host = str(o, 'host');
  const password = str(o, 'password');
  if (!host) throw new Error('Option "host" (door station IP address) is required');
  if (!password) throw new Error('Option "password" is required');
  const username = str(o, 'username', 'admin') || 'admin';

  const pin = str(o, 'homekit_pin');
  if (pin && !/^\d{3}-\d{2}-\d{3}$/.test(pin)) throw new Error('Option "homekit_pin" must look like 123-45-678');

  const ringAction = str(o, 'ring_action', 'hangUp') as RingAction;
  if (!['none', 'hangUp', 'reject', 'answer_hangup'].includes(ringAction)) {
    throw new Error('Option "ring_action" must be one of none, hangUp, reject, answer_hangup');
  }
  const logLevel = (str(o, 'log_level', 'info') || 'info') as LogLevel;

  const rtspPort = num(o, 'rtsp_port', 554, 1, 65535);
  const defaultRtsp = `rtsp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${rtspPort}/Streaming/Channels/101`;

  return {
    name: str(o, 'name', 'Doorbell') || 'Doorbell',
    host,
    httpPort: num(o, 'http_port', 80, 1, 65535),
    sdkPort: num(o, 'sdk_port', 8000, 1, 65535),
    username,
    password,
    rtspUrl: str(o, 'rtsp_url') || defaultRtsp,
    videoTranscode: bool(o, 'video_transcode', false),
    maxStreams: num(o, 'max_streams', 2, 1, 4),
    talkGain: num(o, 'talk_gain', 1.5, 0.1, 10),
    talkIdleMs: num(o, 'talk_idle_seconds', 3, 1, 30) * 1000,
    ringAction,
    doors: num(o, 'doors', 1, 0, 2),
    doorRelockMs: num(o, 'door_relock_seconds', 5, 1, 60) * 1000,
    callPollMs: num(o, 'call_poll_interval', 1, 0.3, 10) * 1000,
    homekitPin: pin || undefined,
    homekitPort: num(o, 'homekit_port', 51828, 1024, 65535),
    homekitBind: str(o, 'homekit_bind') || undefined,
    mdnsAdvertiser: (['ciao', 'bonjour-hap', 'avahi'].includes(str(o, 'mdns_advertiser')) ? str(o, 'mdns_advertiser') : 'ciao') as Config['mdnsAdvertiser'],
    resetPairing: bool(o, 'reset_homekit_pairing', false),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(logLevel) ? logLevel : 'info',
    sdkDir: env.HCNETSDK_DIR || '/opt/hcnetsdk',
    dataDir: env.DATA_DIR || '/data',
    webPort: Number(env.WEB_PORT) || 51830,
    mqtt: bool(o, 'mqtt', true),
    mqttHost: str(o, 'mqtt_host') || undefined,
    mqttPort: num(o, 'mqtt_port', 1883, 1, 65535),
    mqttUsername: str(o, 'mqtt_username') || undefined,
    mqttPassword: str(o, 'mqtt_password') || undefined,
  };
}

/** Home Assistant add-ons receive their options in /data/options.json. */
export function loadConfig(path = process.env.CONFIG_FILE || '/data/options.json'): Config {
  let raw: Options;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Options;
  } catch (err) {
    throw new Error(`Cannot read options from ${path}: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}
