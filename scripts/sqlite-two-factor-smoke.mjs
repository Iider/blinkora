#!/usr/bin/env node

import crypto from 'node:crypto';

const base = process.env.BLINKORA_BASE_URL || 'http://127.0.0.1:6676';
const user = process.env.BLINKORA_SMOKE_USER || '';
const password = process.env.BLINKORA_SMOKE_PASSWORD || '';

if (process.env.BLINKORA_2FA_SMOKE_ALLOW_MUTATION !== '1') {
  fail('BLINKORA_2FA_SMOKE_ALLOW_MUTATION=1 is required because this check temporarily changes account security settings');
}
if (!user || !password) {
  fail('BLINKORA_SMOKE_USER and BLINKORA_SMOKE_PASSWORD are required');
}

function fail(message, details) {
  console.error(`\nFAIL: ${message}`);
  if (details !== undefined) {
    console.error(formatFailureDetails(details));
  }
  process.exitCode = 1;
  throw new Error(message);
}

function assert(condition, message, details) {
  if (!condition) fail(message, details);
}

function formatFailureDetails(details) {
  if (typeof details === 'string') return '[response body omitted]';
  return JSON.stringify(redactSensitiveValues(details), null, 2);
}

function redactSensitiveValues(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveValues);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    /(token|secret|password|authorization|cookie|qr)/i.test(key)
      ? '[redacted]'
      : redactSensitiveValues(child),
  ]));
}

async function request(path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // The assertion that needs JSON will report the response body if necessary.
  }
  return { response, text, json };
}

async function restLogin() {
  return request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: user, password }),
  });
}

async function trpc(path, input, token) {
  const result = await request(`/api/trpc/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ json: input }),
  });
  const data = result.json?.result?.data?.json;
  assert(result.response.ok, `${path} should succeed`, result.json || result.text);
  return data;
}

function totp(secret, timestamp = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let buffer = 0;
  const bytes = [];
  for (const character of secret.replace(/=+$/g, '').toUpperCase()) {
    const value = alphabet.indexOf(character);
    assert(value >= 0, 'generated TOTP secret must be Base32');
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  const counter = Math.floor(timestamp / 30_000);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto.createHmac('sha1', Buffer.from(bytes)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = ((digest[offset] & 0x7f) << 24)
    | (digest[offset + 1] << 16)
    | (digest[offset + 2] << 8)
    | digest[offset + 3];
  return String(value % 1_000_000).padStart(6, '0');
}

let cleanupToken = '';
let twoFactorWasEnabled = false;

try {
  const initialLogin = await restLogin();
  assert(initialLogin.response.ok, 'password login before enabling 2FA', initialLogin.json || initialLogin.text);
  assert(!initialLogin.json?.requiresTwoFactor, 'dedicated 2FA smoke account must start without 2FA');
  cleanupToken = initialLogin.json?.token || '';
  assert(cleanupToken, 'password login must return a token');

  const setup = await trpc('users.generate2FASecret', { name: user }, cleanupToken);
  const secret = setup?.secret;
  assert(typeof secret === 'string' && secret.length >= 16, '2FA setup must return a secret');
  const code = totp(secret);
  assert(await trpc('users.verify2FAToken', { secret, token: code }, cleanupToken) === true, '2FA setup code must verify');

  await trpc('config.update', { key: 'twoFactorSecret', value: secret }, cleanupToken);
  await trpc('config.update', { key: 'twoFactorEnabled', value: true }, cleanupToken);
  twoFactorWasEnabled = true;

  const challengedLogin = await restLogin();
  assert(challengedLogin.response.ok, 'password login must return a 2FA challenge', challengedLogin.json || challengedLogin.text);
  assert(challengedLogin.json?.requiresTwoFactor === true, 'password login must require 2FA after enabling it', challengedLogin.json);
  assert(Number.isInteger(challengedLogin.json?.userId), '2FA challenge must identify its user', challengedLogin.json);
  assert(!challengedLogin.json?.token, '2FA challenge must not issue a JWT', challengedLogin.json);

  const challengedTrpcLogin = await trpc('users.login', { name: user, password });
  assert(challengedTrpcLogin?.requiresTwoFactor === true, 'tRPC login must require 2FA after enabling it', challengedTrpcLogin);
  assert(Number.isInteger(challengedTrpcLogin?.userId), 'tRPC 2FA challenge must identify its user', challengedTrpcLogin);
  assert(!challengedTrpcLogin?.token, 'tRPC 2FA challenge must not issue a JWT', challengedTrpcLogin);

  const rejectedCode = await request('/api/auth/verify-2fa', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: challengedLogin.json.userId, code: '000000' }),
  });
  assert(rejectedCode.response.status === 401, 'invalid 2FA code must be rejected', rejectedCode.json || rejectedCode.text);

  const verifiedLogin = await request('/api/auth/verify-2fa', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: challengedLogin.json.userId, code: totp(secret) }),
  });
  assert(verifiedLogin.response.ok, 'valid 2FA code must complete login', verifiedLogin.json || verifiedLogin.text);
  assert(verifiedLogin.json?.token, 'completed 2FA login must issue a JWT', verifiedLogin.json);
  assert(verifiedLogin.json?.user?.name === user, 'completed 2FA login must return the original account', verifiedLogin.json);
  cleanupToken = verifiedLogin.json.token;
} finally {
  if (twoFactorWasEnabled && cleanupToken) {
    try {
      await trpc('config.update', { key: 'twoFactorEnabled', value: false }, cleanupToken);
      await trpc('config.update', { key: 'twoFactorSecret', value: '' }, cleanupToken);
      const restoredLogin = await restLogin();
      assert(restoredLogin.response.ok && !!restoredLogin.json?.token, '2FA smoke cleanup must restore password login', restoredLogin.json || restoredLogin.text);
    } catch (error) {
      console.error('\nFAIL: 2FA smoke cleanup could not restore the isolated account');
      throw error;
    }
  }
}

if (!process.exitCode) {
  console.log(JSON.stringify({ ok: true, base, user, check: 'two-factor-login' }, null, 2));
}
