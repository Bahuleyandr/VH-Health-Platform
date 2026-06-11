// src/routes/productivity/productivityRoutes.js
//
// Sprint 8 — doctor productivity endpoints. Mounted at
// /api/v1/productivity/*.
//   - smart phrases (dot phrases) — list / lookup / CRUD
//   - order sets — list / get / create / apply
//   - clinical calculators — pure compute, one endpoint per calculator

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as phrases from '../../services/productivity/smartPhrasesService.js';
import * as orderSets from '../../services/productivity/orderSetsService.js';
import { CALCULATORS } from '../../services/productivity/clinicalCalculators.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff, isDoctor } from '../../utils/roleHelpers.js';

const router = Router();

function tenantOf(req) {
  return req?.tenantId || req?.user?.tenant_id || req?.user?.tenantId || req?.tenant?.id ||
    '00000000-0000-4000-8000-000000000001';
}

function canManageSharedPhrases(role) {
  return ['ADMIN', 'SUPER_ADMIN'].includes(String(role || '').trim().toUpperCase());
}

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      if (err.statusCode) return error(res, err.message, err.statusCode);
      logger.error('productivity route error:', err);
      return error(res, err.message || 'Productivity error', 500);
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

function requireDoctorOrAdmin(req, res, next) {
  if (!isDoctor(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Doctor or admin role required', 403);
  }
  next();
}

// ── Smart phrases ────────────────────────────────────────────────────
router.get('/phrases', requireStaffOrAdmin, wrap(async (req) =>
  phrases.listForUser({
    tenantId: tenantOf(req),
    owner_uid: req.user?.uid,
    specialty: req.query.specialty,
    q: req.query.q,
    limit: req.query.limit,
  }),
));

router.get('/phrases/:code', requireStaffOrAdmin, wrap(async (req) =>
  phrases.lookup({
    tenantId: tenantOf(req),
    owner_uid: req.user?.uid,
    code: req.params.code,
  }),
));

router.post('/phrases', requireDoctorOrAdmin, wrap(async (req) =>
  phrases.create({
    tenantId: tenantOf(req),
    owner_uid: req.user?.uid,
    ...req.body,
    can_manage_shared: canManageSharedPhrases(req.user?.role),
  }),
));

router.patch('/phrases/:id', requireDoctorOrAdmin, wrap(async (req) =>
  phrases.update({
    tenantId: tenantOf(req),
    id: req.params.id,
    owner_uid: req.user?.uid,
    ...req.body,
    can_manage_shared: canManageSharedPhrases(req.user?.role),
  }),
));

router.delete('/phrases/:id', requireDoctorOrAdmin, wrap(async (req) =>
  phrases.remove({
    tenantId: tenantOf(req),
    id: req.params.id,
    owner_uid: req.user?.uid,
    can_manage_shared: canManageSharedPhrases(req.user?.role),
  }),
));

// ── Order sets ──────────────────────────────────────────────────────
router.get('/order-sets', requireStaffOrAdmin, wrap(async (req) =>
  orderSets.listSets({
    tenantId: tenantOf(req),
    specialty: req.query.specialty,
    q: req.query.q,
    includeInactive: req.query.includeInactive === 'true',
    limit: req.query.limit,
  }),
));

router.get('/order-sets/:id', requireStaffOrAdmin, wrap(async (req) =>
  orderSets.getSet({ tenantId: tenantOf(req), id: req.params.id }),
));

router.get('/order-sets/by-code/:code', requireStaffOrAdmin, wrap(async (req) =>
  orderSets.getSetByCode({ tenantId: tenantOf(req), code: req.params.code }),
));

router.post('/order-sets', wrap(async (req, res) => {
  if (!isAdmin(req.user?.role)) return error(res, 'Admin role required', 403);
  return orderSets.createSet({
    tenantId: tenantOf(req),
    created_by: req.user?.uid,
    ...req.body,
  });
}));

router.post('/order-sets/:id/apply', requireDoctorOrAdmin, wrap(async (req) =>
  orderSets.applySet({
    tenantId: tenantOf(req),
    order_set_id: req.params.id,
    applied_by: req.user?.uid,
    ...req.body,
  }),
));

router.get('/order-sets/applications/encounter/:encounterId',
  requireStaffOrAdmin, wrap(async (req) =>
    orderSets.listApplicationsForEncounter({
      tenantId: tenantOf(req),
      encounter_id: req.params.encounterId,
    }),
  ));

// ── Clinical calculators ────────────────────────────────────────────
// One endpoint per calculator. Pure compute, no side effects, no PHI
// — open to staff and doctors. The /list endpoint enumerates them so
// the front-end picker isn't hard-coded.

router.get('/calculators', requireStaffOrAdmin, wrap(async () =>
  Object.keys(CALCULATORS).map((name) => ({ name })),
));

for (const [name, fn] of Object.entries(CALCULATORS)) {
  router.post(`/calculators/${name}`, requireStaffOrAdmin, wrap(async (req) =>
    fn(req.body || {}),
  ));
}

export default router;
