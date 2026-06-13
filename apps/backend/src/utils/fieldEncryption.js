// src/utils/fieldEncryption.js
// Field-level encryption for PII/PHI data at rest.
//
// Two on-disk formats coexist (decrypt auto-detects; encrypt always emits the
// newest):
//
//   enc:v1:<ivHex>:<tagHex>:<ctHex>           LEGACY — single process-wide key.
//     One AES-256-GCM key derived once via scryptSync(FIELD_ENCRYPTION_KEY,
//     'vh-field-encryption-v1', 32). No per-record key, no key-id, no envelope.
//     EXISTING ROWS ARE IN THIS FORMAT — decryptField() MUST keep reading them
//     forever. We never write v1 again, but we never break it.
//
//   enc:v2:<base64url(JSON)>                   CURRENT — envelope encryption.
//     Per-record random DEK (AES-256). Field encrypted with the DEK
//     (AES-256-GCM, random 12-byte IV). DEK wrapped by a KEK from the pluggable
//     KEK provider (src/utils/fieldKeyProvider.js — local KEK today, real KMS
//     later). The payload is self-describing and carries the KEK keyId, so a
//     KEK rotation only re-wraps the DEK (see rewrapField / scripts/rotate-field-kek.mjs)
//     and never has to re-encrypt the field itself.
//
//     v2 JSON shape (all binary fields base64):
//       {
//         "v":   2,                 // payload version
//         "alg": "aes-256-gcm",     // data + wrap cipher
//         "kid": "local-v1",        // KEK keyId — drives unwrap + rotation
//         "iv":  "<base64>",        // 12-byte data IV
//         "ct":  "<base64>",        // ciphertext
//         "tag": "<base64>",        // data GCM auth tag
//         "edek":"<base64>",        // DEK wrapped under the KEK
//         "wiv": "<base64>",        // 12-byte wrap IV
//         "wtag":"<base64>"         // wrap GCM auth tag
//       }
//
// searchableHash() now derives from a DISTINCT key (FIELD_SEARCH_HMAC_KEY) so
// the search-index HMAC is not the same secret as the encryption key. To avoid
// breaking lookups on rows hashed under the old scheme, FIELD_SEARCH_HMAC_KEY
// defaults to the EXACT bytes the legacy code used (scrypt over
// FIELD_ENCRYPTION_KEY) when unset. Rotating to a genuinely new search key
// REQUIRES re-hashing existing rows — see scripts/rebuild-search-hashes.mjs.

import crypto from 'crypto';
import logger from '../logging/logger.js';
import { getKekProvider } from './fieldKeyProvider.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // v1 IV length (legacy; v2 uses 12-byte GCM nonces)
const DEK_IV_LENGTH = 12; // v2 data IV (GCM standard nonce)
const DEK_LENGTH = 32; // v2 per-record AES-256 data key
const GCM_TAG_LENGTH = 16;

const ENCRYPTED_PREFIX = 'enc:v1:'; // legacy single-key format
const ENVELOPE_PREFIX = 'enc:v2:'; // envelope format (current)

/**
 * Derive the LEGACY 256-bit single key from the master secret.
 * Cached after first call — scryptSync is deliberately CPU-expensive and must
 * not run on every encrypt/decrypt invocation.
 *
 * This is still used to (a) decrypt all existing enc:v1: data and (b) provide
 * the backward-compatible default for the search HMAC key. It is NOT used for
 * new (v2) writes.
 */
let _cachedKey = null;

function deriveKey() {
  if (_cachedKey) return _cachedKey;

  const masterKey = process.env.FIELD_ENCRYPTION_KEY;
  if (!masterKey) {
    throw new Error('FIELD_ENCRYPTION_KEY must be set for field encryption');
  }
  _cachedKey = crypto.scryptSync(masterKey, 'vh-field-encryption-v1', 32);
  return _cachedKey;
}

// --- Search HMAC key (separate from the encryption key) ----------------------

let _cachedSearchKey = null;

/**
 * Derive the key used for searchableHash().
 *
 * Preference order:
 *   1. FIELD_SEARCH_HMAC_KEY (a DISTINCT secret) — the correct long-term state.
 *   2. Legacy fallback: scrypt(FIELD_ENCRYPTION_KEY, 'vh-field-encryption-v1')
 *      — byte-identical to what searchableHash() used before this change, so
 *      every hash already in the DB still matches. THIS IS WHY ROTATING THE
 *      SEARCH KEY REQUIRES scripts/rebuild-search-hashes.mjs.
 */
function deriveSearchKey() {
  if (_cachedSearchKey) return _cachedSearchKey;

  const explicit = process.env.FIELD_SEARCH_HMAC_KEY;
  if (explicit) {
    // Accept either raw string or base64-encoded 32 bytes; scrypt normalises
    // entropy either way and keeps the key length fixed.
    _cachedSearchKey = crypto.scryptSync(explicit, 'vh-field-search-hmac-v1', 32);
    return _cachedSearchKey;
  }

  // Backward-compatible default: the legacy derived key. Existing search hashes
  // were computed with exactly this, so lookups keep working untouched.
  _cachedSearchKey = deriveKey();
  return _cachedSearchKey;
}

/** Test hook — clears the cached keys so env changes take effect. */
export function resetKeyCacheForTesting() {
  _cachedKey = null;
  _cachedSearchKey = null;
}

// --- base64url helpers for the v2 payload ------------------------------------

function packEnvelope(obj) {
  return ENVELOPE_PREFIX + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

function unpackEnvelope(value) {
  const b64 = String(value).slice(ENVELOPE_PREFIX.length);
  const json = Buffer.from(b64, 'base64url').toString('utf8');
  return JSON.parse(json);
}

/**
 * Encrypt a plaintext field value using envelope encryption (enc:v2:).
 *
 * - null / '' pass through unchanged (so callers can blindly pass optional
 *   fields), matching the legacy contract.
 * - undefined is treated like null (legacy returned it untouched; we normalise
 *   to the same passthrough so `encryptField(undefined)` never throws).
 *
 * @param {string|null|undefined} plaintext
 * @returns {string|null|undefined} enc:v2: payload, or the original null/empty.
 */
export function encryptField(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return plaintext;

  let dek;
  try {
    const provider = getKekProvider();
    dek = provider.generateDek();
    const iv = crypto.randomBytes(DEK_IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, dek, iv);
    const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const wrapped = provider.wrapDek(dek);

    return packEnvelope({
      v: 2,
      alg: ALGORITHM,
      kid: wrapped.keyId,
      iv: iv.toString('base64'),
      ct: ct.toString('base64'),
      tag: tag.toString('base64'),
      edek: Buffer.from(wrapped.edek).toString('base64'),
      wiv: Buffer.from(wrapped.wiv).toString('base64'),
      wtag: Buffer.from(wrapped.wtag).toString('base64'),
    });
  } catch (err) {
    logger.error('Field encryption failed:', err);
    throw new Error('Encryption failed');
  } finally {
    // Wipe the DEK from memory ASAP.
    if (dek) dek.fill(0);
  }
}

/**
 * Decrypt the legacy enc:v1: single-key format. Unchanged from the original
 * implementation — this path MUST keep working for all data at rest.
 */
function decryptV1(encryptedValue) {
  const key = deriveKey();
  const payload = String(encryptedValue).slice(ENCRYPTED_PREFIX.length);
  const [ivHex, tagHex, ciphertext] = payload.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Decrypt the enc:v2: envelope format: unwrap the DEK with the KEK identified
 * by the payload's keyId, then AES-256-GCM decrypt the field.
 */
function decryptV2(encryptedValue) {
  const env = unpackEnvelope(encryptedValue);
  if (env.v !== 2) {
    throw new Error(`Unsupported envelope version: ${env.v}`);
  }
  if (env.alg !== ALGORITHM) {
    throw new Error(`Unsupported envelope algorithm: ${env.alg}`);
  }

  const provider = getKekProvider();
  let dek;
  try {
    dek = provider.unwrapDek({
      keyId: env.kid,
      edek: Buffer.from(env.edek, 'base64'),
      wiv: Buffer.from(env.wiv, 'base64'),
      wtag: Buffer.from(env.wtag, 'base64'),
    });

    const tag = Buffer.from(env.tag, 'base64');
    if (tag.length !== GCM_TAG_LENGTH) {
      throw new Error(`Envelope auth tag wrong size: ${tag.length}`);
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, dek, Buffer.from(env.iv, 'base64'));
    decipher.setAuthTag(tag);
    const out = Buffer.concat([
      decipher.update(Buffer.from(env.ct, 'base64')),
      decipher.final(),
    ]);
    return out.toString('utf8');
  } finally {
    if (dek) dek.fill(0);
  }
}

/**
 * Decrypt an encrypted field value.
 * If the value is not encrypted (no recognised prefix), returns as-is
 * (backwards compatible with un-encrypted legacy rows).
 *
 * @param {string|null} encryptedValue
 * @returns {string|null} Decrypted plaintext or the original null/empty.
 */
export function decryptField(encryptedValue) {
  if (encryptedValue === null || encryptedValue === undefined || encryptedValue === '') {
    return encryptedValue;
  }

  const str = String(encryptedValue);

  try {
    if (str.startsWith(ENVELOPE_PREFIX)) {
      return decryptV2(str);
    }
    if (str.startsWith(ENCRYPTED_PREFIX)) {
      return decryptV1(str);
    }
    // Not encrypted — return as-is for backwards compatibility.
    return encryptedValue;
  } catch (err) {
    logger.error('Field decryption failed:', err);
    throw new Error('Decryption failed');
  }
}

/**
 * Re-wrap an encrypted value's DEK under the provider's CURRENT active KEK
 * WITHOUT re-encrypting the field data. This is the whole point of envelope
 * encryption: KEK rotation touches only the small wrapped-DEK, not the PHI.
 *
 * - enc:v2: → unwrap DEK with its (possibly old) keyId, re-wrap under the
 *   active keyId, return a fresh enc:v2: payload with identical iv/ct/tag.
 * - enc:v1: → returned UNCHANGED. v1 has no separable DEK to re-wrap; v1 rows
 *   are upgraded to v2 opportunistically on their next write (documented; not
 *   forced here, since forcing would mean re-encrypting and re-reading PHI).
 * - null / '' / plaintext → returned unchanged.
 *
 * @param {string|null} encryptedValue
 * @param {Object} [opts]
 * @param {Object} [opts.provider]  KEK provider (defaults to the active one).
 * @returns {string|null} possibly-rewrapped value.
 */
export function rewrapField(encryptedValue, { provider } = {}) {
  if (encryptedValue === null || encryptedValue === undefined || encryptedValue === '') {
    return encryptedValue;
  }
  const str = String(encryptedValue);
  if (!str.startsWith(ENVELOPE_PREFIX)) {
    // v1 or plaintext — nothing to re-wrap.
    return encryptedValue;
  }

  const kek = provider || getKekProvider();
  const env = unpackEnvelope(str);

  let dek;
  try {
    dek = kek.unwrapDek({
      keyId: env.kid,
      edek: Buffer.from(env.edek, 'base64'),
      wiv: Buffer.from(env.wiv, 'base64'),
      wtag: Buffer.from(env.wtag, 'base64'),
    });
    const wrapped = kek.wrapDek(dek); // wrap under the active keyId
    return packEnvelope({
      ...env,
      kid: wrapped.keyId,
      edek: Buffer.from(wrapped.edek).toString('base64'),
      wiv: Buffer.from(wrapped.wiv).toString('base64'),
      wtag: Buffer.from(wrapped.wtag).toString('base64'),
    });
  } finally {
    if (dek) dek.fill(0);
  }
}

/**
 * Read the KEK keyId stamped into an enc:v2: payload (for rotation tooling /
 * audit). Returns 'v1' for legacy rows and null for non-encrypted values.
 */
export function getKeyId(encryptedValue) {
  if (encryptedValue === null || encryptedValue === undefined || encryptedValue === '') return null;
  const str = String(encryptedValue);
  if (str.startsWith(ENVELOPE_PREFIX)) {
    try {
      return unpackEnvelope(str).kid || null;
    } catch {
      return null;
    }
  }
  if (str.startsWith(ENCRYPTED_PREFIX)) return 'v1';
  return null;
}

/**
 * Check if a value is already encrypted (either format).
 * @param {string|null} value
 * @returns {boolean}
 */
export function isEncrypted(value) {
  if (value === null || value === undefined) return false;
  const str = String(value);
  return str.startsWith(ENCRYPTED_PREFIX) || str.startsWith(ENVELOPE_PREFIX);
}

/**
 * Encrypt multiple fields in an object.
 * Only encrypts the specified keys; leaves others untouched.
 *
 * @param {Object} data
 * @param {string[]} fieldsToEncrypt
 * @returns {Object} New object with specified fields encrypted.
 */
export function encryptFields(data, fieldsToEncrypt) {
  if (!data || typeof data !== 'object') return data;
  const result = { ...data };
  for (const field of fieldsToEncrypt) {
    if (result[field] !== null && result[field] !== '' && !isEncrypted(result[field])) {
      result[field] = encryptField(result[field]);
    }
  }
  return result;
}

/**
 * Decrypt multiple fields in an object.
 *
 * @param {Object} data
 * @param {string[]} fieldsToDecrypt
 * @returns {Object} New object with specified fields decrypted.
 */
export function decryptFields(data, fieldsToDecrypt) {
  if (!data || typeof data !== 'object') return data;
  const result = { ...data };
  for (const field of fieldsToDecrypt) {
    if (result[field] !== null && isEncrypted(result[field])) {
      result[field] = decryptField(result[field]);
    }
  }
  return result;
}

/**
 * Create a deterministic hash of a field value for searchable encryption.
 * Uses HMAC-SHA256 with a key DISTINCT from the encryption key
 * (FIELD_SEARCH_HMAC_KEY, falling back to the legacy-derived key when unset)
 * so that the same plaintext always produces the same hash, enabling equality
 * searches on encrypted columns via a companion `_hash` column.
 *
 * BACKWARD COMPAT: with FIELD_SEARCH_HMAC_KEY unset, the key is byte-identical
 * to the legacy implementation, so existing search hashes still match. If you
 * set a genuinely new FIELD_SEARCH_HMAC_KEY you MUST run
 * scripts/rebuild-search-hashes.mjs to re-hash existing rows.
 *
 * @param {string|null} plaintext
 * @returns {string|null} Hex-encoded HMAC hash, or null for null input.
 */
export function searchableHash(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  const key = deriveSearchKey();
  return crypto.createHmac('sha256', key).update(String(plaintext).toLowerCase().trim()).digest('hex');
}

// Fields that should be encrypted in the users/staff tables
export const SENSITIVE_USER_FIELDS = [
  'emergency_contact',
  'allergies',
  'medical_history',
  'blood_group',
  'address',
];

export const SENSITIVE_STAFF_FIELDS = [
  'emergency_contact',
  'salary',
  'license_number',
];

export const __testing__ = {
  ENCRYPTED_PREFIX,
  ENVELOPE_PREFIX,
  ALGORITHM,
  IV_LENGTH,
  DEK_IV_LENGTH,
  DEK_LENGTH,
  GCM_TAG_LENGTH,
  deriveKey,
  deriveSearchKey,
  // Produce a v1-format ciphertext on demand so tests can assert the legacy
  // path keeps decrypting (mirrors the pre-envelope implementation exactly).
  encryptV1ForTest(plaintext) {
    const key = deriveKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(String(plaintext), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `${ENCRYPTED_PREFIX}${iv.toString('hex')}:${tag}:${encrypted}`;
  },
};
