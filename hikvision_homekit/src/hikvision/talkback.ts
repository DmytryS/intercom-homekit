import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { RingAction } from '../config.ts';
import { createLogger } from '../log.ts';
import type { IsapiClient } from './isapi.ts';

const log = createLogger('talkback');
const HELPER = fileURLToPath(new URL('./sdkHelper.ts', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TalkbackOptions {
  sdkDir: string;
  host: string;
  port: number;
  username: string;
  password: string;
  isapi: IsapiClient;
  ringAction: RingAction;
  /** How long to keep the SDK session after the last viewer leaves. */
  lingerMs?: number;
}

interface Pending {
  resolve: (v: void) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface HelperReply {
  id?: number;
  type?: string;
  ok?: boolean;
  error?: string;
  code?: number;
  level?: 'debug' | 'info' | 'warn' | 'error';
  msg?: string;
}

/**
 * Sends iPhone microphone audio (already decoded to G.711 µ-law 8 kHz) to the
 * door station speaker through the Hikvision SDK helper process.
 */
export class Talkback {
  private readonly opts: TalkbackOptions;
  private child?: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private loggedIn = false;
  private talking = false;
  private starting?: Promise<void>;
  private viewers = 0;
  private lingerTimer?: NodeJS.Timeout;
  private preStart: Buffer[] = [];
  private preStartBytes = 0;
  private disabledUntil = 0;

  constructor(opts: TalkbackOptions) {
    this.opts = opts;
  }

  get active(): boolean {
    return this.talking;
  }

  private spawn(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const child = fork(HELPER, [], {
      cwd: this.opts.sdkDir,
      serialization: 'advanced',
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, HCNETSDK_DIR: this.opts.sdkDir },
    });
    child.stdout?.on('data', (d: Buffer) => log.debug(`sdk: ${d.toString().trim()}`));
    child.stderr?.on('data', (d: Buffer) => log.debug(`sdk: ${d.toString().trim()}`));
    child.on('message', (m: HelperReply) => this.onMessage(m));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      log.warn(`SDK helper exited (code ${code}, signal ${signal})`);
      this.child = undefined;
      this.loggedIn = false;
      this.talking = false;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('SDK helper exited'));
        this.pending.delete(id);
      }
    });
    this.child = child;
    return child;
  }

  private onMessage(m: HelperReply): void {
    if (m.type === 'log') {
      log[m.level ?? 'info'](m.msg ?? '');
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
      child.send({ id, type, ...payload });
    });
  }

  private async login(): Promise<void> {
    if (this.loggedIn) return;
    const { host, port, username, password } = this.opts;
    await this.call('login', { host, port, username, password });
    this.loggedIn = true;
  }

  /** A live view started: log in ahead of time so talk-back starts instantly. */
  acquire(): void {
    this.viewers++;
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = undefined;
    if (Date.now() < this.disabledUntil) return;
    this.login().catch((err: Error) => log.warn(`SDK pre-login failed: ${err.message}`));
  }

  /** A live view ended. */
  release(): void {
    this.viewers = Math.max(0, this.viewers - 1);
    if (this.viewers > 0) return;
    void this.stop();
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = setTimeout(() => {
      if (this.viewers === 0 && this.loggedIn) {
        this.loggedIn = false;
        this.call('logout').catch(() => {});
      }
    }, this.opts.lingerMs ?? 30000);
  }

  /** Silence an incoming call first; the door station won't play talk-back while it rings. */
  private async handleRinging(): Promise<void> {
    const action = this.opts.ringAction;
    if (action === 'none') return;
    let status: string;
    try {
      status = await this.opts.isapi.callStatus(2000);
    } catch (err) {
      log.debug(`callStatus before talk failed: ${(err as Error).message}`);
      return;
    }
    if (status !== 'ring') return;
    log.info(`door station is ringing; sending "${action}" before talk-back`);
    try {
      if (action === 'answer_hangup') {
        await this.opts.isapi.callSignal('answer');
        await sleep(300);
        await this.opts.isapi.callSignal('hangUp');
      } else {
        await this.opts.isapi.callSignal(action);
      }
      await sleep(250);
    } catch (err) {
      log.warn(`callSignal ${action} failed: ${(err as Error).message}`);
    }
  }

  /** Begin talking. Audio written before the channel is open is buffered (≤ 0.8 s). */
  start(): Promise<void> {
    if (this.talking) return Promise.resolve();
    if (this.starting) return this.starting;
    if (Date.now() < this.disabledUntil) return Promise.reject(new Error('talk-back temporarily disabled after errors'));
    this.starting = (async () => {
      const t0 = Date.now();
      try {
        await Promise.all([this.login(), this.handleRinging()]);
        try {
          await this.call('startVoice', { channel: 1 });
        } catch (err) {
          // Stale session (device rebooted, network blip): log in again once.
          this.loggedIn = false;
          log.debug(`startVoice failed (${(err as Error).message}); retrying with a fresh login`);
          await this.login();
          await this.call('startVoice', { channel: 1 });
        }
        this.talking = true;
        log.info(`talk-back open (${Date.now() - t0} ms)`);
        for (const chunk of this.preStart) this.child?.send({ type: 'audio', data: chunk });
      } catch (err) {
        this.disabledUntil = Date.now() + 10000;
        throw err;
      } finally {
        this.preStart = [];
        this.preStartBytes = 0;
        this.starting = undefined;
      }
    })();
    return this.starting;
  }

  write(mulaw: Buffer): void {
    if (this.talking) {
      this.child?.send({ type: 'audio', data: mulaw });
    } else if (this.starting) {
      this.preStart.push(mulaw);
      this.preStartBytes += mulaw.length;
      while (this.preStartBytes > 6400 && this.preStart.length > 1) this.preStartBytes -= this.preStart.shift()!.length;
    }
  }

  async stop(): Promise<void> {
    if (this.starting) await this.starting.catch(() => {});
    if (!this.talking) return;
    this.talking = false;
    await this.call('stopVoice').catch((err: Error) => log.debug(`stopVoice: ${err.message}`));
  }

  async shutdown(): Promise<void> {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    const child = this.child;
    if (!child) return;
    await this.call('logout', {}, 3000).catch(() => {});
    this.child = undefined; // intentional exit: don't report it as a crash
    child.kill('SIGTERM');
  }
}
