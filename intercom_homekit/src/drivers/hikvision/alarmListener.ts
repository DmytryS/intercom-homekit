import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createLogger, type Logger } from '../../log.ts';
import { ALARM_CALL_DISMISSED, ALARM_DOORBELL_RINGING, SDK_CONNECTION_LOST } from './alarm.ts';

const HELPER = fileURLToPath(new URL('./sdkHelper.ts', import.meta.url));

/** SDK login errors that mean wrong credentials or a locked account: retry rarely. */
const AUTH_ERRORS = new Set([1, 153]);

export interface AlarmListenerOptions {
  sdkDir: string;
  host: string;
  port: number;
  username: string;
  password: string;
  log?: Logger;
  /** First retry delay after a failure; doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
  /** Retry delay after an authentication failure (the device locks accounts). */
  authRetryMs?: number;
}

export interface AlarmListenerEvents {
  /** The call button was pressed. */
  ring: [];
  /** The door station gave up an unanswered call. */
  dismissed: [];
  listening: [listening: boolean];
}

interface Pending {
  resolve: () => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface HelperMessage {
  id?: number;
  type?: string;
  ok?: boolean;
  error?: string;
  code?: number;
  level?: 'debug' | 'info' | 'warn' | 'error';
  msg?: string;
  alarmType?: number;
}

/**
 * Detects doorbell presses on the Hikvision SDK's alarm channel.
 *
 * A door station linked to an indoor station may keep its ISAPI call status at `idle` while it
 * rings (seen on a DS-KV6113), but it still uploads a "doorbell ringing" alarm to SDK clients.
 * This keeps one SDK login open in its own helper process (talk-back logs in and out on its own
 * schedule, which would close the channel), and opens the channel again after any failure.
 */
export class AlarmListener extends EventEmitter<AlarmListenerEvents> {
  listening = false;
  /** Why the channel isn't open, for the compatibility check. */
  lastError?: string;
  private readonly opts: AlarmListenerOptions;
  private readonly log: Logger;
  private child?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private wanted = false;
  private arming = false;
  private rearmWanted = false;
  private timer?: NodeJS.Timeout;
  private failures = 0;
  private attempts = 0;
  private readonly attempted: (() => void)[] = [];

  constructor(opts: AlarmListenerOptions) {
    super();
    this.opts = opts;
    this.log = opts.log ?? createLogger('ring');
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.schedule(0);
  }

  /** Log in again and reopen the channel: the door station came back, or the SDK lost it. */
  rearm(reason: string, delayMs = 0): void {
    if (!this.wanted) return;
    this.log.debug(`reopening the alarm channel: ${reason}`);
    if (this.arming) this.rearmWanted = true;
    else this.schedule(delayMs);
  }

  /** Try now instead of waiting for the next retry, if the channel isn't open. */
  nudge(): void {
    if (this.wanted && !this.listening && !this.arming) this.schedule(0);
  }

  /** Resolves with `listening` once the first attempt to open the channel is over (or after `timeoutMs`). */
  ready(timeoutMs: number): Promise<boolean> {
    if (this.attempts > 0) return Promise.resolve(this.listening);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(this.listening);
      };
      const timer = setTimeout(done, timeoutMs);
      this.attempted.push(done);
    });
  }

  async stop(): Promise<void> {
    this.wanted = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.setListening(false);
    const child = this.child;
    if (!child) return;
    await this.call('logout', {}, 3000).catch(() => {});
    this.child = undefined; // intentional exit: don't report it as a crash
    child.kill('SIGTERM');
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.arm(), ms);
  }

  private setListening(listening: boolean): void {
    if (this.listening === listening) return;
    this.listening = listening;
    this.emit('listening', listening);
  }

  private async arm(): Promise<void> {
    this.timer = undefined;
    if (!this.wanted || this.arming) return;
    this.arming = true;
    this.rearmWanted = false;
    try {
      const { host, port, username, password } = this.opts;
      // Always a fresh login: a session that survived an outage may no longer deliver alarms.
      if (this.child) await this.call('logout', {}, 5000);
      this.setListening(false);
      await this.call('login', { host, port, username, password });
      await this.call('startAlarm');
      if (!this.wanted) return;
      if (this.failures > 0 || this.attempts === 0) this.log.info('listening for doorbell presses on the SDK alarm channel');
      this.failures = 0;
      this.lastError = undefined;
      this.setListening(true);
    } catch (err) {
      const { message, code } = err as Error & { code?: number };
      this.setListening(false);
      this.lastError = message;
      // A helper that doesn't answer is stuck inside the vendor library: replace it.
      if (/timed out/.test(message)) this.killHelper();
      if (!this.wanted) return;
      this.failures++;
      const auth = code !== undefined && AUTH_ERRORS.has(code);
      const delay = auth
        ? (this.opts.authRetryMs ?? 600000)
        : Math.min(this.opts.maxRetryMs ?? 30000, (this.opts.retryMs ?? 5000) * 2 ** Math.min(this.failures - 1, 10));
      if (this.failures === 1 || auth) {
        this.log.warn(`SDK alarm channel not open (${message}); doorbell presses rely on call status polling until it is. Retrying in ${Math.round(delay / 1000)} s`);
      }
      this.schedule(delay);
    } finally {
      this.arming = false;
      this.attempts++;
      for (const done of this.attempted.splice(0)) done();
      if (this.rearmWanted && this.wanted && !this.timer) this.schedule(0);
    }
  }

  private killHelper(): void {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.rejectPending('SDK helper replaced');
    child.kill('SIGKILL');
  }

  private rejectPending(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private spawn(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const child = fork(HELPER, [], {
      cwd: this.opts.sdkDir,
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, HCNETSDK_DIR: this.opts.sdkDir },
    });
    child.stdout?.on('data', (d: Buffer) => this.log.debug(`sdk: ${d.toString().trim()}`));
    child.stderr?.on('data', (d: Buffer) => this.log.debug(`sdk: ${d.toString().trim()}`));
    child.on('message', (m: HelperMessage) => this.onMessage(m));
    const gone = (reason: string) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.rejectPending(reason);
      const wasListening = this.listening;
      this.setListening(false);
      this.lastError = reason;
      // While opening the channel, the failed request reports it and schedules the retry.
      if (!this.wanted || this.arming) return;
      if (wasListening) this.log.warn(`${reason}; reopening the SDK alarm channel`);
      this.schedule(this.opts.retryMs ?? 5000);
    };
    child.on('exit', (code, signal) => gone(`SDK helper exited (code ${code}, signal ${signal})`));
    // Without a listener, a helper that can't start (e.g. missing SDK directory) would crash the add-on.
    child.on('error', (err) => gone(`SDK helper failed to start: ${err.message}`));
    this.child = child;
    return child;
  }

  private onMessage(m: HelperMessage): void {
    switch (m.type) {
      case 'log':
        this.log[m.level ?? 'info'](m.msg ?? '');
        return;
      case 'alarm':
        if (m.alarmType === ALARM_DOORBELL_RINGING) {
          this.log.info('doorbell pressed (SDK alarm)');
          this.emit('ring');
        } else if (m.alarmType === ALARM_CALL_DISMISSED) {
          this.log.debug('call dismissed (SDK alarm)');
          this.emit('dismissed');
        } else {
          this.log.debug(`video intercom alarm type ${m.alarmType}`);
        }
        return;
      case 'sdkException':
        this.log.debug(`SDK exception 0x${(m.code ?? 0).toString(16)}`);
        if (this.listening && m.code !== undefined && SDK_CONNECTION_LOST.has(m.code)) {
          this.log.warn(`SDK connection lost (0x${m.code.toString(16)}); reopening the alarm channel`);
          this.setListening(false);
          this.rearm('SDK exception', 2000);
        }
        return;
    }
    if (m.id === undefined) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve();
    else p.reject(Object.assign(new Error(m.error ?? 'SDK request failed'), { code: m.code }));
  }

  private call(type: string, payload: Record<string, unknown> = {}, timeoutMs = 10000): Promise<void> {
    const child = this.spawn();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`SDK ${type} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.send({ id, type, ...payload }, (err) => {
        if (!err || !this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(new Error(`SDK ${type} not sent: ${err.message}`));
      });
    });
  }
}
