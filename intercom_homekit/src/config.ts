import { readFileSync } from 'node:fs';
import { DEFAULT_DRIVER, DRIVERS } from './drivers/index.ts';
import { LANGUAGES, isLanguage, type Language } from './i18n.ts';
import type { CommonOptions } from './intercom.ts';
import type { LogLevel } from './log.ts';
import { bool, num, section, str, type Options } from './util/options.ts';
import { slug } from './util/slug.ts';

export { slug };

export type { Options };

/** Everything one doorbell needs: its own settings merged with the add-on-wide ones. */
export interface Config {
  name: string;
  /** Stable storage key derived from the name (HomeKit identity). */
  key: string;
  /** Prefix for log lines; set when more than one doorbell is configured. */
  label?: string;
  /** Driver id (option `type`), e.g. `hikvision`. */
  type: string;
  /** What the driver's parseOptions returned. */
  driverOptions: unknown;
  host: string;
  username: string;
  password: string;
  /** RTSP source for live video: `rtsp_url`, or the driver's default for this door station. */
  rtspUrl: string;
  videoTranscode: boolean;
  maxStreams: number;
  talkGain: number;
  talkIdleMs: number;
  doors: number;
  doorRelockMs: number;
  homekitPin?: string;
  homekitPort: number;
  /** Interface name or IP to advertise HomeKit on (default: all). */
  homekitBind?: string;
  mdnsAdvertiser: 'ciao' | 'bonjour-hap' | 'avahi';
  resetPairing: boolean;
  dataDir: string;
  /** `system.language`: Home Assistant entity names, HomeKit tile names, pairing page fallback. */
  language: Language;
}

export interface MqttSettings {
  /** Publish entities to Home Assistant over MQTT. */
  enabled: boolean;
  /** Broker override; default is the one the Supervisor provides (Mosquitto add-on). */
  host?: string;
  port: number;
  username?: string;
  password?: string;
}

export interface AddonConfig {
  doorbells: Config[];
  /** Doorbells that were left out, with the reason (shown in the log). */
  errors: string[];
  mqtt: MqttSettings;
  logLevel: LogLevel;
  language: Language;
  dataDir: string;
  /** Web UI (Home Assistant ingress) port; must match `ingress_port` in config.yaml. */
  webPort: number;
}


export function hasConfiguredDoorbell(o: Options): boolean {
  return Array.isArray(o.doorbells) && o.doorbells.some((d) => d && typeof d === 'object' && str(d as Options, 'host'));
}

/**
 * Pre-0.6 options were flat (`host`, `password`, `talk_gain`… at the top level). Right after the
 * update the stored options hold both those keys and the new defaults (an empty doorbell).
 */
export function isLegacyOptions(o: Options): boolean {
  if (hasConfiguredDoorbell(o)) return false;
  return Boolean(str(o, 'host')) || (!Array.isArray(o.doorbells) && 'host' in o);
}

function pick(o: Options, map: Record<string, string>): Options {
  const out: Options = {};
  for (const [from, to] of Object.entries(map)) {
    const v = o[from];
    if (v !== undefined && v !== null && v !== '') out[to] = v;
  }
  return out;
}

/** Convert pre-0.6 flat options to the grouped format (for parsing, and to save back to the Supervisor). */
export function migrateOptions(o: Options): Options {
  return {
    doorbells: [
      {
        name: str(o, 'name', 'Doorbell') || 'Doorbell',
        host: str(o, 'host'),
        username: str(o, 'username', 'admin') || 'admin',
        password: str(o, 'password'),
        ...pick(o, {
          doors: 'doors',
          door_relock_seconds: 'door_relock_seconds',
          homekit_pin: 'homekit_pin',
          rtsp_url: 'rtsp_url',
          http_port: 'http_port',
          rtsp_port: 'rtsp_port',
          sdk_port: 'sdk_port',
          reset_homekit_pairing: 'reset_homekit_pairing',
        }),
      },
    ],
    talkback: { ring_action: 'hangUp', gain: 1.5, ...pick(o, { ring_action: 'ring_action', talk_gain: 'gain', talk_idle_seconds: 'idle_seconds' }) },
    video: pick(o, { video_transcode: 'transcode', max_streams: 'max_streams' }),
    homekit: pick(o, { homekit_port: 'port', homekit_bind: 'bind', mdns_advertiser: 'mdns_advertiser' }),
    mqtt: { enabled: bool(o, 'mqtt', true), ...pick(o, { mqtt_host: 'host', mqtt_port: 'port', mqtt_username: 'username', mqtt_password: 'password' }) },
    system: { log_level: 'info', ...pick(o, { log_level: 'log_level', call_poll_interval: 'call_poll_interval' }) },
  };
}

/** HomeKit ports for n doorbells, counting up from `base` and skipping `avoid` (the web UI port). */
export function homekitPorts(base: number, n: number, avoid: number): number[] {
  const ports: number[] = [];
  for (let p = base; ports.length < n; p++) if (p !== avoid) ports.push(p);
  return ports;
}

interface Shared {
  talkback: Options;
  video: Options;
  homekit: Options;
  system: Options;
  env: NodeJS.ProcessEnv;
}

/** Every section of the options except the doorbell list, for drivers. */
function sharedSections(o: Options): Record<string, Options> {
  const out: Record<string, Options> = {};
  for (const key of Object.keys(o)) if (key !== 'doorbells') out[key] = section(o, key);
  return out;
}

function parseDoorbell(d: Options, shared: Shared, sections: Record<string, Options>): Omit<Config, 'homekitPort' | 'label'> {
  const { talkback, video, homekit } = shared;
  const type = str(d, 'type', DEFAULT_DRIVER) || DEFAULT_DRIVER;
  const driver = DRIVERS[type];
  if (!driver) throw new Error(`"type" must be one of ${Object.keys(DRIVERS).join(', ')}`);
  const name = str(d, 'name', 'Doorbell') || 'Doorbell';
  const host = str(d, 'host');
  const password = str(d, 'password');
  if (!host) throw new Error('"host" (door station IP address) is required');
  if (!password) throw new Error('"password" is required');
  const username = str(d, 'username', 'admin') || 'admin';

  const pin = str(d, 'homekit_pin');
  if (pin && !/^\d{3}-\d{2}-\d{3}$/.test(pin)) throw new Error('"homekit_pin" must look like 123-45-678');

  const common: CommonOptions = { host, username, password };
  const driverOptions = driver.parseOptions(d, sections, common);
  const advertiser = str(homekit, 'mdns_advertiser');
  const language = str(shared.system, 'language', 'en') || 'en';
  if (!isLanguage(language)) throw new Error(`"language" must be one of ${LANGUAGES.join(', ')}`);

  return {
    name,
    key: slug(name),
    type,
    driverOptions,
    host,
    username,
    password,
    rtspUrl: str(d, 'rtsp_url') || driver.streamUrl(common, driverOptions),
    videoTranscode: bool(video, 'transcode', false),
    maxStreams: num(video, 'max_streams', 2, 1, 4),
    talkGain: num(talkback, 'gain', 1.5, 0.1, 10),
    talkIdleMs: num(talkback, 'idle_seconds', 3, 1, 30) * 1000,
    doors: num(d, 'doors', 1, 0, 8),
    doorRelockMs: num(d, 'door_relock_seconds', 5, 1, 60) * 1000,
    homekitPin: pin || undefined,
    homekitBind: str(homekit, 'bind') || undefined,
    mdnsAdvertiser: (['ciao', 'bonjour-hap', 'avahi'].includes(advertiser) ? advertiser : 'ciao') as Config['mdnsAdvertiser'],
    resetPairing: bool(d, 'reset_homekit_pairing', false),
    dataDir: shared.env.DATA_DIR || '/data',
    language,
  };
}

/** Parse the add-on options (grouped format, or the pre-0.6 flat one). */
export function parseOptions(raw: Options, env: NodeJS.ProcessEnv = process.env): AddonConfig {
  const o = isLegacyOptions(raw) ? migrateOptions(raw) : raw;
  const shared: Shared = { talkback: section(o, 'talkback'), video: section(o, 'video'), homekit: section(o, 'homekit'), system: section(o, 'system'), env };
  const mqtt = section(o, 'mqtt');
  const system = shared.system;
  const sections = sharedSections(o);
  const webPort = Number(env.WEB_PORT) || 51830;

  const errors: string[] = [];
  const parsed: Omit<Config, 'homekitPort' | 'label'>[] = [];
  const items = Array.isArray(o.doorbells) ? (o.doorbells as unknown[]) : [];
  items.forEach((item, i) => {
    const d = item && typeof item === 'object' ? (item as Options) : {};
    const name = str(d, 'name') || `#${i + 1}`;
    // An untouched placeholder entry (no host, no password) is not an error worth shouting about.
    if (!str(d, 'host') && !str(d, 'password')) {
      errors.push(`doorbell "${name}": not configured yet (set host and password)`);
      return;
    }
    try {
      const c = parseDoorbell(d, shared, sections);
      const clash = parsed.find((p) => p.key === c.key);
      if (clash) throw new Error(`its name is the same as "${clash.name}"; doorbell names must be unique`);
      parsed.push(c);
    } catch (err) {
      errors.push(`doorbell "${name}": ${(err as Error).message}`);
    }
  });

  const ports = homekitPorts(num(shared.homekit, 'port', 51828, 1024, 65535), parsed.length, webPort);
  const logLevel = str(system, 'log_level', 'info') as LogLevel;
  return {
    doorbells: parsed.map((c, i) => ({ ...c, homekitPort: ports[i], label: parsed.length > 1 ? c.name : undefined })),
    errors,
    mqtt: {
      enabled: bool(mqtt, 'enabled', true),
      host: str(mqtt, 'host') || undefined,
      port: num(mqtt, 'port', 1883, 1, 65535),
      username: str(mqtt, 'username') || undefined,
      password: str(mqtt, 'password') || undefined,
    },
    logLevel: ['debug', 'info', 'warn', 'error'].includes(logLevel) ? logLevel : 'info',
    language: ((l) => (isLanguage(l) ? l : 'en'))(str(system, 'language', 'en')),
    dataDir: env.DATA_DIR || '/data',
    webPort,
  };
}

/** One doorbell from flat (pre-0.6 style) options; throws if it is incomplete. For scripts and tests. */
export function parseConfig(o: Options, env: NodeJS.ProcessEnv = process.env): Config {
  const c = parseOptions(migrateOptions(o), env);
  if (!c.doorbells.length) throw new Error(c.errors[0] ?? 'no doorbell configured');
  return c.doorbells[0];
}

/** Home Assistant add-ons receive their options in /data/options.json. */
export function readOptions(path = process.env.CONFIG_FILE || '/data/options.json'): Options {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Options;
  } catch (err) {
    throw new Error(`Cannot read options from ${path}: ${(err as Error).message}`);
  }
}
