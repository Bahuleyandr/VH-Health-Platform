import { patientAccessGuard, patientAccessGuardForResource } from '../../middleware/phiAccessMiddleware.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessDecisionService.js';

export const guardClinicalVitalsWrite = patientAccessGuard('VITAL_SIGN', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
});

export const guardVitalsResourceWrite = patientAccessGuardForResource('VITAL_SIGN', {
  policyCode: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
  resourceType: 'vitals',
  idSelector: (req) => req.params?.vitalsId ?? req.params?.id ?? null,
});
