import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createLogger, redact, type Logger } from './log.ts';

const defaultLog = createLogger('ffmpeg');

export interface FfmpegProcess {
  proc: ChildProcessWithoutNullStreams;
  /** Last lines of stderr, for error reports. */
  tail(): string;
  stop(): void;
  exited: Promise<number | null>;
}

export function runFfmpeg(args: string[], label: string, log: Logger = defaultLog): FfmpegProcess {
  const bin = process.env.FFMPEG_PATH || 'ffmpeg';
  log.debug(`${label}: ${bin} ${redact(args.join(' '))}`);
  const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: string[] = [];
  let partial = '';
  proc.stderr.on('data', (d: Buffer) => {
    const parts = (partial + d.toString()).split(/\r?\n/);
    partial = parts.pop() ?? '';
    for (const line of parts) {
      if (!line.trim()) continue;
      lines.push(line);
      if (lines.length > 20) lines.shift();
      log.debug(`${label}: ${line}`);
    }
  });
  proc.stdin.on('error', () => {}); // EPIPE when ffmpeg exits early
  const exited = new Promise<number | null>((resolve) => {
    proc.once('exit', (code) => resolve(code));
    proc.once('error', (err) => {
      lines.push(err.message);
      resolve(-1);
    });
  });
  let killTimer: NodeJS.Timeout | undefined;
  return {
    proc,
    exited,
    tail: () => redact(lines.slice(-5).join(' | ')),
    stop: () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill('SIGTERM');
      killTimer ??= setTimeout(() => proc.kill('SIGKILL'), 2000);
      void exited.then(() => clearTimeout(killTimer));
    },
  };
}
