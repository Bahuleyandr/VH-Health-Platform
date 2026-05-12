// src/routes/clinical/icuRoutes.js — Sprint 19

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as icu from '../../services/clinical/icuService.js';
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
      // AppError-shaped errors are intentionally surfaced (badRequest /
      // notFound / forbidden carry safe, caller-targeted messages).
      // Anything else is logged server-side and returned as a generic
      // 500 — raw `err.message` from Prisma / pg leaks SQL fragments,
      // bind-parameter shapes, and schema details. Security checklist.
      if (err.statusCode) return error(res, err.message, err.statusCode);
      logger.error('icu route error:', err);
      return error(res, 'An internal server error occurred. Please try again later.', 500);
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// Admissions
router.post('/admissions', requireStaffOrAdmin, wrap(async (req) =>
  icu.createAdmission({ tenantId: tenantOf(req), ...req.body })));

router.get('/admissions', requireStaffOrAdmin, wrap(async (req) =>
  icu.listAdmissions({
    tenantId: tenantOf(req),
    status: req.query.status,
    unit_code: req.query.unit_code,
    limit: req.query.limit,
  })));

router.get('/admissions/:id', requireStaffOrAdmin, wrap(async (req) =>
  icu.getAdmission({ tenantId: tenantOf(req), id: req.params.id })));

router.patch('/admissions/:id/code-status', requireStaffOrAdmin, wrap(async (req) =>
  icu.updateAdmissionCodeStatus({
    tenantId: tenantOf(req), id: req.params.id,
    code_status: req.body.code_status, set_by: req.user?.uid,
  })));

router.patch('/admissions/:id/monitoring-interval', requireStaffOrAdmin, wrap(async (req) =>
  icu.updateMonitoringInterval({
    tenantId: tenantOf(req), id: req.params.id,
    monitoring_interval_minutes: req.body.monitoring_interval_minutes,
  })));

router.post('/admissions/:id/discharge', requireStaffOrAdmin, wrap(async (req) =>
  icu.dischargeAdmission({
    tenantId: tenantOf(req), id: req.params.id,
    disposition: req.body.disposition, outcome_notes: req.body.outcome_notes,
  })));

// Flowsheet
router.post('/admissions/:id/flowsheet', requireStaffOrAdmin, wrap(async (req) =>
  icu.logFlowsheet({
    tenantId: tenantOf(req),
    icu_admission_id: req.params.id,
    recorded_by: req.user?.uid,
    ...req.body,
  })));

router.get('/admissions/:id/flowsheet', requireStaffOrAdmin, wrap(async (req) =>
  icu.listFlowsheet({
    icu_admission_id: req.params.id, hours: req.query.hours,
  })));

router.get('/admissions/:id/io-summary', requireStaffOrAdmin, wrap(async (req) =>
  icu.ioSummary({ icu_admission_id: req.params.id })));

// Assessments
router.post('/admissions/:id/assessments', requireStaffOrAdmin, wrap(async (req) =>
  icu.recordAssessment({
    tenantId: tenantOf(req),
    icu_admission_id: req.params.id,
    recorded_by: req.user?.uid,
    ...req.body,
  })));

router.get('/admissions/:id/assessments', requireStaffOrAdmin, wrap(async (req) =>
  icu.listAssessments({
    icu_admission_id: req.params.id,
    kind: req.query.kind, limit: req.query.limit,
  })));

// ABCDEF Bundle
router.post('/admissions/:id/bundle', requireStaffOrAdmin, wrap(async (req) =>
  icu.upsertBundle({
    tenantId: tenantOf(req),
    icu_admission_id: req.params.id,
    recorded_by: req.user?.uid,
    ...req.body,
  })));

router.get('/admissions/:id/bundle', requireStaffOrAdmin, wrap(async (req) =>
  icu.getBundle({
    icu_admission_id: req.params.id, bundle_date: req.query.bundle_date,
  })));

router.get('/bundle-compliance', requireStaffOrAdmin, wrap(async (req) =>
  icu.bundle30dCompliance({ tenantId: tenantOf(req) })));

export default router;
