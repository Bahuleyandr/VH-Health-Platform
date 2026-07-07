import { evaluateDeferralRules } from '../../services/bloodbank/donorIntakeService.js';

describe('blood-bank donor deferral rule engine', () => {
  test('marks a normal adult donor eligible', () => {
    const verdict = evaluateDeferralRules({
      ageYears: 32,
      questionnaire: {},
      vitals: {
        weight_kg: 72,
        hemoglobin_g_dl: 14.1,
        systolic_bp: 118,
        diastolic_bp: 74,
        temperature_c: 36.8,
      },
    });

    expect(verdict).toMatchObject({
      verdict: 'eligible',
      permanent: false,
      deferralUntil: null,
      primaryReasonCode: null,
    });
  });

  test('temporary deferral chooses the latest active until-date across rules', () => {
    const verdict = evaluateDeferralRules({
      ageYears: 28,
      questionnaire: {
        tattoo_recent: true,
        recent_fever: true,
      },
      vitals: {
        weight_kg: 43,
        hemoglobin_g_dl: 11.8,
        systolic_bp: 122,
        diastolic_bp: 80,
      },
    });

    expect(verdict.verdict).toBe('deferred_temporary');
    expect(verdict.permanent).toBe(false);
    expect(verdict.primaryReasonCode).toBe('LOW_WEIGHT');
    expect(verdict.reasons.map((rule) => rule.code)).toEqual(expect.arrayContaining([
      'LOW_WEIGHT',
      'LOW_HEMOGLOBIN',
      'CURRENT_ILLNESS',
      'RECENT_TATTOO_PIERCING',
    ]));
    expect(verdict.deferralUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('prior TTI history forces permanent deferral', () => {
    const verdict = evaluateDeferralRules({
      ageYears: 35,
      questionnaire: { previous_positive_tti: true },
      vitals: { weight_kg: 70, hemoglobin_g_dl: 13.5 },
    });

    expect(verdict).toMatchObject({
      verdict: 'deferred_permanent',
      permanent: true,
      deferralUntil: null,
      primaryReasonCode: 'PREVIOUS_POSITIVE_TTI',
    });
  });
});
