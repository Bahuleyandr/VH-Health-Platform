// src/services/billing/gatewayProviders/webhookSignature.js
//
// Shared webhook-signature verification for payment gateway providers.
// Razorpay signs webhook deliveries with HMAC-SHA256 over the EXACT raw
// request body, hex-encoded, in the `x-razorpay-signature` header. The
// dry_run provider uses the identical scheme so the whole webhook path
// (signature → intake → capture) is exercisable without live credentials.
//
// Verification is timing-safe (crypto.timingSafeEqual) and fail-closed:
// a missing secret, missing signature, or malformed hex never verifies.

import crypto from 'node:crypto';

/**
 * Verify an HMAC-SHA256 hex signature over the raw body bytes.
 * @param {Buffer|string} rawBody  The exact signed bytes (NOT re-serialized JSON).
 * @param {string} signature      Provider-supplied hex signature.
 * @param {string} secret         Webhook signing secret (decrypted plaintext).
 * @returns {boolean}
 */
export function verifyHmacSha256Signature(rawBody, signature, secret) {
  if (!secret || rawBody === null || rawBody === undefined) return false;
  const provided = String(signature || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(provided, 'hex');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/** Hex SHA-256 fingerprint of the exact signed bytes (dispute evidence). */
export function sha256Hex(rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  return crypto.createHash('sha256').update(body).digest('hex');
}

export default { verifyHmacSha256Signature, sha256Hex };
