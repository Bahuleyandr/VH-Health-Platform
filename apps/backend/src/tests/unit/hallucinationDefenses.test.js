import {
  detectPhiLeaks,
  extractNumericMismatches,
  validateOutputSchema,
  temperatureForRisk,
  runOutputDefenses,
} from '../../services/ai/hallucinationDefenses.js';

describe('hallucinationDefenses', () => {
  describe('detectPhiLeaks', () => {
    it('flags a UID in the draft that is not in the chart context', () => {
      const draft = { note: 'Patient c9999999-9999-4999-8999-999999999999 was stable.' };
      const flags = detectPhiLeaks({ draft, citations: [], context: {} });
      expect(flags.some((flag) => flag.code === 'PHI_LEAK_SUSPECTED' && flag.severity === 'critical')).toBe(true);
    });

    it('does not flag a UID that IS present in the citations', () => {
      const uid = 'c9999999-9999-4999-8999-999999999999';
      const draft = { note: `Patient ${uid} was stable.` };
      const citations = [{ label: `Record for ${uid}`, source_type: 'clinical_note' }];
      const flags = detectPhiLeaks({ draft, citations, context: {} });
      expect(flags.some((flag) => flag.code === 'PHI_LEAK_SUSPECTED' && flag.metadata?.kind === 'uid')).toBe(false);
    });

    it('flags an email that is not in the context', () => {
      const draft = { contact: 'followup@evil.com' };
      const flags = detectPhiLeaks({ draft, citations: [], context: {} });
      expect(flags.some((flag) => flag.code === 'PHI_LEAK_SUSPECTED' && flag.metadata?.kind === 'email')).toBe(true);
    });

    it('surfaces CITATIONS_EMPTY when the draft has body but no citations', () => {
      const flags = detectPhiLeaks({
        draft: { summary: 'Some content' },
        citations: [],
        context: {},
      });
      expect(flags.some((flag) => flag.code === 'CITATIONS_EMPTY')).toBe(true);
    });
  });

  describe('extractNumericMismatches', () => {
    it('flags a dosage in the draft that does not appear in the chart context', () => {
      const draft = { plan: 'Give amoxicillin 500 mg twice daily.' };
      const context = { medications: [{ summary: 'Current: amoxicillin 250 mg twice daily' }] };
      const flags = extractNumericMismatches({ draft, context });
      expect(flags[0]?.code).toBe('UNVERIFIED_NUMERIC');
    });

    it('does not flag a dosage that IS in the chart context', () => {
      const draft = { plan: 'Continue amoxicillin 500 mg twice daily.' };
      const context = { medications: [{ summary: 'amoxicillin 500 mg twice daily' }] };
      const flags = extractNumericMismatches({ draft, context });
      expect(flags.length).toBe(0);
    });
  });

  describe('validateOutputSchema', () => {
    it('flags a draft missing required top-level fields', () => {
      const module = { settings: { outputSchema: { required: ['summary', 'diagnosis'] } } };
      const draft = { summary: 'ok' };
      const flags = validateOutputSchema({ draft, module });
      expect(flags[0]?.code).toBe('SCHEMA_VIOLATION');
      expect(flags[0]?.metadata.missing).toEqual(['diagnosis']);
    });

    it('no flags when schema is satisfied', () => {
      const module = { settings: { outputSchema: { required: ['summary'] } } };
      const draft = { summary: 'ok' };
      expect(validateOutputSchema({ draft, module }).length).toBe(0);
    });
  });

  describe('temperatureForRisk', () => {
    it('returns 0 for critical', () => {
      expect(temperatureForRisk('critical')).toBe(0.0);
    });
    it('returns 0.15 for high', () => {
      expect(temperatureForRisk('high')).toBe(0.15);
    });
    it('falls back to 0.15 for unknown tier', () => {
      expect(temperatureForRisk('nonsense')).toBe(0.15);
    });
  });

  describe('runOutputDefenses', () => {
    it('aggregates PHI + numeric + schema flags in one call', () => {
      const module = { settings: { outputSchema: { required: ['summary'] } } };
      const draft = {
        note: 'Patient c9999999-9999-4999-8999-999999999999 given 500 mg.',
      };
      const flags = runOutputDefenses({ draft, module, context: {}, citations: [] });
      expect(flags.some((flag) => flag.code === 'PHI_LEAK_SUSPECTED')).toBe(true);
      expect(flags.some((flag) => flag.code === 'UNVERIFIED_NUMERIC')).toBe(true);
      expect(flags.some((flag) => flag.code === 'SCHEMA_VIOLATION')).toBe(true);
    });
  });
});
