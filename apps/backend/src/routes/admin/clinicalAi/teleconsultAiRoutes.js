/**
 * Phase B1 — teleconsult AI module admin routes.
 *
 * Two POST endpoints, one per teleconsult AI module. Each generates a
 * draft + enqueues a clinical-AI review row + links the generation_id
 * back onto the parent teleconsultations row.
 */

import express from 'express';

import { success } from '../../../utils/responseHelper.js';
import {
  generatePreVisitSummary,
  generateTeleconsultNoteDraft,
} from '../../../services/ai/teleconsultAiService.js';
import { logClinicalAiAudit } from './audit.js';

const router = express.Router();

function auditAndReturn(req, res, eventType, result, message) {
  return Promise.resolve(
    logClinicalAiAudit(
      req,
      eventType,
      String(result?.generation_id || 'inline'),
      null,
      {
        module_key: result?.module_key,
        generation_id: result?.generation_id,
        teleconsultation_id: result?.teleconsultation_id,
        review_status: result?.review_status,
        provider: result?.provider,
        used_ai: result?.used_ai,
        safety_flag_count: Array.isArray(result?.safety_flags) ? result.safety_flags.length : 0,
      },
    ),
  ).then(() => success(res, result, message, 201));
}

router.post('/teleconsult-pre-visit-summaries', async (req, res, next) => {
  try {
    const result = await generatePreVisitSummary({
      tenantId: req.tenantId,
      teleconsultationId: req.body?.teleconsultation_id,
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_TELECONSULT_PRE_VISIT_SUMMARY_GENERATED', result, 'Teleconsult pre-visit summary drafted');
  } catch (err) { return next(err); }
});

router.post('/teleconsult-note-drafts', async (req, res, next) => {
  try {
    const result = await generateTeleconsultNoteDraft({
      tenantId: req.tenantId,
      teleconsultationId: req.body?.teleconsultation_id,
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_TELECONSULT_NOTE_DRAFTED', result, 'Teleconsult note drafted');
  } catch (err) { return next(err); }
});

export default router;
