// src/services/abdm/abdmCrypto.js
//
// Roadmap C1 follow-up — ABDM M2 FHIR-bundle encryption.
//
// FIDELIUS-equivalent implementation of the ABDM health-information
// payload encryption: ECDH key agreement on Curve25519 (X25519),
// HKDF-SHA256 key derivation, AES-256-GCM payload encryption. Matches the
// NHA reference implementation (fidelius-cli) byte-for-byte:
//
//   * each party generates an ephemeral X25519 key pair + a 32-byte nonce;
//   * sharedSecret = X25519(ownPrivate, peerPublic);
//   * xorOfNonces  = senderNonce XOR receiverNonce (commutative);
//   * salt = xorOfNonces[0..20), iv = xorOfNonces[last 12 bytes];
//   * aesKey = HKDF-SHA256(ikm = sharedSecret, salt, info = empty, len = 32);
//   * ciphertext = AES-256-GCM(plaintext, aesKey, iv) with the 16-byte auth
//     tag APPENDED (Java Cipher AES/GCM/NoPadding convention).
//
// Private keys are ephemeral per transfer and never persisted — only the
// public KeyMaterial envelope (cryptoAlg/curve/dhPublicKey/nonce) is shared
// or stored. Peers may send the DH public key either as the raw 32-byte
// X25519 key or as a 44-byte DER SubjectPublicKeyInfo; both are accepted.

import crypto from 'crypto';
import { AppError } from '../../utils/AppError.js';

const CRYPTO_ALG = 'ECDH';
const CURVE = 'Curve25519';
const KEY_PARAMETERS = 'Curve25519/32byte random key';
const NONCE_LENGTH = 32;
const GCM_TAG_LENGTH = 16;

// DER prefix for an X25519 SubjectPublicKeyInfo (RFC 8410): SEQUENCE,
// AlgorithmIdentifier id-X25519 (1.3.101.110), BIT STRING header.
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
// DER prefix for an X25519 PKCS#8 private key (used by tests/tools that
// construct keys from raw 32-byte scalars).
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

/**
 * Generate ephemeral ABDM key material for one transfer.
 * @returns {{ privateKey: import('crypto').KeyObject, nonce: string, keyMaterial: Object }}
 *   privateKey is held in memory only; keyMaterial is the shareable envelope.
 */
export function generateKeyMaterial({ expiryMinutes = 30 } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const rawPublic = publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(X25519_SPKI_PREFIX.length);
  const nonce = crypto.randomBytes(NONCE_LENGTH).toString('base64');

  return {
    privateKey,
    nonce,
    keyMaterial: {
      cryptoAlg: CRYPTO_ALG,
      curve: CURVE,
      dhPublicKey: {
        expiry: new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString(),
        parameters: KEY_PARAMETERS,
        keyValue: rawPublic.toString('base64'),
      },
      nonce,
    },
  };
}

/**
 * Decode a peer's base64 DH public key into a KeyObject.
 * Accepts the raw 32-byte X25519 key or a 44-byte DER SPKI.
 */
export function decodePublicKey(keyValueB64) {
  if (!keyValueB64 || typeof keyValueB64 !== 'string') {
    throw AppError.badRequest('ABDM DH public key is required', 'ABDM_KEY_MISSING');
  }
  let buf = Buffer.from(keyValueB64, 'base64');
  if (buf.length === 32) {
    buf = Buffer.concat([X25519_SPKI_PREFIX, buf]);
  }
  if (buf.length !== X25519_SPKI_PREFIX.length + 32 || !buf.subarray(0, X25519_SPKI_PREFIX.length).equals(X25519_SPKI_PREFIX)) {
    throw AppError.badRequest(
      `Unsupported ABDM DH public key encoding (${buf.length} bytes; expected raw 32-byte X25519 or 44-byte DER SPKI)`,
      'ABDM_KEY_ENCODING',
    );
  }
  try {
    return crypto.createPublicKey({ key: buf, format: 'der', type: 'spki' });
  } catch (err) {
    throw AppError.badRequest(`Invalid ABDM DH public key: ${err.message}`, 'ABDM_KEY_INVALID');
  }
}

/**
 * Build a KeyObject from a raw 32-byte X25519 private scalar (test/tooling
 * helper — production keys come from generateKeyMaterial()).
 */
export function privateKeyFromRaw(raw32) {
  const raw = Buffer.isBuffer(raw32) ? raw32 : Buffer.from(raw32, 'hex');
  if (raw.length !== 32) {
    throw AppError.badRequest('X25519 private key must be 32 bytes', 'ABDM_KEY_LENGTH');
  }
  return crypto.createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** X25519 shared secret between our private key and the peer's public key. */
export function deriveSharedSecret({ privateKey, peerPublicKeyB64 }) {
  return crypto.diffieHellman({
    privateKey,
    publicKey: decodePublicKey(peerPublicKeyB64),
  });
}

function xorNonces(senderNonceB64, receiverNonceB64) {
  const a = Buffer.from(String(senderNonceB64), 'base64');
  const b = Buffer.from(String(receiverNonceB64), 'base64');
  if (a.length !== NONCE_LENGTH || b.length !== NONCE_LENGTH) {
    throw AppError.badRequest(
      `ABDM nonces must be ${NONCE_LENGTH} bytes (got ${a.length}/${b.length})`,
      'ABDM_NONCE_LENGTH',
    );
  }
  const out = Buffer.alloc(NONCE_LENGTH);
  for (let i = 0; i < NONCE_LENGTH; i += 1) out[i] = a[i] ^ b[i];
  return out;
}

/**
 * Derive the AES-256-GCM session key + IV for one transfer.
 * XOR of nonces is commutative, so sender/receiver order does not matter —
 * both sides derive identical material.
 */
export function deriveSessionKey({ privateKey, peerPublicKeyB64, senderNonceB64, receiverNonceB64 }) {
  const sharedSecret = deriveSharedSecret({ privateKey, peerPublicKeyB64 });
  const xored = xorNonces(senderNonceB64, receiverNonceB64);
  const salt = xored.subarray(0, 20);
  const iv = xored.subarray(xored.length - 12);
  const aesKey = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.alloc(0), 32));
  return { aesKey, iv };
}

/** Encrypt a UTF-8 string; returns base64(ciphertext || 16-byte GCM tag). */
export function encryptPayload({ plaintext, senderPrivateKey, senderNonce, receiverPublicKey, receiverNonce }) {
  const { aesKey, iv } = deriveSessionKey({
    privateKey: senderPrivateKey,
    peerPublicKeyB64: receiverPublicKey,
    senderNonceB64: senderNonce,
    receiverNonceB64: receiverNonce,
  });
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(String(plaintext), 'utf8')),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return encrypted.toString('base64');
}

/** Decrypt base64(ciphertext || tag); throws on tamper/auth failure. */
export function decryptPayload({ encrypted, receiverPrivateKey, receiverNonce, senderPublicKey, senderNonce }) {
  const { aesKey, iv } = deriveSessionKey({
    privateKey: receiverPrivateKey,
    peerPublicKeyB64: senderPublicKey,
    senderNonceB64: senderNonce,
    receiverNonceB64: receiverNonce,
  });
  const all = Buffer.from(String(encrypted), 'base64');
  if (all.length <= GCM_TAG_LENGTH) {
    throw AppError.badRequest('Encrypted ABDM payload too short', 'ABDM_PAYLOAD_SHORT');
  }
  const tag = all.subarray(all.length - GCM_TAG_LENGTH);
  const data = all.subarray(0, all.length - GCM_TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw AppError.badRequest('ABDM payload failed authentication (tampered or wrong key material)', 'ABDM_DECRYPT_FAILED');
  }
}

/**
 * HIP-side helper: encrypt a FHIR bundle for the requesting HIU.
 * Generates ephemeral sender key material, encrypts, and returns the
 * envelope pieces the data-push entry needs.
 *
 * @param {Object|string} bundle - FHIR bundle (object or pre-serialized string)
 * @param {Object} receiverKeyMaterial - HIU keyMaterial from the hiRequest
 * @returns {{ content: string, checksum: string, senderKeyMaterial: Object }}
 */
export function encryptFhirBundle(bundle, receiverKeyMaterial) {
  const receiverPublicKey = receiverKeyMaterial?.dhPublicKey?.keyValue;
  const receiverNonce = receiverKeyMaterial?.nonce;
  if (!receiverPublicKey || !receiverNonce) {
    throw AppError.badRequest(
      'Receiver key material incomplete — dhPublicKey.keyValue and nonce are required',
      'ABDM_KEY_MATERIAL_INCOMPLETE',
    );
  }
  const sender = generateKeyMaterial();
  const plaintext = typeof bundle === 'string' ? bundle : JSON.stringify(bundle);
  const content = encryptPayload({
    plaintext,
    senderPrivateKey: sender.privateKey,
    senderNonce: sender.nonce,
    receiverPublicKey,
    receiverNonce,
  });
  return {
    content,
    // ABDM data-push entries carry an MD5 checksum of the transmitted content.
    checksum: crypto.createHash('md5').update(content).digest('hex'),
    senderKeyMaterial: sender.keyMaterial,
  };
}

/**
 * HIU-side helper (M3 + tests): decrypt a received entry using our private
 * key/nonce and the sender's keyMaterial from the transfer envelope.
 */
export function decryptFhirBundle({ content, senderKeyMaterial, receiverPrivateKey, receiverNonce }) {
  const senderPublicKey = senderKeyMaterial?.dhPublicKey?.keyValue;
  const senderNonce = senderKeyMaterial?.nonce;
  if (!senderPublicKey || !senderNonce) {
    throw AppError.badRequest(
      'Sender key material incomplete — dhPublicKey.keyValue and nonce are required',
      'ABDM_KEY_MATERIAL_INCOMPLETE',
    );
  }
  const plaintext = decryptPayload({
    encrypted: content,
    receiverPrivateKey,
    receiverNonce,
    senderPublicKey,
    senderNonce,
  });
  try {
    return JSON.parse(plaintext);
  } catch {
    return plaintext;
  }
}

export default {
  generateKeyMaterial,
  decodePublicKey,
  privateKeyFromRaw,
  deriveSharedSecret,
  deriveSessionKey,
  encryptPayload,
  decryptPayload,
  encryptFhirBundle,
  decryptFhirBundle,
};
