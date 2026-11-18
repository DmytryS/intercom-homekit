// Dev helper: listens on the Hikvision SDK alarm channel and prints every message the door
// station uploads (doorbell presses arrive as video intercom alarms). Run inside the add-on image:
//   HIK_HOST=… HIK_USER=… HIK_PASS=… node scripts/smoke-alarm.ts [seconds] [sdkPort]
import path from 'node:path';
import koffi from 'koffi';
import { ALARM_CALL_DISMISSED, ALARM_DOORBELL_RINGING, COMM_ALARM_VIDEO_INTERCOM, videoIntercomAlarmType } from '../src/drivers/hikvision/alarm.ts';

const COMMANDS: Record<number, string> = {
  0x1132: 'COMM_UPLOAD_VIDEO_INTERCOM_EVENT',
  [COMM_ALARM_VIDEO_INTERCOM]: 'COMM_ALARM_VIDEO_INTERCOM',
};
/** Alarm types seen on a DS-KV6113 for one press; other values are printed as numbers. */
const ALARM_TYPES: Record<number, string> = {
  [ALARM_DOORBELL_RINGING]: 'doorbell ringing',
  [ALARM_CALL_DISMISSED]: 'incoming call dismissed',
};

const seconds = Number(process.argv[2]) || 120;
const port = Number(process.argv[3]) || Number(process.env.HIK_SDK_PORT) || 8000;
const dir = process.env.HCNETSDK_DIR || '/opt/hcnetsdk';
const ts = () => new Date().toISOString().slice(11, 23);
const say = (m: string) => console.log(`${ts()} ${m}`);

const lib = koffi.load(path.join(dir, 'libhcnetsdk.so'));
const MessageCallback = koffi.proto('int MessageCallback(int command, void *alarmer, void *info, uint32_t length, void *user)');
const sdk = {
  init: lib.func('int NET_DVR_Init()'),
  cleanup: lib.func('int NET_DVR_Cleanup()'),
  setConnectTime: lib.func('int NET_DVR_SetConnectTime(uint32_t, uint32_t)'),
  setReconnect: lib.func('int NET_DVR_SetReconnect(uint32_t, int)'),
  lastError: lib.func('uint32_t NET_DVR_GetLastError()'),
  login: lib.func('int NET_DVR_Login_V30(const char*, uint16_t, const char*, const char*, void*)'),
  logout: lib.func('int NET_DVR_Logout_V30(int)'),
  setMessageCallback: lib.func('int NET_DVR_SetDVRMessageCallBack_V31(MessageCallback *callback, void *user)'),
  setupAlarm: lib.func('int NET_DVR_SetupAlarmChan_V41(int, const uint8_t*)'),
  closeAlarm: lib.func('int NET_DVR_CloseAlarmChan_V30(int)'),
};

let messages = 0;
// Called on an SDK thread; koffi relays it to the main thread while the SDK waits, so `info` stays valid.
const callback = koffi.register((command: number, _alarmer: unknown, info: unknown, length: number) => {
  messages++;
  const bytes = info && length ? Buffer.from(koffi.view(info, Math.min(length, 64))) : Buffer.alloc(0);
  const type = videoIntercomAlarmType(command, bytes);
  const detail = type === undefined ? '' : ` alarm type ${type} (${ALARM_TYPES[type] ?? 'not seen before'})`;
  say(`message 0x${command.toString(16)} ${COMMANDS[command] ?? ''}${detail}, ${length} bytes: ${bytes.toString('hex')}`);
  return 1;
}, koffi.pointer(MessageCallback));

if (!sdk.init()) throw new Error(`NET_DVR_Init failed: SDK error ${sdk.lastError()}`);
sdk.setConnectTime(3000, 1);
sdk.setReconnect(5000, 1);
sdk.setMessageCallback(callback, null);

const user = sdk.login(process.env.HIK_HOST!, port, process.env.HIK_USER!, process.env.HIK_PASS!, Buffer.alloc(512)) as number;
if (user < 0) throw new Error(`login failed: SDK error ${sdk.lastError()}`);
say('SDK login ok');

// NET_DVR_SETUPALARM_PARAM: dwSize, byLevel, byAlarmInfoType, … (20 bytes).
const param = Buffer.alloc(20);
param.writeUInt32LE(param.length, 0);
param[4] = 1;
param[5] = 1;
const alarm = sdk.setupAlarm(user, param) as number;
if (alarm < 0) {
  const code = sdk.lastError();
  sdk.logout(user);
  throw new Error(`NET_DVR_SetupAlarmChan_V41 failed: SDK error ${code}`);
}
say(`alarm channel open; listening for ${seconds} s — press the doorbell button`);

const beat = setInterval(() => say(`  alive: ${messages} messages`), 30000);
const finish = () => {
  clearInterval(beat);
  sdk.closeAlarm(alarm);
  sdk.logout(user);
  koffi.unregister(callback);
  sdk.cleanup();
  say(`done: ${messages} messages`);
  process.exit(0);
};
setTimeout(finish, seconds * 1000);
process.on('SIGTERM', finish);
process.on('SIGINT', finish);
