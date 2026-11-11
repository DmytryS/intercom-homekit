import { EventEmitter } from 'node:events';
import { createLogger, type Logger } from '../../log.ts';
import { IsapiAuthError, IsapiError, type IsapiClient } from './isapi.ts';

export interface CallMonitorEvents {
  ring: [];
  status: [status: string, previous: string | undefined];
  online: [online: boolean];
}

export interface CallMonitorOptions {
  /** Answers in a row without a call status before ring detection is considered unsupported. */
  unsupportedAfter?: number;
  /** Poll interval while unsupported: keeps checking reachability, and whether call status appears. */
  unsupportedPollMs?: number;
}

/** The device answered over HTTP (so it is reachable), but not with a usable call status. */
function answered(err: unknown): err is IsapiError {
  return err instanceof IsapiError && err.status !== undefined;
}

/**
 * Detects doorbell presses by polling `/ISAPI/VideoIntercom/callStatus`, and tells whether the
 * door station is reachable.
 *
 * DS-KV61xx firmware does not deliver ring events on the ISAPI alertStream (it returns
 * an empty document), so polling is the reliable option. The state stays `ring` for the
 * whole ring period, so a 1 s interval never misses a press.
 *
 * Door stations without this endpoint still count as online (they answer), so their door,
 * video and talk-back keep working; only ring detection is missing, and the log says so.
 */
export class CallMonitor extends EventEmitter<CallMonitorEvents> {
  private readonly isapi: Pick<IsapiClient, 'callStatus'>;
  private readonly intervalMs: number;
  private readonly unsupportedAfter: number;
  private readonly unsupportedPollMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;
  /** Polls in a row that got no answer at all. */
  private failures = 0;
  /** Polls in a row the device answered without a call status. */
  private rejected = 0;
  status?: string;
  online = false;

  private readonly log: Logger;

  constructor(
    isapi: Pick<IsapiClient, 'callStatus'>,
    intervalMs: number,
    log: Logger = createLogger('call'),
    opts: CallMonitorOptions = {},
  ) {
    super();
    this.isapi = isapi;
    this.intervalMs = intervalMs;
    this.log = log;
    this.unsupportedAfter = opts.unsupportedAfter ?? 5;
    this.unsupportedPollMs = opts.unsupportedPollMs ?? 30000;
  }

  /** False when the door station doesn't report its call status: rings can't be detected. */
  get ringDetection(): boolean {
    return this.rejected < this.unsupportedAfter;
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

  private reachable(): void {
    if (this.failures > 0) this.log.info(`door station reachable again (after ${this.failures} failed polls)`);
    this.failures = 0;
    this.setOnline(true);
  }

  private async poll(): Promise<void> {
    const started = Date.now();
    try {
      const status = await this.isapi.callStatus(Math.max(2000, this.intervalMs * 2));
      this.reachable();
      if (!this.ringDetection) this.log.info('door station reports its call status now; doorbell presses are detected again');
      this.rejected = 0;
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
      if (err instanceof IsapiAuthError) {
        // Never hammer the device with bad credentials: Hikvision locks the account.
        this.failures++;
        this.log.error(`${err.message}; retrying in 60 s`);
        this.setOnline(false);
        this.schedule(60000);
        return;
      }
      if (answered(err)) {
        this.reachable();
        this.rejected++;
        if (this.rejected === 1) this.log.warn(`callStatus poll failed: ${err.message}`);
        if (this.rejected === this.unsupportedAfter) {
          this.log.warn(
            `this door station doesn't report its call status (${err.message}), so doorbell presses can't be ` +
              'detected. Live view, talk-back and the door still work. Please report your model (see the compatibility ' +
              'check in this log).',
          );
        }
        this.schedule(this.ringDetection ? this.intervalMs : this.unsupportedPollMs);
        return;
      }
      this.failures++;
      if (this.failures === 1 || this.failures % 60 === 0) this.log.warn(`callStatus poll failed: ${(err as Error).message}`);
      if (this.failures >= 3) this.setOnline(false);
      this.schedule(Math.min(30000, this.intervalMs * Math.min(this.failures, 10)));
    }
  }
}
