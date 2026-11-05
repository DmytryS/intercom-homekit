import type { Logger } from '../log.ts';
import { IsapiAuthError, type IsapiClient } from './isapi.ts';

const MAX_AGE_MS = 4000;
/** How often to check, in the background, whether a failing picture endpoint works again. */
const PROBE_INTERVAL_MS = 10 * 60 * 1000;

export interface SnapshotSources {
  isapi: Pick<IsapiClient, 'snapshot'>;
  /** A frame from the video stream, for when the door station can't take pictures. */
  grabFrame: () => Promise<Buffer>;
  log: Logger;
}

/**
 * Door station snapshots shared by HomeKit and Home Assistant: a ring triggers both a HomeKit
 * notification and an MQTT image update, and they should cost the door station one request.
 *
 * The picture endpoint is preferred because it needs no stream slot, but door stations can get
 * into a state where it answers `deviceError` after 30 s while video keeps working. After one
 * failure, snapshots come straight from the stream so nobody waits for the endpoint again.
 */
export class SnapshotCache {
  private readonly sources: SnapshotSources;
  private cache?: { at: number; data: Buffer };
  private inFlight?: Promise<Buffer>;
  private generation = 0;
  private pictureFailing = false;
  private nextProbeAt = 0;

  constructor(sources: SnapshotSources) {
    this.sources = sources;
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
    const p = this.capture().then((data) => {
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

  private async capture(): Promise<Buffer> {
    const { isapi, grabFrame, log } = this.sources;
    if (this.pictureFailing) {
      this.probePicture();
      return grabFrame();
    }
    try {
      return await isapi.snapshot();
    } catch (err) {
      // The stream uses the same credentials: another attempt only brings an account lockout closer.
      if (err instanceof IsapiAuthError) throw err;
      this.pictureFailing = true;
      this.nextProbeAt = Date.now() + PROBE_INTERVAL_MS;
      log.warn(`door station picture request failed (${(err as Error).message}); taking snapshots from the video stream instead`);
      return grabFrame();
    }
  }

  private probePicture(): void {
    const { isapi, log } = this.sources;
    if (Date.now() < this.nextProbeAt) return;
    this.nextProbeAt = Date.now() + PROBE_INTERVAL_MS;
    isapi.snapshot().then(
      () => {
        this.pictureFailing = false;
        log.info('door station picture requests work again; no longer using the video stream for snapshots');
      },
      () => {},
    );
  }
}
