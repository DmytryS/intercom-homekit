import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { encode } from 'uqr';
import { qrLines } from '../src/homekit/qr.ts';
import { createLogger } from '../src/log.ts';
import { isAllowedPeer, renderPairingPage, startPairingPage } from '../src/web/pairingPage.ts';

const uri = 'X-HM://00HVTBC5QN41Q';

test('log QR: half blocks reproduce every module, black on white', () => {
  const lines = qrLines(uri, false);
  const { data } = encode(uri, { ecc: 'M', border: 2 });
  assert.equal(lines.length, Math.ceil(data.length / 2));
  lines.forEach((line, i) => {
    [...line].forEach((c, x) => {
      assert.equal(c === '█' || c === '▀', data[2 * i][x], `row ${2 * i} col ${x}`);
      assert.equal(c === '█' || c === '▄', data[2 * i + 1]?.[x] ?? false, `row ${2 * i + 1} col ${x}`);
    });
  });
  assert.ok(qrLines(uri).every((l) => l.startsWith('\x1b[30;47m') && l.endsWith('\x1b[0m')));
});

test('pairing page: QR and code until paired, escaped name', () => {
  let paired = false;
  const info = { name: 'Front <door>', pincode: '058-47-886', setupUri: uri, paired: () => paired };
  const page = renderPairingPage([info]);
  assert.match(page, /<svg[^>]*viewBox/);
  assert.match(page, /058-47-886/);
  assert.match(page, /href="X-HM:\/\/00HVTBC5QN41Q"/);
  assert.match(page, /Front &lt;door&gt;/);
  assert.doesNotMatch(page, /Front <door>/);
  paired = true;
  const done = renderPairingPage([info]);
  assert.doesNotMatch(done, /<svg/);
  assert.doesNotMatch(done, /058-47-886/);
  assert.match(done, /Paired with Apple Home/);
  assert.doesNotMatch(done.slice(done.indexOf('<script>')), /<door>/, 'no raw "<" from names inside the script');
});

test('pairing page: one card per doorbell', () => {
  const page = renderPairingPage([
    { name: 'Front', pincode: '058-47-886', setupUri: uri, paired: () => false },
    { name: 'Gate', pincode: '111-22-333', setupUri: 'X-HM://0023ABCDEFGH', paired: () => true },
  ]);
  assert.equal(page.match(/<section>/g)?.length, 2);
  assert.match(page, /<title>Doorbells – HomeKit pairing/);
  assert.match(page, /058-47-886/);
  assert.doesNotMatch(page, /111-22-333/, 'paired doorbells hide their code');
  assert.match(renderPairingPage([]), /no doorbell is running yet/);
});

test('pairing page only answers the ingress proxy (and loopback)', () => {
  assert.ok(isAllowedPeer('172.30.32.2'));
  assert.ok(isAllowedPeer('::ffff:172.30.32.2'));
  assert.ok(isAllowedPeer('127.0.0.1'));
  assert.ok(!isAllowedPeer('192.168.88.158'));
  assert.ok(!isAllowedPeer('172.30.32.1'));
  assert.ok(!isAllowedPeer(undefined));
});

test('pairing page server: page under any ingress prefix, status.json, rejects writes', async () => {
  let paired = false;
  const server = startPairingPage(0, () => [{ name: 'Doorbell', pincode: '058-47-886', setupUri: uri, paired: () => paired }], createLogger('test'));
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<svg/);
    assert.deepEqual(await (await fetch(`${base}/status.json`)).json(), { doorbells: [{ name: 'Doorbell', paired: false }] });
    paired = true;
    assert.deepEqual(await (await fetch(`${base}/status.json`)).json(), { doorbells: [{ name: 'Doorbell', paired: true }] });
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
  }
});
