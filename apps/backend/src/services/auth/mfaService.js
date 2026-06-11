/**
 * TOTP MFA service (Phase B4).
 *
 * RFC 6238 TOTP (default sha1 / 6 digits / 30s period) with replay
 * prevention via (device_id, step) uniqueness in mfa_challenges. Stores
 * shared secrets encrypted with TOTP_ENCRYPTION_KEY plus ciphertext_hash
 * for duplicate-enrollment detection. Backup codes are hashed + salted.
 *
 * Schema is in migration 120: mfa_devices / mfa_backup_codes /
 * mfa_challenges. The crypto helpers here are deliberately small —
 * generation + verification work directly off decrypted secret bytes.
 * Legacy rows that predate encryption still require operator backfill or
 * rotation; see src/scripts/security/audit-secret-encryption.js.
 */

import crypto from 'crypto';

import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { decryptSecret as decryptTotpSecret, encryptSecret as encryptTotpSecret } from '../../utils/totpUtils.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

const TEXT_MAX = 8000;
const SHORT_MAX = 255;
const DEFAULT_DIGITS = 6;
const DEFAULT_PERIOD_SECONDS = 30;
const DEFAULT_ALGORITHM = 'sha1';
const TOTP_WINDOW = 1;
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;
const CHALLENGE_TTL_MINUTES = 5;

export const DEVICE_KINDS = ['totp', 'webauthn', 'sms', 'email'];
export const DEVICE_STATUSES = ['pending', 'verified', 'revoked'];
export const ALGORITHMS = ['sha1', 'sha256', 'sha512'];
export const CHALLENGE_KINDS = ['totp', 'backup_code', 'webauthn'];
export const CHALLENGE_STATUSES = ['pending', 'success', 'failure', 'expired'];

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isUniqueViolation(err) {
  return /duplicate key value/i.test(String(err?.message || ''));
}

function safeText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid', { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeEnum(value, allowed, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// TOTP crypto helpers (RFC 6238)
// ---------------------------------------------------------------------------

/** Generate a 20-byte cryptographically random secret encoded as base32. */
export function generateTotpSecret(byteLength = 20) {
  return base32Encode(crypto.randomBytes(byteLength));
}

/** Compute the HOTP value for a step. */
export function computeTotpCode({
  secret, step, algorithm = DEFAULT_ALGORITHM, digits = DEFAULT_DIGITS,
}) {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac(algorithm, key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const truncated = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  const otp = truncated % (10 ** digits);
  return otp.toString().padStart(digits, '0');
}

/** Compute current step for now. */
export function currentStep({ at = Date.now(), period = DEFAULT_PERIOD_SECONDS } = {}) {
  return Math.floor(at / 1000 / period);
}

/** Verify the user-supplied code against the secret with a +/- window. */
export function verifyTotpCode({
  secret, code,
  algorithm = DEFAULT_ALGORITHM, digits = DEFAULT_DIGITS,
  period = DEFAULT_PERIOD_SECONDS, window = TOTP_WINDOW, at = Date.now(),
}) {
  const cleanCode = String(code || '').trim();
  if (!cleanCode || cleanCode.length !== digits || !/^\d+$/.test(cleanCode)) return null;
  const center = currentStep({ at, period });
  for (let drift = -window; drift <= window; drift += 1) {
    const step = center + drift;
    const expected = computeTotpCode({ secret, step, algorithm, digits });
    if (timingSafeEqualString(expected, cleanCode)) {
      return step;
    }
  }
  return null;
}

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i += 1) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const cleaned = String(str || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  const out = [];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < cleaned.length; i += 1) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) throw AppError.badRequest('Invalid base32 secret character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Build a stable ciphertext hash so we can detect duplicate enrollments. */
function fingerprintSecret(secret) {
  return crypto.createHash('sha256').update(`vhmfa:${secret}`).digest('hex').slice(0, 64);
}

function isEncryptedTotpSecret(value) {
  const parts = String(value || '').split(':');
  return parts.length === 3
    && parts.every(Boolean)
    && parts.every((part) => /^[0-9a-f]+$/i.test(part));
}

function decryptStoredTotpSecret(value) {
  if (!value) return value;
  if (!isEncryptedTotpSecret(value)) return value;
  return decryptTotpSecret(value);
}

/** Hash a backup code with a per-row salt. */
function hashBackupCode(code, salt) {
  return crypto.createHmac('sha256', salt).update(code).digest('hex');
}

/** Generate N backup codes; returns plaintexts + hashed rows ready for insertion. */
function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    // Random alphanumeric, hyphenated for readability.
    const raw = crypto.randomBytes(BACKUP_CODE_LENGTH).toString('base64').replace(/[+/=]/g, '').slice(0, BACKUP_CODE_LENGTH).toUpperCase();
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashBackupCode(raw, salt);
    out.push({ raw, salt, hash });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Device CRUD + verification flow
// ---------------------------------------------------------------------------

const DEVICE_RETURNING = `id, tenant_id, user_uid, device_kind, display_name,
  algorithm, digits, period_seconds, status, verified_at, revoked_at,
  last_used_at, last_step, metadata, created_at, updated_at`;

export async function enrollTotpDevice({
  tenantId = null,
  userUid,
  displayName = null,
  algorithm = DEFAULT_ALGORITHM,
  digits = DEFAULT_DIGITS,
  period = DEFAULT_PERIOD_SECONDS,
  encryptedSecret = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanUid = maybeUuid(userUid, 'user_uid', { required: true });
  const cleanAlgo = normalizeEnum(algorithm, ALGORITHMS, 'algorithm') || DEFAULT_ALGORITHM;
  const providedSecret = encryptedSecret || generateTotpSecret();
  const secret = isEncryptedTotpSecret(providedSecret)
    ? decryptTotpSecret(providedSecret)
    : providedSecret;
  const encryptedSecretForStorage = isEncryptedTotpSecret(providedSecret)
    ? providedSecret
    : encryptTotpSecret(secret);
  const hash = fingerprintSecret(secret);

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO mfa_devices
         (tenant_id, user_uid, device_kind, display_name,
          secret_ciphertext, secret_ciphertext_hash,
          algorithm, digits, period_seconds, status)
       VALUES ($1::uuid, $2::uuid, 'totp', $3, $4, $5, $6, $7, $8, 'pending')
       RETURNING ${DEVICE_RETURNING}`,
      tid, cleanUid, safeText(displayName, 160), encryptedSecretForStorage, hash,
      cleanAlgo, digits, period,
    );
    return { device: rows[0], otpauth_url: buildOtpAuthUrl({
      secret, displayName, userUid: cleanUid, algorithm: cleanAlgo, digits, period,
    }) };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.conflict('User already has a verified TOTP device. Revoke it before enrolling a new one.');
    }
    throw err;
  }
}

function buildOtpAuthUrl({ secret, displayName, userUid, algorithm, digits, period, issuer = 'VH Health' }) {
  const params = new URLSearchParams({
    secret, algorithm: algorithm.toUpperCase(),
    digits: String(digits), period: String(period),
    issuer,
  });
  const label = encodeURIComponent(`${issuer}:${displayName || userUid}`);
  return `otpauth://totp/${label}?${params.toString()}`;
}

export async function verifyAndActivateDevice({
  tenantId = null,
  deviceId,
  userUid = null,
  code,
  ipAddress = null,
  userAgent = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const id = normalizeId(deviceId, 'device id');
  const cleanUid = userUid ? maybeUuid(userUid, 'user_uid') : null;
  const filters = ['id = $1', 'tenant_id = $2::uuid'];
  const params = [id, tid];
  if (cleanUid) {
    params.push(cleanUid);
    filters.push(`user_uid = $${params.length}::uuid`);
  }
  const dev = await prisma.$queryRawUnsafe(
    `SELECT id, tenant_id, user_uid, secret_ciphertext, algorithm, digits, period_seconds, status
     FROM mfa_devices WHERE ${filters.join(' AND ')} LIMIT 1`,
    ...params,
  );
  if (!dev[0]) throw AppError.notFound('MFA device not found');
  const device = dev[0];
  if (device.status !== 'pending') {
    throw AppError.badRequest(`Device status is ${device.status}, not pending`);
  }

  const step = verifyTotpCode({
    secret: decryptStoredTotpSecret(device.secret_ciphertext),
    code,
    algorithm: device.algorithm,
    digits: device.digits,
    period: device.period_seconds,
  });
  if (step === null) {
    await persistChallenge({
      tenantId: tid,
      deviceId: id,
      userUid: device.user_uid,
      kind: 'totp',
      step: null,
      status: 'failure',
      ipAddress, userAgent,
    });
    throw AppError.unauthorized('Invalid TOTP code');
  }

  await persistChallenge({
    tenantId: tid,
    deviceId: id,
    userUid: device.user_uid,
    kind: 'totp',
    step,
    status: 'success',
    ipAddress, userAgent,
  });

  // Generate backup codes once on activation.
  const backups = generateBackupCodes();
  const updated = await prisma.$queryRawUnsafe(
    `UPDATE mfa_devices
     SET status = 'verified', verified_at = NOW(),
         last_used_at = NOW(), last_step = $1, updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3::uuid
     RETURNING ${DEVICE_RETURNING}`,
    step, id, tid,
  );

  for (const code of backups) {
    try {
      await prisma.$queryRawUnsafe(
        `INSERT INTO mfa_backup_codes
           (tenant_id, mfa_device_id, user_uid, code_hash, code_salt)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5)`,
        tid, id, device.user_uid, code.hash, code.salt,
      );
    } catch (err) {
      if (!isMissingSchemaError(err)) throw err;
    }
  }

  return {
    device: updated[0],
    backup_codes: backups.map((b) => b.raw),
    next_step_after: step,
  };
}

export async function authenticateTotp({
  tenantId = null,
  userUid,
  code,
  ipAddress = null,
  userAgent = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanUid = maybeUuid(userUid, 'user_uid', { required: true });
  const dev = await prisma.$queryRawUnsafe(
    `SELECT id, secret_ciphertext, algorithm, digits, period_seconds, last_step
     FROM mfa_devices
     WHERE tenant_id = $1::uuid AND user_uid = $2::uuid AND device_kind = 'totp' AND status = 'verified'
     LIMIT 1`,
    tid, cleanUid,
  );
  if (!dev[0]) throw AppError.unauthorized('No verified TOTP device for user');
  const device = dev[0];

  const step = verifyTotpCode({
    secret: decryptStoredTotpSecret(device.secret_ciphertext),
    code,
    algorithm: device.algorithm,
    digits: device.digits,
    period: device.period_seconds,
  });
  if (step === null) {
    await persistChallenge({
      tenantId: tid, deviceId: device.id, userUid: cleanUid,
      kind: 'totp', step: null, status: 'failure', ipAddress, userAgent,
    });
    throw AppError.unauthorized('Invalid TOTP code');
  }
  if (device.last_step != null && BigInt(step) <= BigInt(device.last_step)) {
    await persistChallenge({
      tenantId: tid, deviceId: device.id, userUid: cleanUid,
      kind: 'totp', step, status: 'failure', ipAddress, userAgent,
    });
    throw AppError.unauthorized('Code already used (replay)');
  }
  try {
    await persistChallenge({
      tenantId: tid, deviceId: device.id, userUid: cleanUid,
      kind: 'totp', step, status: 'success', ipAddress, userAgent,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw AppError.unauthorized('Code already used (replay)');
    }
    throw err;
  }
  await prisma.$queryRawUnsafe(
    `UPDATE mfa_devices
     SET last_used_at = NOW(), last_step = $1, updated_at = NOW()
     WHERE id = $2 AND tenant_id = $3::uuid`,
    step, device.id, tid,
  );
  return { authenticated: true, step };
}

export async function consumeBackupCode({
  tenantId = null,
  userUid,
  code,
  ipAddress = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanUid = maybeUuid(userUid, 'user_uid', { required: true });
  const cleanCode = String(code || '').trim().toUpperCase();
  if (!cleanCode) throw AppError.badRequest('code is required');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, code_hash, code_salt FROM mfa_backup_codes
     WHERE tenant_id = $1::uuid AND user_uid = $2::uuid AND used_at IS NULL`,
    tid, cleanUid,
  );
  for (const row of rows) {
    const candidate = hashBackupCode(cleanCode, row.code_salt);
    if (timingSafeEqualString(candidate, row.code_hash)) {
      await prisma.$queryRawUnsafe(
        `UPDATE mfa_backup_codes
         SET used_at = NOW(), used_from_ip = $1
         WHERE id = $2 AND tenant_id = $3::uuid AND used_at IS NULL`,
        safeText(ipAddress, 64), row.id, tid,
      );
      return { authenticated: true, code_id: row.id };
    }
  }
  throw AppError.unauthorized('Invalid backup code');
}

export async function revokeDevice({
  tenantId = null, deviceId, userUid = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const id = normalizeId(deviceId, 'device id');
  const cleanUid = userUid ? maybeUuid(userUid, 'user_uid') : null;
  const filters = ['id = $1', 'tenant_id = $2::uuid', "status <> 'revoked'"];
  const params = [id, tid];
  if (cleanUid) {
    params.push(cleanUid);
    filters.push(`user_uid = $${params.length}::uuid`);
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE mfa_devices
     SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
     WHERE ${filters.join(' AND ')}
     RETURNING ${DEVICE_RETURNING}`,
    ...params,
  );
  if (!rows[0]) throw AppError.notFound('Device not found or already revoked');
  return rows[0];
}

export async function listMfaDevices({ tenantId = null, userUid = null, status = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (userUid) {
    params.push(maybeUuid(userUid, 'user_uid'));
    filters.push(`user_uid = $${params.length}::uuid`);
  }
  if (status) {
    params.push(normalizeEnum(status, DEVICE_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${DEVICE_RETURNING} FROM mfa_devices
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC`,
      ...params,
    );
    return { devices: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { devices: [], count: 0 };
    throw err;
  }
}

async function persistChallenge({
  tenantId, deviceId = null, userUid, kind, step = null, status,
  ipAddress = null, userAgent = null,
}) {
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MINUTES * 60 * 1000);
  return prisma.$queryRawUnsafe(
    `INSERT INTO mfa_challenges
       (tenant_id, user_uid, mfa_device_id, challenge_kind, step, status,
        ip_address, user_agent, expires_at, resolved_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::timestamptz, NOW())
     RETURNING id, status, step`,
    tenantId, userUid, deviceId,
    normalizeEnum(kind, CHALLENGE_KINDS, 'challenge_kind') || 'totp',
    step, status, safeText(ipAddress, 64), safeText(userAgent, SHORT_MAX),
    expiresAt.toISOString(),
  );
}

export const __testing__ = {
  base32Encode, base32Decode, hashBackupCode, fingerprintSecret,
  TOTP_WINDOW, BACKUP_CODE_COUNT,
};

export default {
  enrollTotpDevice,
  verifyAndActivateDevice,
  authenticateTotp,
  consumeBackupCode,
  revokeDevice,
  listMfaDevices,
  generateTotpSecret,
  computeTotpCode,
  currentStep,
  verifyTotpCode,
};
