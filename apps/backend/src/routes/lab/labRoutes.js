// src/routes/lab/labRoutes.js
//
// Sprint 3 — Lab results / critical alerts / pathologist worklist.
// Mounted at /api/v1/lab/*. Complementary to /api/v1/hl7/receive
// which is the inbound transport for analyzer ORU messages.

import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import * as lab from '../../services/lab/labResultsService.js';
import * as labClosedLoop from '../../services/lab/labClosedLoopService.js';
import labCodeMappingRoutes from './labCodeMappingRoutes.js';
import * as investigationService from '../../services/investigation/investigationService.js';
import * as investigationOrderService from '../../services/investigation/orderService.js';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import {
  getAuthenticatedActorRoles,
  isAdmin,
  isClinical,
  isStaff,
} from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Terminology WP3 — analyzer-code → catalog/LOINC mapping curation ──────
// CRUD + coverage for lab_analyzer_code_mappings (migration 721). Sub-router
// keeps its own read (staff/admin) and write (terminology curator) gates.
// No patient rows are involved, so it carries no patient-access guard
// (deliberate).
router.use('/code-mappings', labCodeMappingRoutes);

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
      return relayAppError(res, err, 'Lab error');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

const LAB_RESULT_RECORD_ROLES = new Set([
  'LAB_STAFF',
  'LAB_INCHARGE',
  'PATHOLOGIST',
  'ADMIN',
  'SUPER_ADMIN',
]);

function requireLabResultRecorder(req, res, next) {
  const roles = getAuthenticatedActorRoles(req.user);
  if (!roles.some((role) => LAB_RESULT_RECORD_ROLES.has(role))) {
    return error(res, 'Lab result entry role required', 403);
  }
  return next();
}

function requireCriticalAlertAcknowledger(req, res, next) {
  if (req.user?.role === 'SUPER_ADMIN') return next();
  return requireStaffOrAdmin(req, res, next);
}

function requirePatientUidParam(req, res, next) {
  if (!UUID_RE.test(String(req.params.patientUid || ''))) {
    return error(res, 'patientUid must be a valid UUID', 400);
  }
  next();
}

// ── Per-route patient-access guards ─────────────────────────────────────────
// The LAB_RESULT guard used to sit on this router's /api/v1/lab mount in
// app.js. A mount-level middleware runs before Express matches the route, so
// req.params was always empty there; every route that identifies its patient
// through a path param (or through a resource id such as an investigation,
// result, alert, or specimen) therefore resolved no patient and passed as
// no_patient_context without a policy decision — in shadow AND in enforce.
// The guard now runs per route, with an async selector that resolves the
// patient behind the exact row the handler serves, tenant-scoped.
//
// requirePatientContext makes an unresolvable-but-present subject refuse in
// enforce mode (and record an unresolved-deny audit row in shadow) instead of
// silently passing, so an unknown id and an inaccessible patient are
// indistinguishable to the caller (no existence oracle).
//
// Selector contract: malformed input returns null WITHOUT querying (the ids
// bind to ::int casts, so an unvalidated value would turn into a Postgres cast
// error → 500); resolvePatientForAccess re-verifies every returned {id/uid}
// against users inside the request tenant. Routes with no single patient
// subject (worklists, alert list, interface inbox, code-mapping curation) are
// deliberately NOT patient-context-forced — see the per-route notes below.
const labPatientGuard = (patientSelector) => patientAccessGuard('LAB_RESULT', {
  careTeamModeGoverned: true,
  requirePatientContext: true,
  patientSelector,
});

const POSTGRES_INT4_MAX = 2_147_483_647;

function positiveInt4(value) {
  if (value == null) return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= POSTGRES_INT4_MAX ? parsed : null;
}

// :investigationId routes — the sample lifecycle handlers all resolve the
// investigations row by id + tenant (investigationService), so the guard
// resolves the same row's patient_uid.
async function investigationPatientOf(req) {
  const investigationId = positiveInt4(req.params?.investigationId);
  if (investigationId === null) return null;
  // investigations.patient_uid is NULLABLE: legacy rows link by patient_id or
  // phone only. A uid-only selector returned {uid: null} for those rows, so in
  // enforce mode every legacy row 403'd — a lockout on real data. Resolve
  // through the same fallback chain investigationRoutes uses (uid, then
  // patient_id, then registered-patient phone), all inside the tenant.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(u_uid.id, u_id.id, u_ph.id)   AS id,
            COALESCE(u_uid.uid, u_id.uid, u_ph.uid) AS uid
       FROM investigations i
       LEFT JOIN users u_uid
         ON u_uid.uid = i.patient_uid
        AND u_uid.tenant_id = i.tenant_id
        AND u_uid.role = 'PATIENT'
       LEFT JOIN users u_id
         ON u_id.id = i.patient_id
        AND u_id.tenant_id = i.tenant_id
        AND u_id.role = 'PATIENT'
       LEFT JOIN users u_ph
         ON u_ph.phone = i.phone
        AND u_ph.tenant_id = i.tenant_id
        AND u_ph.role = 'PATIENT'
      WHERE i.tenant_id = $1::uuid
        AND i.id = $2::int
      LIMIT 1`,
    tenantOf(req),
    investigationId,
  );
  const row = rows[0];
  if (!row || (row.id == null && row.uid == null)) return null;
  return row;
}

// GET /samples/barcode/:barcode — same normalisation as
// investigationService.getSampleByBarcode (trim + 40-char cap), same
// tenant-scoped sample_barcode lookup.
async function sampleBarcodePatientOf(req) {
  const barcode = String(req.params?.barcode || '').trim().slice(0, 40);
  if (!barcode) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid AS uid
       FROM investigations
      WHERE tenant_id = $1::uuid
        AND sample_barcode = $2
      LIMIT 1`,
    tenantOf(req),
    barcode,
  );
  return rows[0] ?? null;
}

// POST /orders — the handler identifies its subject in the body as
// patient_id (users.id int) and/or patient_uid, exactly the pair it hands to
// createInvestigationOrder. resolvePatientForAccess verifies the pair against
// users within the tenant.
function orderBodyPatientOf(req) {
  const body = req.body || {};
  // Mirror the handler's precedence EXACTLY: patient_id wins, and patient_uid
  // is consulted only when patient_id is absent. Passing both let a
  // patient_id=A & patient_uid=B request be AUTHORISED on B (the resolver's
  // ambiguous OR + ORDER BY picks one) while the handler ORDERED for A — the
  // wristband patient-confusion shape, through the body instead of the query.
  if (body.patient_id != null) return { id: body.patient_id };
  if (body.patient_uid) return { uid: body.patient_uid };
  return null;
}

// POST /results — recordResultManual requires result.patient_uid.
function manualResultPatientOf(req) {
  const uid = req.body?.patient_uid;
  return uid ? { uid } : null;
}

// GET /results/booking/:bookingId — the handler serves the lab_results rows of
// that booking; a booking belongs to one patient, so the selector accepts the
// rows' single distinct patient_uid and refuses (null) on zero rows or on a
// cross-patient anomaly (LIMIT 2 exists only to detect ">1 distinct").
async function bookingResultsPatientOf(req) {
  const bookingId = positiveInt4(req.params?.bookingId);
  if (bookingId === null) return null;
  // Resolve through the BOOKING, not the result rows. A booking with no
  // lab_results YET is the normal pre-processing state, and the handler
  // answers it with an empty list — a result-row selector returned null there,
  // so enforce mode 403'd a state the handler serves. The booking names
  // exactly one patient, and that patient is the subject whether the answer
  // is results or none yet.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.id, p.uid
       FROM investigation_bookings b
       JOIN users p
         ON p.id = b.patient_id
        AND p.tenant_id = b.tenant_id
        AND p.role = 'PATIENT'
      WHERE b.tenant_id = $1::uuid
        AND b.id = $2::int
      LIMIT 1`,
    tenantOf(req),
    bookingId,
  );
  return rows[0] ?? null;
}

// GET /results/patient/:patientUid — the subject IS the path param (validated
// by requirePatientUidParam just before this guard).
function resultsPatientParamOf(req) {
  return { uid: req.params?.patientUid };
}

// POST /pathologist/signoff — signOffResults derives the patient from the
// tenant-owned lab_results selected by result_ids (the body patient_uid is a
// compatibility assertion only), so the guard resolves the same rows' single
// distinct patient. Mixed-patient id sets refuse (null); ids outside int4
// bounds refuse without querying, mirroring normalizeSignoffResultIds.
async function signoffResultsPatientOf(req) {
  const raw = req.body?.result_ids;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const ids = raw.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0 || id > POSTGRES_INT4_MAX)) {
    return null;
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT patient_uid AS uid
       FROM lab_results
      WHERE tenant_id = $1::uuid
        AND id = ANY($2::int[])
      LIMIT 2`,
    tenantOf(req),
    ids,
  );
  return rows.length === 1 ? rows[0] : null;
}

// POST /alerts/critical/:id/ack — lab_critical_alerts carries patient_uid
// directly (migration 151).
async function criticalAlertPatientOf(req) {
  const alertId = positiveInt4(req.params?.id);
  if (alertId === null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid AS uid
       FROM lab_critical_alerts
      WHERE tenant_id = $1::uuid
        AND id = $2::int
      LIMIT 1`,
    tenantOf(req),
    alertId,
  );
  return rows[0] ?? null;
}

// GET /specimens/:id/label — same id + tenant lookup labClosedLoopService
// loadSpecimen performs.
async function specimenPatientOf(req) {
  const specimenId = positiveInt4(req.params?.id);
  if (specimenId === null) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid AS uid
       FROM lab_specimens
      WHERE tenant_id = $1::uuid
        AND id = $2::int
      LIMIT 1`,
    tenantOf(req),
    specimenId,
  );
  return rows[0] ?? null;
}

// POST /specimens/receive-scan — scanReceiveSpecimen matches the tube by
// case-insensitive barcode within the tenant; so does the selector.
async function specimenScanPatientOf(req) {
  const barcode = String(req.body?.barcode || '').trim();
  if (!barcode) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT patient_uid AS uid
       FROM lab_specimens
      WHERE tenant_id = $1::uuid
        AND UPPER(barcode) = UPPER($2)
      LIMIT 1`,
    tenantOf(req),
    barcode,
  );
  return rows[0] ?? null;
}

const guardOrderCreate = labPatientGuard(orderBodyPatientOf);
const guardInvestigationSample = labPatientGuard(investigationPatientOf);
const guardSampleBarcode = labPatientGuard(sampleBarcodePatientOf);
const guardManualResult = labPatientGuard(manualResultPatientOf);
const guardBookingResults = labPatientGuard(bookingResultsPatientOf);
const guardPatientResults = labPatientGuard(resultsPatientParamOf);
const guardSignoff = labPatientGuard(signoffResultsPatientOf);
const guardCriticalAlertAck = labPatientGuard(criticalAlertPatientOf);
const guardSpecimenLabel = labPatientGuard(specimenPatientOf);
const guardSpecimenScan = labPatientGuard(specimenScanPatientOf);

// Test surface (labPathologyNursingRouteGuards.test.js) — not a public API.
export const __patientAccessSelectors = {
  investigationPatientOf,
  sampleBarcodePatientOf,
  orderBodyPatientOf,
  manualResultPatientOf,
  bookingResultsPatientOf,
  resultsPatientParamOf,
  signoffResultsPatientOf,
  criticalAlertPatientOf,
  specimenPatientOf,
  specimenScanPatientOf,
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

export function renderSpecimenLabelHtml(label) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Specimen ${escapeHtml(label.accession_number)}</title>
<style>body{font-family:monospace;margin:12px}.lbl{border:1px solid #000;padding:8px;max-width:420px}</style></head>
<body><div class="lbl"><div><b>${escapeHtml(label.patient?.name || 'Unknown')}</b> · ${escapeHtml(label.specimen_type)} · ${escapeHtml(label.priority)}</div>
<div>${escapeHtml(label.accession_number)}</div>${label.svg}</div></body></html>`;
}

// ── Doctor-facing lab order shortcut ──────────────────────────────────
// `/api/v1/lab/orders` is the documented endpoint the staff app expects;
// it didn't exist before, so doctors trying to place a CBC/electrolytes
// order from the IPD chart hit a 404 and had to discover the actual
// `/api/v1/investigations/order` path by trial-and-error (plus the
// payload shape mismatch). Delegate to the investigation order service
// so both endpoints behave identically — same notes persistence, same
// patient_uid resolution, same priority + type coercion. Findings:
//   2026-05-10-dynamic-acute-abdomen-doctor-lab-order-endpoint-missing-notes-dropped
//   2026-05-10-inpatient-admission-doctor-lab-orders-notes-dropped-no-batch
function requireOrderingStaff(req, res, next) {
  const role = req.user?.role;
  if (!isClinical(role) && !isAdmin(role)) {
    return error(res, 'Lab ordering requires clinical staff or admin role', 403);
  }
  next();
}

router.post('/orders', requireOrderingStaff, guardOrderCreate, wrap(async (req) => {
  const body = req.body || {};
  // Resolve patient_id from patient_uid if the caller used the UUID
  // form (the documented lab-order shape per the swarm finding) — the
  // investigations service expects patient_id (int). Pass through
  // notes / priority / clinical context unchanged.
  let patientId = body.patient_id;
  if (!patientId && body.patient_uid) {
    const { default: prisma } = await import('../../lib/prisma.js');
    const row = await prisma.users.findUnique({
      where: { uid: String(body.patient_uid) },
      select: { id: true },
    });
    patientId = row?.id;
    if (!patientId) {
      throw Object.assign(new Error('patient_uid does not match any user'), { statusCode: 404 });
    }
  }
  const result = await investigationOrderService.createInvestigationOrder({
    patient_id: patientId,
    doctor_uid: req.user?.uid,
    orderedBy: req.user?.uid,
    test_name: body.test_name,
    test_code: body.test_code,
    // /lab/orders is lab-only by definition; default the type so callers
    // don't have to pass `type: "LAB"` again.
    type: body.type || 'LAB',
    priority: body.priority,
    notes: body.notes ?? body.clinical_note ?? body.clinical_notes,
    collection_location: body.collection_location,
    collection_deadline_at: body.collection_deadline_at,
    fasting_required: body.fasting_required,
    fasting_instructions: body.fasting_instructions,
    admission_id: body.admission_id ?? body.admissionId,
    tenantId: req.tenantId,
    actorRole: req.user?.role || null,
  });
  return result;
}));

// ── Sample collection / barcode / rejection workflow ────────────────
// D43 — expose the lab-facing sample lifecycle under /api/v1/lab so a
// lab tech can collect a sample, print/scan the barcode, and reject a
// bad specimen without discovering the older /investigations routes.
router.post('/samples/:investigationId/collect', requireStaffOrAdmin, guardInvestigationSample, wrap(async (req) =>
  investigationService.markSampleCollected({
    id: req.params.investigationId,
    collected_by: req.user?.uid,
    collected_notes: req.body?.collected_notes ?? req.body?.notes,
    sample_barcode: req.body?.sample_barcode,
    scanned_patient_uid: req.body?.scanned_patient_uid,
    tenantId: tenantOf(req),
    actor_role: req.user?.role || null,
  }),
));

router.get('/samples/barcode/:barcode', requireStaffOrAdmin, guardSampleBarcode, wrap(async (req) =>
  investigationService.getSampleByBarcode({
    barcode: req.params.barcode,
    tenantId: tenantOf(req),
  }),
));

router.get('/samples/:investigationId/barcode', requireStaffOrAdmin, guardInvestigationSample, wrap(async (req) =>
  investigationService.getSampleByInvestigationId({
    id: req.params.investigationId,
    tenantId: tenantOf(req),
  }),
));

router.post('/samples/:investigationId/reject', requireStaffOrAdmin, guardInvestigationSample, wrap(async (req) =>
  investigationService.rejectSample({
    id: req.params.investigationId,
    rejected_by: req.user?.uid,
    rejection_reason: req.body?.rejection_reason ?? req.body?.reason,
    tenantId: tenantOf(req),
    actor_role: req.user?.role || null,
  }),
));

// ── Manual result entry (when no analyzer integration) ───────────────
router.post(
  '/results',
  requireLabResultRecorder,
  // Guard before the idempotency claim so a request denied in enforce mode
  // never consumes an idempotency slot.
  guardManualResult,
  requireIdempotencyKey({ required: true, scope: 'lab-result-record' }),
  wrap(async (req) =>
  lab.recordResultManual({
    tenantId: tenantOf(req),
    performed_by: req.user?.uid,
    performed_by_role: req.user?.role,
    result: req.body,
    idempotencyKey: req.idempotencyClaim?.requestKey,
    requestBodySha256: req.idempotencyClaim?.requestBodyHash,
    httpIdempotencyClaimId: req.idempotencyClaim?.id,
    requestId: req.id || null,
  }),
  ),
);

router.get('/results/booking/:bookingId', requireStaffOrAdmin, guardBookingResults, wrap(async (req) =>
  lab.getResultsForBooking({
    tenantId: tenantOf(req),
    booking_id: req.params.bookingId,
  }),
));

router.get('/results/patient/:patientUid', requireStaffOrAdmin, requirePatientUidParam, guardPatientResults, wrap(async (req) =>
  lab.getResultsForPatient({
    tenantId: tenantOf(req),
    patient_uid: req.params.patientUid,
    limit: req.query.limit,
    include_preliminary: req.query.include_preliminary,
  }),
));

// ── IPD lab worklist (E-5) ──────────────────────────────────────────
// The three worklist reads below (/worklist/ipd, /worklist,
// /pathologist/pending) are tenant-wide queues with no single patient
// subject — forcing patient context here would lock the bench out, so they
// keep the mount RBAC + requireStaffOrAdmin gates only (deliberate).
router.get('/worklist/ipd', requireStaffOrAdmin, wrap(async (req) =>
  lab.listIpdLabWorklist({
    tenantId: tenantOf(req),
    limit: req.query.limit,
  }),
));

// ── General lab worklist ────────────────────────────────────────────
// All open investigations across OPD walk-ins, ER, and IPD — without
// the admission inner join the /worklist/ipd endpoint applies. STAT/
// URGENT orders sort to the top regardless of source. Findings:
//   2026-05-10-emergency-walk-in-lab-tech-stat-er-order-not-on-worklist
//   2026-05-08-obstetric-anc-lab-tech-no-worklist-endpoint
router.get('/worklist', requireStaffOrAdmin, wrap(async (req) =>
  lab.listLabWorklist({
    tenantId: tenantOf(req),
    limit: req.query.limit,
    priority: req.query.priority,
    source: req.query.source,
  }),
));

// ── Pathologist worklist + sign-off ──────────────────────────────────
router.get('/pathologist/pending', requireStaffOrAdmin, wrap(async (req) =>
  lab.listPendingSignOff({
    tenantId: tenantOf(req),
    limit: req.query.limit,
  }),
));

// B-3 — pathologist tier gate. Route-layer requireRole + the
// service-level canSignOffLabResults() form a defence-in-depth pair so
// neither can be bypassed alone (route forgets, service stays safe;
// internal call bypasses route, role is still required).
function requirePathologistTier(req, res, next) {
  const role = req.user?.role;
  if (!['PATHOLOGIST', 'LAB_INCHARGE', 'ADMIN', 'SUPER_ADMIN'].includes(role)) {
    return error(res, 'Lab signoff requires pathologist tier', 403);
  }
  next();
}

async function requireCurrentPathologistTier(req, res, next) {
  try {
    await lab.resolveCurrentLabSigner({
      tenantId: tenantOf(req),
      actorUid: req.user?.uid,
      actorRole: req.user?.role,
      actorRoles: getAuthenticatedActorRoles(req.user),
      actorRawRole: req.user?.rawRole || req.user?.role || null,
    });
    return next();
  } catch (err) {
    return relayAppError(res, err, 'Lab signoff authorization failed');
  }
}

function rejectCallerSignerIdentity(req, res, next) {
  const body = req.body || {};
  const prohibited = [
    'signed_off_by',
    'signed_off_by_uid',
    'signed_off_by_name',
    'signed_off_by_reg',
  ];
  if (prohibited.some((field) => Object.prototype.hasOwnProperty.call(body, field))) {
    return error(res, 'Signer identity is server-derived and must not be supplied', 400);
  }
  return next();
}

router.post(
  '/pathologist/signoff',
  requirePathologistTier,
  rejectCallerSignerIdentity,
  requireCurrentPathologistTier,
  // Guard before the idempotency claim so a request denied in enforce mode
  // never consumes an idempotency slot.
  guardSignoff,
  requireIdempotencyKey({ required: true, scope: 'lab-pathologist-signoff' }),
  wrap(async (req) =>
  lab.signOffResults({
    tenantId: tenantOf(req),
    signed_off_by: req.user?.uid,
    signed_off_by_role: req.user?.role,
    result_ids: req.body.result_ids,
    decision: req.body.decision,
    comments: req.body.comments,
    booking_id: req.body.booking_id,
    // Compatibility-only assertion; the service derives the patient from the tenant-owned results.
    patient_uid: req.body.patient_uid,
    actorRoles: getAuthenticatedActorRoles(req.user),
    actorRawRole: req.user?.rawRole || req.user?.role || null,
    idempotencyKey: req.idempotencyClaim?.requestKey,
    requestBodySha256: req.idempotencyClaim?.requestBodyHash,
    httpIdempotencyClaimId: req.idempotencyClaim?.id,
    requestId: req.id || null,
  }),
  ),
);

// ── Critical alerts ──────────────────────────────────────────────────
// The open-alert list is a tenant-wide escalation queue (no single subject) —
// role gates only, deliberately. The per-alert ack below IS single-subject
// and is guarded.
router.get('/alerts/critical', requireStaffOrAdmin, wrap(async (req) =>
  lab.listOpenCriticalAlerts({
    tenantId: tenantOf(req),
    limit: req.query.limit,
  }),
));

router.post('/alerts/critical/:id/ack', requireCriticalAlertAcknowledger, guardCriticalAlertAck, wrap(async (req) =>
  lab.acknowledgeAlert(req.params.id, {
    tenantId: tenantOf(req),
    acknowledged_by: req.user?.uid,
    acknowledged_by_name: req.user?.name || null,
    actorRoles: getAuthenticatedActorRoles(req.user),
    actorRole: req.user?.role
      || (Array.isArray(req.user?.roles) ? req.user.roles[0] : req.user?.roles)
      || null,
    actorRawRole: req.user?.rawRole || null,
    breakGlassId: req.body?.break_glass_id ?? null,
    read_back_method: req.body.read_back_method,
    notes: req.body.notes,
  }),
));

// ── Roadmap B3 — closed-loop lab ───────────────────────────────────────────

// Printable specimen label (Code 39 of the accession barcode).
router.get('/specimens/:id/label', requireStaffOrAdmin, guardSpecimenLabel, wrap(async (req, res) => {
  const label = await labClosedLoop.getSpecimenLabel(
    Number.parseInt(req.params.id, 10),
    { actorUid: req.user?.uid || null, tenantId: tenantOf(req) },
  );
  if (String(req.query.format || '').toLowerCase() === 'html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderSpecimenLabelHtml(label));
    return undefined;
  }
  return label;
}));

// Scan-on-receipt: lab scans the tube barcode → collected/in_transit → received.
router.post('/specimens/receive-scan', requireStaffOrAdmin, guardSpecimenScan, wrap(async (req) =>
  labClosedLoop.scanReceiveSpecimen({
    barcode: req.body.barcode,
    actorUid: req.user?.uid || null,
    actorRole: req.user?.role || null,
    tenantId: tenantOf(req),
  })));

// Interface inbox (replay/triage surface) — a tenant-wide message list with
// no single patient subject; role gates only, deliberately.
router.get('/interface/messages', requireStaffOrAdmin, wrap(async (req) => ({
  messages: await labClosedLoop.listInterfaceMessages({
    status: req.query.status || null,
    limit: req.query.limit,
    tenantId: tenantOf(req),
  }),
})));

export default router;
