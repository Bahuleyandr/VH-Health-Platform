import {
  buildAppealLetterSections,
  classifyDenialReason,
  extractClinicalEvidence,
  __testing__,
} from '../../services/ai/appealLetterGeneratorService.js';

function note(overrides = {}) {
  return {
    event_type: 'clinical_note',
    id: overrides.id || 1,
    summary: overrides.summary || 'Admission H&P',
    sub_type: overrides.sub_type || 'progress',
    timestamp: overrides.timestamp || '2026-04-20T10:00:00.000Z',
    payload: overrides.payload || { is_signed: true },
  };
}

function diagnosis(overrides = {}) {
  return {
    id: overrides.id || 1,
    icd10_code: overrides.icd10_code || 'J18.9',
    description: overrides.description || 'Pneumonia, unspecified organism',
    status: overrides.status || 'active',
    timestamp: overrides.timestamp || '2026-04-20T09:00:00.000Z',
  };
}

function procedureOrder(overrides = {}) {
  return {
    event_type: 'clinical_order',
    id: overrides.id || 10,
    summary: overrides.summary || 'Bronchoscopy procedure',
    timestamp: overrides.timestamp || '2026-04-21T12:00:00.000Z',
    payload: overrides.payload || {
      order_type: 'procedure',
      procedure_code: '31622',
      procedure_description: 'Bronchoscopy',
    },
  };
}

const { mapPriorAuthToAppealSubject } = __testing__ || {};

describe('mapPriorAuthToAppealSubject', () => {
  const pa = {
    id: 42,
    tenant_id: 't1',
    patient_uid: 'p1',
    admission_id: 7,
    payer_name: 'Acme Health',
    policy_number: 'POL-9',
    procedure_code: '0SR90JZ',
    procedure_description: 'Hip replacement',
    payer_reference_id: 'PA-REF-1',
    payer_decision_reason: 'Prior authorization not on file',
    medical_necessity: 'Severe OA, failed conservative care',
    clinical_evidence: { diagnoses: ['M16.11'], procedures: ['0SR90JZ'] },
    citations: [{ source: 'note', ref: 'n1' }],
  };

  it('maps a denied prior-auth row into the claim-shaped appeal subject', () => {
    const s = mapPriorAuthToAppealSubject(pa);
    expect(s.source_type).toBe('prior_auth');
    expect(s.prior_auth_id).toBe(42);
    expect(s.claim_id).toBeNull();
    expect(s.insurance_provider).toBe('Acme Health');
    expect(s.policy_number).toBe('POL-9');
    expect(s.rejection_reason).toBe('Prior authorization not on file');
    expect(s.claim_number).toBe('PA-REF-1');
    expect(s.patient_uid).toBe('p1');
  });

  it('falls back to PA-{id} when payer_reference_id is absent', () => {
    const s = mapPriorAuthToAppealSubject({ ...pa, payer_reference_id: null });
    expect(s.claim_number).toBe('PA-42');
  });

  it('passes through patient_name, submitted_at, and id for citation building', () => {
    const s = mapPriorAuthToAppealSubject({ ...pa, patient_name: 'Jane Doe', submitted_at: '2026-01-01' });
    expect(s.id).toBe(42);
    expect(s.patient_name).toBe('Jane Doe');
    expect(s.submitted_at).toBe('2026-01-01');
  });
});

describe('appeal letter helpers', () => {
  describe('classifyDenialReason', () => {
    it('classifies medical-necessity denials', () => {
      const result = classifyDenialReason({ denialReason: 'Claim denied — services not medically necessary' });
      expect(result.classification).toBe('medical_necessity');
      expect(result.severity).toBe('high');
    });

    it('classifies prior-auth-missing denials from code or reason', () => {
      const result = classifyDenialReason({
        denialReason: 'Prior authorization required but not obtained',
        denialCode: 'AUTH-01',
      });
      expect(result.classification).toBe('prior_auth_missing');
    });

    it('classifies coding errors', () => {
      const result = classifyDenialReason({ denialReason: 'Invalid CPT code on claim — coding error' });
      expect(result.classification).toBe('coding_error');
    });

    it('classifies duplicate claims', () => {
      const result = classifyDenialReason({ denialReason: 'Duplicate claim already processed' });
      expect(result.classification).toBe('duplicate_claim');
    });

    it('defaults to other when nothing matches', () => {
      const result = classifyDenialReason({ denialReason: 'Some unrelated error message' });
      expect(result.classification).toBe('other');
    });
  });

  describe('extractClinicalEvidence', () => {
    it('pulls active diagnoses, signed notes, procedures, investigations, and medications with citations', () => {
      const context = {
        diagnoses: [diagnosis(), diagnosis({ id: 2, icd10_code: 'J96.90', description: 'Respiratory failure' })],
        notes: [note(), note({ id: 2, payload: { is_signed: false }, summary: 'Nursing note (unsigned)' })],
        orders: [procedureOrder()],
        investigations: [{
          event_type: 'investigation',
          id: 50,
          summary: 'Chest X-ray',
          sub_type: 'completed',
          timestamp: '2026-04-20T15:00:00.000Z',
          payload: { status: 'completed', result_summary: 'Bilateral infiltrates' },
        }],
        medications: [{
          event_type: 'medication',
          id: 60,
          summary: 'Ceftriaxone 2 g IV',
          timestamp: '2026-04-20T11:00:00.000Z',
          payload: { medication_name: 'Ceftriaxone', dose: '2 g', route: 'IV' },
        }],
      };

      const evidence = extractClinicalEvidence(context);
      expect(evidence.diagnoses).toHaveLength(2);
      expect(evidence.diagnosis_codes).toEqual(['J18.9', 'J96.90']);
      expect(evidence.procedures[0].code).toBe('31622');
      expect(evidence.procedure_codes).toContain('31622');
      expect(evidence.signed_notes).toHaveLength(1);
      expect(evidence.investigations).toHaveLength(1);
      expect(evidence.medications).toHaveLength(1);
      expect(evidence.citations.length).toBeGreaterThan(0);
    });

    it('returns empty bundles for empty context without crashing', () => {
      const evidence = extractClinicalEvidence({});
      expect(evidence.diagnoses).toHaveLength(0);
      expect(evidence.signed_notes).toHaveLength(0);
      expect(evidence.procedures).toHaveLength(0);
      expect(evidence.citations).toHaveLength(0);
    });
  });

  describe('buildAppealLetterSections', () => {
    const claim = {
      id: 123,
      claim_number: 'CLM-2026-123',
      insurance_provider: 'Acme Health',
      policy_number: 'POL-999',
    };
    const evidence = extractClinicalEvidence({
      diagnoses: [diagnosis()],
      notes: [note()],
      orders: [procedureOrder()],
    });

    it('produces cover letter, narrative, and requested action tailored to classification', () => {
      const classification = classifyDenialReason({ denialReason: 'Not medically necessary' });
      const sections = buildAppealLetterSections({ claim, classification, evidence, appealType: 'first_level' });
      expect(sections.cover_letter).toContain('Acme Health');
      expect(sections.cover_letter).toContain('CLM-2026-123');
      expect(sections.medical_necessity).toContain('Pneumonia');
      expect(sections.requested_action.toLowerCase()).toContain('medical necessity');
      expect(sections.appeal_type).toBe('first_level');
      expect(sections.classification).toBe('medical_necessity');
      expect(sections.procedure_codes).toContain('31622');
      expect(sections.diagnosis_codes).toContain('J18.9');
      expect(sections.supporting_documentation.length).toBeGreaterThan(0);
    });

    it('normalizes an unknown appeal_type to first_level', () => {
      const classification = classifyDenialReason({ denialReason: 'Coding error' });
      const sections = buildAppealLetterSections({
        claim,
        classification,
        evidence,
        appealType: 'made_up_type',
      });
      expect(sections.appeal_type).toBe('first_level');
      expect(sections.requested_action.toLowerCase()).toContain('corrected');
    });

    it('tailors narrative for timely-filing appeals', () => {
      const classification = classifyDenialReason({ denialReason: 'Past timely filing deadline' });
      const sections = buildAppealLetterSections({ claim, classification, evidence, appealType: 'second_level' });
      expect(sections.classification).toBe('timely_filing');
      expect(sections.medical_necessity.toLowerCase()).toContain('timely');
      expect(sections.requested_action.toLowerCase()).toContain('timely');
    });
  });
});
