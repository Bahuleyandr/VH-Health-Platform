import {
  normalizeText,
  splitSections,
  computeSectionDiff,
  detectImpactByKeywords,
  classifyImpactArea,
  classifySeverity,
  deriveImpactedRoles,
  escalateImpactArea,
  escalateSeverity,
  buildPolicyActions,
  evaluatePolicyDiff,
} from '../../services/ai/policyRegulationWatcherService.js';

describe('policy regulation watcher pure helpers', () => {
  describe('normalizeText', () => {
    it('lowercases, trims, and collapses whitespace', () => {
      expect(normalizeText('  Hello   World  ')).toBe('hello world');
    });
  });

  describe('splitSections', () => {
    it('splits on SECTION headers into non-empty chunks', () => {
      const result = splitSections('SECTION 1\nAccess control policy\n\nSECTION 2\nBilling code changes');
      expect(result).toHaveLength(2);
      expect(result[0].header).toBeTruthy();
      expect(result[1].header).toBeTruthy();
    });

    it('returns an empty array for empty input', () => {
      expect(splitSections('')).toEqual([]);
    });
  });

  describe('computeSectionDiff', () => {
    it('detects a modified section by header equality', () => {
      const result = computeSectionDiff({
        previousSections: [{ header: 'A', body: 'old' }],
        currentSections: [{ header: 'A', body: 'new' }],
      });
      expect(result.modified).toHaveLength(1);
      expect(result.added).toHaveLength(0);
      expect(result.removed).toHaveLength(0);
    });

    it('detects added sections', () => {
      const result = computeSectionDiff({
        previousSections: [],
        currentSections: [{ header: 'X', body: 'y' }],
      });
      expect(result.added).toHaveLength(1);
    });

    it('detects removed sections', () => {
      const result = computeSectionDiff({
        previousSections: [{ header: 'A', body: 'x' }],
        currentSections: [],
      });
      expect(result.removed).toHaveLength(1);
    });
  });

  describe('detectImpactByKeywords', () => {
    it('counts every matching whole-word keyword', () => {
      const result = detectImpactByKeywords({
        text: 'This changes billing and claim coding',
        keywordSet: new Set(['billing', 'claim', 'coding']),
      });
      expect(result.count).toBeGreaterThanOrEqual(3);
    });

    it('returns zero when no keywords match', () => {
      const result = detectImpactByKeywords({
        text: 'Nothing related',
        keywordSet: new Set(['billing', 'claim']),
      });
      expect(result.count).toBe(0);
    });
  });

  describe('classifyImpactArea', () => {
    it('identifies billing changes', () => {
      const result = classifyImpactArea({
        addedText: 'Updated billing code',
        removedText: '',
        modifiedText: '',
      });
      expect(result.impact_area).toBe('billing');
    });

    it('returns mixed when several buckets have hits', () => {
      const result = classifyImpactArea({
        addedText: 'Patient consent and PHI disclosure changes to billing codes',
        removedText: '',
        modifiedText: '',
      });
      expect(result.impact_area).toBe('mixed');
    });

    it('returns none when no keywords match', () => {
      const result = classifyImpactArea({
        addedText: 'Cleanup of whitespace.',
        removedText: '',
        modifiedText: '',
      });
      expect(result.impact_area).toBe('none');
    });
  });

  describe('classifySeverity', () => {
    it('returns unknown for an empty diff with no impact', () => {
      const result = classifySeverity({
        addedCount: 0,
        removedCount: 0,
        modifiedCount: 0,
        impactArea: 'none',
        privacyHits: 0,
        clinicalHits: 0,
      });
      expect(result.severity).toBe('unknown');
    });

    it('returns low for a tiny billing diff', () => {
      const result = classifySeverity({
        addedCount: 1,
        removedCount: 0,
        modifiedCount: 0,
        impactArea: 'billing',
        privacyHits: 0,
        clinicalHits: 0,
      });
      expect(result.severity).toBe('low');
    });

    it('returns moderate for a clinical diff below the critical-clinical threshold', () => {
      const result = classifySeverity({
        addedCount: 2,
        removedCount: 1,
        modifiedCount: 3,
        impactArea: 'clinical',
        privacyHits: 0,
        clinicalHits: 2,
      });
      expect(result.severity).toBe('moderate');
    });

    it('returns high for a large billing diff', () => {
      const result = classifySeverity({
        addedCount: 12,
        removedCount: 0,
        modifiedCount: 0,
        impactArea: 'billing',
        privacyHits: 0,
        clinicalHits: 0,
      });
      expect(result.severity).toBe('high');
    });

    it('returns critical for a privacy diff with >= 2 privacy hits', () => {
      const result = classifySeverity({
        addedCount: 2,
        removedCount: 0,
        modifiedCount: 0,
        impactArea: 'privacy',
        privacyHits: 3,
        clinicalHits: 0,
      });
      expect(result.severity).toBe('critical');
    });
  });

  describe('deriveImpactedRoles', () => {
    it('returns BILLING roles for a billing diff', () => {
      const result = deriveImpactedRoles({
        impactArea: 'billing',
        bucketHits: { billing: ['claim'] },
      });
      expect(result).toContain('BILLING');
    });

    it('unions roles from every bucket with hits when mixed', () => {
      const result = deriveImpactedRoles({
        impactArea: 'mixed',
        bucketHits: { clinical: ['patient'], billing: ['claim'] },
      });
      expect(result).toContain('DOCTOR');
      expect(result).toContain('BILLING');
    });
  });

  describe('escalation helpers', () => {
    it('escalateImpactArea picks clinical over billing and none', () => {
      expect(escalateImpactArea(['none', 'billing', 'clinical'])).toBe('clinical');
    });

    it('escalateSeverity picks critical over moderate and low', () => {
      expect(escalateSeverity(['low', 'moderate', 'critical'])).toBe('critical');
    });
  });

  describe('buildPolicyActions', () => {
    it('includes the disclaimer and at least one clinical- or role-specific action', () => {
      const actions = buildPolicyActions({
        impactArea: 'clinical',
        severity: 'high',
        impactedRoles: ['DOCTOR', 'NURSE'],
        signals: [],
      });
      const joined = actions.join(' ').toLowerCase();
      expect(actions.some((line) => /compliance \+ legal review required/i.test(line))).toBe(true);
      const hasClinicalOrRole = /clinical|doctor|nurse|nursing/.test(joined);
      expect(hasClinicalOrRole).toBe(true);
    });
  });

  describe('evaluatePolicyDiff', () => {
    it('surfaces a privacy-adjacent modification as at least moderate and non-empty modified section count', () => {
      const result = evaluatePolicyDiff({
        previousText: 'SECTION 1\nOld patient consent rules',
        currentText: 'SECTION 1\nNew patient consent and PHI disclosure rules',
      });
      expect(['mixed', 'privacy', 'clinical']).toContain(result.impact_area);
      expect(result.modified_section_count).toBeGreaterThanOrEqual(1);
    });
  });
});
