// Unit tests for the pure-function pieces of the clinical AI decision
// memory service: context signature, draft summary, and edit-diff
// summary. The DB-touching paths (recordDecision, retrieveRelevantDecisions)
// degrade gracefully when the projection table is missing, so they're
// covered by the deep integration suite — not here.

import {
  buildEditDiffSummary,
  classifyDiagnosis,
  extractContextSignature,
  summariseDraft,
} from '../../services/ai/decisionMemoryService.js';

describe('classifyDiagnosis', () => {
  it('matches respiratory infection patterns', () => {
    expect(classifyDiagnosis('Community-acquired pneumonia')).toBe('respiratory_infection');
    expect(classifyDiagnosis('Acute bronchitis with secondary infection')).toBe('respiratory_infection');
  });

  it('separates COPD from generic respiratory', () => {
    expect(classifyDiagnosis('AECOPD on home oxygen')).toBe('copd_asthma');
  });

  it('matches obstetric class on multiple synonyms', () => {
    expect(classifyDiagnosis('Severe preeclampsia at 34 weeks')).toBe('obstetric');
    expect(classifyDiagnosis('Postpartum haemorrhage')).toBe('obstetric');
    expect(classifyDiagnosis('Antenatal admission for IUGR')).toBe('obstetric');
  });

  it('returns "unspecified" for empty input and "other" for unknown', () => {
    expect(classifyDiagnosis('')).toBe('unspecified');
    expect(classifyDiagnosis(null)).toBe('unspecified');
    expect(classifyDiagnosis('something completely random')).toBe('other');
  });
});

describe('extractContextSignature', () => {
  it('drops nulls so jsonb @> retrieval predicates stay tight', () => {
    const sig = extractContextSignature(
      { admission: { admitted_at: null, discharged_at: null, ward: '' }, patient: {} },
      'discharge_summary'
    );
    // module_key is the only thing we should be able to derive when the
    // chart is empty.
    expect(sig.module_key).toBe('discharge_summary');
    expect('age_band' in sig).toBe(false);
    expect('length_of_stay_band' in sig).toBe(false);
    expect('care_setting' in sig).toBe(false);
  });

  it('bands age, length of stay, polypharmacy, and care setting', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    // Pick a birthday >85y in the past relative to "now" so the very_old
    // band threshold (>=80) is comfortably crossed regardless of the
    // exact day the suite runs.
    const birthYear = new Date().getFullYear() - 85;
    const sig = extractContextSignature(
      {
        admission: {
          admitted_at: tenDaysAgo.toISOString(),
          ward: 'ICU East',
          chief_complaint: 'severe pneumonia',
        },
        patient: { birthday: `${birthYear}-04-12` },
        diagnoses: [{ payload: { description: 'Community-acquired pneumonia' } }],
        medications: Array.from({ length: 7 }, (_, i) => ({ summary: `med ${i}` })),
      },
      'discharge_summary'
    );
    expect(sig.age_band).toBe('very_old');
    expect(sig.length_of_stay_band).toBe('extended');
    expect(sig.polypharmacy_band).toBe('high');
    expect(sig.care_setting).toBe('icu');
    expect(sig.primary_dx_class).toBe('respiratory_infection');
  });
});

describe('summariseDraft', () => {
  it('returns empty string for null/non-object input', () => {
    expect(summariseDraft(null)).toBe('');
    expect(summariseDraft('a string')).toBe('');
  });

  it('summarises arrays as item counts and primitives as truncated values', () => {
    const summary = summariseDraft({
      discharge_diagnosis: 'Community-acquired pneumonia, resolved',
      recommended_actions: ['follow up', 'rescue inhaler'],
      irrelevant_field: 'should not appear',
      risk_band: 'high',
    });
    expect(summary).toContain('discharge_diagnosis=Community-acquired pneumonia');
    expect(summary).toContain('recommended_actions=[2 items]');
    expect(summary).toContain('risk_band=high');
    expect(summary).not.toContain('irrelevant_field');
  });

  it('caps total length so it can be embedded in a prompt safely', () => {
    const huge = 'x'.repeat(2000);
    const summary = summariseDraft({ discharge_diagnosis: huge });
    expect(summary.length).toBeLessThanOrEqual(240);
  });
});

describe('buildEditDiffSummary', () => {
  it('returns empty when either side is missing', () => {
    expect(buildEditDiffSummary(null, { a: 1 })).toBe('');
    expect(buildEditDiffSummary({ a: 1 }, null)).toBe('');
  });

  it('detects added, removed, and changed primitive fields', () => {
    const diff = buildEditDiffSummary(
      { a: 'before', b: 'same' },
      { b: 'same', c: 'new' }
    );
    expect(diff).toContain('removed a');
    expect(diff).toContain('added c');
    expect(diff).not.toContain('b');
  });

  it('reports array length deltas and object-shape changes', () => {
    const diff = buildEditDiffSummary(
      { meds: ['a', 'b', 'c'], plan: { steps: 1 } },
      { meds: ['a', 'b', 'c', 'd'], plan: { steps: 2, extra: true } }
    );
    expect(diff).toContain('meds +1 items');
    expect(diff).toContain('plan object changed');
  });

  it('truncates long primitive diffs so the summary stays prompt-safe', () => {
    const longBefore = 'a'.repeat(200);
    const longAfter = 'b'.repeat(200);
    const diff = buildEditDiffSummary({ note: longBefore }, { note: longAfter });
    expect(diff.length).toBeLessThanOrEqual(320);
    expect(diff).toMatch(/note: "a+"/);
  });

  it('returns empty when drafts are identical', () => {
    expect(buildEditDiffSummary({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe('');
  });
});
