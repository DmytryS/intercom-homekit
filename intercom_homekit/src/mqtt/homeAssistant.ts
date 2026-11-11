import { readFileSync, writeFileSync } from 'node:fs';
import type { AudioVolumes, CallState, DeviceInfo, OnlineUser, StreamingStatus, VolumeKind } from '../intercom.ts';
import { t as text, type Language, type TextKey } from '../i18n.ts';
import type { Logger } from '../log.ts';
import { slug } from '../util/slug.ts';
import type { MqttClient, MqttMessage } from './client.ts';

/**
 * Publishes the door station to Home Assistant as an MQTT device (device-based discovery):
 * doorbell event, call state, door/call buttons, snapshot image, volume sliders and
 * diagnostics, and executes the commands Home Assistant sends back.
 */

export const VOLUME_KINDS: VolumeKind[] = ['speaker', 'talk', 'microphone'];
const VOLUME_MAX = 10;
const VOLUME_REFRESH_MS = 10 * 60 * 1000;

/** Who is using the door station: video streams and logged-in clients (it allows only a few). */
export type ConnectionSensor = 'video_streams' | 'logged_in_clients';
export const CONNECTION_SENSORS: ConnectionSensor[] = ['video_streams', 'logged_in_clients'];
const CONNECTIONS_REFRESH_MS = 30 * 1000;

/**
 * Topics, unique ids and the device identifier keep the add-on's first slug (hikvision_homekit):
 * changing them would orphan every user's Home Assistant entities and automations.
 */
export function topics(id: string, prefix = 'homeassistant') {
  const base = `hikvision_homekit/${id}`;
  return {
    base,
    discovery: `${prefix}/device/hikvision_homekit_${id}/config`,
    birth: `${prefix}/status`,
    bridge: `${base}/status`,
    station: `${base}/connection`,
    callState: `${base}/call_state`,
    doorbell: `${base}/doorbell`,
    snapshot: `${base}/snapshot`,
    talking: `${base}/talk_back`,
    liveViews: `${base}/live_views`,
    paired: `${base}/homekit_paired`,
    volume: (kind: VolumeKind) => `${base}/volume/${kind}`,
    connections: (sensor: ConnectionSensor) => `${base}/${sensor}`,
    connectionsAttributes: (sensor: ConnectionSensor) => `${base}/${sensor}/attributes`,
    command: (name: string) => `${base}/cmd/${name}`,
  };
}

/** Call buttons the driver supports. */
export interface CallCommands {
  hangUp: boolean;
  reject: boolean;
  restart: boolean;
  /** "Test ring" button. */
  testRing?: boolean;
}

export interface DiscoveryInput {
  id: string;
  name: string;
  configurationUrl?: string;
  deviceInfo: DeviceInfo;
  /** Door buttons; 0 when the driver can't open doors. */
  doors: number;
  commands: CallCommands;
  /** The driver has two-way audio. */
  talkback: boolean;
  version: string;
  volumes: VolumeKind[];
  connections: ConnectionSensor[];
  /** Entity names; entity ids are English in every language. Default en. */
  language?: Language;
}

type Component = Record<string, unknown> & { platform: string };

/** An entity name: a text key and its placeholders; null takes the device name. */
type Label = [TextKey, Record<string, string | number>?] | null;

const CONNECTION_ENTITIES: Record<ConnectionSensor, { name: TextKey; icon: string }> = {
  video_streams: { name: 'entity.video_streams', icon: 'mdi:video-account' },
  logged_in_clients: { name: 'entity.logged_in_clients', icon: 'mdi:account-network' },
};

const VOLUME_ENTITIES: Record<VolumeKind, { name: TextKey; icon: string }> = {
  speaker: { name: 'entity.speaker_volume', icon: 'mdi:volume-high' },
  talk: { name: 'entity.talk_volume', icon: 'mdi:account-voice' },
  microphone: { name: 'entity.microphone_volume', icon: 'mdi:microphone' },
};

export function discoveryComponents(input: DiscoveryInput): Record<string, Component> {
  const t = topics(input.id);
  // Controls and live states need the door station; diagnostics only need the add-on.
  const station = { availability: [{ topic: t.bridge }, { topic: t.station }], availability_mode: 'all' };
  const addon = { availability: [{ topic: t.bridge }] };
  const cmps: Record<string, Component> = {};
  const lang = input.language ?? 'en';
  const device = slug(input.name, '_');
  const add = (key: string, platform: string, label: Label, cfg: Record<string, unknown>) => {
    const english = label && text('en', ...label);
    cmps[key] = {
      platform,
      unique_id: `hikvision_homekit_${input.id}_${key}`,
      // The id Home Assistant would make from the English name, in every language, so the documented
      // ids (image.doorbell_snapshot…) work. Only used when the entity is first discovered.
      default_entity_id: `${platform}.${device}${english ? `_${slug(english, '_')}` : ''}`,
      name: label && text(lang, ...label),
      ...cfg,
    };
  };

  add('doorbell', 'event', null, { device_class: 'doorbell', event_types: ['ring'], state_topic: t.doorbell, ...station });
  add('call_state', 'sensor', ['entity.call_state'], { icon: 'mdi:phone-ring', state_topic: t.callState, ...station });
  for (let door = 1; door <= input.doors; door++) {
    add(`open_door_${door}`, 'button', input.doors === 1 ? ['entity.open_door'] : ['entity.open_door_n', { n: door }], {
      icon: 'mdi:door-open',
      command_topic: t.command(`open_door_${door}`),
      ...station,
    });
  }
  if (input.commands.hangUp) add('hang_up', 'button', ['entity.hang_up'], { icon: 'mdi:phone-hangup', command_topic: t.command('hang_up'), ...station });
  if (input.commands.reject) add('reject_call', 'button', ['entity.reject_call'], { icon: 'mdi:phone-cancel', command_topic: t.command('reject_call'), ...station });
  add('take_snapshot', 'button', ['entity.take_snapshot'], { icon: 'mdi:camera', command_topic: t.command('take_snapshot'), ...station });
  add('snapshot', 'image', ['entity.snapshot'], { image_topic: t.snapshot, content_type: 'image/jpeg', ...addon });
  for (const kind of input.volumes) {
    add(`${kind}_volume`, 'number', [VOLUME_ENTITIES[kind].name], {
      icon: VOLUME_ENTITIES[kind].icon,
      min: 0,
      max: VOLUME_MAX,
      step: 1,
      mode: 'slider',
      entity_category: 'config',
      state_topic: t.volume(kind),
      command_topic: t.command(`${kind}_volume`),
      ...station,
    });
  }
  // Device page → Configuration: rings like the real button (HomeKit notification, doorbell event,
  // snapshot), to try notifications and automations. Only needs the add-on.
  if (input.commands.testRing) {
    add('test_ring', 'button', ['entity.test_ring'], { icon: 'mdi:bell-ring', entity_category: 'config', command_topic: t.command('test_ring'), ...addon });
  }
  if (input.commands.restart) {
    add('restart', 'button', ['entity.restart'], { device_class: 'restart', entity_category: 'config', command_topic: t.command('restart'), ...station });
  }
  add('connection', 'binary_sensor', ['entity.connection'], {
    device_class: 'connectivity',
    entity_category: 'diagnostic',
    state_topic: t.station,
    payload_on: 'online',
    payload_off: 'offline',
    ...addon,
  });
  for (const sensor of input.connections) {
    add(sensor, 'sensor', [CONNECTION_ENTITIES[sensor].name], {
      icon: CONNECTION_ENTITIES[sensor].icon,
      entity_category: 'diagnostic',
      state_class: 'measurement',
      state_topic: t.connections(sensor),
      json_attributes_topic: t.connectionsAttributes(sensor),
      ...station,
    });
  }
  if (input.talkback) add('talk_back', 'binary_sensor', ['entity.talk_back'], { icon: 'mdi:account-voice', entity_category: 'diagnostic', state_topic: t.talking, ...addon });
  add('live_views', 'sensor', ['entity.live_views'], { icon: 'mdi:cctv', entity_category: 'diagnostic', state_topic: t.liveViews, ...addon });
  add('homekit_paired', 'binary_sensor', ['entity.homekit_paired'], {
    icon: 'mdi:link-variant',
    entity_category: 'diagnostic',
    state_topic: t.paired,
    ...addon,
  });
  return cmps;
}

/** The retained device discovery message. `removed` components (key → platform) are deleted in Home Assistant. */
export function discoveryPayload(input: DiscoveryInput, removed: Record<string, string> = {}): Record<string, unknown> {
  const { deviceInfo: info } = input;
  const components: Record<string, Component> = {};
  for (const [key, platform] of Object.entries(removed)) components[key] = { platform };
  Object.assign(components, discoveryComponents(input));
  const mac = info.macAddress?.toLowerCase();
  return {
    device: {
      identifiers: [`hikvision_homekit_${input.id}`],
      name: input.name,
      manufacturer: info.manufacturer,
      model: info.model,
      serial_number: info.serialNumber,
      sw_version: info.firmwareVersion,
      configuration_url: input.configurationUrl,
      connections: mac ? [['mac', mac]] : undefined,
    },
    origin: { name: 'Intercom Doorbell for HomeKit', sw_version: input.version, support_url: 'https://github.com/DmytryS/intercom-homekit' },
    components,
  };
}

/** A stable id for topics and unique ids: the door station MAC address (or serial number). */
export function deviceId(info: DeviceInfo): string | undefined {
  const raw = info.macAddress?.replace(/[^0-9a-f]/gi, '') || info.serialNumber?.replace(/[^0-9a-z]/gi, '');
  return raw ? raw.toLowerCase() : undefined;
}

/** What Home Assistant can do with the door station. Optional ones get no entity when missing. */
export interface BridgeActions {
  /** `fresh`: take a new picture now rather than reuse one from the last few seconds. */
  snapshot(fresh: boolean): Promise<Buffer>;
  /** Ring as if someone pressed the door station button. */
  testRing?(): void;
  openDoor?(door: number): Promise<void>;
  hangUp?(): Promise<void>;
  rejectCall?(): Promise<void>;
  reboot?(): Promise<void>;
  volumes?(): Promise<AudioVolumes>;
  setVolume?(kind: VolumeKind, value: number): Promise<void>;
  streamingStatus?(): Promise<StreamingStatus>;
  onlineUsers?(): Promise<OnlineUser[]>;
}

class NotSupported extends Error {}

/** Call an optional action; NotSupported when the driver doesn't have it. */
function optional<T>(fn: (() => Promise<T>) | undefined): Promise<T> {
  return fn ? fn() : Promise.reject(new NotSupported('not supported by this door station type'));
}

/** The device answered "not supported / not allowed" (as opposed to being unreachable). */
function isUnsupported(err: unknown): boolean {
  if (err instanceof NotSupported) return true;
  const status = (err as { status?: number }).status;
  return status !== undefined && status >= 400 && status < 500 && status !== 401;
}

export function connectionStates(streams: StreamingStatus | undefined, users: OnlineUser[] | undefined) {
  const out: Partial<Record<ConnectionSensor, { state: string; attributes: string }>> = {};
  if (streams) out.video_streams = { state: String(streams.total), attributes: JSON.stringify({ clients: streams.clients }) };
  if (users) {
    const clients = users.map((u) =>
      [u.name ?? '?', u.address && `from ${u.address}`, u.loginTime && `since ${u.loginTime}`].filter(Boolean).join(' '),
    );
    out.logged_in_clients = { state: String(users.length), attributes: JSON.stringify({ clients }) };
  }
  return out;
}

export interface BridgeOptions {
  client: MqttClient;
  id: string;
  name: string;
  configurationUrl?: string;
  /** With `manufacturer` filled in. */
  deviceInfo: DeviceInfo;
  /** The driver has two-way audio. */
  talkback: boolean;
  doors: number;
  version: string;
  /** Entity names. Default en. */
  language?: Language;
  actions: BridgeActions;
  log: Logger;
  /** Remembers the published components so ones that disappear (e.g. fewer doors) are removed. */
  stateFile?: string;
}

export class HomeAssistantBridge {
  private readonly o: BridgeOptions;
  private readonly t: ReturnType<typeof topics>;
  private readonly cmdPrefix: string;
  /** Volume controls the door station supports; undefined until it has been asked. */
  private volumeKinds?: VolumeKind[];
  /** …and what was published last run, used until then (so restarts don't remove the sliders). */
  private readonly previousVolumeKinds: VolumeKind[];
  private volumes: AudioVolumes = {};
  /** Same for the connection sensors. */
  private connectionKinds?: ConnectionSensor[];
  private readonly previousConnectionKinds: ConnectionSensor[];
  private connections: Partial<Record<ConnectionSensor, { state: string; attributes: string }>> = {};
  private connectionsTimer?: NodeJS.Timeout;
  private online = false;
  private callStatus?: CallState;
  private talking = false;
  private liveViews = 0;
  private paired?: boolean;
  private snapshot?: Buffer;
  private wantInitialSnapshot = true;
  private volumeTimer?: NodeJS.Timeout;
  private birthTimer?: NodeJS.Timeout;
  private announced = false;

  constructor(opts: BridgeOptions) {
    this.o = opts;
    this.t = topics(opts.id);
    this.cmdPrefix = this.t.command('');
    const published = this.loadPublished();
    this.previousVolumeKinds = VOLUME_KINDS.filter((k) => `${k}_volume` in published);
    this.previousConnectionKinds = CONNECTION_SENSORS.filter((k) => k in published);
    opts.client.on('connect', () => this.onConnect());
    opts.client.on('message', (m) => this.onMessage(m));
    opts.client.subscribe(this.t.command('+'), this.t.birth);
  }

  get topics(): ReturnType<typeof topics> {
    return this.t;
  }

  start(): void {
    this.o.client.connect();
    this.volumeTimer = setInterval(() => {
      if (this.online) void this.refreshVolumes();
    }, VOLUME_REFRESH_MS);
    this.connectionsTimer = setInterval(() => {
      if (this.online && this.o.client.connected) void this.refreshConnections();
    }, CONNECTIONS_REFRESH_MS);
  }

  async stop(): Promise<void> {
    if (this.volumeTimer) clearInterval(this.volumeTimer);
    if (this.connectionsTimer) clearInterval(this.connectionsTimer);
    if (this.birthTimer) clearTimeout(this.birthTimer);
    this.publish(this.t.bridge, 'offline', true);
    await this.o.client.end();
  }

  // --- state from the rest of the add-on ---------------------------------------

  setOnline(online: boolean): void {
    this.online = online;
    this.publish(this.t.station, online ? 'online' : 'offline', true);
    if (online) this.whenReady();
  }

  setCallStatus(status: CallState): void {
    this.callStatus = status;
    this.publish(this.t.callState, status, true);
  }

  ring(): void {
    this.publish(this.t.doorbell, JSON.stringify({ event_type: 'ring' }));
    this.updateSnapshot(false, 'ring');
  }

  setTalking(talking: boolean): void {
    this.talking = talking;
    this.publish(this.t.talking, talking ? 'ON' : 'OFF', true);
  }

  setLiveViews(count: number): void {
    this.liveViews = count;
    this.publish(this.t.liveViews, String(count), true);
  }

  setPaired(paired: boolean): void {
    this.paired = paired;
    this.publish(this.t.paired, paired ? 'ON' : 'OFF', true);
  }

  // --- MQTT ----------------------------------------------------------------------

  private publish(topic: string, payload: string | Buffer, retain = false): boolean {
    return this.o.client.publish(topic, payload, { retain });
  }

  private onConnect(): void {
    this.publishDiscovery();
    this.publish(this.t.bridge, 'online', true);
    this.publishStates();
    if (!this.announced) {
      this.announced = true;
      this.o.log.info(`connected to MQTT broker ${this.o.client.address}; published Home Assistant device "${this.o.name}"`);
    } else {
      this.o.log.info(`reconnected to MQTT broker ${this.o.client.address}`);
    }
    this.whenReady();
  }

  /** Things that need both the broker and the door station: volume support, a first snapshot. */
  private whenReady(): void {
    if (!this.o.client.connected || !this.online) return;
    if (this.volumeKinds === undefined) void this.refreshVolumes();
    if (this.connectionKinds === undefined) void this.refreshConnections();
    if (this.wantInitialSnapshot) {
      this.wantInitialSnapshot = false;
      this.updateSnapshot(false, 'startup');
    }
  }

  private discoveryInput(): DiscoveryInput {
    const { id, name, configurationUrl, deviceInfo, actions, version } = this.o;
    return {
      id,
      name,
      configurationUrl,
      deviceInfo,
      doors: actions.openDoor ? this.o.doors : 0,
      commands: {
        hangUp: Boolean(actions.hangUp),
        reject: Boolean(actions.rejectCall),
        restart: Boolean(actions.reboot),
        testRing: Boolean(actions.testRing),
      },
      talkback: this.o.talkback,
      version,
      language: this.o.language,
      volumes: this.volumeKinds ?? this.previousVolumeKinds,
      connections: this.connectionKinds ?? this.previousConnectionKinds,
    };
  }

  private publishDiscovery(): void {
    const input = this.discoveryInput();
    const current = discoveryComponents(input);
    const previous = this.loadPublished();
    const removed: Record<string, string> = {};
    for (const [key, platform] of Object.entries(previous)) if (!(key in current)) removed[key] = platform;
    if (!this.publish(this.t.discovery, JSON.stringify(discoveryPayload(input, removed)), true)) return;
    if (Object.keys(removed).length) this.o.log.info(`removed Home Assistant entities: ${Object.keys(removed).join(', ')}`);
    this.savePublished(Object.fromEntries(Object.entries(current).map(([k, c]) => [k, c.platform])));
  }

  private loadPublished(): Record<string, string> {
    if (!this.o.stateFile) return {};
    try {
      return (JSON.parse(readFileSync(this.o.stateFile, 'utf8')) as { components?: Record<string, string> }).components ?? {};
    } catch {
      return {};
    }
  }

  private savePublished(components: Record<string, string>): void {
    if (!this.o.stateFile) return;
    try {
      writeFileSync(this.o.stateFile, JSON.stringify({ components }));
    } catch (err) {
      this.o.log.debug(`cannot save ${this.o.stateFile}: ${(err as Error).message}`);
    }
  }

  private publishStates(): void {
    this.publish(this.t.station, this.online ? 'online' : 'offline', true);
    if (this.callStatus !== undefined) this.publish(this.t.callState, this.callStatus, true);
    this.publish(this.t.talking, this.talking ? 'ON' : 'OFF', true);
    this.publish(this.t.liveViews, String(this.liveViews), true);
    if (this.paired !== undefined) this.publish(this.t.paired, this.paired ? 'ON' : 'OFF', true);
    for (const kind of VOLUME_KINDS) {
      const v = this.volumes[kind];
      if (v !== undefined) this.publish(this.t.volume(kind), String(v), true);
    }
    if (this.snapshot) this.publish(this.t.snapshot, this.snapshot, true);
    for (const [sensor, v] of Object.entries(this.connections) as [ConnectionSensor, { state: string; attributes: string }][]) {
      this.publish(this.t.connectionsAttributes(sensor), v.attributes, true);
      this.publish(this.t.connections(sensor), v.state, true);
    }
  }

  private onMessage(m: MqttMessage): void {
    if (m.topic === this.t.birth) {
      // Home Assistant restarted: announce again (spread out, as Home Assistant recommends).
      if (m.retain || m.payload.toString() !== 'online') return;
      if (this.birthTimer) clearTimeout(this.birthTimer);
      this.birthTimer = setTimeout(() => {
        this.publishDiscovery();
        this.publishStates();
      }, 500 + Math.random() * 2000);
      return;
    }
    if (!m.topic.startsWith(this.cmdPrefix)) return;
    const command = m.topic.slice(this.cmdPrefix.length);
    // Clearing a retained message (empty payload) is not a command.
    if (m.payload.length === 0) return;
    if (m.retain) {
      // A command stored on the broker (published with retain) is replayed on every connect:
      // never act on it (it could open the door on each restart), and delete it.
      this.o.log.warn(`ignored and cleared a retained MQTT command "${command}"; publish commands without retain`);
      this.publish(m.topic, '', true);
      return;
    }
    void this.runCommand(command, m.payload.toString('utf8').trim());
  }

  private async runCommand(command: string, payload: string): Promise<void> {
    const { actions, log } = this.o;
    try {
      const door = /^open_door_(\d+)$/.exec(command);
      if (door) {
        const n = Number(door[1]);
        if (n < 1 || n > this.o.doors) throw new Error(`door ${n} is not enabled (option "doors")`);
        await optional(actions.openDoor && (() => actions.openDoor!(n)));
        log.info(`${this.o.doors === 1 ? 'door' : `door ${n}`} opened from Home Assistant`);
        return;
      }
      const volume = /^(speaker|talk|microphone)_volume$/.exec(command);
      if (volume) {
        await this.setVolume(volume[1] as VolumeKind, payload);
        return;
      }
      switch (command) {
        case 'hang_up':
          await optional(actions.hangUp);
          log.info('call hung up from Home Assistant');
          return;
        case 'reject_call':
          await optional(actions.rejectCall);
          log.info('call rejected from Home Assistant');
          return;
        case 'take_snapshot':
          this.updateSnapshot(true, 'requested');
          return;
        case 'test_ring':
          if (!actions.testRing) throw new Error('not supported');
          log.info('test ring from Home Assistant');
          actions.testRing();
          return;
        case 'restart':
          await optional(actions.reboot);
          log.warn('door station restart requested from Home Assistant');
          return;
        default:
          log.debug(`unknown MQTT command "${command}"`);
      }
    } catch (err) {
      log.error(`Home Assistant command "${command}" failed: ${(err as Error).message}`);
    }
  }

  private async setVolume(kind: VolumeKind, payload: string): Promise<void> {
    const value = Number(payload);
    try {
      if (payload === '' || !Number.isFinite(value)) throw new Error(`invalid volume "${payload}"`);
      const v = Math.round(Math.min(VOLUME_MAX, Math.max(0, value)));
      const { setVolume } = this.o.actions;
      await optional(setVolume && (() => setVolume(kind, v)));
      this.o.log.info(`${kind} volume set to ${v} from Home Assistant`);
    } finally {
      // Publish what the device has now, so a failed change snaps the slider back.
      await this.refreshVolumes();
    }
  }

  private async refreshVolumes(): Promise<void> {
    let volumes: AudioVolumes;
    try {
      volumes = this.o.actions.volumes ? await this.o.actions.volumes() : {};
    } catch (err) {
      this.o.log.debug(`reading volumes failed: ${(err as Error).message}`);
      for (const kind of VOLUME_KINDS) {
        const v = this.volumes[kind];
        if (v !== undefined) this.publish(this.t.volume(kind), String(v), true);
      }
      return;
    }
    this.volumes = volumes;
    const kinds = VOLUME_KINDS.filter((k) => volumes[k] !== undefined);
    if (kinds.join() !== this.volumeKinds?.join()) {
      this.volumeKinds = kinds;
      this.publishDiscovery();
    }
    for (const kind of kinds) this.publish(this.t.volume(kind), String(volumes[kind]), true);
  }

  private async refreshConnections(): Promise<void> {
    const { streamingStatus, onlineUsers } = this.o.actions;
    const [streams, users] = await Promise.allSettled([optional(streamingStatus), optional(onlineUsers)]);
    const results: [ConnectionSensor, PromiseSettledResult<unknown>][] = [
      ['video_streams', streams],
      ['logged_in_clients', users],
    ];
    // Unreachable: keep the last values. "Not supported": drop that sensor.
    const known = this.connectionKinds ?? this.previousConnectionKinds;
    const kinds = CONNECTION_SENSORS.filter((sensor) => {
      const r = results.find(([k]) => k === sensor)![1];
      return r.status === 'fulfilled' || (!isUnsupported(r.reason) && known.includes(sensor));
    });
    for (const [sensor, r] of results) {
      if (r.status === 'rejected') this.o.log.debug(`reading ${sensor} failed: ${(r.reason as Error).message}`);
    }
    const allUnreachable = results.every(([, r]) => r.status === 'rejected' && !isUnsupported(r.reason));
    if (!allUnreachable && kinds.join() !== this.connectionKinds?.join()) {
      this.connectionKinds = kinds;
      this.publishDiscovery();
    }
    const fresh = connectionStates(
      streams.status === 'fulfilled' ? streams.value : undefined,
      users.status === 'fulfilled' ? users.value : undefined,
    );
    for (const [sensor, v] of Object.entries(fresh) as [ConnectionSensor, { state: string; attributes: string }][]) {
      const old = this.connections[sensor];
      this.connections[sensor] = v;
      if (old?.attributes !== v.attributes) this.publish(this.t.connectionsAttributes(sensor), v.attributes, true);
      if (old?.state !== v.state) this.publish(this.t.connections(sensor), v.state, true);
    }
  }

  private updateSnapshot(fresh: boolean, reason: string): void {
    const t0 = Date.now();
    this.o.actions.snapshot(fresh).then(
      (jpeg) => {
        this.snapshot = jpeg;
        this.publish(this.t.snapshot, jpeg, true);
        this.o.log.debug(`snapshot (${reason}) published: ${jpeg.length} bytes in ${Date.now() - t0} ms`);
      },
      (err: Error) => this.o.log.warn(`snapshot (${reason}) failed: ${err.message}`),
    );
  }
}
