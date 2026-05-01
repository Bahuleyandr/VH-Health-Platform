/**
 * Tier C clinical-assistant admin routes — 16 POST endpoints wrapping
 * tierCAssistantsService. Each generates a draft + enqueues a clinical-AI
 * review row.
 */

import express from 'express';

import {
  generateAdverseDrugEventDetection,
  generateAkiRiskAlert,
  generateClinicLetterDraft,
  generateClinicalNoteCleanup,
  generateFallRiskPrediction,
  generateIcuRoundSummary,
  generateIntakeOutputSummary,
  generateLiverDoseCheck,
  generateMedicalCertificateDraft,
  generateMissingExaminationAssistant,
  generateMissingQuestionsAssistant,
  generateMissingTestsAssistant,
  generateOrderSetSuggestion,
  generatePregnancyLactationWarning,
  generatePressureUlcerRiskPrediction,
  generateRenalDoseCheck,
} from '../../../services/ai/tierCAssistantsService.js';
import { success } from '../../../utils/responseHelper.js';
import { logClinicalAiAudit } from './audit.js';

const router = express.Router();

function auditAndReturn(req, res, eventType, result, message) {
  return Promise.resolve(
    logClinicalAiAudit(req, eventType, String(result?.generation_id || 'inline'), null, {
      module_key: result?.module_key,
      generation_id: result?.generation_id,
      review_status: result?.review_status,
      provider: result?.provider,
      used_ai: result?.used_ai,
      safety_flag_count: Array.isArray(result?.safety_flags) ? result.safety_flags.length : 0,
    }),
  ).then(() => success(res, result, message, 201));
}

router.post('/medical-certificate-drafts', async (req, res, next) => {
  try {
    const result = await generateMedicalCertificateDraft({
      tenantId: req.tenantId, admissionId: req.body?.admission_id,
      certType: req.body?.cert_type, notes: req.body?.notes,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_MEDICAL_CERTIFICATE_GENERATED', result, 'Medical certificate drafted');
  } catch (err) { return next(err); }
});

router.post('/clinic-letter-drafts', async (req, res, next) => {
  try {
    const result = await generateClinicLetterDraft({
      tenantId: req.tenantId, admissionId: req.body?.admission_id,
      recipientType: req.body?.recipient_type || 'referring_physician',
      letterPurpose: req.body?.letter_purpose,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_CLINIC_LETTER_GENERATED', result, 'Clinic letter drafted');
  } catch (err) { return next(err); }
});

router.post('/clinical-note-cleanups', async (req, res, next) => {
  try {
    const result = await generateClinicalNoteCleanup({
      tenantId: req.tenantId, noteText: req.body?.note_text,
      patientUid: req.body?.patient_uid, admissionId: req.body?.admission_id,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_NOTE_CLEANUP_GENERATED', result, 'Clinical note cleanup drafted');
  } catch (err) { return next(err); }
});

router.post('/missing-questions-suggestions', async (req, res, next) => {
  try {
    const result = await generateMissingQuestionsAssistant({
      tenantId: req.tenantId, chiefComplaint: req.body?.chief_complaint,
      ageYears: req.body?.age_years, comorbidities: req.body?.comorbidities,
      patientUid: req.body?.patient_uid, admissionId: req.body?.admission_id,
      encounterId: req.body?.encounter_id, generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_MISSING_QUESTIONS_GENERATED', result, 'Missing-questions suggestions drafted');
  } catch (err) { return next(err); }
});

router.post('/missing-examination-suggestions', async (req, res, next) => {
  try {
    const result = await generateMissingExaminationAssistant({
      tenantId: req.tenantId, workingDiagnosis: req.body?.working_diagnosis,
      examCompleted: req.body?.exam_completed,
      patientUid: req.body?.patient_uid, admissionId: req.body?.admission_id,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_MISSING_EXAM_GENERATED', result, 'Missing-examination suggestions drafted');
  } catch (err) { return next(err); }
});

router.post('/missing-tests-suggestions', async (req, res, next) => {
  try {
    const result = await generateMissingTestsAssistant({
      tenantId: req.tenantId, workingDiagnosis: req.body?.working_diagnosis,
      testsOrdered: req.body?.tests_ordered,
      patientUid: req.body?.patient_uid, admissionId: req.body?.admission_id,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_MISSING_TESTS_GENERATED', result, 'Missing-tests suggestions drafted');
  } catch (err) { return next(err); }
});

router.post('/order-set-suggestions', async (req, res, next) => {
  try {
    const result = await generateOrderSetSuggestion({
      tenantId: req.tenantId, workingDiagnosis: req.body?.working_diagnosis,
      acuity: req.body?.acuity || 'routine',
      patientUid: req.body?.patient_uid, admissionId: req.body?.admission_id,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_ORDER_SET_GENERATED', result, 'Order-set suggestion drafted');
  } catch (err) { return next(err); }
});

router.post('/renal-dose-checks', async (req, res, next) => {
  try {
    const result = await generateRenalDoseCheck({
      tenantId: req.tenantId, prescriptionId: req.body?.prescription_id,
      eGfr: req.body?.eGFR, creatinine: req.body?.creatinine,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_RENAL_DOSE_CHECK_GENERATED', result, 'Renal dose check drafted');
  } catch (err) { return next(err); }
});

router.post('/liver-dose-checks', async (req, res, next) => {
  try {
    const result = await generateLiverDoseCheck({
      tenantId: req.tenantId, prescriptionId: req.body?.prescription_id,
      ast: req.body?.ast, alt: req.body?.alt, bilirubin: req.body?.bilirubin,
      childPugh: req.body?.child_pugh,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_LIVER_DOSE_CHECK_GENERATED', result, 'Liver dose check drafted');
  } catch (err) { return next(err); }
});

router.post('/pregnancy-lactation-warnings', async (req, res, next) => {
  try {
    const result = await generatePregnancyLactationWarning({
      tenantId: req.tenantId, prescriptionId: req.body?.prescription_id,
      pregnancyStatus: req.body?.pregnancy_status, lactationStatus: req.body?.lactation_status,
      trimester: req.body?.trimester,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_PREGNANCY_LACTATION_WARNING_GENERATED', result, 'Pregnancy/lactation warning drafted');
  } catch (err) { return next(err); }
});

router.post('/adverse-drug-event-detections', async (req, res, next) => {
  try {
    const result = await generateAdverseDrugEventDetection({
      tenantId: req.tenantId, patientUid: req.body?.patient_uid,
      signal: req.body?.signal,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_ADE_DETECTION_GENERATED', result, 'ADE detection drafted');
  } catch (err) { return next(err); }
});

router.post('/fall-risk-predictions', async (req, res, next) => {
  try {
    const result = await generateFallRiskPrediction({
      tenantId: req.tenantId, patientUid: req.body?.patient_uid,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_FALL_RISK_PREDICTION_GENERATED', result, 'Fall risk prediction drafted');
  } catch (err) { return next(err); }
});

router.post('/pressure-ulcer-risk-predictions', async (req, res, next) => {
  try {
    const result = await generatePressureUlcerRiskPrediction({
      tenantId: req.tenantId, patientUid: req.body?.patient_uid,
      admissionId: req.body?.admission_id,
      bradenScore: req.body?.braden_score, mobilityNotes: req.body?.mobility_notes,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_PRESSURE_ULCER_PREDICTION_GENERATED', result, 'Pressure ulcer risk drafted');
  } catch (err) { return next(err); }
});

router.post('/aki-risk-alerts', async (req, res, next) => {
  try {
    const result = await generateAkiRiskAlert({
      tenantId: req.tenantId, patientUid: req.body?.patient_uid,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_AKI_RISK_GENERATED', result, 'AKI risk alert drafted');
  } catch (err) { return next(err); }
});

router.post('/intake-output-summaries', async (req, res, next) => {
  try {
    const result = await generateIntakeOutputSummary({
      tenantId: req.tenantId, admissionId: req.body?.admission_id,
      dateIso: req.body?.date,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_IO_SUMMARY_GENERATED', result, 'Intake/output summary drafted');
  } catch (err) { return next(err); }
});

router.post('/icu-round-summaries', async (req, res, next) => {
  try {
    const result = await generateIcuRoundSummary({
      tenantId: req.tenantId, admissionId: req.body?.admission_id,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_ICU_ROUND_GENERATED', result, 'ICU round summary drafted');
  } catch (err) { return next(err); }
});

export default router;
