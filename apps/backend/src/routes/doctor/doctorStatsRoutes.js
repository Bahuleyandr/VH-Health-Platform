// src/routes/doctor/doctorStatsRoutes.js
import express from 'express';
import { doctorStatsController } from '../../controllers/doctor/doctorStatsController.js';
import { doctorValidators } from '../../validators/doctor/doctorValidator.js';

const router = express.Router();

// Doctor statistics
router.get('/:id', doctorValidators.getStats, doctorStatsController.getDoctorStats);

export default router;