/**
 * Quality case routes — M&M/RCA standing queue.
 *
 * Mounted under the control-plane router (clinicalAiRoutes.js) which
 * enforces requireClinicalAiControl + IP allowlist + tenant injection.
 *
 * Final paths:
 *   GET  /api/v1/admin/clinical-ai/quality/cases
 *   POST /api/v1/admin/clinical-ai/quality/cases/:alertId/generate-packet
 */

import express from 'express';
import {
  listQualityCases,
  generateQualityPacket,
} from '../../../controllers/admin/clinicalAi/qualityCaseController.js';

const router = express.Router();

router.get('/quality/cases', listQualityCases);
router.post('/quality/cases/:alertId/generate-packet', generateQualityPacket);

export default router;
