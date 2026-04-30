/**
 * PHI column encryption helper (Phase E3 follow-up).
 *
 * Thin wrapper around phiEnvelopeService for the canonical PHI shadow
 * columns added in migration 132:
 *   users.name_encrypted        ← users.name
 *   users.phone_encrypted       ← users.phone
 *   users.phone_search_hash     ← deterministic HMAC of users.phone
 *   users.address_encrypted     ← users.address
 *   medical_records.description_encrypted ← medical_records.description
 *   medical_records.diagnosis_encrypted   ← medical_records.diagnosis
 *   medical_records.treatment_encrypted   ← medical_records.treatment
 *
 * Operational rollout, per column:
 *   1. (this file) Plaintext stays authoritative; shadow column is
 *      written on every successful UPDATE/INSERT via dualWriteFields().
 *   2. Run scripts/phi-backfill.mjs to encrypt every existing row.
 *   3. Flip reads to readWithFallback() — encrypted column wins, plain
 *      is the fallback for un-backfilled rows.
 *   4. Future migration drops the plaintext column once all rows
 *      have non-null encrypted values.
 *
 * Search-hash design:
 *   For columns we still need to filter by equality (notably
 *   users.phone — Firebase OTP and staff lookup), HMAC-SHA256 the
 *   normalised value with PHI_SEARCH_HASH_KEY (a SEPARATE secret from
 *   KMS_MASTER_KEY so the HMAC doesn't reveal the wrap key). The hash
 *   is deterministic, so equality lookups work; preimage resistance
 *   means leaked DB rows don't reveal phone numbers.
 */

import crypto from 'crypto';
import {
  decryptField as envelopeDecrypt,
  encryptField as envelopeEncrypt,
} from './phiEnvelopeService.js';

let _searchHmacKey = null;

function getSearchHmacKey() {
  if (_searchHmacKey) return _searchHmacKey;
  const raw = process.env.PHI_SEARCH_HASH_KEY;
  if (!raw) {
    throw new Error('PHI_SEARCH_HASH_KEY must be set for searchable encryption (32 bytes base64)');
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length < 16) {
    throw new Error('PHI_SEARCH_HASH_KEY must decode to >=16 bytes');
  }
  _searchHmacKey = buf;
  return _searchHmacKey;
}

export function resetSearchHmacKeyForTesting() {
  _searchHmacKey = null;
}

/**
 * Encrypt a column value to its envelope JSON. Returns null for null /
 * empty input, so callers can safely pass through unset fields.
 */
export function encryptColumn(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  return envelopeEncrypt(plaintext);
}

/**
 * Decrypt a shadow column. Falls back to the plain value when the
 * shadow column is null (un-backfilled rows). Throws on tampered
 * envelope so corruption is loud, not silent.
 */
export function decryptColumn(envelope, fallback = null) {
  if (envelope === null || envelope === undefined || envelope === '') return fallback;
  return envelopeDecrypt(envelope);
}

/**
 * Deterministic search hash for equality lookups. Normalises the input
 * (lowercase + trim) so 'A@b.com' and 'a@b.com' hash identically.
 */
export function searchableHash(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalised = String(value).trim().toLowerCase();
  return crypto.createHmac('sha256', getSearchHmacKey()).update(normalised).digest('hex');
}

/**
 * Convenience for the common case: take a plain field about to be
 * persisted and return both the plaintext (kept authoritative for
 * reads) and the envelope to write to the shadow column.
 *
 * Example:
 *   const { plain, encrypted } = dualWriteValue(req.body.name);
 *   await prisma.users.update({
 *     where: { id }, data: { name: plain, name_encrypted: encrypted },
 *   });
 */
export function dualWriteValue(value) {
  return {
    plain: value === undefined ? undefined : (value || null),
    encrypted: encryptColumn(value),
  };
}

/**
 * For phones specifically: returns plain + encrypted + search_hash
 * so callers can populate phone, phone_encrypted, phone_search_hash
 * in a single update.
 */
export function dualWritePhone(phone) {
  if (phone === null || phone === undefined || phone === '') {
    return { plain: phone === undefined ? undefined : null, encrypted: null, search_hash: null };
  }
  return {
    plain: phone,
    encrypted: encryptColumn(phone),
    search_hash: searchableHash(phone),
  };
}

/**
 * Read pattern: prefer the encrypted shadow column when present, fall
 * back to plain. Used during the phased read-cutover.
 */
export function readWithFallback({ encryptedValue = null, plainValue = null } = {}) {
  if (encryptedValue) {
    try {
      return envelopeDecrypt(encryptedValue);
    } catch {
      // Decryption errors should be loud upstream, but during a phased
      // cutover we don't want a single corrupt envelope to take down a
      // patient page. Fall through to the plaintext column.
      return plainValue;
    }
  }
  return plainValue;
}

export const __testing__ = { getSearchHmacKey };

export default {
  encryptColumn,
  decryptColumn,
  searchableHash,
  dualWriteValue,
  dualWritePhone,
  readWithFallback,
};
