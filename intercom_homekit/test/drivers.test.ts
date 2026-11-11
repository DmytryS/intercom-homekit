/**
 * The driver contract: every registered driver is reachable from the options, and the core works
 * with a driver that implements only the required parts (as a new brand's first version might).
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { Service } from 'hap-nodejs';
import { parseOptions } from '../src/config.ts';
import type { IsapiClient } from '../src/drivers/hikvision/isapi.ts';
import { Talkback } from '../src/drivers/hikvision/talkback.ts';
import { DEFAULT_DRIVER, DRIVERS } from '../src/drivers/index.ts';
import { createDoorbellAccessory } from '../src/homekit/doorbell.ts';
import type { DeviceInfo, Driver, Intercom, IntercomEvents } from '../src/intercom.ts';
import { SnapshotCache } from '../src/media/snapshots.ts';
import { discoveryComponents } from '../src/mqtt/homeAssistant.ts';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** The smallest useful driver: device info, reachability, rings and a stream. */
class MinimalIntercom extends EventEmitter<IntercomEvents> implements Intercom {
  online = true;
  start(): void {}
  async close(): Promise<void> {}
  async deviceInfo(): Promise<DeviceInfo> {
    return { model: 'Model X', macAddress: '02:00:00:00:00:01' };
  }
}

const minimal: Driver<{ path: string }> = {
  id: 'minimal',
  name: 'Acme',
  parseOptions: (entry) => ({ path: typeof entry.stream_path === 'string' ? entry.stream_path : '/live' }),
  streamUrl: ({ host }, o) => `rtsp://${host}${o.path}`,
  create: () => new MinimalIntercom(),
};

describe('driver registry', () => {
  it('lists every driver in config.yaml and the translations, and defaults to Hikvision', () => {
    const yaml = readFileSync(new URL('../config.yaml', import.meta.url), 'utf8');
    const schema = /^\s+type: list\(([^)]*)\)\?$/m.exec(yaml);
    assert.ok(schema, 'doorbells[].type in the schema');
    assert.deepEqual(schema[1].split('|').sort(), Object.keys(DRIVERS).sort());
    assert.equal(DEFAULT_DRIVER, 'hikvision');
    for (const [id, d] of Object.entries(DRIVERS)) assert.equal(d.id, id);
    assert.match(readFileSync(new URL('../translations/en.yaml', import.meta.url), 'utf8'), /^ {6}type:$/m);
  });

  it('picks the driver by type and rejects unknown ones', () => {
    const c = parseOptions({ doorbells: [{ name: 'A', host: 'h', password: 'p' }, { name: 'B', host: 'h2', password: 'p', type: 'acme' }] }, {});
    assert.equal(c.doorbells[0].type, 'hikvision');
    assert.match(c.errors[0], /"B": "type" must be one of hikvision/);
  });

  it('uses the driver for options and the default stream', () => {
    DRIVERS.minimal = minimal;
    try {
      const c = parseOptions({ doorbells: [{ name: 'A', type: 'minimal', host: '10.0.0.9', password: 'p', stream_path: '/main' }] }, {});
      assert.deepEqual(c.errors, []);
      assert.equal(c.doorbells[0].rtspUrl, 'rtsp://10.0.0.9/main');
      assert.deepEqual(c.doorbells[0].driverOptions, { path: '/main' });
    } finally {
      delete DRIVERS.minimal;
    }
  });
});

describe('core with a minimal driver', () => {
  const config = parseOptions({ doorbells: [{ name: 'Gate', host: '10.0.0.9', password: 'p' }] }, {}).doorbells[0];

  it('makes a HomeKit doorbell without lock tiles or two-way audio', () => {
    const intercom = new MinimalIntercom();
    const snapshots = new SnapshotCache({ grabFrame: async () => Buffer.from([0xff, 0xd8]), log: quiet });
    const { accessory, controller, shutdown } = createDoorbellAccessory({
      config,
      identity: { username: '0E:00:00:00:00:01', pincode: '031-45-154', setupId: 'ABCD' },
      intercom,
      deviceInfo: { manufacturer: 'Acme', model: 'Model X' },
      snapshots,
      media: () => undefined,
    });
    assert.equal(accessory.getService(Service.LockMechanism), undefined, 'no openDoor, no lock tile');
    let rang = 0;
    controller.ringDoorbell = () => void rang++;
    intercom.emit('ring');
    assert.equal(rang, 1);
    shutdown();
  });

  it('publishes no Home Assistant controls the driver lacks', () => {
    const keys = Object.keys(
      discoveryComponents({
        id: 'x',
        name: 'Gate',
        deviceInfo: { manufacturer: 'Acme' },
        doors: 0,
        commands: { hangUp: false, reject: false, restart: false },
        talkback: false,
        version: '0',
        volumes: [],
        connections: [],
      }),
    ).sort();
    assert.deepEqual(keys, ['call_state', 'connection', 'doorbell', 'homekit_paired', 'live_views', 'snapshot', 'take_snapshot']);
  });
});

describe('Hikvision driver', () => {
  it('reports a talk-back helper that cannot start instead of crashing', async () => {
    const tb = new Talkback({
      sdkDir: '/nonexistent-sdk-dir',
      host: '127.0.0.1',
      port: 8000,
      username: 'u',
      password: 'p',
      isapi: {} as IsapiClient,
      ringAction: 'none',
      log: quiet,
    });
    await assert.rejects(tb.check(), /SDK helper failed to start/);
  });
});

describe('example driver (the template for new brands)', () => {
  it('detects rings, opens the door and reports auth failures, against a fake device', async () => {
    const { createServer } = await import('node:http');
    const { example } = await import('../src/drivers/example/index.ts');
    const { isAuthError } = await import('../src/intercom.ts');
    let state = 'idle';
    const opened: string[] = [];
    const server = createServer((req, res) => {
      if (req.headers.authorization !== `Basic ${Buffer.from('admin:secret').toString('base64')}`) return void res.writeHead(401).end();
      if (req.url === '/api/info') return void res.end(JSON.stringify({ model: 'X1', mac: '02:00:00:00:00:02' }));
      if (req.url === '/api/call') return void res.end(JSON.stringify({ state }));
      if (req.method === 'POST' && req.url?.startsWith('/api/door/')) {
        opened.push(req.url);
        return void res.writeHead(204).end();
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const entry = { name: 'X', host: '127.0.0.1', username: 'admin', password: 'secret', http_port: port };
      DRIVERS.example = example;
      const config = parseOptions({ doorbells: [{ ...entry, type: 'example' }] }, {}).doorbells[0];
      delete DRIVERS.example;
      const options = { ...(config.driverOptions as object), pollMs: 10 } as Parameters<typeof example.create>[1];
      const intercom = example.create(config, options, () => quiet);
      let rings = 0;
      intercom.on('ring', () => rings++);
      intercom.start();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(intercom.online, true);
      state = 'ringing';
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(rings, 1);
      assert.equal(intercom.callState, 'ringing');
      assert.equal((await intercom.deviceInfo()).model, 'X1');
      await intercom.openDoor!(1);
      assert.deepEqual(opened, ['/api/door/1/open']);
      await intercom.close();

      const wrong = example.create({ ...config, password: 'nope' }, options, () => quiet);
      await assert.rejects(wrong.deviceInfo(), (err) => isAuthError(err));
    } finally {
      delete DRIVERS.example;
      server.close();
    }
  });
});
