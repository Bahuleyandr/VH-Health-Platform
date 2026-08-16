// HMAC request authenticity helper for public/integration callbacks.
//
// Callers sign the canonical string:
//   <timestamp>.<requestId>.<payload>
// where payload is either the exact captured request bytes, a raw protocol
// payload string such as HL7v2, or (for trusted internal callers only) parsed
// JSON serialized with JSON.stringify.

import crypto from 'crypto';

import prisma from '../lib/prisma.js';
import { getRedisClient } from '../lib/redis.js';
import logger from '../logging/logger.js';
import { AppError } from './AppError.js';

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_REPLAY_CACHE_ENTRIES = 5000;
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

  const expected = crypto.createHmac('sha256', secret)
    .update(`${ts}.${rid}.`, 'utf8')
    .update(canonicalPayload(payload))
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    throw AppError.unauthorized(`${context} signature is invalid`, `${codePrefix}_SIGNATURE_INVALID`);
  }

  if (claimLocalReplay) {
    rememberReplayKey(
      `${replayNamespace}:${rid}:${ts}:${provided}`,
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
 */
export async function assertSharedReplayOnce({
  replayNamespace = 'signed-request',
  requestId,
  timestamp,
  signature,
  toleranceMs = DEFAULT_TOLERANCE_MS,
  codePrefix = 'SIGNED_REQUEST',
  context = 'Signed request',
} = {}) {
  const rid = String(requestId || '').trim();
  const ts = String(timestamp || '').trim();
  const provided = normalizeSignature(signature) || '';
  // Bind the key to the signature too, so a malicious id-collision attempt with
  // a different (still-valid? — impossible without the secret) signature cannot
  // be conflated. Mirrors the in-memory key shape.
  const member = `${rid}:${ts}:${provided}`;
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
    ).catch(() => {});
  }

  return true;
}

export const __testing__ = {
  canonicalPayload,
  normalizeSignature,
  replayCache,
  timestampMs,
};

export default { verifySignedRequest, assertSharedReplayOnce };
