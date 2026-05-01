/**
 * Tier D — emergency / triage admin routes. 9 POST endpoints wrapping
 * tierDEmergencyService.
 */

import express from 'express';

import {
  generateAmbulanceHandoverSummary,
  generateChestPainProtocol,
  generateEdRedFlagDetection,
  generateEmergencyTriageForm,
  generateEmergencyVisitSummary,
  generateMlcDocumentation,
  generateStrokeFastCheckAssistant,
  generateTraumaChecklist,
  generateTriagePrioritySuggestion,
} from '../../../services/ai/tierDEmergencyService.js';
import { success } from '../../../utils/responseHelper.js';
import { logClinicalAiAudit } from './audit.js';

const router = express.Router();

function auditAndReturn(req, res, eventType, result, message) {
  return Promise.resolve(
    logClinicalAiAudit(req, eventType, String(result?.generation_id || 'inline'), null, {
      module_key: result?.module_key,
      generation_id: result?.generation_id,
      review_status: result?.review_status,
      provider: result?.provider, used_ai: result?.used_ai,
      safety_flag_count: Array.isArray(result?.safety_flags) ? result.safety_flags.length : 0,
    }),
  ).then(() => success(res, result, message, 201));
}

router.post('/emergency-triage-forms', async (req, res, next) => {
  try {
    const result = await generateEmergencyTriageForm({
      tenantId: req.tenantId, transcript: req.body?.transcript,
      ageYears: req.body?.age_years, sex: req.body?.sex,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_ED_TRIAGE_FORM_GENERATED', result, 'Triage form drafted');
  } catch (err) { return next(err); }
});

router.post('/triage-priority-suggestions', async (req, res, next) => {
  try {
    const result = await generateTriagePrioritySuggestion({
      tenantId: req.tenantId, scale: req.body?.scale,
      vitals: req.body?.vitals, chiefComplaint: req.body?.chief_complaint,
      ageYears: req.body?.age_years, redFlagsObserved: req.body?.red_flags_observed,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_ED_TRIAGE_PRIORITY_GENERATED', result, 'Triage priority drafted');
  } catch (err) { return next(err); }
});

router.post('/ed-red-flag-detections', async (req, res, next) => {
  try {
    const result = await generateEdRedFlagDetection({
      tenantId: req.tenantId, chiefComplaint: req.body?.chief_complaint,
      vitals: req.body?.vitals, ageYears: req.body?.age_years,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_ED_RED_FLAG_GENERATED', result, 'ED red flag screen drafted');
  } catch (err) { return next(err); }
});

router.post('/emergency-visit-summaries', async (req, res, next) => {
  try {
    const result = await generateEmergencyVisitSummary({
      tenantId: req.tenantId, emergencyVisitId: req.body?.emergency_visit_id,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_ED_VISIT_SUMMARY_GENERATED', result, 'Emergency visit summary drafted');
  } catch (err) { return next(err); }
});

router.post('/ambulance-handover-summaries', async (req, res, next) => {
  try {
    const result = await generateAmbulanceHandoverSummary({
      tenantId: req.tenantId, ambulanceRequestId: req.body?.ambulance_request_id,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_AMBULANCE_HANDOVER_GENERATED', result, 'Ambulance handover drafted');
  } catch (err) { return next(err); }
});

router.post('/stroke-fast-checks', async (req, res, next) => {
  try {
    const result = await generateStrokeFastCheckAssistant({
      tenantId: req.tenantId, observations: req.body?.observations,
      patientUid: req.body?.patient_uid, emergencyVisitId: req.body?.emergency_visit_id,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_STROKE_FAST_GENERATED', result, 'Stroke FAST check drafted');
  } catch (err) { return next(err); }
});

router.post('/chest-pain-protocols', async (req, res, next) => {
  try {
    const result = await generateChestPainProtocol({
      tenantId: req.tenantId, observations: req.body?.observations,
      riskFactors: req.body?.risk_factors, ecg: req.body?.ecg, troponin: req.body?.troponin,
      patientUid: req.body?.patient_uid, emergencyVisitId: req.body?.emergency_visit_id,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_CHEST_PAIN_PROTOCOL_GENERATED', result, 'Chest pain protocol drafted');
  } catch (err) { return next(err); }
});

router.post('/trauma-checklists', async (req, res, next) => {
  try {
    const result = await generateTraumaChecklist({
      tenantId: req.tenantId, observations: req.body?.observations,
      mechanism: req.body?.mechanism,
      patientUid: req.body?.patient_uid, emergencyVisitId: req.body?.emergency_visit_id,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_TRAUMA_CHECKLIST_GENERATED', result, 'Trauma checklist drafted');
  } catch (err) { return next(err); }
});

router.post('/mlc-documentation', async (req, res, next) => {
  try {
    const result = await generateMlcDocumentation({
      tenantId: req.tenantId, mlcRecordId: req.body?.mlc_record_id,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_MLC_DOCUMENTATION_GENERATED', result, 'MLC documentation drafted');
  } catch (err) { return next(err); }
});

export default router;
