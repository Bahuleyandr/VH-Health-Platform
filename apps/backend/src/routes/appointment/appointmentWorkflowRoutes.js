// src/routes/appointment/appointmentWorkflowRoutes.js
import express from 'express';
import { validationResult } from 'express-validator';
import * as adminController from '../../controllers/appointment/appointmentAdminController.js';
import * as docController from '../../controllers/appointment/appointmentDocumentController.js';
import * as workflowController from '../../controllers/appointment/appointmentWorkflowController.js';
import { upload, validateFileContent, validatePatientUpload } from '../../middleware/uploadMiddleware.js';
import { requiredString, paramId } from '../../validators/sharedValidators.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = express.Router();

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
router.post('/walk-in', requiredString('patient_name', 255), validate, workflowController.registerWalkIn);

// Patient records
router.get('/patient/records/all', docController.getPatientAllRecords);
router.post('/patient/records/upload', upload.single('file'), validateFileContent, validatePatientUpload, docController.uploadPatientRecord);
router.delete('/patient/records/:id', docController.deletePatientRecord);

// Document upload (staff)
router.post('/documents/upload', upload.single('file'), validateFileContent, docController.uploadAppointmentDocument);

// Admin SLA dashboard and audit trail
router.get('/admin/sla-dashboard', adminController.getAppointmentSLADashboard);
router.get('/admin/audit-trail', adminController.getStatusAuditTrail);
router.get('/admin/documents', docController.getAllDocumentsAdmin);

// ── Per-appointment actions (parameterized) ──────────────────────────────────
router.post('/:id/confirm', paramId(), validate, workflowController.confirmAppointment);
router.post('/:id/no-show', paramId(), validate, workflowController.markNoShow);
router.post('/:id/complete', paramId(), validate, workflowController.completeAppointment);
router.post('/:id/cancel', paramId(), validate, workflowController.cancelAppointment);
// OPD→IPD bridge: doctor flips this on a visit; admission counter sees it.
router.post('/:id/advise-admission', paramId(), validate, workflowController.adviseForAdmission);
router.get('/:id/history', workflowController.getAppointmentHistory);
router.get('/:appointment_id/documents', docController.getAppointmentDocuments);

export default router;
