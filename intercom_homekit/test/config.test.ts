import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { hasConfiguredDoorbell, homekitPorts, isLegacyOptions, migrateOptions, parseOptions, slug } from '../src/config.ts';
import type { HikvisionOptions } from '../src/drivers/hikvision/index.ts';
import { loadIdentities } from '../src/homekit/identity.ts';

// --- A tiny reader for the YAML subset config.yaml uses, and the Supervisor's schema rules ----------

type Yaml = string | number | boolean | Yaml[] | { [k: string]: Yaml };

function scalar(v: string): Yaml {
  if (v === '{}') return {};
  if (v === 'true' || v === 'false') return v === 'true';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.replace(/^"(.*)"$/, '$1');
}

function parseYaml(text: string): Record<string, Yaml> {
  const lines = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  let i = 0;
  const indent = (l: string) => l.length - l.trimStart().length;
  function block(level: number): Yaml {
    if (lines[i].trimStart().startsWith('- ')) {
      const list: Yaml[] = [];
      while (i < lines.length && indent(lines[i]) === level && lines[i].trimStart().startsWith('- ')) {
        const rest = lines[i].trimStart().slice(2);
        if (!rest.includes(': ') && !rest.endsWith(':')) {
          list.push(scalar(rest));
          i++;
          continue;
        }
        lines[i] = ' '.repeat(level + 2) + rest; // "- key: v" → a map starting at level + 2
        list.push(block(level + 2));
      }
      return list;
    }
    const map: Record<string, Yaml> = {};
    while (i < lines.length && indent(lines[i]) === level) {
      const m = /^(\s*)([^:]+):(?:\s+(.*))?$/.exec(lines[i])!;
      i++;
      if (m[3] !== undefined && m[3] !== '>-') map[m[2]] = scalar(m[3]);
      else if (m[3] === '>-') while (i < lines.length && indent(lines[i]) > level) i++;
      else map[m[2]] = i < lines.length && indent(lines[i]) > level ? block(indent(lines[i])) : '';
    }
    return map;
  }
  return block(0) as Record<string, Yaml>;
}

/** The Supervisor's option validation, reduced to what this add-on's schema uses. */
function validate(value: unknown, schema: Yaml, at = 'options'): string[] {
  if (Array.isArray(schema)) {
    if (!Array.isArray(value)) return [`${at}: expected a list`];
    return value.flatMap((v, i) => validate(v, schema[0], `${at}[${i}]`));
  }
  if (typeof schema === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${at}: expected a section`];
    const v = value as Record<string, unknown>;
    const errors = Object.keys(v).filter((k) => !(k in schema)).map((k) => `${at}.${k}: not in the schema`);
    for (const [k, s] of Object.entries(schema)) {
      if (v[k] === undefined) {
        if (!(typeof s === 'string' && s.endsWith('?'))) errors.push(`${at}.${k}: missing`);
      } else errors.push(...validate(v[k], s, `${at}.${k}`));
    }
    return errors;
  }
  const type = String(schema).replace(/\?$/, '');
  const ok =
    type === 'str' || type === 'password' ? typeof value === 'string'
    : type === 'bool' ? typeof value === 'boolean'
    : type === 'port' ? Number.isInteger(value) && (value as number) > 0 && (value as number) < 65536
    : type.startsWith('int') ? Number.isInteger(value)
    : type.startsWith('float') ? typeof value === 'number'
    : type.startsWith('list(') ? type.slice(5, -1).split('|').includes(String(value))
    : type.startsWith('match(') ? new RegExp(type.slice(6, -1)).test(String(value))
    : false;
  return ok ? [] : [`${at}: ${JSON.stringify(value)} is not ${type}`];
}

const addon = parseYaml(readFileSync(new URL('../config.yaml', import.meta.url), 'utf8'));

const LEGACY = {
  name: 'Front door',
  host: '192.168.88.21',
  username: 'admin',
  password: 'secret',
  ring_action: 'reject',
  talk_gain: 2.5,
  mqtt: true,
  log_level: 'debug',
  homekit_pin: '058-47-886',
  doors: 2,
  talk_idle_seconds: 5,
  homekit_port: 51900,
  homekit_bind: 'eth0',
  mqtt_host: '10.0.0.5',
  mqtt_password: 'mq',
  video_transcode: true,
};

describe('options schema (config.yaml)', () => {
  it('the defaults are valid (and the checker does catch mistakes)', () => {
    assert.deepEqual(validate(addon.options, addon.schema), []);
    const o = addon.options as Record<string, Yaml>;
    assert.deepEqual(validate({ ...o, talk_gain: 1 }, addon.schema), ['options.talk_gain: not in the schema']);
    assert.deepEqual(validate({ ...o, doorbells: [{ name: 'x', host: 'h', username: 'u' }] }, addon.schema), ['options.doorbells[0].password: missing']);
    assert.deepEqual(validate({ ...o, talkback: { ring_action: 'loud', gain: 1 } }, addon.schema), ['options.talkback.ring_action: "loud" is not list(hangUp|reject|answer_hangup|none)']);
    const { video: _v, ...noVideo } = o;
    assert.deepEqual(validate(noVideo, addon.schema), ['options.video: missing']);
  });

  it('options converted from the old flat format are valid, so the Supervisor accepts them', () => {
    const migrated = migrateOptions(LEGACY);
    assert.deepEqual(validate(migrated, addon.schema), []);
    assert.deepEqual(validate(migrateOptions({ name: 'Doorbell', host: 'h', username: 'admin', password: 'p', ring_action: 'hangUp', talk_gain: 1.5, mqtt: true, log_level: 'info' }), addon.schema), []);
  });

  it('every option has a translation', () => {
    const tr = readFileSync(new URL('../translations/en.yaml', import.meta.url), 'utf8');
    const schema = addon.schema as Record<string, Yaml>;
    for (const [section, s] of Object.entries(schema)) {
      assert.match(tr, new RegExp(`\\n  ${section}:\\n`), section);
      const fields = Array.isArray(s) ? (s[0] as Record<string, Yaml>) : (s as Record<string, Yaml>);
      for (const f of Object.keys(fields)) assert.match(tr, new RegExp(`\\n      ${f}:\\n`), `${section}.${f}`);
    }
  });
});

describe('parseOptions', () => {
  it('reads several doorbells with shared settings and gives each its own HomeKit port', () => {
    const c = parseOptions(
      {
        doorbells: [
          { name: 'Front door', host: '192.168.88.21', username: 'admin', password: 'a', doors: 2 },
          { name: 'Gate', host: '192.168.88.22', username: 'admin', password: 'b', rtsp_url: 'rtsp://go2rtc:8554/gate' },
          { name: 'Back', host: '192.168.88.23', username: 'user', password: 'c', homekit_pin: '058-47-886' },
        ],
        talkback: { ring_action: 'reject', gain: 3 },
        video: { max_streams: 3 },
        homekit: { port: 51828 },
        mqtt: { enabled: false },
        system: { log_level: 'debug', call_poll_interval: 0.5 },
      },
      {},
    );
    assert.deepEqual(c.errors, []);
    assert.deepEqual(c.doorbells.map((d) => d.homekitPort), [51828, 51829, 51831], 'skips the web UI port 51830');
    assert.deepEqual(c.doorbells.map((d) => d.label), ['Front door', 'Gate', 'Back']);
    assert.deepEqual(c.doorbells.map((d) => d.key), ['front-door', 'gate', 'back']);
    assert.deepEqual(c.doorbells.map((d) => d.doors), [2, 1, 1]);
    assert.ok(c.doorbells.every((d) => d.talkGain === 3 && d.maxStreams === 3));
    assert.ok(c.doorbells.every((d) => { const o = d.driverOptions as HikvisionOptions; return o.ringAction === 'reject' && o.callPollMs === 500; }));
    assert.equal(c.doorbells[1].rtspUrl, 'rtsp://go2rtc:8554/gate');
    assert.equal(c.doorbells[2].rtspUrl, 'rtsp://user:c@192.168.88.23:554/Streaming/Channels/101');
    assert.equal(c.doorbells[2].homekitPin, '058-47-886');
    assert.equal(c.mqtt.enabled, false);
    assert.equal(c.logLevel, 'debug');
  });

  it('skips broken doorbells with a reason and keeps the rest', () => {
    const c = parseOptions(
      {
        doorbells: [
          { name: 'Doorbell', host: '', username: 'admin', password: '' },
          { name: 'Front', host: '192.168.88.21', username: 'admin', password: 'a' },
          { name: 'front', host: '192.168.88.22', username: 'admin', password: 'b' },
          { name: 'Gate', host: '192.168.88.23', username: 'admin', password: '' },
          { name: 'Back', host: '192.168.88.24', username: 'admin', password: 'c', homekit_pin: '1234' },
        ],
      },
      {},
    );
    assert.deepEqual(c.doorbells.map((d) => d.name), ['Front']);
    assert.equal(c.doorbells[0].label, undefined, 'no log prefix with a single doorbell');
    assert.equal(c.errors.length, 4);
    assert.match(c.errors[0], /"Doorbell": not configured yet/);
    assert.match(c.errors[1], /"front": .*must be unique/);
    assert.match(c.errors[2], /"Gate": "password" is required/);
    assert.match(c.errors[3], /"Back": "homekit_pin"/);
  });

  it('still reads the old flat options, with the same result as the converted ones', () => {
    const flat = parseOptions(LEGACY, {});
    assert.deepEqual(flat, parseOptions(migrateOptions(LEGACY), {}));
    const d = flat.doorbells[0];
    assert.equal(d.name, 'Front door');
    assert.equal(d.homekitPort, 51900);
    assert.equal(d.homekitBind, 'eth0');
    assert.equal(d.talkGain, 2.5);
    assert.equal(d.talkIdleMs, 5000);
    assert.equal((d.driverOptions as HikvisionOptions).ringAction, 'reject');
    assert.equal(d.videoTranscode, true);
    assert.equal(d.doors, 2);
    assert.deepEqual(flat.mqtt, { enabled: true, host: '10.0.0.5', port: 1883, username: undefined, password: 'mq' });
  });

  it('recognises the stored options right after the update (old keys plus the new empty doorbell)', () => {
    const stored = { ...addon.options as Record<string, unknown>, ...LEGACY };
    assert.ok(isLegacyOptions(stored));
    assert.ok(!hasConfiguredDoorbell(stored));
    assert.ok(!isLegacyOptions(addon.options as Record<string, unknown>), 'fresh install');
    assert.ok(!isLegacyOptions(migrateOptions(LEGACY)), 'already converted');
  });

  it('helpers', () => {
    assert.deepEqual(homekitPorts(51828, 4, 51830), [51828, 51829, 51831, 51832]);
    assert.equal(slug('Вхід / Front Door #1'), 'vkhid-front-door-1');
    assert.equal(slug('Двері'), 'dveri');
    assert.equal(slug('Café'), 'cafe');
    assert.equal(slug('—'), 'doorbell');
  });
});

describe('HomeKit identities', () => {
  const req = (name: string, host: string, reset = false) => ({ key: slug(name), name, host, reset });

  it('keeps the pairing of the single doorbell of older versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hk-id-'));
    try {
      mkdirSync(join(dir, 'homekit'), { recursive: true });
      const legacy = { username: '0E:11:22:33:44:55', pincode: '058-47-886', setupId: 'AB12' };
      writeFileSync(join(dir, 'homekit', 'identity.json'), JSON.stringify(legacy));
      const { identities, notes } = loadIdentities(dir, [req('Front door', '192.168.88.21'), req('Gate', '192.168.88.22')]);
      assert.deepEqual(identities.get('front-door'), legacy);
      assert.notEqual(identities.get('gate')!.username, legacy.username);
      assert.match(notes.join(), /kept the existing HomeKit pairing for "Front door"/);
      assert.ok(!existsSync(join(dir, 'homekit', 'identity.json')));

      // Restart: same identities.
      const again = loadIdentities(dir, [req('Front door', '192.168.88.21'), req('Gate', '192.168.88.22')]).identities;
      assert.deepEqual(again.get('gate'), identities.get('gate'));

      // Rename (same IP): pairing kept. Reset: new accessory, old data cleaned up.
      const renamed = loadIdentities(dir, [req('Entrance', '192.168.88.21'), req('Gate', '192.168.88.22')]);
      assert.deepEqual(renamed.identities.get('entrance'), legacy);
      const cleaned: string[] = [];
      const reset = loadIdentities(dir, [req('Entrance', '192.168.88.21', true)], (u) => cleaned.push(u)).identities;
      assert.deepEqual(cleaned, [legacy.username]);
      assert.notEqual(reset.get('entrance')!.username, legacy.username);
      const stored = JSON.parse(readFileSync(join(dir, 'homekit', 'identities.json'), 'utf8'));
      assert.ok(stored.gate, 'a removed doorbell keeps its identity in case it comes back');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('converting old options under the Supervisor', () => {
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };

  it('reads the stored flat options, saves them in the new format and runs with them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hk-opt-'));
    const realFetch = globalThis.fetch;
    try {
      // What options.json holds right after the update: new defaults, the old keys dropped.
      const file = join(dir, 'options.json');
      writeFileSync(file, JSON.stringify(addon.options));
      const calls: { method: string; url: string; body?: unknown }[] = [];
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        calls.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith('/addons/self/info')) return Response.json({ result: 'ok', data: { options: { ...(addon.options as object), ...LEGACY } } });
        return Response.json({ result: 'ok', data: {} });
      }) as typeof fetch;
      const { loadAddonConfig } = await import('../src/options.ts');
      const c = await loadAddonConfig(quiet, { SUPERVISOR_TOKEN: 't', DATA_DIR: dir }, file);
      assert.deepEqual(c.doorbells.map((d) => [d.name, d.host, d.talkGain]), [['Front door', '192.168.88.21', 2.5]]);
      assert.deepEqual(calls.map((x) => `${x.method} ${x.url}`), ['GET http://supervisor/addons/self/info', 'POST http://supervisor/addons/self/options']);
      const saved = (calls[1].body as { options: unknown }).options;
      assert.deepEqual(validate(saved, addon.schema), [], 'the Supervisor will accept what we save');

      // Configured in the new format: nothing to convert, no Supervisor calls.
      calls.length = 0;
      writeFileSync(file, JSON.stringify(saved));
      const again = await loadAddonConfig(quiet, { SUPERVISOR_TOKEN: 't', DATA_DIR: dir }, file);
      assert.equal(again.doorbells[0].name, 'Front door');
      assert.deepEqual(calls, []);
    } finally {
      globalThis.fetch = realFetch;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
