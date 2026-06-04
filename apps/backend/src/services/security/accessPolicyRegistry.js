export const SAFE_PATIENT_ACCESS_DENIAL_MESSAGE =
  'Patient record access denied: no active care-team, appointment, admission, guardian, or break-glass relationship';

export const ACCESS_POLICY_CODES = Object.freeze({
  PATIENT_RECORD_VIEW: 'patient.record.view',
  PATIENT_RECORD_UPLOAD: 'patient.record.upload',
  PATIENT_RECORD_EXTRACTION_VIEW: 'patient.record.extraction.view',
  PATIENT_RECORD_EXTRACTION_REVIEW: 'patient.record.extraction.review',
  PATIENT_RECORD_DELETE: 'patient.record.delete',
  PATIENT_TIMELINE_VIEW: 'patient.timeline.view',
  PATIENT_APPOINTMENT_VIEW: 'patient.appointment.view',
  PATIENT_APPOINTMENT_WRITE: 'patient.appointment.write',
  PATIENT_ADMISSION_VIEW: 'patient.admission.view',
  PATIENT_ADMISSION_WRITE: 'patient.admission.write',
  PATIENT_BED_VIEW: 'patient.bed.view',
  PATIENT_BED_WRITE: 'patient.bed.write',
  PATIENT_CLINICAL_WORKFLOW_ACCESS: 'patient.clinical_workflow.access',
  PATIENT_CLINICAL_WORKFLOW_WRITE: 'patient.clinical_workflow.write',
});

const RELATIONSHIP_CHECKS = Object.freeze([
  'self',
  'guardian',
  'care_team',
  'clinical_authorship',
  'appointment',
  'admission',
  'break_glass',
]);

const DEFAULT_SAFE_DENIAL = Object.freeze({
  safe_denial_code: 'PATIENT_ACCESS_DENIED',
  safe_denial_message: SAFE_PATIENT_ACCESS_DENIAL_MESSAGE,
});

function policy({
  code,
  title,
  resourceType,
  action,
  requiredPhiLevel = 'basic_patient_context',
  capabilityGroups,
  relationshipChecks = RELATIONSHIP_CHECKS,
  breakGlassAllowed = true,
}) {
  return {
    code,
    title,
    resource_type: resourceType,
    action,
    required_phi_level: requiredPhiLevel,
    capability_groups: capabilityGroups,
    relationship_checks: relationshipChecks,
    break_glass_allowed: breakGlassAllowed,
    audit_required: true,
    ...DEFAULT_SAFE_DENIAL,
  };
}

export const ACCESS_POLICIES = Object.freeze({
  [ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
    title: 'View patient records',
    resourceType: 'patient_record',
    action: 'VIEW',
    capabilityGroups: ['op_flow', 'ip_flow', 'nursing_governance'],
  }),
  [ACCESS_POLICY_CODES.PATIENT_RECORD_UPLOAD]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_RECORD_UPLOAD,
    title: 'Upload patient records',
    resourceType: 'patient_record',
    action: 'CREATE',
    capabilityGroups: ['op_flow', 'ip_flow', 'nursing_governance'],
  }),
  [ACCESS_POLICY_CODES.PATIENT_RECORD_EXTRACTION_VIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_RECORD_EXTRACTION_VIEW,
    title: 'View patient record extraction',
    resourceType: 'patient_record_extraction',
    action: 'VIEW',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['op_flow', 'ip_flow'],
  }),
  [ACCESS_POLICY_CODES.PATIENT_RECORD_EXTRACTION_REVIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_RECORD_EXTRACTION_REVIEW,
    title: 'Review patient record extraction',
    resourceType: 'patient_record_extraction',
    action: 'UPDATE',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['ip_flow'],
    relationshipChecks: ['care_team', 'appointment', 'admission', 'break_glass'],
  }),
  [ACCESS_POLICY_CODES.PATIENT_RECORD_DELETE]: {
    code: ACCESS_POLICY_CODES.PATIENT_RECORD_DELETE,
    title: 'Delete patient uploaded record',
    resource_type: 'patient_record',
    action: 'DELETE',
    required_phi_level: 'own_record',
    capability_groups: [],
    relationship_checks: ['self', 'guardian'],
    break_glass_allowed: false,
    audit_required: true,
    safe_denial_code: 'PATIENT_ACCESS_DENIED',
    safe_denial_message: SAFE_PATIENT_ACCESS_DENIAL_MESSAGE,
  },
  [ACCESS_POLICY_CODES.PATIENT_TIMELINE_VIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_TIMELINE_VIEW,
    title: 'View patient timeline',
    resourceType: 'patient_timeline',
    action: 'VIEW',
    capabilityGroups: ['op_flow', 'ip_flow', 'nursing_governance'],
  }),
  [ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_VIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_VIEW,
    title: 'View patient appointment',
    resourceType: 'appointment',
    action: 'VIEW',
    capabilityGroups: ['op_flow', 'billing'],
  }),
  [ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_WRITE]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_WRITE,
    title: 'Update patient appointment',
    resourceType: 'appointment',
    action: 'UPDATE',
    capabilityGroups: ['op_flow', 'billing'],
  }),
  [ACCESS_POLICY_CODES.PATIENT_ADMISSION_VIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_ADMISSION_VIEW,
    title: 'View patient admission',
    resourceType: 'admission',
    action: 'VIEW',
    capabilityGroups: ['op_flow', 'ip_flow', 'billing', 'nursing_governance'],
  }),
  [ACCESS_POLICY_CODES.PATIENT_ADMISSION_WRITE]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_ADMISSION_WRITE,
    title: 'Update patient admission',
    resourceType: 'admission',
    action: 'UPDATE',
    capabilityGroups: ['op_flow', 'ip_flow', 'billing', 'nursing_governance'],
  }),
  [ACCESS_POLICY_CODES.PATIENT_BED_VIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_BED_VIEW,
    title: 'View occupied bed patient context',
    resourceType: 'bed',
    action: 'VIEW',
    capabilityGroups: ['op_flow', 'ip_flow', 'nursing_governance'],
  }),
  [ACCESS_POLICY_CODES.PATIENT_BED_WRITE]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_BED_WRITE,
    title: 'Update occupied bed patient context',
    resourceType: 'bed',
    action: 'UPDATE',
    capabilityGroups: ['op_flow', 'ip_flow', 'nursing_governance'],
  }),
  [ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
    title: 'Access patient clinical workflow',
    resourceType: 'clinical_workflow',
    action: 'ACCESS',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['ip_flow', 'nursing_governance', 'pharmacy', 'theatre', 'cath_lab'],
  }),
  [ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
    title: 'Write patient clinical workflow',
    resourceType: 'clinical_workflow',
    action: 'UPDATE',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['ip_flow', 'theatre', 'cath_lab'],
  }),
});

export function getAccessPolicy(policyCode) {
  return ACCESS_POLICIES[policyCode] || null;
}

export function policyCodeForRecordType(recordType = 'PHI') {
  const normalized = String(recordType || '').trim().toUpperCase();
  if (normalized === 'EMR_TIMELINE') return ACCESS_POLICY_CODES.PATIENT_TIMELINE_VIEW;
  if (normalized === 'APPOINTMENT') return ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_VIEW;
  if (normalized === 'ADMISSION') return ACCESS_POLICY_CODES.PATIENT_ADMISSION_VIEW;
  if (normalized === 'BED_BOARD' || normalized === 'BED_MANAGEMENT') return ACCESS_POLICY_CODES.PATIENT_BED_VIEW;
  if (normalized === 'CLINICAL_WORKFLOW'
    || normalized === 'EMR'
    || normalized === 'CLINICAL_NOTE'
    || normalized === 'CLINICAL_ORDER'
    || normalized === 'VITAL_SIGN'
    || normalized === 'MAR'
    || normalized === 'NURSE_HANDOVER'
    || normalized === 'DIAGNOSIS') {
    return ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS;
  }
  return ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW;
}
