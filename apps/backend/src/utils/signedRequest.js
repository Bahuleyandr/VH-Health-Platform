// HMAC request authenticity helper for public/integration callbacks.
//
// Legacy callers sign:
//   <timestamp>.<requestId>.<payload>
// Endpoint-bound v1 callers sign:
//   vhhealth.signed-request.v1\n<METHOD>\n<CANONICAL_PATH>\n<timestamp>\n<requestId>\n<payload>
// where payload is either the exact captured request bytes, a raw protocol
// payload string such as HL7v2, or (for trusted internal callers only) parsed
// JSON serialized with JSON.stringify. New public HTTP callback contracts must
// use endpoint-bound v1; legacy stays available only for explicitly held
// protocol-compatibility callers.

import crypto from 'crypto';

import prisma from '../lib/prisma.js';
import { getRedisClient } from '../lib/redis.js';
import logger from '../logging/logger.js';
import { AppError } from './AppError.js';

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_REPLAY_CACHE_ENTRIES = 5000;
const ENDPOINT_BOUND_V1_DOMAIN = 'vhhealth.signed-request.v1';
export const SIGNED_REQUEST_SIGNATURE_VERSIONS = Object.freeze({
  LEGACY: 'legacy',
  ENDPOINT_BOUND_V1: 'v1',
});
// Per-process fast-path cache. Rejects same-process replays without a round
// trip; the durable cross-replica authority is the interop_replay_guard table.
// Redis is only a post-claim coordination marker (see assertSharedReplayOnce /
// migration 321).
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
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8');
  return Buffer.from(JSON.stringify(payload || {}), 'utf8');
}

function normalizeSignatureVersion(value, { codePrefix, context }) {
  const version = String(value || SIGNED_REQUEST_SIGNATURE_VERSIONS.LEGACY).trim().toLowerCase();
  if (version === SIGNED_REQUEST_SIGNATURE_VERSIONS.LEGACY
      || version === SIGNED_REQUEST_SIGNATURE_VERSIONS.ENDPOINT_BOUND_V1) {
    return version;
  }
  throw AppError.unauthorized(
    `${context} signature version is unsupported`,
    `${codePrefix}_SIGNATURE_VERSION_UNSUPPORTED`,
  );
}

function canonicalMethod(value, { codePrefix, context }) {
  const method = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]+$/.test(method)) {
    throw AppError.unauthorized(
      `${context} HTTP method is required`,
      `${codePrefix}_METHOD_REQUIRED`,
    );
  }
  return method;
}

function canonicalPath(value, { codePrefix, context }) {
  const path = String(value || '').trim();
  // The caller must supply the already-canonical application path. Query
  // parameters are deliberately outside the endpoint identity; reverse-proxy
  // prefixes must be removed before this boundary. Refuse to normalize here —
  // accepting two spellings would make the signed intent ambiguous.
  if (!path.startsWith('/')
      || path.includes('?')
      || path.includes('#')
      || path.includes('\\')
      || path.includes('//')
      || /\/(?:\.{1,2})(?:\/|$)/.test(path)) {
    throw AppError.unauthorized(
      `${context} canonical path is invalid`,
      `${codePrefix}_CANONICAL_PATH_INVALID`,
    );
  }
  return path;
}

function assertLineSafe(value, field, { codePrefix, context }) {
  if (/[\r\n]/.test(value)) {
    throw AppError.unauthorized(
      `${context} ${field} is invalid`,
      `${codePrefix}_${field.toUpperCase().replaceAll(' ', '_')}_INVALID`,
    );
  }
}

function signingPrefix({ signatureVersion, method, canonicalPath: path, timestamp, requestId, codePrefix, context }) {
  if (signatureVersion === SIGNED_REQUEST_SIGNATURE_VERSIONS.LEGACY) {
    return Buffer.from(`${timestamp}.${requestId}.`, 'utf8');
  }
  const boundMethod = canonicalMethod(method, { codePrefix, context });
  const boundPath = canonicalPath(path, { codePrefix, context });
  assertLineSafe(timestamp, 'timestamp', { codePrefix, context });
  assertLineSafe(requestId, 'request id', { codePrefix, context });
  return Buffer.from(
    `${ENDPOINT_BOUND_V1_DOMAIN}\n${boundMethod}\n${boundPath}\n${timestamp}\n${requestId}\n`,
    'utf8',
  );
}

function signatureHex({
  secret,
  signatureVersion,
  method,
  canonicalPath: path,
  timestamp,
  requestId,
  payload,
  codePrefix,
  context,
}) {
  return crypto.createHmac('sha256', secret)
    .update(signingPrefix({
      signatureVersion,
      method,
      canonicalPath: path,
      timestamp,
      requestId,
      codePrefix,
      context,
    }))
    .update(canonicalPayload(payload))
    .digest('hex');
}

function replayMember({
  signatureVersion,
  method,
  canonicalPath: path,
  requestId,
  timestamp,
  signature,
  codePrefix,
  context,
}) {
  if (signatureVersion === SIGNED_REQUEST_SIGNATURE_VERSIONS.LEGACY) {
    return `${requestId}:${timestamp}:${signature}`;
  }
  const boundMethod = canonicalMethod(method, { codePrefix, context });
  const boundPath = canonicalPath(path, { codePrefix, context });
  assertLineSafe(timestamp, 'timestamp', { codePrefix, context });
  assertLineSafe(requestId, 'request id', { codePrefix, context });
  const digest = crypto.createHash('sha256')
    .update(`${ENDPOINT_BOUND_V1_DOMAIN}\n${boundMethod}\n${boundPath}\n${timestamp}\n${requestId}\n${signature}`, 'utf8')
    .digest('hex');
  return `v1:${digest}`;
}

export function signSignedRequest({
  secret,
  timestamp,
  requestId,
  payload,
  signatureVersion = SIGNED_REQUEST_SIGNATURE_VERSIONS.LEGACY,
  method,
  canonicalPath: path,
  context = 'Signed request',
  codePrefix = 'SIGNED_REQUEST',
} = {}) {
  if (!secret) {
    throw new AppError(`${context} signing secret is not configured`, 503, `${codePrefix}_SECRET_NOT_CONFIGURED`);
  }
  const ts = String(timestamp || '').trim();
  const rid = String(requestId || '').trim();
  if (!ts) {
    throw AppError.unauthorized(`${context} timestamp is required`, `${codePrefix}_TIMESTAMP_REQUIRED`);
  }
  if (!rid) {
    throw AppError.unauthorized(`${context} request id is required`, `${codePrefix}_REQUEST_ID_REQUIRED`);
  }
  const version = normalizeSignatureVersion(signatureVersion, { codePrefix, context });
  return signatureHex({
    secret,
    signatureVersion: version,
    method,
    canonicalPath: path,
    timestamp: ts,
    requestId: rid,
    payload,
    codePrefix,
    context,
  });
}

function timestampMs(timestamp) {
  const raw = String(timestamp || '').trim();
  const numeric = Number(raw);
  return Number.isFinite(numeric)
    ? (numeric < 1_000_000_000_000 ? numeric * 1000 : numeric)
    : Date.parse(raw);
}

function assertFreshTimestamp(timestamp, { toleranceMs, codePrefix, context }) {
  const raw = String(timestamp || '').trim();
  if (!raw) {
    throw AppError.unauthorized(`${context} timestamp is required`, `${codePrefix}_TIMESTAMP_REQUIRED`);
  }
  const requestTime = timestampMs(raw);
  if (!Number.isFinite(requestTime)) {
    throw AppError.unauthorized(`${context} timestamp is invalid`, `${codePrefix}_TIMESTAMP_INVALID`);
  }
  if (Math.abs(nowMs() - requestTime) > toleranceMs) {
    throw AppError.unauthorized(`${context} timestamp is out of range`, `${codePrefix}_TIMESTAMP_STALE`);
  }
  return { raw, requestTime };
}

function rememberReplayKey(key, expiresAt, codePrefix, context) {
  const now = nowMs();
  for (const [cachedKey, cachedExpiry] of replayCache) {
    if (now > cachedExpiry) replayCache.delete(cachedKey);
  }
  if (replayCache.has(key)) {
    throw AppError.unauthorized(`${context} request replay detected`, `${codePrefix}_REPLAY`);
  }
  replayCache.set(key, expiresAt);
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
  claimLocalReplay = true,
  signatureVersion = SIGNED_REQUEST_SIGNATURE_VERSIONS.LEGACY,
  method,
  canonicalPath: path,
} = {}) {
  if (!secret) {
    throw new AppError(`${context} signing secret is not configured`, 503, `${codePrefix}_SECRET_NOT_CONFIGURED`);
  }
  const { raw: ts, requestTime } = assertFreshTimestamp(timestamp, {
    toleranceMs,
    codePrefix,
    context,
  });
  const rid = String(requestId || '').trim();
  if (!rid) {
    throw AppError.unauthorized(`${context} request id is required`, `${codePrefix}_REQUEST_ID_REQUIRED`);
  }
  const provided = normalizeSignature(signature);
  if (!provided) {
    throw AppError.unauthorized(`${context} signature is required`, `${codePrefix}_SIGNATURE_REQUIRED`);
  }

  const version = normalizeSignatureVersion(signatureVersion, { codePrefix, context });
  const expected = signatureHex({
    secret,
    signatureVersion: version,
    method,
    canonicalPath: path,
    timestamp: ts,
    requestId: rid,
    payload,
    codePrefix,
    context,
  });
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    throw AppError.unauthorized(`${context} signature is invalid`, `${codePrefix}_SIGNATURE_INVALID`);
  }

  if (claimLocalReplay) {
    rememberReplayKey(
      `${replayNamespace}:${replayMember({
        signatureVersion: version,
        method,
        canonicalPath: path,
        requestId: rid,
        timestamp: ts,
        signature: provided,
        codePrefix,
        context,
      })}`,
      requestTime + toleranceMs,
      codePrefix,
      context,
    );
  }
  return true;
}

/**
 * Cross-replica replay guard. The per-process Map in verifySignedRequest only
 * sees replays that hit the SAME worker; the cluster runs CLUSTER_WORKERS
 * workers × N replicas, so a captured (still-fresh) signed request replayed
 * against a DIFFERENT process is not in that process's Map and would be
 * accepted again. This makes the replay claim authoritative across all
 * processes. The database row is the durable authority; Redis is only a
 * best-effort coordination/cache marker because Sentinel failover, AOF's
 * every-second durability window, and eviction can all lose a Redis-only claim:
 *
 *   - DB authority: a unique (namespace, request_id) insert into
 *     interop_replay_guard (migration 321). A duplicate raises 23505
 *     (unique_violation) → replay, regardless of Redis state.
 *   - Redis cache: after the durable insert succeeds, `SET NX EX` records the
 *     same remaining acceptance horizon. Failure or eviction never weakens the
 *     durable claim.
 *
 * Call this AFTER verifySignedRequest (cheap sync crypto + freshness + same-
 * process replay check) so a forged/stale request never reaches the store.
 *
 * Fail-closed: if the DB is unreachable we cannot create the durable claim, so
 * we reject even when Redis is healthy. Current callers are public PHI-moving
 * mounts and none explicitly supports a volatile no-DB replay authority.
 *
 * @param {Object} args
 * @param {string} args.replayNamespace  Logical namespace (e.g. 'abdm-callback').
 * @param {string} args.requestId        The signed request id.
 * @param {string|number} args.timestamp The signed timestamp.
 * @param {string} args.signature        The provided signature (raw or sig=/sha256=).
 * @param {number} [args.toleranceMs]    Freshness window around the signed timestamp.
 * @param {string} [args.codePrefix]     Error code prefix (defaults SIGNED_REQUEST).
 * @param {string} [args.context]        Human label for the error message.
 * @param {'legacy'|'v1'} [args.signatureVersion] Signature contract version.
 * @param {string} [args.method]          Required for endpoint-bound v1.
 * @param {string} [args.canonicalPath]   Required for endpoint-bound v1.
 */
export async function assertSharedReplayOnce({
  replayNamespace = 'signed-request',
  requestId,
  timestamp,
  signature,
  toleranceMs = DEFAULT_TOLERANCE_MS,
  codePrefix = 'SIGNED_REQUEST',
  context = 'Signed request',
  signatureVersion = SIGNED_REQUEST_SIGNATURE_VERSIONS.LEGACY,
  method,
  canonicalPath: path,
} = {}) {
  const rid = String(requestId || '').trim();
  const ts = String(timestamp || '').trim();
  const provided = normalizeSignature(signature) || '';
  const version = normalizeSignatureVersion(signatureVersion, { codePrefix, context });
  // Endpoint-bound requests claim the exact signed intent. A signature sent to
  // the wrong method/path therefore fails authentication before it can consume
  // the intended endpoint's durable replay identity.
  const member = replayMember({
    signatureVersion: version,
    method,
    canonicalPath: path,
    requestId: rid,
    timestamp: ts,
    signature: provided,
    codePrefix,
    context,
  });
  const requestTime = timestampMs(ts);
  const remainingAcceptanceMs = Number.isFinite(requestTime)
    ? requestTime + toleranceMs - nowMs()
    : toleranceMs;
  const ttlSeconds = Math.max(1, Math.ceil(remainingAcceptanceMs / 1000));

  // Durable DB authority: unique (namespace, request_id) insert. 23505 == replay.
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO interop_replay_guard (namespace, request_id, expires_at)
       VALUES ($1, $2, NOW() + ($3 || ' seconds')::interval)`,
      replayNamespace,
      member,
      String(ttlSeconds),
    );
  } catch (err) {
    const code = err?.meta?.code
      || err?.meta?.driverAdapterError?.cause?.originalCode
      || err?.code;
    if (code === '23505') {
      throw AppError.unauthorized(`${context} request replay detected`, `${codePrefix}_REPLAY`);
    }
    // Could not prove non-replay (DB down / table missing). Fail CLOSED — these
    // are public PHI-moving mounts; a fail-open here re-opens the replay hole.
    logger.error('Shared replay store unavailable — rejecting inbound request fail-closed', {
      namespace: replayNamespace,
      message: err?.message,
    });
    throw new AppError(
      `${context} replay store is unavailable`,
      503,
      `${codePrefix}_REPLAY_STORE_UNAVAILABLE`,
    );
  }

  // Best-effort Redis cache/coordination marker. Never substitute it for the
  // durable row and never fail an already-authoritative claim on cache loss.
  const redis = getRedisClient();
  if (redis) {
    try {
      const key = `replay:${replayNamespace}:${member}`;
      await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
    } catch (err) {
      logger.warn('Shared replay cache marker failed after durable DB claim', {
        namespace: replayNamespace,
        message: err?.message,
      });
    }
  }

  // Best-effort opportunistic sweep of expired rows so the table stays small.
  // Never blocks/fails the request.
  if (Math.random() < 0.02) {
    prisma.$executeRawUnsafe(
      `DELETE FROM interop_replay_guard WHERE expires_at < NOW()`,
    ).catch((cleanupErr) => {
      // Sustained failure here grows a security-relevant table unboundedly —
      // visible at warn, never silent.
      logger.warn('interop_replay_guard expiry cleanup failed', { error: cleanupErr.message });
    });
  }

  return true;
}

export const __testing__ = {
  canonicalMethod,
  canonicalPath,
  canonicalPayload,
  normalizeSignature,
  normalizeSignatureVersion,
  replayMember,
  replayCache,
  signingPrefix,
  timestampMs,
};

export default { verifySignedRequest, assertSharedReplayOnce, signSignedRequest };
