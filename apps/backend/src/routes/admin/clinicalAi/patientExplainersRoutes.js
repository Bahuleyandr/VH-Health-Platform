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
import { patientAccessGuard, patientAccessGuardForResource } from '../../../middleware/phiAccessMiddleware.js';
import { ACCESS_POLICY_CODES } from '../../../services/security/accessDecisionService.js';
import { logClinicalAiAudit } from './audit.js';

const router = express.Router();

// Intra-tenant IDOR guards — resolve the patient owning the cited source
// row (tenant-scoped) and enforce the actor's care relationship before the
// explainer reads PHI. Run care-team-mode-governed (per-tenant, default
// 'shadow') so they match exactly how the underlying PHI families are
// guarded in app.js (/investigations, /prescriptions both
// careTeamModeGoverned) — a tenant flipped to 'enforce' returns a real 403
// for an out-of-relationship id; shadow logs the would-be denial to
// patient_access_audit_log. allowNoPatientResource lets a not-found id fall
// through to the service's existing 404. The hard cross-tenant guarantee is
// the tenant_id predicate added to each source SELECT in
// patientExplainersService.js.
const guardLabExplainer = patientAccessGuardForResource('INVESTIGATION', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_INVESTIGATION_VIEW,
  resourceType: 'investigation',
  idSelector: (req) => req.body?.investigation_id ?? null,
  allowNoPatientResource: true,
  careTeamModeGoverned: true,
});
const guardRadiologyExplainer = patientAccessGuardForResource('RADIOLOGY', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_RADIOLOGY_VIEW,
  resourceType: 'radiology_order',
  idSelector: (req) => req.body?.radiology_order_id ?? null,
  allowNoPatientResource: true,
  careTeamModeGoverned: true,
});
const guardPrescriptionExplainer = patientAccessGuardForResource('PRESCRIPTION', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_PHARMACY_ORDER_VIEW,
  resourceType: 'prescription',
  idSelector: (req) => req.body?.prescription_id ?? null,
  allowNoPatientResource: true,
  careTeamModeGoverned: true,
});
const guardInvoiceExplainer = patientAccessGuardForResource('PRESCRIPTION', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_PHARMACY_ORDER_VIEW,
  resourceType: 'invoice',
  idSelector: (req) => req.body?.invoice_id ?? null,
  allowNoPatientResource: true,
  careTeamModeGoverned: true,
});

// The free-text report explainer takes a caller-asserted patient_uid (there is
// no source row to scope from), so it uses the DIRECT patient guard rather than
// patientAccessGuardForResource. Care-team-mode-governed (shadow today, 403 at
// GO_LIVE). The load-bearing existence + tenant check for the asserted
// patient_uid / admission_id lives in generatePatientReportExplanation.
const guardReportExplainer = patientAccessGuard('PATIENT_RECORD', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
  careTeamModeGoverned: true,
});

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

router.post('/lab-patient-explanations', guardLabExplainer, async (req, res, next) => {
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

router.post('/radiology-patient-explanations', guardRadiologyExplainer, async (req, res, next) => {
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

router.post('/patient-report-explanations', guardReportExplainer, async (req, res, next) => {
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

router.post('/prescription-patient-explanations', guardPrescriptionExplainer, async (req, res, next) => {
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

router.post('/invoice-patient-explanations', guardInvoiceExplainer, async (req, res, next) => {
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
