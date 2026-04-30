/**
 * Tier A patient explainer admin routes — five lightweight POST endpoints
 * that wrap patientExplainersService. Each generates a draft + enqueues a
 * clinical-AI review row. Listing + decisions reuse the existing
 * /reviews surface so we don't duplicate the review queue here.
 */

import express from 'express';

import { success } from '../../../utils/responseHelper.js';
import {
  generateInvoicePatientExplanation,
  generateLabPatientExplanation,
  generatePatientReportExplanation,
  generatePrescriptionPatientExplanation,
  generateRadiologyPatientExplanation,
} from '../../../services/ai/patientExplainersService.js';
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

router.post('/lab-patient-explanations', async (req, res, next) => {
  try {
    const result = await generateLabPatientExplanation({
      tenantId: req.tenantId,
      investigationId: req.body?.investigation_id,
      language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_LAB_PATIENT_EXPLANATION_GENERATED', result, 'Lab patient explanation drafted');
  } catch (err) {
    return next(err);
  }
});

router.post('/radiology-patient-explanations', async (req, res, next) => {
  try {
    const result = await generateRadiologyPatientExplanation({
      tenantId: req.tenantId,
      radiologyOrderId: req.body?.radiology_order_id,
      reportText: req.body?.report_text || null,
      language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_RADIOLOGY_PATIENT_EXPLANATION_GENERATED', result, 'Radiology patient explanation drafted');
  } catch (err) {
    return next(err);
  }
});

router.post('/patient-report-explanations', async (req, res, next) => {
  try {
    const result = await generatePatientReportExplanation({
      tenantId: req.tenantId,
      reportType: req.body?.report_type,
      reportText: req.body?.report_text,
      patientUid: req.body?.patient_uid || null,
      admissionId: req.body?.admission_id || null,
      language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_PATIENT_REPORT_EXPLANATION_GENERATED', result, 'Patient report explanation drafted');
  } catch (err) {
    return next(err);
  }
});

router.post('/prescription-patient-explanations', async (req, res, next) => {
  try {
    const result = await generatePrescriptionPatientExplanation({
      tenantId: req.tenantId,
      prescriptionId: req.body?.prescription_id,
      language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_PRESCRIPTION_PATIENT_EXPLANATION_GENERATED', result, 'Prescription patient explanation drafted');
  } catch (err) {
    return next(err);
  }
});

router.post('/invoice-patient-explanations', async (req, res, next) => {
  try {
    const result = await generateInvoicePatientExplanation({
      tenantId: req.tenantId,
      invoiceId: req.body?.invoice_id,
      language: req.body?.language || 'en',
      generatedBy: req.user?.uid || null,
      req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_INVOICE_PATIENT_EXPLANATION_GENERATED', result, 'Invoice patient explanation drafted');
  } catch (err) {
    return next(err);
  }
});

export default router;
