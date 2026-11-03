import { EventEmitter } from 'node:events';
import { createLogger, type Logger } from '../log.ts';
import { IsapiAuthError, type IsapiClient } from './isapi.ts';


export interface CallMonitorEvents {
  ring: [];
  status: [status: string, previous: string | undefined];
  online: [online: boolean];
}

/**
 * Detects doorbell presses by polling `/ISAPI/VideoIntercom/callStatus`.
 *
 * DS-KV61xx firmware does not deliver ring events on the ISAPI alertStream (it returns
 * an empty document), so polling is the reliable option. The state stays `ring` for the
 * whole ring period, so a 1 s interval never misses a press.
 */
export class CallMonitor extends EventEmitter<CallMonitorEvents> {
  private readonly isapi: IsapiClient;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;
  private failures = 0;
  status?: string;
  online = false;

  private readonly log: Logger;

  constructor(isapi: IsapiClient, intervalMs: number, log: Logger = createLogger('call')) {
    super();
    this.isapi = isapi;
    this.intervalMs = intervalMs;
    this.log = log;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    if (this.running) this.timer = setTimeout(() => void this.poll(), ms);
  }

  private setOnline(online: boolean): void {
    if (this.online === online) return;
    this.online = online;
    this.emit('online', online);
  }

  private async poll(): Promise<void> {
    const started = Date.now();
    try {
      const status = await this.isapi.callStatus(Math.max(2000, this.intervalMs * 2));
      if (this.failures > 0) this.log.info(`door station reachable again (after ${this.failures} failed polls)`);
      this.failures = 0;
      this.setOnline(true);
      const previous = this.status;
      if (status !== previous) {
        this.status = status;
        this.log.debug(`call status ${previous ?? '-'} -> ${status}`);
        this.emit('status', status, previous);
        if (status === 'ring' && previous !== undefined) {
          this.log.info('doorbell pressed');
          this.emit('ring');
        }
      }
      this.schedule(Math.max(0, this.intervalMs - (Date.now() - started)));
    } catch (err) {
      this.failures++;
      if (err instanceof IsapiAuthError) {
        // Never hammer the device with bad credentials: Hikvision locks the account.
        this.log.error(`${err.message}; retrying in 60 s`);
        this.setOnline(false);
        this.schedule(60000);
        return;
      }
      if (this.failures === 1 || this.failures % 60 === 0) this.log.warn(`callStatus poll failed: ${(err as Error).message}`);
      if (this.failures >= 3) this.setOnline(false);
      this.schedule(Math.min(30000, this.intervalMs * Math.min(this.failures, 10)));
    }
  }
}
