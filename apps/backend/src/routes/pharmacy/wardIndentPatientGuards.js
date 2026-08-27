import prisma from '../../lib/prisma.js';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import {
  positiveIntOrNull,
  selectorTenantOf,
} from '../../middleware/routePatientAccessGuards.js';

function guard(patientSelector, { requirePatientContext = false, tag } = {}) {
  const middleware = patientAccessGuard('PHARMACY_ORDER', {
    careTeamModeGoverned: true,
    patientSelector,
    ...(requirePatientContext ? { requirePatientContext: true } : {}),
  });
  middleware.__patientGuard = Object.freeze({
    recordType: 'PHARMACY_ORDER',
    careTeamModeGoverned: true,
    requirePatientContext,
    hasSelector: true,
    tag,
  });
  return middleware;
}

async function admissionPatient(req, admissionId) {
  const id = positiveIntOrNull(admissionId);
  const tenantId = selectorTenantOf(req);
  if (id == null || !tenantId) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient.id, patient.uid
       FROM admissions admission
       JOIN users patient
         ON patient.tenant_id = admission.tenant_id
        AND patient.uid = admission.patient_uid
        AND patient.role = 'PATIENT'
      WHERE admission.tenant_id = $1::uuid
        AND admission.id = $2::int
      LIMIT 1`,
    tenantId,
    id,
  );
  return rows[0] ?? null;
}

export function selectWardIndentPatient(readIndentId) {
  return async (req) => {
    const indentId = positiveIntOrNull(readIndentId(req));
    const tenantId = selectorTenantOf(req);
    if (indentId == null || !tenantId) return null;
    const rows = await prisma.$queryRawUnsafe(
    `SELECT patient.id, patient.uid
       FROM ward_indents indent
       LEFT JOIN admissions admission
         ON admission.tenant_id = indent.tenant_id
        AND admission.id = indent.admission_id
       JOIN users patient
         ON patient.tenant_id = indent.tenant_id
        AND patient.uid = COALESCE(indent.patient_uid, admission.patient_uid)
          AND patient.role = 'PATIENT'
        WHERE indent.tenant_id = $1::uuid
          AND indent.id = $2::int
        LIMIT 1`,
      tenantId,
      indentId,
    );
    return rows[0] ?? null;
  };
}

export async function selectWardIndentCreatePatient(req) {
  const admissionId = req.body?.admission_id ?? req.body?.admissionId;
  if (admissionId != null && admissionId !== '') {
    return admissionPatient(req, admissionId);
  }
  const uid = req.body?.patient_uid ?? req.body?.patientUid;
  return uid == null || uid === '' ? null : { uid };
}

export async function selectWardIndentListPatient(req) {
  const admissionId = req.query?.admission_id ?? req.query?.admissionId;
  if (admissionId != null && admissionId !== '') {
    return admissionPatient(req, admissionId);
  }
  const uid = req.query?.patient_uid ?? req.query?.patientUid;
  return uid == null || uid === '' ? null : { uid };
}

export function wardIndentCreateGuard() {
  return guard(selectWardIndentCreatePatient, { tag: 'ward-indent-create' });
}

export function wardIndentListGuard() {
  return guard(selectWardIndentListPatient, { tag: 'ward-indent-list' });
}

export function wardIndentAdmissionGuard(readAdmissionId) {
  return guard((req) => admissionPatient(req, readAdmissionId(req)), {
    requirePatientContext: true,
    tag: 'ward-indent-admission',
  });
}

export function wardIndentRowGuard(readIndentId) {
  return guard(selectWardIndentPatient(readIndentId), { tag: 'ward-indent-row' });
}
