import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseOptions } from '../src/config.ts';
import { loadIdentities } from '../src/homekit/identity.ts';
import { pickLanguage, t } from '../src/i18n.ts';
import { discoveryComponents, type DiscoveryInput } from '../src/mqtt/homeAssistant.ts';
import { slug } from '../src/util/slug.ts';
import { renderPairingPage } from '../src/web/pairingPage.ts';

/** Key paths of a translations file (`configuration.system.fields.language.name`…), ignoring the texts. */
function keyPaths(file: string): string[] {
  const stack: string[] = [];
  const paths: string[] = [];
  for (const line of readFileSync(new URL(`../translations/${file}`, import.meta.url), 'utf8').split('\n')) {
    const m = /^( *)([a-z_]+):/.exec(line);
    if (!m) continue;
    stack.length = m[1].length / 2;
    stack.push(m[2]);
    paths.push(stack.join('.'));
  }
  return paths;
}

describe('languages', () => {
  it('the Ukrainian Configuration tab translates exactly what the English one does', () => {
    assert.deepEqual(keyPaths('uk.yaml'), keyPaths('en.yaml'));
    assert.ok(keyPaths('en.yaml').includes('configuration.system.fields.language.description'));
  });

  it('picks the browser language when it has one, else the configured one', () => {
    assert.equal(pickLanguage('uk-UA,uk;q=0.9,en-US;q=0.8', 'en'), 'uk');
    assert.equal(pickLanguage('de-DE,uk;q=0.5,en;q=0.7', 'en'), 'en', 'by quality');
    assert.equal(pickLanguage('de-DE,fr;q=0.5', 'uk'), 'uk');
    assert.equal(pickLanguage(undefined, 'en'), 'en');
    assert.equal(pickLanguage('uk;q=0', 'en'), 'en', 'q=0 means not acceptable');
    assert.equal(t('uk', 'entity.open_door_n', { n: 2 }), 'Відчинити двері 2');
  });

  it('turns Ukrainian names into distinct Latin keys', () => {
    assert.equal(slug('Хвіртка'), 'khvirtka');
    assert.equal(slug('Їжакова хата', '_'), 'yizhakova_khata');
    assert.equal(slug('Згорани'), 'zghorany');
    assert.equal(slug('Під’їзд 2'), 'pidizd-2');
    assert.equal(slug('Front door'), 'front-door');
    const c = parseOptions({ doorbells: [{ name: 'Хвіртка', host: 'a', password: 'p' }, { name: 'Двері', host: 'b', password: 'p' }] }, {});
    assert.deepEqual(c.errors, [], 'two Ukrainian names are not the same doorbell');
    assert.deepEqual(c.doorbells.map((d) => d.key), ['khvirtka', 'dveri']);
  });

  it('a Ukrainian-named doorbell keeps its HomeKit pairing after its key changes from "doorbell"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ids-'));
    try {
      const before = loadIdentities(dir, [{ key: 'doorbell', name: 'Двері', host: '192.168.88.21', reset: false }]);
      const after = loadIdentities(dir, [{ key: slug('Двері'), name: 'Двері', host: '192.168.88.21', reset: false }]);
      assert.equal(after.identities.get('dveri')?.username, before.identities.get('doorbell')?.username);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown language', () => {
    const c = parseOptions({ doorbells: [{ name: 'A', host: 'h', password: 'p' }], system: { language: 'xx' } }, {});
    assert.match(c.errors[0], /"language" must be one of en, uk/);
  });
});

describe('Home Assistant entities in Ukrainian', () => {
  const input: DiscoveryInput = {
    id: 'x',
    name: 'Doorbell',
    deviceInfo: {},
    doors: 2,
    commands: { hangUp: true, reject: true, restart: true },
    talkback: true,
    version: '0',
    volumes: ['speaker'],
    connections: ['logged_in_clients'],
  };

  it('keeps the English entity ids the documentation uses', () => {
    const ids = (lang: 'en' | 'uk') =>
      Object.fromEntries(Object.entries(discoveryComponents({ ...input, language: lang })).map(([k, c]) => [k, c.default_entity_id]));
    const en = ids('en');
    assert.equal(en.doorbell, 'event.doorbell');
    assert.equal(en.snapshot, 'image.doorbell_snapshot');
    assert.equal(en.open_door_2, 'button.doorbell_open_door_2');
    assert.equal(en.live_views, 'sensor.doorbell_homekit_live_views');
    assert.equal(en.logged_in_clients, 'sensor.doorbell_logged_in_clients');
    assert.deepEqual(ids('uk'), en);
    assert.equal(discoveryComponents({ ...input, name: 'Хвіртка' }).snapshot.default_entity_id, 'image.khvirtka_snapshot');
  });

  it('names them in the configured language', () => {
    const c = discoveryComponents({ ...input, language: 'uk' });
    assert.equal(c.open_door_1.name, 'Відчинити двері 1');
    assert.equal(c.snapshot.name, 'Знімок');
    assert.equal(c.speaker_volume.name, 'Гучність динаміка');
    assert.equal(c.doorbell.name, null, 'the doorbell event takes the device name');
    assert.equal(discoveryComponents(input).snapshot.name, 'Snapshot');
  });
});

describe('pairing page in Ukrainian', () => {
  it('translates the texts and still escapes the doorbell name', () => {
    const html = renderPairingPage([{ name: 'Хвіртка <b>', pincode: '123-45-678', setupUri: 'X-HM://0', paired: () => false }], 'uk');
    assert.match(html, /<html lang="uk">/);
    assert.match(html, /Додати аксесуар/);
    assert.match(html, /виберіть «Хвіртка &lt;b&gt;» і введіть <b>123-45-678<\/b>/);
    assert.ok(!html.includes('Хвіртка <b>'));
    const paired = renderPairingPage([{ name: 'A', pincode: '1', setupUri: 'X', paired: () => true }], 'uk');
    assert.match(paired, /Додано до програми «Дім»/);
  });
});
