import express from 'express';
import * as legacyController from '../../controllers/appointment/appointmentLegacyController.js';
import { legacyAppointmentValidators } from '../../validators/appointment/appointmentValidators.js';

const router = express.Router();

// Legacy routes for backward compatibility
router.post('/', legacyAppointmentValidators, legacyController.createLegacyAppointment);
router.get('/phone/:phone', legacyController.getAppointmentsByPhone);
router.get('/uid/:uid', legacyController.getAppointmentsByUID);

export default router;