// src/routes/portal/patientPortalRoutes.js
//
// Sprint 10 — patient self-service surface. Mounted at
// /api/v1/portal/* and /api/v1/patient/* with PATIENT-role gating.
// Every endpoint scopes to
// req.user.uid; we never trust a body-provided patient_uid.
//
// Bill payment, lab results, secure messaging.

import crypto from 'crypto';
import { Router } from 'express';
import { getPatientAppointments } from '../../controllers/appointment/appointmentListController.js';
import { getMyPrescriptions } from '../../controllers/prescription/ePrescriptionController.js';
import { getHealthRecordsByPhone } from '../../controllers/record/patientRecordController.js';
import * as maternity from '../../services/maternity/maternityService.js';
import * as portal from '../../services/portal/patientPortalService.js';
import * as portalAccess from '../../services/portal/portalAccessService.js';
import {
  getPatientReferral,
  listPatientReferrals,
} from '../../services/portal/patientReferralService.js';
import { getPatientWhatsNext } from '../../services/carePlan/carePlanService.js';
import {
  getPatientTeleconsultLobbyStateForAppointment,
  issueJoinToken,
  recordTeleconsultConsent,
} from '../../services/telemedicine/teleconsultProvisioningService.js';
import { AppError } from '../../utils/AppError.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { phiAccessLogger } from '../../middleware/phiAccessMiddleware.js';
import { singleUpload, validateFileContent, validatePatientUpload } from '../../middleware/uploadMiddleware.js';
import { uploadFileToR2 } from '../../utils/r2Storage.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function patientUidOf(req) {
  return req?.user?.uid;
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
      // generic 500 that never relays raw err.message (the old branch leaked
      // it on non-prod deployments, where sanitize passes 5xx through).
      return relayAppError(res, err, 'Portal error');
    }
  };
}

function requirePatient(req, res, next) {
  if (req.user?.role !== 'PATIENT') {
    return error(res, 'Patient role required', 403);
  }
  if (!patientUidOf(req)) return error(res, 'Patient UID missing from token', 401);
  next();
}

const PROXY_SIGNATURE_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/jpg'];

function parseProxyGrantScope(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return ['results'];
  const trimmed = value.trim();
  if (!trimmed) return ['results'];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [String(parsed)];
  } catch {
    return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
  }
}

function normalizeSignatureMime(value) {
  const mime = String(value || '').trim().toLowerCase();
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

function signatureExtension(mime) {
  return normalizeSignatureMime(mime) === 'image/png' ? 'png' : 'jpg';
}

async function buildProxyGrantSignatureProof(req) {
  if (!req.file) return null;
  const mimeType = normalizeSignatureMime(req.file.mimetype);
  if (!PROXY_SIGNATURE_IMAGE_MIMES.includes(mimeType)) {
    throw AppError.badRequest('Proxy grant signature must be a PNG or JPEG image', 'PORTAL_PROXY_SIGNATURE_IMAGE_REQUIRED');
  }
  const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const tenantId = tenantOf(req);
  const storageKey = [
    'portal-proxy-grant-signatures',
    tenantId,
    patientUidOf(req),
    `${Date.now()}_${hash.slice(0, 12)}.${signatureExtension(mimeType)}`,
  ].join('/');
  const storageUrl = await uploadFileToR2(req.file.buffer, storageKey, mimeType);
  return {
    storageKey,
    storageUrl,
    mimeType,
    fileSize: req.file.size,
    sha256Hash: hash,
  };
}

async function requireActivePregnancy(req) {
  const active = await maternity.getActivePregnancyForPatient({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
  });
  if (!active) throw AppError.notFound('Active pregnancy not found');
  return active;
}

function useAuthenticatedPatientId(req, res, next) {
  const patientId = req.user?.id || req.user?.userId;
  if (!patientId) return error(res, 'Patient ID missing from token', 401);
  req.params.patient_id = String(patientId);
  next();
}

function useAuthenticatedPatientPhone(req, res, next) {
  if (!req.user?.phone) return error(res, 'Phone not available in token', 400);
  req.params.phone = req.user.phone;
  next();
}

function attachPatientPhiContext(req, _res, next) {
  req.phiContext = {
    ...(req.phiContext || {}),
    patientUid: patientUidOf(req),
  };
  next();
}

function signedUrlBaseOf(req) {
  const host = req.get('host');
  if (!host) return null;
  return `${req.protocol}://${host}`;
}

// ── Standard patient mobile contract ─────────────────────────────────
router.get('/command-center', requirePatient, wrap(async (req) =>
  portal.getPatientCommandCenter({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    patient_id: req.user?.id || req.user?.userId || null,
    acting: req.acting || null,
  }),
));

router.get('/appointments', requirePatient, useAuthenticatedPatientId, getPatientAppointments);

router.get('/records', requirePatient, useAuthenticatedPatientPhone, getHealthRecordsByPhone);

router.get('/prescriptions', requirePatient, getMyPrescriptions);

// Patient-facing care-plan projection: read-only "what's next" cards from
// patient-visible active goals plus open/scheduled follow-up plans.
router.get('/care-plans/whats-next', requirePatient, wrap(async (req) =>
  getPatientWhatsNext({
    tenantId: tenantOf(req),
    patientUid: patientUidOf(req),
    limit: req.query.limit,
  }),
));

// Patient-facing Rx PDF — returns a JSON envelope with a signed R2
// URL. Lazily regenerates the PDF if pdf_key is null (R2 outage at
// create time would otherwise leave it permanently un-downloadable).
// Finding 2026-05-10-pediatric-opd-patient-weight-based-rx-pdf-missing.
router.get('/prescriptions/:id/pdf', requirePatient, wrap(async (req) => {
  const result = await portal.getOrGenerateMyPrescriptionPdfUrl({
    patient_uid: patientUidOf(req),
    prescription_id: req.params.id,
  });
  logPhiAccess({
    userId: req.user?.uid,
    userRole: req.user?.role,
    patientId: req.user?.uid,
    recordType: 'e_prescription_pdf',
    action: 'EXPORT',
    ip: req.ip,
    requestId: req.id,
  });
  return result;
}));


// ── Bills ────────────────────────────────────────────────────────────
router.get('/bills', requirePatient, wrap(async (req) =>
  portal.listMyBills({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    status: req.query.status,
  }),
));

router.get('/bills/:id', requirePatient, wrap(async (req) =>
  portal.getMyBill({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    id: req.params.id,
  }),
));

router.post('/bills/:id/payment-link', requirePatient, wrap(async (req) =>
  portal.createSelfPaymentLink({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    invoice_id: req.params.id,
  }),
));

// Patient-facing invoice PDF download. Streams the generated binary
// rather than going through `wrap`/`success` which assume a JSON
// envelope. PHI access is logged so HIPAA audit captures the download.
router.get('/bills/:id/pdf', requirePatient, async (req, res) => {
  try {
    const buffer = await portal.generateMyInvoicePdfBuffer({
      tenantId: tenantOf(req),
      patient_uid: patientUidOf(req),
      id: req.params.id,
    });
    logPhiAccess({
      userId: req.user?.uid,
      userRole: req.user?.role,
      patientId: req.user?.uid,
      recordType: 'billing_invoice_pdf',
      action: 'EXPORT',
      ip: req.ip,
      requestId: req.id,
    });
    const filename = `Invoice_${req.params.id}_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (err) {
    // Nothing above can throw after headers are written, so responding here
    // is safe. relayAppError also replaces the old `next(err)` fallthrough:
    // the global handler relayed raw err.message on non-prod deployments.
    return relayAppError(res, err, 'patient bill PDF error');
  }
});

// ── B-6 — patient-side discharge PDF ────────────────────────────────
router.get('/discharge/:admissionId/pdf', requirePatient, wrap(async (req) =>
  portal.getMyDischargePdfUrl({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    admission_id: req.params.admissionId,
  }),
));

// ── Discharge summary read surface ──────────────────────────────────
router.get('/discharge-summaries', requirePatient, wrap(async (req) =>
  portal.listMyDischargeSummaries({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    limit: req.query.limit,
  }),
));

router.get('/discharge-summaries/admission/:admissionId', requirePatient, wrap(async (req) =>
  portal.getMyDischargeSummaryByAdmission({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    admission_id: req.params.admissionId,
  }),
));

// Patient-facing discharge-summary PDF download. Streams the binary
// (like /bills/:id/pdf) rather than the JSON envelope. Ownership is
// enforced inside generateMyDischargeSummaryPdfBuffer → getMyDischargeSummary
// (scoped by patient_uid). Declared BEFORE /discharge-summaries/:id so
// the more-specific /pdf + /download paths win the route match.
// PHI access logged as EXPORT for HIPAA audit.
async function sendMyDischargeSummaryPdf(req, res) {
  try {
    const buffer = await portal.generateMyDischargeSummaryPdfBuffer({
      tenantId: tenantOf(req),
      patient_uid: patientUidOf(req),
      id: req.params.id,
    });
    logPhiAccess({
      userId: req.user?.uid,
      userRole: req.user?.role,
      patientId: req.user?.uid,
      recordType: 'discharge_summary_pdf',
      action: 'EXPORT',
      ip: req.ip,
      requestId: req.id,
    });
    const filename = `Discharge_Summary_${req.params.id}_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (err) {
    // Nothing above can throw after headers are written, so responding here
    // is safe. relayAppError also replaces the old `next(err)` fallthrough:
    // the global handler relayed raw err.message on non-prod deployments.
    return relayAppError(res, err, 'patient discharge summary PDF error');
  }
}

router.get('/discharge-summaries/:id/pdf', requirePatient, sendMyDischargeSummaryPdf);
router.get('/discharge-summaries/:id/download', requirePatient, sendMyDischargeSummaryPdf);

router.get('/discharge-summaries/:id', requirePatient, wrap(async (req) =>
  portal.getMyDischargeSummary({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    id: req.params.id,
  }),
));

// ── Clinical notes (patient self-read) ──────────────────────────────
// /api/v1/emr/notes is staff-only by RBAC (CLINICAL_STAFF_ROLES). The
// patient-scoped equivalent lives here, returning only signed OP
// appointment-bound notes owned by the authenticated patient_uid and
// filtered to patient-visible consultation/follow-up/progress/SOAP
// types. IP/ward/procedure/discharge source notes stay off the portal.
// PHI access is logged per read.
// Finding 2026-05-09-follow-up-opd-patient-progress-note-not-visible.

function logClinicalNoteAccess(req) {
  logPhiAccess({
    userId: req.user?.uid,
    userRole: req.user?.role,
    patientId: req.user?.uid,
    recordType: 'clinical_note',
    action: 'VIEW',
    ip: req.ip,
    requestId: req.id,
  });
}

router.get('/clinical-notes', requirePatient, wrap(async (req) => {
  const result = await portal.listMyClinicalNotes({
    patient_uid: patientUidOf(req),
    note_type: req.query.note_type || null,
    limit: req.query.limit,
  });
  logClinicalNoteAccess(req);
  return result;
}));

router.get('/clinical-notes/appointment/:appointmentId', requirePatient, wrap(async (req) => {
  const result = await portal.listMyClinicalNotesForAppointment({
    patient_uid: patientUidOf(req),
    appointment_id: req.params.appointmentId,
  });
  logClinicalNoteAccess(req);
  return result;
}));

router.get('/clinical-notes/:id', requirePatient, wrap(async (req) => {
  const result = await portal.getMyClinicalNote({
    patient_uid: patientUidOf(req),
    id: req.params.id,
  });
  logClinicalNoteAccess(req);
  return result;
}));

// -- Teleconsult lobby (patient self) ---------------------------------------
// The patient app enters from an appointment card/detail. These routes derive
// patient_uid from the authenticated token and never accept a body patient_uid.

router.get('/teleconsult/appointments/:appointmentId/lobby-state', requirePatient, wrap(async (req) => {
  return getPatientTeleconsultLobbyStateForAppointment({
    tenantId: tenantOf(req),
    appointmentId: req.params.appointmentId,
    actorUid: patientUidOf(req),
  });
}));

router.post('/teleconsult/teleconsultations/:teleconsultationId/consent', requirePatient, wrap(async (req) =>
  recordTeleconsultConsent({
    tenantId: tenantOf(req),
    teleconsultationId: req.params.teleconsultationId,
    participantUid: patientUidOf(req),
    actorUid: patientUidOf(req),
    actorRole: 'PATIENT',
    consentPayload: req.body?.consent_payload || req.body || {},
    ipAddress: req.ip,
  }),
));

router.post('/teleconsult/teleconsultations/:teleconsultationId/token', requirePatient, wrap(async (req) =>
  issueJoinToken({
    tenantId: tenantOf(req),
    teleconsultationId: req.params.teleconsultationId,
    participantUid: patientUidOf(req),
    role: 'patient',
  }),
));

// ── Clinical AI explainers (accepted human-review outputs only) ──────
router.get('/explainers', requirePatient, attachPatientPhiContext, wrap(async (req) =>
  portal.listMyExplainers({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    limit: req.query.limit,
  }),
));

router.get('/explainers/:id', requirePatient, attachPatientPhiContext, wrap(async (req) =>
  portal.getMyExplainer({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    id: req.params.id,
  }),
));

// ── B-5 — TPA / insurance claims (read-only) ────────────────────────
router.get('/tpa/claims', requirePatient, wrap(async (req) =>
  portal.listMyClaims({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    status: req.query.status || null,
  }),
));

router.get('/tpa/claims/:id', requirePatient, wrap(async (req) =>
  portal.getMyClaim({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    id: req.params.id,
  }),
));

// `for_patient` is the ONE sanctioned exception to "never trust a
// caller-provided patient uid": it only ever resolves through an active
// proxy grant (E6) and every proxy read is audited with the grant id.
async function effectivePatientAccess(req, scope = 'results') {
  return portalAccess.resolvePortalPatient({
    requesterUid: patientUidOf(req),
    forPatientUid: req.query.for_patient || null,
    scope,
  });
}

async function effectivePatientUid(req, scope = 'results') {
  const resolved = await effectivePatientAccess(req, scope);
  return resolved.patientUid;
}

// D69 — Patient TPA claim documents. Read-only list of the document
// metadata attached to a claim (and to its parent preauth, since the
// hospital often uploads supporting scans against the preauth before
// the claim is filed). Returns only patient-visible columns — no
// staff uploaded_by uid, no internal review notes. The patient app
// renders the list with the doc_type / file_name / size / timestamp;
// downloads go through a separate short-lived signed-URL endpoint
// below. The list endpoint must remain metadata-only.
// Findings: 95008441, 0a3e84c3.
router.get('/tpa/claims/:id/documents', requirePatient, wrap(async (req) =>
  portal.listMyClaimDocuments({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    id: req.params.id,
  }),
));

router.get(
  '/tpa/claims/:id/documents/:docId/download-url',
  requirePatient,
  attachPatientPhiContext,
  phiAccessLogger('TPA_CLAIM_DOCUMENT'),
  wrap(async (req) => {
    const access = await effectivePatientAccess(req, 'claim_documents');
    req.phiContext = {
      ...(req.phiContext || {}),
      patientUid: access.patientUid,
    };
    return portal.getMyClaimDocumentDownloadUrl({
      tenantId: tenantOf(req),
      patient_uid: access.patientUid,
      claim_id: req.params.id,
      doc_id: req.params.docId,
      baseUrl: signedUrlBaseOf(req),
      actorUid: patientUidOf(req),
      actorRole: req.user?.role,
      requestId: req.id,
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      proxyGrantId: access.grantId || null,
    });
  }),
);

// ── Lab results ─────────────────────────────────────────────────────
router.get('/lab-results', requirePatient, wrap(async (req) =>
  portal.listMyLabResults({
    tenantId: tenantOf(req),
    patient_uid: await effectivePatientUid(req),
    limit: req.query.limit,
  }),
));

// E6 — longitudinal trend series for one test (released results only).
// Registered before '/lab-results/:id' so 'trends' never parses as an id.
router.get('/lab-results/trends', requirePatient, wrap(async (req) =>
  portalAccess.getLabTrend({
    tenantId: tenantOf(req),
    patientUid: await effectivePatientUid(req),
    testCode: req.query.test_code || null,
    loincCode: req.query.loinc_code || null,
    months: req.query.months,
  }),
));

router.get('/lab-results/:id', requirePatient, wrap(async (req) =>
  portal.getMyLabResult({
    tenantId: tenantOf(req),
    patient_uid: await effectivePatientUid(req),
    id: req.params.id,
  }),
));

router.get('/diagnostic-results', requirePatient, wrap(async (req) =>
  portal.listMyStructuredDiagnosticResults({
    tenantId: tenantOf(req),
    patient_uid: await effectivePatientUid(req),
    limit: req.query.limit,
  }),
));

router.get('/diagnostic-results/:id', requirePatient, wrap(async (req) =>
  portal.getMyStructuredDiagnosticResult({
    tenantId: tenantOf(req),
    patient_uid: await effectivePatientUid(req),
    id: req.params.id,
  }),
));

router.get('/referrals', requirePatient, wrap(async (req) =>
  listPatientReferrals({
    tenantId: tenantOf(req),
    patientUid: await effectivePatientUid(req),
    limit: req.query.limit,
  }),
));

router.get('/referrals/:id', requirePatient, wrap(async (req) =>
  getPatientReferral({
    tenantId: tenantOf(req),
    patientUid: await effectivePatientUid(req),
    id: req.params.id,
  }),
));

// ── Proxy access grants (E6 — consent trail) ────────────────────────
router.post('/proxy/grants', requirePatient, singleUpload, validatePatientUpload, validateFileContent, wrap(async (req) =>
  portalAccess.createProxyGrant({
    patientUid: patientUidOf(req),
    proxyUid: req.body.proxy_uid,
    relationship: req.body.relationship || null,
    scope: parseProxyGrantScope(req.body.scope),
    consentMethod: req.body.consent_method,
    consentRef: req.body.consent_ref || null,
    expiresAt: req.body.expires_at || null,
    signatureProof: await buildProxyGrantSignatureProof(req),
  }, { actorUid: patientUidOf(req), actorRole: null }),
));

router.get('/proxy/grants', requirePatient, wrap(async (req) =>
  portalAccess.listProxyGrants(patientUidOf(req)),
));

router.post('/proxy/grants/:id/revoke', requirePatient, wrap(async (req) =>
  portalAccess.revokeProxyGrant(req.params.id, {
    reason: req.body.reason || null,
  }, { actorUid: patientUidOf(req), actorRole: null }),
));

// ── Lab orders (patient-actionable collection + report download) ───
router.get('/lab-orders', requirePatient, wrap(async (req) =>
  portal.listMyLabOrders({
    tenantId: tenantOf(req),
    patient_uid: await effectivePatientUid(req),
    status: req.query.status,
    limit: req.query.limit,
  }),
));

router.get('/lab-orders/:id', requirePatient, wrap(async (req) =>
  portal.getMyLabOrder({
    tenantId: tenantOf(req),
    patient_uid: await effectivePatientUid(req),
    id: req.params.id,
  }),
));

// Binary PDF stream — bypass `wrap`/`success` which assume a JSON
// envelope. PHI access is logged so HIPAA audit captures the download.
router.get('/lab-orders/:id/pdf', requirePatient, async (req, res) => {
  try {
    const buffer = await portal.generateMyLabOrderPdfBuffer({
      tenantId: tenantOf(req),
      patient_uid: await effectivePatientUid(req),
      id: req.params.id,
    });
    logPhiAccess({
      userId: req.user?.uid,
      userRole: req.user?.role,
      patientId: req.user?.uid,
      recordType: 'lab_report_pdf',
      action: 'EXPORT',
      ip: req.ip,
      requestId: req.id,
    });
    const filename =
      `LabReport_${req.params.id}_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);
  } catch (err) {
    // Nothing above can throw after headers are written, so responding here
    // is safe. relayAppError also replaces the old `next(err)` fallthrough:
    // the global handler relayed raw err.message on non-prod deployments.
    return relayAppError(res, err, 'patient lab report PDF error');
  }
});

// ── Maternity / ANC ─────────────────────────────────────────────────
router.get('/maternity/timeline', requirePatient, wrap(async (req) => {
  const timeline = await maternity.getAncTimelineForPatient({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
  });
  return maternity.projectAncTimelineForPatient(timeline);
}));

router.get('/maternity/fetal-kicks', requirePatient, wrap(async (req) => {
  const active = await maternity.getActivePregnancyForPatient({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
  });
  if (!active) return { pregnancy: null, fetal_kicks: [] };
  const fetalKicks = await maternity.listFetalKicks({
    tenantId: tenantOf(req),
    pregnancy_id: active.id,
    fromDate: req.query.from || null,
    toDate: req.query.to || null,
  });
  return { pregnancy: active, fetal_kicks: fetalKicks };
}));

router.post('/maternity/fetal-kicks', requirePatient, wrap(async (req) => {
  const active = await requireActivePregnancy(req);
  return maternity.recordFetalKick({
    tenantId: tenantOf(req),
    pregnancy_id: active.id,
    log_date: req.body.log_date,
    kick_count: req.body.kick_count,
    observation_window_minutes: req.body.observation_window_minutes,
    notes: req.body.notes,
    recorded_by: patientUidOf(req),
    actor_uid: req.user?.uid,
    actor_role: req.user?.role,
  });
}));

router.patch('/maternity/supplements/:id/reminder', requirePatient, wrap(async (req) => {
  const active = await requireActivePregnancy(req);
  return maternity.setSupplementReminder({
    tenantId: tenantOf(req),
    pregnancy_id: active.id,
    supplement_id: req.params.id,
    reminder_enabled: req.body.reminder_enabled,
    actor_uid: req.user?.uid,
    actor_role: req.user?.role,
  });
}));

// ── Maternity packages (patient pre-booking surface) ────────────────
// ANC patients ask about delivery package pricing at registration.
// The /api/v1/maternity/* router is staff/admin-gated, so the
// patient-readable view lives here. Prices are placeheld until
// finance review (migration 226). Finding:
// 2026-05-09-walk-in-opd-patient-maternity-package-forbidden.
router.get('/maternity/packages', requirePatient, wrap(async (req) =>
  maternity.listMaternityPackages({ tenantId: tenantOf(req) }),
));

// ── ANC trimester advice (patient self-monitoring surface) ──────────
// Danger signs, reduced-fetal-movement guidance, foods to avoid, when
// to contact the hospital. Decorated with the patient's current
// trimester when they have an active pregnancy so the app can
// highlight the relevant section. Content is review-placeheld
// (migration 226). The patient fetal-kick counter routes already
// exist above (GET/POST /maternity/fetal-kicks). Finding:
// 2026-05-10-obstetric-anc-patient-no-kick-counter-or-ob-advice.
router.get('/maternity/anc-advice', requirePatient, wrap(async (req) => {
  const active = await maternity.getActivePregnancyForPatient({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
  });
  let currentTrimester = null;
  const weeks = active?.gestational_age?.weeks;
  if (weeks != null) currentTrimester = weeks < 14 ? 1 : weeks < 28 ? 2 : 3;
  const advice = await maternity.getAncAdvice({
    tenantId: tenantOf(req),
    trimester: req.query.trimester ?? null,
    language: req.query.language || 'hi',
    includePlaceholders: false,
  });
  return {
    current_trimester: currentTrimester,
    gestational_age: active?.gestational_age ?? null,
    content_pending_review: advice.some((row) => row.content_status === 'pending_clinical_review'),
    advice,
  };
}));

// ── Secure messaging ────────────────────────────────────────────────
router.get('/messages', requirePatient, wrap(async (req) =>
  portal.listMyThreads({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    status: req.query.status,
    limit: req.query.limit,
  }),
));

router.post('/messages/appointment/:appointmentId/teleconsult-fallback', requirePatient, wrap(async (req) =>
  portal.ensureAppointmentThread({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    appointment_id: req.params.appointmentId,
    subject: req.body?.subject,
    body: req.body?.body,
  }),
));

router.get('/messages/:threadId', requirePatient, wrap(async (req) =>
  portal.getThread({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    thread_id: req.params.threadId,
    viewer_kind: 'patient',
  }),
));

router.post('/messages', requirePatient, wrap(async (req) =>
  portal.startThread({
    ...req.body,
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
  }),
));

router.post('/messages/:threadId/reply', requirePatient, wrap(async (req) =>
  portal.appendMessage({
    tenantId: tenantOf(req),
    thread_id: req.params.threadId,
    sender_kind: 'patient',
    sender_uid: patientUidOf(req),
    sender_name: req.user?.name,
    body: req.body.body,
    attachments: req.body.attachments,
    patient_uid: patientUidOf(req),
  }),
));

router.post('/messages/:threadId/read', requirePatient, wrap(async (req) =>
  portal.markThreadRead({
    tenantId: tenantOf(req),
    thread_id: req.params.threadId,
    reader_kind: 'patient',
    patient_uid: patientUidOf(req),
  }),
));

export default router;
