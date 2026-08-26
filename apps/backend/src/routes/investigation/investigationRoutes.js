import express from 'express';
import multer from 'multer';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as bookingController from '../../controllers/investigation/bookingController.js';
import * as bulkController from '../../controllers/investigation/bulkController.js';
import * as investigationController from '../../controllers/investigation/investigationController.js';
import * as orderController from '../../controllers/investigation/orderController.js';
import * as uploadController from '../../controllers/investigation/uploadController.js';
import prisma from '../../lib/prisma.js';
import { sanitizeInvestigationFields } from '../../middleware/sanitizeMiddleware.js';
import { patientAccessGuard, patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import { rejectMobileClinicalWrite } from '../../middleware/rejectMobileClinicalWriteMiddleware.js';
import { validateFileContent, validateGenericDocumentUpload, validatePatientUpload } from '../../middleware/uploadMiddleware.js';
import { 
  investigationRequestValidator,
  idValidator,
  updateStatusValidator,
  addResultsValidator,
  listInvestigationsValidator,
  patientIdValidator,
  doctorIdValidator,
  typeValidator
} from '../../validators/investigation/investigationValidators.js';

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

const router = express.Router();

// CAN-017: booking-by-id workflow handlers address the patient through the
// booking id (a path param the parent INVESTIGATION guard can't resolve), so
// they bypassed the care-team relationship check. This per-route guard resolves
// the patient from the booking row and applies the same governed ABAC posture
// (shadow by default → non-breaking; enforce-mode denies an unrelated clinician).
const bookingPatientGuard = patientAccessGuardForResource('INVESTIGATION', {
  resourceType: 'investigation_booking',
  idParam: 'id',
  careTeamModeGoverned: true,
});

// ── Per-route patient access guards for the remaining routes ────────────────
//
// The /api/v1/investigations mount previously wrapped this router in
// patientAccessGuard('INVESTIGATION', ...) at the MOUNT. A mount-level guard
// runs before Express matches the route, so req.params is empty there: every
// route that names its subject only in the path (/:id, /uid/:uid,
// /patient/:patient_id, /:id/files...) resolved no patient and the guard
// returned no_patient_context without evaluating a policy — in shadow AND in
// enforce. CAN-017 fixed the booking family; these guards extend the same
// pattern to the rest of the router (selector = the row the handler serves,
// explicit tenant predicate; bcmaRoutes / abdmHiuRoutes precedent).

function tenantOf(req) {
  return req.tenantId ?? req.user?.tenant_id ?? req.user?.tenantId ?? null;
}

// Digit-strict (unlike Number.parseInt, which would accept '31abc'):
// getInvestigationById rejects non-integer ids outright, so the selector must
// not resolve a subject for an id the handler will never serve.
function positiveInt(value) {
  const text = value == null ? '' : String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 2147483647 ? parsed : null;
}

// Guard factory: keeps the mount's record type + careTeamModeGoverned posture
// (per-tenant mode, default shadow) and stamps metadata for the route pin test.
function investigationGuard(patientSelector, { requirePatientContext = false } = {}) {
  const mw = patientAccessGuard('INVESTIGATION', {
    careTeamModeGoverned: true,
    patientSelector,
    ...(requirePatientContext ? { requirePatientContext: true } : {}),
  });
  mw.__patientGuard = Object.freeze({
    recordType: 'INVESTIGATION',
    careTeamModeGoverned: true,
    requirePatientContext,
    hasSelector: typeof patientSelector === 'function',
  });
  return mw;
}

// Selector: investigation id (path param) → that row's patient. investigations
// links its patient three ways — uid (patient uid), nullable patient_id, and a
// NOT NULL phone that legacy rows may carry alone — so resolve uid →
// patient_id → phone, tenant-scoped on both the row and the user; the ORDER BY
// mirrors accessDecisionService#patientByIdOrUid for multi-match phones.
// Returns null (never throws) on malformed ids, missing/out-of-tenant rows, or
// rows with no registered PATIENT subject.
async function selectInvestigationPatient(req) {
  const invId = positiveInt(req.params?.id);
  const tenantId = tenantOf(req);
  if (invId === null || !tenantId) return null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.id, p.uid
       FROM investigations i
       JOIN users p
         ON p.tenant_id = i.tenant_id
        AND p.role = 'PATIENT'
        AND (
          (i.uid IS NOT NULL AND p.uid = i.uid)
          OR (i.uid IS NULL AND i.patient_id IS NOT NULL AND p.id = i.patient_id)
          OR (i.uid IS NULL AND i.patient_id IS NULL AND p.phone = i.phone)
        )
      WHERE i.tenant_id = $1::uuid
        AND i.id = $2::int
      ORDER BY p.registered_at DESC NULLS LAST, p.id DESC
      LIMIT 1`,
    tenantId,
    invId,
  );
  return rows[0] ?? null;
}

// Resolve a raw phone to the registered patient in the caller's tenant
// (stored E.164 form or digits-only legacy form — the same matching
// accessDecisionService's phone resolution performs). Unregistered → null.
async function resolvePatientByPhone(tenantId, raw) {
  if (raw == null || raw === '' || !tenantId) return null;
  const text = String(raw).trim();
  const digits = text.replace(/\D/g, '');
  const phoneDigits = digits.length >= 10 ? digits.slice(-10) : null;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, uid
       FROM users
      WHERE tenant_id = $1::uuid
        AND role = 'PATIENT'
        AND (
          phone = $2::text
          OR ($3::text IS NOT NULL AND REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') = $3::text)
        )
      ORDER BY registered_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    tenantId,
    text,
    phoneDigits,
  );
  return rows[0] ?? null;
}

// Selector: body.phone (legacy POST / request — the handler resolves the
// target patient purely from the body phone). An unregistered phone yields
// null and the walk-in create proceeds on the role gate.
function selectPatientByBodyPhone(req) {
  return resolvePatientByPhone(tenantOf(req), req.body?.phone ?? req.body?.phoneNumber);
}

// Selector: booking create — mirrors resolveBookingPatient exactly: a PATIENT
// books for themself; staff name body.patient_id or body.patient_phone; a
// brand-new walk-in (unregistered phone, about to be created) has no subject
// yet and stays role-gated.
async function selectBookingCreatePatient(req) {
  if (String(req.user?.role || '').toUpperCase() === 'PATIENT') {
    return req.user?.id != null ? { id: req.user.id } : null;
  }
  const explicitId = req.body?.patient_id;
  if (explicitId != null && explicitId !== '') return { id: explicitId };
  return resolvePatientByPhone(tenantOf(req), req.body?.patient_phone);
}

// Selector for /list: the list is cross-patient UNLESS the caller filters by
// query.patient_uid / query.patient_id — exactly the filters the handler
// passes to the service. Only a present filter yields a subject; an
// unfiltered list stays a role-gated list.
function selectListFilterPatient(req) {
  const uid = req.query?.patient_uid;
  if (uid != null && uid !== '') return { uid };
  const id = req.query?.patient_id;
  if (id != null && id !== '') return { id };
  return null;
}

// Single-subject routes refuse (enforce) rather than fall through when the
// subject cannot be resolved. Investigation-row routes deliberately do NOT
// force context (legacy phone-only rows may have no registered patient);
// the guard still decides every row with a real subject.
const guardInvestigationRow = investigationGuard(selectInvestigationPatient);
const guardPatientIdParam = investigationGuard(
  (req) => (req.params?.patient_id != null ? { id: req.params.patient_id } : null),
  { requirePatientContext: true },
);
const guardPatientUidParam = investigationGuard(
  (req) => (req.params?.uid ? { uid: req.params.uid } : null),
  { requirePatientContext: true },
);
const guardOrderBodyPatient = investigationGuard(
  (req) => (req.body?.patient_id != null && req.body.patient_id !== '' ? { id: req.body.patient_id } : null),
  { requirePatientContext: true },
);
const guardLegacyRequestByPhone = investigationGuard(selectPatientByBodyPhone);
const guardBookingCreate = investigationGuard(selectBookingCreatePatient);
const guardListFilter = investigationGuard(selectListFilterPatient);

export const __guardTesting__ = Object.freeze({
  selectInvestigationPatient,
  selectPatientByBodyPhone,
  selectBookingCreatePatient,
  selectListFilterPatient,
});

// Patient & Medical Staff Routes
wrapAutoRBAC(router, 'investigationRoutes', {
  get: [
    // Static routes MUST come before parameterized routes.
    // Catalog / SLA / pending-queue / doctor-worklist / type views are
    // cross-patient lists or non-patient data — no single subject, so they
    // stay on the role gate and are NOT patient-context-forced.
    ['/catalog', investigationController.getTestCatalog],
    ['/sla-dashboard', investigationController.getInvestigationSLADashboard],
    // /list decides only when the caller narrows to one patient
    // (query.patient_uid / query.patient_id); unfiltered lists pass through.
    ['/list', listInvestigationsValidator, guardListFilter, investigationController.listInvestigations],
    ['/status/pending', investigationController.getPendingInvestigations],

    // Booking routes (static before parameterized)
    ['/bookings/my', bookingController.getMyBookings],
    ['/bookings/queue', bookingController.getBookingQueue],
    ['/bookings/sla', bookingController.getBookingSLADashboard],
    ['/bookings/:id', bookingPatientGuard, bookingController.getBookingDetail],

    // Self-service: caller's own investigations, patient derived from the JWT.
    ['/my', investigationController.getMyInvestigations],
    ['/patient/:patient_id', patientIdValidator, guardPatientIdParam, investigationController.getPatientInvestigations],
    ['/doctor/:doctor_id', doctorIdValidator, investigationController.getDoctorInvestigations],
    ['/type/:type', typeValidator, investigationController.getInvestigationsByType],
    ['/uid/:uid', guardPatientUidParam, investigationController.getInvestigationsByUID],
    ['/:id/files', guardInvestigationRow, uploadController.getFiles],
    ['/:id/files/:fileId', guardInvestigationRow, uploadController.getFileInfo],
    ['/:id/files/:fileId/download', guardInvestigationRow, uploadController.downloadFile],
    ['/:id', idValidator, guardInvestigationRow, investigationController.getInvestigationById]
  ],

  post: [
    // Booking routes (static before parameterized). The create guard runs
    // after multer so a multipart booking has its body fields parsed.
    ['/bookings/create', rejectMobileClinicalWrite, upload.single('slip_photo'), validateFileContent, validatePatientUpload, sanitizeInvestigationFields, guardBookingCreate, bookingController.createBooking],
    ['/bookings/:id/confirm', rejectMobileClinicalWrite, bookingPatientGuard, bookingController.confirmBooking],
    ['/bookings/:id/dispatch', rejectMobileClinicalWrite, bookingPatientGuard, bookingController.dispatchCollector],
    ['/bookings/:id/collected', rejectMobileClinicalWrite, bookingPatientGuard, bookingController.markCollected],
    ['/bookings/:id/processing', rejectMobileClinicalWrite, bookingPatientGuard, bookingController.startProcessing],
    ['/bookings/:id/result', rejectMobileClinicalWrite, bookingPatientGuard, upload.single('file'), validateFileContent, validateGenericDocumentUpload, bookingController.uploadResult],

    ['/catalog', investigationController.upsertTestCatalog],
    ['/order', rejectMobileClinicalWrite, investigationRequestValidator, guardOrderBodyPatient, orderController.orderInvestigation],
    // Bulk status touches up to 100 investigations across patients in one
    // call — a multi-subject operation a single-patient decision cannot
    // represent; it stays on the role gate (deliberate, see report).
    ['/bulk/status', rejectMobileClinicalWrite, bulkController.updateStatus],
    // Wave-5 batch-3 — stamp sample collection on the investigations
    // row itself (not the booking). Surfaces a printable barcode +
    // collector/notes for the lab walk-in flow that bypasses bookings.
    ['/:id/collected', rejectMobileClinicalWrite, idValidator, guardInvestigationRow, investigationController.markInvestigationCollected],
    ['/:id/upload', rejectMobileClinicalWrite, guardInvestigationRow, upload.single('file'), validateFileContent, validateGenericDocumentUpload, uploadController.uploadResult],
    ['/', rejectMobileClinicalWrite, investigationRequestValidator, guardLegacyRequestByPhone, orderController.legacyInvestigationRequest]
  ],

delete: [
    ['/:id/files/:fileId', rejectMobileClinicalWrite, guardInvestigationRow, uploadController.removeFile]
  ],

  put: [
    ['/:id/status', rejectMobileClinicalWrite, updateStatusValidator, guardInvestigationRow, investigationController.updateInvestigationStatus],
    ['/:id/results', rejectMobileClinicalWrite, addResultsValidator, guardInvestigationRow, investigationController.addInvestigationResults]
  ]
});

export default router;
