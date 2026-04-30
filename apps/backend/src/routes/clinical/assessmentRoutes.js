/**
 * Clinical assessment routes (Phase F2).
 * Pain / fall-risk / growth-chart record + list. Mounted at
 * /api/v1/clinical/assessments.
 */

import express from 'express';

import {
  listFallRiskAssessments,
  listGrowthCharts,
  listPainAssessments,
  recordFallRiskAssessment,
  recordGrowthChart,
  recordPainAssessment,
} from '../../services/clinical/clinicalAssessmentService.js';
import { success } from '../../utils/responseHelper.js';

const router = express.Router();

// Pain
router.post('/pain', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await recordPainAssessment({
      tenantId: req.tenantId,
      patientUid: b.patient_uid, encounterId: b.encounter_id,
      scale: b.scale, score: b.score,
      location: b.location, characterStr: b.character, context: b.context,
      interventions: b.interventions, notes: b.notes,
      recordedBy: req.user?.uid || null, recordedAt: b.recorded_at,
      metadata: b.metadata,
    });
    return success(res, row, 'Pain assessment recorded', 201);
  } catch (err) { return next(err); }
});

router.get('/pain', async (req, res, next) => {
  try {
    const result = await listPainAssessments({
      tenantId: req.tenantId,
      patientUid: req.query.patient_uid || null,
      encounterId: req.query.encounter_id || null,
      minScore: req.query.min_score != null ? Number(req.query.min_score) : null,
      limit: req.query.limit,
    });
    return success(res, result, 'Pain assessments retrieved');
  } catch (err) { return next(err); }
});

// Fall risk
router.post('/fall-risk', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await recordFallRiskAssessment({
      tenantId: req.tenantId,
      patientUid: b.patient_uid, encounterId: b.encounter_id,
      scale: b.scale, score: b.score, riskLevel: b.risk_level,
      factors: b.factors, interventions: b.interventions, notes: b.notes,
      recordedBy: req.user?.uid || null, recordedAt: b.recorded_at,
      metadata: b.metadata,
    });
    return success(res, row, 'Fall-risk assessment recorded', 201);
  } catch (err) { return next(err); }
});

router.get('/fall-risk', async (req, res, next) => {
  try {
    const result = await listFallRiskAssessments({
      tenantId: req.tenantId,
      patientUid: req.query.patient_uid || null,
      encounterId: req.query.encounter_id || null,
      riskLevel: req.query.risk_level || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Fall-risk assessments retrieved');
  } catch (err) { return next(err); }
});

// Growth chart
router.post('/growth', async (req, res, next) => {
  try {
    const b = req.body || {};
    const row = await recordGrowthChart({
      tenantId: req.tenantId,
      patientUid: b.patient_uid, encounterId: b.encounter_id,
      referenceDataset: b.reference_dataset, ageInDays: b.age_in_days,
      heightCm: b.height_cm, weightKg: b.weight_kg,
      headCircumferenceCm: b.head_circumference_cm,
      midUpperArmCircumferenceCm: b.mid_upper_arm_circumference_cm,
      bmi: b.bmi,
      percentiles: b.percentiles, zScores: b.z_scores,
      classification: b.classification, notes: b.notes,
      recordedBy: req.user?.uid || null, recordedAt: b.recorded_at,
      metadata: b.metadata,
    });
    return success(res, row, 'Growth-chart record saved', 201);
  } catch (err) { return next(err); }
});

router.get('/growth', async (req, res, next) => {
  try {
    const result = await listGrowthCharts({
      tenantId: req.tenantId,
      patientUid: req.query.patient_uid || null,
      encounterId: req.query.encounter_id || null,
      referenceDataset: req.query.reference_dataset || null,
      limit: req.query.limit,
    });
    return success(res, result, 'Growth-chart records retrieved');
  } catch (err) { return next(err); }
});

export default router;
