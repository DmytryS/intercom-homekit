/**
 * Example driver: a starting point for a new brand. It is compiled and tested
 * (test/drivers.test.ts), but not registered, so users can't select it.
 *
 * It talks to an imaginary door station with a small HTTP API:
 *
 *   GET  /api/info              → {"model": "...", "serial": "...", "mac": "...", "firmware": "..."}
 *   GET  /api/call              → {"state": "idle" | "ringing" | "talking"}
 *   POST /api/door/<n>/open     → 204
 *   GET  /api/snapshot.jpg      → JPEG
 *   RTSP rtsp://<user>:<pass>@<host>:554/live
 *
 * To support a real brand: copy this folder to drivers/<brand>/, replace the HTTP calls with the
 * device's API, register it in drivers/index.ts and add its id to `type` in config.yaml.
 * CONTRIBUTING.md walks through it.
 */
import { EventEmitter } from 'node:events';
import type { Config } from '../../config.ts';
import type { CallState, Check, CommonOptions, DeviceInfo, Driver, Intercom, IntercomEvents } from '../../intercom.ts';
import type { Logger } from '../../log.ts';
import { num, type Options } from '../../util/options.ts';

export interface ExampleOptions {
  httpPort: number;
  rtspPort: number;
  pollMs: number;
}

/** Device call states → the core's call states. */
const CALL_STATES: Record<string, CallState> = { idle: 'idle', ringing: 'ringing', talking: 'on_call' };

class HttpError extends Error {
  readonly status: number;
  /** Tells the core (and us) not to retry: devices lock accounts after repeated failures. See isAuthError(). */
  readonly authFailure: boolean;
  constructor(status: number, path: string) {
    super(`HTTP ${status} for ${path}`);
    this.status = status;
    this.authFailure = status === 401 || status === 403;
  }
}

export class ExampleIntercom extends EventEmitter<IntercomEvents> implements Intercom {
  online = false;
  callState?: CallState;
  readonly configurationUrl: string;
  private readonly base: string;
  private readonly auth: string;
  private readonly pollMs: number;
  private readonly log: Logger;
  private timer?: NodeJS.Timeout;
  private running = false;
  private failures = 0;

  constructor(config: Config, o: ExampleOptions, logger: (scope: string) => Logger) {
    super();
    this.base = `http://${config.host}:${o.httpPort}`;
    this.configurationUrl = `${this.base}/`;
    this.auth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
    this.pollMs = o.pollMs;
    this.log = logger('call');
  }

  private async request(method: string, path: string): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { Authorization: this.auth },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new HttpError(res.status, path);
    return res;
  }

  // --- required -------------------------------------------------------------------------

  start(): void {
    this.running = true;
    void this.poll();
  }

  async close(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  async deviceInfo(): Promise<DeviceInfo> {
    const j = (await (await this.request('GET', '/api/info')).json()) as Record<string, string | undefined>;
    return { manufacturer: 'Example', model: j.model, serialNumber: j.serial, macAddress: j.mac, firmwareVersion: j.firmware };
  }

  /** Ring detection by polling. Prefer the device's push events (event stream, webhook, SIP) if it has them. */
  private async poll(): Promise<void> {
    let delay = this.pollMs;
    try {
      const { state } = (await (await this.request('GET', '/api/call')).json()) as { state: string };
      this.failures = 0;
      this.setOnline(true);
      const next = CALL_STATES[state] ?? state;
      if (next !== this.callState) {
        const previous = this.callState;
        this.callState = next;
        this.emit('callState', next);
        // Once per press, and not for a ring already in progress when the add-on starts.
        if (next === 'ringing' && previous !== undefined) this.emit('ring');
      }
    } catch (err) {
      this.failures++;
      if ((err as HttpError).authFailure) {
        this.log.error(`${(err as Error).message}: check username and password; retrying in 60 s`);
        delay = 60000;
        this.setOnline(false);
      } else {
        if (this.failures === 1) this.log.warn(`call state poll failed: ${(err as Error).message}`);
        if (this.failures >= 3) this.setOnline(false);
      }
    }
    if (this.running) this.timer = setTimeout(() => void this.poll(), delay);
  }

  private setOnline(online: boolean): void {
    if (online === this.online) return;
    this.online = online;
    this.emit('online', online);
  }

  // --- optional: implement what the device can do, delete the rest -------------------

  async snapshot(): Promise<Buffer> {
    return Buffer.from(await (await this.request('GET', '/api/snapshot.jpg')).arrayBuffer());
  }

  async openDoor(door: number): Promise<void> {
    await this.request('POST', `/api/door/${door}/open`);
  }

  /** Lines for the start-up compatibility check, next to the core's snapshot/video/audio lines. */
  async checks(): Promise<Check[]> {
    try {
      await this.request('GET', '/api/call');
      return [{ name: 'ring detection', status: 'ok', detail: 'call state works' }];
    } catch (err) {
      return [{ name: 'ring detection', status: 'failed', detail: `call state unavailable (${(err as Error).message})` }];
    }
  }
}

export const example: Driver<ExampleOptions> = {
  id: 'example',
  name: 'Example',
  // Read driver-specific options from the doorbell entry. Add each to config.yaml (schema, optional
  // with "?") and translations/en.yaml.
  parseOptions(entry: Options): ExampleOptions {
    return {
      httpPort: num(entry, 'http_port', 80, 1, 65535),
      rtspPort: num(entry, 'rtsp_port', 554, 1, 65535),
      pollMs: 1000,
    };
  },
  streamUrl({ host, username, password }: CommonOptions, o: ExampleOptions): string {
    return `rtsp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${o.rtspPort}/live`;
  },
  create: (config, options, logger) => new ExampleIntercom(config, options, logger),
};
