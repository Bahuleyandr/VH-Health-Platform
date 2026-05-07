// src/routes/clinical/dialysisRoutes.js — Sprint 22

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as svc from '../../services/clinical/dialysisService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';

const router = Router();

function tenantOf(req) {
  return req?.user?.tenantId || req?.tenant?.id ||
    '00000000-0000-4000-8000-000000000001';
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
router.post('/patients', requireStaffOrAdmin, wrap(async (req) =>
  svc.enrolPatient({ tenantId: tenantOf(req), ...req.body })));

router.get('/patients', requireStaffOrAdmin, wrap(async (req) =>
  svc.listPatients({
    tenantId: tenantOf(req),
    status: req.query.status, limit: req.query.limit,
  })));

router.get('/patients/:id', requireStaffOrAdmin, wrap(async (req) =>
  svc.getPatient({ tenantId: tenantOf(req), id: req.params.id })));

router.patch('/patients/:id/dry-weight', requireStaffOrAdmin, wrap(async (req) =>
  svc.updateDryWeight({
    tenantId: tenantOf(req), id: req.params.id,
    dry_weight_kg: req.body.dry_weight_kg,
  })));

// Vascular access
router.post('/patients/:id/access', requireStaffOrAdmin, wrap(async (req) =>
  svc.addAccess({ dialysis_patient_id: req.params.id, ...req.body })));

router.post('/access/:id/abandon', requireStaffOrAdmin, wrap(async (req) =>
  svc.abandonAccess({ id: req.params.id, reason: req.body.reason })));

// Sessions
router.post('/sessions', requireStaffOrAdmin, wrap(async (req) =>
  svc.scheduleSession({
    tenantId: tenantOf(req), conducted_by: req.user?.uid, ...req.body,
  })));

router.get('/sessions', requireStaffOrAdmin, wrap(async (req) =>
  svc.listSessions({
    tenantId: tenantOf(req),
    date: req.query.date, status: req.query.status,
    dialysis_patient_id: req.query.dialysis_patient_id,
    limit: req.query.limit,
  })));

router.get('/today', requireStaffOrAdmin, wrap(async (req) =>
  svc.todayBoard({ tenantId: tenantOf(req) })));

router.post('/sessions/:id/start', requireStaffOrAdmin, wrap(async (req) =>
  svc.startSession({
    tenantId: tenantOf(req), id: req.params.id, ...req.body,
  })));

router.post('/sessions/:id/complete', requireStaffOrAdmin, wrap(async (req) =>
  svc.completeSession({
    tenantId: tenantOf(req), id: req.params.id, ...req.body,
  })));

router.post('/sessions/:id/cancel', requireStaffOrAdmin, wrap(async (req) =>
  svc.cancelSession({
    tenantId: tenantOf(req), id: req.params.id,
    reason: req.body.reason, mark_no_show: req.body.mark_no_show,
  })));

// Intra-dialysis observations
router.post('/sessions/:id/obs', requireStaffOrAdmin, wrap(async (req) =>
  svc.logObservation({
    session_id: req.params.id, recorded_by: req.user?.uid, ...req.body,
  })));

router.get('/sessions/:id/obs', requireStaffOrAdmin, wrap(async (req) =>
  svc.listObservations({ session_id: req.params.id })));

// Serology
router.post('/patients/:id/serology', requireStaffOrAdmin, wrap(async (req) =>
  svc.recordSerology({
    dialysis_patient_id: req.params.id, reported_by: req.user?.uid, ...req.body,
  })));

export default router;
