// src/routes/portal/patientPortalRoutes.js
//
// Sprint 10 — patient self-service surface. Mounted at
// /api/v1/portal/* and /api/v1/patient/* with PATIENT-role gating.
// Every endpoint scopes to
// req.user.uid; we never trust a body-provided patient_uid.
//
// Bill payment, lab results, secure messaging.

import { Router } from 'express';
import { getPatientAppointments } from '../../controllers/appointment/appointmentListController.js';
import { getMyPrescriptions } from '../../controllers/prescription/ePrescriptionController.js';
import { getHealthRecordsByPhone } from '../../controllers/record/patientRecordController.js';
import logger from '../../logging/logger.js';
import * as maternity from '../../services/maternity/maternityService.js';
import * as portal from '../../services/portal/patientPortalService.js';
import { AppError } from '../../utils/AppError.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success, error } from '../../utils/responseHelper.js';

const router = Router();

function tenantOf(req) {
  return req?.user?.tenantId || req?.tenant?.id ||
    '00000000-0000-4000-8000-000000000001';
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
      if (err.statusCode) return error(res, err.message, err.statusCode);
      logger.error('patient portal route error:', err);
      return error(res, err.message || 'Portal error', 500);
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

// ── Standard patient mobile contract ─────────────────────────────────
router.get('/appointments', requirePatient, useAuthenticatedPatientId, getPatientAppointments);

router.get('/records', requirePatient, useAuthenticatedPatientPhone, getHealthRecordsByPhone);

router.get('/prescriptions', requirePatient, getMyPrescriptions);


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
router.get('/bills/:id/pdf', requirePatient, async (req, res, next) => {
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
    if (err.statusCode) return error(res, err.message, err.statusCode);
    logger.error('patient bill PDF error:', err);
    return next(err);
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

router.get('/discharge-summaries/:id', requirePatient, wrap(async (req) =>
  portal.getMyDischargeSummary({
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

// ── Lab results ─────────────────────────────────────────────────────
router.get('/lab-results', requirePatient, wrap(async (req) =>
  portal.listMyLabResults({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    limit: req.query.limit,
  }),
));

router.get('/lab-results/:id', requirePatient, wrap(async (req) =>
  portal.getMyLabResult({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    id: req.params.id,
  }),
));

// ── Maternity / ANC ─────────────────────────────────────────────────
router.get('/maternity/timeline', requirePatient, wrap(async (req) =>
  maternity.getAncTimelineForPatient({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
  }),
));

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
  });
}));

router.patch('/maternity/supplements/:id/reminder', requirePatient, wrap(async (req) => {
  const active = await requireActivePregnancy(req);
  return maternity.setSupplementReminder({
    tenantId: tenantOf(req),
    pregnancy_id: active.id,
    supplement_id: req.params.id,
    reminder_enabled: req.body.reminder_enabled,
  });
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
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    ...req.body,
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
