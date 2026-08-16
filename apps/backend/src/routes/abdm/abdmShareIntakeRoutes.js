// src/routes/abdm/abdmShareIntakeRoutes.js
//
// Front-desk surface for ABDM Scan & Share intakes (migration 702), mounted at
// /api/v1/front-desk/abdm/share-intakes behind patient-registry write RBAC and
// phiAccessLogger('ABDM') — the shared profile is patient demographics (PHI).
//
// Work item lifecycle actions:
//   match      → attach the intake to an EXISTING patient
//   register   → drive the guarded front-desk registration flow with the
//                shared profile prefilled (409 PATIENT_DUPLICATE_REVIEW_REQUIRED
//                until reviewed/overridden with an audited reason)
//   link-visit → attach an existing OP appointment
//   dismiss    → close the intake without action
//
// Registration/match are identity writes: front-desk audit rows (logAudit),
// no clinical_timeline_events row.

import { Router } from 'express';
import { markRouterDomain } from '../../config/openapiDomain.js';
import logger from '../../logging/logger.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { PATIENT_REGISTRY_WRITE_ROLES } from '../../config/patientAccessRoles.js';
import {
  dismissShareIntake,
  getShareIntake,
  linkVisitToIntake,
  listShareIntakes,
  matchShareIntake,
  registerFromShareIntake,
} from '../../services/abdm/abdmShareIntakeService.js';
import { logAudit } from '../../utils/logAudit.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';

const router = Router();
markRouterDomain(router, 'abdm');
router.use(requireRole(...PATIENT_REGISTRY_WRITE_ROLES));

function handle(label, run) {
  return async (req, res, next) => {
    try {
      return await run(req, res);
    } catch (err) {
      if (err.isOperational) {
        return relayAppError(res, err, label);
      }
      logger.error(label, { error: err.message });
      return next(err);
    }
  };
}

function intakeId(req, res) {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    error(res, 'A numeric intake id is required', 400);
    return null;
  }
  return id;
}

router.get('/', handle('Failed to list ABDM share intakes', async (req, res) => {
  const result = await listShareIntakes({
    tenantId: req.tenantId,
    status: req.query?.status || null,
    limit: req.query?.limit,
    offset: req.query?.offset,
  });
  return success(res, result, 'Share intakes retrieved', 200);
}));

router.get('/:id', handle('Failed to get ABDM share intake', async (req, res) => {
  const id = intakeId(req, res);
  if (id === null) return undefined;
  const intake = await getShareIntake({ tenantId: req.tenantId, intakeId: id });
  return success(res, { intake }, 'Share intake retrieved', 200);
}));

router.post('/:id/match', handle('Failed to match ABDM share intake', async (req, res) => {
  const id = intakeId(req, res);
  if (id === null) return undefined;
  const intake = await matchShareIntake({
    tenantId: req.tenantId,
    intakeId: id,
    patientUid: req.body?.patient_uid ?? req.body?.patientUid,
    actorUid: req.user?.uid,
  });
  req.phiContext = { ...(req.phiContext || {}), patientUid: intake.matched_patient_uid };
  await logAudit(req, 'ABDM_SHARE_INTAKE_MATCHED', {
    intake_id: intake.id,
    patient_uid: intake.matched_patient_uid,
  }, { resource: 'abdm_share_intake', resourceId: String(intake.id) });
  return success(res, { intake }, 'Share intake matched', 200);
}));

router.post('/:id/register', handle('Failed to register patient from ABDM share intake', async (req, res) => {
  const id = intakeId(req, res);
  if (id === null) return undefined;
  const body = req.body || {};
  const result = await registerFromShareIntake({
    tenantId: req.tenantId,
    intakeId: id,
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    overrides: {
      name: body.name,
      phone: body.phone,
      gender: body.gender,
      birthday: body.birthday,
      address: body.address,
    },
    overrideReason: body.duplicate_override_reason ?? body.create_anyway_reason ?? '',
    requestId: req.id,
    ip: req.ip,
    userAgent: req.get?.('user-agent') || null,
  });
  req.phiContext = { ...(req.phiContext || {}), patientUid: result.patient.uid };
  await logAudit(req, 'FRONT_OFFICE_PATIENT_CREATED', {
    patient_uid: result.patient.uid,
    source: 'abdm_scan_and_share',
    intake_id: id,
    duplicate_override: result.duplicate_override,
    abha_link_status: result.abha_link?.verification_status ?? null,
    abha_link_error: result.abha_link_error,
  }, { resource: 'patient', resourceId: String(result.patient.uid) });
  return success(res, result, 'Patient registered from share intake', 201);
}));

router.post('/:id/link-visit', handle('Failed to link visit to ABDM share intake', async (req, res) => {
  const id = intakeId(req, res);
  if (id === null) return undefined;
  const intake = await linkVisitToIntake({
    tenantId: req.tenantId,
    intakeId: id,
    appointmentId: req.body?.appointment_id ?? req.body?.appointmentId,
    actorUid: req.user?.uid,
  });
  await logAudit(req, 'ABDM_SHARE_INTAKE_VISIT_LINKED', {
    intake_id: intake.id,
    appointment_id: intake.linked_appointment_id,
    patient_uid: intake.matched_patient_uid,
  }, { resource: 'abdm_share_intake', resourceId: String(intake.id) });
  return success(res, { intake }, 'Visit linked to share intake', 200);
}));

router.post('/:id/dismiss', handle('Failed to dismiss ABDM share intake', async (req, res) => {
  const id = intakeId(req, res);
  if (id === null) return undefined;
  const intake = await dismissShareIntake({
    tenantId: req.tenantId,
    intakeId: id,
    actorUid: req.user?.uid,
    reason: req.body?.reason ?? null,
  });
  await logAudit(req, 'ABDM_SHARE_INTAKE_DISMISSED', {
    intake_id: intake.id,
    reason: req.body?.reason ?? null,
  }, { resource: 'abdm_share_intake', resourceId: String(intake.id) });
  return success(res, { intake }, 'Share intake dismissed', 200);
}));

export default router;
