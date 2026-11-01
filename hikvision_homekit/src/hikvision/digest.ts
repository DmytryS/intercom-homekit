import { createHash, randomBytes } from 'node:crypto';

interface Challenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm: string;
}

/** Parse `Digest realm="x", nonce="y", qop="auth"` into a key/value map. */
export function parseAuthParams(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  const body = header.replace(/^\s*Digest\s+/i, '');
  const re = /([a-zA-Z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    params[m[1].toLowerCase()] = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
  }
  return params;
}

function hash(algorithm: string, data: string): string {
  const algo = algorithm.toUpperCase().startsWith('SHA-256') ? 'sha256' : 'md5';
  return createHash(algo).update(data).digest('hex');
}

/**
 * HTTP Digest authentication (RFC 7616) with nonce reuse, so steady-state polling
 * costs a single request instead of a 401 round trip every time.
 */
export class DigestAuth {
  private challenge?: Challenge;
  private nc = 0;
  private readonly username: string;
  private readonly password: string;

  constructor(username: string, password: string) {
    this.username = username;
    this.password = password;
  }

  get hasChallenge(): boolean {
    return this.challenge !== undefined;
  }

  /** Returns false if the header is not a usable Digest challenge. */
  setChallenge(wwwAuthenticate: string | string[] | undefined): boolean {
    const headers = Array.isArray(wwwAuthenticate) ? wwwAuthenticate : wwwAuthenticate ? [wwwAuthenticate] : [];
    const digest = headers.find((h) => /^\s*Digest\s/i.test(h));
    if (!digest) return false;
    const p = parseAuthParams(digest);
    if (!p.realm || !p.nonce) return false;
    const qop = p.qop
      ?.split(',')
      .map((q) => q.trim())
      .find((q) => q === 'auth');
    this.challenge = { realm: p.realm, nonce: p.nonce, qop, opaque: p.opaque, algorithm: p.algorithm || 'MD5' };
    this.nc = 0;
    return true;
  }

  clear(): void {
    this.challenge = undefined;
  }

  /** Build the Authorization header for the next request, or undefined if no challenge is known yet. */
  authorization(method: string, uri: string): string | undefined {
    const c = this.challenge;
    if (!c) return undefined;
    const sess = c.algorithm.toLowerCase().endsWith('-sess');
    const cnonce = randomBytes(8).toString('hex');
    let ha1 = hash(c.algorithm, `${this.username}:${c.realm}:${this.password}`);
    if (sess) ha1 = hash(c.algorithm, `${ha1}:${c.nonce}:${cnonce}`);
    const ha2 = hash(c.algorithm, `${method}:${uri}`);
    const parts = [
      `username="${this.username}"`,
      `realm="${c.realm}"`,
      `nonce="${c.nonce}"`,
      `uri="${uri}"`,
      `algorithm=${c.algorithm}`,
    ];
    let response: string;
    if (c.qop) {
      this.nc += 1;
      const nc = this.nc.toString(16).padStart(8, '0');
      response = hash(c.algorithm, `${ha1}:${c.nonce}:${nc}:${cnonce}:${c.qop}:${ha2}`);
      parts.push(`qop=${c.qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
    } else {
      response = hash(c.algorithm, `${ha1}:${c.nonce}:${ha2}`);
    }
    parts.push(`response="${response}"`);
    if (c.opaque !== undefined) parts.push(`opaque="${c.opaque}"`);
    return `Digest ${parts.join(', ')}`;
  }
}
