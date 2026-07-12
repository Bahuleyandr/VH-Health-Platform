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

/**
 * Blacklist a token by its jti. Sets Redis key with TTL, and persists to DB.
 * @param {string} jti - JWT ID to blacklist
 * @param {number} expiresAt - Token expiry as Unix timestamp (seconds)
 * @param {string} [reason] - Why the token was blacklisted (e.g. 'logout', 'refresh_rotation')
 */
export async function blacklistToken(jti, expiresAt, reason = 'logout') {
  if (!jti) return;

  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(expiresAt - now, 0);
  if (ttl <= 0) return; // Already expired, no need to blacklist

  // Redis: fast path
  try {
    await cacheSet(`${BLACKLIST_PREFIX}${jti}`, { reason, blacklistedAt: now }, ttl);
  } catch (err) {
    logger.warn('Token blacklist Redis write failed:', err.message);
  }

  // DB: persistent fallback (fire-and-forget)
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
 * Blacklist ALL tokens for a user by storing a "revoke-all" timestamp.
 * Any token issued before this timestamp is considered invalid.
 * @param {string} userId - User ID whose tokens to revoke
 */
export async function revokeAllUserTokens(userId) {
  if (!userId) return;
  const now = Math.floor(Date.now() / 1000);
  const ttl = 30 * 24 * 60 * 60; // 30 days (max token lifetime)

  try {
    await cacheSet(`${BLACKLIST_PREFIX}user:${userId}`, { revokedAt: now }, ttl);
  } catch (err) {
    logger.warn('Revoke-all Redis write failed:', err.message);
  }

  setImmediate(async () => {
    try {
      await prisma.$queryRawUnsafe(`
        INSERT INTO invalidated_tokens (jti, expires_at, reason, created_at)
        VALUES ($1, NOW() + INTERVAL '30 days', $2, NOW())
        ON CONFLICT (jti) DO UPDATE SET
          expires_at = EXCLUDED.expires_at,
          reason = EXCLUDED.reason,
          created_at = EXCLUDED.created_at
      `, `user:${userId}`, 'revoke_all_user_tokens');
    } catch (err) {
      logger.warn('Revoke-all DB write failed:', err.message);
    }
  });
}

/**
 * Check if all tokens for a user were revoked after the token was issued.
 * @param {string} userId
 * @param {number} tokenIssuedAt - Token iat claim (Unix timestamp)
 * @returns {Promise<boolean>} - true if token should be rejected
 */
export async function isUserTokensRevoked(userId, tokenIssuedAt) {
  if (!userId) return false;

  let redisAnswered = false;
  try {
    const result = await cacheGet(`${BLACKLIST_PREFIX}user:${userId}`);
    redisAnswered = isRedisConnected();
    if (result && result.revokedAt && result.revokedAt > tokenIssuedAt) {
      return true;
    }
  } catch {
    redisAnswered = false; // fall through to DB
  }

  try {
    const issuedAt = Number.isFinite(Number(tokenIssuedAt)) ? Number(tokenIssuedAt) : 0;
    const result = await prisma.$queryRawUnsafe(
      `SELECT 1
         FROM invalidated_tokens
        WHERE jti = $1
          AND expires_at > NOW()
          AND created_at > to_timestamp($2)
        LIMIT 1`,
      `user:${userId}`,
      issuedAt,
    );
    if (result.length > 0) {
      return true;
    }
  } catch (err) {
    // A clean Redis miss is authoritative (revoke-all always writes Redis
    // with a 30-day TTL ≥ max token lifetime); a DB error alone is then
    // tolerable. But if NEITHER store answered, fail CLOSED (audit M2).
    if (!redisAnswered) {
      logger.error('Revoke-all check failed (both Redis and DB) — failing CLOSED', {
        error: err?.message,
        code: err?.code,
      });
      throw new RevocationCheckUnavailableError(
        'User token-revocation store unreachable (Redis and DB both failed)',
        err,
      );
    }
    logger.warn('Revoke-all DB check failed; trusting clean Redis answer', {
      error: err?.message,
    });
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
