// src/routes/maternity/maternityRoutes.js
//
// Sprint 7 — Maternity workflow endpoints. Mounted at
// /api/v1/maternity/*.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as mat from '../../services/maternity/maternityService.js';
import * as immun from '../../services/maternity/immunisationService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isPatient, isStaff } from '../../utils/roleHelpers.js';

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
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role) && req.user?.role !== 'SUPER_ADMIN') {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

function requireStaffAdminOrSelfPatient(req, res, next) {
  const role = req.user?.role;
  if (isStaff(role) || isAdmin(role) || role === 'SUPER_ADMIN') return next();
  if (isPatient(role) && String(req.user?.uid) === String(req.params.patientUid)) return next();
  return error(res, 'Staff/admin access or matching patient account required', 403);
}

function requireStaffAdminOrPatient(req, res, next) {
  const role = req.user?.role;
  if (isStaff(role) || isAdmin(role) || role === 'SUPER_ADMIN' || isPatient(role)) return next();
  return error(res, 'Staff/admin or patient role required', 403);
}

async function ensurePregnancyAccess(req, res, pregnancyId) {
  if (!isPatient(req.user?.role)) return true;
  const parsedId = Number.parseInt(pregnancyId, 10);
  if (!Number.isInteger(parsedId) || parsedId <= 0) return true;
  const pregnancy = await mat.getPregnancy({ tenantId: tenantOf(req), id: parsedId });
  if (String(pregnancy.patient_uid) !== String(req.user?.uid)) {
    error(res, 'Forbidden', 403);
    return false;
  }
  return true;
}

// ── Pregnancy ────────────────────────────────────────────────────────
router.post('/pregnancies', requireStaffOrAdmin, wrap(async (req) =>
  mat.createPregnancy({
    tenantId: tenantOf(req),
    created_by: req.user?.uid,
    ...req.body,
  }),
));

router.get('/pregnancies/patient/:patientUid', requireStaffAdminOrSelfPatient, wrap(async (req) =>
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

// Wave-5 batch-3 — single-tap "this patient is up to date" shortcut.
// Replaces the 29-write per-dose entry path with one signed
// clinical_notes row. Finding:
//   2026-05-10-pediatric-opd-nurse-immunisation-up-to-date-requires-29-writes
router.post('/immunisations/up-to-date', requireStaffOrAdmin, wrap(async (req) =>
  immun.markScheduleUpToDate({
    tenantId: tenantOf(req),
    patient_uid: req.body?.patient_uid,
    as_of: req.body?.as_of,
    age_group: req.body?.age_group,
    signed_by: req.user?.uid,
    signed_by_name: req.user?.name || req.body?.signed_by_name || null,
    notes: req.body?.notes || null,
  }),
));

// Read-side companion — patient app's immunisation card uses this.
router.get('/immunisations/status/:patientUid', requireStaffOrAdmin, wrap(async (req) =>
  immun.getImmunisationStatus({ patient_uid: req.params.patientUid }),
));

// ── A7 — ANC operational helpers (migration 181) ────────────────────

// GET /api/v1/maternity/ga?lmp=YYYY-MM-DD&onDate=YYYY-MM-DD?
// Stateless GA computation. Receptionist + walk-in form use this.
router.get('/ga', requireStaffOrAdmin, (req, res) => {
  const ga = mat.computeGestationalAge(req.query.lmp, req.query.onDate || null);
  if (!ga) return error(res, 'lmp is required and must be a valid past date', 400);
  return success(res, ga);
});

// Active pregnancy lookup for the patient app + walk-in form.
router.get('/pregnancies/active/:patientUid', requireStaffAdminOrSelfPatient, wrap(async (req) =>
  mat.getActivePregnancyForPatient({
    tenantId: tenantOf(req),
    patient_uid: req.params.patientUid,
  }),
));

// ANC timeline (visits + supplements + recent kicks) per pregnancy.
router.get('/pregnancies/:id/timeline', requireStaffAdminOrPatient, wrap(async (req, res) => {
  if (!await ensurePregnancyAccess(req, res, req.params.id)) return null;
  return mat.getAncTimelineForPregnancy({
    tenantId: tenantOf(req),
    pregnancy_id: req.params.id,
  });
}));

// Patient-flavored timeline: resolves the active pregnancy first.
router.get('/timeline/patient/:patientUid', requireStaffAdminOrSelfPatient, wrap(async (req) =>
  mat.getAncTimelineForPatient({
    tenantId: tenantOf(req),
    patient_uid: req.params.patientUid,
  }),
));

// Supplements
router.post('/supplements', requireStaffOrAdmin, wrap(async (req) =>
  mat.recordSupplement({
    tenantId: tenantOf(req),
    prescribed_by: req.user?.uid,
    ...req.body,
  }),
));

router.get('/supplements/pregnancy/:pregnancyId', requireStaffOrAdmin, wrap(async (req) =>
  mat.listSupplements({
    tenantId: tenantOf(req),
    pregnancy_id: req.params.pregnancyId,
    activeOnly: req.query.activeOnly === 'true',
  }),
));

// E-12 — prior-orders timeline for a pregnancy
router.get('/pregnancies/:id/prior-orders', requireStaffOrAdmin, wrap(async (req) =>
  mat.listPriorOrdersForPregnancy({
    tenantId: tenantOf(req),
    pregnancy_id: req.params.id,
  }),
));

// Fetal kick log
router.post('/fetal-kicks', requireStaffAdminOrPatient, wrap(async (req, res) => {
  if (!await ensurePregnancyAccess(req, res, req.body?.pregnancy_id)) return null;
  const recordedBy = isPatient(req.user?.role)
    ? req.user?.uid
    : (req.body.recorded_by ?? req.user?.uid);
  return mat.recordFetalKick({
    tenantId: tenantOf(req),
    ...req.body,
    recorded_by: recordedBy,
  });
}));

router.get('/fetal-kicks/pregnancy/:pregnancyId', requireStaffAdminOrPatient, wrap(async (req, res) => {
  if (!await ensurePregnancyAccess(req, res, req.params.pregnancyId)) return null;
  return mat.listFetalKicks({
    tenantId: tenantOf(req),
    pregnancy_id: req.params.pregnancyId,
    fromDate: req.query.from || null,
    toDate: req.query.to || null,
  });
}));

// ── Maternity packages ──────────────────────────────────────────────
// Staff/admin pricing-quote surface. The patient-readable view is
// /api/v1/portal/maternity/packages (this router is staff/admin
// gated). Finding:
// 2026-05-09-walk-in-opd-patient-maternity-package-forbidden.
router.get('/packages', requireStaffOrAdmin, wrap(async (req) =>
  mat.listMaternityPackages({ tenantId: tenantOf(req) }),
));

// ── ANC trimester advice ────────────────────────────────────────────
// Staff/admin view of the trimester ANC advice content (the editable
// source the clinical team reviews). Patient-facing view is
// /api/v1/portal/maternity/anc-advice. Finding:
// 2026-05-10-obstetric-anc-patient-no-kick-counter-or-ob-advice.
router.get('/anc-advice', requireStaffOrAdmin, wrap(async (req) =>
  mat.getAncAdvice({
    tenantId: tenantOf(req),
    trimester: req.query.trimester || null,
    language: req.query.language || 'hi',
  }),
));

export default router;
