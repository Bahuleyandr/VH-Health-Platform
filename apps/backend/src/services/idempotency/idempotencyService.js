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
import logger from '../../logging/logger.js';

const RETENTION_HOURS = 24;
const KEY_MAX_LEN = 200;

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

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
 * Returns:
 *   { state: 'claimed' }                                   — first time, caller proceeds
 *   { state: 'replay', response_status, response_body }    — already complete, cached
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
    if (!isUniqueViolation(err)) {
      if (isMissingSchemaError(err)) {
        // Substrate not migrated — fail open so endpoints still work.
        logger.warn('idempotency_keys table missing, skipping idempotency check');
        return { state: 'claimed', id: null, schemaMissing: true };
      }
      throw err;
    }
  }

  // Existing row — fetch and decide.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, response_status, response_body, request_body_hash
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
    return {
      state: 'replay',
      response_status: existing.response_status,
      response_body: existing.response_body,
    };
  }
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
  try {
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
  } catch (err) {
    if (isMissingSchemaError(err)) return null;
    throw err;
  }
}

/**
 * Background sweep to expire old rows. Run from a cron tick when the
 * scheduler is available.
 */
export async function expireOldIdempotencyKeys({ batchSize = 500 } = {}) {
  try {
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
  } catch (err) {
    if (isMissingSchemaError(err)) return { expired: 0 };
    throw err;
  }
}

export const __testing__ = { RETENTION_HOURS, KEY_MAX_LEN };

export default {
  claimIdempotencyKey,
  finaliseIdempotencyKey,
  expireOldIdempotencyKeys,
  hashRequestBody,
  isValidIdempotencyKey,
};
