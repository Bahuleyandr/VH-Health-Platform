// HMAC request authenticity helper for public/integration callbacks.
//
// Callers sign the canonical string:
//   <timestamp>.<requestId>.<payload>
// where payload is either the parsed JSON body re-serialized with
// JSON.stringify, or a raw protocol payload string such as HL7v2.

import crypto from 'crypto';

import prisma from '../lib/prisma.js';
import { getRedisClient } from '../lib/redis.js';
import logger from '../logging/logger.js';
import { AppError } from './AppError.js';

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_REPLAY_CACHE_ENTRIES = 5000;
// Per-process fast-path cache. Rejects same-process replays without a round
// trip; the cross-replica authority is the shared store (Redis SET NX EX, or
// the interop_replay_guard table — see assertSharedReplayOnce / migration 321).
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
  claimLocalReplay = true,
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

  if (claimLocalReplay) {
    rememberReplayKey(`${replayNamespace}:${rid}:${ts}:${provided}`, toleranceMs, codePrefix, context);
  }
  return true;
}

/**
 * Cross-replica replay guard. The per-process Map in verifySignedRequest only
 * sees replays that hit the SAME worker; the cluster runs CLUSTER_WORKERS
 * workers × N replicas, so a captured (still-fresh) signed request replayed
 * against a DIFFERENT process is not in that process's Map and would be
 * accepted again. This makes the replay claim authoritative across all
 * processes:
 *
 *   - Redis (preferred, when REDIS_URL is wired): `SET key NX EX <window>`.
 *     The first claim sets the key; any concurrent/subsequent claim gets a
 *     null reply (key exists) → replay.
 *   - DB fallback (when Redis is not connected — the current prod Sealed
 *     Secret ships Redis un-wired): a unique (namespace, request_id) insert
 *     into interop_replay_guard (migration 321). A duplicate raises 23505
 *     (unique_violation) → replay.
 *
 * Call this AFTER verifySignedRequest (cheap sync crypto + freshness + same-
 * process replay check) so a forged/stale request never reaches the store.
 *
 * Fail-closed: if BOTH Redis and the DB are unreachable we cannot prove the
 * request is not a replay, so we reject rather than silently accept (the
 * unauthenticated inbound mounts move PHI — a fail-open here would re-open the
 * very replay hole this closes).
 *
 * @param {Object} args
 * @param {string} args.replayNamespace  Logical namespace (e.g. 'abdm-callback').
 * @param {string} args.requestId        The signed request id.
 * @param {string|number} args.timestamp The signed timestamp.
 * @param {string} args.signature        The provided signature (raw or sig=/sha256=).
 * @param {number} [args.toleranceMs]    Freshness window; doubles as the store TTL.
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
  const ttlSeconds = Math.max(1, Math.ceil(toleranceMs / 1000));

  // Preferred path: Redis SET NX EX (atomic cross-replica claim).
  const redis = getRedisClient();
  if (redis) {
    try {
      const key = `replay:${replayNamespace}:${member}`;
      const res = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
      if (res === null) {
        throw AppError.unauthorized(`${context} request replay detected`, `${codePrefix}_REPLAY`);
      }
      return true;
    } catch (err) {
      if (err instanceof AppError) throw err; // a real replay rejection
      // Redis transport error — fall through to the DB guard rather than
      // failing the (otherwise authentic) request on a cache hiccup.
      logger.warn('Shared replay store: Redis claim failed, falling back to DB guard', {
        namespace: replayNamespace,
        message: err?.message,
      });
    }
  }

  // DB fallback: unique (namespace, request_id) insert. 23505 == replay.
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
};

export default { verifySignedRequest, assertSharedReplayOnce };
