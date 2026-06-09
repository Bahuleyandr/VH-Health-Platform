// src/routes/clinical/drugKbRoutes.js
//
// Roadmap B2 — drug knowledge base surface. Mounted at /api/v1/drug-kb
// behind the clinical-staff gate (app.js). Two endpoints:
//   GET  /status — which KB sources are loaded (governance: surfaces
//                  loudly when only the starter set is active)
//   POST /check  — stateless KB evaluation for CDS previews and the
//                  pharmacist verification screen (B1). All context is
//                  passed explicitly; the patient-bound path runs inside
//                  validatePrescriptionSafety on prescription save.

import express from 'express';
import logger from '../../logging/logger.js';
import { evaluateDrugKb, drugKbStatus } from '../../services/clinical/drugKnowledgeBaseService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();

router.get('/status', async (req, res) => {
  try {
    const status = await drugKbStatus();
    return success(res, status, 'Drug KB status');
  } catch (err) {
    logger.error('Drug KB status failed:', err);
    return error(res, 'Failed to read drug KB status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

router.post('/check', async (req, res) => {
  try {
    const medications = Array.isArray(req.body.medications) ? req.body.medications : null;
    if (!medications || medications.length === 0) {
      return error(res, 'medications array is required', HTTP_STATUS.BAD_REQUEST);
    }
    const result = await evaluateDrugKb({
      medications,
      allergies: Array.isArray(req.body.allergies) ? req.body.allergies : [],
      problems: Array.isArray(req.body.problems) ? req.body.problems : [],
      patient: {
        ageYears: req.body.patient?.age_years ?? null,
        weightKg: req.body.patient?.weight_kg ?? null,
        egfr: req.body.patient?.egfr ?? null,
      },
    });
    return success(res, {
      kb_available: result.kbAvailable,
      findings: result.findings,
      count: result.findings.length,
    }, 'Drug KB evaluation');
  } catch (err) {
    logger.error('Drug KB check failed:', err);
    return error(res, 'Failed to evaluate drug KB', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
