import express from 'express';
import { param } from 'express-validator';
import * as crudController from '../../controllers/appointment/appointmentCrudController.js';
import * as statusController from '../../controllers/appointment/appointmentStatusController.js';
import { patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import { sanitizeAppointmentFields } from '../../middleware/sanitizeMiddleware.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import * as validators from '../../validators/appointment/appointmentValidators.js';

const router = express.Router();

// Shared param validator for :id
const idParamValidator = param('id').isInt({ min: 1 }).withMessage('Valid appointment ID required');
const guardAppointmentWrite = patientAccessGuardForResource('APPOINTMENT', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_WRITE,
  resourceType: 'appointment',
});

// Create appointment
router.post('/book', validators.createAppointmentValidators, sanitizeAppointmentFields, crudController.createAppointment);

// Update appointment
router.put('/:id', validators.updateAppointmentValidators, guardAppointmentWrite, sanitizeAppointmentFields, crudController.updateAppointment);

// Update appointment status
router.put('/:id/status', validators.updateStatusValidators, guardAppointmentWrite, statusController.updateAppointmentStatus);

// Delete/Cancel appointment (with ID validation — IDOR check is in controller via checkAppointmentPermission)
router.delete('/:id', idParamValidator, guardAppointmentWrite, crudController.deleteAppointment);

export default router;
