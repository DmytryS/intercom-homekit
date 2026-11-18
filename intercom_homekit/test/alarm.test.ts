/** Ring detection on the Hikvision SDK alarm channel, next to the call status poll. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { parseOptions } from '../src/config.ts';
import {
  ALARM_CALL_DISMISSED,
  ALARM_DOORBELL_RINGING,
  COMM_ALARM_VIDEO_INTERCOM,
  PressFilter,
  videoIntercomAlarmType,
} from '../src/drivers/hikvision/alarm.ts';
import { AlarmListener, type AlarmListenerEvents } from '../src/drivers/hikvision/alarmListener.ts';
import type { CallMonitorEvents } from '../src/drivers/hikvision/callMonitor.ts';
import { HikvisionIntercom, type HikvisionOptions, type HikvisionSources } from '../src/drivers/hikvision/index.ts';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

// The first 64 bytes of the alarms a DS-KV6113 (firmware V2.2.53) uploaded for one press.
const RINGING = '30020000ea070b121308330031303031303130303030300000000000000000000000000000000000000000001100000000000000000000000000000000000000';
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

describe('video intercom alarm messages', () => {
  it('reads the alarm type of a recorded "doorbell ringing" alarm', () => {
    assert.equal(videoIntercomAlarmType(COMM_ALARM_VIDEO_INTERCOM, bytes(RINGING)), ALARM_DOORBELL_RINGING);
    const dismissed = bytes(RINGING);
    dismissed[44] = ALARM_CALL_DISMISSED;
    assert.equal(videoIntercomAlarmType(COMM_ALARM_VIDEO_INTERCOM, dismissed), ALARM_CALL_DISMISSED);
  });

  it('ignores other messages and truncated ones', () => {
    assert.equal(videoIntercomAlarmType(0x1132, bytes(RINGING)), undefined);
    assert.equal(videoIntercomAlarmType(COMM_ALARM_VIDEO_INTERCOM, bytes(RINGING).subarray(0, 44)), undefined);
    assert.equal(videoIntercomAlarmType(COMM_ALARM_VIDEO_INTERCOM, new Uint8Array(0)), undefined);
  });
});

describe('press filter', () => {
  it('counts a press reported twice once, and a later press again', () => {
    const f = new PressFilter(10000);
    assert.equal(f.accept(1000), true);
    assert.equal(f.accept(1800), false);
    assert.equal(f.accept(10999), false);
    assert.equal(f.accept(11000), true);
  });
});

class FakeMonitor extends EventEmitter<CallMonitorEvents> {
  online = false;
  status?: string;
  start(): void {}
  stop(): void {}
  set(status: string): void {
    const previous = this.status;
    this.status = status;
    this.emit('status', status, previous);
  }
  setOnline(online: boolean): void {
    this.online = online;
    this.emit('online', online);
  }
}

class FakeAlarm extends EventEmitter<AlarmListenerEvents> {
  listening = true;
  lastError?: string;
  calls: string[] = [];
  start(): void {
    this.calls.push('start');
  }
  async stop(): Promise<void> {
    this.calls.push('stop');
  }
  rearm(): void {
    this.calls.push('rearm');
  }
  nudge(): void {
    this.calls.push('nudge');
  }
  async ready(): Promise<boolean> {
    return this.listening;
  }
}

function intercomWith(monitor: FakeMonitor, alarm: FakeAlarm): { intercom: HikvisionIntercom; rings: () => number; states: string[] } {
  const config = parseOptions({ doorbells: [{ name: 'Gate', host: '127.0.0.1', password: 'p' }] }, {}).doorbells[0];
  const sources = { monitor, alarm } as unknown as HikvisionSources;
  const intercom = new HikvisionIntercom(config, config.driverOptions as HikvisionOptions, () => quiet, sources);
  let rings = 0;
  const states: string[] = [];
  intercom.on('ring', () => rings++);
  intercom.on('callState', (s) => states.push(s));
  return { intercom, rings: () => rings, states };
}

describe('Hikvision ring detection', () => {
  it('rings from the alarm channel while the call status stays idle', async () => {
    const monitor = new FakeMonitor();
    const alarm = new FakeAlarm();
    const { intercom, rings, states } = intercomWith(monitor, alarm);
    monitor.set('idle');
    alarm.emit('ring');
    assert.equal(rings(), 1);
    assert.equal(intercom.callState, 'ringing');
    alarm.emit('dismissed');
    assert.equal(intercom.callState, 'idle');
    assert.deepEqual(states, ['idle', 'ringing', 'idle']);
    await intercom.close();
  });

  it('rings once when both the alarm channel and the call status report the press', async () => {
    const monitor = new FakeMonitor();
    const alarm = new FakeAlarm();
    const { intercom, rings, states } = intercomWith(monitor, alarm);
    monitor.set('idle');
    alarm.emit('ring');
    monitor.set('ring');
    monitor.emit('ring');
    assert.equal(rings(), 1);
    // The call status reports this call, so it decides when the ringing ends.
    monitor.set('idle');
    assert.equal(intercom.callState, 'idle');
    assert.deepEqual(states, ['idle', 'ringing', 'idle']);
    await intercom.close();
  });

  it('still rings from the call status alone', async () => {
    const monitor = new FakeMonitor();
    const alarm = new FakeAlarm();
    const { intercom, rings } = intercomWith(monitor, alarm);
    monitor.set('idle');
    monitor.set('ring');
    monitor.emit('ring');
    assert.equal(rings(), 1);
    assert.equal(intercom.callState, 'ringing');
    await intercom.close();
  });

  it('reopens the alarm channel when the door station comes back after an outage', async () => {
    const monitor = new FakeMonitor();
    const alarm = new FakeAlarm();
    const { intercom } = intercomWith(monitor, alarm);
    intercom.start();
    monitor.setOnline(true);
    assert.deepEqual(alarm.calls, ['start', 'nudge']);
    monitor.setOnline(false);
    monitor.setOnline(true);
    assert.deepEqual(alarm.calls, ['start', 'nudge', 'rearm']);
    await intercom.close();
    assert.equal(alarm.calls.at(-1), 'stop');
  });

  it('keeps retrying, without crashing, when the SDK helper cannot start', async () => {
    const listener = new AlarmListener({
      sdkDir: '/nonexistent-sdk-dir',
      host: '127.0.0.1',
      port: 8000,
      username: 'u',
      password: 'p',
      log: quiet,
      retryMs: 10,
      maxRetryMs: 20,
    });
    listener.start();
    assert.equal(await listener.ready(5000), false);
    assert.match(listener.lastError ?? '', /SDK helper failed to start/);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(listener.listening, false);
    await listener.stop();
  });
});
