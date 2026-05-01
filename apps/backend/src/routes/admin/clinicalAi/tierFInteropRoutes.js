/**
 * Tier F interoperability admin routes (5 endpoints).
 */

import express from 'express';

import {
  generateAbdmCareContext,
  generateDocumentPatientMatching,
  generateFhirValidation,
  generateHealthRecordReconciliation,
  generateMedicalRecordBundle,
} from '../../../services/ai/tierFInteropService.js';
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

router.post('/fhir-validations', async (req, res, next) => {
  try {
    const result = await generateFhirValidation({
      tenantId: req.tenantId, resourceType: req.body?.resource_type,
      resourceJson: req.body?.resource_json,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_FHIR_VALIDATION_GENERATED', result, 'FHIR validation drafted');
  } catch (err) { return next(err); }
});

router.post('/abdm-care-contexts', async (req, res, next) => {
  try {
    const result = await generateAbdmCareContext({
      tenantId: req.tenantId, admissionId: req.body?.admission_id,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_ABDM_CARE_CONTEXT_GENERATED', result, 'ABDM Care Context drafted');
  } catch (err) { return next(err); }
});

router.post('/health-record-reconciliations', async (req, res, next) => {
  try {
    const result = await generateHealthRecordReconciliation({
      tenantId: req.tenantId, recordA: req.body?.record_a, recordB: req.body?.record_b,
      patientUid: req.body?.patient_uid,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_RECORD_RECONCILIATION_GENERATED', result, 'Record reconciliation drafted');
  } catch (err) { return next(err); }
});

router.post('/document-patient-matching', async (req, res, next) => {
  try {
    const result = await generateDocumentPatientMatching({
      tenantId: req.tenantId, documentText: req.body?.document_text,
      candidatePatients: req.body?.candidate_patients,
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_DOCUMENT_PATIENT_MATCHING_GENERATED', result, 'Document patient matching drafted');
  } catch (err) { return next(err); }
});

router.post('/medical-record-bundles', async (req, res, next) => {
  try {
    const result = await generateMedicalRecordBundle({
      tenantId: req.tenantId, admissionId: req.body?.admission_id,
      scope: req.body?.scope || 'insurance',
      generatedBy: req.user?.uid || null, req,
    });
    return auditAndReturn(req, res, 'CLINICAL_AI_MEDICAL_RECORD_BUNDLE_GENERATED', result, 'Medical record bundle drafted');
  } catch (err) { return next(err); }
});

export default router;
