// src/routes/chatbot/chatbotRoutes.js

import express from 'express';
import { ALL_STAFF_MESSAGING_ROUTE_ROLES } from '../../config/routeRolePolicy.js';
import { triage } from '../../controllers/chatbot/chatbotController.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';

const router = express.Router();

// POST /chatbot/triage — AI symptom-check. Rate-limited via the standard patient
// rate limiter applied at mount time. Keep the surface human-only: machine and
// integration roles must not be able to spend the clinical-AI budget or send
// symptom text to a configured provider.
router.use(requireRole('PATIENT', ...ALL_STAFF_MESSAGING_ROUTE_ROLES));
router.post('/triage', triage);

export default router;
