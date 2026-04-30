/**
 * PHI envelope encryption service (Phase E3).
 *
 * Per record:
 *   1. Generate a fresh 32-byte AES-256 Data Encryption Key (DEK) via
 *      the KMS provider.
 *   2. AES-256-GCM encrypt the plaintext with the DEK + a fresh IV.
 *   3. Wrap the DEK with the KMS Key Encryption Key (KEK).
 *   4. Serialise an envelope JSON containing ciphertext + IV + GCM tag
 *      + wrapped DEK + KEK kid.
 *
 * On read: parse the envelope, ask the KMS provider to unwrap the DEK,
 * AES-GCM decrypt the ciphertext.
 *
 * Wire format (JSON, base64-encoded fields):
 *   {
 *     "v": 1,                         // envelope version
 *     "alg": "aes-256-gcm",           // data cipher
 *     "kid": "env-default",           // KEK identifier — for rotation
 *     "iv": "<base64>",               // IV used for data encryption
 *     "tag": "<base64>",              // GCM auth tag
 *     "ct": "<base64>",               // ciphertext
 *     "edek": "<base64>",             // wrapped DEK
 *     "edek_iv": "<base64>",          // IV used to wrap DEK
 *     "edek_tag": "<base64>"          // GCM auth tag for the wrap
 *   }
 *
 * AES-GCM provides authenticated encryption — any tampering with
 * ciphertext, IV, tag, or wrapped DEK causes decryption to throw.
 */

import crypto from 'crypto';
import { getKmsProvider } from './kmsProviderService.js';

const ENVELOPE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce size
const TAG_BYTES = 16;

function bufToBase64(buf) {
  return Buffer.from(buf).toString('base64');
}

function base64ToBuf(s) {
  return Buffer.from(String(s), 'base64');
}

/**
 * Encrypt a plaintext field. Returns the JSON-serialised envelope.
 * Returns null on null/empty input.
 */
export function encryptField(plaintext, { provider = null } = {}) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const kms = provider || getKmsProvider();
  const dek = kms.generateDek();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, dek, iv);
  const ct = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const wrapped = kms.wrapDek(dek);
  // Wipe the DEK from memory ASAP.
  dek.fill(0);

  const envelope = {
    v: ENVELOPE_VERSION,
    alg: ALGORITHM,
    kid: wrapped.kid,
    iv: bufToBase64(iv),
    tag: bufToBase64(tag),
    ct: bufToBase64(ct),
    edek: bufToBase64(wrapped.edek),
    edek_iv: bufToBase64(wrapped.edek_iv),
    edek_tag: bufToBase64(wrapped.edek_tag),
  };
  return JSON.stringify(envelope);
}

/**
 * Decrypt an envelope back to plaintext. Throws on tampering, wrong
 * KEK, or version mismatch. Returns null on null/empty input.
 */
export function decryptField(serialised, { provider = null } = {}) {
  if (serialised === null || serialised === undefined || serialised === '') return null;
  let envelope;
  try {
    envelope = typeof serialised === 'string' ? JSON.parse(serialised) : serialised;
  } catch {
    const err = new Error('PHI envelope is not valid JSON');
    err.code = 'PHI_ENVELOPE_PARSE';
    throw err;
  }
  if (envelope.v !== ENVELOPE_VERSION) {
    const err = new Error(`PHI envelope version mismatch: got ${envelope.v}, expected ${ENVELOPE_VERSION}`);
    err.code = 'PHI_ENVELOPE_VERSION';
    throw err;
  }
  if (envelope.alg !== ALGORITHM) {
    const err = new Error(`PHI envelope algorithm mismatch: ${envelope.alg}`);
    err.code = 'PHI_ENVELOPE_ALGORITHM';
    throw err;
  }
  const kms = provider || getKmsProvider();
  const dek = kms.unwrapDek({
    edek: base64ToBuf(envelope.edek),
    edek_iv: base64ToBuf(envelope.edek_iv),
    edek_tag: base64ToBuf(envelope.edek_tag),
    kid: envelope.kid,
  });
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, dek, base64ToBuf(envelope.iv));
    const tagBuf = base64ToBuf(envelope.tag);
    if (tagBuf.length !== TAG_BYTES) {
      throw new Error(`PHI envelope auth tag wrong size: ${tagBuf.length}`);
    }
    decipher.setAuthTag(tagBuf);
    const out = Buffer.concat([
      decipher.update(base64ToBuf(envelope.ct)),
      decipher.final(),
    ]);
    return out.toString('utf8');
  } finally {
    // Wipe the DEK whether decrypt succeeded or threw.
    dek.fill(0);
  }
}

/**
 * Lightweight detector — used by services that store both legacy
 * fieldEncryption.js prefix and new envelope blobs in the same column
 * during a phased rollout.
 */
export function isPhiEnvelope(value) {
  if (typeof value !== 'string' || !value.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(value);
    return parsed && parsed.v === ENVELOPE_VERSION && parsed.alg === ALGORITHM
      && typeof parsed.ct === 'string' && typeof parsed.edek === 'string';
  } catch {
    return false;
  }
}

/**
 * Re-wrap an envelope under a new KMS provider (rotation): unwrap with
 * the old provider, re-wrap the DEK with the new provider, and return
 * a fresh envelope. The plaintext is never re-encrypted, just the DEK.
 */
export function rotateEnvelopeKek(serialised, { fromProvider, toProvider }) {
  if (!fromProvider || !toProvider) {
    throw new Error('rotateEnvelopeKek requires fromProvider and toProvider');
  }
  if (serialised === null || serialised === undefined || serialised === '') return null;
  const envelope = typeof serialised === 'string' ? JSON.parse(serialised) : serialised;

  const dek = fromProvider.unwrapDek({
    edek: base64ToBuf(envelope.edek),
    edek_iv: base64ToBuf(envelope.edek_iv),
    edek_tag: base64ToBuf(envelope.edek_tag),
    kid: envelope.kid,
  });
  const wrapped = toProvider.wrapDek(dek);
  dek.fill(0);

  return JSON.stringify({
    ...envelope,
    kid: wrapped.kid,
    edek: bufToBase64(wrapped.edek),
    edek_iv: bufToBase64(wrapped.edek_iv),
    edek_tag: bufToBase64(wrapped.edek_tag),
  });
}

export const __testing__ = { ENVELOPE_VERSION, ALGORITHM, IV_BYTES, TAG_BYTES };

export default { encryptField, decryptField, isPhiEnvelope, rotateEnvelopeKek };
