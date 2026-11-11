import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { frameGrabArgs, grabFrame } from '../src/media/frameGrab.ts';
import { IsapiAuthError, IsapiError } from '../src/drivers/hikvision/isapi.ts';
import { SnapshotCache } from '../src/media/snapshots.ts';
import { addSecret, redact, type Logger } from '../src/log.ts';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const TEN_MINUTES = 10 * 60 * 1000;
const flush = () => new Promise((r) => setImmediate(r));

function recorder() {
  const warnings: string[] = [];
  const infos: string[] = [];
  const log: Logger = { debug() {}, info: (m) => void infos.push(m), warn: (m) => void warnings.push(m), error() {} };
  return { log, warnings, infos };
}

describe('SnapshotCache', () => {
  it('shares one request between concurrent callers and refetches after a ring', async () => {
    let n = 0;
    const cache = new SnapshotCache({
      picture: async () => {
        n++;
        await new Promise((r) => setTimeout(r, 20));
        return Buffer.from([n]);
      },
      grabFrame: () => assert.fail('the picture endpoint works'),
      log: recorder().log,
    });
    const [a, b] = await Promise.all([cache.get(), cache.get()]);
    assert.equal(n, 1);
    assert.equal(a, b);
    assert.equal((await cache.get())[0], 1, 'cached');
    cache.invalidate();
    assert.equal((await cache.get())[0], 2, 'new picture after a ring');
    assert.equal((await cache.fresh())[0], 3);
  });

  describe('when the picture endpoint fails', () => {
    beforeEach(() => mock.timers.enable({ apis: ['Date'] }));
    afterEach(() => mock.timers.reset());

    function failing() {
      const calls = { picture: 0, grab: 0 };
      const state = { pictureWorks: false };
      const rec = recorder();
      const cache = new SnapshotCache({
        picture: async () => {
          calls.picture++;
          if (!state.pictureWorks) throw new IsapiError('HTTP 400: Device Error / deviceError', 400, 'deviceError');
          return Buffer.from('picture');
        },
        grabFrame: async () => {
          calls.grab++;
          return Buffer.from('frame');
        },
        log: rec.log,
      });
      return { cache, calls, state, ...rec };
    }

    it('answers from the stream, warning once and not asking the endpoint again', async () => {
      const { cache, calls, warnings } = failing();
      assert.equal((await cache.fresh()).toString(), 'frame');
      assert.equal((await cache.fresh()).toString(), 'frame');
      mock.timers.tick(TEN_MINUTES - 1);
      assert.equal((await cache.fresh()).toString(), 'frame');
      assert.deepEqual(calls, { picture: 1, grab: 3 });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /deviceError/);
    });

    it('checks in the background every 10 minutes, without holding up callers', async () => {
      const { cache, calls } = failing();
      await cache.fresh();
      mock.timers.tick(TEN_MINUTES);
      assert.equal((await cache.fresh()).toString(), 'frame');
      assert.equal(calls.picture, 2, 'probed');
      await cache.fresh();
      assert.equal(calls.picture, 2, 'one probe per interval');
    });

    it('goes back to the endpoint once a probe succeeds', async () => {
      const { cache, calls, state, infos } = failing();
      await cache.fresh();
      state.pictureWorks = true;
      mock.timers.tick(TEN_MINUTES);
      assert.equal((await cache.fresh()).toString(), 'frame', 'the probing request still answers from the stream');
      await flush();
      assert.equal((await cache.fresh()).toString(), 'picture');
      assert.equal(calls.grab, 2);
      assert.equal(infos.length, 1);
    });

    it('does not retry wrong credentials over RTSP, which could lock the account', async () => {
      let grabs = 0;
      const cache = new SnapshotCache({
        picture: () => Promise.reject(new IsapiAuthError('authentication rejected')),
        grabFrame: async () => {
          grabs++;
          return JPEG;
        },
        log: recorder().log,
      });
      await assert.rejects(cache.get(), IsapiAuthError);
      await assert.rejects(cache.fresh(), IsapiAuthError);
      assert.equal(grabs, 0);
    });

    it('reports the failure when the stream is unavailable too', async () => {
      const cache = new SnapshotCache({
        picture: () => Promise.reject(new Error('picture timed out')),
        grabFrame: () => Promise.reject(new Error('no stream slot')),
        log: recorder().log,
      });
      await assert.rejects(cache.get(), /no stream slot/);
    });
  });
});

describe('grabFrame', () => {
  const log = recorder().log;
  let dir: string;
  let previous: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'frame-grab-'));
    previous = process.env.FFMPEG_PATH;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  /** Puts a stand-in for ffmpeg on FFMPEG_PATH. */
  function fakeFfmpeg(script: string): void {
    const path = join(dir, 'ffmpeg');
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    process.env.FFMPEG_PATH = path;
  }

  it('asks ffmpeg for a single JPEG on stdout', () => {
    const args = frameGrabArgs('rtsp://u:p@host/101');
    assert.equal(args[args.indexOf('-i') + 1], 'rtsp://u:p@host/101');
    assert.equal(args[args.indexOf('-frames:v') + 1], '1');
    assert.equal(args.at(-1), 'pipe:1');
  });

  it('reads stdout to the end, even when it finishes after the process has exited', async () => {
    const size = 1024 * 1024;
    const file = join(dir, 'big.jpg');
    writeFileSync(file, Buffer.concat([JPEG, Buffer.alloc(size)]));
    fakeFfmpeg(`(sleep 0.2; cat "${file}") &\nexit 0`);
    const jpeg = await grabFrame('rtsp://host/101', log);
    assert.equal(jpeg.length, size + JPEG.length);
  });

  it('rejects output that is not a JPEG', async () => {
    fakeFfmpeg('printf "not an image"');
    await assert.rejects(grabFrame('rtsp://host/101', log), /frame grab failed/);
  });

  it('reports why ffmpeg failed without leaking the password', async () => {
    addSecret('s3cret-password');
    fakeFfmpeg('echo "rtsp://admin:s3cret-password@host/101: Server returned 500" >&2; exit 1');
    await assert.rejects(grabFrame('rtsp://admin:s3cret-password@host/101', log), (err: Error) => {
      assert.match(err.message, /exit 1.*Server returned 500/);
      assert.equal(redact(err.message), err.message);
      assert.doesNotMatch(err.message, /s3cret-password/);
      return true;
    });
  });

  it('stops an ffmpeg that hangs', async () => {
    fakeFfmpeg('exec sleep 30');
    const t = Date.now();
    await assert.rejects(grabFrame('rtsp://host/101', log, 100), /frame grab failed/);
    assert.ok(Date.now() - t < 5000);
  });

  it('fails cleanly when ffmpeg is not installed', async () => {
    process.env.FFMPEG_PATH = join(dir, 'missing');
    await assert.rejects(grabFrame('rtsp://host/101', log), /frame grab failed/);
  });
});
