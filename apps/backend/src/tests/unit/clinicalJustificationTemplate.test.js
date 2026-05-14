// Unit tests for the TPA enhancement clinical-justification normaliser.
// Pure function — no DB, no mocks.
//
// Finding: 2026-05-09-tpa-insurance-claim-doctor-no-clinical-justification-template

import {
  ENHANCEMENT_JUSTIFICATION_TEMPLATE,
  normalizeClinicalJustification,
} from '../../services/insurance/clinicalJustificationTemplate.js';

describe('ENHANCEMENT_JUSTIFICATION_TEMPLATE', () => {
  it('exposes a versioned field list with exactly one required field', () => {
    expect(ENHANCEMENT_JUSTIFICATION_TEMPLATE.version).toBe(1);
    const required = ENHANCEMENT_JUSTIFICATION_TEMPLATE.fields.filter((f) => f.required);
    expect(required.map((f) => f.key)).toEqual(['clinical_reason']);
  });
});

describe('normalizeClinicalJustification — legacy / empty inputs', () => {
  it('treats null / undefined / empty string as "none"', () => {
    for (const v of [null, undefined, '']) {
      expect(normalizeClinicalJustification(v)).toEqual({
        format: 'none', structured: null, text: null,
      });
    }
  });

  it('treats a whitespace-only string as "none"', () => {
    expect(normalizeClinicalJustification('   \n  ')).toEqual({
      format: 'none', structured: null, text: null,
    });
  });

  it('keeps a non-empty string as trimmed free_text (back-compat)', () => {
    const out = normalizeClinicalJustification('  patient deteriorated, needs ICU  ');
    expect(out).toEqual({
      format: 'free_text',
      structured: null,
      text: 'patient deteriorated, needs ICU',
    });
  });
});

describe('normalizeClinicalJustification — structured input', () => {
  it('accepts a structured object with the required field and renders text', () => {
    const out = normalizeClinicalJustification({
      clinical_reason: 'Acute pancreatitis complicating the admission',
      additional_los_days: '2',
      supporting_investigations: 'Lipase 1200, CT abdomen',
    });
    expect(out.format).toBe('structured');
    expect(out.template_version).toBe(1);
    // number-typed field is coerced
    expect(out.structured.additional_los_days).toBe(2);
    expect(out.structured.clinical_reason).toMatch(/Acute pancreatitis/);
    // text rendering uses the platform-authored labels, ordered by template
    expect(out.text).toContain('Clinical reason for enhancement: Acute pancreatitis');
    expect(out.text).toContain('Expected additional length of stay (days): 2');
  });

  it('rejects a structured object missing the required clinical_reason', () => {
    expect(() =>
      normalizeClinicalJustification({ expected_outcome: 'recovery' }),
    ).toThrow(/clinical_reason is required/i);
  });

  it('rejects a negative additional_los_days', () => {
    expect(() =>
      normalizeClinicalJustification({
        clinical_reason: 'x', additional_los_days: -1,
      }),
    ).toThrow(/additional_los_days must be a non-negative number/i);
  });

  it('rejects an array input', () => {
    expect(() => normalizeClinicalJustification(['clinical_reason'])).toThrow(
      /must be a string or an object/i,
    );
  });

  it('rejects an object with only unrecognised keys (required field still missing)', () => {
    // The required clinical_reason check fires first — an all-garbage
    // object is missing it, so that is the error surfaced.
    expect(() =>
      normalizeClinicalJustification({ not_a_field: 'value', another: 1 }),
    ).toThrow(/clinical_reason is required/i);
  });

  it('drops unknown keys but keeps recognised ones', () => {
    const out = normalizeClinicalJustification({
      clinical_reason: 'sepsis',
      bogus_field: 'ignored',
    });
    expect(out.structured).toEqual({ clinical_reason: 'sepsis' });
  });
});
