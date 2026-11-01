// Dev helper: counts HTTP round trips/401s during steady callStatus polling (digest nonce reuse).
import { IsapiClient } from '../src/hikvision/isapi.ts';
const isapi = new IsapiClient({ host: process.env.HIK_HOST!, port: 80, username: process.env.HIK_USER!, password: process.env.HIK_PASS! });
const stats = { requests: 0, s401: 0, s200: 0 };
const proto = IsapiClient.prototype as unknown as { rawRequest: (...a: unknown[]) => Promise<{ status: number }> };
const orig = proto.rawRequest;
proto.rawRequest = async function (this: unknown, ...a: unknown[]) {
  const r = await orig.apply(this, a);
  stats.requests++;
  if (r.status === 401) stats.s401++; else if (r.status === 200) stats.s200++;
  return r;
};
const n = Number(process.argv[2]) || 30;
const t0 = Date.now();
for (let i = 0; i < n; i++) { await isapi.callStatus(); await new Promise((r) => setTimeout(r, 1000)); }
console.log(`${n} polls in ${((Date.now() - t0) / 1000).toFixed(0)} s → ${stats.requests} HTTP requests, ${stats.s401} × 401, ${stats.s200} × 200`);
for (const q of ['', '?videoResolutionWidth=1920&videoResolutionHeight=1080']) {
  const r = await isapi.request('GET', `/ISAPI/Streaming/channels/101/picture${q}`);
  const b = r.body; let w = 0, h = 0;
  for (let i = 2; i < b.length - 9; ) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1]; if (m >= 0xc0 && m <= 0xc2) { h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); break; } i += 2 + b.readUInt16BE(i + 2); }
  console.log(`snapshot${q ? ' 1080p query' : ''}: HTTP ${r.status}, ${b.length} bytes, ${w}x${h}`);
}
