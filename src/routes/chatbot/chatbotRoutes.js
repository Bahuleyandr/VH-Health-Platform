// src/routes/chatbot/chatbotRoutes.js

import express from 'express';
import { triage } from '../../controllers/chatbot/chatbotController.js';

const router = express.Router();

// POST /chatbot/triage — AI symptom-check. Rate-limited via the standard patient
// rate limiter applied at mount time; no additional RBAC (patient or staff can
// call it for themselves / on a patient's behalf).
router.post('/triage', triage);

export default router;
