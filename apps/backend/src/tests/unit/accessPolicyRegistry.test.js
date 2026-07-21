import {
  ACCESS_POLICY_CODES,
  ACCESS_POLICIES,
  getAccessPolicy,
  policyCodeForRecordType,
} from '../../services/security/accessPolicyRegistry.js';

// LOW-1: every PHI route family the CareTeam ABAC guard now covers (shadow)
// must resolve to a family-appropriate policy with the correct PHI level + a
// relationship chain that includes care_team — NOT the generic
// patient.record.view fallback. Before any tenant flips to 'enforce', this is
// the contract that keeps each family judged on a real clinical relationship.

// recordType (exact spelling the app.js guards pass) -> intended policy code.
const FAMILY_RECORD_TYPE_MAP = {
  // Diagnostics
  INVESTIGATION: ACCESS_POLICY_CODES.PATIENT_INVESTIGATION_VIEW,
  LAB_RESULT: ACCESS_POLICY_CODES.PATIENT_LAB_RESULT_VIEW,
  MICROBIOLOGY: ACCESS_POLICY_CODES.PATIENT_LAB_RESULT_VIEW,
  RADIOLOGY: ACCESS_POLICY_CODES.PATIENT_RADIOLOGY_VIEW,
  RADIOLOGY_PACS: ACCESS_POLICY_CODES.PATIENT_RADIOLOGY_VIEW,
  // Medication
  PHARMACY_ORDER: ACCESS_POLICY_CODES.PATIENT_PHARMACY_ORDER_VIEW,
  PRESCRIPTION: ACCESS_POLICY_CODES.PATIENT_PHARMACY_ORDER_VIEW,
  BCMA: ACCESS_POLICY_CODES.PATIENT_MEDICATION_ADMIN_VIEW,
  MED_REC: ACCESS_POLICY_CODES.PATIENT_MEDICATION_ADMIN_VIEW,
  // Critical care + specialty procedures
  ICU: ACCESS_POLICY_CODES.PATIENT_CRITICAL_CARE_VIEW,
  DIALYSIS: ACCESS_POLICY_CODES.PATIENT_CRITICAL_CARE_VIEW,
  BLOOD_BANK: ACCESS_POLICY_CODES.PATIENT_BLOOD_BANK_VIEW,
  OPERATING_THEATRE: ACCESS_POLICY_CODES.PATIENT_SURGICAL_VIEW,
  ANESTHESIA_CHART: ACCESS_POLICY_CODES.PATIENT_SURGICAL_VIEW,
  SURGICAL_DOCUMENTATION: ACCESS_POLICY_CODES.PATIENT_SURGICAL_VIEW,
  MATERNITY_RECORD: ACCESS_POLICY_CODES.PATIENT_MATERNITY_PAEDIATRIC_VIEW,
  PAEDIATRIC_IMMUNISATION: ACCESS_POLICY_CODES.PATIENT_MATERNITY_PAEDIATRIC_VIEW,
  // Clinical documents
  DISCHARGE_SUMMARY: ACCESS_POLICY_CODES.PATIENT_CLINICAL_DOCUMENT_VIEW,
  REFERRAL: ACCESS_POLICY_CODES.PATIENT_CLINICAL_DOCUMENT_VIEW,
  DEATH_CERTIFICATION: ACCESS_POLICY_CODES.PATIENT_CLINICAL_DOCUMENT_VIEW,
  // Generic clinical records
  CLINICAL_ENCOUNTER: ACCESS_POLICY_CODES.PATIENT_CLINICAL_RECORD_VIEW,
  ENCOUNTER: ACCESS_POLICY_CODES.PATIENT_CLINICAL_RECORD_VIEW,
  PROBLEM_LIST: ACCESS_POLICY_CODES.PATIENT_CLINICAL_RECORD_VIEW,
  PROBLEM: ACCESS_POLICY_CODES.PATIENT_CLINICAL_RECORD_VIEW,
  ALLERGY: ACCESS_POLICY_CODES.PATIENT_CLINICAL_RECORD_VIEW,
  NURSING_ASSESSMENT: ACCESS_POLICY_CODES.PATIENT_CLINICAL_RECORD_VIEW,
  WARD_BOARD: ACCESS_POLICY_CODES.PATIENT_CLINICAL_RECORD_VIEW,
  // Clinical-workflow families already covered by the EMR guards.
  CLINICAL_DECISION: ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
};

describe('policyCodeForRecordType — CareTeam ABAC family mappings (LOW-1)', () => {
  it('maps every guarded PHI family to a non-fallback, family-appropriate policy', () => {
    for (const [recordType, expectedCode] of Object.entries(FAMILY_RECORD_TYPE_MAP)) {
      const code = policyCodeForRecordType(recordType);
      expect(code).toBe(expectedCode);
      // Must NOT collapse to the generic record-view fallback.
      expect(code).not.toBe(ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW);
    }
  });

  it('resolves each mapped record type to a registered policy at PHI rank patient_relationship_required', () => {
    for (const recordType of Object.keys(FAMILY_RECORD_TYPE_MAP)) {
      const policy = getAccessPolicy(policyCodeForRecordType(recordType));
      expect(policy).toBeTruthy();
      expect(policy.required_phi_level).toBe('patient_relationship_required');
    }
  });

  it('keeps care_team in the relationship chain for every mapped family', () => {
    for (const recordType of Object.keys(FAMILY_RECORD_TYPE_MAP)) {
      const policy = getAccessPolicy(policyCodeForRecordType(recordType));
      expect(policy.relationship_checks).toEqual(expect.arrayContaining(['care_team']));
    }
  });

  it('keeps the full clinical relationship chain (referral/appointment/admission/clinical_authorship) on the new family policies', () => {
    const newFamilyCodes = [
      ACCESS_POLICY_CODES.PATIENT_CLINICAL_RECORD_VIEW,
      ACCESS_POLICY_CODES.PATIENT_CLINICAL_DOCUMENT_VIEW,
      ACCESS_POLICY_CODES.PATIENT_INVESTIGATION_VIEW,
      ACCESS_POLICY_CODES.PATIENT_LAB_RESULT_VIEW,
      ACCESS_POLICY_CODES.PATIENT_RADIOLOGY_VIEW,
      ACCESS_POLICY_CODES.PATIENT_PHARMACY_ORDER_VIEW,
      ACCESS_POLICY_CODES.PATIENT_MEDICATION_ADMIN_VIEW,
      ACCESS_POLICY_CODES.PATIENT_CRITICAL_CARE_VIEW,
      ACCESS_POLICY_CODES.PATIENT_BLOOD_BANK_VIEW,
      ACCESS_POLICY_CODES.PATIENT_SURGICAL_VIEW,
      ACCESS_POLICY_CODES.PATIENT_MATERNITY_PAEDIATRIC_VIEW,
    ];
    for (const code of newFamilyCodes) {
      const policy = getAccessPolicy(code);
      expect(policy).toBeTruthy();
      expect(policy.relationship_checks).toEqual(
        expect.arrayContaining(['care_team', 'referral', 'clinical_authorship', 'appointment', 'admission', 'break_glass']),
      );
      expect(policy.break_glass_allowed).toBe(true);
      expect(policy.audit_required).toBe(true);
    }
  });
});

describe('policyCodeForRecordType — safe fallback is unchanged', () => {
  it('adds pathway ownership to workflow policies and exact transfer-recipient access only to its three bounded policies', () => {
    expect(getAccessPolicy(ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS).relationship_checks)
      .toContain('care_pathway_owner');
    expect(getAccessPolicy(ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE).relationship_checks)
      .toContain('care_pathway_owner');
    expect(getAccessPolicy(ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS).relationship_checks)
      .toContain('care_pathway_transfer_recipient');
    expect(getAccessPolicy(ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE).relationship_checks)
      .toContain('care_pathway_transfer_recipient');
    expect(getAccessPolicy(ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_TRANSFER_READ))
      .toMatchObject({
        code: 'patient.care_pathway.transfer_read',
        resource_type: 'clinical_workflow',
        action: 'VIEW',
        required_phi_level: 'patient_relationship_required',
        relationship_checks: ['care_pathway_transfer_recipient'],
        break_glass_allowed: false,
      });

    for (const [code, policy] of Object.entries(ACCESS_POLICIES)) {
      if ([
        ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS,
        ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_WRITE,
        ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_TRANSFER_READ,
      ].includes(code)) continue;
      expect(policy.relationship_checks).not.toContain('care_pathway_owner');
      expect(policy.relationship_checks).not.toContain('care_pathway_transfer_recipient');
    }
  });

  it('keeps role-queue claim authority on one break-glass-free claim-only policy', () => {
    const claim = getAccessPolicy(ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_QUEUE_CLAIM);
    expect(claim).toMatchObject({
      code: 'patient.care_pathway.queue_claim',
      resource_type: 'clinical_workflow',
      action: 'UPDATE',
      required_phi_level: 'patient_relationship_required',
      relationship_checks: ['care_pathway_role_queue_claimant'],
      break_glass_allowed: false,
    });
    for (const [code, registeredPolicy] of Object.entries(ACCESS_POLICIES)) {
      if (code === ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_QUEUE_CLAIM) continue;
      expect(registeredPolicy.relationship_checks)
        .not.toContain('care_pathway_role_queue_claimant');
    }
  });

  it('keeps transfer-decline authority on one break-glass-free decline-only policy', () => {
    const decline = getAccessPolicy(
      ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_TRANSFER_DECLINE,
    );
    expect(decline).toMatchObject({
      code: 'patient.care_pathway.transfer_decline',
      resource_type: 'clinical_workflow',
      action: 'UPDATE',
      required_phi_level: 'patient_relationship_required',
      relationship_checks: ['care_pathway_transfer_decline_recipient'],
      break_glass_allowed: false,
    });
    for (const [code, registeredPolicy] of Object.entries(ACCESS_POLICIES)) {
      if (code === ACCESS_POLICY_CODES.PATIENT_CARE_PATHWAY_TRANSFER_DECLINE) continue;
      expect(registeredPolicy.relationship_checks)
        .not.toContain('care_pathway_transfer_decline_recipient');
    }
  });

  it('falls back to patient.record.view for unknown / unmapped record types', () => {
    expect(policyCodeForRecordType('PHI')).toBe(ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW);
    expect(policyCodeForRecordType('MEDICAL_RECORD')).toBe(ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW);
    expect(policyCodeForRecordType('SOMETHING_NEW_AND_UNMAPPED')).toBe(ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW);
    expect(policyCodeForRecordType('')).toBe(ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW);
    expect(policyCodeForRecordType()).toBe(ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW);
  });

  it('does not weaken the patient.record.view fallback policy itself', () => {
    const fallback = ACCESS_POLICIES[ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW];
    expect(fallback.required_phi_level).toBe('basic_patient_context');
    expect(fallback.relationship_checks).toEqual([
      'self',
      'guardian',
      'care_team',
      'referral',
      'clinical_authorship',
      'appointment',
      'admission',
      'break_glass',
    ]);
    expect(fallback.audit_required).toBe(true);
  });

  it('preserves pre-existing record-type mappings', () => {
    expect(policyCodeForRecordType('EMR_TIMELINE')).toBe(ACCESS_POLICY_CODES.PATIENT_TIMELINE_VIEW);
    expect(policyCodeForRecordType('APPOINTMENT')).toBe(ACCESS_POLICY_CODES.PATIENT_APPOINTMENT_VIEW);
    expect(policyCodeForRecordType('ADMISSION')).toBe(ACCESS_POLICY_CODES.PATIENT_ADMISSION_VIEW);
    expect(policyCodeForRecordType('BED_BOARD')).toBe(ACCESS_POLICY_CODES.PATIENT_BED_VIEW);
    expect(policyCodeForRecordType('BED_MANAGEMENT')).toBe(ACCESS_POLICY_CODES.PATIENT_BED_VIEW);
    expect(policyCodeForRecordType('CLINICAL_NOTE')).toBe(ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS);
    expect(policyCodeForRecordType('CARE_PATHWAY')).toBe(ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS);
    expect(policyCodeForRecordType('CLINICAL_ORDER')).toBe(ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS);
    expect(policyCodeForRecordType('VITAL_SIGN')).toBe(ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS);
    expect(policyCodeForRecordType('MAR')).toBe(ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS);
    expect(policyCodeForRecordType('DIAGNOSIS')).toBe(ACCESS_POLICY_CODES.PATIENT_CLINICAL_WORKFLOW_ACCESS);
  });
});
