// src/routes/appointment/appointmentWorkflowRoutes.js
import express from 'express';
import * as workflowController from '../../controllers/appointment/appointmentWorkflowController.js';
import * as docController from '../../controllers/appointment/appointmentDocumentController.js';
import * as adminController from '../../controllers/appointment/appointmentAdminController.js';
import { upload } from '../../middleware/uploadMiddleware.js';

const router = express.Router();

// ── Staff workflow ────────────────────────────────────────────────────────────
// IMPORTANT: Static paths must come BEFORE /:id param routes

// Queue, pending, slots, walk-in (static paths — must be before /:id)
router.get('/queue/today', workflowController.getTodayQueue);
router.get('/pending', workflowController.getPendingAppointments);
router.get('/slots', workflowController.getAvailableSlots);
router.post('/walk-in', workflowController.registerWalkIn);

// Patient records
router.get('/patient/records/all', docController.getPatientAllRecords);
router.post('/patient/records/upload', upload.single('file'), docController.uploadPatientRecord);
router.delete('/patient/records/:id', docController.deletePatientRecord);

// Document upload (staff)
router.post('/documents/upload', upload.single('file'), docController.uploadAppointmentDocument);

// Admin SLA dashboard and audit trail
router.get('/admin/sla-dashboard', adminController.getAppointmentSLADashboard);
router.get('/admin/audit-trail', adminController.getStatusAuditTrail);
router.get('/admin/documents', docController.getAllDocumentsAdmin);

// ── Per-appointment actions (parameterized) ──────────────────────────────────
router.post('/:id/confirm', workflowController.confirmAppointment);
router.post('/:id/no-show', workflowController.markNoShow);
router.post('/:id/complete', workflowController.completeAppointment);
router.post('/:id/cancel', workflowController.cancelAppointment);
router.get('/:id/history', workflowController.getAppointmentHistory);
router.get('/:appointment_id/documents', docController.getAppointmentDocuments);

export default router;
