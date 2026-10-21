// Trusted-device support for the installed app.
//
// WHY this exists: the token fence mints a signed cookie with a 30 day Max-Age
// from a signing secret that survives restarts, so a phone that signed in once
// should not be asked again. When it is asked anyway the phone has either lost
// the cookie or cannot present it, and an installed app has no address bar, so
// the only recovery is pasting a fresh code by hand. This module lets the phone
// hold a credential of its own instead: a random device key, kept in the app's
// own storage and recorded here only as a hash, which the host exchanges for a
// freshly minted session cookie.
//
// The cookie is minted with dsh's own contract (dsh-client-connection
// lib/index.js:284-322): a name derived from the request authority, and a value
// of v1.<base64url payload>.<base64url HMAC-SHA256>, signed with the durable
// browser-session secret. The fence accepts it because it is the same shape the
// fence itself writes. If dsh ever changes that contract the mint fails closed -
// the phone is asked for a code, which is what happens today.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const COOKIE_PREFIX = 'dsh-auth-';
export const DEVICE_COOKIE_MAX_AGE_DAYS = 30;
export const MAX_DEVICES = 10;

const COOKIE_PAYLOAD_VERSION = 1;
const SECRET_BYTES = 32;
const DEVICE_KEY_BYTES = 32;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000;
const AUTH_RECORD = 'client-connection/browser-session';

/** The canonical request authority dsh names its cookie after. */
export function requestAuthority(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return undefined;
  try {
    return new URL(`http://${hostHeader}`).host;
  } catch {
    return undefined;
  }
}

export function cookieName(authority) {
  return COOKIE_PREFIX + createHash('sha256').update(authority).digest('base64url');
}

/** Read the exact generated cookie without implementing general Cookie decoding. */
export function cookieValue(headerValue, name) {
  for (const segment of String(headerValue ?? '').split(';')) {
    const at = segment.indexOf('=');
    if (at === -1 || segment.slice(0, at).trim() !== name) continue;
    return segment.slice(at + 1).trim();
  }
  return undefined;
}

function unquote(value) {
  const text = String(value);
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
    return text.slice(1, -1);
  }
  return text;
}

function decodeSecret(value) {
  const text = unquote(value);
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return undefined;
  const decoded = Buffer.from(text, 'base64url');
  // dsh's own reader re-encodes and compares, so a value that is not canonical
  // base64url is rejected there and must be rejected here.
  if (decoded.byteLength !== SECRET_BYTES || decoded.toString('base64url') !== text) return undefined;
  return decoded;
}

/**
 * Pull the browser-session signing secret out of the credentials file.
 *
 * Deliberately narrow: it looks for the one record key under `records:` and the
 * first `secret:` inside that block, and returns undefined for anything else, so
 * an unrelated credentials layout degrades to "ask for a code" rather than
 * failing the plugin. The credentials service would be the cleaner source, but
 * its read method is provided by a separate provider package that this plugin
 * does not depend on.
 */
export function readSecret(yamlText) {
  let inRecord = false;
  for (const line of String(yamlText).split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inRecord = false;
      continue;
    }
    // Exactly two spaces and a non-space first character: `payload:` sits at four
    // spaces under this record and must not be mistaken for a record key, or the
    // block would end before its `secret:` line.
    const recordKey = /^ {2}(\S[^:]*):\s*$/.exec(line);
    if (recordKey !== null) {
      inRecord = recordKey[1].trim() === AUTH_RECORD;
      continue;
    }
    if (!inRecord) continue;
    const secret = /^\s+secret:\s*(\S+)\s*$/.exec(line);
    if (secret !== null) return decodeSecret(secret[1]);
  }
  return undefined;
}

/** The signing secret, or undefined when this home has none yet. */
export function loadSecret(credentialsPath) {
  try {
    return readSecret(readFileSync(credentialsPath, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Mint a session cookie the fence will accept for this authority.
 *
 * `maxAgeDays` must not exceed the fence's own configured window: it rejects a
 * cookie whose lifetime is longer than its own, so a shorter one is always safe.
 */
export function mintCookie({ authority, secret, maxAgeDays = DEVICE_COOKIE_MAX_AGE_DAYS, now = Date.now() }) {
  const issuedAt = now;
  const expiresAt = now + maxAgeDays * DAY_MILLISECONDS;
  const payload = { version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest().toString('base64url');
  const name = cookieName(authority);
  const value = `v1.${body}.${mac}`;
  const maxAgeSeconds = maxAgeDays * 24 * 60 * 60;
  return {
    name,
    value,
    expiresAt,
    header: `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`,
  };
}

/**
 * Whether this request already carries a cookie the fence would accept.
 *
 * The fence only gates the index, so this plugin's own routes are reachable by
 * anyone who can reach the host. Enrollment hands out a durable credential, so
 * it has to check for itself.
 */
export function cookieAuthenticated({ hostHeader, cookieHeader }, secret, maxAgeDays, now = Date.now()) {
  const authority = requestAuthority(hostHeader);
  if (authority === undefined || secret === undefined) return false;
  const value = cookieValue(cookieHeader, cookieName(authority));
  if (value === undefined) return false;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const body = parts[1];
  const encodedSignature = parts[2];
  const expectedSignature = createHmac('sha256', secret).update(body).digest();
  const actualSignature = Buffer.from(encodedSignature, 'base64url');
  if (actualSignature.byteLength !== expectedSignature.byteLength) return false;
  if (!timingSafeEqual(actualSignature, expectedSignature)) return false;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (payload === null || typeof payload !== 'object') return false;
  if (payload.version !== COOKIE_PAYLOAD_VERSION || payload.authority !== authority) return false;
  if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)) return false;
  const window = maxAgeDays * DAY_MILLISECONDS;
  return (
    payload.issuedAt <= now &&
    payload.expiresAt > now &&
    payload.expiresAt > payload.issuedAt &&
    payload.expiresAt - payload.issuedAt <= window
  );
}

export function newDeviceKey() {
  return randomBytes(DEVICE_KEY_BYTES).toString('base64url');
}

export function hashKey(key) {
  return createHash('sha256').update(String(key)).digest('base64url');
}

export function emptyDevices() {
  return { version: 1, devices: [] };
}

export function loadDevices(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed?.version !== 1 || !Array.isArray(parsed.devices)) return emptyDevices();
    return { version: 1, devices: parsed.devices.filter((device) => typeof device?.keyHash === 'string') };
  } catch {
    return emptyDevices();
  }
}

/** Written through a temporary file so a crash cannot truncate the record. */
export function saveDevices(file, state) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2));
  renameSync(temporary, file);
}

/** Constant-time lookup: a device key is a bearer credential. */
export function findDevice(state, key) {
  if (typeof key !== 'string' || key === '') return undefined;
  const wanted = Buffer.from(hashKey(key), 'utf8');
  for (const device of state.devices) {
    const stored = Buffer.from(String(device.keyHash), 'utf8');
    if (stored.byteLength === wanted.byteLength && timingSafeEqual(stored, wanted)) return device;
  }
  return undefined;
}

export function addDevice(state, { id, label, keyHash, now }) {
  const device = { id, label, keyHash, createdAt: now, lastSeenAt: now };
  // Oldest first out: a phone that re-enrolls must not be pushed out by a
  // stream of enrollments, but an unbounded file is worse than losing the
  // least recently created entry.
  const devices = [...state.devices, device].slice(-MAX_DEVICES);
  return { version: 1, devices };
}

export function removeDevice(state, id) {
  return { version: 1, devices: state.devices.filter((device) => device.id !== id) };
}

export function touchDevice(state, id, now) {
  return {
    version: 1,
    devices: state.devices.map((device) => (device.id === id ? { ...device, lastSeenAt: now } : device)),
  };
}

/** Public shape of a device: never the hash, which is the credential itself. */
export function describeDevices(state) {
  return state.devices.map((device) => ({
    id: device.id,
    label: typeof device.label === 'string' ? device.label : 'Device',
    createdAt: device.createdAt ?? null,
    lastSeenAt: device.lastSeenAt ?? null,
  }));
}
