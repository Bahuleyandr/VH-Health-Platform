// src/routes/oncology/oncologyRoutes.js
//
// Roadmap D1 — oncology/chemo foundations. Mounted at /api/v1/oncology
// (app.js) behind clinical-staff RBAC + PHI logging. Protocol/plan
// management is doctor/leadership-gated; verification + administration are
// nurse-level actions with the two-person guard enforced in the service.

import express from 'express';
import logger from '../../logging/logger.js';
import {
  createProtocol,
  activateProtocol,
  getProtocol,
  listProtocols,
  createTreatmentPlan,
  scheduleCycle,
  verifyAdministration,
  recordChemoAdministration,
  withholdAdministration,
  getPatientCumulative,
  getPlanDetail,
} from '../../services/oncology/chemoService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { isAdmin, isLeadership, isDoctor } from '../../utils/roleHelpers.js';

const router = express.Router();

const canManage = (role) => isAdmin(role) || isLeadership(role) || isDoctor(role) || role === 'SUPER_ADMIN';

function handleFailure(res, err, context) {
  if (err instanceof AppError) {
    return error(res, err.message, err.statusCode, err.details ?? { code: err.code });
  }
  logger.error(`Oncology ${context} failed:`, err);
  return error(res, `Failed to ${context}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

const ctx = (req) => ({ actorUid: req.user?.uid || null, actorRole: req.user?.role || null });
const tenantOf = (req) => req?.user?.tenantId || req?.tenant?.id || null;

// ── protocols ───────────────────────────────────────────────────────────

router.post('/protocols', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership manage chemo protocols', HTTP_STATUS.FORBIDDEN);
    const protocol = await createProtocol({
      tenantId: tenantOf(req),
      code: req.body.code,
      name: req.body.name,
      indication: req.body.indication || null,
      cycleLengthDays: req.body.cycle_length_days,
      totalCycles: req.body.total_cycles || 1,
      reference: req.body.reference || null,
      drugs: req.body.drugs || [],
    }, ctx(req));
    return success(res, { protocol }, 'Protocol created (draft)', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create protocol');
  }
});

router.get('/protocols', async (req, res) => {
  try {
    const protocols = await listProtocols({
      tenantId: tenantOf(req),
      status: req.query.status || null,
    });
    return success(res, { protocols, count: protocols.length }, 'Chemo protocols');
  } catch (err) {
    return handleFailure(res, err, 'list protocols');
  }
});

router.get('/protocols/:id', async (req, res) => {
  try {
    const protocol = await getProtocol(req.params.id, { tenantId: tenantOf(req) });
    return success(res, { protocol }, 'Chemo protocol');
  } catch (err) {
    return handleFailure(res, err, 'get protocol');
  }
});

router.post('/protocols/:id/activate', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership activate protocols', HTTP_STATUS.FORBIDDEN);
    const protocol = await activateProtocol(req.params.id, { tenantId: tenantOf(req) });
    return success(res, { protocol }, 'Protocol activated');
  } catch (err) {
    return handleFailure(res, err, 'activate protocol');
  }
});

// ── treatment plans + cycles ────────────────────────────────────────────

router.post('/protocols/:id/plans', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership create treatment plans', HTTP_STATUS.FORBIDDEN);
    const plan = await createTreatmentPlan(req.params.id, {
      tenantId: tenantOf(req),
      patientUid: req.body.patient_uid,
      indication: req.body.indication || null,
      plannedCycles: req.body.planned_cycles || null,
      consentRef: req.body.consent_ref || null,
      heightCm: req.body.height_cm ?? null,
      weightKg: req.body.weight_kg ?? null,
      startDate: req.body.start_date || null,
    }, ctx(req));
    return success(res, { plan }, 'Treatment plan created', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'create treatment plan');
  }
});

router.get('/plans/:id', async (req, res) => {
  try {
    const plan = await getPlanDetail(req.params.id, { tenantId: tenantOf(req) });
    return success(res, { plan }, 'Treatment plan');
  } catch (err) {
    return handleFailure(res, err, 'get treatment plan');
  }
});

router.post('/plans/:id/cycles', async (req, res) => {
  try {
    if (!canManage(req.user?.role)) return error(res, 'Only doctors/leadership schedule cycles', HTTP_STATUS.FORBIDDEN);
    const result = await scheduleCycle(req.params.id, {
      tenantId: tenantOf(req),
      cycleNumber: req.body.cycle_number,
      scheduledDate: req.body.scheduled_date,
      weightKg: req.body.weight_kg ?? null,
      doseReductions: req.body.dose_reductions || {},
      ceilingOverrideReason: req.body.ceiling_override_reason || null,
    }, ctx(req));
    return success(res, result, 'Cycle scheduled', HTTP_STATUS.CREATED);
  } catch (err) {
    return handleFailure(res, err, 'schedule cycle');
  }
});

// ── administration loop ─────────────────────────────────────────────────

router.post('/administrations/:id/verify', async (req, res) => {
  try {
    const verification = await verifyAdministration(req.params.id, {
      tenantId: tenantOf(req),
      verifierRole: req.body.verifier_role,
      scannedPatientUid: req.body.scanned_patient_uid || null,
    }, ctx(req));
    return success(res, { verification }, 'Verification recorded');
  } catch (err) {
    return handleFailure(res, err, 'verify administration');
  }
});

router.post('/administrations/:id/administer', async (req, res) => {
  try {
    const administration = await recordChemoAdministration(req.params.id, {
      tenantId: tenantOf(req),
      ...ctx(req),
    });
    return success(res, { administration }, 'Chemo administration recorded');
  } catch (err) {
    return handleFailure(res, err, 'record administration');
  }
});

router.post('/administrations/:id/withhold', async (req, res) => {
  try {
    const administration = await withholdAdministration(req.params.id, {
      tenantId: tenantOf(req),
      reason: req.body.reason,
    }, ctx(req));
    return success(res, { administration }, 'Administration withheld');
  } catch (err) {
    return handleFailure(res, err, 'withhold administration');
  }
});

// ── cumulative dose view ────────────────────────────────────────────────

router.get('/patients/:uid/cumulative', async (req, res) => {
  try {
    const cumulative = await getPatientCumulative(req.params.uid, { tenantId: tenantOf(req) });
    return success(res, { cumulative, count: cumulative.length }, 'Cumulative chemo doses');
  } catch (err) {
    return handleFailure(res, err, 'get cumulative doses');
  }
});

export default router;
