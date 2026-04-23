import {
  escalateAdvisoryCategory,
  evaluatePgxAdvisory,
  lookupPgxReference,
  PGX_REFERENCE,
} from '../../services/ai/pharmacogenomicsService.js';

describe('pharmacogenomics helpers', () => {
  describe('lookupPgxReference', () => {
    it('finds the Codeine / CYP2D6 entry', () => {
      const entries = lookupPgxReference('Codeine 30mg');
      expect(entries.length).toBeGreaterThanOrEqual(1);
      const codeine = entries.find((e) => e.display === 'Codeine');
      expect(codeine).toBeTruthy();
      expect(codeine.gene).toBe('CYP2D6');
    });

    it('returns two entries for warfarin (CYP2C9 + VKORC1)', () => {
      const entries = lookupPgxReference('warfarin 5mg');
      const genes = entries.map((e) => e.gene).sort();
      expect(genes).toEqual(expect.arrayContaining(['CYP2C9', 'VKORC1']));
    });

    it('is case-insensitive', () => {
      expect(lookupPgxReference('CLOPIDOGREL').length).toBeGreaterThanOrEqual(1);
      expect(lookupPgxReference('clopidogrel 75mg daily').length).toBeGreaterThanOrEqual(1);
    });

    it('returns empty array for unknown medication', () => {
      expect(lookupPgxReference('Unobtanium 500mg')).toEqual([]);
    });

    it('returns empty array for empty input', () => {
      expect(lookupPgxReference('')).toEqual([]);
      expect(lookupPgxReference(null)).toEqual([]);
    });

    it('PGX_REFERENCE is a non-empty array of entries with required keys', () => {
      expect(Array.isArray(PGX_REFERENCE)).toBe(true);
      expect(PGX_REFERENCE.length).toBeGreaterThan(0);
      for (const entry of PGX_REFERENCE) {
        expect(entry.medication_pattern).toBeInstanceOf(RegExp);
        expect(typeof entry.display).toBe('string');
        expect(typeof entry.gene).toBe('string');
        expect(typeof entry.phenotype_advisories).toBe('object');
      }
    });
  });

  describe('escalateAdvisoryCategory', () => {
    it('escalates standard_dose + contraindicated to contraindicated', () => {
      expect(escalateAdvisoryCategory(['standard_dose', 'contraindicated'])).toBe('contraindicated');
    });

    it('escalates testing_recommended + no_action to testing_recommended', () => {
      expect(escalateAdvisoryCategory(['testing_recommended', 'no_action'])).toBe('testing_recommended');
    });

    it('returns unknown for an empty list', () => {
      expect(escalateAdvisoryCategory([])).toBe('unknown');
    });

    it('treats unknown categories as the lowest priority', () => {
      expect(escalateAdvisoryCategory(['fake_category', 'consider_dose_change'])).toBe('consider_dose_change');
    });

    it('prefers use_alternative over consider_dose_change', () => {
      expect(escalateAdvisoryCategory(['consider_dose_change', 'use_alternative'])).toBe('use_alternative');
    });
  });

  describe('evaluatePgxAdvisory', () => {
    it('returns contraindicated/critical for codeine + CYP2D6 ultra_rapid_metabolizer', () => {
      const result = evaluatePgxAdvisory({
        medicationName: 'Codeine 30mg',
        genotypes: [{ gene: 'CYP2D6', phenotype: 'ultra_rapid_metabolizer', verified: true }],
      });
      expect(result.advisory_category).toBe('contraindicated');
      expect(result.severity).toBe('critical');
      expect(result.matched_genes.length).toBeGreaterThanOrEqual(1);
      const match = result.matched_genes.find((m) => m.gene === 'CYP2D6');
      expect(match).toBeTruthy();
      expect(match.phenotype).toBe('ultra_rapid_metabolizer');
    });

    it('returns consider_dose_change for warfarin + CYP2C9 poor_metabolizer', () => {
      const result = evaluatePgxAdvisory({
        medicationName: 'Warfarin',
        genotypes: [{ gene: 'CYP2C9', phenotype: 'poor_metabolizer', verified: true }],
      });
      expect(result.advisory_category).toBe('consider_dose_change');
      expect(['moderate', 'high']).toContain(result.severity);
      const match = result.matched_genes.find((m) => m.gene === 'CYP2C9');
      expect(match).toBeTruthy();
    });

    it('returns testing_recommended when simvastatin has no SLCO1B1 genotype on file', () => {
      const result = evaluatePgxAdvisory({
        medicationName: 'Simvastatin 40mg',
        genotypes: [],
      });
      expect(result.advisory_category).toBe('testing_recommended');
      expect(result.severity).toBe('low');
      expect(result.matched_genes).toEqual([]);
      expect(result.summary).toMatch(/simvastatin/i);
    });

    it('returns no_action for paracetamol (no PGx consideration)', () => {
      const result = evaluatePgxAdvisory({
        medicationName: 'Paracetamol 500mg',
        genotypes: [
          { gene: 'CYP2D6', phenotype: 'ultra_rapid_metabolizer', verified: true },
          { gene: 'CYP2C19', phenotype: 'poor_metabolizer', verified: true },
        ],
      });
      expect(result.advisory_category).toBe('no_action');
      expect(result.matched_genes).toEqual([]);
    });

    it('returns contraindicated/critical for abacavir + HLA-B*57:01 positive', () => {
      const result = evaluatePgxAdvisory({
        medicationName: 'Abacavir',
        genotypes: [{ gene: 'HLA-B*57:01', phenotype: 'positive', verified: true }],
      });
      expect(result.advisory_category).toBe('contraindicated');
      expect(result.severity).toBe('critical');
      expect(result.matched_genes.some((m) => m.gene === 'HLA_B_5701')).toBe(true);
    });

    it('returns contraindicated/critical for carbamazepine + HLA-B*15:02 positive', () => {
      const result = evaluatePgxAdvisory({
        medicationName: 'Carbamazepine 200mg',
        genotypes: [{ gene: 'HLA_B_1502', phenotype: 'positive', verified: true }],
      });
      expect(result.advisory_category).toBe('contraindicated');
      expect(result.severity).toBe('critical');
    });

    it('returns contraindicated/critical for azathioprine + TPMT deficient', () => {
      const result = evaluatePgxAdvisory({
        medicationName: 'Azathioprine 50mg',
        genotypes: [{ gene: 'TPMT', phenotype: 'deficient', verified: true }],
      });
      expect(result.advisory_category).toBe('contraindicated');
      expect(result.severity).toBe('critical');
    });

    it('returns use_alternative for clopidogrel + CYP2C19 poor_metabolizer', () => {
      const result = evaluatePgxAdvisory({
        medicationName: 'Clopidogrel 75mg',
        genotypes: [{ gene: 'CYP2C19', phenotype: 'poor_metabolizer', verified: true }],
      });
      expect(result.advisory_category).toBe('use_alternative');
      expect(['high', 'critical']).toContain(result.severity);
    });

    it('combines matches across genes — picks the highest-priority category', () => {
      // Warfarin matches CYP2C9 and VKORC1; both map to consider_dose_change.
      // Add a non-relevant gene alongside.
      const result = evaluatePgxAdvisory({
        medicationName: 'warfarin',
        genotypes: [
          { gene: 'CYP2C9', phenotype: 'poor_metabolizer', verified: true },
          { gene: 'VKORC1', phenotype: 'intermediate_metabolizer', verified: true },
          { gene: 'TPMT', phenotype: 'normal_metabolizer', verified: true },
        ],
      });
      expect(result.advisory_category).toBe('consider_dose_change');
      expect(result.matched_genes.length).toBeGreaterThanOrEqual(2);
      const genes = result.matched_genes.map((m) => m.gene);
      expect(genes).toEqual(expect.arrayContaining(['CYP2C9', 'VKORC1']));
    });

    it('always includes the review disclaimer in recommended_actions', () => {
      const disclaimerRegex = /pharmacist\/clinician review required|decision support only/i;

      const contraindicated = evaluatePgxAdvisory({
        medicationName: 'Codeine',
        genotypes: [{ gene: 'CYP2D6', phenotype: 'ultra_rapid_metabolizer', verified: true }],
      });
      expect(contraindicated.recommended_actions.some((a) => disclaimerRegex.test(a))).toBe(true);

      const noAction = evaluatePgxAdvisory({
        medicationName: 'Paracetamol',
        genotypes: [],
      });
      expect(noAction.recommended_actions.some((a) => disclaimerRegex.test(a))).toBe(true);

      const testing = evaluatePgxAdvisory({
        medicationName: 'Simvastatin',
        genotypes: [],
      });
      expect(testing.recommended_actions.some((a) => disclaimerRegex.test(a))).toBe(true);
    });

    it('handles unknown medication name gracefully', () => {
      const result = evaluatePgxAdvisory({
        medicationName: 'Unobtanium',
        genotypes: [{ gene: 'CYP2D6', phenotype: 'poor_metabolizer', verified: true }],
      });
      expect(result.advisory_category).toBe('no_action');
      expect(result.severity).toBe('low');
      expect(result.matched_genes).toEqual([]);
    });

    it('handles empty medicationName gracefully', () => {
      const result = evaluatePgxAdvisory({ medicationName: '', genotypes: [] });
      expect(result.advisory_category).toBe('no_action');
      expect(result.matched_genes).toEqual([]);
    });

    it('ignores a genotype whose phenotype has no specific advisory (e.g. normal_metabolizer)', () => {
      const result = evaluatePgxAdvisory({
        medicationName: 'Codeine',
        genotypes: [{ gene: 'CYP2D6', phenotype: 'normal_metabolizer', verified: true }],
      });
      // normal_metabolizer has no entry under codeine's phenotype_advisories,
      // so the service escalates to the soft "standard_dose" match.
      expect(['standard_dose', 'no_action']).toContain(result.advisory_category);
      expect(result.severity).toBe('low');
    });
  });
});
