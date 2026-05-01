/**
 * Tier H operational-forecasting admin routes.
 */

import express from 'express';

import {
  generateAmbulanceDemandForecast,
  generateLabTatDelayPrediction,
  generatePackageComplianceCheck,
  generatePatientFeedbackSummary,
  generateRadiologyTatDelayPrediction,
  generateSentimentAnalysis,
  generateSmartQueueOptimization,
  generateTariffOptimizationInsights,
} from '../../../services/ai/tierHOperationalService.js';
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

router.post('/lab-tat-delay-predictions', async (req, res, next) => {
  try {
    const result = await generateLabTatDelayPrediction({
      tenantId: req.tenantId, queueSnapshot: req.body?.queue_snapshot,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_LAB_TAT_GENERATED', result, 'Lab TAT prediction drafted');
  } catch (err) { return next(err); }
});

router.post('/radiology-tat-delay-predictions', async (req, res, next) => {
  try {
    const result = await generateRadiologyTatDelayPrediction({
      tenantId: req.tenantId, queueSnapshot: req.body?.queue_snapshot,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_RADIOLOGY_TAT_GENERATED', result, 'Radiology TAT prediction drafted');
  } catch (err) { return next(err); }
});

router.post('/ambulance-demand-forecasts', async (req, res, next) => {
  try {
    const result = await generateAmbulanceDemandForecast({
      tenantId: req.tenantId, horizonHours: req.body?.horizon_hours,
      recentDispatches: req.body?.recent_dispatches,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_AMBULANCE_DEMAND_GENERATED', result, 'Ambulance demand forecast drafted');
  } catch (err) { return next(err); }
});

router.post('/smart-queue-optimizations', async (req, res, next) => {
  try {
    const result = await generateSmartQueueOptimization({
      tenantId: req.tenantId, queueLabel: req.body?.queue_label,
      queueSnapshot: req.body?.queue_snapshot, serviceRate: req.body?.service_rate,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_QUEUE_OPTIMIZATION_GENERATED', result, 'Queue optimization drafted');
  } catch (err) { return next(err); }
});

router.post('/tariff-optimization-insights', async (req, res, next) => {
  try {
    const result = await generateTariffOptimizationInsights({
      tenantId: req.tenantId, payerId: req.body?.payer_id,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_TARIFF_INSIGHTS_GENERATED', result, 'Tariff insights drafted');
  } catch (err) { return next(err); }
});

router.post('/package-compliance-checks', async (req, res, next) => {
  try {
    const result = await generatePackageComplianceCheck({
      tenantId: req.tenantId, admissionId: req.body?.admission_id,
      packageCode: req.body?.package_code,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_PACKAGE_COMPLIANCE_GENERATED', result, 'Package compliance check drafted');
  } catch (err) { return next(err); }
});

router.post('/patient-feedback-summaries', async (req, res, next) => {
  try {
    const result = await generatePatientFeedbackSummary({
      tenantId: req.tenantId, periodDays: req.body?.period_days,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_FEEDBACK_SUMMARY_GENERATED', result, 'Feedback summary drafted');
  } catch (err) { return next(err); }
});

router.post('/sentiment-analyses', async (req, res, next) => {
  try {
    const result = await generateSentimentAnalysis({
      tenantId: req.tenantId, text: req.body?.text,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_SENTIMENT_GENERATED', result, 'Sentiment analysis drafted');
  } catch (err) { return next(err); }
});

export default router;
