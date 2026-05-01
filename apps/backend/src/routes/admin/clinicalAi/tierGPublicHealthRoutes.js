/**
 * Tier G public / population-health admin routes.
 */

import express from 'express';

import {
  generateChronicDiseaseRegistry,
  generateHighRiskCohorts,
  generatePhiDeidentification,
  generatePublicHealthReport,
  generateScreeningGapDetection,
} from '../../../services/ai/tierGPublicHealthService.js';
import { success } from '../../../utils/responseHelper.js';
import { logClinicalAiAudit } from './audit.js';

const router = express.Router();

function auditAndReturn(req, res, eventType, result, message) {
  return Promise.resolve(
    logClinicalAiAudit(req, eventType, String(result?.generation_id || 'inline'), null, {
      module_key: result?.module_key, generation_id: result?.generation_id,
      review_status: result?.review_status, provider: result?.provider, used_ai: result?.used_ai,
      safety_flag_count: Array.isArray(result?.safety_flags) ? result.safety_flags.length : 0,
    }),
  ).then(() => success(res, result, message, 201));
}

router.post('/chronic-disease-registries', async (req, res, next) => {
  try {
    const result = await generateChronicDiseaseRegistry({
      tenantId: req.tenantId, condition: req.body?.condition,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_CHRONIC_REGISTRY_GENERATED', result, 'Chronic disease registry drafted');
  } catch (err) { return next(err); }
});

router.post('/screening-gap-detections', async (req, res, next) => {
  try {
    const result = await generateScreeningGapDetection({
      tenantId: req.tenantId, screeningType: req.body?.screening_type,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_SCREENING_GAP_GENERATED', result, 'Screening gap detection drafted');
  } catch (err) { return next(err); }
});

router.post('/high-risk-cohorts', async (req, res, next) => {
  try {
    const result = await generateHighRiskCohorts({
      tenantId: req.tenantId, criteria: req.body?.criteria,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_HIGH_RISK_COHORT_GENERATED', result, 'High-risk cohort drafted');
  } catch (err) { return next(err); }
});

router.post('/public-health-reports', async (req, res, next) => {
  try {
    const result = await generatePublicHealthReport({
      tenantId: req.tenantId, reportType: req.body?.report_type,
      periodDays: req.body?.period_days,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_PUBLIC_HEALTH_REPORT_GENERATED', result, 'Public health report drafted');
  } catch (err) { return next(err); }
});

router.post('/phi-deidentifications', async (req, res, next) => {
  try {
    const result = await generatePhiDeidentification({
      tenantId: req.tenantId, sourceText: req.body?.source_text,
      retainSafeHarbor: Boolean(req.body?.retain_safe_harbor),
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_PHI_DEID_GENERATED', result, 'PHI de-identification drafted');
  } catch (err) { return next(err); }
});

export default router;
