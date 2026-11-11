import http from 'node:http';
import { renderSVG } from 'uqr';
import { pickLanguage, t, type Language } from '../i18n.ts';
import type { Logger } from '../log.ts';

/** Home Assistant's ingress proxy. With host networking the port is also reachable from the LAN. */
const ALLOWED_PEERS = new Set(['172.30.32.2', '::ffff:172.30.32.2', '127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isAllowedPeer(address: string | undefined): boolean {
  return ALLOWED_PEERS.has(address ?? '');
}

export interface PairingInfo {
  name: string;
  pincode: string;
  setupUri: string;
  paired: () => boolean;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function card(info: PairingInfo, lang: Language): string {
  // Texts may contain markup; only the values filled in are escaped.
  const name = esc(info.name);
  const code = esc(info.pincode);
  if (info.paired()) {
    return `<section>
  <h2>${name}</h2>
  <p class="ok">${t(lang, 'page.paired')}</p>
  <p class="hint">${t(lang, 'page.paired_hint', { name })}</p>
</section>`;
  }
  return `<section>
  <h2>${name}</h2>
  <div class="qr">${renderSVG(info.setupUri, { border: 2 })}</div>
  <p class="code">${code}</p>
  <ol>
    <li>${t(lang, 'page.step_open')}</li>
    <li>${t(lang, 'page.step_scan', { name, code })}</li>
  </ol>
  <p><a class="button" href="${esc(info.setupUri)}" target="_top">${t(lang, 'page.open_home')}</a>
    <span class="hint">${t(lang, 'page.open_home_hint')}</span></p>
</section>`;
}

/** What the page shows; it reloads itself when this changes (paired, removed, doorbell added). */
export function pairingStatus(infos: PairingInfo[]): { doorbells: { name: string; paired: boolean }[] } {
  return { doorbells: infos.map((i) => ({ name: i.name, paired: i.paired() })) };
}

export function renderPairingPage(infos: PairingInfo[], lang: Language = 'en'): string {
  const title = t(lang, 'page.title', { name: infos.length === 1 ? infos[0].name : t(lang, 'page.doorbells') });
  const body = infos.length
    ? infos.map((info) => card(info, lang)).join('\n')
    : `<p class="hint">${t(lang, 'page.starting')}</p>`;
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  body { margin: 0; padding: 24px; display: flex; justify-content: center; }
  main { max-width: 420px; width: 100%; }
  section + section { margin-top: 32px; padding-top: 24px; border-top: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
  h2 { font-size: 1.4rem; margin: 0 0 16px; }
  .qr { background: #fff; padding: 12px; border-radius: 12px; width: 240px; margin: 0 auto; }
  .qr svg { display: block; width: 100%; height: auto; }
  .code { text-align: center; font: 600 1.8rem ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .08em; margin: 12px 0; }
  .ok { font-size: 1.2rem; font-weight: 600; color: #2e7d32; }
  .button { display: inline-block; padding: 8px 14px; border-radius: 8px; background: #03a9f4; color: #fff; text-decoration: none; }
  .hint { font-size: .85rem; opacity: .7; }
  ol { padding-left: 20px; line-height: 1.5; }
</style>
</head>
<body>
<main>
${body}
</main>
<script>
  // Refresh when a pairing state changes (paired in the Home app, removed from it) or a doorbell starts.
  const shown = ${JSON.stringify(JSON.stringify(pairingStatus(infos))).replace(/</g, '\\u003c')};
  setInterval(async () => {
    try {
      const r = await fetch('status.json', { cache: 'no-store' });
      if (JSON.stringify(await r.json()) !== shown) location.reload();
    } catch {}
  }, 3000);
</script>
</body>
</html>`;
}

/** The add-on's "Open Web UI" page (Home Assistant ingress): pairing QR codes and setup codes. */
/** `language`: used when the browser asks for no language the page has. */
export function startPairingPage(port: number, infos: () => PairingInfo[], log: Logger, language: Language = 'en'): http.Server {
  const server = http.createServer((req, res) => {
    if (!isAllowedPeer(req.socket.remoteAddress)) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const path = (req.url ?? '/').split('?')[0];
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (path.endsWith('/status.json')) {
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(pairingStatus(infos())));
    } else if (path === '/' || path.endsWith('/index.html')) {
      const lang = pickLanguage(req.headers['accept-language'], language);
      res
        .writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Language': lang, Vary: 'Accept-Language' })
        .end(renderPairingPage(infos(), lang));
    } else {
      res.writeHead(404).end();
    }
  });
  server.on('error', (err) => log.warn(`web UI unavailable on port ${port}: ${err.message}`));
  server.listen(port, () => log.debug(`web UI listening on port ${port}`));
  return server;
}
