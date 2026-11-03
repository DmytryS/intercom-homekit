/**
 * Home Assistant Supervisor API, as seen from inside an add-on. Every add-on gets a token in
 * SUPERVISOR_TOKEN; `/addons/self/*` and `/services/*` need no extra permissions.
 */

export class SupervisorError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SupervisorError';
    this.status = status;
  }
}

export function underSupervisor(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SUPERVISOR_TOKEN);
}

/** Call the Supervisor and return the `data` of its `{result: "ok", data}` envelope. */
export async function supervisorApi<T>(method: 'GET' | 'POST', path: string, body?: unknown, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  const token = env.SUPERVISOR_TOKEN;
  if (!token) throw new SupervisorError('not running under the Home Assistant Supervisor', 0);
  const res = await fetch(`http://supervisor${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const json = (await res.json().catch(() => ({}))) as { result?: string; message?: string; data?: T };
  if (!res.ok || json.result !== 'ok') {
    throw new SupervisorError(`${method} ${path}: HTTP ${res.status}${json.message ? ` (${json.message})` : ''}`, res.status);
  }
  return json.data as T;
}

/** This add-on's options as stored by the Supervisor (including keys the current schema no longer has). */
export async function storedOptions(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, unknown>> {
  const info = await supervisorApi<{ options?: Record<string, unknown> }>('GET', '/addons/self/info', undefined, env);
  return info.options ?? {};
}

/** Replace this add-on's saved options (validated by the Supervisor against config.yaml). */
export async function saveOptions(options: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await supervisorApi('POST', '/addons/self/options', { options }, env);
}
