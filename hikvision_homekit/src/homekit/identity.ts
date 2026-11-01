import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface Identity {
  /** HAP "username": a MAC-address-like accessory id. Changing it means a new accessory. */
  username: string;
  pincode: string;
  setupId: string;
}

const INVALID_PINS = new Set([
  '000-00-000', '111-11-111', '222-22-222', '333-33-333', '444-44-444', '555-55-555',
  '666-66-666', '777-77-777', '888-88-888', '999-99-999', '123-45-678', '876-54-321',
]);

export function randomPin(): string {
  for (;;) {
    const d = Array.from({ length: 8 }, () => randomInt(0, 10)).join('');
    const pin = `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
    if (!INVALID_PINS.has(pin)) return pin;
  }
}

function randomUsername(): string {
  const b = randomBytes(6);
  b[0] = (b[0] & 0xfe) | 0x02; // locally administered, unicast
  return [...b].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

function randomSetupId(): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return Array.from({ length: 4 }, () => chars[randomInt(0, chars.length)]).join('');
}

/**
 * Load (or create) the accessory identity under `<dataDir>/homekit`. `reset` wipes it
 * together with all HomeKit pairings, producing a brand-new accessory.
 */
export function loadIdentity(dataDir: string, configuredPin: string | undefined, reset: boolean): { identity: Identity; persistDir: string } {
  const dir = path.join(dataDir, 'homekit');
  const persistDir = path.join(dir, 'persist');
  const file = path.join(dir, 'identity.json');
  if (reset) rmSync(dir, { recursive: true, force: true });
  mkdirSync(persistDir, { recursive: true });

  let identity: Identity | undefined;
  if (existsSync(file)) {
    try {
      identity = JSON.parse(readFileSync(file, 'utf8')) as Identity;
    } catch {
      identity = undefined;
    }
  }
  if (!identity?.username || !identity.pincode || !identity.setupId) {
    identity = { username: randomUsername(), pincode: configuredPin ?? randomPin(), setupId: randomSetupId() };
  }
  if (configuredPin && configuredPin !== identity.pincode) identity.pincode = configuredPin;
  if (INVALID_PINS.has(identity.pincode)) throw new Error(`HomeKit rejects the trivial setup code ${identity.pincode}`);
  writeFileSync(file, JSON.stringify(identity, null, 2));
  return { identity, persistDir };
}
