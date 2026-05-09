// src/routes/portal/patientPortalRoutes.js
//
// Sprint 10 — patient self-service surface. Mounted at
// /api/v1/portal/* with PATIENT-role gating. Every endpoint scopes to
// req.user.uid; we never trust a body-provided patient_uid.
//
// Bill payment, lab results, secure messaging.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as portal from '../../services/portal/patientPortalService.js';
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

// ── B-6 — patient-side discharge PDF ────────────────────────────────
router.get('/discharge/:admissionId/pdf', requirePatient, wrap(async (req) =>
  portal.getMyDischargePdfUrl({
    tenantId: tenantOf(req),
    patient_uid: patientUidOf(req),
    admission_id: req.params.admissionId,
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
