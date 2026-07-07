// src/routes/clinical/deathCertificationRoutes.js — Sprint 21

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as svc from '../../services/clinical/deathCertificationService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';

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
      logger.error('death-certification route error:', err);
      return error(res, err.message || 'Death certification error', 500);
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// Death records
router.post('/records', requireStaffOrAdmin, wrap(async (req) =>
  svc.createDeathRecord({ tenantId: tenantOf(req), ...req.body })));

router.get('/records', requireStaffOrAdmin, wrap(async (req) =>
  svc.listDeathRecords({
    tenantId: tenantOf(req),
    status: req.query.status, from: req.query.from, to: req.query.to,
    is_medicolegal: req.query.is_medicolegal,
    limit: req.query.limit,
  })));

router.get('/records/:id', requireStaffOrAdmin, wrap(async (req) =>
  svc.getDeathRecord({ tenantId: tenantOf(req), id: req.params.id })));

router.post('/records/:id/transition', requireStaffOrAdmin, wrap(async (req) =>
  svc.transition({
    tenantId: tenantOf(req), id: req.params.id,
    certified_by: req.user?.uid,
    ...req.body,
  })));

router.post('/records/:id/body-release', requireStaffOrAdmin, wrap(async (req) =>
  svc.recordBodyRelease({
    tenantId: tenantOf(req), id: req.params.id,
    body_release_witnessed_by: req.user?.uid,
    ...req.body,
  })));

router.post('/records/:id/police-clearance', requireStaffOrAdmin, wrap(async (req) =>
  svc.recordPoliceClearance({
    tenantId: tenantOf(req), id: req.params.id, ...req.body,
  })));

// Mortuary custody
router.get('/mortuary/board', requireStaffOrAdmin, wrap(async (req) =>
  svc.mortuaryBoard({ tenantId: tenantOf(req) })));

router.get('/mortuary/slots', requireStaffOrAdmin, wrap(async (req) =>
  svc.listMortuarySlots({
    tenantId: tenantOf(req),
    status: req.query.status,
    limit: req.query.limit,
  })));

router.post('/mortuary/slots', requireStaffOrAdmin, wrap(async (req) =>
  svc.createMortuarySlot({ tenantId: tenantOf(req), ...req.body })));

router.get('/records/:id/custody', requireStaffOrAdmin, wrap(async (req) =>
  svc.getBodyCustodyChain({ tenantId: tenantOf(req), id: req.params.id })));

router.post('/records/:id/custody/receive', requireStaffOrAdmin, wrap(async (req) =>
  svc.recordBodyReceive({
    tenantId: tenantOf(req),
    id: req.params.id,
    performed_by: req.user?.uid,
    performed_by_role: req.user?.role,
    ...req.body,
  })));

router.post('/records/:id/custody/store', requireStaffOrAdmin, wrap(async (req) =>
  svc.recordBodyStorage({
    tenantId: tenantOf(req),
    id: req.params.id,
    performed_by: req.user?.uid,
    performed_by_role: req.user?.role,
    ...req.body,
  })));

router.post('/records/:id/custody/release', requireStaffOrAdmin, wrap(async (req) =>
  svc.recordMortuaryBodyRelease({
    tenantId: tenantOf(req),
    id: req.params.id,
    performed_by: req.user?.uid,
    performed_by_role: req.user?.role,
    body_release_witnessed_by: req.user?.uid,
    ...req.body,
  })));

// Mortality review
router.post('/records/:id/review', requireStaffOrAdmin, wrap(async (req) =>
  svc.upsertReview({
    tenantId: tenantOf(req), death_record_id: req.params.id, ...req.body,
  })));

router.post('/reviews/:id/finalise', requireStaffOrAdmin, wrap(async (req) =>
  svc.finaliseReview({
    tenantId: tenantOf(req), id: req.params.id, finalised_by: req.user?.uid,
  })));

// 30-day mortality dashboard
router.get('/summary-30d', requireStaffOrAdmin, wrap(async (req) =>
  svc.summary30d({ tenantId: tenantOf(req) })));

export default router;
