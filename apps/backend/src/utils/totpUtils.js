// src/utils/totpUtils.js
// TOTP (Time-based One-Time Password) utilities for 2FA
// Uses otplib v13+ functional API (no `authenticator` export)

import crypto from 'crypto';
import { verify, generateSecret as libGenerateSecret, generateURI } from 'otplib';
import QRCode from 'qrcode';

// Encryption key for TOTP secrets at rest (separate from JWT_SECRET)
const TOTP_ENCRYPTION_KEY = process.env.TOTP_ENCRYPTION_KEY || process.env.JWT_SECRET;
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

/**
 * Cached derived key — scryptSync is deliberately CPU-expensive
 * and must not run on every encrypt/decrypt call.
 */
let _cachedTotpKey = null;

function deriveTotpKey() {
  if (_cachedTotpKey) return _cachedTotpKey;
  _cachedTotpKey = crypto.scryptSync(TOTP_ENCRYPTION_KEY, 'vh-totp-salt', 32);
  return _cachedTotpKey;
}

/**
 * Encrypt a TOTP secret for database storage.
 * Uses AES-256-GCM authenticated encryption.
 */
export function encryptSecret(plaintext) {
  const key = deriveTotpKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a TOTP secret from database storage.
 */
export function decryptSecret(encryptedStr) {
  const key = deriveTotpKey();
  const [ivHex, tagHex, ciphertext] = encryptedStr.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Generate a new TOTP secret and QR code data URL.
 * @param {string} username - The admin's username for the QR label.
 * @returns {{ secret: string, encryptedSecret: string, qrCodeDataUrl: string, otpauthUrl: string }}
 */
export async function generateTotpSetup(username) {
  const secret = libGenerateSecret();
  const otpauthUrl = await generateURI({
    label: username,
    issuer: 'VHHealth Admin',
    secret,
  });
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

  return {
    secret,
    encryptedSecret: encryptSecret(secret),
    qrCodeDataUrl,
    otpauthUrl,
  };
}

/**
 * Verify a TOTP token against an encrypted secret.
 * @param {string} token - 6-digit code from authenticator app.
 * @param {string} encryptedSecret - Encrypted secret from database.
 * @returns {Promise<boolean>}
 */
export async function verifyTotp(token, encryptedSecret) {
  const secret = decryptSecret(encryptedSecret);
  const result = await verify({ token, secret });
  return result?.valid === true;
}

/**
 * Generate backup codes for account recovery.
 * Returns 10 plaintext codes.
 * @returns {string[]}
 */
export function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < 10; i++) {
    codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return codes;
}

/**
 * Generate a short-lived challenge token for 2FA verification step.
 * @returns {{ challengeToken: string, expiresAt: Date }}
 */
export function generateChallengeToken() {
  const challengeToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
  return { challengeToken, expiresAt };
}
