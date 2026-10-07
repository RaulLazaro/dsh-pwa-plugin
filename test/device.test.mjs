import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEVICE_COOKIE_MAX_AGE_DAYS,
  MAX_DEVICES,
  addDevice,
  cookieAuthenticated,
  cookieName,
  cookieValue,
  describeDevices,
  emptyDevices,
  findDevice,
  hashKey,
  loadDevices,
  loadSecret,
  mintCookie,
  newDeviceKey,
  readSecret,
  removeDevice,
  requestAuthority,
  saveDevices,
  touchDevice
} from '../src/device.js';

const SECRET = randomBytes(32);
const SECRET_TEXT = SECRET.toString('base64url');
const AUTHORITY = 'vastus.tail4417fc.ts.net:3080';

// Shaped like the real file: the record sits under `records:`, two levels in,
// and another record follows it.
const CREDENTIALS = [
  'version: 1',
  'refs:',
  '  SOME_KEY: abc',
  'records:',
  '  client-connection/browser-session:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  `      secret: ${SECRET_TEXT}`,
  '  other/record:',
  '    kind: grant',
  '    payload:',
  '      version: 1',
  '      secret: not-this-one',
  ''
].join('\n');

// The cookie a browser would send for this host: the name is derived from the
// request authority, so a different authority presents a different name.
function at(cookieValueText, host, secret, when) {
  const authority = requestAuthority(host);
  return cookieAuthenticated(
    { hostHeader: host, cookieHeader: `${cookieName(authority)}=${cookieValueText}` },
    secret,
    DEVICE_COOKIE_MAX_AGE_DAYS,
    when
  );
}

test('readSecret reads the browser-session secret and no other record', () => {
  const secret = readSecret(CREDENTIALS);
  assert.ok(secret, 'the browser-session secret must be found');
  assert.equal(secret.toString('base64url'), SECRET_TEXT);
});

test('readSecret returns nothing for a file that does not carry the record', () => {
  const foreign = ['version: 1', 'records:', '  other/record:', '    secret: nope', ''].join('\n');
  assert.equal(readSecret(foreign), undefined);
  assert.equal(readSecret(''), undefined);
  assert.equal(readSecret('not yaml at all'), undefined);
  assert.equal(readSecret('records:\n  client-connection/browser-session:\n    kind: grant\n'), undefined);
});

test('readSecret refuses a secret that is not 32 canonical bytes', () => {
  const short = `records:\n  client-connection/browser-session:\n    secret: ${randomBytes(16).toString('base64url')}\n`;
  assert.equal(readSecret(short), undefined);
  const notBase64 = 'records:\n  client-connection/browser-session:\n    secret: ********\n';
  assert.equal(readSecret(notBase64), undefined);
});

test('loadSecret reads a credentials file and survives a missing one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-cred-'));
  try {
    const file = join(dir, '.credentials.yaml');
    writeFileSync(file, CREDENTIALS);
    assert.equal(loadSecret(file)?.toString('base64url'), SECRET_TEXT);
    assert.equal(loadSecret(join(dir, 'absent.yaml')), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the cookie identity matches dsh-client-connection', () => {
  assert.equal(requestAuthority('Vastus.Tail4417FC.ts.net:3080'), AUTHORITY);
  assert.equal(requestAuthority(''), undefined);
  assert.equal(requestAuthority(undefined), undefined);
  assert.equal(requestAuthority('['), undefined);
  assert.equal(cookieName(AUTHORITY), `dsh-auth-${createHash('sha256').update(AUTHORITY).digest('base64url')}`);
});

test('cookieValue reads only the named cookie', () => {
  assert.equal(cookieValue('a=1; dsh-auth-x=2; b=3', 'dsh-auth-x'), '2');
  assert.equal(cookieValue('a=1', 'dsh-auth-x'), undefined);
  assert.equal(cookieValue(undefined, 'dsh-auth-x'), undefined);
});

test('a minted cookie carries the attributes the fence writes', () => {
  const now = 1_700_000_000_000;
  const cookie = mintCookie({ authority: AUTHORITY, secret: SECRET, now });
  assert.equal(cookie.name, cookieName(AUTHORITY));
  assert.match(cookie.value, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(cookie.header.startsWith(`${cookie.name}=${cookie.value}; `));
  for (const attribute of ['Max-Age=', 'Path=/', 'Expires=', 'HttpOnly', 'SameSite=Strict']) {
    assert.ok(cookie.header.includes(attribute), `the cookie must carry ${attribute}`);
  }
  assert.equal(cookie.expiresAt, now + DEVICE_COOKIE_MAX_AGE_DAYS * 86_400_000);
  assert.equal(cookieAuthenticated({ hostHeader: AUTHORITY, cookieHeader: `a=1; ${cookie.name}=${cookie.value}` }, SECRET, DEVICE_COOKIE_MAX_AGE_DAYS, now), true);
});

test('a minted cookie is bound to its authority, its secret and its window', () => {
  const now = 1_700_000_000_000;
  const { value } = mintCookie({ authority: AUTHORITY, secret: SECRET, now });
  assert.equal(at(value, AUTHORITY, SECRET, now), true, 'the control case must pass');
  assert.equal(at(value, 'other.host:3080', SECRET, now), false, 'another authority must not accept it');
  assert.equal(at(value, AUTHORITY, randomBytes(32), now), false, 'another secret must not accept it');
  assert.equal(at(value, AUTHORITY, SECRET, now - 1), false, 'a cookie issued in the future must not be accepted');
  assert.equal(
    at(value, AUTHORITY, SECRET, now + DEVICE_COOKIE_MAX_AGE_DAYS * 86_400_000 + 1),
    false,
    'an expired cookie must not be accepted'
  );
});

test('a tampered payload is rejected', () => {
  const now = 1_700_000_000_000;
  const { value } = mintCookie({ authority: AUTHORITY, secret: SECRET, now });
  const [version, body, mac] = value.split('.');
  assert.equal(at(value, AUTHORITY, SECRET, now), true, 'the untampered value must pass');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  const forged = Buffer.from(JSON.stringify({ ...payload, expiresAt: payload.expiresAt + 1 }), 'utf8').toString('base64url');
  assert.equal(at(`v1.${forged}.${mac}`, AUTHORITY, SECRET, now), false, 'a rewritten payload must not verify');
  assert.equal(at(`v2.${body}.${mac}`, AUTHORITY, SECRET, now), false, 'another version must not verify');
  assert.equal(at(`v1.${body}.`, AUTHORITY, SECRET, now), false, 'a missing signature must not verify');
});

test('the device record round-trips, caps its size and finds a key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pwa-device-'));
  try {
    const file = join(dir, 'devices.json');
    assert.deepEqual(loadDevices(file), emptyDevices(), 'a missing file reads as an empty record');

    const key = newDeviceKey();
    saveDevices(file, addDevice(emptyDevices(), { id: 'a', label: 'Android Chrome', keyHash: hashKey(key), now: 1 }));
    const reloaded = loadDevices(file);
    assert.equal(reloaded.devices.length, 1);
    assert.equal(findDevice(reloaded, key)?.id, 'a');
    assert.equal(findDevice(reloaded, newDeviceKey()), undefined);
    assert.equal(findDevice(reloaded, ''), undefined);

    let many = emptyDevices();
    for (let i = 0; i < MAX_DEVICES + 5; i += 1) {
      many = addDevice(many, { id: `d${i}`, label: 'x', keyHash: hashKey(`k${i}`), now: i });
    }
    assert.equal(many.devices.length, MAX_DEVICES, 'the record must not grow without bound');
    assert.equal(many.devices[0].id, 'd5', 'the oldest entries are the ones dropped');

    const touched = touchDevice(many, 'd9', 99);
    assert.equal(touched.devices.find((device) => device.id === 'd9').lastSeenAt, 99);
    assert.equal(touched.devices.find((device) => device.id === 'd8').lastSeenAt, 8, 'other devices are untouched');
    assert.equal(removeDevice(many, 'd9').devices.length, MAX_DEVICES - 1);

    writeFileSync(file, '{ not json');
    assert.deepEqual(loadDevices(file), emptyDevices(), 'a corrupt record reads as empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the public device shape never carries the credential', () => {
  const state = addDevice(emptyDevices(), { id: 'a', label: 'Phone', keyHash: hashKey('secret-key'), now: 5 });
  const [described] = describeDevices(state);
  assert.deepEqual(Object.keys(described).sort(), ['createdAt', 'id', 'label', 'lastSeenAt']);
  assert.equal(JSON.stringify(described).includes(state.devices[0].keyHash), false);
});
