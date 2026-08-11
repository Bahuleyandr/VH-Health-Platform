import { AppError } from '../../utils/AppError.js';
import { isValidPhone, normalizePhone } from '../../utils/phoneUtils.js';
import { requireTenantId } from '../tenant/tenantService.js';

function positiveInt(value, label) {
  const text = String(value ?? '').trim();
  const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function patientUnavailable() {
  return AppError.conflict(
    'Patient is no longer available for appointment booking',
    'APPOINTMENT_PATIENT_UNAVAILABLE',
  );
}

function assertActivePatient(row, tenantId = null) {
  if (
    !row
    || (row.tenant_id != null
      && String(row.tenant_id).trim().toLowerCase() !== String(tenantId).trim().toLowerCase())
    || String(row.role || '').trim().toUpperCase() !== 'PATIENT'
    || row.is_active !== true
    || String(row.status || '').trim().toLowerCase() !== 'active'
    || row.is_deleted !== false
    || row.deleted_at !== null
    || row.merged_into_uid !== null
  ) {
    throw patientUnavailable();
  }
}

function assertExpectedPhone(row, expectedPhone, required) {
  const requested = normalizePhone(expectedPhone);
  if (required && (!requested || !isValidPhone(requested))) {
    throw AppError.badRequest(
      'Valid patient phone is required for staff appointment booking',
      'APPOINTMENT_PATIENT_PHONE_REQUIRED',
    );
  }
  if (!requested) return;
  const stored = normalizePhone(row.phone);
  if (!stored || !isValidPhone(stored) || stored !== requested) {
    throw AppError.conflict(
      'patient_id and patient_phone identify different patients',
      'APPOINTMENT_PATIENT_ID_PHONE_MISMATCH',
    );
  }
}

export async function lockAppointmentPatientIdentity(db, {
  tenantId,
  patientId = null,
  patientUid = null,
  expectedPhone = null,
  requirePhoneMatch = false,
  allowMissing = false,
} = {}) {
  if (!db || typeof db.$queryRawUnsafe !== 'function') {
    throw AppError.internal(
      'Appointment patient identity transaction is unavailable',
      'APPOINTMENT_PATIENT_TX_REQUIRED',
    );
  }
  const tid = requireTenantId(tenantId);
  if (requirePhoneMatch) {
    const requested = normalizePhone(expectedPhone);
    if (!requested || !isValidPhone(requested)) {
      throw AppError.badRequest(
        'Valid patient phone is required for staff appointment booking',
        'APPOINTMENT_PATIENT_PHONE_REQUIRED',
      );
    }
  }

  let rows;
  if (patientId !== null && patientId !== undefined && patientId !== '') {
    rows = await db.$queryRawUnsafe(
      `SELECT id, uid, phone, name, role, is_active, status,
              is_deleted, deleted_at, merged_into_uid, tenant_id
         FROM users
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND role = 'PATIENT'
          AND is_active = TRUE
          AND LOWER(BTRIM(COALESCE(status, ''))) = 'active'
          AND is_deleted IS FALSE
          AND deleted_at IS NULL
          AND merged_into_uid IS NULL
        LIMIT 1
        FOR UPDATE`,
      tid,
      positiveInt(patientId, 'patient_id'),
    );
  } else if (patientUid !== null && patientUid !== undefined && patientUid !== '') {
    const uid = String(patientUid || '').trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uid)) {
      throw AppError.badRequest('patient_uid must be a UUID');
    }
    rows = await db.$queryRawUnsafe(
      `SELECT id, uid, phone, name, role, is_active, status,
              is_deleted, deleted_at, merged_into_uid, tenant_id
         FROM users
        WHERE tenant_id = $1::uuid
          AND uid = $2::uuid
          AND role = 'PATIENT'
          AND is_active = TRUE
          AND LOWER(BTRIM(COALESCE(status, ''))) = 'active'
          AND is_deleted IS FALSE
          AND deleted_at IS NULL
          AND merged_into_uid IS NULL
        LIMIT 1
        FOR UPDATE`,
      tid,
      uid,
    );
  } else {
    const requested = normalizePhone(expectedPhone);
    if (!requested || !isValidPhone(requested)) {
      throw AppError.badRequest(
        'Valid patient phone is required for staff appointment booking',
        'APPOINTMENT_PATIENT_PHONE_REQUIRED',
      );
    }
    rows = await db.$queryRawUnsafe(
      `SELECT id, uid, phone, name, role, is_active, status,
              is_deleted, deleted_at, merged_into_uid, tenant_id
         FROM users
        WHERE tenant_id = $1::uuid
          AND role = 'PATIENT'
          AND is_active = TRUE
          AND LOWER(BTRIM(COALESCE(status, ''))) = 'active'
          AND is_deleted IS FALSE
          AND deleted_at IS NULL
          AND merged_into_uid IS NULL
          AND (phone = $2 OR phone = $3)
        ORDER BY CASE WHEN phone = $2 THEN 0 ELSE 1 END, id
        LIMIT 1
        FOR UPDATE`,
      tid,
      requested,
      requested.replace(/\D/g, '').slice(-10),
    );
  }

  const patient = rows[0];
  if (!patient && allowMissing) return null;
  assertActivePatient(patient, tid);
  assertExpectedPhone(patient, expectedPhone, requirePhoneMatch);
  return patient;
}

export const __testing__ = { assertActivePatient, assertExpectedPhone };
