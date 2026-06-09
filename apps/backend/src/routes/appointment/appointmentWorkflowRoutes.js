// src/routes/appointment/appointmentWorkflowRoutes.js
import express from 'express';
import { validationResult } from 'express-validator';
import * as adminController from '../../controllers/appointment/appointmentAdminController.js';
import * as docController from '../../controllers/appointment/appointmentDocumentController.js';
import * as workflowController from '../../controllers/appointment/appointmentWorkflowController.js';
import { patientAccessGuard, patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import { rejectMobileClinicalWrite } from '../../middleware/rejectMobileClinicalWriteMiddleware.js';
import { upload, validateFileContent, validatePatientUpload } from '../../middleware/uploadMiddleware.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import { paramId } from '../../validators/sharedValidators.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = express.Router();

const guardAppointmentView = patientAccessGuardForResource('APPOINTMENT', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_VIEW,
  resourceType: 'appointment',
  allowNoPatientResource: true,
});
const guardAppointmentWrite = patientAccessGuardForResource('APPOINTMENT', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_WRITE,
  resourceType: 'appointment',
  allowNoPatientResource: true,
});
const guardAppointmentDocumentView = patientAccessGuardForResource('APPOINTMENT', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_VIEW,
  resourceType: 'appointment',
  idParam: 'appointment_id',
  allowNoPatientResource: true,
});
const guardAppointmentDocumentUpload = patientAccessGuardForResource('APPOINTMENT', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_WRITE,
  resourceType: 'appointment',
  idSelector: (req) => req.body?.appointment_id || req.body?.appointmentId || req.query?.appointment_id || null,
  allowNoPatientResource: true,
});

// ── Staff workflow ────────────────────────────────────────────────────────────
// IMPORTANT: Static paths must come BEFORE /:id param routes

// Queue, pending, slots, walk-in (static paths — must be before /:id)
router.get('/queue/today', workflowController.getTodayQueue);
// A9 — doctor's "my queue" alias. Pulls doctor_id from JWT instead of
// requiring the caller to thread it. Matches the /notifications/my
// pattern from PHI-mitigation guidance.
router.get('/queue/today/mine', (req, _res, next) => {
  req.params.scope = 'mine';
  return workflowController.getTodayQueue(req, _res, next);
});
router.get('/pending', workflowController.getPendingAppointments);
router.get('/doctors/options', workflowController.getDoctorOptions);
router.get('/slots', workflowController.getAvailableSlots);
// Don't unconditionally require `patient_name`. When the caller supplies
// `patient_phone` (or `patient_id`) for a returning patient the backend
// already has the name on file, and forcing the receptionist to re-type
// the child's name on every paeds follow-up adds 15-20s of friction per
// registration. The controller falls back to the stored name when
// patient_name is absent. Finding:
// 2026-05-09-pediatric-opd-receptionist-patient-name-required-for-returning.
router.post('/walk-in', validate, workflowController.registerWalkIn);

// Patient records
router.get('/patient/records/all', patientAccessGuard('MEDICAL_RECORD'), docController.getPatientAllRecords);
router.post('/patient/records/upload', upload.single('file'), patientAccessGuard('MEDICAL_RECORD', { policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_UPLOAD }), validateFileContent, validatePatientUpload, docController.uploadPatientRecord);
router.get('/patient/records/:id/extraction', docController.getPatientRecordExtraction);
router.post('/patient/records/:id/extraction/process', docController.processPatientRecordExtraction);
router.patch('/patient/records/:id/extraction-review', docController.reviewPatientRecordExtraction);
router.delete('/patient/records/:id', docController.deletePatientRecord);

// Document upload (staff)
router.post('/documents/upload', upload.single('file'), guardAppointmentDocumentUpload, validateFileContent, docController.uploadAppointmentDocument);

// Admin SLA dashboard and audit trail
router.get('/admin/sla-dashboard', adminController.getAppointmentSLADashboard);
router.get('/admin/audit-trail', adminController.getStatusAuditTrail);
router.get('/admin/documents', docController.getAllDocumentsAdmin);

// ── Per-appointment actions (parameterized) ──────────────────────────────────
router.post('/:id/confirm', paramId(), validate, guardAppointmentWrite, workflowController.confirmAppointment);
router.post('/:id/no-show', paramId(), validate, guardAppointmentWrite, workflowController.markNoShow);
router.post('/:id/reschedule', paramId(), validate, guardAppointmentWrite, workflowController.rescheduleAppointment);
router.post('/:id/complete', rejectMobileClinicalWrite, paramId(), validate, guardAppointmentWrite, workflowController.completeAppointment);
router.post('/:id/cancel', paramId(), validate, guardAppointmentWrite, workflowController.cancelAppointment);
// OPD→IPD bridge: doctor flips this on a visit; admission counter sees it.
router.post('/:id/advise-admission', rejectMobileClinicalWrite, paramId(), validate, guardAppointmentWrite, workflowController.adviseForAdmission);
router.get('/:id/history', guardAppointmentView, workflowController.getAppointmentHistory);
router.get('/:appointment_id/documents', guardAppointmentDocumentView, docController.getAppointmentDocuments);

export default router;
