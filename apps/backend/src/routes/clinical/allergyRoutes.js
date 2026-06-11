// src/routes/clinical/allergyRoutes.js
//
// HTTP surface for A10's unified allergy resolver (E5 follow-up). Mounted at
// /api/v1/allergies behind the clinical-staff gate + PHI logger (see app.js).
//
// Until now getUnifiedActiveAllergies() was internal-only (prescription
// gate, encounter CDS, dispense label) — the staff app's patient summary
// sheet had to read allergies off the admission-scoped command-board
// payload, so un-admitted patients always showed "No allergies recorded".
// This read serves the union of all four allergy stores for ANY patient,
// admitted or not.

import express from 'express';
import logger from '../../logging/logger.js';
import prisma from '../../lib/prisma.js';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import { getUnifiedActiveAllergies } from '../../services/clinical/allergySourceService.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const guardAllergyView = patientAccessGuard('ALLERGY', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
});

router.get('/patient/:patientUid/unified', guardAllergyView, async (req, res) => {
  try {
    const patientUid = String(req.params.patientUid || '').trim();
    if (!UUID_RE.test(patientUid)) {
      return error(res, 'patientUid must be a UUID', HTTP_STATUS.BAD_REQUEST);
    }
    // Service contract: never throws — missing source tables degrade to [].
    const allergies = await getUnifiedActiveAllergies(prisma, { patientUid });
    return success(res, { allergies, count: allergies.length }, 'Unified active allergies');
  } catch (err) {
    logger.error('Unified allergy read failed:', err);
    return error(res, 'Failed to fetch unified allergies', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
