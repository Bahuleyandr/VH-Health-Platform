// src/routes/maternity/maternityRoutes.js
//
// Sprint 7 — Maternity workflow endpoints. Mounted at
// /api/v1/maternity/*.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as mat from '../../services/maternity/maternityService.js';
import * as immun from '../../services/maternity/immunisationService.js';
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
      logger.error('maternity route error:', err);
      return error(res, err.message || 'Maternity error', 500);
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// ── Pregnancy ────────────────────────────────────────────────────────
router.post('/pregnancies', requireStaffOrAdmin, wrap(async (req) =>
  mat.createPregnancy({
    tenantId: tenantOf(req),
    created_by: req.user?.uid,
    ...req.body,
  }),
));

router.get('/pregnancies/patient/:patientUid', requireStaffOrAdmin, wrap(async (req) =>
  mat.listPregnanciesForPatient({
    tenantId: tenantOf(req),
    patient_uid: req.params.patientUid,
  }),
));

router.get('/pregnancies/:id', requireStaffOrAdmin, wrap(async (req) =>
  mat.getPregnancy({ tenantId: tenantOf(req), id: req.params.id }),
));

router.patch('/pregnancies/:id', requireStaffOrAdmin, wrap(async (req) =>
  mat.updatePregnancy({
    tenantId: tenantOf(req),
    id: req.params.id,
    ...req.body,
  }),
));

// ── ANC visits ───────────────────────────────────────────────────────
router.post('/anc-visits', requireStaffOrAdmin, wrap(async (req) =>
  mat.recordAncVisit({
    tenantId: tenantOf(req),
    recorded_by: req.user?.uid,
    ...req.body,
  }),
));

router.get('/anc-visits/pregnancy/:pregnancyId', requireStaffOrAdmin, wrap(async (req) =>
  mat.listAncVisits({
    tenantId: tenantOf(req),
    pregnancy_id: req.params.pregnancyId,
  }),
));

// ── Labor admission ──────────────────────────────────────────────────
router.post('/labor-admissions', requireStaffOrAdmin, wrap(async (req) =>
  mat.admitToLabor({
    tenantId: tenantOf(req),
    ...req.body,
  }),
));

router.get('/labor-admissions/active', requireStaffOrAdmin, wrap(async (req) =>
  mat.listActiveLaborAdmissions({
    tenantId: tenantOf(req),
    limit: req.query.limit,
  }),
));

router.get('/labor-admissions/:id', requireStaffOrAdmin, wrap(async (req) =>
  mat.getLaborAdmission({ tenantId: tenantOf(req), id: req.params.id }),
));

// ── Partograph ───────────────────────────────────────────────────────
router.post('/partograph', requireStaffOrAdmin, wrap(async (req) =>
  mat.recordPartographEntry({
    tenantId: tenantOf(req),
    recorded_by: req.user?.uid,
    ...req.body,
  }),
));

router.get('/partograph/labor/:laborId', requireStaffOrAdmin, wrap(async (req) =>
  mat.listPartographEntries({
    tenantId: tenantOf(req),
    labor_admission_id: req.params.laborId,
  }),
));

// ── Delivery summary ────────────────────────────────────────────────
router.post('/deliveries', requireStaffOrAdmin, wrap(async (req) =>
  mat.recordDelivery({
    tenantId: tenantOf(req),
    ...req.body,
  }),
));

router.get('/deliveries/:id', requireStaffOrAdmin, wrap(async (req) =>
  mat.getDelivery({ tenantId: tenantOf(req), id: req.params.id }),
));

// ── Newborn record + Apgar ──────────────────────────────────────────
router.post('/newborns', requireStaffOrAdmin, wrap(async (req) =>
  mat.recordNewborn({
    tenantId: tenantOf(req),
    recorded_by: req.user?.uid,
    ...req.body,
  }),
));

router.get('/newborns/delivery/:deliveryId', requireStaffOrAdmin, wrap(async (req) =>
  mat.listNewbornsForDelivery({ delivery_id: req.params.deliveryId }),
));

router.get('/newborns/:id', requireStaffOrAdmin, wrap(async (req) =>
  mat.getNewbornBundle({ tenantId: tenantOf(req), id: req.params.id }),
));

router.post('/newborns/:id/apgar', requireStaffOrAdmin, wrap(async (req) =>
  mat.recordApgar({
    newborn_id: req.params.id,
    recorded_by: req.user?.uid,
    ...req.body,
  }),
));

// ── Postnatal visits ────────────────────────────────────────────────
router.post('/postnatal-visits', requireStaffOrAdmin, wrap(async (req) =>
  mat.recordPostnatalVisit({
    tenantId: tenantOf(req),
    recorded_by: req.user?.uid,
    ...req.body,
  }),
));

router.get('/postnatal-visits/delivery/:deliveryId', requireStaffOrAdmin, wrap(async (req) =>
  mat.listPostnatalVisits({
    tenantId: tenantOf(req),
    delivery_id: req.params.deliveryId,
  }),
));

// ── Newborn immunisations (Sprint 7 follow-through) ─────────────────
router.get('/immunisations/catalogue', requireStaffOrAdmin, wrap(async (req) =>
  immun.listCatalogue({
    tenantId: tenantOf(req),
    includeInactive: req.query.includeInactive === 'true',
  }),
));

router.post('/newborns/:id/immunisations/seed', requireStaffOrAdmin, wrap(async (req) =>
  immun.seedScheduleForNewborn({
    tenantId: tenantOf(req),
    newborn_id: req.params.id,
  }),
));

router.get('/newborns/:id/immunisations', requireStaffOrAdmin, wrap(async (req) =>
  immun.getScheduleForNewborn({
    tenantId: tenantOf(req),
    newborn_id: req.params.id,
  }),
));

router.patch('/immunisations/:id/record', requireStaffOrAdmin, wrap(async (req) =>
  immun.recordDose({
    tenantId: tenantOf(req),
    immunisation_id: req.params.id,
    given_by: req.user?.uid,
    ...req.body,
  }),
));

router.get('/immunisations/due', requireStaffOrAdmin, wrap(async (req) =>
  immun.listDueOrOverdue({
    tenantId: tenantOf(req),
    from_date: req.query.from,
    to_date: req.query.to,
    limit: req.query.limit,
  }),
));

export default router;
