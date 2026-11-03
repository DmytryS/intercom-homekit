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

/** HAP-NodeJS storage for all accessories (pairings, keyed by accessory id). */
export function homekitPersistDir(dataDir: string): string {
  return path.join(dataDir, 'homekit', 'persist');
}

export interface IdentityRequest {
  /** Storage key (slug of the doorbell name). */
  key: string;
  name: string;
  host: string;
  pin?: string;
  reset: boolean;
}

interface StoredIdentity extends Identity {
  name?: string;
  host?: string;
}

function newIdentity(pin: string | undefined): Identity {
  return { username: randomUsername(), pincode: pin ?? randomPin(), setupId: randomSetupId() };
}

function valid(i: Partial<Identity> | undefined): i is Identity {
  return Boolean(i?.username && i.pincode && i.setupId);
}

/**
 * HomeKit identities of all doorbells, in `<dataDir>/homekit/identities.json`, keyed by the
 * doorbell name. HAP-NodeJS keeps pairings per accessory id in the shared `persist` directory.
 *
 * - A renamed doorbell keeps its identity (and pairing) when its host is unchanged.
 * - The single identity of versions before 0.6 (`identity.json`) goes to the first doorbell.
 * - `reset` creates a new accessory id; `cleanup` deletes the old one's pairing data.
 */
export function loadIdentities(
  dataDir: string,
  doorbells: IdentityRequest[],
  cleanup: (username: string) => void = () => {},
): { identities: Map<string, Identity>; persistDir: string; notes: string[] } {
  const dir = path.join(dataDir, 'homekit');
  const persistDir = homekitPersistDir(dataDir);
  const file = path.join(dir, 'identities.json');
  const legacyFile = path.join(dir, 'identity.json');
  mkdirSync(persistDir, { recursive: true });
  const notes: string[] = [];

  let store: Record<string, StoredIdentity> = {};
  if (existsSync(file)) {
    try {
      store = JSON.parse(readFileSync(file, 'utf8')) as Record<string, StoredIdentity>;
    } catch {
      notes.push(`${file} is unreadable; creating new HomeKit identities`);
    }
  } else if (existsSync(legacyFile) && doorbells.length) {
    try {
      const legacy = JSON.parse(readFileSync(legacyFile, 'utf8')) as Identity;
      if (valid(legacy)) {
        store[doorbells[0].key] = { ...legacy, name: doorbells[0].name, host: doorbells[0].host };
        notes.push(`kept the existing HomeKit pairing for "${doorbells[0].name}"`);
      }
    } catch {
      /* start fresh */
    }
  }

  const wanted = new Set(doorbells.map((d) => d.key));
  const identities = new Map<string, Identity>();
  for (const d of doorbells) {
    let entry: StoredIdentity | undefined = store[d.key];
    if (!valid(entry)) {
      // Renamed? Take over an identity no configured doorbell uses that points at the same door station.
      const orphan = Object.entries(store).find(([k, v]) => !wanted.has(k) && valid(v) && v.host === d.host);
      if (orphan) {
        entry = orphan[1];
        delete store[orphan[0]];
        notes.push(`"${d.name}" keeps the HomeKit pairing of "${orphan[1].name ?? orphan[0]}" (same door station)`);
      }
    }
    if (d.reset && valid(entry)) {
      cleanup(entry.username);
      entry = undefined;
      notes.push(`HomeKit pairing of "${d.name}" was reset: turn "reset_homekit_pairing" off again, then pair the new accessory`);
    }
    const identity: Identity = valid(entry) ? { username: entry.username, pincode: entry.pincode, setupId: entry.setupId } : newIdentity(d.pin);
    if (d.pin && d.pin !== identity.pincode) identity.pincode = d.pin;
    if (INVALID_PINS.has(identity.pincode)) throw new Error(`HomeKit rejects the trivial setup code ${identity.pincode} ("${d.name}")`);
    store[d.key] = { ...identity, name: d.name, host: d.host };
    identities.set(d.key, identity);
  }

  writeFileSync(file, JSON.stringify(store, null, 2));
  if (existsSync(legacyFile)) rmSync(legacyFile, { force: true });
  return { identities, persistDir, notes };
}
