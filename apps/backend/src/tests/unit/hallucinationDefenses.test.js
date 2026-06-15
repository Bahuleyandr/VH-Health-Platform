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

    // FIX 2 (security review of f8cd10a7): a curated-KB citation label must
    // NOT widen the PHI allowlist. A PHI-shaped token (phone/MRN) that only
    // appears in an APPROVED KB title must still trip PHI_LEAK_SUSPECTED when
    // it shows up in the draft — KB titles are not chart-anchored PHI.
    it('does NOT let a phone-shaped token in a KB citation label suppress a PHI_LEAK flag', () => {
      const phone = '9876543210';
      const draft = { note: `Call the patient on ${phone} to confirm.` };
      // Same phone appears ONLY in a knowledge_chunk citation label.
      const citations = [{
        source_type: 'knowledge_chunk',
        source_id: '501',
        label: `Discharge protocol ${phone}`,
      }];
      const flags = detectPhiLeaks({ draft, citations, context: {} });
      expect(flags.some((flag) => flag.code === 'PHI_LEAK_SUSPECTED' && flag.metadata?.kind === 'phone')).toBe(true);
    });

    it('does NOT let an MRN-shaped token in a KB citation label suppress a PHI_LEAK flag', () => {
      const draft = { note: 'Reference MRN AB12345 in the chart.' };
      const citations = [{
        source_type: 'knowledge_chunk',
        source_id: '777',
        label: 'Formulary doc MRN AB12345',
      }];
      const flags = detectPhiLeaks({ draft, citations, context: {} });
      expect(flags.some((flag) => flag.code === 'PHI_LEAK_SUSPECTED' && flag.metadata?.kind === 'mrn')).toBe(true);
    });

    it('STILL allows a non-KB (chart) citation label to anchor an identifier', () => {
      // Control: the same token in a real chart citation IS a legitimate
      // anchor and must NOT be flagged — proving the filter is KB-specific.
      const phone = '9876543210';
      const draft = { note: `Call the patient on ${phone} to confirm.` };
      const citations = [{
        source_type: 'clinical_note',
        source_id: '12',
        label: `Contact note ${phone}`,
      }];
      const flags = detectPhiLeaks({ draft, citations, context: {} });
      expect(flags.some((flag) => flag.code === 'PHI_LEAK_SUSPECTED' && flag.metadata?.kind === 'phone')).toBe(false);
    });

    it('keeps KB citations in the list for traceability (no crash, only allowlist excluded)', () => {
      // A KB citation whose label has NO PHI-shaped token must not produce
      // any PHI flag, and a clean draft must stay clean — the filter only
      // removes KB labels from the allowlist, it does not drop citations.
      const draft = { note: 'Stable, continue current plan.' };
      const citations = [{
        source_type: 'knowledge_chunk',
        source_id: '9',
        label: 'Beta-lactam formulary (sim 0.82)',
      }];
      const flags = detectPhiLeaks({ draft, citations, context: {} });
      expect(flags.some((flag) => flag.code === 'PHI_LEAK_SUSPECTED')).toBe(false);
      // citationsBody is non-empty, so CITATIONS_EMPTY must NOT fire.
      expect(flags.some((flag) => flag.code === 'CITATIONS_EMPTY')).toBe(false);
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

    // AI-4a: unit normalization — equivalent quantities in different units
    // must NOT read as a hallucinated number.
    it('does not flag "120 mg" in the draft when the chart says "0.12 g" (mass equivalence)', () => {
      const draft = { plan: 'Give 120 mg of the drug.' };
      const context = { orders: [{ summary: 'dose 0.12 g' }] };
      const flags = extractNumericMismatches({ draft, context });
      expect(flags.length).toBe(0);
    });

    it('does not flag "0.12 g" in the draft when the chart says "120 mg" (reverse equivalence)', () => {
      const draft = { plan: 'Give 0.12 g of the drug.' };
      const context = { orders: [{ summary: 'dose 120 mg' }] };
      const flags = extractNumericMismatches({ draft, context });
      expect(flags.length).toBe(0);
    });

    it('does not flag mcg/mg equivalence (250 mcg vs 0.25 mg)', () => {
      const draft = { plan: 'levothyroxine 250 mcg daily' };
      const context = { medications: [{ summary: 'levothyroxine 0.25 mg daily' }] };
      const flags = extractNumericMismatches({ draft, context });
      expect(flags.length).toBe(0);
    });

    it('does not flag volume equivalence (1 L vs 1000 ml)', () => {
      const draft = { plan: 'Infuse 1 L normal saline.' };
      const context = { orders: [{ summary: 'normal saline 1000 ml' }] };
      const flags = extractNumericMismatches({ draft, context });
      expect(flags.length).toBe(0);
    });

    it('STILL flags a genuine dose drift after normalization (60 mg chart -> 120 mg draft)', () => {
      const draft = { plan: 'Increase to 120 mg.' };
      const context = { orders: [{ summary: 'current dose 60 mg' }] };
      const flags = extractNumericMismatches({ draft, context });
      expect(flags[0]?.code).toBe('UNVERIFIED_NUMERIC');
      // The flagged value should be the unmatched draft quantity.
      expect(flags[0].metadata.sample.join(' ')).toMatch(/120\s*mg/);
    });

    it('does not cross dimensions (120 mg drug must not match 120 ml volume)', () => {
      const draft = { plan: 'Give 120 mg of the drug.' };
      const context = { orders: [{ summary: 'volume 120 ml' }] };
      const flags = extractNumericMismatches({ draft, context });
      expect(flags[0]?.code).toBe('UNVERIFIED_NUMERIC');
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

    // AI-4b: real JSON-schema validation via AJV — catches what the old
    // shallow top-level-keys check missed.
    it('flags a wrong-typed field (string where the schema requires an array)', () => {
      const module = {
        settings: {
          outputSchema: {
            type: 'object',
            required: ['key_points'],
            properties: { key_points: { type: 'array' } },
          },
        },
      };
      const draft = { key_points: 'should be an array' };
      const flags = validateOutputSchema({ draft, module });
      expect(flags[0]?.code).toBe('SCHEMA_VIOLATION');
      expect(flags[0].metadata.error_count).toBeGreaterThan(0);
    });

    it('flags a missing NESTED required field (shallow check could not)', () => {
      const module = {
        settings: {
          outputSchema: {
            type: 'object',
            required: ['vitals'],
            properties: {
              vitals: {
                type: 'object',
                required: ['heart_rate', 'spo2'],
                properties: { heart_rate: { type: 'number' }, spo2: { type: 'number' } },
              },
            },
          },
        },
      };
      // Top-level key present, but nested required field missing — old shallow
      // check would have passed this.
      const draft = { vitals: { heart_rate: 80 } };
      const flags = validateOutputSchema({ draft, module });
      expect(flags[0]?.code).toBe('SCHEMA_VIOLATION');
      expect(flags[0].message).toMatch(/spo2/);
    });

    it('passes a fully valid nested object', () => {
      const module = {
        settings: {
          outputSchema: {
            type: 'object',
            required: ['vitals'],
            properties: {
              vitals: {
                type: 'object',
                required: ['heart_rate', 'spo2'],
                properties: { heart_rate: { type: 'number' }, spo2: { type: 'number' } },
              },
            },
          },
        },
      };
      const draft = { vitals: { heart_rate: 80, spo2: 97 }, extra_field: 'allowed' };
      expect(validateOutputSchema({ draft, module }).length).toBe(0);
    });

    it('still reports missing required top-level keys via metadata.missing', () => {
      const module = {
        settings: { outputSchema: { type: 'object', required: ['summary', 'diagnosis'] } },
      };
      const draft = { summary: 'ok' };
      const flags = validateOutputSchema({ draft, module });
      expect(flags[0]?.code).toBe('SCHEMA_VIOLATION');
      expect(flags[0].metadata.missing).toContain('diagnosis');
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
