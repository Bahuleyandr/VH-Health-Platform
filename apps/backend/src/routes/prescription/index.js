import express from 'express';
import multer from 'multer';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import * as ePrescriptionController from '../../controllers/prescription/ePrescriptionController.js';
import * as rejectedPrescriptionAmendmentController from '../../controllers/prescription/rejectedPrescriptionAmendmentController.js';
import * as pharmacyOrderController from '../../controllers/pharmacy/pharmacyOrderController.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { requireIdempotencyKey } from '../../middleware/idempotencyMiddleware.js';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import { rejectMobileClinicalWrite } from '../../middleware/rejectMobileClinicalWriteMiddleware.js';
import { validateFileContent } from '../../middleware/uploadMiddleware.js';
import { prescriptionAttachmentFileFilter } from '../../utils/prescriptionAttachmentFilter.js';

const router = express.Router();

logger.info('✅ E-Prescription routes loaded');

// ── Per-route patient access guards ─────────────────────────────────────────
//
// The /api/v1/prescriptions mount previously wrapped this router in
// patientAccessGuard('PRESCRIPTION', ...) at the MOUNT. A mount-level guard
// runs before Express matches the route, so req.params is empty there: every
// route that names its subject only in the path (/:id, /pdf/:id,
// /appointment/:appointmentId) resolved no patient and the guard returned
// no_patient_context without evaluating a policy — in shadow AND in enforce.
// The guard now lives on the routes themselves, each with a selector that
// resolves THE ROW THE HANDLER SERVES (same identifier, explicit tenant
// predicate), so the decision, the audit row and the disclosure are the same
// patient by construction. Same pattern as routes/clinical/bcmaRoutes.js and
// routes/abdm/abdmHiuRoutes.js.
//
// These routes serve e_prescriptions (patient via the integer
// e_prescriptions.patient_id → users.id). The registry resourceType
// 'prescription' resolves the UNRELATED legacy `prescriptions` table
// (patient_uid-keyed), so patientAccessGuardForResource would authorise
// against a different row than the handler serves — hence inline selectors.

function tenantOf(req) {
  return req.tenantId ?? req.user?.tenant_id ?? req.user?.tenantId ?? null;
}

function positiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 2147483647 ? parsed : null;
}

// Guard factory: keeps the mount's record type and careTeamModeGoverned
// posture (per-tenant mode, default shadow), and stamps metadata the route
// pin test reads off the router stack.
function prescriptionGuard(patientSelector, { requirePatientContext = false } = {}) {
  const mw = patientAccessGuard('PRESCRIPTION', {
    careTeamModeGoverned: true,
    patientSelector,
    ...(requirePatientContext ? { requirePatientContext: true } : {}),
  });
  mw.__patientGuard = Object.freeze({
    recordType: 'PRESCRIPTION',
    careTeamModeGoverned: true,
    requirePatientContext,
    hasSelector: typeof patientSelector === 'function',
  });
  return mw;
}

// Receipt replay can disclose the rejected prescription after care authority is
// revoked, so this command cannot inherit the tenant's shadow/off ABAC mode.
function enforcedPrescriptionGuard(patientSelector, { requirePatientContext = false } = {}) {
  const mw = patientAccessGuard('PRESCRIPTION', {
    patientSelector,
    ...(requirePatientContext ? { requirePatientContext: true } : {}),
  });
  mw.__patientGuard = Object.freeze({
    recordType: 'PRESCRIPTION',
    careTeamModeGoverned: false,
    requirePatientContext,
    hasSelector: typeof patientSelector === 'function',
  });
  return mw;
}

// Selector: prescription id (path param) → the e_prescriptions row's patient.
// Returns null (never throws) on a malformed id, a missing row, an
// out-of-tenant row, or a row whose patient_id does not point at a PATIENT
// user — the guard then refuses via requirePatientContext (enforce) or
// records no_patient_context (shadow) instead of 500ing.
function selectRxPatientByParam(paramName) {
  return async (req) => {
    const rxId = positiveInt(req.params?.[paramName]);
    const tenantId = tenantOf(req);
    if (rxId === null || !tenantId) return null;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT p.id, p.uid
         FROM e_prescriptions ep
         JOIN users p
           ON p.id = ep.patient_id
          AND p.tenant_id = ep.tenant_id
          AND p.role = 'PATIENT'
        WHERE ep.tenant_id = $1::uuid
          AND ep.id = $2::int
        LIMIT 1`,
      tenantId,
      rxId,
    );
    return rows[0] ?? null;
  };
}

// Selector: appointment id → the patient of the SAME e_prescriptions row the
// handler serves (latest by created_at for that appointment — mirrors
// getPrescriptionByAppointment's ORDER BY ... LIMIT 1 pick).
async function selectRxPatientByAppointment(req) {
  const apptId = positiveInt(req.params?.appointmentId);
  const tenantId = tenantOf(req);
  if (apptId === null || !tenantId) return null;
  // Resolve through the APPOINTMENT, not the prescription row. The handler is
  // the check-then-create flow: callers legitimately probe an appointment that
  // has no e_prescriptions row YET, and a prescription-row selector returned
  // null there — so in enforce mode the probe 403'd and the create flow could
  // never start. The appointment always names exactly one patient, and that
  // patient is the subject whether the answer is a prescription or an empty
  // result.
  const rows = await prisma.$queryRawUnsafe(
    `SELECT p.id, p.uid
       FROM appointments a
       JOIN users p
         ON p.id = a.patient_id
        AND p.tenant_id = a.tenant_id
        AND p.role = 'PATIENT'
      WHERE a.tenant_id = $1::uuid
        AND a.id = $2::int
      LIMIT 1`,
    tenantId,
    apptId,
  );
  return rows[0] ?? null;
}

// Selector: body.patient_id (the identifier createPrescription /
// previewSafetyCheck read). resolvePatientForAccess validates the id against
// users with the tenant + role='PATIENT' predicate, so returning the raw value
// is safe: malformed input resolves to null, never throws.
function selectRxPatientFromBody(req) {
  const patientId = req.body?.patient_id;
  return patientId == null || patientId === '' ? null : { id: patientId };
}

// Selector for /all: that list is cross-patient UNLESS the caller filters by
// patient (query.patient_id) or phone (query.phone — matched against the
// patient's own phone; the handler's guardian-phone branches can additionally
// match dependants, which a single-subject decision cannot represent). Only a
// present filter yields a subject; an unfiltered list stays a role-gated list.
async function selectRxListFilterPatient(req) {
  const patientId = req.query?.patient_id;
  if (patientId != null && patientId !== '') return { id: patientId };
  const phone = req.query?.phone;
  const tenantId = tenantOf(req);
  if (phone == null || phone === '' || !tenantId) return null;
  const digits = String(phone).replace(/\D/g, '');
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
    String(phone),
    phoneDigits,
  );
  return rows[0] ?? null;
}

// Single-subject routes refuse (enforce) rather than fall through when the
// subject cannot be resolved; the shared-list guard must never block a list
// that simply has no patient filter.
const guardRxById = prescriptionGuard(selectRxPatientByParam('id'), { requirePatientContext: true });
const guardRejectedRxAmendment = enforcedPrescriptionGuard(
  selectRxPatientByParam('id'),
  { requirePatientContext: true },
);
const guardRxByAppointment = prescriptionGuard(selectRxPatientByAppointment, { requirePatientContext: true });
const guardRxCreate = prescriptionGuard(selectRxPatientFromBody, { requirePatientContext: true });
const guardRxListFilter = prescriptionGuard(selectRxListFilterPatient, { requirePatientContext: false });

export const __guardTesting__ = Object.freeze({
  selectRxPatientByParam,
  selectRxPatientByAppointment,
  selectRxPatientFromBody,
  selectRxListFilterPatient,
});

// Multer for handwritten prescription photo
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: prescriptionAttachmentFileFilter
});

// Static paths BEFORE /:id

// Shared formulary type-ahead for clinical prescribing screens. This reuses
// the pharmacy catalog controller, but keeps OP/IP prescription screens away
// from the broader /pharmacy-orders route surface.
wrapAutoRBAC(router, 'pharmacyCatalogRoutes', {
  get: [['/catalog', [], pharmacyOrderController.getCatalog]]
});

// Staff/admin create prescription — idempotency-key middleware on
// /create so retries don't duplicate scripts. Header-driven, optional.
wrapAutoRBAC(router, 'ePrescriptionCreateRoutes', {
  post: [
    ['/create',
      [
        requireIdempotencyKey({ required: false, scope: 'prescription_create' }),
        rejectMobileClinicalWrite,
        upload.single('handwritten_photo'),
        // Magic-byte content check: the multer fileFilter above only inspects
        // the declared Content-Type, so a spoofed file (e.g. a script renamed
        // .jpg with an image/jpeg MIME) would otherwise reach R2. Run after
        // multer so the buffer is available, before the handler uploads it.
        validateFileContent,
        // After multer: a multipart create only has body.patient_id once the
        // form is parsed. Resolves the same body.patient_id the handler will
        // prescribe against.
        guardRxCreate,
      ],
      ePrescriptionController.createPrescription],
    // Safety preview reads the named patient's allergy + active-medication
    // history — a single-subject PHI read keyed on body.patient_id.
    ['/safety-check', [guardRxCreate], ePrescriptionController.previewSafetyCheck]
  ]
});

// Patient: my prescriptions (self-scoped)
wrapAutoRBAC(router, 'ePrescriptionPatientRoutes', {
  get: [
    ['/patient/my', [], ePrescriptionController.getMyPrescriptions]
  ]
});

// Staff/pharmacy: list ALL prescriptions. NOT patient-accessible — getAllPrescriptions
// is unscoped (WHERE 1=1), so PATIENT here = enumerate everyone's PHI (Sol Ultra #11).
// The guard decides only when the caller narrows the list to one patient
// (query.patient_id / query.phone); an unfiltered triage list has no single
// subject and stays on the role gate — patient context is NOT forced here.
wrapAutoRBAC(router, 'ePrescriptionListAllRoutes', {
  get: [
    ['/all', [guardRxListFilter], ePrescriptionController.getAllPrescriptions]
  ]
});

// By appointment — the subject is the patient of the prescription row the
// handler picks for that appointment.
wrapAutoRBAC(router, 'ePrescriptionAppointmentRoutes', {
  get: [
    ['/appointment/:appointmentId', [guardRxByAppointment], ePrescriptionController.getPrescriptionByAppointment]
  ]
});

// PDF download
wrapAutoRBAC(router, 'ePrescriptionPdfRoutes', {
  get: [
    ['/pdf/:id', [guardRxById], ePrescriptionController.downloadPrescriptionPDF]
  ]
});

wrapAutoRBAC(router, 'ePrescriptionStaffPdfRoutes', {
  get: [
    ['/:id/print-pdf', [guardRxById], ePrescriptionController.printPrescriptionPDF]
  ]
});

// A rejected pharmacy-linked prescription is immutable through the generic
// update route. This dedicated command preserves the rejection evidence and
// advances the exact linked prescription/order versions so the pharmacist must
// perform a fresh verification before any fulfilment can continue.
wrapAutoRBAC(router, 'ePrescriptionRejectedAmendmentRoutes', {
  post: [
    ['/:id/amend-rejected-pharmacy-order', [
      rejectMobileClinicalWrite,
      guardRejectedRxAmendment,
      requireIdempotencyKey({
        required: true,
        scope: 'prescription_amend_rejected_pharmacy_order',
        retainOnServerError: true,
        durableDomainReceipt: true,
        requestPathForIdempotency: (req) =>
          `/api/v1/prescriptions/${req.params.id}/amend-rejected-pharmacy-order`,
      }),
    ], rejectedPrescriptionAmendmentController.amendRejectedPharmacyOrder],
  ],
});

// Dynamic /:id routes last. Idempotency on the two write paths that
// create downstream pharmacy orders (order-pharmacy + refill). The guard runs
// before requireIdempotencyKey so a denial can never burn a client's
// idempotency-key claim.
wrapAutoRBAC(router, 'ePrescriptionDetailRoutes', {
  get: [
    ['/:id', [guardRxById], ePrescriptionController.getPrescription],
    ['/:id/safety', [guardRxById], ePrescriptionController.getPrescriptionSafety]
  ],
  put: [
    ['/:id', [rejectMobileClinicalWrite, guardRxById], ePrescriptionController.updatePrescription]
  ],
  post: [
    ['/:id/sign', [rejectMobileClinicalWrite, guardRxById], ePrescriptionController.signPrescription],
    ['/:id/order-pharmacy',
      [rejectMobileClinicalWrite, guardRxById, requireIdempotencyKey({
        required: true,
        scope: 'prescription_order_pharmacy',
        retainOnServerError: true,
        durableDomainReceipt: true,
        requestPathForIdempotency: (req) => `/api/v1/prescriptions/${req.params.id}/order-pharmacy`,
      })],
      ePrescriptionController.orderPharmacyFromPrescription],
    ['/:id/refill',
      [rejectMobileClinicalWrite, guardRxById, requireIdempotencyKey({
        required: true,
        scope: 'prescription_refill',
        retainOnServerError: true,
        durableDomainReceipt: true,
        requestPathForIdempotency: (req) => `/api/v1/prescriptions/${req.params.id}/refill`,
      })],
      ePrescriptionController.orderPharmacyFromPrescription]
  ]
});

export default router;
