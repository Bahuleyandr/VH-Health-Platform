// src/routes/dashboard/index.js
// Patient dashboard route — API key only (no JWT)

import express from 'express';
import { getPatientDashboard } from '../../controllers/dashboard/dashboardController.js';

const router = express.Router();

/**
 * GET /api/v1/dashboard?phone=<phone>
 * Returns patient summary: name, last appointment, next appointment, upcoming count.
 * Protected by validateApiKey only (applied at mount in app.js).
 * Flutter app does not send JWT for this endpoint.
 */
router.get('/', getPatientDashboard);

export default router;
