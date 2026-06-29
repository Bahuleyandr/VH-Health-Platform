// src/routes/clinical/dialysisRoutes.js — Sprint 22 + roadmap D7 depth

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as svc from '../../services/clinical/dialysisService.js';
import { ingestMachineObservations } from '../../services/clinical/dialysisMachineService.js';
import { success, error } from '../../utils/responseHelper.js';
import { AppError } from '../../utils/AppError.js';
import { isAdmin, isStaff, isDoctor } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { emitDialysisEvent } from '../../utils/websocket/realtimeEmitter.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      if (err.statusCode) return error(res, err.message, err.statusCode);
      logger.error('dialysis route error:', err);
      return error(res, err.message || 'Dialysis error', 500);
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// Patients
router.post('/patients', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.enrolPatient({ tenantId, ...req.body });
  emitDialysisEvent('patient-enrolled', { tenantId });
  return row;
}));

router.get('/patients', requireStaffOrAdmin, wrap(async (req) =>
  svc.listPatients({
    tenantId: tenantOf(req),
    status: req.query.status, limit: req.query.limit,
  })));

router.get('/patients/:id', requireStaffOrAdmin, wrap(async (req) =>
  svc.getPatient({ tenantId: tenantOf(req), id: req.params.id })));

router.patch('/patients/:id/dry-weight', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.updateDryWeight({
    tenantId, id: req.params.id,
    dry_weight_kg: req.body.dry_weight_kg,
  });
  emitDialysisEvent('dry-weight-updated', { tenantId });
  return row;
}));

// Prescriptions (roadmap D7) — the standing order sessions inherit from.
router.post('/patients/:id/prescription', requireStaffOrAdmin, wrap(async (req) => {
  if (!isDoctor(req.user?.role) && !isAdmin(req.user?.role)) {
    throw AppError.forbidden('Only doctors/admin prescribe dialysis');
  }
  const tenantId = tenantOf(req);
  const row = await svc.prescribe({
    tenantId, dialysis_patient_id: req.params.id,
    prescribed_by: req.user?.uid, ...req.body,
  });
  emitDialysisEvent('prescription-created', { tenantId });
  return row;
}));

router.get('/patients/:id/prescription', requireStaffOrAdmin, wrap(async (req) =>
  svc.getPrescriptions({ tenantId: tenantOf(req), dialysis_patient_id: req.params.id })));

// Vascular access
router.post('/patients/:id/access', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.addAccess({
    tenantId,
    dialysis_patient_id: req.params.id,
    ...req.body,
  });
  emitDialysisEvent('access-created', { tenantId });
  return row;
}));

router.post('/access/:id/abandon', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.abandonAccess({
    tenantId,
    id: req.params.id,
    reason: req.body.reason,
  });
  emitDialysisEvent('access-abandoned', { tenantId });
  return row;
}));

// Sessions
router.post('/sessions', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.scheduleSession({
    tenantId, conducted_by: req.user?.uid, ...req.body,
  });
  emitDialysisEvent('session-scheduled', { tenantId });
  return row;
}));

router.get('/sessions', requireStaffOrAdmin, wrap(async (req) =>
  svc.listSessions({
    tenantId: tenantOf(req),
    date: req.query.date, status: req.query.status,
    dialysis_patient_id: req.query.dialysis_patient_id,
    limit: req.query.limit,
  })));

router.get('/today', requireStaffOrAdmin, wrap(async (req) =>
  svc.todayBoard({ tenantId: tenantOf(req) })));

router.post('/sessions/:id/start', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.startSession({
    tenantId, id: req.params.id, ...req.body,
  });
  emitDialysisEvent('session-started', { tenantId });
  return row;
}));

router.post('/sessions/:id/complete', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.completeSession({
    tenantId, id: req.params.id, ...req.body,
  });
  emitDialysisEvent('session-completed', { tenantId });
  return row;
}));

router.post('/sessions/:id/cancel', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.cancelSession({
    tenantId, id: req.params.id,
    reason: req.body.reason, mark_no_show: req.body.mark_no_show,
  });
  emitDialysisEvent('session-cancelled', { tenantId });
  return row;
}));

// Intra-dialysis observations
router.post('/sessions/:id/obs', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.logObservation({
    tenantId, session_id: req.params.id, recorded_by: req.user?.uid, ...req.body,
  });
  emitDialysisEvent('observation-logged', { tenantId });
  return row;
}));

router.get('/sessions/:id/obs', requireStaffOrAdmin, wrap(async (req) =>
  svc.listObservations({ tenantId: tenantOf(req), session_id: req.params.id })));

// Structured complications (roadmap D7)
router.post('/sessions/:id/events', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.recordSessionEvent({
    tenantId, session_id: req.params.id,
    recorded_by: req.user?.uid, actorRole: req.user?.role, ...req.body,
  });
  emitDialysisEvent('session-event-recorded', { tenantId });
  return row;
}));

router.get('/sessions/:id/events', requireStaffOrAdmin, wrap(async (req) =>
  svc.listSessionEvents({ tenantId: tenantOf(req), session_id: req.params.id })));

// Machine-data ingestion (roadmap D7) — raw payloads hit the B3 inbox
// first; observations land source='device' on the in-progress session
// matched by machine_no. Mirrors C5 /devices/vitals/ingest.
router.post('/machines/ingest', requireStaffOrAdmin, wrap(async (req, res) => {
  const result = await ingestMachineObservations({
    payload: req.body,
    machineCode: req.body.machine_no || req.query.machine_no || null,
    tenantId: tenantOf(req),
  }, { actorUid: req.user?.uid || null });
  return success(res, result, 'Dialysis machine observations ingested', 201);
}));

// Serology
router.post('/patients/:id/serology', requireStaffOrAdmin, wrap(async (req) => {
  const tenantId = tenantOf(req);
  const row = await svc.recordSerology({
    tenantId, dialysis_patient_id: req.params.id, reported_by: req.user?.uid, ...req.body,
  });
  emitDialysisEvent('serology-recorded', { tenantId });
  return row;
}));

export default router;
