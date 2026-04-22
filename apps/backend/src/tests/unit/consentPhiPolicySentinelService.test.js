import { evaluateConsentPhiPolicy } from '../../services/ai/consentPhiPolicySentinelService.js';

const PATIENT_UID = '11111111-1111-4111-8111-111111111111';

function generation(overrides = {}) {
  return {
    id: 10,
    patient_uid: PATIENT_UID,
    task_type: 'patient_aftercare_instructions',
    module_key: 'patient_aftercare_instructions',
    provider: 'template',
    status: 'draft',
    review_decision: 'accepted',
    citations: [{ source_type: 'note', source_id: '1', label: 'Signed note' }],
    safety_flags: [],
    draft: { summary: 'Stable discharge instructions.' },
    created_at: '2026-04-22T08:00:00.000Z',
    ...overrides,
  };
}

function module(overrides = {}) {
  return {
    module_key: 'patient_aftercare_instructions',
    external_allowed: false,
    settings: {
      surface: 'clinical',
      risk: 'high',
      requiresCitations: true,
      requiresClinicianSignoff: true,
    },
    ...overrides,
  };
}

function consent(type, overrides = {}) {
  return {
    consent_type: type,
    granted: true,
    status: 'active',
    granted_at: '2026-04-21T08:00:00.000Z',
    revoked_at: null,
    expires_at: null,
    ...overrides,
  };
}

describe('consent phi policy sentinel helpers', () => {
  it('scores local cited accepted output with active treatment consent as low risk', () => {
    const audit = evaluateConsentPhiPolicy({
      generation: generation(),
      module: module(),
      consents: [consent('treatment')],
      now: new Date('2026-04-22T10:00:00.000Z'),
    });

    expect(audit.risk_band).toBe('low');
    expect(audit.risk_score).toBe(0);
    expect(audit.findings).toEqual([]);
  });

  it('flags external AI without AI consent and local-only module boundary', () => {
    const audit = evaluateConsentPhiPolicy({
      generation: generation({
        provider: 'openai',
        draft: { patient_email: 'asha@example.com', mobile: '+919876543210' },
      }),
      module: module({ external_allowed: false }),
      consents: [consent('treatment')],
      now: new Date('2026-04-22T10:00:00.000Z'),
    });

    expect(audit.risk_band).toBe('critical');
    expect(audit.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'EXTERNAL_PROVIDER_NOT_ALLOWED',
        'EXTERNAL_AI_WITHOUT_AI_CONSENT',
        'RAW_IDENTIFIER_IN_EXTERNAL_DRAFT',
      ])
    );
  });

  it('flags missing consent, citations, critical safety, and stale review', () => {
    const audit = evaluateConsentPhiPolicy({
      generation: generation({
        review_decision: 'pending',
        citations: [],
        safety_flags: [{ severity: 'critical', code: 'NO_CITATIONS', message: 'No evidence.' }],
        created_at: '2026-04-10T08:00:00.000Z',
      }),
      module: module(),
      consents: [],
      now: new Date('2026-04-22T10:00:00.000Z'),
    });

    expect(audit.risk_band).toBe('critical');
    expect(audit.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        'NO_ACTIVE_TREATMENT_CONSENT',
        'CRITICAL_SAFETY_FLAG_PRESENT',
        'REQUIRED_CITATIONS_MISSING',
        'SIGNOFF_PENDING',
        'STALE_UNREVIEWED_DRAFT',
      ])
    );
  });
});
