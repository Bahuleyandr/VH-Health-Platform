// src/services/abdm/abdmShareIntakeService.js
//
// SCAN & SHARE intake (migration 702) — the ABDM QR flow where a patient scans
// a counter QR with any ABDM app and the CM POSTs a patient-profile share
// (/v0.5/patients/profile/share shape) to the HIP callback endpoint.
//
// Intake layering (618 precedent, design decision (a)): the raw transport
// evidence for the new callback path is recorded as a PLAIN 124-shape
// abdm_webhook_events row via abdmHipHiuService.recordWebhookEvent —
// receipt_source stays NULL, because 618's CHECK
// (chk_abdm_webhook_events_i16_receipt_shape) pins non-NULL receipt_source to
// the two I16 callback paths ('/consent/on-notify', '/health-info/on-request').
// THIS module then derives the front-desk work item in
// abdm_patient_share_intakes:
//
//   received → matched | registered → linked_visit
//            → dismissed | expired | failed
//
// PRE-RLS MOUNT: the callback router runs before tenant middleware. The
// tenant is resolved from x-hip-id by validateABDMRequest and EVERY write here
// carries tenant_id explicitly (the migration-238/336 GUC-reading DEFAULTs
// would otherwise silently stamp the default tenant).
//
// Registration performed FROM an intake follows front-desk registration's
// guardrails: near matches 409 PATIENT_DUPLICATE_REVIEW_REQUIRED, create-anyway
// requires an audited override reason, ABHA linkage rides the registerABHA
// verified-gate pathway. Identity writes → audit rows; no clinical timeline row.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import {
  findRegistrationDuplicateCandidates,
  recordRegistrationDuplicateOverride,
} from '../patient/patientDedupeService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  markWebhookProcessed,
  recordWebhookEvent,
} from '../abdmFull/abdmHipHiuService.js';
import abdmService from './abdmService.js';

const SHARE_INTAKE_TTL_MINUTES = 30;
const DUPLICATE_OVERRIDE_MIN_REASON = 10;
const EVENT_TYPE = 'patient_profile_share';

const INTAKE_RETURNING = `id, tenant_id, environment, request_id, token_number,
  counter_context, abha_number, abha_address, profile, status,
  matched_patient_uid, linked_appointment_id, processed_by_uid, processed_at,
  failure_reason, received_at, expires_at, metadata, created_at, updated_at`;

// Service-enforced transition map (the 702 CHECK constrains evidence, not order).
const TRANSITIONS = {
  received: ['matched', 'registered', 'dismissed', 'expired', 'failed'],
  matched: ['registered', 'linked_visit', 'dismissed'],
  registered: ['linked_visit', 'dismissed'],
  linked_visit: [],
  dismissed: [],
  expired: [],
  failed: [],
};

/**
 * Allowlist the CM-shared demographics. Anything not named here — including
 * any KYC/Aadhaar-adjacent fields a CM implementation might attach — is
 * dropped. Scan & Share never carries Aadhaar material into our tables.
 */
function sanitizeSharedProfile(patient) {
  if (!patient || typeof patient !== 'object') return {};
  const out = {};
  const ALLOW = [
    'name', 'firstName', 'middleName', 'lastName', 'gender',
    'yearOfBirth', 'monthOfBirth', 'dayOfBirth', 'dob',
    'address', 'districtName', 'stateName', 'pinCode', 'mobile', 'phone',
  ];
  for (const key of ALLOW) {
    if (patient[key] !== undefined && patient[key] !== null && patient[key] !== '') {
      out[key] = String(patient[key]).slice(0, 300);
    }
  }
  return out;
}

function normalizeAbhaNumber(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return /^\d{14}$/.test(digits)
    ? `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}-${digits.slice(10)}`
    : null;
}

function publicIntake(row) {
  if (!row) return null;
  return {
    id: row.id,
    environment: row.environment,
    request_id: row.request_id,
    token_number: row.token_number,
    counter_context: row.counter_context,
    abha_number: row.abha_number,
    abha_address: row.abha_address,
    profile: row.profile,
    status: row.status,
    matched_patient_uid: row.matched_patient_uid,
    linked_appointment_id: row.linked_appointment_id,
    processed_at: row.processed_at,
    received_at: row.received_at,
    expires_at: row.expires_at,
  };
}

/**
 * Verified-callback intake: derive the front-desk work item from a CM
 * profile-share callback that already passed HMAC + shared-replay validation.
 * tenant_id EXPLICIT on every write (pre-RLS mount).
 *
 * @returns {{intake: Object, duplicate: boolean, tokenNumber: string|null}}
 */
export async function handlePatientProfileShareCallback({
  tenantId = null,
  environment = 'sandbox',
  body = {},
} = {}) {
  const tid = requireTenantId(tenantId);
  const requestId = String(body.requestId || body.request_id || '').trim();
  if (!requestId) {
    throw AppError.badRequest('Profile share requestId is required', 'ABDM_SHARE_REQUEST_ID_REQUIRED');
  }
  const profileWrapper = body.profile || {};
  const patient = profileWrapper.patient || {};

  // Raw transport evidence: plain 124-shape row, receipt_source NULL by
  // design (618's CHECK pins non-NULL receipt_source to the two I16 paths).
  const eventIntake = await recordWebhookEvent({
    tenantId: tid,
    externalEventId: requestId,
    eventType: EVENT_TYPE,
    source: 'abdm_public_callback',
    signatureVerified: true,
    payload: body,
    environment,
    metadata: { callback_path: '/patients/profile/share' },
  });
  if (eventIntake.duplicate && eventIntake.event?.event_type !== EVENT_TYPE) {
    throw AppError.conflict(
      'Profile share request id collides with a different ABDM event',
      'ABDM_SHARE_EVENT_COLLISION',
    );
  }

  const abhaNumber = normalizeAbhaNumber(patient.abhaNumber ?? patient.healthIdNumber);
  const abhaAddress = patient.abhaAddress ?? patient.healthId ?? null;
  const inserted = await prisma.$queryRawUnsafe(
    `INSERT INTO abdm_patient_share_intakes
       (tenant_id, environment, request_id, token_number, counter_context,
        abha_number, abha_address, profile, status, received_at, expires_at)
     VALUES ($1::uuid, $2::text, $3::text, $4::text, $5::text,
             $6::text, $7::text, $8::jsonb, 'received', NOW(),
             NOW() + ($9::int * INTERVAL '1 minute'))
     ON CONFLICT (tenant_id, request_id, environment) DO NOTHING
     RETURNING ${INTAKE_RETURNING}`,
    tid, environment, requestId,
    patient.tokenNumber ? String(patient.tokenNumber).slice(0, 20) : null,
    profileWrapper.hipCode || profileWrapper.context || body.intent?.counter || null,
    abhaNumber,
    abhaAddress ? String(abhaAddress).trim().toLowerCase().slice(0, 120) : null,
    JSON.stringify(sanitizeSharedProfile(patient)),
    SHARE_INTAKE_TTL_MINUTES,
  );

  let intake = inserted[0] || null;
  let duplicate = false;
  if (!intake) {
    duplicate = true;
    const existing = await prisma.$queryRawUnsafe(
      `SELECT ${INTAKE_RETURNING} FROM abdm_patient_share_intakes
        WHERE tenant_id = $1::uuid AND request_id = $2::text AND environment = $3::text
        LIMIT 1`,
      tid, requestId, environment,
    );
    intake = existing[0] || null;
  } else if (!intake.token_number) {
    // No CM-assigned token: mint a queue-display token from the row id.
    const tokenRows = await prisma.$queryRawUnsafe(
      `UPDATE abdm_patient_share_intakes
          SET token_number = 'T-' || id::text, updated_at = NOW()
        WHERE id = $1::integer AND tenant_id = $2::uuid AND token_number IS NULL
        RETURNING ${INTAKE_RETURNING}`,
      intake.id, tid,
    );
    intake = tokenRows[0] || intake;
  }

  await markWebhookProcessed({
    tenantId: tid,
    id: Number(eventIntake.event.id),
    status: eventIntake.duplicate || duplicate ? 'duplicate' : 'processed',
  }).catch((err) => logger.error('Failed to mark profile-share webhook processed', {
    eventId: eventIntake.event?.id,
    error: err.message,
  }));

  logger.info('ABDM Scan & Share intake recorded', {
    tenantId: tid,
    intakeId: intake?.id,
    duplicate,
  });
  return {
    intake: publicIntake(intake),
    duplicate,
    tokenNumber: intake?.token_number || null,
  };
}

export async function listShareIntakes({
  tenantId = null, status = null, limit = 50, offset = 0,
} = {}) {
  const tid = requireTenantId(tenantId);
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const safeOffset = Math.max(Number.parseInt(offset, 10) || 0, 0);
  const normalizedStatus = status ? String(status).trim().toLowerCase() : null;
  if (normalizedStatus && !Object.prototype.hasOwnProperty.call(TRANSITIONS, normalizedStatus)) {
    throw AppError.badRequest('Unknown share-intake status filter', 'INVALID_STATUS');
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${INTAKE_RETURNING} FROM abdm_patient_share_intakes
      WHERE tenant_id = $1::uuid
        AND ($2::text IS NULL OR status = $2::text)
      ORDER BY received_at DESC
      LIMIT $3::int OFFSET $4::int`,
    tid, normalizedStatus, safeLimit, safeOffset,
  );
  return { intakes: rows.map(publicIntake), count: rows.length };
}

export async function getShareIntake({ tenantId = null, intakeId } = {}) {
  const tid = requireTenantId(tenantId);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${INTAKE_RETURNING} FROM abdm_patient_share_intakes
      WHERE id = $1::integer AND tenant_id = $2::uuid LIMIT 1`,
    Number(intakeId), tid,
  );
  if (!rows[0]) {
    throw AppError.notFound('Share intake not found', 'ABDM_SHARE_INTAKE_NOT_FOUND');
  }
  return rows[0];
}

async function transitionIntake(tid, intakeId, fromStatuses, sets, params) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE abdm_patient_share_intakes
        SET ${sets}, updated_at = NOW()
      WHERE id = $1::integer AND tenant_id = $2::uuid
        AND status IN ('${fromStatuses.join("', '")}')
      RETURNING ${INTAKE_RETURNING}`,
    Number(intakeId), tid, ...params,
  );
  return rows[0] || null;
}

/** Match an intake to an EXISTING patient. */
export async function matchShareIntake({
  tenantId = null, intakeId, patientUid, actorUid = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  if (!patientUid) {
    throw AppError.badRequest('patient_uid is required', 'MISSING_PATIENT_UID');
  }
  const patients = await prisma.$queryRawUnsafe(
    `SELECT uid FROM users
      WHERE uid = $1::uuid AND tenant_id = $2::uuid
        AND role = 'PATIENT' AND is_active = true LIMIT 1`,
    patientUid, tid,
  );
  if (!patients[0]) {
    throw AppError.notFound('Patient not found', 'PATIENT_NOT_FOUND');
  }
  const intake = await getShareIntake({ tenantId: tid, intakeId });
  const updated = await transitionIntake(
    tid, intakeId, ['received'],
    `status = 'matched', matched_patient_uid = $3::uuid,
     processed_by_uid = $4::uuid, processed_at = NOW()`,
    [patientUid, actorUid],
  );
  if (!updated) {
    throw AppError.invalidTransition(intake.status, 'matched', TRANSITIONS[intake.status] || []);
  }
  return publicIntake(updated);
}

/**
 * Register a NEW patient from an intake, driving the same guarded flow as
 * front-desk POST /patients: exact-phone probe + duplicate candidate scan →
 * 409 PATIENT_DUPLICATE_REVIEW_REQUIRED unless an audited override reason is
 * given. On create, the shared ABHA identity is linked via the registerABHA
 * verified-gate pathway (verified only if it passes the gate; a linkage
 * refusal never rolls back the registration — it is recorded on the intake).
 */
export async function registerFromShareIntake({
  tenantId = null,
  intakeId,
  actorUid = null,
  actorRole = null,
  overrides = {},
  overrideReason = '',
  requestId = null,
  ip = null,
  userAgent = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const intake = await getShareIntake({ tenantId: tid, intakeId });
  if (!['received', 'matched'].includes(intake.status)) {
    throw AppError.invalidTransition(intake.status, 'registered', ['received', 'matched']);
  }
  const profile = intake.profile || {};

  const name = String(overrides.name ?? profile.name
    ?? [profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(' ')).trim();
  if (!name) {
    throw AppError.badRequest('Patient name is required', 'MISSING_PATIENT_NAME');
  }
  const rawPhone = String(overrides.phone ?? profile.mobile ?? profile.phone ?? '').replace(/\D/g, '');
  const phoneNational = rawPhone.replace(/^91(?=\d{10}$)/, '');
  if (!/^\d{10}$/.test(phoneNational)) {
    throw AppError.badRequest(
      'A valid patient phone is required to register from this intake',
      'SHARE_INTAKE_PHONE_REQUIRED',
    );
  }
  const phone = `+91${phoneNational}`;

  const genderFirst = String(overrides.gender ?? profile.gender ?? '').trim().toLowerCase().slice(0, 1);
  const gender = genderFirst === 'm' ? 'male' : genderFirst === 'f' ? 'female' : genderFirst === 'o' ? 'other' : null;
  const dob = String(overrides.birthday ?? profile.dob ?? '').trim();
  const yob = String(profile.yearOfBirth ?? '').trim();
  const birthday = /^\d{4}-\d{2}-\d{2}$/.test(dob)
    ? dob
    : (/^\d{4}$/.test(yob) ? `${yob}-01-01` : null);
  const address = String(overrides.address ?? profile.address ?? '').trim() || null;
  const reason = String(overrideReason || '').trim();

  // Exact-phone duplicate probe (front-desk createPatient parity).
  const exactPhoneRows = await prisma.$queryRawUnsafe(
    `SELECT id, uid, phone, name, role FROM users
      WHERE tenant_id = $1::uuid
        AND (phone = $2 OR REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') LIKE $3)
      ORDER BY CASE WHEN phone = $2 THEN 0 ELSE 1 END, registered_at DESC NULLS LAST
      LIMIT 1`,
    tid, phone, `%${phoneNational}`,
  );
  if (exactPhoneRows.length > 0) {
    if (exactPhoneRows[0].role !== 'PATIENT') {
      throw AppError.conflict(
        'This phone number belongs to a non-patient account',
        'PHONE_NON_PATIENT_ACCOUNT',
      );
    }
    throw AppError.conflict('Potential duplicate patient requires review', 'PATIENT_DUPLICATE_REVIEW_REQUIRED', {
      duplicate_review_required: true,
      candidates: [{
        uid: exactPhoneRows[0].uid,
        name: exactPhoneRows[0].name,
        confidence_score: 92,
        confidence_band: 'high',
        match_signals: { phone_last10: true },
      }],
      hint: 'Use the match action to attach this intake to the existing patient.',
    });
  }

  const duplicateScan = await findRegistrationDuplicateCandidates({
    tenantId: tid,
    name,
    phone,
    birthday,
    abhaAddress: intake.abha_address || '',
  });
  if (duplicateScan.candidates.length > 0 && reason.length < DUPLICATE_OVERRIDE_MIN_REASON) {
    throw AppError.conflict('Potential duplicate patient requires review', 'PATIENT_DUPLICATE_REVIEW_REQUIRED', {
      duplicate_review_required: true,
      candidates: duplicateScan.candidates,
    });
  }

  const created = await prisma.$queryRawUnsafe(
    `INSERT INTO users
       (phone, name, gender, birthday, address, role, is_active, tenant_id, registered_at, updated_at)
     VALUES ($1, $2, $3, $4::date, $5, 'PATIENT', true, $6::uuid, NOW(), NOW())
     RETURNING id, uid`,
    phone, name, gender, birthday, address, tid,
  );
  const newPatient = created[0];

  if (duplicateScan.candidates.length > 0) {
    await recordRegistrationDuplicateOverride({
      tenantId: tid,
      newPatientUid: newPatient.uid,
      candidates: duplicateScan.candidates,
      decidedBy: actorUid,
      reason,
    });
  }

  // ABHA identity linkage rides the EXISTING verified-gate pathway. A refusal
  // (gateway down, number already verified elsewhere) is evidence on the
  // intake, never a registration rollback.
  let abhaLink = null;
  let abhaLinkError = null;
  if (intake.abha_number) {
    try {
      abhaLink = await abdmService.registerABHA(
        newPatient.uid, intake.abha_number, intake.abha_address,
        { tenantId: tid, actorUid, actorRole, requestId, ip, userAgent },
      );
    } catch (err) {
      abhaLinkError = err.code || 'ABHA_LINK_FAILED';
      logger.warn('Scan & Share registration: ABHA linkage refused', {
        intakeId: intake.id,
        code: abhaLinkError,
      });
    }
  }

  const updated = await transitionIntake(
    tid, intakeId, ['received', 'matched'],
    `status = 'registered', matched_patient_uid = $3::uuid,
     processed_by_uid = $4::uuid, processed_at = NOW(),
     metadata = metadata || $5::jsonb`,
    [newPatient.uid, actorUid, JSON.stringify({
      registered_patient_uid: newPatient.uid,
      duplicate_override: duplicateScan.candidates.length > 0,
      abha_link_status: abhaLink ? abhaLink.verification_status : null,
      abha_link_error: abhaLinkError,
    })],
  );
  if (!updated) {
    throw AppError.conflict('Share intake left the registrable state', 'ABDM_SHARE_INTAKE_STATE');
  }

  return {
    intake: publicIntake(updated),
    patient: { id: newPatient.id, uid: newPatient.uid, name, phone },
    abha_link: abhaLink,
    abha_link_error: abhaLinkError,
    duplicate_override: duplicateScan.candidates.length > 0,
  };
}

/** Attach an existing OP appointment to a matched/registered intake. */
export async function linkVisitToIntake({
  tenantId = null, intakeId, appointmentId, actorUid = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const apptId = Number.parseInt(appointmentId, 10);
  if (!Number.isFinite(apptId) || apptId <= 0) {
    throw AppError.badRequest('appointment_id must be a positive integer', 'INVALID_APPOINTMENT_ID');
  }
  const intake = await getShareIntake({ tenantId: tid, intakeId });
  if (!intake.matched_patient_uid) {
    throw AppError.conflict(
      'The intake must be matched or registered before linking a visit',
      'ABDM_SHARE_INTAKE_UNRESOLVED',
    );
  }
  const appts = await prisma.$queryRawUnsafe(
    `SELECT a.id FROM appointments a
       JOIN users u ON u.id = a.patient_id AND u.tenant_id = a.tenant_id
      WHERE a.id = $1::integer AND a.tenant_id = $2::uuid AND u.uid = $3::uuid
      LIMIT 1`,
    apptId, tid, intake.matched_patient_uid,
  );
  if (!appts[0]) {
    throw AppError.notFound(
      'Appointment not found for the resolved patient',
      'APPOINTMENT_NOT_FOUND',
    );
  }
  const updated = await transitionIntake(
    tid, intakeId, ['matched', 'registered'],
    `status = 'linked_visit', linked_appointment_id = $3::integer,
     processed_by_uid = COALESCE($4::uuid, processed_by_uid)`,
    [apptId, actorUid],
  );
  if (!updated) {
    throw AppError.invalidTransition(intake.status, 'linked_visit', TRANSITIONS[intake.status] || []);
  }
  return publicIntake(updated);
}

export async function dismissShareIntake({
  tenantId = null, intakeId, actorUid = null, reason = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const intake = await getShareIntake({ tenantId: tid, intakeId });
  const updated = await transitionIntake(
    tid, intakeId, ['received', 'matched', 'registered'],
    `status = 'dismissed', processed_by_uid = COALESCE($3::uuid, processed_by_uid),
     processed_at = COALESCE(processed_at, NOW()), failure_reason = $4::text`,
    [actorUid, reason ? String(reason).slice(0, 500) : null],
  );
  if (!updated) {
    throw AppError.invalidTransition(intake.status, 'dismissed', TRANSITIONS[intake.status] || []);
  }
  return publicIntake(updated);
}

/** Cron sweep: expire unactioned intakes (abdm-share-intake-expiry). */
export async function sweepExpiredShareIntakes() {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE abdm_patient_share_intakes
        SET status = 'expired', updated_at = NOW()
      WHERE status = 'received' AND expires_at IS NOT NULL AND expires_at < NOW()
      RETURNING id`,
  );
  if (rows.length > 0) {
    logger.info('ABDM share-intake expiry sweep complete', { expired: rows.length });
  }
  return { expired: rows.length };
}

export default {
  handlePatientProfileShareCallback,
  listShareIntakes,
  getShareIntake,
  matchShareIntake,
  registerFromShareIntake,
  linkVisitToIntake,
  dismissShareIntake,
  sweepExpiredShareIntakes,
};
