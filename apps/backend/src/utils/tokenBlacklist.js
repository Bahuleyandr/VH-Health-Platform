/**
 * Token Blacklist — Revocation support for JWT tokens.
 *
 * Uses Redis (preferred) with DB fallback. Tokens are identified by their
 * `jti` (JWT ID) claim. Blacklisted tokens are rejected by jwtMiddleware.
 *
 * Redis key: `blacklist:<jti>` with TTL matching the token's remaining lifetime.
 * DB table: `invalidated_tokens` as persistent fallback when Redis is unavailable.
 */

import prisma from '../lib/prisma.js';
import { cacheGet, cacheSet, isRedisConnected } from '../lib/redis.js';
import logger from '../logging/logger.js';

const BLACKLIST_PREFIX = 'blacklist:';

// The epoch columns live on the identity tables and are keyed by uuid uid.
// Legacy revoke keys can be non-uuid (int id / phone fallbacks in old tokens);
// those identities keep watermark-only semantics — the epoch machinery is
// simply skipped for them rather than failing the whole revocation.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Thrown when NO revocation store could answer (Redis unavailable AND DB
 * errored). Audit finding M2 (2026-06-10): these checks previously returned
 * `false` (accept) in that case, so a revoked / force-logged-out token was
 * honoured for its full ≤7-day life during any store blip. Callers
 * (jwtMiddleware) must fail CLOSED on this error — deny with 503 + alert.
 */
export class RevocationCheckUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'RevocationCheckUnavailableError';
    this.code = 'REVOCATION_CHECK_UNAVAILABLE';
    this.cause = cause;
  }
}

export class RevocationWriteUnavailableError extends Error {
  constructor(message, causes = {}) {
    super(message);
    this.name = 'RevocationWriteUnavailableError';
    this.code = 'REVOCATION_WRITE_UNAVAILABLE';
    this.causes = causes;
  }
}

/**
 * Blacklist a token by its jti. Sets Redis key with TTL, and persists to DB.
 * @param {string} jti - JWT ID to blacklist
 * @param {number} expiresAt - Token expiry as Unix timestamp (seconds)
 * @param {string} [reason] - Why the token was blacklisted (e.g. 'logout', 'refresh_rotation')
 * @param {{requireEvidence?: boolean}} [opts] - When `requireEvidence` is true
 *   (audit F10), the DB write is awaited inline instead of fired-and-forgotten,
 *   and a `RevocationWriteUnavailableError` is thrown if NEITHER store
 *   persisted the entry — callers that must not claim success on a silent
 *   revocation failure (e.g. logout) opt into this. Default false preserves
 *   the original best-effort behaviour for every other existing caller.
 */
export async function blacklistToken(jti, expiresAt, reason = 'logout', { requireEvidence = false } = {}) {
  if (!jti) return requireEvidence ? null : undefined;

  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(expiresAt - now, 0);
  if (ttl <= 0) return requireEvidence ? null : undefined; // Already expired, no need to blacklist

  // Redis: fast path
  let redisError = null;
  let redisPersisted = false;
  try {
    redisPersisted = await cacheSet(`${BLACKLIST_PREFIX}${jti}`, { reason, blacklistedAt: now }, ttl) === true;
  } catch (err) {
    redisError = err;
    logger.warn('Token blacklist Redis write failed:', err.message);
  }

  if (!requireEvidence) {
    // DB: persistent fallback (fire-and-forget) — unchanged for existing callers.
    setImmediate(async () => {
      try {
        await prisma.$queryRawUnsafe(`
          INSERT INTO invalidated_tokens (jti, expires_at, reason, created_at)
          VALUES ($1, to_timestamp($2), $3, NOW())
          ON CONFLICT (jti) DO NOTHING
        `, jti, expiresAt, reason);
      } catch (err) {
        logger.warn('Token blacklist DB write failed:', err.message);
      }
    });
    return undefined;
  }

  // Evidence required: await the DB write so a failure there is visible.
  let databaseError = null;
  let databasePersisted = false;
  try {
    await prisma.$queryRawUnsafe(`
      INSERT INTO invalidated_tokens (jti, expires_at, reason, created_at)
      VALUES ($1, to_timestamp($2), $3, NOW())
      ON CONFLICT (jti) DO NOTHING
    `, jti, expiresAt, reason);
    databasePersisted = true;
  } catch (err) {
    databaseError = err;
    logger.warn('Token blacklist DB write failed:', err.message);
  }

  // R12: Postgres is the AUTHORITATIVE revocation store — the committed Redis
  // manifest runs allkeys-lru, so a Redis-only blacklist entry can be evicted
  // and the "successful" logout silently un-revoked. When the caller requires
  // evidence, only a durable (DB) write counts as success; Redis remains a
  // best-effort fast-path cache on top of it.
  if (!databasePersisted) {
    throw new RevocationWriteUnavailableError(
      'Durable revocation store (database) did not accept the blacklist entry',
      { redis: redisError, database: databaseError, redisPersisted },
    );
  }

  return Object.freeze({
    redis: Object.freeze({ persisted: redisPersisted }),
    database: Object.freeze({ persisted: databasePersisted }),
  });
}

/**
 * Check if a token's jti is blacklisted.
 * @param {string} jti - JWT ID to check
 * @returns {Promise<boolean>} - true if blacklisted
 */
export async function isTokenBlacklisted(jti) {
  if (!jti) return false;

  // Redis is a POSITIVE cache only. A hit proves the token is revoked; a MISS is
  // NOT proof of absence — the key may have been evicted, or Redis flushed, while
  // the durable invalidated_tokens row still stands. So only a hit short-circuits;
  // a miss (or any Redis error) falls through to the authoritative DB query
  // (Sol Ultra #29 — a Redis clean-miss must never accept a DB-revoked token).
  if (isRedisConnected()) {
    try {
      const result = await cacheGet(`${BLACKLIST_PREFIX}${jti}`);
      if (result !== null) return true;
      // miss → fall through to the DB; absence in Redis is not proof.
    } catch (err) {
      // Redis failed, fall through to DB
      logger.warn('Token blacklist Redis read failed, falling back to DB:', err.message);
    }
  }

  // DB: authoritative negative answer (and the fallback when Redis missed/failed)
  try {
    const result = await prisma.$queryRawUnsafe(
      'SELECT 1 FROM invalidated_tokens WHERE jti = $1 AND expires_at > NOW() LIMIT 1',
      jti
    );
    return result.length > 0;
  } catch (err) {
    // FAIL CLOSED (audit finding M2): neither store could answer, so we
    // cannot prove the token wasn't revoked. The caller turns this into a
    // 503 — "I can't tell if this is allowed" means "deny" on a PHI system.
    logger.error('Token blacklist check failed (both Redis and DB) — failing CLOSED', {
      error: err?.message,
      code: err?.code,
    });
    throw new RevocationCheckUnavailableError(
      'Token revocation store unreachable (Redis and DB both failed)',
      err,
    );
  }
}

/**
 * Blacklist ALL tokens for a user by storing a "revoke-all" timestamp, and bump
 * the identity's token-generation epoch (R1 issuance-time gate).
 *
 * The single DB statement atomically:
 *   1. upserts the durable `user:<uid>` revoke-all watermark row (consulted by
 *      isUserTokensRevoked at verify time), and
 *   2. increments users/admins.token_epoch + stamps token_epoch_bumped_at, so
 *      refresh tokens minted under the previous epoch (and Firebase sessions
 *      whose auth_time predates the bump) are refused at ISSUANCE time.
 *
 * R12: the DB write is REQUIRED — a revoke-all with no durable evidence throws
 * (the committed Redis manifest is allkeys-lru, so a Redis-only marker can
 * evaporate). Redis stays as the fast-path positive cache. The `requireEvidence`
 * option is retained for signature compatibility but is now always effectively
 * true for the durable side.
 *
 * R14: on success, a `session:revoked` event is pushed (best-effort) to every
 * open WebSocket of the user across all processes; wsServer closes those
 * sockets server-side after delivery.
 *
 * @param {string} userId - User ID whose tokens to revoke
 * @param {{requireEvidence?: boolean, reason?: string}} [opts]
 */
export async function revokeAllUserTokens(userId, { requireEvidence = false, reason = 'revoke_all' } = {}) {
  if (!userId) return null;
  const now = Math.floor(Date.now() / 1000);
  const ttl = 30 * 24 * 60 * 60; // 30 days (max token lifetime)
  let redisError = null;
  let redisPersisted = false;
  try {
    redisPersisted = await cacheSet(
      `${BLACKLIST_PREFIX}user:${userId}`,
      { revokedAt: now },
      ttl,
    ) === true;
  } catch (err) {
    redisError = err;
    logger.warn('Revoke-all Redis write failed:', err.message);
  }
  let databaseError = null;
  let databasePersisted = false;
  const isUuidIdentity = UUID_RE.test(String(userId));
  try {
    if (isUuidIdentity) {
      // Watermark + epoch bump in ONE statement (data-modifying CTEs are
      // atomic): the durable revocation evidence and the issuance-time gate
      // can never diverge. The uid lives in exactly one of users/admins, so
      // the two bump CTEs together touch at most one row.
      await prisma.$queryRawUnsafe(`
        WITH marker AS (
          INSERT INTO invalidated_tokens (jti, expires_at, reason, created_at)
          VALUES ($1, NOW() + INTERVAL '30 days', $2, to_timestamp($3))
          ON CONFLICT (jti) DO UPDATE SET
            expires_at = EXCLUDED.expires_at,
            reason = EXCLUDED.reason,
            created_at = EXCLUDED.created_at
          RETURNING jti
        ), bump_users AS (
          UPDATE users
             SET token_epoch = token_epoch + 1,
                 token_epoch_bumped_at = NOW()
           WHERE uid = $4::uuid
          RETURNING uid
        ), bump_admins AS (
          UPDATE admins
             SET token_epoch = token_epoch + 1,
                 token_epoch_bumped_at = NOW()
           WHERE uid = $4::uuid
          RETURNING uid
        )
        SELECT (SELECT COUNT(*) FROM marker)::int AS marker_rows,
               (SELECT COUNT(*) FROM bump_users)::int + (SELECT COUNT(*) FROM bump_admins)::int AS epoch_rows
      `, `user:${userId}`, 'revoke_all_user_tokens', now, String(userId));
    } else {
      await prisma.$queryRawUnsafe(`
        INSERT INTO invalidated_tokens (jti, expires_at, reason, created_at)
        VALUES ($1, NOW() + INTERVAL '30 days', $2, to_timestamp($3))
        ON CONFLICT (jti) DO UPDATE SET
          expires_at = EXCLUDED.expires_at,
          reason = EXCLUDED.reason,
          created_at = EXCLUDED.created_at
      `, `user:${userId}`, 'revoke_all_user_tokens', now);
    }
    databasePersisted = true;
  } catch (err) {
    databaseError = err;
    logger.warn('Revoke-all DB write failed:', err.message);
  }
  // R12: the durable (DB) write is authoritative and REQUIRED. A Redis-only
  // marker is not acceptable evidence — allkeys-lru can evict it, silently
  // resurrecting every "revoked" token.
  if (!databasePersisted) {
    throw new RevocationWriteUnavailableError(
      'Durable revocation store (database) did not accept the revoke-all marker',
      { redis: redisError, database: databaseError, redisPersisted, requireEvidence },
    );
  }

  // R14: close the revoked identity's live WebSockets. Best-effort — the
  // revocation itself is already durable; a WS hiccup must not undo it.
  // Dynamic import avoids a static tokenBlacklist ↔ wsServer cycle.
  try {
    const { pushSessionRevoked } = await import('./websocket/wsServer.js');
    pushSessionRevoked(String(userId), {
      reason,
      at: new Date(now * 1000).toISOString(),
    });
  } catch (err) {
    logger.warn('Revoke-all session:revoked push failed:', err.message);
  }

  return Object.freeze({
    revoked_at: new Date(now * 1000).toISOString(),
    redis: Object.freeze({ persisted: redisPersisted }),
    database: Object.freeze({ persisted: databasePersisted }),
  });
}

/**
 * Current token-generation epoch for an identity (users OR admins realm).
 *
 * Read DIRECTLY from the durable store — deliberately uncached, because a
 * stale (lower) epoch would let a revoked refresh token pass the issuance
 * gate. Called only on token-mint paths (login / refresh), never per-request.
 *
 * @param {string} userId - users.uid / admins.uid
 * @returns {Promise<number>} current epoch (0 = never revoked / legacy id)
 * @throws {RevocationCheckUnavailableError} when the durable store cannot
 *   answer — issuance must FAIL CLOSED rather than mint under a guessed epoch.
 */
export async function getCurrentTokenEpoch(userId) {
  if (!userId || !UUID_RE.test(String(userId))) return 0;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT token_epoch FROM users WHERE uid = $1::uuid
       UNION ALL
       SELECT token_epoch FROM admins WHERE uid = $1::uuid
       LIMIT 1`,
      String(userId),
    );
    if (rows.length === 0) return 0;
    const epoch = Number(rows[0].token_epoch);
    return Number.isFinite(epoch) ? epoch : 0;
  } catch (err) {
    logger.error('Token epoch lookup failed — failing CLOSED', {
      error: err?.message,
      code: err?.code,
    });
    throw new RevocationCheckUnavailableError(
      'Token epoch store unreachable (database failed)',
      err,
    );
  }
}

/**
 * Check if all tokens for a user were revoked at or after the token was issued.
 * @param {string} userId
 * @param {number} tokenIssuedAt - Token iat claim (Unix timestamp)
 * @returns {Promise<boolean>} - true if token should be rejected
 */
export async function isUserTokensRevoked(userId, tokenIssuedAt) {
  if (!userId) return false;

  // Redis is a POSITIVE cache only (same contract as isTokenBlacklisted): a
  // hit proves revocation, but a clean miss is NOT proof of absence — the
  // committed Redis manifest runs allkeys-lru, so the marker can be evicted
  // while the durable invalidated_tokens row still stands (R12).
  try {
    const result = await cacheGet(`${BLACKLIST_PREFIX}user:${userId}`);
    if (result && result.revokedAt && result.revokedAt >= tokenIssuedAt) {
      return true;
    }
  } catch {
    // Redis failed — the durable store below is authoritative anyway.
  }

  try {
    const issuedAt = Number.isFinite(Number(tokenIssuedAt)) ? Number(tokenIssuedAt) : 0;
    const result = await prisma.$queryRawUnsafe(
      `SELECT 1
         FROM invalidated_tokens
        WHERE jti = $1
          AND expires_at > NOW()
          AND created_at >= to_timestamp($2)
        LIMIT 1`,
      `user:${userId}`,
      issuedAt,
    );
    if (result.length > 0) {
      return true;
    }
  } catch (err) {
    // FAIL CLOSED (audit M2 + R12): the durable store is the authority; a
    // Redis clean miss is never acceptable as a negative answer (allkeys-lru
    // eviction), so a DB failure means we cannot prove the token wasn't
    // revoked. Callers turn this into a 503.
    logger.error('Revoke-all durable check failed — failing CLOSED', {
      error: err?.message,
      code: err?.code,
    });
    throw new RevocationCheckUnavailableError(
      'User token-revocation durable store unreachable',
      err,
    );
  }

  return false;
}

/**
 * Remove expired entries from the invalidated_tokens table.
 * Should be called periodically (e.g. daily) to prevent table bloat.
 */
export async function cleanupExpiredTokens() {
  try {
    const result = await prisma.$queryRawUnsafe(
      'DELETE FROM invalidated_tokens WHERE expires_at < NOW()'
    );
    logger.info('Token blacklist cleanup complete', { deleted: Number(result) || 0 });
  } catch (err) {
    logger.error('Token blacklist cleanup failed:', err.message);
  }
}
