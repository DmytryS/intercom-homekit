import type { IsapiClient } from './isapi.ts';

const MAX_AGE_MS = 4000;

/**
 * Door station snapshots shared by HomeKit and Home Assistant: a ring triggers both a HomeKit
 * notification and an MQTT image update, and they should cost the door station one request.
 */
export class SnapshotCache {
  private readonly isapi: Pick<IsapiClient, 'snapshot'>;
  private cache?: { at: number; data: Buffer };
  private inFlight?: Promise<Buffer>;
  private generation = 0;

  constructor(isapi: Pick<IsapiClient, 'snapshot'>) {
    this.isapi = isapi;
  }

  /** The next get() fetches a new picture (someone just rang). */
  invalidate(): void {
    this.cache = undefined;
    this.inFlight = undefined;
    this.generation++;
  }

  get(): Promise<Buffer> {
    const c = this.cache;
    if (c && Date.now() - c.at < MAX_AGE_MS) return Promise.resolve(c.data);
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    const p = this.isapi.snapshot().then((data) => {
      if (generation === this.generation) this.cache = { at: Date.now(), data };
      return data;
    });
    this.inFlight = p;
    const clear = () => {
      if (this.inFlight === p) this.inFlight = undefined;
    };
    p.then(clear, clear);
    return p;
  }

  /** A picture taken now, not a cached one. */
  fresh(): Promise<Buffer> {
    this.invalidate();
    return this.get();
  }
}
