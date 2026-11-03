import http from 'node:http';
import { DigestAuth } from './digest.ts';

export class IsapiError extends Error {
  readonly status?: number;
  readonly subStatus?: string;
  constructor(message: string, status?: number, subStatus?: string) {
    super(message);
    this.name = 'IsapiError';
    this.status = status;
    this.subStatus = subStatus;
  }
}

/** Wrong username/password, or the account is locked by the device after too many failures. */
export class IsapiAuthError extends IsapiError {
  constructor(message: string) {
    super(message, 401);
    this.name = 'IsapiAuthError';
  }
}

export interface IsapiOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  timeoutMs?: number;
}

export interface IsapiResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface RequestOptions {
  body?: string | Buffer;
  contentType?: string;
  timeoutMs?: number;
}

export interface DeviceInfo {
  deviceName?: string;
  model?: string;
  serialNumber?: string;
  macAddress?: string;
  firmwareVersion?: string;
}

export type VolumeKind = 'speaker' | 'talk' | 'microphone';
export type AudioVolumes = Partial<Record<VolumeKind, number>>;

const AUDIO_PATHS: Record<VolumeKind, string> = {
  speaker: '/ISAPI/System/Audio/AudioOut/channels/1',
  talk: '/ISAPI/System/Audio/AudioOut/channels/1',
  microphone: '/ISAPI/System/Audio/AudioIn/channels/1',
};
const AUDIO_TAGS: Record<VolumeKind, string> = { speaker: 'volume', talk: 'talkVolume', microphone: 'volume' };

export type CallSignal ='answer' | 'reject' | 'hangUp' | 'cancel' | 'bellTimeout' | 'request' | 'deviceOnCall';

/** Extract the text content of the first `<tag>` in an XML document. */
export function xmlValue(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(xml);
  return m ? m[1].trim() : undefined;
}

function describeError(res: IsapiResponse): IsapiError {
  const text = res.body.toString('utf8');
  let detail = '';
  let sub: string | undefined;
  if (text.trimStart().startsWith('{')) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      sub = (j.subStatusCode as string) ?? undefined;
      detail = [j.statusString, j.subStatusCode, j.errorMsg].filter(Boolean).join(' / ');
    } catch {
      /* ignore */
    }
  } else {
    sub = xmlValue(text, 'subStatusCode');
    detail = [xmlValue(text, 'statusString'), sub, xmlValue(text, 'errorMsg')].filter(Boolean).join(' / ');
  }
  return new IsapiError(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status, sub);
}

/** Minimal Hikvision ISAPI client (HTTP + Digest auth), tailored to video intercom door stations. */
export class IsapiClient {
  readonly host: string;
  readonly port: number;
  private readonly timeoutMs: number;
  private readonly digest: DigestAuth;
  private readonly agent = new http.Agent({ keepAlive: false });

  constructor(opts: IsapiOptions) {
    this.host = opts.host;
    this.port = opts.port;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.digest = new DigestAuth(opts.username, opts.password);
  }

  private rawRequest(method: string, path: string, opts: RequestOptions): Promise<IsapiResponse> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = {};
      const auth = this.digest.authorization(method, path);
      if (auth) headers.Authorization = auth;
      const body = opts.body === undefined ? undefined : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body);
      if (body) {
        headers['Content-Type'] = opts.contentType ?? 'application/xml';
        headers['Content-Length'] = body.length;
      } else if (method !== 'GET') {
        headers['Content-Length'] = 0;
      }
      const req = http.request(
        { host: this.host, port: this.port, method, path, headers, agent: this.agent },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        },
      );
      req.setTimeout(opts.timeoutMs ?? this.timeoutMs, () => req.destroy(new IsapiError(`${method} ${path} timed out`)));
      req.on('error', reject);
      req.end(body);
    });
  }

  /** Perform a request, answering the Digest challenge transparently. */
  async request(method: string, path: string, opts: RequestOptions = {}): Promise<IsapiResponse> {
    let res = await this.rawRequest(method, path, opts);
    if (res.status !== 401) return res;
    // Either we had no challenge yet, or the nonce expired: take the fresh challenge and retry once.
    if (!this.digest.setChallenge(res.headers['www-authenticate'])) {
      // Hikvision answers a stale nonce with a bare 401 (no challenge): ask again unauthenticated.
      this.digest.clear();
      res = await this.rawRequest(method, path, opts);
      if (res.status !== 401) return res;
      if (!this.digest.setChallenge(res.headers['www-authenticate'])) {
        throw new IsapiAuthError(`${method} ${path}: device did not offer Digest authentication`);
      }
    }
    const retry = await this.rawRequest(method, path, opts);
    if (retry.status === 401) {
      this.digest.clear();
      throw new IsapiAuthError(
        `${method} ${path}: authentication rejected — check username/password (the device locks the account after repeated failures)`,
      );
    }
    return retry;
  }

  /** Like request(), but throws on non-2xx and returns the body as text. */
  async requestText(method: string, path: string, opts: RequestOptions = {}): Promise<string> {
    const res = await this.request(method, path, opts);
    if (res.status < 200 || res.status >= 300) throw describeError(res);
    return res.body.toString('utf8');
  }

  async deviceInfo(): Promise<DeviceInfo> {
    const xml = await this.requestText('GET', '/ISAPI/System/deviceInfo');
    return {
      deviceName: xmlValue(xml, 'deviceName'),
      model: xmlValue(xml, 'model'),
      serialNumber: xmlValue(xml, 'serialNumber'),
      macAddress: xmlValue(xml, 'macAddress'),
      firmwareVersion: xmlValue(xml, 'firmwareVersion'),
    };
  }

  /** Current call state of the door station: typically `idle`, `ring` or `onCall`. */
  async callStatus(timeoutMs?: number): Promise<string> {
    const text = await this.requestText('GET', '/ISAPI/VideoIntercom/callStatus?format=json', { timeoutMs });
    const status = (JSON.parse(text) as { CallStatus?: { status?: string } }).CallStatus?.status;
    if (!status) throw new IsapiError(`Unexpected callStatus response: ${text.slice(0, 200)}`);
    return status;
  }

  async callSignal(cmdType: CallSignal): Promise<void> {
    await this.requestText('PUT', '/ISAPI/VideoIntercom/callSignal?format=json', {
      body: JSON.stringify({ CallSignal: { cmdType } }),
      contentType: 'application/json',
    });
  }

  async openDoor(door: number): Promise<void> {
    await this.requestText('PUT', `/ISAPI/AccessControl/RemoteControl/door/${door}`, {
      body: '<RemoteControlDoor><cmd>open</cmd></RemoteControlDoor>',
    });
  }

  async reboot(): Promise<void> {
    await this.requestText('PUT', '/ISAPI/System/reboot');
  }

  /** Speaker (prompts/ring-back), talk (intercom calls) and microphone volume, 0–10 on DS-KV61xx. */
  async audioVolumes(): Promise<AudioVolumes> {
    const [out, inp] = await Promise.allSettled([
      this.requestText('GET', AUDIO_PATHS.speaker),
      this.requestText('GET', AUDIO_PATHS.microphone),
    ]);
    if (out.status === 'rejected' && inp.status === 'rejected') throw out.reason;
    const read = (r: PromiseSettledResult<string>, tag: string) => {
      const v = r.status === 'fulfilled' ? xmlValue(r.value, tag) : undefined;
      return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
    };
    return { speaker: read(out, 'volume'), talk: read(out, 'talkVolume'), microphone: read(inp, 'volume') };
  }

  async setAudioVolume(kind: VolumeKind, value: number): Promise<void> {
    const path = AUDIO_PATHS[kind];
    const tag = AUDIO_TAGS[kind];
    const xml = await this.requestText('GET', path);
    const re = new RegExp(`(<${tag}>)[^<]*(</${tag}>)`);
    if (!re.test(xml)) throw new IsapiError(`${tag} is not supported by this device`);
    await this.requestText('PUT', path, { body: xml.replace(re, `$1${Math.round(value)}$2`) });
  }

  async snapshot(channel = 101): Promise<Buffer> {
    const res = await this.request('GET', `/ISAPI/Streaming/channels/${channel}/picture`, { timeoutMs: 6000 });
    if (res.status !== 200) throw describeError(res);
    if (res.body.length < 4 || res.body[0] !== 0xff || res.body[1] !== 0xd8) {
      throw new IsapiError(`Snapshot is not a JPEG (${res.headers['content-type']}, ${res.body.length} bytes)`);
    }
    return res.body;
  }
}
