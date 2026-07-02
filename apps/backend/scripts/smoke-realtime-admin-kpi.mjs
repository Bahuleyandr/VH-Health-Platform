#!/usr/bin/env node

import crypto from 'node:crypto';
import WebSocket from 'ws';

const ADMIN_BASE_URL = stripTrailingSlash(process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3001');
const BACKEND_WS_URL = resolveWsUrl();
const ADMIN_USERNAME = process.env.PLAYWRIGHT_ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.PLAYWRIGHT_ADMIN_PASSWORD || 'test1234';
const TOTP_SECRET = process.env.PLAYWRIGHT_ADMIN_TOTP_SECRET || '';
const ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN || ADMIN_BASE_URL;

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function resolveWsUrl() {
  const raw = process.env.NEXT_PUBLIC_WS_URL || process.env.BACKEND_URL || 'ws://127.0.0.1:5206';
  const url = new URL(raw);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (!url.pathname || url.pathname === '/') url.pathname = '/ws';
  return url.toString();
}

function fail(message, details) {
  const suffix = details ? `\n${typeof details === 'string' ? details : JSON.stringify(details, null, 2)}` : '';
  throw new Error(`[smoke-realtime-admin-kpi] ${message}${suffix}`);
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { response, data, text };
}

function setCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const cookie = response.headers.get('set-cookie');
  return cookie ? [cookie] : [];
}

function authCookie(response) {
  const cookie = setCookies(response).find((entry) => /^auth_token=/.test(entry));
  if (!cookie) return null;
  return cookie.split(';', 1)[0];
}

function base32ToBuffer(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of value.replace(/=+$/, '').toUpperCase().replace(/\s/g, '')) {
    const index = alphabet.indexOf(ch);
    if (index >= 0) bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function totpCode(secret, step = 30, digits = 6) {
  const counter = Math.floor(Date.now() / 1000 / step);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32ToBuffer(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

async function loginAndGetCookie() {
  const login = await postJson(`${ADMIN_BASE_URL}/api/login`, {
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
  });
  if (!login.response.ok) {
    fail(`admin login failed with HTTP ${login.response.status}`, login.data || login.text);
  }

  const payload = login.data?.data ?? login.data ?? {};
  if (payload.requiresTwoFactor) {
    if (!payload.challengeToken) fail('admin login requested 2FA without a challengeToken', login.data);
    if (!TOTP_SECRET) fail('PLAYWRIGHT_ADMIN_TOTP_SECRET is required for the admin 2FA challenge');

    const mfa = await postJson(`${ADMIN_BASE_URL}/api/login/mfa`, {
      challengeToken: payload.challengeToken,
      code: totpCode(TOTP_SECRET),
    });
    if (!mfa.response.ok) {
      fail(`admin MFA verification failed with HTTP ${mfa.response.status}`, mfa.data || mfa.text);
    }

    const cookie = authCookie(mfa.response);
    if (!cookie) fail('admin MFA response did not set auth_token cookie', mfa.data);
    return cookie;
  }

  const cookie = authCookie(login.response);
  if (!cookie) fail('admin login response did not set auth_token cookie', login.data);
  return cookie;
}

async function getRealtimeTicket(cookie) {
  const ticketResponse = await postJson(`${ADMIN_BASE_URL}/api/realtime-ticket`, {}, { Cookie: cookie });
  if (!ticketResponse.response.ok) {
    fail(`realtime ticket request failed with HTTP ${ticketResponse.response.status}`, ticketResponse.data || ticketResponse.text);
  }
  const ticket = ticketResponse.data?.ticket ?? ticketResponse.data?.data?.ticket;
  if (!ticket) fail('realtime ticket response did not include a ticket', ticketResponse.data);
  return ticket;
}

function waitForAdminKpiSubscription(ticket) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BACKEND_WS_URL, { handshakeTimeout: 10_000 });
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`[smoke-realtime-admin-kpi] timed out waiting for admin:kpi subscribed ack`));
    }, 15_000);

    const finish = (fn, value) => {
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // no-op: closing a failed socket should not hide the smoke failure.
      }
      fn(value);
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({ action: 'auth', token: ticket }));
    });

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        finish(reject, new Error(`[smoke-realtime-admin-kpi] non-JSON WS frame: ${raw.toString()}`));
        return;
      }

      if (message.event === 'connected') {
        ws.send(JSON.stringify({ action: 'subscribe', channel: 'admin:kpi' }));
        return;
      }

      if (message.event === 'subscribed' && message.channel === 'admin:kpi') {
        finish(resolve, message);
        return;
      }

      if (message.event === 'subscribe-denied' && message.channel === 'admin:kpi') {
        finish(reject, new Error(`[smoke-realtime-admin-kpi] admin:kpi subscribe denied: ${message.reason || 'no reason'}`));
        return;
      }

      if (message.event === 'auth_failed' || message.event === 'error') {
        finish(reject, new Error(`[smoke-realtime-admin-kpi] websocket failure: ${JSON.stringify(message)}`));
      }
    });

    ws.on('error', (error) => finish(reject, error));
    ws.on('close', (code, reason) => {
      if (code !== 1000 && code !== 1005) {
        finish(reject, new Error(`[smoke-realtime-admin-kpi] websocket closed before subscribed ack: ${code} ${reason.toString()}`));
      }
    });
  });
}

const cookie = await loginAndGetCookie();
const ticket = await getRealtimeTicket(cookie);
const ack = await waitForAdminKpiSubscription(ticket);

console.log(`[smoke-realtime-admin-kpi] subscribed to ${ack.channel} via ${BACKEND_WS_URL}`);
