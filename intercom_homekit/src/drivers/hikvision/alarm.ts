/**
 * Messages the Hikvision SDK uploads on its alarm channel, as far as ring detection needs them.
 *
 * A doorbell press arrives as a video intercom alarm of type 17, and the end of an unanswered call
 * as type 18 (seen on the DS-KV6113, firmware V2.2.53; the same values the Hikvision Doorbell
 * add-on by pergolafabio uses).
 */

/** Message type (`lCommand`) carrying a NET_DVR_VIDEO_INTERCOM_ALARM. */
export const COMM_ALARM_VIDEO_INTERCOM = 0x1133;
export const ALARM_DOORBELL_RINGING = 17;
export const ALARM_CALL_DISMISSED = 18;

/** NET_DVR_VIDEO_INTERCOM_ALARM: dwSize (4), time (8), device number (32), then byAlarmType. */
const ALARM_TYPE_OFFSET = 44;

/** The alarm type of a video intercom alarm message, or undefined for any other message. */
export function videoIntercomAlarmType(command: number, info: Uint8Array): number | undefined {
  if (command !== COMM_ALARM_VIDEO_INTERCOM || info.length <= ALARM_TYPE_OFFSET) return undefined;
  return info[ALARM_TYPE_OFFSET];
}

/** SDK exception codes that mean the login or the alarm channel was lost. */
export const SDK_CONNECTION_LOST = new Set([
  0x8000, // EXCEPTION_EXCHANGE: no heartbeat from the device
  0x8002, // EXCEPTION_ALARM
  0x8006, // EXCEPTION_ALARMRECONNECT
  0x8040, // EXCEPTION_RELOGIN
]);

/** Suppresses repeats of one doorbell press, reported by more than one source. */
export class PressFilter {
  private last = -Infinity;
  private readonly windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  /** True for a new press; false for one within the window of the last accepted press. */
  accept(now: number = Date.now()): boolean {
    if (now - this.last < this.windowMs) return false;
    this.last = now;
    return true;
  }
}
