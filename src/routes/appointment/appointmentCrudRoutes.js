import express from 'express';
import { param } from 'express-validator';
import * as crudController from '../../controllers/appointment/appointmentCrudController.js';
import * as statusController from '../../controllers/appointment/appointmentStatusController.js';
import { sanitizeAppointmentFields } from '../../middleware/sanitizeMiddleware.js';
import * as validators from '../../validators/appointment/appointmentValidators.js';

const router = express.Router();

// Shared param validator for :id
const idParamValidator = param('id').isInt({ min: 1 }).withMessage('Valid appointment ID required');

// Create appointment
router.post('/book', validators.createAppointmentValidators, sanitizeAppointmentFields, crudController.createAppointment);

// Update appointment
router.put('/:id', validators.updateAppointmentValidators, sanitizeAppointmentFields, crudController.updateAppointment);

// Update appointment status
router.put('/:id/status', validators.updateStatusValidators, statusController.updateAppointmentStatus);

// Delete/Cancel appointment (with ID validation — IDOR check is in controller via checkAppointmentPermission)
router.delete('/:id', idParamValidator, crudController.deleteAppointment);

export default router;