// Dev helper: silent check of the SDK talk-back helper inside the add-on image.
import { Talkback } from '../src/hikvision/talkback.ts';
import { addSecret, setLogLevel } from '../src/log.ts';
import type { IsapiClient } from '../src/hikvision/isapi.ts';
setLogLevel('debug');
addSecret(process.env.HIK_PASS);
const tb = new Talkback({
  sdkDir: process.env.HCNETSDK_DIR ?? '/opt/hcnetsdk', host: process.env.HIK_HOST!, port: 8000,
  username: process.env.HIK_USER!, password: process.env.HIK_PASS!, isapi: {} as IsapiClient, ringAction: 'none', lingerMs: 500,
});
tb.acquire();
await new Promise((r) => setTimeout(r, 1500));
const t = Date.now();
await tb.start();
console.log(`start() resolved in ${Date.now() - t} ms, active=${tb.active}`);
for (let i = 0; i < 50; i++) { tb.write(Buffer.alloc(160, 0xff)); await new Promise((r) => setTimeout(r, 20)); }
await tb.stop();
tb.release();
await new Promise((r) => setTimeout(r, 1000));
await tb.shutdown();
console.log('smoke OK');
