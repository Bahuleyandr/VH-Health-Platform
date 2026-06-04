export const SAFE_PATIENT_ACCESS_DENIAL_MESSAGE =
  'Patient record access denied: no active care-team, appointment, admission, guardian, or break-glass relationship';

export const ACCESS_POLICY_CODES = Object.freeze({
  PATIENT_RECORD_VIEW: 'patient.record.view',
  PATIENT_RECORD_UPLOAD: 'patient.record.upload',
  PATIENT_RECORD_EXTRACTION_VIEW: 'patient.record.extraction.view',
  PATIENT_RECORD_EXTRACTION_REVIEW: 'patient.record.extraction.review',
  PATIENT_RECORD_DELETE: 'patient.record.delete',
  PATIENT_TIMELINE_VIEW: 'patient.timeline.view',
});

export const ACCESS_POLICIES = Object.freeze({
  [ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW]: {
    code: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
    title: 'View patient records',
    resource_type: 'patient_record',
    action: 'VIEW',
    required_phi_level: 'basic_patient_context',
    capability_groups: ['op_flow', 'ip_flow', 'nursing_governance'],
    relationship_checks: ['self', 'guardian', 'care_team', 'appointment', 'admission', 'break_glass'],
    break_glass_allowed: true,
    audit_required: true,
    safe_denial_code: 'PATIENT_ACCESS_DENIED',
    safe_denial_message: SAFE_PATIENT_ACCESS_DENIAL_MESSAGE,
  },
  [ACCESS_POLICY_CODES.PATIENT_RECORD_UPLOAD]: {
    code: ACCESS_POLICY_CODES.PATIENT_RECORD_UPLOAD,
    title: 'Upload patient records',
    resource_type: 'patient_record',
    action: 'CREATE',
    required_phi_level: 'basic_patient_context',
    capability_groups: ['op_flow', 'ip_flow', 'nursing_governance'],
    relationship_checks: ['self', 'guardian', 'care_team', 'appointment', 'admission', 'break_glass'],
    break_glass_allowed: true,
    audit_required: true,
    safe_denial_code: 'PATIENT_ACCESS_DENIED',
    safe_denial_message: SAFE_PATIENT_ACCESS_DENIAL_MESSAGE,
  },
  [ACCESS_POLICY_CODES.PATIENT_RECORD_EXTRACTION_VIEW]: {
    code: ACCESS_POLICY_CODES.PATIENT_RECORD_EXTRACTION_VIEW,
    title: 'View patient record extraction',
    resource_type: 'patient_record_extraction',
    action: 'VIEW',
    required_phi_level: 'patient_relationship_required',
    capability_groups: ['op_flow', 'ip_flow'],
    relationship_checks: ['self', 'guardian', 'care_team', 'appointment', 'admission', 'break_glass'],
    break_glass_allowed: true,
    audit_required: true,
    safe_denial_code: 'PATIENT_ACCESS_DENIED',
    safe_denial_message: SAFE_PATIENT_ACCESS_DENIAL_MESSAGE,
  },
  [ACCESS_POLICY_CODES.PATIENT_RECORD_EXTRACTION_REVIEW]: {
    code: ACCESS_POLICY_CODES.PATIENT_RECORD_EXTRACTION_REVIEW,
    title: 'Review patient record extraction',
    resource_type: 'patient_record_extraction',
    action: 'UPDATE',
    required_phi_level: 'patient_relationship_required',
    capability_groups: ['ip_flow'],
    relationship_checks: ['care_team', 'appointment', 'admission', 'break_glass'],
    break_glass_allowed: true,
    audit_required: true,
    safe_denial_code: 'PATIENT_ACCESS_DENIED',
    safe_denial_message: SAFE_PATIENT_ACCESS_DENIAL_MESSAGE,
  },
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
  [ACCESS_POLICY_CODES.PATIENT_TIMELINE_VIEW]: {
    code: ACCESS_POLICY_CODES.PATIENT_TIMELINE_VIEW,
    title: 'View patient timeline',
    resource_type: 'patient_timeline',
    action: 'VIEW',
    required_phi_level: 'basic_patient_context',
    capability_groups: ['op_flow', 'ip_flow', 'nursing_governance'],
    relationship_checks: ['self', 'guardian', 'care_team', 'appointment', 'admission', 'break_glass'],
    break_glass_allowed: true,
    audit_required: true,
    safe_denial_code: 'PATIENT_ACCESS_DENIED',
    safe_denial_message: SAFE_PATIENT_ACCESS_DENIAL_MESSAGE,
  },
});

export function getAccessPolicy(policyCode) {
  return ACCESS_POLICIES[policyCode] || null;
}

export function policyCodeForRecordType(recordType = 'PHI') {
  const normalized = String(recordType || '').trim().toUpperCase();
  if (normalized === 'EMR_TIMELINE') return ACCESS_POLICY_CODES.PATIENT_TIMELINE_VIEW;
  return ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW;
}
