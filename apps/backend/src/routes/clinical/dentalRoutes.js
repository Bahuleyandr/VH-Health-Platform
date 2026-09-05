// src/routes/clinical/dentalRoutes.js
//
// Roadmap D7 — dental charting. Mounted at /api/v1/dental (app.js) behind
// clinical-staff RBAC + PHI logging.

import express from 'express';
import {
  recordToothFinding,
  resolveFinding,
  getChart,
  planProcedure,
  completeProcedure,
  cancelProcedure,
  listProcedures,
} from '../../services/clinical/dentalService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, relayAppError } from '../../utils/responseHelper.js';

import { patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessPolicyRegistry.js';

import { routePatientGuard } from '../../middleware/routePatientAccessGuards.js';

const router = express.Router();

// Per-route patient guard. The mount-level patientAccessGuard could never
// decide this route: mount middleware runs before Express binds the path
// param, so it saw req.params = {} and returned no_patient_context without
// evaluating a policy. routePatientAccessGuards.js carries the full
// rationale, the selector contract and the shadow-mode posture.
//
// One guard serves both reads below: they take the same :uid and are about
// the same subject, so splitting them would only duplicate the selector.
const guardDentalPatientView = routePatientGuard('CLINICAL_WORKFLOW', {
  tag: 'dental:patient-uid-param',
  patientSelector: (req) => ({ uid: req.params?.uid }),
});


// These three transitions mutate a named patient's dental record under a
// FINDING or PROCEDURE id. The mount guard cannot see :id, so no
// patient-access policy has ever run on them; the rest of the chain is a
// different axis (requireRole is role-scoped, specialtyDepartmentGuard is
// department-scoped, phiAccessLogger is a passive writer).
//
// dental_procedures.id and dental_tooth_findings.id are SEPARATE identity
// sequences — procedure #7 and finding #7 can be different patients — so
// these are two distinct guards and must not be merged.
const guardDentalFindingWrite = patientAccessGuardForResource('CLINICAL_WORKFLOW', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  resourceType: 'dental_finding',
  idParam: 'id',
  careTeamModeGoverned: true,
});
const guardDentalProcedureWrite = patientAccessGuardForResource('CLINICAL_WORKFLOW', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  resourceType: 'dental_procedure',
  idParam: 'id',
  careTeamModeGoverned: true,
});

function handleFailure(res, err, context) {
  return relayAppError(res, err, `Failed to ${context}`);
}

const ctx = (req) => ({ actorUid: req.user?.uid || null, actorRole: req.user?.role || null });
const tenantOf = (req) => req?.user?.tenantId || req?.tenant?.id || null;

router.post('/findings', async (req, res) => {
  try {
    const finding = await recordToothFinding({
      tenantId: tenantOf(req),
      patientUid: req.body.patient_uid,
      toothFdi: req.body.tooth_fdi,
      surface: req.body.surface || null,
      finding: req.body.finding,
      severity: req.body.severity || null,
      notes: req.body.notes || null,
    }, ctx(req));
    return success(res, { finding }, 'Tooth finding recorded', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'record tooth finding');
  }
});

router.post('/findings/:id/resolve', guardDentalFindingWrite, async (req, res) => {
  try {
    const finding = await resolveFinding(req.params.id, {
      tenantId: tenantOf(req),
      resolutionNote: req.body.resolution_note,
    }, ctx(req));
    return success(res, { finding }, 'Finding resolved');
  } catch (err) {
    return handleFailure(res, err, 'resolve finding');
  }
});

router.get('/patients/:uid/chart', guardDentalPatientView, async (req, res) => {
  try {
    const chart = await getChart(req.params.uid, { tenantId: tenantOf(req) });
    return success(res, { chart }, 'Dental chart');
  } catch (err) {
    return handleFailure(res, err, 'get dental chart');
  }
});

router.post('/procedures', async (req, res) => {
  try {
    const procedure = await planProcedure({
      tenantId: tenantOf(req),
      patientUid: req.body.patient_uid,
      toothFdi: req.body.tooth_fdi || null,
      surface: req.body.surface || null,
      findingId: req.body.finding_id || null,
      procedureName: req.body.procedure_name,
      procedureCode: req.body.procedure_code || null,
      anesthesia: req.body.anesthesia || null,
      notes: req.body.notes || null,
    }, ctx(req));
    return success(res, { procedure }, 'Procedure planned', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'plan procedure');
  }
});

router.post('/procedures/:id/complete', guardDentalProcedureWrite, async (req, res) => {
  try {
    const procedure = await completeProcedure(req.params.id, {
      tenantId: tenantOf(req),
      materials: req.body.materials || null,
      anesthesia: req.body.anesthesia || null,
      notes: req.body.notes || null,
    }, ctx(req));
    return success(res, { procedure }, 'Procedure completed');
  } catch (err) {
    return handleFailure(res, err, 'complete procedure');
  }
});

router.post('/procedures/:id/cancel', guardDentalProcedureWrite, async (req, res) => {
  try {
    const procedure = await cancelProcedure(req.params.id, {
      tenantId: tenantOf(req),
      reason: req.body.reason,
    }, ctx(req));
    return success(res, { procedure }, 'Procedure cancelled');
  } catch (err) {
    return handleFailure(res, err, 'cancel procedure');
  }
});

router.get('/patients/:uid/procedures', guardDentalPatientView, async (req, res) => {
  try {
    const procedures = await listProcedures(req.params.uid, {
      tenantId: tenantOf(req),
      status: req.query.status || null,
    });
    return success(res, { procedures, count: procedures.length }, 'Dental procedures');
  } catch (err) {
    return handleFailure(res, err, 'list procedures');
  }
});

export default router;
