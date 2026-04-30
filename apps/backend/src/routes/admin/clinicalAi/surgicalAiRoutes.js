/**
 * Tier B PR2 — surgical AI module admin routes.
 *
 * Eight POST endpoints, one per surgical AI module. Each generates a
 * draft + enqueues a clinical-AI review row. Listing + decisions reuse
 * the existing /reviews surface.
 */

import express from 'express';

import { success } from '../../../utils/responseHelper.js';
import {
  detectPostOpComplications,
  draftOperativeNote,
  draftPostOpInstructions,
  draftSurgicalConsent,
  reviewPreopChecklist,
  runAnesthesiaPrecheck,
  summarizeSurgicalRisk,
  trackImplantsAndConsumables,
} from '../../../services/ai/surgicalAiService.js';
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
        ot_schedule_id: result?.ot_schedule_id,
        review_status: result?.review_status,
        provider: result?.provider,
        used_ai: result?.used_ai,
        safety_flag_count: Array.isArray(result?.safety_flags) ? result.safety_flags.length : 0,
      },
    ),
  ).then(() => success(res, result, message, 201));
}

router.post('/preop-checklist-reviews', async (req, res, next) => {
  try {
    const result = await reviewPreopChecklist({
      tenantId: req.tenantId,
      otScheduleId: req.body?.ot_schedule_id,
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_PREOP_CHECKLIST_REVIEWED', result, 'Pre-op checklist review drafted');
  } catch (err) { return next(err); }
});

router.post('/surgical-consent-drafts', async (req, res, next) => {
  try {
    const result = await draftSurgicalConsent({
      tenantId: req.tenantId,
      otScheduleId: req.body?.ot_schedule_id,
      language: req.body?.language || 'en',
      patientComorbidities: req.body?.patient_comorbidities || null,
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_SURGICAL_CONSENT_DRAFTED', result, 'Surgical consent drafted');
  } catch (err) { return next(err); }
});

router.post('/ot-note-drafts', async (req, res, next) => {
  try {
    const result = await draftOperativeNote({
      tenantId: req.tenantId,
      otScheduleId: req.body?.ot_schedule_id,
      surgeonNotes: req.body?.surgeon_notes || null,
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_OT_NOTE_DRAFTED', result, 'Operative note drafted');
  } catch (err) { return next(err); }
});

router.post('/post-op-instruction-drafts', async (req, res, next) => {
  try {
    const result = await draftPostOpInstructions({
      tenantId: req.tenantId,
      otScheduleId: req.body?.ot_schedule_id,
      language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_POST_OP_INSTRUCTIONS_DRAFTED', result, 'Post-op instructions drafted');
  } catch (err) { return next(err); }
});

router.post('/surgical-risk-summaries', async (req, res, next) => {
  try {
    const result = await summarizeSurgicalRisk({
      tenantId: req.tenantId,
      otScheduleId: req.body?.ot_schedule_id,
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_SURGICAL_RISK_SUMMARIZED', result, 'Surgical risk summary drafted');
  } catch (err) { return next(err); }
});

router.post('/anesthesia-prechecks', async (req, res, next) => {
  try {
    const result = await runAnesthesiaPrecheck({
      tenantId: req.tenantId,
      otScheduleId: req.body?.ot_schedule_id,
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_ANESTHESIA_PRECHECK_DRAFTED', result, 'Anesthesia precheck drafted');
  } catch (err) { return next(err); }
});

router.post('/implant-consumable-tracking', async (req, res, next) => {
  try {
    const result = await trackImplantsAndConsumables({
      tenantId: req.tenantId,
      otScheduleId: req.body?.ot_schedule_id,
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_IMPLANT_TRACKING_RUN', result, 'Implant + consumable reconciliation drafted');
  } catch (err) { return next(err); }
});

router.post('/post-op-complication-alerts', async (req, res, next) => {
  try {
    const result = await detectPostOpComplications({
      tenantId: req.tenantId,
      otScheduleId: req.body?.ot_schedule_id,
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_POST_OP_COMPLICATIONS_DETECTED', result, 'Post-op complication alert drafted');
  } catch (err) { return next(err); }
});

export default router;
