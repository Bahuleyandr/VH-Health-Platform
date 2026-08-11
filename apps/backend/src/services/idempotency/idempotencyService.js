/**
 * Idempotency-key service (Phase E4).
 *
 * Backs the `requireIdempotencyKey` middleware. Lookup + claim + finalise
 * patterns over the `idempotency_keys` table.
 *
 * Migration 130.
 */

import crypto from 'crypto';
import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

const RETENTION_HOURS = 24;
const KEY_MAX_LEN = 200;

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

export function hashRequestBody(body) {
  if (body === null || body === undefined) return null;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function isValidIdempotencyKey(key) {
  if (typeof key !== 'string') return false;
  if (key.length === 0 || key.length > KEY_MAX_LEN) return false;
  return /^[A-Za-z0-9_\-:.]+$/.test(key);
}

/**
 * Atomically claim a slot for the given (tenant, user, key, path) tuple.
 *
 * Uniqueness scope (migration 130): the UNIQUE constraint is
 * (tenant_id, user_uid, request_key, request_path). The first-writer race is
 * resolved by that constraint's INSERT, so the *path* is always part of the
 * identity — two endpoints can safely reuse the same client key. The
 * staff-vitals mount runs this middleware BEFORE tenantContext, so
 * `tenant_id` can be NULL at claim time; in that case the row is still
 * uniquely identified by (user_uid, request_key, request_path).
 *
 * NULL caveat: Postgres treats NULLs as DISTINCT in a UNIQUE constraint, so
 * when BOTH tenant_id and user_uid are NULL the atomic INSERT cannot block a
 * truly-concurrent duplicate. The post-insert COALESCE lookup below still
 * detects an already-finalised row on a *sequential* retry (the common
 * client-retry case), and the staff-vitals path always carries a user_uid, so
 * (user_uid, request_key, request_path) keeps that path atomic. Migration 130
 * predates `NULLS NOT DISTINCT`; tightening the constraint is a schema change
 * tracked separately.
 *
 * Returns:
 *   { state: 'claimed' }                                   — first time, caller proceeds
 *   { state: 'replay', response_status, response_body }    — already complete + unexpired
 *   { state: 'in_flight' }                                 — concurrent retry — 409
 *   { state: 'mismatch' }                                  — same key reused with different body
 */
export async function claimIdempotencyKey({
  tenantId, userUid, requestKey, requestMethod, requestPath, requestBodyHash,
}) {
  if (!isValidIdempotencyKey(requestKey)) {
    throw AppError.badRequest('Idempotency-Key must be 1-200 chars [A-Za-z0-9_-:.]');
  }
  try {
    const inserted = await prisma.$queryRawUnsafe(
      `INSERT INTO idempotency_keys
         (tenant_id, user_uid, request_key, request_method, request_path,
          request_body_hash, status)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 'in_flight')
       RETURNING id, status`,
      tenantId || null, userUid || null,
      requestKey, requestMethod, requestPath, requestBodyHash,
    );
    return { state: 'claimed', id: inserted[0].id };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }

  // Existing row — fetch and decide. `is_expired` lets us refuse to replay a
  // cached response whose retention window has lapsed.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, response_status, response_body, request_body_hash,
            (expires_at IS NOT NULL AND expires_at <= NOW()) AS is_expired
     FROM idempotency_keys
     WHERE COALESCE(tenant_id::text, '') = COALESCE($1::text, '')
       AND COALESCE(user_uid::text, '') = COALESCE($2::text, '')
       AND request_key = $3
       AND request_path = $4`,
    tenantId || null, userUid || null, requestKey, requestPath,
  );
  const existing = rows[0];
  if (!existing) {
    // Race lost the insert but row vanished — treat as fresh claim.
    return { state: 'claimed', id: null };
  }
  if (existing.request_body_hash && requestBodyHash
      && existing.request_body_hash !== requestBodyHash) {
    return { state: 'mismatch' };
  }
  if (existing.status === 'complete' || existing.status === 'failed') {
    // Replay the cached answer only while the row is still within its
    // retention window. Past expires_at the cached response is stale, so we
    // re-arm the existing row as a fresh in-flight claim (new body hash + new
    // expiry) and let the handler re-execute — without this the key would
    // serve an expired response forever.
    if (existing.is_expired) {
      return reclaimExpiredRow({ id: existing.id, requestBodyHash });
    }
    return {
      state: 'replay',
      response_status: existing.response_status,
      response_body: existing.response_body,
    };
  }
  return { state: 'in_flight' };
}

/**
 * Re-arm an expired row as a fresh in-flight claim so the caller re-executes.
 * Guarded on status so a concurrent retry that already flipped the row back to
 * in_flight (or completed it) is reported as in_flight rather than double-armed.
 */
async function reclaimExpiredRow({ id, requestBodyHash }) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE idempotency_keys
        SET status = 'in_flight',
            request_body_hash = $2,
            response_status = NULL,
            response_body = NULL,
            expires_at = NOW() + ($3 || ' hours')::interval,
            updated_at = NOW()
      WHERE id = $1
        AND status IN ('complete', 'failed', 'expired')
        AND expires_at <= NOW()
      RETURNING id`,
    id, requestBodyHash || null, String(RETENTION_HOURS),
  );
  if (rows[0]?.id) {
    return { state: 'claimed', id: rows[0].id };
  }
  // Lost the re-arm race — another retry is already executing.
  return { state: 'in_flight' };
}

/**
 * Persist the response for a claim. Called from the middleware after
 * the underlying handler resolves.
 */
export async function finaliseIdempotencyKey({
  id, status = 'complete', responseStatus, responseBody,
}) {
  if (!id) return null;
  const cleanStatus = status === 'failed' ? 'failed' : 'complete';
  const rows = await prisma.$queryRawUnsafe(
      `UPDATE idempotency_keys
       SET status = $1, response_status = $2, response_body = $3::jsonb,
           updated_at = NOW()
       WHERE id = $4
       RETURNING id, status`,
      cleanStatus,
      responseStatus,
      responseBody !== undefined ? JSON.stringify(responseBody) : null,
      id,
  );
  return rows[0] || null;
}

/**
 * Release an in-flight claim by deleting its row. Called when the handler
 * produced a transient failure (5xx / timeout) that must NOT be pinned under
 * the key — deleting frees the (tenant, user, key, path) slot so the client's
 * retry re-executes the handler and can succeed. A deterministic 4xx is
 * persisted via finaliseIdempotencyKey instead; only non-deterministic
 * failures are released here.
 */
export async function releaseIdempotencyKey(id) {
  if (!id) return null;
  const rows = await prisma.$queryRawUnsafe(
      `DELETE FROM idempotency_keys WHERE id = $1 RETURNING id`,
      id,
  );
  return rows[0] || null;
}

/**
 * Background sweep to expire old rows. Run from a cron tick when the
 * scheduler is available.
 */
export async function expireOldIdempotencyKeys({ batchSize = 500 } = {}) {
  const rows = await prisma.$queryRawUnsafe(
      `UPDATE idempotency_keys
       SET status = 'expired', updated_at = NOW()
       WHERE id IN (
         SELECT id FROM idempotency_keys
         WHERE expires_at < NOW() AND status <> 'expired'
         LIMIT $1
       )
       RETURNING id`,
      Number(batchSize),
  );
  return { expired: rows.length };
}

export const __testing__ = { RETENTION_HOURS, KEY_MAX_LEN };

export default {
  claimIdempotencyKey,
  finaliseIdempotencyKey,
  releaseIdempotencyKey,
  expireOldIdempotencyKeys,
  hashRequestBody,
  isValidIdempotencyKey,
};
