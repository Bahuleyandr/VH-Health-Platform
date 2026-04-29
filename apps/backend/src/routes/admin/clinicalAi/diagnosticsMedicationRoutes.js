import express from 'express';
import { success } from '../../../utils/responseHelper.js';
import { logClinicalAiAudit } from './audit.js';
import {
  decideLabAutoverification,
  evaluateInvestigation,
  listLabAutoverifications,
} from '../../../services/ai/labAutoverificationService.js';
import {
  decidePediatricDoseCheck,
  evaluatePrescriptionSafety,
  listPediatricDoseChecks,
} from '../../../services/ai/pediatricDosingSafetyService.js';
import {
  decideStaffBurnoutReview,
  evaluateStaffBurnout,
  listStaffBurnoutReviews,
} from '../../../services/ai/staffBurnoutRiskService.js';
import {
  decideEdTriagePrediction,
  evaluateEdTriage,
  listEdTriagePredictions,
} from '../../../services/ai/edTriageBoardingService.js';
import {
  decideVentilatorBundleAudit,
  generateVentilatorBundleAudit,
  listVentilatorBundleAudits,
} from '../../../services/ai/icuVentilatorBundleService.js';
import {
  decideBloodBankForecast,
  generateBloodBankForecast,
  listBloodBankForecasts,
  listBloodBankInventory,
  upsertBloodBankInventory,
} from '../../../services/ai/bloodBankForecastService.js';
import {
  decideObstetricRiskAssessment,
  evaluateObstetricRisk,
  listObstetricRiskAssessments,
} from '../../../services/ai/obstetricRiskService.js';

const router = express.Router();

// ---------------------------------------------------------------------------
// Lab autoverification / delta check
// ---------------------------------------------------------------------------
router.post('/lab-autoverifications/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateInvestigation({
      req,
      investigationId: req.body?.investigation_id,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_LAB_AUTOVERIFICATION_EVALUATED',
      String(result.review_id || result.generation_id || req.body?.investigation_id || 'inline'),
      null,
      {
        review_id: result.review_id,
        generation_id: result.generation_id,
        investigation_id: req.body?.investigation_id,
        decision: result.decision,
        critical_band: result.critical_band,
      }
    );
    return success(res, result, 'Lab autoverification evaluated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/lab-autoverifications', async (req, res, next) => {
  try {
    const result = await listLabAutoverifications({
      tenantId: req.tenantId,
      patientUid: req.query?.patient_uid || null,
      decision: req.query?.decision || null,
      criticalBand: req.query?.critical_band || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Lab autoverifications retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/lab-autoverifications/:id', async (req, res, next) => {
  try {
    const result = await decideLabAutoverification({
      tenantId: req.tenantId,
      reviewId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_LAB_AUTOVERIFICATION_REVIEWED', String(result.id), null, result);
    return success(res, result, 'Lab autoverification review updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Pediatric dosing safety AI
// ---------------------------------------------------------------------------
router.post('/pediatric-dose-checks/evaluate', async (req, res, next) => {
  try {
    const result = await evaluatePrescriptionSafety({
      req,
      prescriptionId: req.body?.prescription_id || null,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id || null,
      medicationName: req.body?.medication_name,
      prescribedDoseMg: req.body?.prescribed_dose_mg,
      prescribedRoute: req.body?.prescribed_route || null,
      prescribedFrequency: req.body?.prescribed_frequency || null,
      ageDaysOverride: req.body?.age_days_override || null,
      weightKgOverride: req.body?.weight_kg_override || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_PEDIATRIC_DOSE_EVALUATED',
      String(result.check_id || result.generation_id || req.body?.patient_uid || 'inline'),
      null,
      {
        check_id: result.check_id,
        generation_id: result.generation_id,
        patient_uid: req.body?.patient_uid,
        safety_band: result.safety_band,
        medication_name: req.body?.medication_name,
      }
    );
    return success(res, result, 'Pediatric dose evaluated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/pediatric-dose-checks', async (req, res, next) => {
  try {
    const result = await listPediatricDoseChecks({
      tenantId: req.tenantId,
      patientUid: req.query?.patient_uid || null,
      admissionId: req.query?.admission_id || null,
      safetyBand: req.query?.safety_band || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Pediatric dose checks retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/pediatric-dose-checks/:id', async (req, res, next) => {
  try {
    const result = await decidePediatricDoseCheck({
      tenantId: req.tenantId,
      checkId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_PEDIATRIC_DOSE_REVIEWED', String(result.id), null, result);
    return success(res, result, 'Pediatric dose check updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Staff burnout / workload risk predictor
// ---------------------------------------------------------------------------
router.post('/staff-burnout/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateStaffBurnout({
      req,
      staffUid: req.body?.staff_uid,
      windowDays: req.body?.window_days,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_STAFF_BURNOUT_EVALUATED',
      String(result.review_id || result.generation_id || req.body?.staff_uid || 'inline'),
      null,
      {
        review_id: result.review_id,
        generation_id: result.generation_id,
        staff_uid: req.body?.staff_uid,
        risk_band: result.draft?.risk_band,
        risk_score: result.draft?.risk_score,
      }
    );
    return success(res, result, 'Staff burnout risk evaluated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/staff-burnout/reviews', async (req, res, next) => {
  try {
    const result = await listStaffBurnoutReviews({
      tenantId: req.tenantId,
      staffUid: req.query?.staff_uid || null,
      department: req.query?.department || null,
      riskBand: req.query?.risk_band || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Staff burnout reviews retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/staff-burnout/reviews/:id', async (req, res, next) => {
  try {
    const result = await decideStaffBurnoutReview({
      tenantId: req.tenantId,
      reviewId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_STAFF_BURNOUT_REVIEWED', String(result.id), null, result);
    return success(res, result, 'Staff burnout review updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// ED triage + boarding predictor
// ---------------------------------------------------------------------------
router.post('/ed-triage/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateEdTriage({
      req,
      admissionId: req.body?.admission_id || null,
      patientUid: req.body?.patient_uid || null,
      chiefComplaint: req.body?.chief_complaint || null,
      arrivalMode: req.body?.arrival_mode || 'unknown',
      ageYears: req.body?.age_years || null,
      vitals: req.body?.vitals || {},
      painScore: req.body?.pain_score ?? null,
      occupancyOverride: req.body?.occupancy ?? null,
      staffLoadOverride: req.body?.staff_load || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_ED_TRIAGE_PREDICTED',
      String(result.prediction_id || result.generation_id || req.body?.admission_id || 'inline'),
      null,
      {
        prediction_id: result.prediction_id,
        triage_level: result.draft?.triage_level,
        boarding_risk_band: result.draft?.boarding_risk_band,
        predicted_disposition: result.draft?.predicted_disposition,
      }
    );
    return success(res, result, 'ED triage predicted', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/ed-triage/predictions', async (req, res, next) => {
  try {
    const result = await listEdTriagePredictions({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      patientUid: req.query?.patient_uid || null,
      triageLevel: req.query?.triage_level || null,
      boardingBand: req.query?.boarding_band || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'ED triage predictions retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/ed-triage/predictions/:id', async (req, res, next) => {
  try {
    const result = await decideEdTriagePrediction({
      tenantId: req.tenantId,
      predictionId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_ED_TRIAGE_REVIEWED', String(result.id), null, result);
    return success(res, result, 'ED triage prediction updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// ICU ventilator / sedation bundle reviewer
// ---------------------------------------------------------------------------
router.post('/icu-ventilator-bundle/audits', async (req, res, next) => {
  try {
    const result = await generateVentilatorBundleAudit({
      req,
      admissionId: req.body?.admission_id,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_ICU_VENTILATOR_BUNDLE_AUDITED',
      String(result.audit_id || result.generation_id || req.body?.admission_id || 'inline'),
      null,
      {
        audit_id: result.audit_id,
        compliance_score: result.draft?.compliance_score,
        risk_band: result.draft?.risk_band,
      }
    );
    return success(res, result, 'ICU ventilator bundle audit generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/icu-ventilator-bundle/audits', async (req, res, next) => {
  try {
    const result = await listVentilatorBundleAudits({
      tenantId: req.tenantId,
      admissionId: req.query?.admission_id || null,
      riskBand: req.query?.risk_band || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'ICU ventilator bundle audits retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/icu-ventilator-bundle/audits/:id', async (req, res, next) => {
  try {
    const result = await decideVentilatorBundleAudit({
      tenantId: req.tenantId,
      auditId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_ICU_VENTILATOR_BUNDLE_REVIEWED', String(result.id), null, result);
    return success(res, result, 'ICU ventilator bundle audit updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Blood bank demand + compatibility forecast
// ---------------------------------------------------------------------------
router.post('/blood-bank/inventory', async (req, res, next) => {
  try {
    const result = await upsertBloodBankInventory({
      tenantId: req.tenantId,
      bloodGroup: req.body?.blood_group,
      component: req.body?.component,
      unitsAvailable: req.body?.units_available,
      unitsCommitted: req.body?.units_committed,
      minimumStockLevel: req.body?.minimum_stock_level,
      expiresEarliest: req.body?.expires_earliest || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_BLOOD_BANK_INVENTORY_UPSERTED',
      String(result?.id || 'inline'),
      null,
      result
    );
    return success(res, result, 'Blood bank inventory upserted', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/blood-bank/inventory', async (req, res, next) => {
  try {
    const result = await listBloodBankInventory({
      tenantId: req.tenantId,
      bloodGroup: req.query?.blood_group || null,
      component: req.query?.component || null,
    });
    return success(res, result, 'Blood bank inventory retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/blood-bank/forecast', async (req, res, next) => {
  try {
    const result = await generateBloodBankForecast({
      req,
      forecastWindowHours: req.body?.forecast_window_hours,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_BLOOD_BANK_FORECAST_GENERATED',
      String(result.review_id || result.generation_id || 'inline'),
      null,
      {
        review_id: result.review_id,
        risk_band: result.draft?.risk_band,
      }
    );
    return success(res, result, 'Blood bank forecast generated', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/blood-bank/forecasts', async (req, res, next) => {
  try {
    const result = await listBloodBankForecasts({
      tenantId: req.tenantId,
      riskBand: req.query?.risk_band || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Blood bank forecasts retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/blood-bank/forecasts/:id', async (req, res, next) => {
  try {
    const result = await decideBloodBankForecast({
      tenantId: req.tenantId,
      forecastId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_BLOOD_BANK_FORECAST_REVIEWED', String(result.id), null, result);
    return success(res, result, 'Blood bank forecast updated');
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------------------
// Pregnancy / obstetric risk assistant
// ---------------------------------------------------------------------------
router.post('/obstetric-risk/evaluate', async (req, res, next) => {
  try {
    const result = await evaluateObstetricRisk({
      req,
      patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id || null,
      gestationalAgeWeeks: req.body?.gestational_age_weeks ?? null,
      gravida: req.body?.gravida ?? null,
      parity: req.body?.parity ?? null,
      priorConditions: req.body?.prior_conditions || [],
      currentConditions: req.body?.current_conditions || [],
      vitals: req.body?.vitals || {},
      labs: req.body?.labs || {},
      symptoms: req.body?.symptoms || [],
      multipleGestation: Boolean(req.body?.multiple_gestation),
      ageYears: req.body?.age_years ?? null,
      stageOverride: req.body?.stage_override || null,
    });
    await logClinicalAiAudit(
      req,
      'CLINICAL_AI_OBSTETRIC_RISK_EVALUATED',
      String(result.assessment_id || result.generation_id || req.body?.patient_uid || 'inline'),
      null,
      {
        assessment_id: result.assessment_id,
        risk_band: result.draft?.risk_band,
        risk_score: result.draft?.risk_score,
      }
    );
    return success(res, result, 'Obstetric risk assessed', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/obstetric-risk/assessments', async (req, res, next) => {
  try {
    const result = await listObstetricRiskAssessments({
      tenantId: req.tenantId,
      patientUid: req.query?.patient_uid || null,
      admissionId: req.query?.admission_id || null,
      riskBand: req.query?.risk_band || null,
      stage: req.query?.stage || null,
      reviewerDecision: req.query?.reviewer_decision || null,
      limit: req.query?.limit,
    });
    return success(res, result, 'Obstetric risk assessments retrieved');
  } catch (err) {
    return next(err);
  }
});

router.patch('/obstetric-risk/assessments/:id', async (req, res, next) => {
  try {
    const result = await decideObstetricRiskAssessment({
      tenantId: req.tenantId,
      assessmentId: req.params.id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    await logClinicalAiAudit(req, 'CLINICAL_AI_OBSTETRIC_RISK_REVIEWED', String(result.id), null, result);
    return success(res, result, 'Obstetric risk assessment updated');
  } catch (err) {
    return next(err);
  }
});

export default router;
