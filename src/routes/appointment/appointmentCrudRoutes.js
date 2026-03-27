import express from 'express';
import * as crudController from '../../controllers/appointment/appointmentCrudController.js';
import * as statusController from '../../controllers/appointment/appointmentStatusController.js';
import { sanitizeAppointmentFields } from '../../middleware/sanitizeMiddleware.js';
import * as validators from '../../validators/appointment/appointmentValidators.js';

const router = express.Router();

// Create appointment
router.post('/book', validators.createAppointmentValidators, sanitizeAppointmentFields, crudController.createAppointment);

// Update appointment
router.put('/:id', validators.updateAppointmentValidators, sanitizeAppointmentFields, crudController.updateAppointment);

// Update appointment status
router.put('/:id/status', validators.updateStatusValidators, statusController.updateAppointmentStatus);

// Delete/Cancel appointment
router.delete('/:id', crudController.deleteAppointment);

export default router;