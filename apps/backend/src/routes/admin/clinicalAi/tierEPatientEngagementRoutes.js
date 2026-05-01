/**
 * Tier E patient-engagement admin routes. 13 POST endpoints.
 */

import express from 'express';

import {
  generateChronicDiseaseCoaching,
  generateDietAdviceDraft,
  generateExerciseAdviceDraft,
  generateFamilyHealthRiskSummary,
  generateFollowUpReminders,
  generateHomeVitalsInsights,
  generateMedicationReminders,
  generateMentalHealthScreening,
  generatePostDischargeCheckIn,
  generatePostSurgeryMonitoring,
  generatePreVisitForm,
  generatePreventiveHealthRecommendations,
  generateSymptomRedFlagCheck,
} from '../../../services/ai/tierEPatientEngagementService.js';
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

router.post('/symptom-red-flag-checks', async (req, res, next) => {
  try {
    const result = await generateSymptomRedFlagCheck({
      tenantId: req.tenantId, symptomDescription: req.body?.symptom_description,
      ageYears: req.body?.age_years, sex: req.body?.sex,
      knownConditions: req.body?.known_conditions, language: req.body?.language || 'en',
      patientUid: req.body?.patient_uid, generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_SYMPTOM_RED_FLAG_GENERATED', result, 'Symptom red-flag check drafted');
  } catch (err) { return next(err); }
});

router.post('/chronic-disease-coaching', async (req, res, next) => {
  try {
    const result = await generateChronicDiseaseCoaching({
      tenantId: req.tenantId, patientUid: req.body?.patient_uid,
      condition: req.body?.condition, language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_CHRONIC_DISEASE_COACH_GENERATED', result, 'Chronic disease coaching drafted');
  } catch (err) { return next(err); }
});

router.post('/post-discharge-checkins', async (req, res, next) => {
  try {
    const result = await generatePostDischargeCheckIn({
      tenantId: req.tenantId, admissionId: req.body?.admission_id,
      dayPostDischarge: req.body?.day_post_discharge, language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_POST_DISCHARGE_CHECKIN_GENERATED', result, 'Post-discharge check-in drafted');
  } catch (err) { return next(err); }
});

router.post('/post-surgery-monitoring', async (req, res, next) => {
  try {
    const result = await generatePostSurgeryMonitoring({
      tenantId: req.tenantId, admissionId: req.body?.admission_id,
      postOpDay: req.body?.post_op_day, procedureName: req.body?.procedure_name,
      language: req.body?.language || 'en', generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_POST_SURGERY_MONITORING_GENERATED', result, 'Post-surgery monitoring drafted');
  } catch (err) { return next(err); }
});

router.post('/home-vitals-insights', async (req, res, next) => {
  try {
    const result = await generateHomeVitalsInsights({
      tenantId: req.tenantId, patientUid: req.body?.patient_uid,
      vitalsSeries: req.body?.vitals_series, language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_HOME_VITALS_INSIGHTS_GENERATED', result, 'Home vitals insights drafted');
  } catch (err) { return next(err); }
});

router.post('/diet-advice-drafts', async (req, res, next) => {
  try {
    const result = await generateDietAdviceDraft({
      tenantId: req.tenantId, patientUid: req.body?.patient_uid,
      condition: req.body?.condition, restrictions: req.body?.restrictions,
      language: req.body?.language || 'en', generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_DIET_ADVICE_GENERATED', result, 'Diet advice drafted');
  } catch (err) { return next(err); }
});

router.post('/exercise-advice-drafts', async (req, res, next) => {
  try {
    const result = await generateExerciseAdviceDraft({
      tenantId: req.tenantId, patientUid: req.body?.patient_uid,
      condition: req.body?.condition, restrictions: req.body?.restrictions,
      language: req.body?.language || 'en', generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_EXERCISE_ADVICE_GENERATED', result, 'Exercise advice drafted');
  } catch (err) { return next(err); }
});

router.post('/mental-health-screenings', async (req, res, next) => {
  try {
    const result = await generateMentalHealthScreening({
      tenantId: req.tenantId, patientUid: req.body?.patient_uid,
      screen: req.body?.screen, responses: req.body?.responses,
      language: req.body?.language || 'en', generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_MENTAL_HEALTH_SCREENING_GENERATED', result, 'Mental health screening drafted');
  } catch (err) { return next(err); }
});

router.post('/medication-reminders', async (req, res, next) => {
  try {
    const result = await generateMedicationReminders({
      tenantId: req.tenantId, patientUid: req.body?.patient_uid,
      language: req.body?.language || 'en', generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_MEDICATION_REMINDER_GENERATED', result, 'Medication reminder drafted');
  } catch (err) { return next(err); }
});

router.post('/follow-up-reminders', async (req, res, next) => {
  try {
    const result = await generateFollowUpReminders({
      tenantId: req.tenantId, admissionId: req.body?.admission_id,
      language: req.body?.language || 'en', generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_FOLLOWUP_REMINDER_GENERATED', result, 'Follow-up reminder drafted');
  } catch (err) { return next(err); }
});

router.post('/pre-visit-forms', async (req, res, next) => {
  try {
    const result = await generatePreVisitForm({
      tenantId: req.tenantId, patientUid: req.body?.patient_uid,
      appointmentReason: req.body?.appointment_reason,
      departmentSpecialty: req.body?.department_specialty,
      language: req.body?.language || 'en', generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_PRE_VISIT_FORM_GENERATED', result, 'Pre-visit form drafted');
  } catch (err) { return next(err); }
});

router.post('/preventive-health-recommendations', async (req, res, next) => {
  try {
    const result = await generatePreventiveHealthRecommendations({
      tenantId: req.tenantId, patientUid: req.body?.patient_uid,
      ageYears: req.body?.age_years, sex: req.body?.sex,
      comorbidities: req.body?.comorbidities, familyHistory: req.body?.family_history,
      language: req.body?.language || 'en', generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_PREVENTIVE_HEALTH_GENERATED', result, 'Preventive health recommendations drafted');
  } catch (err) { return next(err); }
});

router.post('/family-health-risk-summaries', async (req, res, next) => {
  try {
    const result = await generateFamilyHealthRiskSummary({
      tenantId: req.tenantId, patientUid: req.body?.patient_uid,
      familyHistoryEntries: req.body?.family_history_entries,
      language: req.body?.language || 'en', generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_FAMILY_HEALTH_RISK_GENERATED', result, 'Family health risk summary drafted');
  } catch (err) { return next(err); }
});

export default router;
