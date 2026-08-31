export const SAFE_PATIENT_ACCESS_DENIAL_MESSAGE =
  'Patient record access denied: no active care-team, referral, appointment, admission, guardian, or break-glass relationship';

export const ACCESS_POLICY_CODES = Object.freeze({
  PATIENT_RECORD_VIEW: 'patient.record.view',
  PATIENT_RECORD_UPLOAD: 'patient.record.upload',
  PATIENT_RECORD_EXTRACTION_VIEW: 'patient.record.extraction.view',
  PATIENT_RECORD_EXTRACTION_REVIEW: 'patient.record.extraction.review',
  PATIENT_RECORD_DELETE: 'patient.record.delete',
  PATIENT_TIMELINE_VIEW: 'patient.timeline.view',
  PATIENT_APPOINTMENT_VIEW: 'patient.appointment.view',
  PATIENT_APPOINTMENT_WRITE: 'patient.appointment.write',
  PATIENT_REALTIME_SUBSCRIBE: 'patient.realtime.subscribe',
  PATIENT_ADMISSION_VIEW: 'patient.admission.view',
  PATIENT_ADMISSION_WRITE: 'patient.admission.write',
  PATIENT_BED_VIEW: 'patient.bed.view',
  PATIENT_BED_WRITE: 'patient.bed.write',
  PATIENT_CLINICAL_WORKFLOW_ACCESS: 'patient.clinical_workflow.access',
  PATIENT_CLINICAL_WORKFLOW_WRITE: 'patient.clinical_workflow.write',
  PATIENT_CLINICAL_ORDER_VERIFY: 'patient.clinical_order.verify',
  PATIENT_CLINICAL_ORDER_MAR_RECOVERY: 'patient.clinical_order.mar_recovery',
  PATIENT_MAR_SUPPLY_RECONCILIATION_WRITE: 'patient.mar_supply_reconciliation.write',
  // Owner decision 2026-08-25 (see docs/ROADMAP.md, "BCMA wristband"). Used by
  // EXACTLY ONE route — GET /api/v1/bcma/wristband/:patientUid. It exists so
  // the administrator grant that decision authorises has a policy code of its
  // own and cannot reach any other PHI surface. Do not reuse it.
  PATIENT_WRISTBAND_PRINT: 'patient.wristband.print',
  PATIENT_CARE_PATHWAY_QUEUE_CLAIM: 'patient.care_pathway.queue_claim',
  PATIENT_CARE_PATHWAY_TRANSFER_READ: 'patient.care_pathway.transfer_read',
  PATIENT_CARE_PATHWAY_TRANSFER_DECLINE: 'patient.care_pathway.transfer_decline',
  PATIENT_MEDICATION_RECONCILIATION_WRITE: 'patient.medication_reconciliation.write',
  PATIENT_CONTINUITY_MAR_BACK_ENTRY: 'patient.continuity.mar_back_entry',
  PATIENT_CONTINUITY_SPECIMEN_BACK_ENTRY: 'patient.continuity.specimen_back_entry',
  PATIENT_CONTINUITY_TRANSFUSION_BACK_ENTRY: 'patient.continuity.transfusion_back_entry',
  // CareTeam ABAC family policies (LOW-1). Each previously-shadow PHI route
  // family resolves to a family-appropriate policy here instead of falling
  // through to the generic patient.record.view rules. All clinical families sit
  // at patient_relationship_required (PHI rank 3) and keep the full
  // care_team/referral/clinical_authorship/appointment/admission relationship
  // chain so a tenant flip to 'enforce' is judged on a real clinical link.
  PATIENT_CLINICAL_RECORD_VIEW: 'patient.clinical_record.view',
  PATIENT_CLINICAL_DOCUMENT_VIEW: 'patient.clinical_document.view',
  PATIENT_INVESTIGATION_VIEW: 'patient.investigation.view',
  PATIENT_LAB_RESULT_VIEW: 'patient.lab_result.view',
  PATIENT_RADIOLOGY_VIEW: 'patient.radiology.view',
  PATIENT_PHARMACY_ORDER_VIEW: 'patient.pharmacy_order.view',
  PATIENT_MEDICATION_ADMIN_VIEW: 'patient.medication_admin.view',
  PATIENT_CRITICAL_CARE_VIEW: 'patient.critical_care.view',
  PATIENT_BLOOD_BANK_VIEW: 'patient.blood_bank.view',
  PATIENT_SURGICAL_VIEW: 'patient.surgical.view',
  PATIENT_MATERNITY_PAEDIATRIC_VIEW: 'patient.maternity_paediatric.view',
});

const RELATIONSHIP_CHECKS = Object.freeze([
  'self',
  'guardian',
  'care_team',
  'referral',
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
  [ACCESS_POLICY_CODES.PATIENT_REALTIME_SUBSCRIBE]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_REALTIME_SUBSCRIBE,
    title: 'Subscribe to patient realtime updates',
    resourceType: 'realtime_patient_channel',
    action: 'VIEW',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: [],
    relationshipChecks: ['self', 'guardian', 'care_team', 'break_glass'],
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
    relationshipChecks: [
      ...RELATIONSHIP_CHECKS,
      'care_pathway_owner',
      'care_pathway_transfer_recipient',
    ],
  }),
  [ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
    title: 'Write patient clinical workflow',
    resourceType: 'clinical_workflow',
    action: 'UPDATE',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['ip_flow', 'theatre', 'cath_lab'],
    relationshipChecks: [
      ...RELATIONSHIP_CHECKS,
      'care_pathway_owner',
      'care_pathway_transfer_recipient',
    ],
  }),
  [ACCESS_POLICY_CODES.PATIENT_CLINICAL_ORDER_VERIFY]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_CLINICAL_ORDER_VERIFY,
    title: 'Verify an inpatient clinical order',
    resourceType: 'clinical_order_verification',
    action: 'UPDATE',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['ip_flow', 'pharmacy'],
    relationshipChecks: ['care_team', 'admission', 'break_glass'],
  }),
  [ACCESS_POLICY_CODES.PATIENT_CLINICAL_ORDER_MAR_RECOVERY]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_CLINICAL_ORDER_MAR_RECOVERY,
    title: 'Recover an inpatient medication order MAR schedule',
    resourceType: 'clinical_order_mar_recovery',
    action: 'UPDATE',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['ip_flow'],
    relationshipChecks: ['admission', 'break_glass'],
  }),
  [ACCESS_POLICY_CODES.PATIENT_MAR_SUPPLY_RECONCILIATION_WRITE]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_MAR_SUPPLY_RECONCILIATION_WRITE,
    title: 'Reconcile inpatient MAR supply evidence',
    resourceType: 'mar_supply_reconciliation',
    action: 'UPDATE',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['supply_chain', 'nursing_governance'],
    relationshipChecks: ['care_team', 'admission', 'break_glass'],
  }),
  // Wristband printing (owner decision 2026-08-25). The gate SURFACE — PHI
  // level, capability groups, relationship chain — is copied from
  // PATIENT_CLINICAL_WORKFLOW_ACCESS so every actor who could print a band
  // before this policy existed still can, on the same evidence.
  //
  // It is NOT a byte-for-byte copy, and an earlier version of this comment
  // claimed it was. Two deliberate differences: findClinicalAuthorshipRelationship
  // was code-gated to the clinical-workflow codes and had to learn this one, or
  // splitting the route out would have silently dropped the authorship allow
  // path; and the route binds an explicit patientSelector with
  // requirePatientContext (bcmaRoutes.js), which the clinical-workflow routes do
  // not, because resolvePatientForAccess consults req.phiContext before
  // req.params and an earlier mount guard can leave a DIFFERENT patient there.
  //
  // The grant difference is that accessDecisionService gives ADMIN and
  // SUPER_ADMIN a last-resort administrative allow for this code (and no other),
  // recorded as administrative access. Splitting it out is the whole point: the
  // administrator grant is keyed on this code, so widening it cannot leak into
  // the 27 sites that run on PATIENT_CLINICAL_WORKFLOW_ACCESS.
  [ACCESS_POLICY_CODES.PATIENT_WRISTBAND_PRINT]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_WRISTBAND_PRINT,
    title: 'Print a patient wristband',
    resourceType: 'patient_wristband',
    action: 'VIEW',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['ip_flow', 'nursing_governance', 'pharmacy', 'theatre', 'cath_lab'],
    // The full self/guardian/care_team/referral/clinical_authorship/appointment/
    // admission/break_glass chain, i.e. every check that can actually fire on
    // this route. PATIENT_CLINICAL_WORKFLOW_ACCESS additionally lists
    // care_pathway_owner and care_pathway_transfer_recipient; both resolvers
    // require a resourceContext of type care_pathway_instance /
    // care_handoff_instance, which the wristband guard never supplies, so they
    // were unreachable here before the split too. Listing them would be a
    // control that can never fire.
    relationshipChecks: RELATIONSHIP_CHECKS,
  }),
  [ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_QUEUE_CLAIM]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_QUEUE_CLAIM,
    title: 'Claim a role-owned care pathway',
    resourceType: 'clinical_workflow',
    action: 'UPDATE',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: [],
    relationshipChecks: ['care_pathway_role_queue_claimant'],
    breakGlassAllowed: false,
  }),
  [ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_TRANSFER_READ]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_TRANSFER_READ,
    title: 'Read a care pathway ownership transfer',
    resourceType: 'clinical_workflow',
    action: 'VIEW',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: [],
    relationshipChecks: ['care_pathway_transfer_recipient'],
    breakGlassAllowed: false,
  }),
  [ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_TRANSFER_DECLINE]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_TRANSFER_DECLINE,
    title: 'Decline a care pathway ownership transfer',
    resourceType: 'clinical_workflow',
    action: 'UPDATE',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: [],
    relationshipChecks: ['care_pathway_transfer_decline_recipient'],
    breakGlassAllowed: false,
  }),
  [ACCESS_POLICY_CODES.PATIENT_MEDICATION_RECONCILIATION_WRITE]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_MEDICATION_RECONCILIATION_WRITE,
    title: 'Write patient medication reconciliation',
    resourceType: 'medication_reconciliation',
    action: 'UPDATE',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['ip_flow', 'pharmacy'],
  }),
  [ACCESS_POLICY_CODES.PATIENT_CONTINUITY_MAR_BACK_ENTRY]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_CONTINUITY_MAR_BACK_ENTRY,
    title: 'Record retrospective continuity medication administration',
    resourceType: 'clinical_continuity_paper_fact',
    action: 'CREATE',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['ip_flow', 'nursing_governance', 'theatre', 'cath_lab'],
  }),
  [ACCESS_POLICY_CODES.PATIENT_CONTINUITY_SPECIMEN_BACK_ENTRY]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_CONTINUITY_SPECIMEN_BACK_ENTRY,
    title: 'Record retrospective continuity specimen collection',
    resourceType: 'clinical_continuity_paper_fact',
    action: 'CREATE',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['diagnostics', 'ip_flow', 'nursing_governance'],
  }),
  [ACCESS_POLICY_CODES.PATIENT_CONTINUITY_TRANSFUSION_BACK_ENTRY]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_CONTINUITY_TRANSFUSION_BACK_ENTRY,
    title: 'Record retrospective continuity transfusion verification',
    resourceType: 'clinical_continuity_paper_fact',
    action: 'CREATE',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['diagnostics', 'ip_flow', 'theatre', 'cath_lab', 'specialty_services'],
  }),
  // ---- CareTeam ABAC family policies (LOW-1) ----
  // Generic clinical-record family: encounters, problem lists, allergies,
  // nursing assessments, ward board. Broad clinical capability surface; the
  // care_team/referral/appointment/admission/authorship chain is the real gate.
  [ACCESS_POLICY_CODES.PATIENT_CLINICAL_RECORD_VIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_CLINICAL_RECORD_VIEW,
    title: 'Access patient clinical record',
    resourceType: 'clinical_record',
    action: 'ACCESS',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['ip_flow', 'op_flow', 'nursing_governance', 'theatre', 'cath_lab'],
  }),
  // Clinical documents authored by the care team / referral chain: discharge
  // summaries, referrals, death certification.
  [ACCESS_POLICY_CODES.PATIENT_CLINICAL_DOCUMENT_VIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_CLINICAL_DOCUMENT_VIEW,
    title: 'Access patient clinical document',
    resourceType: 'clinical_document',
    action: 'ACCESS',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['ip_flow', 'op_flow', 'nursing_governance'],
  }),
  // Diagnostics — investigations.
  [ACCESS_POLICY_CODES.PATIENT_INVESTIGATION_VIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_INVESTIGATION_VIEW,
    title: 'View patient investigations',
    resourceType: 'investigation',
    action: 'VIEW',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['diagnostics', 'ip_flow', 'op_flow', 'nursing_governance', 'theatre', 'cath_lab'],
  }),
  // Diagnostics — lab results + microbiology.
  [ACCESS_POLICY_CODES.PATIENT_LAB_RESULT_VIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_LAB_RESULT_VIEW,
    title: 'View patient laboratory results',
    resourceType: 'lab_result',
    action: 'VIEW',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['diagnostics', 'ip_flow', 'op_flow', 'nursing_governance', 'theatre', 'cath_lab'],
  }),
  // Diagnostics — radiology + PACS.
  [ACCESS_POLICY_CODES.PATIENT_RADIOLOGY_VIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_RADIOLOGY_VIEW,
    title: 'View patient radiology',
    resourceType: 'radiology',
    action: 'VIEW',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['diagnostics', 'ip_flow', 'op_flow', 'nursing_governance'],
  }),
  // Pharmacy orders + prescriptions.
  [ACCESS_POLICY_CODES.PATIENT_PHARMACY_ORDER_VIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_PHARMACY_ORDER_VIEW,
    title: 'View patient pharmacy orders',
    resourceType: 'pharmacy_order',
    action: 'VIEW',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['pharmacy', 'ip_flow', 'op_flow'],
  }),
  // Bedside medication administration (BCMA) + medication reconciliation review.
  [ACCESS_POLICY_CODES.PATIENT_MEDICATION_ADMIN_VIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_MEDICATION_ADMIN_VIEW,
    title: 'View patient medication administration',
    resourceType: 'medication_administration',
    action: 'VIEW',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['pharmacy', 'ip_flow', 'nursing_governance'],
  }),
  // Critical care — ICU + dialysis.
  [ACCESS_POLICY_CODES.PATIENT_CRITICAL_CARE_VIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_CRITICAL_CARE_VIEW,
    title: 'Access patient critical-care record',
    resourceType: 'critical_care_record',
    action: 'ACCESS',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['ip_flow', 'emergency', 'nursing_governance', 'specialty_services'],
  }),
  // Blood bank / transfusion.
  [ACCESS_POLICY_CODES.PATIENT_BLOOD_BANK_VIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_BLOOD_BANK_VIEW,
    title: 'View patient blood bank record',
    resourceType: 'blood_bank_record',
    action: 'VIEW',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['diagnostics', 'ip_flow', 'theatre', 'cath_lab', 'specialty_services'],
  }),
  // Theatre / anaesthesia / surgical documentation.
  [ACCESS_POLICY_CODES.PATIENT_SURGICAL_VIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_SURGICAL_VIEW,
    title: 'Access patient surgical record',
    resourceType: 'surgical_record',
    action: 'ACCESS',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['theatre', 'cath_lab', 'ip_flow'],
  }),
  // Maternity + paediatric immunisation.
  [ACCESS_POLICY_CODES.PATIENT_MATERNITY_PAEDIATRIC_VIEW]: policy({
    code: ACCESS_POLICY_CODES.PATIENT_MATERNITY_PAEDIATRIC_VIEW,
    title: 'Access patient maternity or paediatric record',
    resourceType: 'maternity_paediatric_record',
    action: 'ACCESS',
    requiredPhiLevel: 'patient_relationship_required',
    capabilityGroups: ['ip_flow', 'op_flow'],
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
    || normalized === 'CARE_PATHWAY'
    || normalized === 'EMR'
    || normalized === 'CLINICAL_NOTE'
    || normalized === 'CLINICAL_ORDER'
    || normalized === 'CLINICAL_DECISION'
    || normalized === 'VITAL_SIGN'
    || normalized === 'MAR'
    || normalized === 'NURSE_HANDOVER'
    || normalized === 'DIAGNOSIS') {
    return ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS;
  }

  // ---- CareTeam ABAC family record types (LOW-1) ----
  // Diagnostics
  if (normalized === 'INVESTIGATION') return ACCESS_POLICY_CODES.PATIENT_INVESTIGATION_VIEW;
  if (normalized === 'LAB_RESULT'
    || normalized === 'MICROBIOLOGY'
    || normalized === 'PATHOLOGY'
    || normalized === 'ANATOMIC_PATHOLOGY') return ACCESS_POLICY_CODES.PATIENT_LAB_RESULT_VIEW;
  if (normalized === 'RADIOLOGY' || normalized === 'RADIOLOGY_PACS') return ACCESS_POLICY_CODES.PATIENT_RADIOLOGY_VIEW;
  // Medication
  if (normalized === 'PHARMACY_ORDER' || normalized === 'PRESCRIPTION') return ACCESS_POLICY_CODES.PATIENT_PHARMACY_ORDER_VIEW;
  if (normalized === 'BCMA' || normalized === 'MED_REC') return ACCESS_POLICY_CODES.PATIENT_MEDICATION_ADMIN_VIEW;
  // Critical care + specialty procedures
  if (normalized === 'ICU' || normalized === 'DIALYSIS' || normalized === 'BURN_CHART') {
    return ACCESS_POLICY_CODES.PATIENT_CRITICAL_CARE_VIEW;
  }
  if (normalized === 'BLOOD_BANK') return ACCESS_POLICY_CODES.PATIENT_BLOOD_BANK_VIEW;
  if (normalized === 'OPERATING_THEATRE'
    || normalized === 'ANESTHESIA_CHART'
    || normalized === 'SURGICAL_DOCUMENTATION') {
    return ACCESS_POLICY_CODES.PATIENT_SURGICAL_VIEW;
  }
  if (normalized === 'MATERNITY_RECORD' || normalized === 'PAEDIATRIC_IMMUNISATION') {
    return ACCESS_POLICY_CODES.PATIENT_MATERNITY_PAEDIATRIC_VIEW;
  }
  // Clinical documents (authored by / referred through the care team)
  if (normalized === 'DISCHARGE_SUMMARY'
    || normalized === 'REFERRAL'
    || normalized === 'DEATH_CERTIFICATION') {
    return ACCESS_POLICY_CODES.PATIENT_CLINICAL_DOCUMENT_VIEW;
  }
  // Generic clinical records: encounters, problem lists, allergies, nursing
  // assessments, ward board.
  if (normalized === 'CLINICAL_ENCOUNTER'
    || normalized === 'ENCOUNTER'
    || normalized === 'PROBLEM_LIST'
    || normalized === 'PROBLEM'
    || normalized === 'ALLERGY'
    || normalized === 'NURSING_ASSESSMENT'
    || normalized === 'WARD_BOARD') {
    return ACCESS_POLICY_CODES.PATIENT_CLINICAL_RECORD_VIEW;
  }

  return ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW;
}
