// src/routes/maternity/maternityRoutes.js
//
// Sprint 7 — Maternity workflow endpoints. Mounted at
// /api/v1/maternity/*.

import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import * as mat from '../../services/maternity/maternityService.js';
import * as immun from '../../services/maternity/immunisationService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin, isPatient, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { exactPositiveInt4OrNull } from '../../utils/postgresInteger.js';

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
      // Shared relay (responseHelper.relayAppError): surfaces AppError
      // code+details per the documented envelope; non-AppErrors get a logged
      // generic 500 that never relays raw err.message. Extracted from this
      // file's #598 fix so exactly one implementation of the pattern exists.
      return relayAppError(res, err, 'Maternity error');
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
  // FAIL CLOSED. This used to `return true` on an unparseable id, which was
  // survivable only while the guard and the services behind it parsed
  // identically. They no longer do: this guard uses the exact int4 parser while
  // getAncTimelineForPregnancy/listFetalKicks used Number.parseInt, which
  // accepts '012', '12abc', ' 12', '+12' and '12.9' as 12. An id in that gap
  // skipped the ownership check entirely and served another patient's record.
  // Both sides now use the same parser AND this refuses rather than allows, so
  // neither half alone can reopen the hole.
  const parsedId = exactPositiveInt4OrNull(pregnancyId);
  if (parsedId === null) {
    error(res, 'pregnancy id must be a positive integer', 400);
    return false;
  }
  const pregnancy = await mat.getPregnancy({ tenantId: tenantOf(req), id: parsedId });
  if (String(pregnancy.patient_uid) !== String(req.user?.uid)) {
    error(res, 'Forbidden', 403);
    return false;
  }
  return true;
}

// ── Patient-access guards (re-audit 2026-08, M: mount guards) ────────
//
// The MATERNITY_RECORD patientAccessGuard used to sit on the app.js mount.
// A mount-level middleware runs BEFORE Express matches the route, so
// req.params is empty there; most routes in this file carry the subject only
// behind a path id (:id, :pregnancyId, :laborId, :deliveryId, :patientUid),
// so resolvePatientForAccess found nothing and authorizePatientAccessRequest
// returned no_patient_context without evaluating a policy — in shadow AND in
// enforce. The mount guard DID read req.body, which is worse, not better: a
// body-supplied decoy patient_uid on any POST/PATCH could be authorised
// while the handler served the row behind the path id.
//
// The guard now sits on each single-subject route with an explicit
// patientSelector that resolves THE ROW THE HANDLER IS ABOUT TO SERVE,
// tenant-scoped, through the same admission/pregnancy joins the
// maternityService handlers use (same pattern as
// bcmaRoutes.guardWristbandView and the abdmHiuRoutes selector factories).
//
// THE SUBJECT IS THE MOTHER. Every maternity row hangs off a
// maternity_pregnancies row and pregnancies.patient_uid (the mother) is the
// clinical subject of the maternity episode — labour admissions, partograph
// entries, deliveries, newborn/apgar rows and postnatal visits all resolve
// to her through the same joins the service asserts before serving them
// (assertPregnancyInTenant / assertDeliveryInTenant / assertNewbornInTenant).
// The two exceptions are the immunisation-status routes
// (POST /immunisations/up-to-date, GET /immunisations/status/:patientUid),
// which take an arbitrary child's patient_uid directly — there the named
// child IS the subject. Note the deliberate asymmetry with the D7 M-D write
// rule: the immunisation seed/dose writers additionally require the
// newborn's OWN minted identity inside immunisationService (fail-closed,
// newbornIdentityRequired) — that write-subject rule is enforced by the
// service and is not weakened by anchoring the ACCESS decision on the
// mother, whose care-team/admission relationships are where labour-ward
// staff hold their clinical link on day 0.
//
// requirePatientContext refuses instead of falling back when a selector
// yields nothing: every guarded route's subject chain is NOT NULL
// (pregnancies.patient_uid, and the service rejects a create whose body id
// is missing), so a missing subject means a malformed id or a
// missing/foreign row, never a legitimately subject-less request. In shadow
// mode the refusal (like every denial) is audit-only. PATIENT self-access
// (and guardian acting-as) is allowed by the policy engine itself, so the
// existing requireStaffAdminOrSelfPatient / ensurePregnancyAccess gates keep
// their behaviour for patients.
//
// Cross-patient boards and subject-less content keep the role gate only —
// GET /labor-admissions/active (labour board), GET /immunisations/due
// (worklist), GET /immunisations/catalogue, GET /ga (stateless calculator),
// GET /packages (pricing), GET /anc-advice (content). A patient guard there
// has no single subject to resolve and would be a control that can never
// fire.
//
// Mode governance is carried over from the mount unchanged:
// careTeamModeGoverned stays true, so the per-tenant
// care_team_enforcement_mode flag ('shadow' by default) governs these
// routes. MATERNITY_RECORD resolves to the
// patient.maternity_paediatric.view policy
// (accessPolicyRegistry.policyCodeForRecordType).

// Delegates to the shared int4-capped parser. The local copy lacked the
// int4 cap, so a 10-digit id reached the ::int bind and threw 22003 —
// a guard 500 on malformed input, violating the never-throw contract.
function positiveInt(value) {
  return exactPositiveInt4OrNull(value);
}

const maternityGuard = (patientSelector) => patientAccessGuard('MATERNITY_RECORD', {
  careTeamModeGoverned: true,
  requirePatientContext: true,
  requireResolvedPatient: true,
  patientSelector,
});

// Mother behind a maternity_pregnancies row. A malformed id returns null
// (clean refusal), never a throw.
const motherFromPregnancyId = (idOf) => async (req) => {
  const pregnancyId = positiveInt(idOf(req));
  if (pregnancyId === null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid AS uid
       FROM maternity_pregnancies
      WHERE tenant_id = $1::uuid AND id = $2::int
      LIMIT 1`,
    tenantOf(req),
    pregnancyId,
  );
  return rows[0] ?? null;
};

// Mother behind a maternity_labor_admissions row (labor → pregnancy).
const motherFromLaborId = (idOf) => async (req) => {
  const laborId = positiveInt(idOf(req));
  if (laborId === null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.patient_uid AS uid
       FROM maternity_labor_admissions la
       JOIN maternity_pregnancies p
         ON p.id = la.pregnancy_id
        AND p.tenant_id = la.tenant_id
      WHERE la.tenant_id = $1::uuid AND la.id = $2::int
      LIMIT 1`,
    tenantOf(req),
    laborId,
  );
  return rows[0] ?? null;
};

// Mother behind a maternity_deliveries row (delivery → pregnancy).
const motherFromDeliveryId = (idOf) => async (req) => {
  const deliveryId = positiveInt(idOf(req));
  if (deliveryId === null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.patient_uid AS uid
       FROM maternity_deliveries d
       JOIN maternity_pregnancies p
         ON p.id = d.pregnancy_id
        AND p.tenant_id = d.tenant_id
      WHERE d.tenant_id = $1::uuid AND d.id = $2::int
      LIMIT 1`,
    tenantOf(req),
    deliveryId,
  );
  return rows[0] ?? null;
};

// Mother behind a maternity_newborns row (newborn → delivery → pregnancy).
const motherFromNewbornId = (idOf) => async (req) => {
  const newbornId = positiveInt(idOf(req));
  if (newbornId === null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.patient_uid AS uid
       FROM maternity_newborns n
       JOIN maternity_deliveries d
         ON d.id = n.delivery_id
        AND d.tenant_id = n.tenant_id
       JOIN maternity_pregnancies p
         ON p.id = d.pregnancy_id
        AND p.tenant_id = n.tenant_id
      WHERE n.tenant_id = $1::uuid AND n.id = $2::int
      LIMIT 1`,
    tenantOf(req),
    newbornId,
  );
  return rows[0] ?? null;
};

// Mother behind a newborn_immunisations row (immunisation → newborn →
// delivery → pregnancy) — the same join chain immunisationService.recordDose
// resolves before writing.
const motherFromImmunisationId = (idOf) => async (req) => {
  const immunisationId = positiveInt(idOf(req));
  if (immunisationId === null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.patient_uid AS uid
       FROM newborn_immunisations i
       JOIN maternity_newborns n
         ON n.id = i.newborn_id
        AND n.tenant_id = i.tenant_id
       JOIN maternity_deliveries d
         ON d.id = n.delivery_id
        AND d.tenant_id = n.tenant_id
       JOIN maternity_pregnancies p
         ON p.id = d.pregnancy_id
        AND p.tenant_id = n.tenant_id
      WHERE i.tenant_id = $1::uuid AND i.id = $2::int
      LIMIT 1`,
    tenantOf(req),
    immunisationId,
  );
  return rows[0] ?? null;
};

// Route-shaped guard instances. Each binds the selector to the SAME
// identifier its handler passes to the service, so the decision, the audit
// row and the served row are the same patient by construction.
const guardByBodyPatientUid = maternityGuard((req) => ({ uid: req.body?.patient_uid }));
const guardByParamPatientUid = maternityGuard((req) => ({ uid: req.params?.patientUid }));
const guardByPregnancyIdParam = maternityGuard(motherFromPregnancyId((req) => req.params?.id));
const guardByPregnancyIdNamedParam = maternityGuard(motherFromPregnancyId((req) => req.params?.pregnancyId));
const guardByPregnancyIdBody = maternityGuard(motherFromPregnancyId((req) => req.body?.pregnancy_id));
const guardByLaborIdParam = maternityGuard(motherFromLaborId((req) => req.params?.id));
const guardByLaborIdNamedParam = maternityGuard(motherFromLaborId((req) => req.params?.laborId));
const guardByLaborIdBody = maternityGuard(motherFromLaborId((req) => req.body?.labor_admission_id));
const guardByDeliveryIdParam = maternityGuard(motherFromDeliveryId((req) => req.params?.id));
const guardByDeliveryIdNamedParam = maternityGuard(motherFromDeliveryId((req) => req.params?.deliveryId));
const guardByDeliveryIdBody = maternityGuard(motherFromDeliveryId((req) => req.body?.delivery_id));
const guardByNewbornIdParam = maternityGuard(motherFromNewbornId((req) => req.params?.id));
const guardByImmunisationIdParam = maternityGuard(motherFromImmunisationId((req) => req.params?.id));

// ── Pregnancy ────────────────────────────────────────────────────────
router.post('/pregnancies', requireStaffOrAdmin, guardByBodyPatientUid, wrap(async (req) =>
  mat.createPregnancy({
    ...req.body,
    tenantId: tenantOf(req),
    created_by: req.user?.uid,
    actor_uid: req.user?.uid,
    actor_role: req.user?.role,
  }),
));

router.get('/pregnancies/patient/:patientUid', requireStaffAdminOrSelfPatient, guardByParamPatientUid, wrap(async (req) =>
  mat.listPregnanciesForPatient({
    tenantId: tenantOf(req),
    patient_uid: req.params.patientUid,
  }),
));

router.get('/pregnancies/:id', requireStaffOrAdmin, guardByPregnancyIdParam, wrap(async (req) =>
  mat.getPregnancy({ tenantId: tenantOf(req), id: req.params.id }),
));

router.patch('/pregnancies/:id', requireStaffOrAdmin, guardByPregnancyIdParam, wrap(async (req) =>
  mat.updatePregnancy(
    {
      ...req.body,
      tenantId: tenantOf(req),
      id: req.params.id,
    },
    {
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
    },
  ),
));

// ── ANC visits ───────────────────────────────────────────────────────
router.post('/anc-visits', requireStaffOrAdmin, guardByPregnancyIdBody, wrap(async (req) =>
  mat.recordAncVisit({
    ...req.body,
    tenantId: tenantOf(req),
    recorded_by: req.user?.uid,
    actor_uid: req.user?.uid,
    actor_role: req.user?.role,
  }),
));

router.get('/anc-visits/pregnancy/:pregnancyId', requireStaffOrAdmin, guardByPregnancyIdNamedParam, wrap(async (req) =>
  mat.listAncVisits({
    tenantId: tenantOf(req),
    pregnancy_id: req.params.pregnancyId,
  }),
));

// ── Labor admission ──────────────────────────────────────────────────
router.post('/labor-admissions', requireStaffOrAdmin, guardByPregnancyIdBody, wrap(async (req) =>
  mat.admitToLabor({
    ...req.body,
    tenantId: tenantOf(req),
    actor_uid: req.user?.uid,
    actor_role: req.user?.role,
  }),
));

// Cross-patient labour board — no single patient subject; role gate only
// (see the guard block comment above).
router.get('/labor-admissions/active', requireStaffOrAdmin, wrap(async (req) =>
  mat.listActiveLaborAdmissions({
    tenantId: tenantOf(req),
    limit: req.query.limit,
  }),
));

router.get('/labor-admissions/:id', requireStaffOrAdmin, guardByLaborIdParam, wrap(async (req) =>
  mat.getLaborAdmission({ tenantId: tenantOf(req), id: req.params.id }),
));

// ── Partograph ───────────────────────────────────────────────────────
router.post('/partograph', requireStaffOrAdmin, guardByLaborIdBody, wrap(async (req) =>
  mat.recordPartographEntry({
    ...req.body,
    tenantId: tenantOf(req),
    recorded_by: req.user?.uid,
    actor_uid: req.user?.uid,
    actor_role: req.user?.role,
  }),
));

router.get('/partograph/labor/:laborId', requireStaffOrAdmin, guardByLaborIdNamedParam, wrap(async (req) =>
  mat.listPartographEntries({
    tenantId: tenantOf(req),
    labor_admission_id: req.params.laborId,
  }),
));

// ── Delivery summary ────────────────────────────────────────────────
router.post('/deliveries', requireStaffOrAdmin, guardByPregnancyIdBody, wrap(async (req) =>
  mat.recordDelivery({
    ...req.body,
    tenantId: tenantOf(req),
    actor_uid: req.user?.uid,
    actor_role: req.user?.role,
  }),
));

router.get('/deliveries/:id', requireStaffOrAdmin, guardByDeliveryIdParam, wrap(async (req) =>
  mat.getDelivery({ tenantId: tenantOf(req), id: req.params.id }),
));

// ── Newborn record + Apgar ──────────────────────────────────────────
// D7 Shape-3: recordNewborn atomically mints the infant identity +
// guardian link for live/early_neonatal_death outcomes. Actor context is
// pinned to the authenticated user AFTER the body spread — body-supplied
// recorded_by/actor fields can never override it.
router.post('/newborns', requireStaffOrAdmin, guardByDeliveryIdBody, wrap(async (req) =>
  mat.recordNewborn({
    ...req.body,
    tenantId: tenantOf(req),
    recorded_by: req.user?.uid,
    actor_uid: req.user?.uid,
    actor_role: req.user?.role,
  }),
));

router.get('/newborns/delivery/:deliveryId', requireStaffOrAdmin, guardByDeliveryIdNamedParam, wrap(async (req) =>
  mat.listNewbornsForDelivery({
    tenantId: tenantOf(req),
    delivery_id: req.params.deliveryId,
  }),
));

router.get('/newborns/:id', requireStaffOrAdmin, guardByNewbornIdParam, wrap(async (req) =>
  mat.getNewbornBundle({ tenantId: tenantOf(req), id: req.params.id }),
));

router.post('/newborns/:id/apgar', requireStaffOrAdmin, guardByNewbornIdParam, wrap(async (req) =>
  mat.recordApgar({
    ...req.body,
    tenantId: tenantOf(req),
    newborn_id: req.params.id,
    recorded_by: req.user?.uid,
    actor_uid: req.user?.uid,
    actor_role: req.user?.role,
  }),
));

// ── Postnatal visits ────────────────────────────────────────────────
router.post('/postnatal-visits', requireStaffOrAdmin, guardByDeliveryIdBody, wrap(async (req) =>
  mat.recordPostnatalVisit({
    ...req.body,
    tenantId: tenantOf(req),
    recorded_by: req.user?.uid,
    actor_uid: req.user?.uid,
    actor_role: req.user?.role,
  }),
));

router.get('/postnatal-visits/delivery/:deliveryId', requireStaffOrAdmin, guardByDeliveryIdNamedParam, wrap(async (req) =>
  mat.listPostnatalVisits({
    tenantId: tenantOf(req),
    delivery_id: req.params.deliveryId,
  }),
));

// ── Newborn immunisations (Sprint 7 follow-through) ─────────────────
// Vaccine catalogue — no patient subject; role gate only.
router.get('/immunisations/catalogue', requireStaffOrAdmin, wrap(async (req) =>
  immun.listCatalogue({
    tenantId: tenantOf(req),
    includeInactive: req.query.includeInactive === 'true',
  }),
));

router.post('/newborns/:id/immunisations/seed', requireStaffOrAdmin, guardByNewbornIdParam, wrap(async (req) =>
  immun.seedScheduleForNewborn({
    tenantId: tenantOf(req),
    newborn_id: req.params.id,
    actor_uid: req.user?.uid,
    actor_role: req.user?.role,
  }),
));

router.get('/newborns/:id/immunisations', requireStaffOrAdmin, guardByNewbornIdParam, wrap(async (req) =>
  immun.getScheduleForNewborn({
    tenantId: tenantOf(req),
    newborn_id: req.params.id,
  }),
));

router.patch('/immunisations/:id/record', requireStaffOrAdmin, guardByImmunisationIdParam, wrap(async (req) =>
  immun.recordDose({
    ...req.body,
    tenantId: tenantOf(req),
    immunisation_id: req.params.id,
    given_by: req.user?.uid,
    actor_role: req.user?.role,
  }),
));

// Cross-patient due/overdue worklist — no single patient subject; role
// gate only (see the guard block comment above).
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
router.post('/immunisations/up-to-date', requireStaffOrAdmin, guardByBodyPatientUid, wrap(async (req) =>
  immun.markScheduleUpToDate({
    tenantId: tenantOf(req),
    patient_uid: req.body?.patient_uid,
    as_of: req.body?.as_of,
    age_group: req.body?.age_group,
    signed_by: req.user?.uid,
    signed_by_name: req.user?.name || req.body?.signed_by_name || null,
    notes: req.body?.notes || null,
    actor_role: req.user?.role,
  }),
));

// Read-side companion — patient app's immunisation card uses this.
router.get('/immunisations/status/:patientUid', requireStaffOrAdmin, guardByParamPatientUid, wrap(async (req) =>
  immun.getImmunisationStatus({
    tenantId: tenantOf(req),
    patient_uid: req.params.patientUid,
  }),
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
router.get('/pregnancies/active/:patientUid', requireStaffAdminOrSelfPatient, guardByParamPatientUid, wrap(async (req) =>
  mat.getActivePregnancyForPatient({
    tenantId: tenantOf(req),
    patient_uid: req.params.patientUid,
  }),
));

// ANC timeline (visits + supplements + recent kicks) per pregnancy.
router.get('/pregnancies/:id/timeline', requireStaffAdminOrPatient, guardByPregnancyIdParam, wrap(async (req, res) => {
  if (!await ensurePregnancyAccess(req, res, req.params.id)) return null;
  const timeline = await mat.getAncTimelineForPregnancy({
    tenantId: tenantOf(req),
    pregnancy_id: req.params.id,
  });
  return isPatient(req.user?.role)
    ? mat.projectAncTimelineForPatient(timeline)
    : timeline;
}));

// Patient-flavored timeline: resolves the active pregnancy first.
router.get('/timeline/patient/:patientUid', requireStaffAdminOrSelfPatient, guardByParamPatientUid, wrap(async (req) => {
  const timeline = await mat.getAncTimelineForPatient({
    tenantId: tenantOf(req),
    patient_uid: req.params.patientUid,
  });
  return isPatient(req.user?.role)
    ? mat.projectAncTimelineForPatient(timeline)
    : timeline;
}));

// Supplements
router.post('/supplements', requireStaffOrAdmin, guardByPregnancyIdBody, wrap(async (req) =>
  mat.recordSupplement({
    ...req.body,
    tenantId: tenantOf(req),
    prescribed_by: req.user?.uid,
    actor_uid: req.user?.uid,
    actor_role: req.user?.role,
  }),
));

router.get('/supplements/pregnancy/:pregnancyId', requireStaffOrAdmin, guardByPregnancyIdNamedParam, wrap(async (req) =>
  mat.listSupplements({
    tenantId: tenantOf(req),
    pregnancy_id: req.params.pregnancyId,
    activeOnly: req.query.activeOnly === 'true',
  }),
));

// E-12 — prior-orders timeline for a pregnancy
router.get('/pregnancies/:id/prior-orders', requireStaffOrAdmin, guardByPregnancyIdParam, wrap(async (req) =>
  mat.listPriorOrdersForPregnancy({
    tenantId: tenantOf(req),
    pregnancy_id: req.params.id,
  }),
));

// Fetal kick log
router.post('/fetal-kicks', requireStaffAdminOrPatient, guardByPregnancyIdBody, wrap(async (req, res) => {
  if (!await ensurePregnancyAccess(req, res, req.body?.pregnancy_id)) return null;
  const recordedBy = isPatient(req.user?.role)
    ? req.user?.uid
    : (req.body.recorded_by ?? req.user?.uid);
  return mat.recordFetalKick({
    ...req.body,
    tenantId: tenantOf(req),
    recorded_by: recordedBy,
    actor_uid: req.user?.uid,
    actor_role: req.user?.role,
  });
}));

router.get('/fetal-kicks/pregnancy/:pregnancyId', requireStaffAdminOrPatient, guardByPregnancyIdNamedParam, wrap(async (req, res) => {
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
