import express from 'express';
import * as waitTimeController from '../../controllers/appointment/waitTimeController.js';

const router = express.Router();

// IMPORTANT: Static paths must come BEFORE /:id param routes
// General wait time for a doctor today
router.get('/doctor/:doctorId/wait-time', waitTimeController.getWaitTimeForDoctor);

// Wait time estimate for a specific appointment
router.get('/:id/wait-time', waitTimeController.getWaitTimeForAppointment);

export default router;
