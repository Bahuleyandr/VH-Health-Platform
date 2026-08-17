// Stateless callback routing for deployment-level Twilio credentials.
// The URL token binds tenant routing to the exact env account/auth pair used
// for the send; it carries no credential material and cannot be forged without
// TWILIO_AUTH_TOKEN. Database-config callbacks use their stored random tokens.

import { createHmac, timingSafeEqual } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENV_TOKEN_RE = /^env\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i;

function callbackMac(tenantId, accountSid, authToken) {
  return createHmac('sha256', authToken)
    .update(`vhhealth:twilio-status:v1:${tenantId}:${accountSid}`)
    .digest('base64url');
}

export function mintEnvTwilioCallbackToken({ tenantId, accountSid, authToken }) {
  const tenant = String(tenantId || '').trim().toLowerCase();
  const sid = String(accountSid || '').trim();
  const secret = String(authToken || '');
  if (!UUID_RE.test(tenant) || !sid || !secret) return null;
  return `env.${tenant}.${callbackMac(tenant, sid, secret)}`;
}

export function resolveEnvTwilioCallbackToken(token, { accountSid, authToken } = {}) {
  const candidate = String(token || '').trim();
  const match = ENV_TOKEN_RE.exec(candidate);
  if (!match) return null;
  const expected = mintEnvTwilioCallbackToken({
    tenantId: match[1], accountSid, authToken,
  });
  if (!expected) return null;
  const actualBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length
      || !timingSafeEqual(actualBytes, expectedBytes)) return null;
  return { tenantId: match[1].toLowerCase(), credentialSource: 'env' };
}

export const __testing__ = Object.freeze({ callbackMac });
