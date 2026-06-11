// src/routes/dashboard/index.js
// Patient dashboard route — JWT + PATIENT role (enforced at mount in app.js).

import express from 'express';
import { getPatientDashboard } from '../../controllers/dashboard/dashboardController.js';

const router = express.Router();

/**
 * GET /api/v1/dashboard
 * Returns the authenticated patient's summary: name, last appointment,
 * next appointment, upcoming count. The subject is derived from the JWT
 * (req.user) — a caller-supplied ?phone= is only accepted when it matches
 * the caller's own phone (audit finding H1).
 */
router.get('/', getPatientDashboard);

export default router;
