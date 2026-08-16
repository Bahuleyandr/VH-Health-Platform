// src/utils/uhiSignature.js
//
// Beckn/DHP request-signature helpers for the UHI adapter.
//
// UHI messages carry an HTTP `Authorization: Signature ...` header (beckn
// signing spec): an ed25519 signature over the signing string
//
//   (created): <unix seconds>
//   (expires): <unix seconds>
//   digest: BLAKE-512=<base64(blake2b-512(raw request body))>
//
// The digest is computed over the EXACT raw bytes of the request body (the
// route captures them via the app.js express.json verify hook — parsed-body
// re-serialization is not byte-stable). Verification is fail-closed and
// timing-safe by construction (crypto.verify). Freshness comes from the
// signed created/expires window plus a hard tolerance so an absurdly long
// signature validity cannot be minted by the sender.
//
// Key material: raw 32-byte ed25519 keys, base64-encoded (the beckn registry
// convention). We wrap them in the fixed DER prefixes Node's crypto expects.

import crypto from 'crypto';
import { AppError } from './AppError.js';

// DER prefixes for raw ed25519 keys (RFC 8410 SPKI / PKCS8).
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const MAX_SIGNATURE_WINDOW_MS = 60 * 60 * 1000; // 1h hard cap on (expires-created)
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function unauthorized(message, code) {
  return AppError.unauthorized(message, code);
}

/**
 * Parses a beckn `Authorization: Signature k1="v1",k2="v2",...` header into
 * its parameter map. Returns null when the header is absent or not a
 * Signature scheme.
 */
export function parseBecknAuthorizationHeader(header) {
  const text = String(header || '').trim();
  if (!/^signature\s/i.test(text)) return null;
  const paramsText = text.replace(/^signature\s+/i, '');
  const params = {};
  const re = /([a-zA-Z]+)=(?:"([^"]*)"|([^,\s]+))/g;
  let match;
  while ((match = re.exec(paramsText)) !== null) {
    params[match[1]] = match[2] ?? match[3] ?? '';
  }
  if (!params.keyId || !params.signature) return null;
  return params;
}

/** BLAKE-512 digest of the raw body, base64 (beckn digest convention). */
export function computeBecknDigest(rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  return crypto.createHash('blake2b512').update(body).digest('base64');
}

/** The beckn signing string for a (created, expires, digest) triple. */
export function buildBecknSigningString({ created, expires, digest }) {
  return `(created): ${created}\n(expires): ${expires}\ndigest: BLAKE-512=${digest}`;
}

function publicKeyFromBase64(publicKeyBase64) {
  const raw = Buffer.from(String(publicKeyBase64 || ''), 'base64');
  if (raw.length !== 32) {
    throw unauthorized('UHI counterparty public key is malformed', 'UHI_SIGNATURE_KEY_INVALID');
  }
  return crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

function privateKeyFromBase64(privateKeyBase64) {
  const raw = Buffer.from(String(privateKeyBase64 || ''), 'base64');
  // Accept 32-byte seeds and 64-byte libsodium-style secret keys (seed||pub).
  const seed = raw.length === 64 ? raw.subarray(0, 32) : raw;
  if (seed.length !== 32) {
    throw new AppError('UHI signing private key is malformed', 503, 'UHI_SIGNING_KEY_INVALID');
  }
  return crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * Verifies an inbound beckn request signature. Fail-closed: any missing or
 * malformed piece throws an AppError (401) with a UHI_SIGNATURE_* code; the
 * caller stores the failure reason as evidence and NACKs.
 *
 * @param {object} args
 * @param {string} args.authorizationHeader  The raw Authorization header.
 * @param {Buffer|string} args.rawBody       Exact raw request bytes.
 * @param {string} args.publicKeyBase64      Trusted counterparty ed25519 public key (raw, base64).
 * @param {number} [args.nowMs]              Injection point for tests.
 */
export function verifyBecknSignature({
  authorizationHeader,
  rawBody,
  publicKeyBase64,
  nowMs = Date.now(),
} = {}) {
  const params = parseBecknAuthorizationHeader(authorizationHeader);
  if (!params) {
    throw unauthorized('UHI signature header is required', 'UHI_SIGNATURE_REQUIRED');
  }
  if (!publicKeyBase64) {
    throw new AppError(
      'UHI verification key is not configured',
      503,
      'UHI_SIGNATURE_KEY_NOT_CONFIGURED',
    );
  }
  const created = Number.parseInt(params.created, 10);
  const expires = Number.parseInt(params.expires, 10);
  if (!Number.isFinite(created) || !Number.isFinite(expires)) {
    throw unauthorized('UHI signature created/expires are invalid', 'UHI_SIGNATURE_WINDOW_INVALID');
  }
  const createdMs = created * 1000;
  const expiresMs = expires * 1000;
  if (expiresMs <= createdMs || expiresMs - createdMs > MAX_SIGNATURE_WINDOW_MS) {
    throw unauthorized('UHI signature validity window is invalid', 'UHI_SIGNATURE_WINDOW_INVALID');
  }
  if (nowMs < createdMs - CLOCK_SKEW_MS || nowMs > expiresMs + CLOCK_SKEW_MS) {
    throw unauthorized('UHI signature is stale', 'UHI_SIGNATURE_STALE');
  }

  const digest = computeBecknDigest(rawBody);
  const signingString = buildBecknSigningString({ created, expires, digest });
  let verified = false;
  try {
    verified = crypto.verify(
      null,
      Buffer.from(signingString, 'utf8'),
      publicKeyFromBase64(publicKeyBase64),
      Buffer.from(String(params.signature), 'base64'),
    );
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw unauthorized('UHI signature is invalid', 'UHI_SIGNATURE_INVALID');
  }
  if (!verified) {
    throw unauthorized('UHI signature is invalid', 'UHI_SIGNATURE_INVALID');
  }
  return { keyId: params.keyId, created, expires };
}

/**
 * Signs an outbound beckn message body, returning the Authorization header
 * value for our on_* callbacks.
 */
export function signBecknRequest({
  rawBody,
  privateKeyBase64,
  keyId,
  validitySeconds = 600,
  nowMs = Date.now(),
} = {}) {
  if (!keyId) {
    throw new AppError('UHI signing key id is not configured', 503, 'UHI_SIGNING_KEY_NOT_CONFIGURED');
  }
  const created = Math.floor(nowMs / 1000);
  const expires = created + Math.max(1, validitySeconds);
  const digest = computeBecknDigest(rawBody);
  const signingString = buildBecknSigningString({ created, expires, digest });
  const signature = crypto.sign(
    null,
    Buffer.from(signingString, 'utf8'),
    privateKeyFromBase64(privateKeyBase64),
  ).toString('base64');
  return `Signature keyId="${keyId}",algorithm="ed25519",created="${created}",expires="${expires}",headers="(created) (expires) digest",signature="${signature}"`;
}

export default {
  parseBecknAuthorizationHeader,
  computeBecknDigest,
  buildBecknSigningString,
  verifyBecknSignature,
  signBecknRequest,
};
