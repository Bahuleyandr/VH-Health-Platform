/**
 * Tier A "fastest wins" assistant admin routes — 10 lightweight POST
 * endpoints wrapping tierAAssistantsService. Each generates a draft +
 * enqueues a clinical-AI review row. Listing + decisions reuse the
 * existing /reviews surface.
 *
 * Module → endpoint mapping (under /api/v1/admin/clinical-ai/):
 *   POST /lab-trend-summaries                — lab_trend_summary
 *   POST /discharge-medication-explanations  — discharge_medication_explanation
 *   POST /patient-faq-answers                — patient_faq_assistant
 *   POST /lab-pending-reminders              — lab_pending_result_reminder
 *   POST /front-desk-responses               — front_desk_assistant
 *   POST /audit-log-summaries                — audit_log_summary
 *   POST /call-summaries                     — call_summary
 *   POST /handwritten-note-structures        — handwritten_note_assistant
 *   POST /voice-to-prescription-drafts       — voice_to_prescription_draft
 *   POST /pending-report-trackers            — pending_report_tracker
 */

import express from 'express';

import {
  generateAuditLogSummary,
  generateCallSummary,
  generateDischargeMedicationExplanation,
  generateFrontDeskResponse,
  generateHandwrittenNoteStructure,
  generateLabPendingReminder,
  generateLabTrendSummary,
  generatePatientFaqAnswer,
  generatePendingReportTracker,
  generateVoiceToPrescriptionDraft,
} from '../../../services/ai/tierAAssistantsService.js';
import { success } from '../../../utils/responseHelper.js';
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
        review_status: result?.review_status,
        provider: result?.provider,
        used_ai: result?.used_ai,
        safety_flag_count: Array.isArray(result?.safety_flags) ? result.safety_flags.length : 0,
      },
    ),
  ).then(() => success(res, result, message, 201));
}

router.post('/lab-trend-summaries', async (req, res, next) => {
  try {
    const result = await generateLabTrendSummary({
      tenantId: req.tenantId,
      patientUid: req.body?.patient_uid,
      analyte: req.body?.analyte,
      windowDays: req.body?.window_days,
      language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_LAB_TREND_SUMMARY_GENERATED', result, 'Lab trend summary drafted');
  } catch (err) { return next(err); }
});

router.post('/discharge-medication-explanations', async (req, res, next) => {
  try {
    const result = await generateDischargeMedicationExplanation({
      tenantId: req.tenantId,
      admissionId: req.body?.admission_id,
      language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_DISCHARGE_MEDICATION_EXPLANATION_GENERATED', result, 'Discharge medication explanation drafted');
  } catch (err) { return next(err); }
});

router.post('/patient-faq-answers', async (req, res, next) => {
  try {
    const result = await generatePatientFaqAnswer({
      tenantId: req.tenantId,
      query: req.body?.query,
      knowledgeBaseId: req.body?.knowledge_base_id || null,
      language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_PATIENT_FAQ_GENERATED', result, 'Patient FAQ answer drafted');
  } catch (err) { return next(err); }
});

router.post('/lab-pending-reminders', async (req, res, next) => {
  try {
    const result = await generateLabPendingReminder({
      tenantId: req.tenantId,
      patientUid: req.body?.patient_uid,
      language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_LAB_PENDING_REMINDER_GENERATED', result, 'Lab pending reminder drafted');
  } catch (err) { return next(err); }
});

router.post('/front-desk-responses', async (req, res, next) => {
  try {
    const result = await generateFrontDeskResponse({
      tenantId: req.tenantId,
      query: req.body?.query,
      knowledgeBaseId: req.body?.knowledge_base_id || null,
      language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_FRONT_DESK_RESPONSE_GENERATED', result, 'Front desk response drafted');
  } catch (err) { return next(err); }
});

router.post('/audit-log-summaries', async (req, res, next) => {
  try {
    const result = await generateAuditLogSummary({
      tenantId: req.tenantId,
      windowDays: req.body?.window_days,
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_AUDIT_LOG_SUMMARY_GENERATED', result, 'Audit log summary drafted');
  } catch (err) { return next(err); }
});

router.post('/call-summaries', async (req, res, next) => {
  try {
    const result = await generateCallSummary({
      tenantId: req.tenantId,
      transcript: req.body?.transcript,
      patientUid: req.body?.patient_uid || null,
      callMetadata: req.body?.call_metadata || null,
      language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_CALL_SUMMARY_GENERATED', result, 'Call summary drafted');
  } catch (err) { return next(err); }
});

router.post('/handwritten-note-structures', async (req, res, next) => {
  try {
    const result = await generateHandwrittenNoteStructure({
      tenantId: req.tenantId,
      ocrText: req.body?.ocr_text,
      patientUid: req.body?.patient_uid || null,
      admissionId: req.body?.admission_id || null,
      ocrConfidenceMap: req.body?.ocr_confidence_map || null,
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_HANDWRITTEN_NOTE_GENERATED', result, 'Handwritten note structure drafted');
  } catch (err) { return next(err); }
});

router.post('/voice-to-prescription-drafts', async (req, res, next) => {
  try {
    const result = await generateVoiceToPrescriptionDraft({
      tenantId: req.tenantId,
      transcript: req.body?.transcript,
      patientUid: req.body?.patient_uid || null,
      doctorUid: req.body?.doctor_uid || null,
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_VOICE_TO_PRESCRIPTION_GENERATED', result, 'Voice-to-prescription draft generated');
  } catch (err) { return next(err); }
});

router.post('/pending-report-trackers', async (req, res, next) => {
  try {
    const result = await generatePendingReportTracker({
      tenantId: req.tenantId,
      staleDays: req.body?.stale_days,
      scope: req.body?.scope || 'all',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_PENDING_REPORT_TRACKER_GENERATED', result, 'Pending report tracker drafted');
  } catch (err) { return next(err); }
});

export default router;
