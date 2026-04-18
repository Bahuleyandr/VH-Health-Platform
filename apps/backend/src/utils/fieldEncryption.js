// src/utils/fieldEncryption.js
// Field-level encryption for PII data at rest.
// Uses AES-256-GCM authenticated encryption with a per-field IV.

import crypto from 'crypto';
import logger from '../logging/logger.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const ENCRYPTED_PREFIX = 'enc:v1:'; // Prefix to identify encrypted values

/**
 * Derive a 256-bit encryption key from the master secret.
 * Cached after first call — scryptSync is deliberately CPU-expensive
 * and must not run on every encrypt/decrypt invocation.
 */
let _cachedKey = null;

function deriveKey() {
  if (_cachedKey) return _cachedKey;

  const masterKey = process.env.FIELD_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!masterKey) {
    throw new Error('FIELD_ENCRYPTION_KEY or JWT_SECRET must be set for field encryption');
  }
  _cachedKey = crypto.scryptSync(masterKey, 'vh-field-encryption-v1', 32);
  return _cachedKey;
}

/**
 * Encrypt a plaintext field value.
 * Returns a prefixed string: `enc:v1:<iv>:<authTag>:<ciphertext>`
 * Returns null for null/undefined input.
 *
 * @param {string|null} plaintext - The value to encrypt.
 * @returns {string|null} Encrypted string or null.
 */
export function encryptField(plaintext) {
  if (plaintext === null || plaintext === '') return plaintext;

  try {
    const key = deriveKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(String(plaintext), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `${ENCRYPTED_PREFIX}${iv.toString('hex')}:${tag}:${encrypted}`;
  } catch (err) {
    logger.error('Field encryption failed:', err);
    throw new Error('Encryption failed');
  }
}

/**
 * Decrypt an encrypted field value.
 * If the value is not encrypted (no prefix), returns as-is (backwards compatible).
 *
 * @param {string|null} encryptedValue - The value to decrypt.
 * @returns {string|null} Decrypted plaintext or null.
 */
export function decryptField(encryptedValue) {
  if (encryptedValue === null || encryptedValue === '') return encryptedValue;

  // Not encrypted — return as-is for backwards compatibility
  if (!String(encryptedValue).startsWith(ENCRYPTED_PREFIX)) {
    return encryptedValue;
  }

  try {
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
  } catch (err) {
    logger.error('Field decryption failed:', err);
    throw new Error('Decryption failed');
  }
}

/**
 * Check if a value is already encrypted.
 * @param {string|null} value
 * @returns {boolean}
 */
export function isEncrypted(value) {
  return value !== null && String(value).startsWith(ENCRYPTED_PREFIX);
}

/**
 * Encrypt multiple fields in an object.
 * Only encrypts the specified keys; leaves others untouched.
 *
 * @param {Object} data - The object containing fields.
 * @param {string[]} fieldsToEncrypt - Array of field names to encrypt.
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
 * @param {Object} data - The object containing encrypted fields.
 * @param {string[]} fieldsToDecrypt - Array of field names to decrypt.
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
 * Uses HMAC-SHA256 so that the same plaintext always produces the same hash,
 * enabling equality searches on encrypted columns via a companion `_hash` column.
 *
 * @param {string} plaintext - The value to hash.
 * @returns {string} Hex-encoded HMAC hash.
 */
export function searchableHash(plaintext) {
  if (plaintext === null) return null;
  const key = deriveKey();
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
