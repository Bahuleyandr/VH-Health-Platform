/**
 * Clinical assessment routes (Phase F2).
 * Pain / fall-risk / growth-chart record + list. Mounted at
 * /api/v1/clinical/assessments.
 */

import express from 'express';

import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';
import {
  listFallRiskAssessments,
  listGrowthCharts,
  listPainAssessments,
  recordFallRiskAssessment,
  recordGrowthChart,
  recordPainAssessment,
} from '../../services/clinical/clinicalAssessmentService.js';
import { computePercentile } from '../../services/clinical/growthPercentileService.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';
import { success, error } from '../../utils/responseHelper.js';

const router = express.Router();

const guardAssessmentView = patientAccessGuard('CLINICAL_ASSESSMENT', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
});
const guardAssessmentWrite = patientAccessGuard('CLINICAL_ASSESSMENT', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
});

// Pain
router.post('/pain', guardAssessmentWrite, async (req, res, next) => {
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

router.get('/pain', guardAssessmentView, async (req, res, next) => {
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
router.post('/fall-risk', guardAssessmentWrite, async (req, res, next) => {
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

router.get('/fall-risk', guardAssessmentView, async (req, res, next) => {
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
router.post('/growth', guardAssessmentWrite, async (req, res, next) => {
  try {
    const b = req.body || {};
    // B-7 — auto-compute percentiles + z-scores when the caller didn't
    // supply them, the cohort is WHO_0_5, and we have sex + ageInDays.
    // Caller can override by passing percentiles/z_scores/classification
    // in the body.
    let percentiles = b.percentiles ?? null;
    let zScores = b.z_scores ?? null;
    let classification = b.classification ?? null;
    if (b.reference_dataset === 'WHO_0_5' && b.sex && b.age_in_days != null) {
      try {
        const auto = {};
        const autoZ = {};
        let firstClass = null;
        for (const [field, metric] of [
          ['height_cm', 'height_cm'],
          ['weight_kg', 'weight_kg'],
        ]) {
          if (b[field] != null) {
            const r = computePercentile({
              sex: b.sex, ageInDays: b.age_in_days, metric, value: b[field],
            });
            if (r.z_score != null) {
              auto[metric] = r.percentile;
              autoZ[metric] = r.z_score;
              firstClass = firstClass ?? r.classification;
            }
          }
        }
        if (Object.keys(auto).length > 0) {
          percentiles = percentiles ?? auto;
          zScores = zScores ?? autoZ;
          classification = classification ?? firstClass;
        }
      } catch (_e) { /* fall through; caller may have passed values */ }
    }
    const row = await recordGrowthChart({
      tenantId: req.tenantId,
      patientUid: b.patient_uid, encounterId: b.encounter_id,
      referenceDataset: b.reference_dataset, ageInDays: b.age_in_days,
      heightCm: b.height_cm, weightKg: b.weight_kg,
      headCircumferenceCm: b.head_circumference_cm,
      midUpperArmCircumferenceCm: b.mid_upper_arm_circumference_cm,
      bmi: b.bmi,
      percentiles, zScores,
      classification, notes: b.notes,
      recordedBy: req.user?.uid || null, recordedAt: b.recorded_at,
      metadata: b.metadata,
    });
    return success(res, row, 'Growth-chart record saved', 201);
  } catch (err) { return next(err); }
});

router.get('/growth', guardAssessmentView, async (req, res, next) => {
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

// B-7 — pure-compute percentile / z-score helper. No DB write.
// GET /api/v1/clinical/assessments/growth/percentile
//   ?sex=M|F&ageInDays=N&metric=height_cm|weight_kg|...&value=N
// Used by the paeds OPD UI before recording, and by the patient-app
// "where is my child on the chart" tile.
router.get('/growth/percentile', (req, res) => {
  try {
    const result = computePercentile({
      sex: req.query.sex,
      ageInDays: req.query.ageInDays ?? req.query.age_in_days,
      metric: req.query.metric,
      value: req.query.value,
    });
    return success(res, result, 'Growth percentile computed');
  } catch (err) {
    if (err.statusCode) return error(res, err.message, err.statusCode);
    return error(res, err.message || 'Compute failed', 500);
  }
});

export default router;
