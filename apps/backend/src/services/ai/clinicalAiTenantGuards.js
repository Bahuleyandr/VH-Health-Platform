import prisma from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';

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

export default {
  assertPatientInTenant,
  normalizePatientUid,
};
