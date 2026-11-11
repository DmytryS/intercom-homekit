/**
 * Child process that owns the native Hikvision HCNetSDK (glibc, amd64/aarch64).
 *
 * Talk-back on DS-KV61xx door stations only works through the SDK's voice
 * forwarding (port 8000); ISAPI two-way audio is rejected by the firmware.
 * Running the SDK out-of-process means a crash inside the vendor library only
 * kills this helper, which the parent simply restarts.
 *
 * Protocol (IPC, advanced serialization):
 *   parent -> { id, type: 'login', host, port, username, password }
 *   parent -> { id, type: 'startVoice', channel }
 *   parent -> { type: 'audio', data: Buffer }      // G.711 µ-law 8 kHz, any length
 *   parent -> { id, type: 'stopVoice' } | { id, type: 'logout' }
 *   child  -> { id, ok: true } | { id, ok: false, error, code }
 *   child  -> { type: 'log', level, msg }
 */
import path from 'node:path';
import koffi from 'koffi';
import { FRAME_BYTES, FRAME_MS, VoiceQueue } from './voiceQueue.ts';

interface Request {
  id?: number;
  type: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  channel?: number;
  data?: Uint8Array;
}

function send(msg: Record<string, unknown>): void {
  if (process.connected) process.send?.(msg);
}

function log(level: 'debug' | 'info' | 'warn' | 'error', msg: string): void {
  send({ type: 'log', level, msg });
}

const dir = process.env.HCNETSDK_DIR || '/opt/hcnetsdk';
const lib = koffi.load(path.join(dir, 'libhcnetsdk.so'));
const sdk = {
  init: lib.func('int NET_DVR_Init()'),
  cleanup: lib.func('int NET_DVR_Cleanup()'),
  setConnectTime: lib.func('int NET_DVR_SetConnectTime(uint32_t, uint32_t)'),
  setReconnect: lib.func('int NET_DVR_SetReconnect(uint32_t, int)'),
  setLogToFile: lib.func('int NET_DVR_SetLogToFile(uint32_t, const char*, int)'),
  lastError: lib.func('uint32_t NET_DVR_GetLastError()'),
  errorMsg: lib.func('const char* NET_DVR_GetErrorMsg(_Inout_ int *err)'),
  login: lib.func('int NET_DVR_Login_V30(const char*, uint16_t, const char*, const char*, void*)'),
  logout: lib.func('int NET_DVR_Logout_V30(int)'),
  startVoice: lib.func('int NET_DVR_StartVoiceCom_MR_V30(int, uint32_t, void*, void*)'),
  sendVoice: lib.func('int NET_DVR_VoiceComSendData(int, const uint8_t*, uint32_t)'),
  stopVoice: lib.func('int NET_DVR_StopVoiceCom(int)'),
};

function lastError(): { code: number; error: string } {
  const code = sdk.lastError() as number;
  let text = '';
  try {
    text = (sdk.errorMsg([code]) as string) || '';
  } catch {
    /* ignore */
  }
  return { code, error: `SDK error ${code}${text ? ` (${text})` : ''}` };
}

if (!sdk.init()) {
  log('error', `NET_DVR_Init failed: ${lastError().error}`);
  process.exit(2);
}
// No NET_DVR_SetValidIP: binding to "local IP #0" picks a Docker bridge on Home Assistant OS
// hosts. Let the kernel choose the source address from the routing table.
sdk.setConnectTime(3000, 1);
sdk.setReconnect(5000, 1);
if (process.env.HCNETSDK_LOG_DIR) sdk.setLogToFile(3, process.env.HCNETSDK_LOG_DIR, 1);

let userId = -1;
let voice = -1;
let queue = new VoiceQueue();
let pacer: NodeJS.Timeout | undefined;
let sentFrames = 0;
let sendFailures = 0;

/** Send one 160-byte frame every 20 ms, scheduled against a monotonic clock to avoid drift. */
function startPacer(): void {
  stopPacer();
  const t0 = performance.now();
  let n = 0;
  const tick = () => {
    if (voice < 0) return;
    const frame = queue.next(performance.now());
    if (frame) {
      if (sdk.sendVoice(voice, frame, FRAME_BYTES)) {
        sentFrames++;
        sendFailures = 0;
      } else if (sendFailures++ % 50 === 0) {
        log('warn', `NET_DVR_VoiceComSendData failed (${sendFailures}x): ${lastError().error}`);
        if (sendFailures > 100) {
          // ~2 s of failures: the voice session is dead; release it so the next talk re-opens.
          log('warn', 'voice session lost; closing it');
          stopVoice();
          return;
        }
      }
    }
    n++;
    let next = t0 + n * FRAME_MS;
    const now = performance.now();
    if (next < now - 5 * FRAME_MS) {
      // Event loop stalled; resynchronise instead of bursting frames.
      n = Math.ceil((now - t0) / FRAME_MS);
      next = t0 + n * FRAME_MS;
    }
    pacer = setTimeout(tick, Math.max(0, next - now));
  };
  pacer = setTimeout(tick, FRAME_MS);
}

function stopPacer(): void {
  if (pacer) clearTimeout(pacer);
  pacer = undefined;
}

function stopVoice(): void {
  stopPacer();
  if (voice >= 0) {
    sdk.stopVoice(voice);
    log(
      'info',
      `voice talk stopped (${sentFrames} frames sent, ${queue.underruns} underruns, ` +
        `${queue.skippedFrames} quiet frames skipped, ${queue.droppedBytes} bytes dropped for latency)`,
    );
  }
  voice = -1;
  queue = new VoiceQueue();
}

function logout(): void {
  stopVoice();
  if (userId >= 0) sdk.logout(userId);
  userId = -1;
}

function handle(req: Request): Record<string, unknown> | undefined {
  switch (req.type) {
    case 'login': {
      if (userId >= 0) return { ok: true };
      const t = Date.now();
      // Login blocks for up to the connect timeout; that's fine in this dedicated process.
      userId = sdk.login(req.host, req.port ?? 8000, req.username, req.password, Buffer.alloc(512)) as number;
      if (userId < 0) return { ok: false, ...lastError() };
      log('info', `SDK login ok (${Date.now() - t} ms)`);
      return { ok: true };
    }
    case 'startVoice': {
      if (userId < 0) return { ok: false, code: -1, error: 'not logged in' };
      if (voice >= 0) return { ok: true };
      voice = sdk.startVoice(userId, req.channel ?? 1, null, null) as number;
      if (voice < 0) {
        const err = lastError();
        // Session may have died (device reboot, network); force a fresh login next time.
        if ([7, 8, 9, 10, 41, 47].includes(err.code)) logout();
        return { ok: false, ...err };
      }
      sentFrames = 0;
      sendFailures = 0;
      queue = new VoiceQueue();
      startPacer();
      return { ok: true };
    }
    case 'audio': {
      if (voice < 0 || !req.data) return undefined;
      queue.push(req.data, performance.now());
      return undefined;
    }
    case 'stopVoice':
      stopVoice();
      return { ok: true };
    case 'logout':
      logout();
      return { ok: true };
    default:
      return { ok: false, code: -1, error: `unknown request ${req.type}` };
  }
}

process.on('message', (req: Request) => {
  let res: Record<string, unknown> | undefined;
  try {
    res = handle(req);
  } catch (err) {
    res = { ok: false, code: -1, error: (err as Error).message };
  }
  if (res && req.id !== undefined) send({ id: req.id, ...res });
});

function shutdown(): void {
  try {
    logout();
    sdk.cleanup();
  } finally {
    process.exit(0);
  }
}
process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
send({ type: 'ready' });
