// src/routes/clinical/cathLabAccessGuards.js
//
// Re-audit M: the /api/v1/cath-lab mount used to wrap cathLabRoutes (and the
// cathSchedulingRoutes subrouter it mounts) in
// patientAccessGuard('CLINICAL_WORKFLOW'), which ran before Express matched a
// route, saw an empty req.params, and returned no_patient_context without
// ever evaluating a policy. The guard now lives per route in BOTH routers,
// with selectors that resolve the exact case/report row the handler serves.
// This module is shared by the two routers (cathLabRoutes imports
// cathSchedulingRoutes, so the scheduling router cannot import from
// cathLabRoutes without a cycle).

import prisma from '../../lib/prisma.js';
import {
  positiveBigIntTextOrNull,
  routePatientGuard,
  selectorTenantOf,
} from '../../middleware/routePatientAccessGuards.js';

const CATH_RECORD_TYPE = 'CLINICAL_WORKFLOW';

// The cath_lab_cases row a /cases/:id* (or /cases/:caseId*) handler loads —
// same id shape (bigint) and tenant predicate as the service's caseById.
export async function selectCathCasePatient(req, rawCaseId) {
  const tenantId = selectorTenantOf(req);
  const caseId = positiveBigIntTextOrNull(rawCaseId);
  if (tenantId == null || caseId == null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid AS uid
       FROM cath_lab_cases
      WHERE tenant_id = $1::uuid AND id = $2::bigint
      LIMIT 1`,
    tenantId,
    caseId,
  );
  return rows[0] ?? null;
}

// The cath_procedure_reports row a /reports/:id* handler loads — the report
// row carries its own patient_uid (stamped from the case at creation).
export async function selectCathReportPatient(req, rawReportId) {
  const tenantId = selectorTenantOf(req);
  const reportId = positiveBigIntTextOrNull(rawReportId);
  if (tenantId == null || reportId == null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid AS uid
       FROM cath_procedure_reports
      WHERE tenant_id = $1::uuid AND id = $2::bigint
      LIMIT 1`,
    tenantId,
    reportId,
  );
  return rows[0] ?? null;
}

/** Guard for routes whose case id lives in req.params[paramName]. */
export function cathCaseGuard(paramName) {
  return routePatientGuard(CATH_RECORD_TYPE, {
    tag: `cath-lab:case-param:${paramName}`,
    patientSelector: (req) => selectCathCasePatient(req, req.params?.[paramName]),
  });
}

/** Guard for /reports/:id* routes. */
export function cathReportGuard() {
  return routePatientGuard(CATH_RECORD_TYPE, {
    tag: 'cath-lab:report-param',
    patientSelector: (req) => selectCathReportPatient(req, req.params?.id),
  });
}

/**
 * Guard for POST /cases — the case is created FOR body.patient_uid (the value
 * createCase persists after its own tenant-scoped patient check);
 * resolvePatientForAccess verifies it against the tenant's users table.
 */
export function cathCaseCreateGuard() {
  return routePatientGuard(CATH_RECORD_TYPE, {
    tag: 'cath-lab:body-patient-uid',
    patientSelector: (req) => ({ uid: req.body?.patient_uid ?? req.body?.patientUid }),
  });
}
