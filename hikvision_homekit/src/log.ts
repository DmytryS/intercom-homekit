export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = ORDER.info;
const secrets = new Set<string>();

export function setLogLevel(level: LogLevel): void {
  threshold = ORDER[level] ?? ORDER.info;
}

export function isDebug(): boolean {
  return threshold <= ORDER.debug;
}

/** Register a value (password, URL-encoded password, …) that must never appear in logs. */
export function addSecret(value: string | undefined): void {
  if (value && value.length >= 3) {
    secrets.add(value);
    secrets.add(encodeURIComponent(value));
  }
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('***');
  // Credentials embedded in URLs (rtsp://user:pass@host)
  return out.replace(/(\b[a-z]+:\/\/[^:/\s]+:)[^@\s]+@/gi, '$1***@');
}

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

function fmt(arg: unknown): string {
  if (arg instanceof Error) return arg.stack && isDebug() ? arg.stack : arg.message;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function write(level: LogLevel, scope: string, msg: string, args: unknown[]): void {
  if (ORDER[level] < threshold) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${[msg, ...args.map(fmt)].join(' ')}`;
  const safe = redact(line);
  if (level === 'error' || level === 'warn') process.stderr.write(safe + '\n');
  else process.stdout.write(safe + '\n');
}

export function createLogger(scope: string): Logger {
  return {
    debug: (msg, ...args) => write('debug', scope, msg, args),
    info: (msg, ...args) => write('info', scope, msg, args),
    warn: (msg, ...args) => write('warn', scope, msg, args),
    error: (msg, ...args) => write('error', scope, msg, args),
  };
}
