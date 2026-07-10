import { jest } from '@jest/globals';

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: jest.fn(),
}));

jest.unstable_mockModule('../../services/staff/credentialingService.js', () => ({
  hasActivePrivilege: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => {
    if (!tenantId) throw new Error('tenant id required');
    return tenantId;
  },
}));

jest.unstable_mockModule('../../services/transplant/transplantProgramFeatureService.js', () => ({
  isTransplantProgramEnabled: jest.fn(),
}));

const {
  TRANSPLANT_ORGANS,
  assertCommitteeDecisionState,
  assertNottoReleaseEvidence,
  assertTransplantPrivilege,
  assertWaitlistTransition,
  committeeStatusFromDecision,
  normalizeRequiredOrgans,
  normalizeTransplantOrgan,
  privilegeForTransplantAction,
} = await import('../../services/transplant/transplantProgramService.js');
const { hasActivePrivilege } = await import('../../services/staff/credentialingService.js');

describe('transplantProgramService pure helpers', () => {
  it('keeps the owner-approved organ enum exact', () => {
    expect(TRANSPLANT_ORGANS).toEqual([
      'heart',
      'liver',
      'lung',
      'kidney',
      'small_bowel',
      'multivisceral',
    ]);
    expect(normalizeTransplantOrgan('multivisceral')).toBe('multivisceral');
    expect(() => normalizeTransplantOrgan('pancreas')).toThrow(/organ must be one of/);
  });

  it('deduplicates candidate required organs and rejects empty lists', () => {
    expect(normalizeRequiredOrgans(['heart', 'heart', 'kidney'])).toEqual(['heart', 'kidney']);
    expect(() => normalizeRequiredOrgans([])).toThrow(/required_organs/);
  });

  it('allows only explicit waitlist transitions and keeps terminal states terminal', () => {
    expect(assertWaitlistTransition(null, 'listed')).toBe('listed');
    expect(assertWaitlistTransition('listed', 'hold')).toBe('hold');
    expect(assertWaitlistTransition('hold', 'listed')).toBe('listed');
    expect(() => assertWaitlistTransition('removed', 'listed')).toThrow(/Invalid state transition/);
    expect(() => assertWaitlistTransition('transplanted', 'hold')).toThrow(/Invalid state transition/);
  });

  it('maps committee decisions to candidate committee states', () => {
    expect(assertCommitteeDecisionState({ decision: 'approved', affectsCandidate: true, candidateId: 1 })).toBe('approved');
    expect(committeeStatusFromDecision('approved')).toBe('approved');
    expect(committeeStatusFromDecision('deferred')).toBe('deferred');
    expect(committeeStatusFromDecision('removed')).toBe('declined');
    expect(() => assertCommitteeDecisionState({ decision: 'deferred', affectsCandidate: false })).toThrow(/deferral/);
  });

  it('binds transplant actions to owner-confirmed privilege keys', () => {
    expect(privilegeForTransplantAction('candidate')).toBe('transplant_physician');
    expect(privilegeForTransplantAction('committee_review')).toBe('transplant_committee_member');
    expect(privilegeForTransplantAction('donor_referral')).toBe('transplant_coordinator');
    expect(privilegeForTransplantAction('match_review')).toBe('transplant_surgeon');
    expect(() => privilegeForTransplantAction('allocation_rule')).toThrow(/Unknown transplant action/);
  });

  it('accepts standard hyphenated UUID actors at the privilege gate', async () => {
    hasActivePrivilege.mockResolvedValueOnce({
      allowed: true,
      reason: null,
      privilege_key: 'transplant_physician',
    });

    await expect(assertTransplantPrivilege(
      '550e8400-e29b-41d4-a716-446655440000',
      'candidate',
      { tenantId: '00000000-0000-4000-8000-000000000001' },
    )).resolves.toMatchObject({ allowed: true });
    expect(hasActivePrivilege).toHaveBeenCalledWith(
      '550e8400-e29b-41d4-a716-446655440000',
      'transplant_physician',
      { tenantId: '00000000-0000-4000-8000-000000000001' },
    );
  });

  it('fails NOTTO release state closed until owner evidence is present', () => {
    expect(() => assertNottoReleaseEvidence({
      owner_reviewed_by: '550e8400-e29b-41d4-a716-446655440000',
      owner_reviewed_at: '2026-07-09T00:00:00.000Z',
      upload_reference_id: null,
      audit_evidence: { reviewed: true },
    })).toThrow(/NOTTO export cannot be released/);

    expect(assertNottoReleaseEvidence({
      owner_reviewed_by: '550e8400-e29b-41d4-a716-446655440000',
      owner_reviewed_at: '2026-07-09T00:00:00.000Z',
      upload_reference_id: 'NOTTO-REF-1',
      audit_evidence: { owner_evidence: 'operator-supplied' },
    })).toBe(true);
  });
});
