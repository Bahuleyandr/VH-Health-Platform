import {
  evaluateConsentScope,
  scrubPhiForFamilyUpdate,
} from '../../services/ai/familyUpdateGeneratorService.js';

describe('family update helpers', () => {
  describe('evaluateConsentScope', () => {
    it('allows when an active family_update consent exists', () => {
      const result = evaluateConsentScope({
        consents: [
          { id: 1, consent_type: 'family_update', status: 'active' },
        ],
        caregiverRelationship: 'spouse',
      });
      expect(result.allowed).toBe(true);
      expect(result.caregiver_relationship).toBe('spouse');
      expect(result.consent.id).toBe(1);
      expect(result.scope.length).toBeGreaterThan(0);
    });

    it('allows when treatment consent is active (acceptable fallback)', () => {
      const result = evaluateConsentScope({
        consents: [
          { id: 2, consent_type: 'treatment', status: 'active' },
        ],
        caregiverRelationship: 'child',
      });
      expect(result.allowed).toBe(true);
      expect(result.consent_type).toBe('treatment');
    });

    it('denies when no eligible consent exists', () => {
      const result = evaluateConsentScope({
        consents: [
          { id: 3, consent_type: 'marketing', status: 'active' },
        ],
        caregiverRelationship: 'spouse',
      });
      expect(result.allowed).toBe(false);
      expect(result.consent).toBeNull();
      expect(result.reason.toLowerCase()).toContain('consent');
    });

    it('denies revoked or expired consent', () => {
      const revoked = evaluateConsentScope({
        consents: [
          { id: 4, consent_type: 'family_update', status: 'active', revoked: true },
        ],
        caregiverRelationship: 'spouse',
      });
      expect(revoked.allowed).toBe(false);

      const expired = evaluateConsentScope({
        consents: [
          { id: 5, consent_type: 'family_update', status: 'active', expires_at: new Date(Date.now() - 86400000).toISOString() },
        ],
        caregiverRelationship: 'spouse',
      });
      expect(expired.allowed).toBe(false);
    });

    it('normalizes unknown relationships to "other"', () => {
      const result = evaluateConsentScope({
        consents: [{ id: 1, consent_type: 'family_update', status: 'active' }],
        caregiverRelationship: 'mother_in_law',
      });
      expect(result.caregiver_relationship).toBe('other');
    });

    it('uses default scope when consent has no explicit scope', () => {
      const result = evaluateConsentScope({
        consents: [{ id: 1, consent_type: 'family_update', status: 'active' }],
        caregiverRelationship: 'parent',
      });
      expect(result.scope).toEqual(expect.arrayContaining(['current_status', 'next_steps', 'when_to_worry']));
    });

    it('uses explicit scope when provided', () => {
      const result = evaluateConsentScope({
        consents: [{
          id: 1,
          consent_type: 'family_update',
          status: 'active',
          scope: ['current_status', 'next_steps'],
        }],
        caregiverRelationship: 'spouse',
      });
      expect(result.scope).toEqual(['current_status', 'next_steps']);
    });
  });

  describe('scrubPhiForFamilyUpdate', () => {
    it('redacts specific medication doses', () => {
      const text = 'The patient is on ceftriaxone 2 g IV daily and metformin 500 mg oral.';
      const scrubbed = scrubPhiForFamilyUpdate(text);
      expect(scrubbed).toContain('[dose withheld]');
      expect(scrubbed).not.toMatch(/\b2\s*g\b/);
      expect(scrubbed).not.toMatch(/\b500\s*mg\b/);
    });

    it('redacts raw lab values', () => {
      const text = 'Latest hemoglobin 9.2 g/dl and creatinine 1.8 mg/dl noted.';
      const scrubbed = scrubPhiForFamilyUpdate(text);
      expect(scrubbed).toContain('[lab value withheld]');
    });

    it('redacts MRN and patient id patterns', () => {
      const text = 'Chart reference MRN: VH-12345 has been updated.';
      const scrubbed = scrubPhiForFamilyUpdate(text);
      expect(scrubbed).toContain('[identifier withheld]');
      expect(scrubbed).not.toContain('VH-12345');
    });

    it('returns non-string inputs unchanged', () => {
      expect(scrubPhiForFamilyUpdate(null)).toBe(null);
      expect(scrubPhiForFamilyUpdate(undefined)).toBe(undefined);
      expect(scrubPhiForFamilyUpdate(42)).toBe(42);
    });

    it('leaves non-PHI text intact', () => {
      const text = 'The patient is resting well and eating normally.';
      expect(scrubPhiForFamilyUpdate(text)).toBe(text);
    });
  });
});
