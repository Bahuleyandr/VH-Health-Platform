// src/routes/clinical/deathCertificationRoutes.js — Sprint 21

import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import * as svc from '../../services/clinical/deathCertificationService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { positiveIntOrNull } from '../../middleware/routePatientAccessGuards.js';

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
      return relayAppError(res, err, 'Death certification error');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// ── Patient-access guards (re-audit 2026-08, M: mount guards) ────────
//
// The DEATH_CERTIFICATION patientAccessGuard used to sit on the app.js
// mount. A mount-level middleware runs BEFORE Express matches the route, so
// req.params is empty there; every single-subject route in this file carries
// the deceased patient only behind a path id, so resolvePatientForAccess
// found nothing and authorizePatientAccessRequest returned no_patient_context
// without evaluating a policy — in shadow AND in enforce. The mount guard
// DID read req.body, which is worse, not better: a body-supplied decoy
// patient_uid on any POST route (e.g. /records/:id/transition) could be
// authorised while the handler served the record behind :id.
//
// The guard now sits on each single-subject route with an explicit
// patientSelector that resolves THE ROW THE HANDLER IS ABOUT TO SERVE,
// tenant-scoped, from the same identifier the handler passes to the service
// (same pattern as bcmaRoutes.guardWristbandView and the abdmHiuRoutes
// selector factories). requirePatientContext refuses instead of falling back
// when the selector yields nothing: death_records.patient_uid is NOT NULL,
// so a missing subject means a malformed id or a missing/foreign record,
// never a legitimately subject-less read. In shadow mode the refusal (like
// every denial) is audit-only.
//
// Register/board/inventory reads with no single patient subject — GET
// /records, the mortuary board, slot inventory, summary-30d — deliberately
// keep the role gate only: a patient guard there has no subject to resolve
// and would be a control that can never fire.
//
// Mode governance is carried over from the mount unchanged:
// careTeamModeGoverned stays true, so the per-tenant
// care_team_enforcement_mode flag ('shadow' by default) governs these
// routes. DEATH_CERTIFICATION resolves to the patient.clinical_document.view
// policy (accessPolicyRegistry.policyCodeForRecordType).

// Delegates to the shared int4-capped parser. The local copy lacked the
// int4 cap, so a 10-digit id reached the ::int bind and threw 22003 —
// a guard 500 on malformed input, violating the never-throw contract.
function positiveInt(value) {
  return positiveIntOrNull(value);
}

const deathCertGuard = (patientSelector) => patientAccessGuard('DEATH_CERTIFICATION', {
  careTeamModeGoverned: true,
  requirePatientContext: true,
  requireResolvedPatient: true,
  patientSelector,
});

// The deceased patient behind death_records.:id — the row every /records/:id
// handler loads. A malformed id returns null (clean refusal), never a throw.
const deceasedFromRecordId = async (req) => {
  const recordId = positiveInt(req.params?.id);
  if (recordId === null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid AS uid
       FROM death_records
      WHERE tenant_id = $1::uuid AND id = $2::int
      LIMIT 1`,
    tenantOf(req),
    recordId,
  );
  return rows[0] ?? null;
};

const guardDeathRecordById = deathCertGuard(deceasedFromRecordId);

// POST /records carries the subject only in the body — resolve it exactly
// the way createDeathRecord will (body.patient_uid, required by the
// service), so the decision, the audit row and the inserted record are the
// same patient by construction.
const guardDeathRecordCreate = deathCertGuard((req) => ({ uid: req.body?.patient_uid }));

// POST /reviews/:id addresses a mortality_reviews row; the subject is the
// deceased patient behind its death record (tenant-scoped join).
const guardMortalityReviewById = deathCertGuard(async (req) => {
  const reviewId = positiveInt(req.params?.id);
  if (reviewId === null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT dr.patient_uid AS uid
       FROM mortality_reviews mr
       JOIN death_records dr
         ON dr.id = mr.death_record_id
        AND dr.tenant_id = mr.tenant_id
      WHERE mr.tenant_id = $1::uuid AND mr.id = $2::int
      LIMIT 1`,
    tenantOf(req),
    reviewId,
  );
  return rows[0] ?? null;
});

// Death records
router.post('/records', requireStaffOrAdmin, guardDeathRecordCreate, wrap(async (req) =>
  svc.createDeathRecord({ ...req.body, tenantId: tenantOf(req) })));

// Register listing — no single patient subject; role gate only (see the
// guard block comment above).
router.get('/records', requireStaffOrAdmin, wrap(async (req) =>
  svc.listDeathRecords({
    tenantId: tenantOf(req),
    status: req.query.status, from: req.query.from, to: req.query.to,
    is_medicolegal: req.query.is_medicolegal,
    limit: req.query.limit,
  })));

router.get('/records/:id', requireStaffOrAdmin, guardDeathRecordById, wrap(async (req) =>
  svc.getDeathRecord({ tenantId: tenantOf(req), id: req.params.id })));

router.post('/records/:id/transition', requireStaffOrAdmin, guardDeathRecordById, wrap(async (req) =>
  svc.transition({
    ...req.body,
    tenantId: tenantOf(req), id: req.params.id,
    certified_by: req.user?.uid,
  })));

router.post('/records/:id/body-release', requireStaffOrAdmin, guardDeathRecordById, wrap(async (req) =>
  svc.recordBodyRelease({
    ...req.body,
    tenantId: tenantOf(req), id: req.params.id,
    body_release_witnessed_by: req.user?.uid,
  })));

router.post('/records/:id/police-clearance', requireStaffOrAdmin, guardDeathRecordById, wrap(async (req) =>
  svc.recordPoliceClearance({
    ...req.body,
    tenantId: tenantOf(req), id: req.params.id,
  })));

// Mortuary custody
// Board + slot inventory are cross-patient/no-patient operational surfaces —
// role gate only (see the guard block comment above).
router.get('/mortuary/board', requireStaffOrAdmin, wrap(async (req) =>
  svc.mortuaryBoard({ tenantId: tenantOf(req) })));

router.get('/mortuary/slots', requireStaffOrAdmin, wrap(async (req) =>
  svc.listMortuarySlots({
    tenantId: tenantOf(req),
    status: req.query.status,
    limit: req.query.limit,
  })));

router.post('/mortuary/slots', requireStaffOrAdmin, wrap(async (req) =>
  svc.createMortuarySlot({ ...req.body, tenantId: tenantOf(req) })));

router.get('/records/:id/custody', requireStaffOrAdmin, guardDeathRecordById, wrap(async (req) =>
  svc.getBodyCustodyChain({ tenantId: tenantOf(req), id: req.params.id })));

router.post('/records/:id/custody/receive', requireStaffOrAdmin, guardDeathRecordById, wrap(async (req) =>
  svc.recordBodyReceive({
    ...req.body,
    tenantId: tenantOf(req),
    id: req.params.id,
    performed_by: req.user?.uid,
    performed_by_role: req.user?.role,
  })));

router.post('/records/:id/custody/store', requireStaffOrAdmin, guardDeathRecordById, wrap(async (req) =>
  svc.recordBodyStorage({
    ...req.body,
    tenantId: tenantOf(req),
    id: req.params.id,
    performed_by: req.user?.uid,
    performed_by_role: req.user?.role,
  })));

router.post('/records/:id/custody/release', requireStaffOrAdmin, guardDeathRecordById, wrap(async (req) =>
  svc.recordMortuaryBodyRelease({
    ...req.body,
    tenantId: tenantOf(req),
    id: req.params.id,
    performed_by: req.user?.uid,
    performed_by_role: req.user?.role,
    body_release_witnessed_by: req.user?.uid,
  })));

// Mortality review
router.post('/records/:id/review', requireStaffOrAdmin, guardDeathRecordById, wrap(async (req) =>
  svc.upsertReview({
    ...req.body,
    tenantId: tenantOf(req), death_record_id: req.params.id,
  })));

router.post('/reviews/:id/finalise', requireStaffOrAdmin, guardMortalityReviewById, wrap(async (req) =>
  svc.finaliseReview({
    tenantId: tenantOf(req), id: req.params.id, finalised_by: req.user?.uid,
  })));

// 30-day mortality dashboard — tenant-level aggregate, no patient subject;
// role gate only.
router.get('/summary-30d', requireStaffOrAdmin, wrap(async (req) =>
  svc.summary30d({ tenantId: tenantOf(req) })));

export default router;
