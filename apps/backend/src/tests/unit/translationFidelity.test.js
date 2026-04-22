import { verifyTranslationFidelity } from '../../services/ai/translationService.js';

describe('verifyTranslationFidelity', () => {
  it('flags missing numeric tuples', () => {
    const result = verifyTranslationFidelity({
      source: { medicines: ['Amoxicillin 500 mg twice daily for 5 days'] },
      translated: { medicines: ['Amoxicillin do baar lein'] }, // lost dose + duration
    });
    expect(result.flags.some((flag) => flag.code === 'TRANSLATION_NUMERIC_MISSING')).toBe(true);
    expect(result.coverage_pct).toBeLessThan(100);
  });

  it('passes when every tuple round-trips', () => {
    const source = { plan: 'Paracetamol 500 mg every 6 hours for 3 days.' };
    const translated = {
      plan: 'Paracetamol 500 mg har 6 hours lein, 3 days tak.', // numeric + med preserved
    };
    const result = verifyTranslationFidelity({ source, translated });
    expect(result.flags.length).toBe(0);
    expect(result.coverage_pct).toBe(100);
  });

  it('flags missing drug names', () => {
    const source = { meds: ['Atorvastatin 10 mg'] };
    const translated = { meds: ['dawa 10 mg'] }; // lost drug name
    const result = verifyTranslationFidelity({ source, translated });
    expect(result.flags.some((flag) => flag.code === 'TRANSLATION_MEDICATION_MISSING')).toBe(true);
  });

  it('flags missing follow-up dates', () => {
    const source = { follow_up: ['Follow up on 12/05/2026'] };
    const translated = { follow_up: ['Follow-up karwayein'] }; // date dropped
    const result = verifyTranslationFidelity({ source, translated });
    expect(result.flags.some((flag) => flag.code === 'TRANSLATION_DATE_MISSING')).toBe(true);
  });

  it('reports 100% coverage for empty source', () => {
    const result = verifyTranslationFidelity({ source: {}, translated: {} });
    expect(result.coverage_pct).toBe(100);
    expect(result.source_tuple_count).toBe(0);
  });
});
