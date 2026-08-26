// src/services/abdm/abhaEnrolmentService.js
//
// ABHA ENROLMENT (ABDM v3 Aadhaar-OTP / mobile-OTP) — migration 701.
//
// Closes the gap documented on abdmService.registerABHA: the platform could
// LINK an ABHA a patient already held but could not CREATE one. This service
// drives the enrolment session state machine in abha_enrolment_sessions:
//
//   initiated → otp_sent → otp_verifying → linked
//                                       → failed | expired | cancelled
//
// PRIVACY CONTRACT (zero tolerance, migration 701 header):
//   * The Aadhaar number is validated (12 digits + Verhoeff checksum),
//     RSA-encrypted IN MEMORY with the gateway's enrolment certificate, handed
//     to abdmGateway, and discarded. It is NEVER persisted to any column,
//     never logged, never placed in an error message or metadata JSONB, and
//     never echoed back. The schema has no column for it — keep it that way.
//   * OTP values get the same treatment (encrypted, forwarded, discarded).
//   * profile_snapshot keeps ONLY allowlisted gateway-returned demographics.
//
// Linkage goes through the EXISTING 653 verified-gate path: a successful
// enrolment updates users.abha_number + abha_verification_status='verified'
// (gateway-issued ⇒ verified by construction) inside one setTenantTx together
// with a clinical_audit_events row — identity, not clinical care, so NO
// clinical_timeline_events row (registerABHA precedent, abdmService.js:474).
//
// Config-gated DEFAULT OFF: ABDM_ENABLED env AND
// tenants.settings.abdmEnrolment.enabled (403 ABDM_ENROLMENT_DISABLED).

import crypto from 'crypto';

import { ABDM_CONFIG } from '../../config/abdmConfig.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { epochMsOrNull } from '../../utils/dbInstant.js';
import { maskGeneric } from '../../utils/piiMask.js';
import { recordClinicalAuditEvent } from '../clinical/canonicalClinicalPlatformService.js';
import { getAbdmEnrolmentSettings } from '../tenant/tenantSettingsService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import abdmGateway from './abdmGateway.js';

const MAX_OTP_ATTEMPTS = 3;
const MAX_OTP_RESENDS = 3;
const OTP_TTL_MINUTES = 10;
const SESSION_TTL_MINUTES = 30;
const OTP_VERIFY_CLAIM_TTL_MINUTES = 5;
const OTP_RESEND_CLAIM_TTL_MINUTES = 5;

// ---------------------------------------------------------------------------
// Aadhaar validation — Verhoeff checksum (UIDAI standard). The value never
// leaves this module unencrypted and is never included in errors or logs.
// ---------------------------------------------------------------------------

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/**
 * Verhoeff-validate a numeric string (whole string including check digit).
 * Exported for tests only — never pass the result anywhere loggable.
 */
export function verhoeffValidate(numeric) {
  if (!/^\d+$/.test(String(numeric || ''))) return false;
  let c = 0;
  const digits = String(numeric).split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i += 1) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][digits[i]]];
  }
  return c === 0;
}

/**
 * Validate an Aadhaar number: exactly 12 digits, not starting 0/1, Verhoeff
 * checksum passes. Returns the clean digits or throws INVALID_AADHAAR with a
 * message that NEVER echoes the input.
 */
export function requireValidAadhaar(aadhaarNumber) {
  const clean = String(aadhaarNumber ?? '').replace(/[\s-]/g, '');
  if (!/^[2-9]\d{11}$/.test(clean) || !verhoeffValidate(clean)) {
    throw AppError.badRequest(
      'A valid 12-digit Aadhaar number is required',
      'INVALID_AADHAAR',
    );
  }
  return clean;
}

function requireValidOtp(otp) {
  const clean = String(otp ?? '').trim();
  if (!/^\d{6}$/.test(clean)) {
    throw AppError.badRequest('A valid 6-digit OTP is required', 'INVALID_OTP');
  }
  return clean;
}

function requireValidMobile(mobile) {
  const clean = String(mobile ?? '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
  if (!/^[6-9]\d{9}$/.test(clean)) {
    throw AppError.badRequest('A valid 10-digit mobile number is required', 'INVALID_MOBILE');
  }
  return clean;
}

function requirePatientUid(patientUid) {
  const clean = String(patientUid || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean)) {
    throw AppError.badRequest('A valid patient UID is required', 'INVALID_PATIENT_UID');
  }
  return clean;
}

/** Render 14 ABHA digits in the canonical 2-4-4-4 hyphenated spelling. */
function hyphenateAbhaNumber(cleanAbha) {
  return `${cleanAbha.slice(0, 2)}-${cleanAbha.slice(2, 6)}-${cleanAbha.slice(6, 10)}-${cleanAbha.slice(10)}`;
}

function isCanonicalAbhaUniqueViolation(err) {
  const sqlState = err?.meta?.code
    ?? err?.meta?.driverAdapterError?.cause?.originalCode
    ?? err?.code;
  const detail = [
    err?.message,
    err?.meta?.message,
    err?.meta?.target,
    err?.meta?.driverAdapterError?.cause?.originalMessage,
  ].filter(Boolean).join(' ');
  const isUniqueViolation = String(sqlState) === '23505'
    || String(sqlState) === 'P2002'
    || /duplicate key value/i.test(detail);
  return isUniqueViolation && detail.includes('uniq_users_tenant_abha_number_canonical');
}

function isUniqueViolationOn(err, indexName) {
  const detail = [err?.message, err?.meta?.message, err?.meta?.target].filter(Boolean).join(' ');
  return /duplicate key value|23505|P2002/i.test(detail + String(err?.code ?? '') + String(err?.meta?.code ?? ''))
    && detail.includes(indexName);
}

// ---------------------------------------------------------------------------
// In-memory RSA encryption with the gateway's enrolment certificate.
// ---------------------------------------------------------------------------

function enrolmentPublicKeyObject(certResponse) {
  const raw = String(certResponse?.publicKey || '').trim();
  if (!raw) {
    throw AppError.internal('ABHA enrolment public key unavailable', 'ABHA_ENROLMENT_CERT_MISSING');
  }
  try {
    if (raw.includes('BEGIN')) {
      return crypto.createPublicKey(raw.replace(/\\n/g, '\n'));
    }
    // Base64 DER SPKI without PEM armor.
    return crypto.createPublicKey({
      key: Buffer.from(raw.replace(/\s+/g, ''), 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch (err) {
    logger.error('ABHA enrolment certificate could not be parsed', { error: err.message });
    throw AppError.internal('ABHA enrolment public key is invalid', 'ABHA_ENROLMENT_CERT_INVALID');
  }
}

/**
 * RSA-OAEP(SHA-1)-encrypt a sensitive value (Aadhaar / OTP / mobile) with the
 * enrolment certificate; returns base64. The plaintext is a local variable in
 * the caller and is discarded after this call.
 */
async function encryptForEnrolment(plainValue) {
  const cert = await abdmGateway.fetchEnrolmentPublicCertificate();
  const key = enrolmentPublicKeyObject(cert);
  return crypto.publicEncrypt(
    { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
    Buffer.from(String(plainValue), 'utf8'),
  ).toString('base64');
}

// ---------------------------------------------------------------------------
// Gate + shapes
// ---------------------------------------------------------------------------

async function assertEnrolmentEnabled(tenantId) {
  if (!ABDM_CONFIG.enabled) {
    throw new AppError('ABDM integration is not enabled', 503, 'ABDM_NOT_ENABLED');
  }
  const settings = await getAbdmEnrolmentSettings(tenantId);
  if (!settings.enabled) {
    throw AppError.forbidden(
      'ABHA enrolment is not enabled for this tenant',
      'ABDM_ENROLMENT_DISABLED',
    );
  }
}

const SESSION_RETURNING = `id, tenant_id, patient_uid, flow, environment, status,
  otp_attempts, mobile_last4, abha_number, abha_address, error_code,
  otp_sent_at, otp_verified_at, enrolled_at, linked_at, expires_at,
  resend_count, resend_claim_id, resend_claimed_at, created_at, updated_at`;

/** Public projection: never includes txn_id, profile_snapshot, or metadata. */
function publicSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    patient_uid: row.patient_uid,
    flow: row.flow,
    environment: row.environment,
    status: row.status,
    otp_attempts: row.otp_attempts,
    mobile_last4: row.mobile_last4,
    abha_number: row.abha_number,
    abha_address: row.abha_address,
    error_code: row.error_code,
    otp_sent_at: row.otp_sent_at,
    enrolled_at: row.enrolled_at,
    linked_at: row.linked_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
}

/**
 * Allowlist the gateway-returned profile echo. Anything not named here —
 * including any Aadhaar echo, photo bytes, or full address KYC blob the
 * gateway may return — is dropped on the floor.
 */
function sanitizeProfileSnapshot(profile) {
  if (!profile || typeof profile !== 'object') return {};
  const out = {};
  const ALLOW = [
    'firstName', 'middleName', 'lastName', 'name', 'gender',
    'dayOfBirth', 'monthOfBirth', 'yearOfBirth', 'dob',
    'districtName', 'stateName', 'pinCode', 'abhaStatus', 'abhaType',
  ];
  for (const key of ALLOW) {
    if (profile[key] !== undefined && profile[key] !== null && profile[key] !== '') {
      out[key] = String(profile[key]).slice(0, 200);
    }
  }
  const mobile = String(profile.mobile ?? '').replace(/\D/g, '');
  if (mobile.length >= 4) out.mobile_last4 = mobile.slice(-4);
  return out;
}

function extractEnrolmentResult(gatewayResponse) {
  const profile = gatewayResponse?.ABHAProfile
    || gatewayResponse?.abhaProfile
    || gatewayResponse?.profile
    || {};
  const rawNumber = String(
    profile.ABHANumber ?? profile.abhaNumber ?? profile.healthIdNumber ?? '',
  ).replace(/\D/g, '');
  const addresses = profile.phrAddress ?? profile.abhaAddress ?? profile.healthId ?? null;
  const abhaAddress = Array.isArray(addresses) ? addresses[0] : addresses;
  return {
    abhaNumberClean: /^\d{14}$/.test(rawNumber) ? rawNumber : null,
    abhaAddress: abhaAddress ? String(abhaAddress).trim().toLowerCase().slice(0, 120) : null,
    profileSnapshot: sanitizeProfileSnapshot(profile),
    isNew: gatewayResponse?.isNew === true,
  };
}

async function loadSession(tenantId, sessionId, patientUid) {
  const expectedPatientUid = requirePatientUid(patientUid);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${SESSION_RETURNING}, txn_id, metadata,
            (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_epoch_ms
       FROM abha_enrolment_sessions
      WHERE id = $1::integer AND tenant_id = $2::uuid AND patient_uid = $3::uuid
      LIMIT 1`,
    Number(sessionId), tenantId, expectedPatientUid,
  );
  if (!rows[0]) {
    throw AppError.notFound('Enrolment session not found', 'ABHA_ENROLMENT_SESSION_NOT_FOUND');
  }
  return rows[0];
}

async function markSessionFailed(tenantId, sessionId, errorCode, failureReason = null) {
  await prisma.$executeRawUnsafe(
    `UPDATE abha_enrolment_sessions
        SET status = 'failed', error_code = $3::text,
            failure_reason = $4::text, updated_at = NOW()
      WHERE id = $1::integer AND tenant_id = $2::uuid`,
    Number(sessionId), tenantId, errorCode,
    failureReason ? String(failureReason).slice(0, 500) : null,
  ).catch((err) => logger.error('Failed to mark enrolment session failed', {
    sessionId, errorCode, error: err.message,
  }));
}

async function claimOtpVerification(tenantId, sessionId) {
  const claimId = crypto.randomUUID();
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE abha_enrolment_sessions
        SET status = 'otp_verifying',
            otp_attempts = CASE
              WHEN status = 'otp_sent' THEN otp_attempts + 1
              ELSE otp_attempts
            END,
            verification_claim_id = $4::uuid,
            verification_claimed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1::integer AND tenant_id = $2::uuid
        AND (expires_at IS NULL OR expires_at >= NOW())
        AND (
          (status = 'otp_sent' AND otp_attempts < $3::int)
          OR (
            status = 'otp_verifying'
            AND verification_claimed_at <= NOW() - ($5::int * INTERVAL '1 minute')
          )
        )
      RETURNING ${SESSION_RETURNING}, txn_id, metadata,
                verification_claim_id, verification_claimed_at`,
    Number(sessionId), tenantId, MAX_OTP_ATTEMPTS, claimId,
    OTP_VERIFY_CLAIM_TTL_MINUTES,
  );
  return rows[0] ?? null;
}

async function releaseOtpVerificationClaim({
  tenantId, sessionId, claimId, attempts, errorCode = null, failureReason = null,
}) {
  const terminal = Number(attempts) >= MAX_OTP_ATTEMPTS;
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE abha_enrolment_sessions
        SET status = $4::text,
            error_code = $5::text,
            failure_reason = $6::text,
            verification_claim_id = NULL,
            verification_claimed_at = NULL,
            updated_at = NOW()
      WHERE id = $1::integer AND tenant_id = $2::uuid
        AND status = 'otp_verifying' AND verification_claim_id = $3::uuid
      RETURNING ${SESSION_RETURNING}`,
    Number(sessionId), tenantId, claimId,
    terminal ? 'failed' : 'otp_sent',
    terminal ? (errorCode || 'otp_attempts_exceeded') : null,
    terminal && failureReason ? String(failureReason).slice(0, 500) : null,
  );
  return rows[0] ?? null;
}

async function claimOtpResend(tenantId, sessionId, patientUid) {
  const claimId = crypto.randomUUID();
  const expectedPatientUid = requirePatientUid(patientUid);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE abha_enrolment_sessions
        SET resend_count = resend_count + 1,
            resend_claim_id = $4::uuid,
            resend_claimed_at = NOW(),
            updated_at = NOW()
      WHERE id = $1::integer AND tenant_id = $2::uuid
        AND patient_uid = $3::uuid AND status = 'otp_sent'
        AND (expires_at IS NULL OR expires_at >= NOW())
        AND resend_count < $5::smallint
        AND (
          resend_claim_id IS NULL
          OR resend_claimed_at <= NOW() - ($6::int * INTERVAL '1 minute')
        )
      RETURNING ${SESSION_RETURNING}, txn_id, metadata`,
    Number(sessionId), tenantId, expectedPatientUid, claimId,
    MAX_OTP_RESENDS, OTP_RESEND_CLAIM_TTL_MINUTES,
  );
  return rows[0] ?? null;
}

async function releaseOtpResendClaim(tenantId, sessionId, claimId) {
  await prisma.$executeRawUnsafe(
    `UPDATE abha_enrolment_sessions
        SET resend_claim_id = NULL, resend_claimed_at = NULL, updated_at = NOW()
      WHERE id = $1::integer AND tenant_id = $2::uuid
        AND resend_claim_id = $3::uuid AND status = 'otp_sent'`,
    Number(sessionId), tenantId, claimId,
  ).catch((err) => logger.error('Failed to release ABHA OTP resend claim', {
    sessionId, error: err.message,
  }));
}

function verificationClaimLost() {
  return AppError.conflict(
    'OTP verification was completed or reclaimed by another request',
    'ABHA_ENROLMENT_VERIFY_SUPERSEDED',
  );
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

/**
 * Start an enrolment session and request the first OTP.
 *
 * flow 'aadhaar_otp' (default): aadhaarNumber required — validated, encrypted
 * in memory, forwarded, discarded. flow 'mobile_otp': mobile required — the
 * verify/update-mobile leg for a patient whose enrolment (or linked ABHA)
 * already exists.
 */
export async function startEnrolment({
  tenantId = null,
  patientUid,
  flow = 'aadhaar_otp',
  aadhaarNumber = null,
  mobile = null,
  requestedBy = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  await assertEnrolmentEnabled(tid);
  if (!patientUid) {
    throw AppError.badRequest('Patient UID is required', 'MISSING_PATIENT_UID');
  }
  if (!['aadhaar_otp', 'mobile_otp'].includes(flow)) {
    throw AppError.badRequest('flow must be aadhaar_otp or mobile_otp', 'INVALID_ENROLMENT_FLOW');
  }

  // Validate sensitive inputs FIRST (local variables only; discarded below).
  const cleanAadhaar = flow === 'aadhaar_otp' ? requireValidAadhaar(aadhaarNumber) : null;
  const cleanMobile = mobile !== null && mobile !== undefined && String(mobile).trim() !== ''
    ? requireValidMobile(mobile)
    : null;
  if (flow === 'mobile_otp' && !cleanMobile) {
    throw AppError.badRequest('A valid 10-digit mobile number is required', 'INVALID_MOBILE');
  }

  const patients = await prisma.$queryRawUnsafe(
    `SELECT uid, abha_number, abha_verification_status
       FROM users
      WHERE uid = $1::uuid AND tenant_id = $2::uuid
        AND role = 'PATIENT' AND is_active = true
      LIMIT 1`,
    patientUid, tid,
  );
  if (!patients[0]) {
    throw AppError.notFound('Patient not found', 'PATIENT_NOT_FOUND');
  }
  const patient = patients[0];
  if (flow === 'aadhaar_otp' && patient.abha_verification_status === 'verified') {
    throw AppError.conflict(
      'A verified ABHA is already linked to this patient',
      'ABHA_ALREADY_VERIFIED',
    );
  }
  // The mobile-verify leg presumes an enrolment happened: require a linked ABHA.
  let priorTxnId = null;
  if (flow === 'mobile_otp') {
    if (!patient.abha_number) {
      throw AppError.conflict(
        'Mobile verification requires an enrolled/linked ABHA',
        'ABHA_ENROLMENT_REQUIRED',
      );
    }
    const prior = await prisma.$queryRawUnsafe(
      `SELECT txn_id FROM abha_enrolment_sessions
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
          AND flow = 'aadhaar_otp' AND status IN ('enrolled', 'linked')
          AND txn_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      tid, patientUid,
    );
    priorTxnId = prior[0]?.txn_id || null;
  }

  // Claim the one-live-session-per-patient slot BEFORE any gateway call so a
  // double-click cannot fire two OTP requests.
  let session;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO abha_enrolment_sessions
         (tenant_id, patient_uid, flow, environment, status, requested_by_uid,
          expires_at, mobile_last4)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text, 'initiated', $5::uuid,
               NOW() + ($6::int * INTERVAL '1 minute'), $7::text)
       RETURNING ${SESSION_RETURNING}`,
      tid, patientUid, flow, ABDM_CONFIG.environment,
      requestedBy || patientUid, SESSION_TTL_MINUTES,
      cleanMobile ? cleanMobile.slice(-4) : null,
    );
    session = rows[0];
  } catch (err) {
    if (isUniqueViolationOn(err, 'ux_abha_enrolment_patient_live')) {
      throw AppError.conflict(
        'An enrolment session is already in progress for this patient',
        'ABHA_ENROLMENT_IN_PROGRESS',
      );
    }
    throw err;
  }

  // Request the OTP: sensitive value is encrypted in memory then discarded.
  let otpResult;
  try {
    const encryptedValue = await encryptForEnrolment(
      flow === 'aadhaar_otp' ? cleanAadhaar : cleanMobile,
    );
    otpResult = await abdmGateway.requestEnrolmentOtp({
      scope: flow === 'aadhaar_otp' ? 'abha-enrol' : 'mobile-verify',
      encryptedValue,
      txnId: priorTxnId,
    });
  } catch (err) {
    await markSessionFailed(tid, session.id, 'otp_request_failed', err.message);
    throw err;
  }

  try {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE abha_enrolment_sessions
          SET txn_id = $3::text, status = 'otp_sent', otp_sent_at = NOW(),
              expires_at = NOW() + ($4::int * INTERVAL '1 minute'),
              updated_at = NOW()
        WHERE id = $1::integer AND tenant_id = $2::uuid AND status = 'initiated'
        RETURNING ${SESSION_RETURNING}`,
      session.id, tid, String(otpResult.txnId), OTP_TTL_MINUTES,
    );
    if (!rows[0]) {
      throw AppError.conflict('Enrolment session left the initiated state', 'ABHA_ENROLMENT_STATE');
    }
    logger.info('ABHA enrolment OTP sent', {
      sessionId: rows[0].id,
      flow,
      txnId: maskGeneric(String(otpResult.txnId)),
    });
    return publicSession(rows[0]);
  } catch (err) {
    if (isUniqueViolationOn(err, 'ux_abha_enrolment_tenant_txn')) {
      // The gateway returned a txn we already recorded — a replayed
      // request-otp collapse (701 unique).
      await markSessionFailed(tid, session.id, 'txn_replay');
      throw AppError.conflict(
        'This enrolment transaction is already recorded',
        'ABHA_ENROLMENT_TXN_REPLAY',
      );
    }
    throw err;
  }
}

/**
 * Verify the OTP for a session. Aadhaar flow completes enrolment and links the
 * resulting ABHA through the 653 verified gate (users update + audit row +
 * session → linked in ONE setTenantTx). Mobile flow completes the
 * verify-mobile leg.
 */
export async function verifyEnrolmentOtp({
  tenantId = null,
  sessionId,
  patientUid,
  otp,
  actorUid = null,
  actorRole = null,
  requestId = null,
  ip = null,
  userAgent = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  await assertEnrolmentEnabled(tid);
  const cleanOtp = requireValidOtp(otp);
  const session = await loadSession(tid, sessionId, patientUid);

  if (session.status === 'linked') return publicSession(session);
  if (!['otp_sent', 'otp_verifying'].includes(session.status)) {
    throw AppError.invalidTransition(session.status, 'otp_verified', ['otp_sent']);
  }
  const sessionExpiry = epochMsOrNull(session.expires_at_epoch_ms);
  if (session.status === 'otp_sent'
      && sessionExpiry != null && sessionExpiry < Date.now()) {
    await prisma.$executeRawUnsafe(
      `UPDATE abha_enrolment_sessions SET status = 'expired', updated_at = NOW()
        WHERE id = $1::integer AND tenant_id = $2::uuid AND status = 'otp_sent'`,
      session.id, tid,
    );
    throw AppError.badRequest('The enrolment OTP has expired', 'ABHA_ENROLMENT_EXPIRED');
  }

  // Claim the gateway verification leg before leaving the database. Only one
  // request may own the claim; a crashed worker can be reclaimed after the
  // bounded timeout, and its stale claim token can never finalize the row.
  const claimed = await claimOtpVerification(tid, session.id);
  if (!claimed) {
    const current = await loadSession(tid, session.id, patientUid);
    if (current.status === 'linked') return publicSession(current);
    if (current.status === 'otp_verifying') {
      throw AppError.conflict(
        'OTP verification is already in progress',
        'ABHA_ENROLMENT_VERIFY_IN_PROGRESS',
      );
    }
    if (current.status === 'otp_sent' && Number(current.otp_attempts) >= MAX_OTP_ATTEMPTS) {
      await prisma.$executeRawUnsafe(
        `UPDATE abha_enrolment_sessions
            SET status = 'failed', error_code = 'otp_attempts_exceeded', updated_at = NOW()
          WHERE id = $1::integer AND tenant_id = $2::uuid
            AND status = 'otp_sent' AND otp_attempts >= $3::int`,
        session.id, tid, MAX_OTP_ATTEMPTS,
      );
      throw new AppError(
        'Too many OTP attempts for this enrolment session',
        429,
        'ABHA_ENROLMENT_OTP_ATTEMPTS_EXCEEDED',
      );
    }
    throw verificationClaimLost();
  }
  const attempts = Number(claimed.otp_attempts);
  const claimId = claimed.verification_claim_id;

  let gatewayResponse;
  try {
    const encryptedOtp = await encryptForEnrolment(cleanOtp);
    gatewayResponse = claimed.flow === 'aadhaar_otp'
      ? await abdmGateway.enrolByAadhaar({ txnId: claimed.txn_id, encryptedOtp })
      : await abdmGateway.verifyMobileOtp({ txnId: claimed.txn_id, encryptedOtp });
  } catch (_err) {
    const released = await releaseOtpVerificationClaim({
      tenantId: tid,
      sessionId: claimed.id,
      claimId,
      attempts,
      errorCode: 'otp_attempts_exceeded',
    });
    if (!released) throw verificationClaimLost();
    throw AppError.badRequest(
      'The ABDM gateway rejected the OTP',
      'ABHA_ENROLMENT_OTP_REJECTED',
    );
  }

  if (claimed.flow === 'mobile_otp') {
    // Mobile leg completion. The session's ABHA columns echo the ALREADY
    // linked ABHA so the 701 evidence CHECK holds ('linked' requires them).
    const linked = await setTenantTx(tid, async (tx) => {
      const users = await tx.$queryRawUnsafe(
        `SELECT abha_number, abha_address FROM users
          WHERE uid = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
        claimed.patient_uid, tid,
      );
      const rows = await tx.$queryRawUnsafe(
        `UPDATE abha_enrolment_sessions
            SET status = 'linked', otp_verified_at = NOW(), enrolled_at = NOW(),
                linked_at = NOW(), abha_number = $3::text, abha_address = $4::text,
                verification_claim_id = NULL, verification_claimed_at = NULL,
                updated_at = NOW()
          WHERE id = $1::integer AND tenant_id = $2::uuid
            AND status = 'otp_verifying' AND verification_claim_id = $5::uuid
          RETURNING ${SESSION_RETURNING}`,
        claimed.id, tid,
        users[0]?.abha_number || null, users[0]?.abha_address || null,
        claimId,
      );
      if (!rows[0]) throw verificationClaimLost();
      await recordClinicalAuditEvent({
        tenantId: tid,
        patientUid: claimed.patient_uid,
        action: 'ABHA_MOBILE_VERIFIED',
        actionStatus: 'success',
        actorUid: actorUid || claimed.patient_uid,
        actorRole,
        resourceType: 'ABHA_ENROLMENT',
        resourceTable: 'abha_enrolment_sessions',
        resourceId: String(claimed.id),
        requestId,
        ipAddress: ip,
        userAgent,
        metadata: { flow: 'mobile_otp', environment: claimed.environment },
        idempotencyKey: `abha-enrol:${claimed.id}:mobile_verified`,
      }, { db: tx });
      return rows[0];
    });
    return publicSession(linked);
  }

  const result = extractEnrolmentResult(gatewayResponse);
  if (!result.abhaNumberClean) {
    const released = await releaseOtpVerificationClaim({
      tenantId: tid,
      sessionId: claimed.id,
      claimId,
      attempts: MAX_OTP_ATTEMPTS,
      errorCode: 'enrolment_no_abha',
    });
    if (!released) throw verificationClaimLost();
    throw AppError.internal(
      'The ABDM gateway completed enrolment without returning an ABHA number',
      'ABHA_ENROLMENT_NO_ABHA',
    );
  }
  const normalizedAbha = hyphenateAbhaNumber(result.abhaNumberClean);

  // LINK through the 653 verified gate: users update + audit + session →
  // linked, all in ONE transaction. Gateway-issued ⇒ verified by construction.
  try {
    const linked = await setTenantTx(tid, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `UPDATE abha_enrolment_sessions
            SET status = 'linked', otp_verified_at = NOW(), enrolled_at = NOW(),
                linked_at = NOW(), abha_number = $3::text, abha_address = $4::text,
                profile_snapshot = $5::jsonb,
                verification_claim_id = NULL, verification_claimed_at = NULL,
                updated_at = NOW()
          WHERE id = $1::integer AND tenant_id = $2::uuid
            AND status = 'otp_verifying' AND verification_claim_id = $6::uuid
          RETURNING ${SESSION_RETURNING}`,
        claimed.id, tid, normalizedAbha, result.abhaAddress,
        JSON.stringify(result.profileSnapshot),
        claimId,
      );
      if (!rows[0]) throw verificationClaimLost();
      const users = await tx.$queryRawUnsafe(
        `UPDATE users
            SET abha_number = $1, abha_address = $2,
                abha_verification_status = 'verified',
                abha_verified_at = COALESCE(abha_verified_at, NOW()),
                updated_at = NOW()
          WHERE uid = $3::uuid AND tenant_id = $4::uuid
          RETURNING uid`,
        normalizedAbha, result.abhaAddress, claimed.patient_uid, tid,
      );
      if (!users[0]) {
        throw AppError.notFound('Patient not found', 'PATIENT_NOT_FOUND');
      }
      await recordClinicalAuditEvent({
        tenantId: tid,
        patientUid: claimed.patient_uid,
        action: 'ABHA_ENROLLED',
        actionStatus: 'success',
        actorUid: actorUid || claimed.patient_uid,
        actorRole,
        resourceType: 'ABHA_LINKAGE',
        resourceTable: 'users',
        resourceId: String(claimed.patient_uid),
        requestId,
        ipAddress: ip,
        userAgent,
        metadata: {
          verification_status: 'verified',
          gateway_issued: true,
          enrolment_session_id: claimed.id,
          environment: claimed.environment,
          is_new_abha: result.isNew,
        },
        idempotencyKey: `abha-enrol:${claimed.id}:linked`,
      }, { db: tx });
      return rows[0];
    });

    logger.info('ABHA enrolled and linked', {
      sessionId: claimed.id,
      patientUid: claimed.patient_uid,
      abhaNumber: maskGeneric(normalizedAbha),
    });
    return publicSession(linked);
  } catch (err) {
    if (isCanonicalAbhaUniqueViolation(err)) {
      // Another patient holds the verified slot (653 canonical unique). The
      // enrolment DID succeed at the gateway — keep the evidence columns, mark
      // the session failed per the design contract.
      await prisma.$executeRawUnsafe(
        `UPDATE abha_enrolment_sessions
            SET status = 'failed', error_code = 'abha_already_linked',
                otp_verified_at = NOW(), enrolled_at = NOW(),
                abha_number = $3::text, abha_address = $4::text,
                profile_snapshot = $5::jsonb,
                verification_claim_id = NULL, verification_claimed_at = NULL,
                updated_at = NOW()
          WHERE id = $1::integer AND tenant_id = $2::uuid
            AND status = 'otp_verifying' AND verification_claim_id = $6::uuid`,
        claimed.id, tid, normalizedAbha, result.abhaAddress,
        JSON.stringify(result.profileSnapshot),
        claimId,
      ).catch((markErr) => logger.error('Failed to record enrolment conflict', {
        sessionId: claimed.id, error: markErr.message,
      }));
      throw AppError.conflict(
        'This ABHA number is already linked to another patient',
        'ABHA_ALREADY_LINKED',
      );
    }
    throw err;
  }
}

/**
 * Re-send the enrolment OTP. The Aadhaar number is never stored, so the
 * aadhaar_otp flow requires it AGAIN from the caller (validated, encrypted in
 * memory, discarded — exactly like startEnrolment).
 */
export async function resendEnrolmentOtp({
  tenantId = null,
  sessionId,
  patientUid,
  aadhaarNumber = null,
  mobile = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  await assertEnrolmentEnabled(tid);
  const session = await loadSession(tid, sessionId, patientUid);
  if (session.status !== 'otp_sent') {
    throw AppError.invalidTransition(session.status, 'otp_sent', ['otp_sent']);
  }
  const resends = Number(session.resend_count ?? session.metadata?.resend_count ?? 0);
  if (resends >= MAX_OTP_RESENDS) {
    throw new AppError(
      'Too many OTP resends for this enrolment session',
      429,
      'ABHA_ENROLMENT_RESEND_EXCEEDED',
    );
  }

  const cleanValue = session.flow === 'aadhaar_otp'
    ? requireValidAadhaar(aadhaarNumber)
    : requireValidMobile(mobile);
  const encryptedValue = await encryptForEnrolment(cleanValue);
  const claimed = await claimOtpResend(tid, session.id, patientUid);
  if (!claimed) {
    const current = await loadSession(tid, session.id, patientUid);
    const currentResends = Number(current.resend_count ?? current.metadata?.resend_count ?? 0);
    if (currentResends >= MAX_OTP_RESENDS) {
      throw new AppError(
        'Too many OTP resends for this enrolment session',
        429,
        'ABHA_ENROLMENT_RESEND_EXCEEDED',
      );
    }
    if (current.resend_claim_id) {
      throw AppError.conflict(
        'An OTP resend is already being processed',
        'ABHA_ENROLMENT_RESEND_IN_PROGRESS',
      );
    }
    throw AppError.conflict(
      'Enrolment session left the otp_sent state',
      'ABHA_ENROLMENT_STATE',
    );
  }

  let otpResult;
  try {
    otpResult = await abdmGateway.requestEnrolmentOtp({
      scope: claimed.flow === 'aadhaar_otp' ? 'abha-enrol' : 'mobile-verify',
      encryptedValue,
      txnId: claimed.txn_id,
    });
  } catch (err) {
    await releaseOtpResendClaim(tid, claimed.id, claimed.resend_claim_id);
    throw err;
  }

  const rows = await prisma.$queryRawUnsafe(
    `UPDATE abha_enrolment_sessions
        SET txn_id = $3::text, otp_sent_at = NOW(), otp_attempts = 0,
            expires_at = NOW() + ($4::int * INTERVAL '1 minute'),
            metadata = metadata || jsonb_build_object('resend_count', $5::int),
            resend_claim_id = NULL, resend_claimed_at = NULL,
            updated_at = NOW()
      WHERE id = $1::integer AND tenant_id = $2::uuid AND status = 'otp_sent'
        AND patient_uid = $6::uuid AND resend_claim_id = $7::uuid
      RETURNING ${SESSION_RETURNING}`,
    claimed.id, tid, String(otpResult.txnId), OTP_TTL_MINUTES,
    Number(claimed.resend_count), requirePatientUid(patientUid), claimed.resend_claim_id,
  );
  if (!rows[0]) {
    throw AppError.conflict(
      'OTP resend was completed or reclaimed by another request',
      'ABHA_ENROLMENT_RESEND_SUPERSEDED',
    );
  }
  return publicSession(rows[0]);
}

/**
 * Cancel an enrolment session so the patient can start a new one.
 *
 * WHAT COUNTS AS CANCELLABLE. Every status the one-live-session partial
 * unique index counts as live — and since migration 707 that index is
 * `status IN ('initiated','otp_sent','otp_verifying','otp_verified')`.
 * 'otp_verifying' used to be missing here, so a
 * row in that state held the slot and cancel answered 404
 * ABHA_ENROLMENT_SESSION_NOT_FOUND: the patient could not start again until
 * the every-5-minute expiry sweep passed the row's expires_at, which
 * startEnrolment sets to OTP_TTL_MINUTES after the OTP was sent.
 *
 * THE RACE, AND HOW IT IS HANDLED. 'otp_verifying' is the one live status a
 * request may still be standing inside: verifyEnrolmentOtp claims the row,
 * calls the gateway, and finalizes with a compare-and-set on
 * `status = 'otp_verifying' AND verification_claim_id = <its own token>`.
 *
 *   • FRESH claim (younger than OTP_VERIFY_CLAIM_TTL_MINUTES) — a verifier
 *     may be inside enrolByAadhaar right now. Cancelling under it could
 *     leave the gateway having minted an ABHA that neither this row nor
 *     users.abha_number ever records. Cancel therefore refuses and answers
 *     409 ABHA_ENROLMENT_VERIFY_IN_PROGRESS, the same code verifyEnrolmentOtp
 *     already returns for this state.
 *   • STALE claim (older than that TTL) — by this service's own rule the
 *     verifier is gone: claimOtpVerification re-claims exactly these rows for
 *     a NEW verify attempt. Cancelling one retires a row the service was
 *     already willing to hand to another request, so it opens no new hole.
 *   • And if a stale verifier does come back, every terminal write it can
 *     make still requires `status = 'otp_verifying'`. Against a cancelled row
 *     they match nothing and it raises ABHA_ENROLMENT_VERIFY_SUPERSEDED, so a
 *     cancelled session can never be silently promoted to linked.
 *
 * This is deliberately stricter than sweepExpiredEnrolmentSessions, which
 * expires an otp_verifying row regardless of claim age: the sweep only fires
 * once expires_at has passed, whereas cancel fires the moment a patient asks.
 */
export async function cancelEnrolment({ tenantId = null, sessionId, patientUid } = {}) {
  const tid = requireTenantId(tenantId);
  const expectedPatientUid = requirePatientUid(patientUid);
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE abha_enrolment_sessions
        SET status = 'cancelled',
            verification_claim_id = NULL, verification_claimed_at = NULL,
            resend_claim_id = NULL, resend_claimed_at = NULL,
            updated_at = NOW()
      WHERE id = $1::integer AND tenant_id = $2::uuid
        AND patient_uid = $3::uuid
        AND (
          status IN ('initiated', 'otp_sent', 'otp_verified')
          OR (
            status = 'otp_verifying'
            AND (
              verification_claimed_at IS NULL
              OR verification_claimed_at <= NOW() - ($4::int * INTERVAL '1 minute')
            )
          )
        )
      RETURNING ${SESSION_RETURNING}`,
    Number(sessionId), tid, expectedPatientUid, OTP_VERIFY_CLAIM_TTL_MINUTES,
  );
  if (!rows[0]) {
    const verifying = await prisma.$queryRawUnsafe(
      `SELECT id FROM abha_enrolment_sessions
        WHERE id = $1::integer AND tenant_id = $2::uuid
          AND patient_uid = $3::uuid AND status = 'otp_verifying'
        LIMIT 1`,
      Number(sessionId), tid, expectedPatientUid,
    );
    if (verifying[0]) {
      throw AppError.conflict(
        'OTP verification is already in progress for this session',
        'ABHA_ENROLMENT_VERIFY_IN_PROGRESS',
      );
    }
    throw AppError.notFound(
      'No live enrolment session to cancel',
      'ABHA_ENROLMENT_SESSION_NOT_FOUND',
    );
  }
  return publicSession(rows[0]);
}

/** Latest enrolment session for a patient (safe projection only). */
export async function getEnrolmentStatus({ tenantId = null, patientUid } = {}) {
  const tid = requireTenantId(tenantId);
  if (!patientUid) {
    throw AppError.badRequest('Patient UID is required', 'MISSING_PATIENT_UID');
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${SESSION_RETURNING} FROM abha_enrolment_sessions
      WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
      ORDER BY created_at DESC LIMIT 1`,
    tid, patientUid,
  );
  return { session: publicSession(rows[0] || null) };
}

/**
 * Cron sweep: expire live sessions past expires_at (abha-enrolment-expiry).
 * The scheduler may invoke only migration 736's parameterless owner routine;
 * runtime SQL cannot choose a tenant, predicate, state, timestamp, or payload.
 */
export async function sweepExpiredEnrolmentSessions() {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT public.sweep_expired_abha_enrolment_sessions() AS expired',
  );
  const expired = Number(rows[0]?.expired ?? 0);
  if (expired > 0) {
    logger.info('ABHA enrolment expiry sweep complete', { expired });
  }
  return { expired };
}

export default {
  verhoeffValidate,
  requireValidAadhaar,
  startEnrolment,
  verifyEnrolmentOtp,
  resendEnrolmentOtp,
  cancelEnrolment,
  getEnrolmentStatus,
  sweepExpiredEnrolmentSessions,
};
