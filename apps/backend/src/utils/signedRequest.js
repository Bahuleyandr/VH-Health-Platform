// HMAC request authenticity helper for public/integration callbacks.
//
// Callers sign the canonical string:
//   <timestamp>.<requestId>.<payload>
// where payload is either the parsed JSON body re-serialized with
// JSON.stringify, or a raw protocol payload string such as HL7v2.

import crypto from 'crypto';

import { AppError } from './AppError.js';

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_REPLAY_CACHE_ENTRIES = 5000;
const replayCache = new Map();

function nowMs() {
  return Date.now();
}

function normalizeSignature(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const sigPart = text.split(',').find((part) => part.trim().startsWith('sig='));
  const candidate = sigPart ? sigPart.split('=').slice(1).join('=') : text.replace(/^sha256=/i, '');
  return /^[0-9a-f]{64}$/i.test(candidate) ? candidate.toLowerCase() : null;
}

function canonicalPayload(payload) {
  return typeof payload === 'string' ? payload : JSON.stringify(payload || {});
}

function assertFreshTimestamp(timestamp, { toleranceMs, codePrefix, context }) {
  const raw = String(timestamp || '').trim();
  if (!raw) {
    throw AppError.unauthorized(`${context} timestamp is required`, `${codePrefix}_TIMESTAMP_REQUIRED`);
  }
  const numeric = Number(raw);
  const requestTime = Number.isFinite(numeric)
    ? (numeric < 1_000_000_000_000 ? numeric * 1000 : numeric)
    : Date.parse(raw);
  if (!Number.isFinite(requestTime)) {
    throw AppError.unauthorized(`${context} timestamp is invalid`, `${codePrefix}_TIMESTAMP_INVALID`);
  }
  if (Math.abs(nowMs() - requestTime) > toleranceMs) {
    throw AppError.unauthorized(`${context} timestamp is out of range`, `${codePrefix}_TIMESTAMP_STALE`);
  }
  return raw;
}

function rememberReplayKey(key, toleranceMs, codePrefix, context) {
  const now = nowMs();
  for (const [cachedKey, seenAt] of replayCache) {
    if (now - seenAt > toleranceMs) replayCache.delete(cachedKey);
  }
  if (replayCache.has(key)) {
    throw AppError.unauthorized(`${context} request replay detected`, `${codePrefix}_REPLAY`);
  }
  replayCache.set(key, now);
  if (replayCache.size > MAX_REPLAY_CACHE_ENTRIES) {
    const oldest = replayCache.keys().next().value;
    replayCache.delete(oldest);
  }
}

export function verifySignedRequest({
  secret,
  signature,
  timestamp,
  requestId,
  payload,
  context = 'Signed request',
  codePrefix = 'SIGNED_REQUEST',
  toleranceMs = DEFAULT_TOLERANCE_MS,
  replayNamespace = 'signed-request',
} = {}) {
  if (!secret) {
    throw new AppError(`${context} signing secret is not configured`, 503, `${codePrefix}_SECRET_NOT_CONFIGURED`);
  }
  const ts = assertFreshTimestamp(timestamp, { toleranceMs, codePrefix, context });
  const rid = String(requestId || '').trim();
  if (!rid) {
    throw AppError.unauthorized(`${context} request id is required`, `${codePrefix}_REQUEST_ID_REQUIRED`);
  }
  const provided = normalizeSignature(signature);
  if (!provided) {
    throw AppError.unauthorized(`${context} signature is required`, `${codePrefix}_SIGNATURE_REQUIRED`);
  }

  const signedPayload = `${ts}.${rid}.${canonicalPayload(payload)}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    throw AppError.unauthorized(`${context} signature is invalid`, `${codePrefix}_SIGNATURE_INVALID`);
  }

  rememberReplayKey(`${replayNamespace}:${rid}:${ts}:${provided}`, toleranceMs, codePrefix, context);
  return true;
}

export const __testing__ = {
  canonicalPayload,
  normalizeSignature,
  replayCache,
};

export default { verifySignedRequest };
