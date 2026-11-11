import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Aedes } from 'aedes';
import { parseOptions } from '../src/config.ts';
import { callState } from '../src/drivers/hikvision/index.ts';
import type { AudioVolumes, VolumeKind } from '../src/intercom.ts';
import type { Logger } from '../src/log.ts';
import { MqttClient, encodePublish, encodeRemainingLength, readPackets, type MqttMessage } from '../src/mqtt/client.ts';
import {
  CONNECTION_SENSORS,
  HomeAssistantBridge,
  connectionStates,
  deviceId,
  discoveryComponents,
  discoveryPayload,
  topics,
  type BridgeActions,
} from '../src/mqtt/homeAssistant.ts';
import { findBroker } from '../src/mqtt/setup.ts';

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const INFO = { manufacturer: 'Hikvision', model: 'DS-KV6113-WPE1(B)', serialNumber: 'DS-KV6113-WPE1(B)0120210707RRG32043316', macAddress: '24:28:fd:4d:33:b0', firmwareVersion: 'V2.2.53' };

async function waitFor<T>(fn: () => T | undefined, what: string, ms = 3000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('MQTT codec', () => {
  it('encodes the remaining length at the variable-length boundaries', () => {
    assert.deepEqual([...encodeRemainingLength(0)], [0]);
    assert.deepEqual([...encodeRemainingLength(127)], [0x7f]);
    assert.deepEqual([...encodeRemainingLength(128)], [0x80, 0x01]);
    assert.deepEqual([...encodeRemainingLength(16383)], [0xff, 0x7f]);
    assert.deepEqual([...encodeRemainingLength(2097152)], [0x80, 0x80, 0x80, 0x01]);
  });

  it('reassembles packets split across reads, including large ones', () => {
    const big = encodePublish('a/b', Buffer.alloc(300_000, 7), true);
    const small = encodePublish('c', 'x');
    const all = Buffer.concat([small, big, small]);
    const out: { type: number; flags: number; body: Buffer }[] = [];
    let rest = Buffer.alloc(0);
    for (let i = 0; i < all.length; i += 4093) {
      const r = readPackets(Buffer.concat([rest, all.subarray(i, i + 4093)]));
      out.push(...r.packets);
      rest = Buffer.from(r.rest);
    }
    assert.equal(rest.length, 0);
    assert.deepEqual(out.map((p) => [p.type, p.flags, p.body.length]), [[3, 0, 4], [3, 1, 300_005], [3, 0, 4]]);
  });
});

describe('MQTT client and Home Assistant bridge (aedes broker)', () => {
  let broker: Aedes;
  let server: net.Server;
  let port: number;
  let dir: string;
  const retained = new Map<string, Buffer>();

  before(async () => {
    broker = await Aedes.createBroker();
    broker.authenticate = (_client, username, password, cb) => cb(null, username === 'addons' && password?.toString() === 's3cret');
    broker.on('publish', (packet) => {
      if (packet.retain) retained.set(packet.topic, Buffer.from(packet.payload as Buffer));
    });
    server = net.createServer(broker.handle as (s: net.Socket) => void);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as net.AddressInfo).port;
    dir = mkdtempSync(join(tmpdir(), 'hik-mqtt-'));
  });

  after(async () => {
    await new Promise<void>((r) => broker.close(() => r()));
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const client = (clientId: string, extra: Partial<ConstructorParameters<typeof MqttClient>[0]> = {}) =>
    new MqttClient({ host: '127.0.0.1', port, username: 'addons', password: 's3cret', clientId, keepaliveSec: 10, ...extra });

  it('rejects bad credentials without reconnecting in a tight loop', async () => {
    const c = client('bad', { password: 'nope' });
    const errors: string[] = [];
    c.on('error', (e) => errors.push(e.message));
    c.connect();
    await waitFor(() => errors.length > 0, 'CONNACK error');
    assert.match(errors[0], /not authorized|bad username/);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(errors.length, 1, 'backs off after an auth failure');
    await c.end();
  });

  it('falls back to another host when the broker hostname does not resolve', async () => {
    const c = client('fallback', { host: 'core-mosquitto.invalid', fallbackHosts: ['127.0.0.1'] });
    c.on('error', () => {});
    c.connect();
    await waitFor(() => c.connected, 'connection via fallback', 5000);
    assert.equal(c.address, `127.0.0.1:${port}`);
    await c.end();
  });

  it('publishes, subscribes, flags retained deliveries and sends the will on a dropped connection', async () => {
    const a = client('a', { will: { topic: 'test/a/status', payload: 'offline', retain: true } });
    const b = client('b');
    const got: MqttMessage[] = [];
    b.on('message', (m) => got.push(m));
    a.connect();
    await waitFor(() => a.connected, 'a connected');
    a.publish('test/kept', 'stored', { retain: true });
    await waitFor(() => retained.get('test/kept'), 'retained message');
    b.subscribe('test/#');
    b.connect();
    await waitFor(() => got.find((m) => m.topic === 'test/kept'), 'retained delivery');
    assert.equal(got.find((m) => m.topic === 'test/kept')!.retain, true);
    a.publish('test/live', Buffer.from([1, 2, 3]));
    const live = await waitFor(() => got.find((m) => m.topic === 'test/live'), 'live message');
    assert.equal(live.retain, false);
    assert.deepEqual([...live.payload], [1, 2, 3]);

    // Kill a's socket without DISCONNECT: the broker must publish its will.
    (a as unknown as { socket: net.Socket }).socket.destroy();
    const will = await waitFor(() => got.find((m) => m.topic === 'test/a/status'), 'last will');
    assert.equal(will.payload.toString(), 'offline');
    // …and a reconnects by itself, re-subscribing nothing but working again.
    await waitFor(() => a.connected, 'a reconnected', 4000);
    await Promise.all([a.end(), b.end()]);
  });

  it('publishes the device, mirrors state and runs commands from Home Assistant', async () => {
    const calls: string[] = [];
    let volumes: AudioVolumes = { speaker: 7, talk: 8, microphone: 8 };
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    let ringBridge: HomeAssistantBridge | undefined;
    const actions: BridgeActions = {
      openDoor: async (door) => void calls.push(`open ${door}`),
      testRing: () => {
        calls.push('test ring');
        ringBridge?.ring(); // in the add-on: intercom 'ring' → bridge.ring(), HomeKit, snapshots
      },
      hangUp: async () => void calls.push('signal hangUp'),
      rejectCall: async () => void calls.push('signal reject'),
      reboot: async () => void calls.push('reboot'),
      snapshot: async (fresh) => {
        calls.push(`snapshot ${fresh}`);
        return jpeg;
      },
      volumes: async () => ({ ...volumes }),
      setVolume: async (kind: VolumeKind, value: number) => {
        calls.push(`volume ${kind} ${value}`);
        volumes = { ...volumes, [kind]: value };
      },
      streamingStatus: async () => ({ total: 2, clients: ['10.0.8.112'] }),
      onlineUsers: async () => [{ name: 'admin', type: 'admin', address: '172.30.33.5', loginTime: '2026-11-01 13:18:46' }],
    };
    const stateFile = join(dir, 'mqtt-discovery.json');
    const mk = (doors: number) =>
      new HomeAssistantBridge({
        client: client(`bridge${doors}`, { will: { topic: topics('2428fd4d33b0').bridge, payload: 'offline', retain: true } }),
        id: '2428fd4d33b0',
        name: 'Doorbell',
        configurationUrl: 'http://192.168.88.21/',
        deviceInfo: INFO,
        talkback: true,
        doors,
        version: '0.4.0',
        actions,
        log: quiet,
        stateFile,
      });
    const t = topics('2428fd4d33b0');
    const bridge = mk(2);
    ringBridge = bridge;
    bridge.setOnline(true);
    bridge.setCallStatus('idle');
    bridge.start();

    const discovery = () => JSON.parse(retained.get(t.discovery)?.toString() ?? '{}') as { components?: Record<string, Record<string, unknown>> };
    await waitFor(() => discovery().components?.speaker_volume, 'discovery with volume sliders');
    const cmps = discovery().components!;
    assert.ok(cmps.open_door_1 && cmps.open_door_2 && cmps.doorbell && cmps.snapshot);
    assert.equal(retained.get(t.bridge)?.toString(), 'online');
    assert.equal(retained.get(t.station)?.toString(), 'online');
    assert.equal(retained.get(t.callState)?.toString(), 'idle');
    assert.equal(retained.get(t.volume('talk'))?.toString(), '8');
    await waitFor(() => retained.get(t.snapshot), 'startup snapshot');
    await waitFor(() => discovery().components?.logged_in_clients, 'connection sensors');
    await waitFor(() => retained.get(t.connections('logged_in_clients')), 'logged-in clients');
    assert.equal(retained.get(t.connections('video_streams'))?.toString(), '2');
    assert.deepEqual(JSON.parse(retained.get(t.connectionsAttributes('video_streams'))!.toString()), { clients: ['10.0.8.112'] });
    assert.equal(retained.get(t.connections('logged_in_clients'))?.toString(), '1');
    assert.deepEqual(JSON.parse(retained.get(t.connectionsAttributes('logged_in_clients'))!.toString()), {
      clients: ['admin from 172.30.33.5 since 2026-11-01 13:18:46'],
    });

    // Home Assistant's side.
    const ha = client('homeassistant');
    const seen: MqttMessage[] = [];
    ha.on('message', (m) => seen.push(m));
    ha.subscribe(t.doorbell);
    ha.connect();
    await waitFor(() => ha.connected, 'HA connected');

    ha.publish(t.command('open_door_2'), 'PRESS');
    ha.publish(t.command('hang_up'), 'PRESS');
    ha.publish(t.command('reject_call'), 'PRESS');
    ha.publish(t.command('restart'), 'PRESS');
    ha.publish(t.command('talk_volume'), '12.0'); // clamped to 10
    ha.publish(t.command('open_door_3'), 'PRESS'); // not enabled: refused
    await waitFor(() => calls.includes('volume talk 10'), 'volume command');
    await waitFor(() => retained.get(t.volume('talk'))?.toString() === '10', 'volume state after set');
    assert.deepEqual(
      calls.filter((c) => !c.startsWith('snapshot')),
      ['open 2', 'signal hangUp', 'signal reject', 'reboot', 'volume talk 10'],
    );

    // A command published with retain runs once (live delivery has retain=0, per MQTT 3.1.1)…
    calls.length = 0;
    ha.publish(t.command('open_door_1'), 'PRESS', { retain: true });
    await waitFor(() => calls.includes('open 1'), 'live retained command');
    calls.length = 0;

    // Ring (here from the Test ring button): event (not retained) + new snapshot.
    assert.equal(discovery().components?.test_ring?.entity_category, 'config', 'on the device page under Configuration');
    ha.publish(t.command('test_ring'), 'PRESS');
    const ring = await waitFor(() => seen.find((m) => m.topic === t.doorbell), 'ring event');
    assert.ok(calls.includes('test ring'));
    assert.deepEqual(JSON.parse(ring.payload.toString()), { event_type: 'ring' });
    assert.equal(ring.retain, false);
    await waitFor(() => calls.includes('snapshot false'), 'ring snapshot');

    bridge.setCallStatus(callState('onCall'));
    await waitFor(() => retained.get(t.callState)?.toString() === 'on_call', 'call state');
    bridge.setTalking(true);
    bridge.setLiveViews(2);
    bridge.setPaired(true);
    await waitFor(() => retained.get(t.liveViews)?.toString() === '2', 'live views');
    assert.equal(retained.get(t.talking)?.toString(), 'ON');
    assert.equal(retained.get(t.paired)?.toString(), 'ON');

    await bridge.stop();
    assert.equal(retained.get(t.bridge)?.toString(), 'offline');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(stateFile, 'utf8')).components).sort(), Object.keys(cmps).sort());

    // Restart with one door (and a model without the logged-in list): door 2 is removed at once,
    // volume sliders are kept from the first publish on, logged-in clients is removed once known.
    actions.onlineUsers = async () => {
      throw Object.assign(new Error('HTTP 404: Invalid Operation'), { status: 404 });
    };
    const firstPublish: Record<string, Record<string, unknown>>[] = [];
    const watcher = (packet: { topic: string; payload: unknown }) => {
      if (packet.topic === t.discovery) firstPublish.push(JSON.parse(String(packet.payload)).components);
    };
    broker.on('publish', watcher);
    const bridge1 = mk(1);
    bridge1.setOnline(true);
    bridge1.start();
    await waitFor(() => firstPublish.length > 0, 'discovery after restart');
    assert.deepEqual(firstPublish[0].open_door_2, { platform: 'button' }, 'door 2 removal stub');
    assert.ok(firstPublish[0].speaker_volume?.command_topic, 'sliders not removed while volume support is re-checked');
    assert.ok(firstPublish[0].logged_in_clients?.state_topic, 'kept until the device says it is unsupported');
    await waitFor(() => firstPublish.find((c) => c.logged_in_clients?.platform && !c.logged_in_clients.state_topic), 'removal of logged-in clients');
    assert.ok(firstPublish.at(-1)!.video_streams?.state_topic, 'video streams stays');
    broker.off('publish', watcher);
    // …but is never replayed from the broker's store on (re)connect, and gets cleared.
    await waitFor(() => retained.get(t.command('open_door_1'))?.length === 0, 'retained command cleared');
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!calls.includes('open 1'), `stored command must not run: ${calls}`);
    await bridge1.stop();
    await ha.end();
  });
});

describe('Home Assistant discovery payload', () => {
  const input = { id: '2428fd4d33b0', name: 'Doorbell', configurationUrl: 'http://192.168.88.21/', deviceInfo: INFO, doors: 1, commands: { hangUp: true, reject: true, restart: true, testRing: true }, talkback: true, version: '0.4.0', volumes: ['speaker', 'talk', 'microphone'] as VolumeKind[], connections: CONNECTION_SENSORS };

  it('describes the device and gives every entity a platform and a unique id', () => {
    const p = discoveryPayload(input) as { device: Record<string, unknown>; origin: Record<string, unknown>; components: Record<string, Record<string, unknown>> };
    assert.deepEqual(p.device.identifiers, ['hikvision_homekit_2428fd4d33b0']);
    assert.deepEqual(p.device.connections, [['mac', '24:28:fd:4d:33:b0']]);
    assert.equal(p.device.configuration_url, 'http://192.168.88.21/');
    assert.equal(p.origin.name, 'Intercom Doorbell for HomeKit');
    const cmps = Object.values(p.components);
    assert.equal(new Set(cmps.map((c) => c.unique_id)).size, cmps.length);
    for (const c of cmps) {
      assert.ok(c.platform && c.unique_id && c.availability, JSON.stringify(c));
      for (const k of ['state_topic', 'command_topic', 'image_topic']) {
        if (c[k] !== undefined) assert.match(String(c[k]), /^hikvision_homekit\/2428fd4d33b0\/[a-z_/0-9]+$/);
      }
    }
    assert.deepEqual(Object.keys(p.components).sort(), [
      'call_state', 'connection', 'doorbell', 'hang_up', 'homekit_paired', 'live_views', 'logged_in_clients', 'microphone_volume',
      'open_door_1', 'reject_call', 'restart', 'snapshot', 'speaker_volume', 'take_snapshot', 'talk_back', 'talk_volume',
      'test_ring', 'video_streams',
    ]);
    assert.equal(p.components.doorbell.name, null, 'doorbell event takes the device name');
    assert.equal(p.components.open_door_1.name, 'Open door');
  });

  it('drops door buttons with doors: 0 and volume sliders the device lacks', () => {
    const keys = Object.keys(discoveryComponents({ ...input, doors: 0, volumes: ['speaker'] }));
    assert.ok(!keys.some((k) => k.startsWith('open_door')));
    assert.ok(keys.includes('speaker_volume') && !keys.includes('talk_volume'));
  });

  it('turns streams and logins into sensor states with client lists', () => {
    const c = connectionStates({ total: 3, clients: ['10.0.8.112', '10.0.8.100'] }, [{ name: 'admin', address: '192.168.88.1' }, {}]);
    assert.deepEqual(c.video_streams, { state: '3', attributes: '{"clients":["10.0.8.112","10.0.8.100"]}' });
    assert.deepEqual(JSON.parse(c.logged_in_clients!.attributes), { clients: ['admin from 192.168.88.1', '?'] });
    assert.deepEqual(connectionStates(undefined, undefined), {});
  });

  it('maps call states and device ids', () => {
    assert.equal(callState('ring'), 'ringing');
    assert.equal(callState('onCall'), 'on_call');
    assert.equal(callState('somethingNew'), 'somethingNew');
    assert.equal(deviceId(INFO), '2428fd4d33b0');
    assert.equal(deviceId({ serialNumber: 'DS-KV6113(B)012' }), 'dskv6113b012');
    assert.equal(deviceId({}), undefined);
  });
});

describe('MQTT broker lookup', () => {
  const config = parseOptions({}, {}).mqtt;

  it('prefers the add-on options', async () => {
    const b = await findBroker({ ...config, host: '10.0.0.5', port: 1884, username: 'u', password: 'p' }, {});
    assert.deepEqual(b, { host: '10.0.0.5', port: 1884, ssl: false, username: 'u', password: 'p', source: 'add-on options' });
  });

  it('asks the Supervisor for the Mosquitto add-on, and copes without it', async () => {
    assert.equal(await findBroker(config, {}), undefined, 'not running under the Supervisor');
    const realFetch = globalThis.fetch;
    try {
      let auth = '';
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        auth = (init.headers as Record<string, string>).Authorization;
        return Response.json({ result: 'ok', data: { addon: 'core_mosquitto', host: 'core-mosquitto', port: 1883, ssl: false, protocol: '3.1.1', username: 'addons', password: 'pw' } });
      }) as typeof fetch;
      const b = await findBroker(config, { SUPERVISOR_TOKEN: 'tok' });
      assert.equal(auth, 'Bearer tok');
      assert.deepEqual(b, { host: 'core-mosquitto', port: 1883, ssl: false, username: 'addons', password: 'pw', source: 'core_mosquitto add-on' });
      globalThis.fetch = (async () => Response.json({ result: 'error', message: 'Service not enabled' }, { status: 400 })) as typeof fetch;
      assert.equal(await findBroker(config, { SUPERVISOR_TOKEN: 'tok' }), undefined);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
