/** Readers for the add-on options (untyped JSON from the Supervisor), shared by the config parser and drivers. */
export type Options = Record<string, unknown>;

export function section(o: Options, key: string): Options {
  const v = o[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Options) : {};
}

export function str(o: Options, key: string, def = ''): string {
  const v = o[key];
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? def : String(v);
}

export function num(o: Options, key: string, def: number, min: number, max: number): number {
  const v = o[key];
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Option "${key}" must be a number`);
  return Math.min(max, Math.max(min, n));
}

export function bool(o: Options, key: string, def: boolean): boolean {
  const v = o[key];
  return typeof v === 'boolean' ? v : v === undefined || v === null ? def : String(v) === 'true';
}
