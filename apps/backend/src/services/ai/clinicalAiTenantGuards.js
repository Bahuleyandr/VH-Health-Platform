import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

function isMissingSchemaError(err) {
  return /does not exist|column .* does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

export function normalizePatientUid(patientUid, {
  errorCode = 'CLINICAL_AI_PATIENT_UID_INVALID',
} = {}) {
  const value = String(patientUid || '').trim();
  if (!value) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw AppError.badRequest('patient_uid must be a valid UUID', errorCode);
  }
  return value;
}

export async function assertPatientInTenant({
  tenantId,
  patientUid,
  invalidCode = 'CLINICAL_AI_PATIENT_UID_INVALID',
  notFoundCode = 'CLINICAL_AI_PATIENT_NOT_FOUND',
  roleInvalidCode = 'CLINICAL_AI_PATIENT_ROLE_INVALID',
  tenantMismatchCode = 'CLINICAL_AI_PATIENT_TENANT_MISMATCH',
  optional = false,
} = {}) {
  const uid = normalizePatientUid(patientUid, { errorCode: invalidCode });
  if (!uid && optional) return null;
  if (!uid) {
    throw AppError.badRequest('patient_uid is required', invalidCode);
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT uid, tenant_id, role
     FROM users
     WHERE uid = $1::uuid
     LIMIT 1`,
    uid,
  );
  const patient = rows[0];
  if (!patient) {
    throw AppError.notFound('Clinical AI patient not found', notFoundCode);
  }
  if (String(patient.role || '').toUpperCase() !== 'PATIENT') {
    throw AppError.badRequest(
      'patient_uid must reference a patient user',
      roleInvalidCode,
      { patient_uid: uid, role: patient.role || null },
    );
  }
  if (String(patient.tenant_id) !== String(tenantId)) {
    throw AppError.forbidden(
      'Clinical AI patient belongs to a different tenant',
      tenantMismatchCode,
      { patient_uid: uid, tenant_id: tenantId },
    );
  }
  return uid;
}

export function normalizeConsentReference(consentReference, {
  errorCode = 'CLINICAL_AI_CONSENT_REFERENCE_INVALID',
  required = true,
} = {}) {
  const value = String(consentReference || '').trim();
  if (!value) {
    if (!required) return null;
    throw AppError.badRequest('consent_reference is required', errorCode);
  }
  const match = value.match(/^(?:(?:patient_)?consents?:)?(\d+)$/i);
  if (!match) {
    throw AppError.badRequest('consent_reference must identify a patient_consents row', errorCode);
  }
  const id = Number.parseInt(match[1], 10);
  if (!Number.isFinite(id) || id < 1) {
    throw AppError.badRequest('consent_reference must identify a patient_consents row', errorCode);
  }
  return {
    id,
    reference: String(id),
  };
}

export async function assertPatientConsentInTenant({
  tenantId,
  patientUid,
  consentReference,
  allowedTypes = ['recording_consent', 'treatment'],
  referenceInvalidCode = 'CLINICAL_AI_CONSENT_REFERENCE_INVALID',
  notFoundCode = 'CLINICAL_AI_CONSENT_NOT_FOUND',
  patientMismatchCode = 'CLINICAL_AI_CONSENT_PATIENT_MISMATCH',
  tenantMismatchCode = 'CLINICAL_AI_CONSENT_TENANT_MISMATCH',
  typeInvalidCode = 'CLINICAL_AI_CONSENT_TYPE_INVALID',
  inactiveCode = 'CLINICAL_AI_CONSENT_INACTIVE',
  expiredCode = 'CLINICAL_AI_CONSENT_EXPIRED',
  schemaUnavailableCode = 'CLINICAL_AI_CONSENT_SCHEMA_UNAVAILABLE',
} = {}) {
  const uid = normalizePatientUid(patientUid);
  if (!uid) {
    throw AppError.badRequest('patient_uid is required');
  }
  const normalizedRef = normalizeConsentReference(consentReference, {
    errorCode: referenceInvalidCode,
  });
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT pc.id, pc.patient_uid, pc.consent_type, pc.granted, pc.status,
              pc.expires_at, u.tenant_id
       FROM patient_consents pc
       JOIN users u ON u.uid = pc.patient_uid
       WHERE pc.id = $1
       LIMIT 1`,
      normalizedRef.id,
    );
    const consent = rows[0];
    if (!consent) {
      throw AppError.notFound('Clinical AI consent reference not found', notFoundCode);
    }
    if (String(consent.patient_uid) !== uid) {
      throw AppError.forbidden(
        'Clinical AI consent reference belongs to a different patient',
        patientMismatchCode,
        { consent_reference: normalizedRef.reference, patient_uid: uid },
      );
    }
    if (String(consent.tenant_id) !== String(tenantId)) {
      throw AppError.forbidden(
        'Clinical AI consent reference belongs to a different tenant',
        tenantMismatchCode,
        { consent_reference: normalizedRef.reference, tenant_id: tenantId },
      );
    }
    const allowed = new Set((Array.isArray(allowedTypes) ? allowedTypes : []).map((type) => String(type).toLowerCase()));
    if (allowed.size && !allowed.has(String(consent.consent_type || '').toLowerCase())) {
      throw AppError.forbidden(
        'Clinical AI consent reference is not valid for this workflow',
        typeInvalidCode,
        { consent_reference: normalizedRef.reference, consent_type: consent.consent_type || null },
      );
    }
    if (consent.granted !== true || String(consent.status || '').toLowerCase() !== 'active') {
      throw AppError.forbidden(
        'Clinical AI consent reference is not active',
        inactiveCode,
        { consent_reference: normalizedRef.reference, status: consent.status || null },
      );
    }
    if (consent.expires_at && new Date(consent.expires_at).getTime() <= Date.now()) {
      throw AppError.forbidden(
        'Clinical AI consent reference has expired',
        expiredCode,
        { consent_reference: normalizedRef.reference },
      );
    }
    return {
      id: normalizedRef.id,
      reference: normalizedRef.reference,
      consentType: consent.consent_type,
      patientUid: uid,
      tenantId: String(consent.tenant_id),
      expiresAt: consent.expires_at || null,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (isMissingSchemaError(err)) {
      throw new AppError(
        'Clinical AI consent schema is unavailable',
        503,
        schemaUnavailableCode,
      );
    }
    throw err;
  }
}

export default {
  assertPatientInTenant,
  assertPatientConsentInTenant,
  normalizeConsentReference,
  normalizePatientUid,
};
