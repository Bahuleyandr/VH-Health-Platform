// Re-review 2026-08-10 H1 pins for src/utils/clinical/icuPlausibility.js —
// hard plausibility bounds on ICU flowsheet + assessment inputs and the
// recorded_at sanity window (mirrors the C-M4 vitalPlausibility pattern).

import {
  ICU_FLOWSHEET_BOUNDS,
  ICU_ASSESSMENT_BOUNDS,
  assertIcuFlowsheetPlausibility,
  assertIcuAssessmentPlausibility,
} from '../../utils/clinical/icuPlausibility.js';
import {
  VITAL_PLAUSIBILITY_BOUNDS,
  RECORDED_AT_MAX_FUTURE_MS,
  RECORDED_AT_MAX_BACKDATE_MS,
} from '../../utils/clinical/vitalPlausibility.js';
import { AppError } from '../../utils/AppError.js';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

describe('ICU flowsheet bounds — edges', () => {
  const CASES = Object.entries(ICU_FLOWSHEET_BOUNDS).map(([field, b]) => [field, b.min, b.max]);

  it.each(CASES)('%s: accepts min (%d) and max (%d), rejects just outside', (field, min, max) => {
    expect(() => assertIcuFlowsheetPlausibility({ [field]: min })).not.toThrow();
    expect(() => assertIcuFlowsheetPlausibility({ [field]: max })).not.toThrow();
    expect(() => assertIcuFlowsheetPlausibility({ [field]: min - 1 })).toThrow(AppError);
    expect(() => assertIcuFlowsheetPlausibility({ [field]: max + 1 })).toThrow(AppError);
  });

  it('shares the C-M4 vitals bounds under the ICU column names', () => {
    expect(ICU_FLOWSHEET_BOUNDS.hr.min).toBe(VITAL_PLAUSIBILITY_BOUNDS.heart_rate.min);
    expect(ICU_FLOWSHEET_BOUNDS.hr.max).toBe(VITAL_PLAUSIBILITY_BOUNDS.heart_rate.max);
    expect(ICU_FLOWSHEET_BOUNDS.spo2.max).toBe(VITAL_PLAUSIBILITY_BOUNDS.spo2.max);
    expect(ICU_FLOWSHEET_BOUNDS.temp_c.min).toBe(VITAL_PLAUSIBILITY_BOUNDS.temperature.min);
  });

  it('accepts an arrest flowsheet row including MAP 0 and the expanded shared envelope', () => {
    expect(() => assertIcuFlowsheetPlausibility({
      hr: 0,
      sbp: 0,
      dbp: 0,
      map: 0,
      spo2: 0,
      rr: 120,
      temp_c: 12,
    })).not.toThrow();
  });

  it('the H1 reproduction (spo2 990) is a 400 naming the field and range', () => {
    try {
      assertIcuFlowsheetPlausibility({ spo2: 990 });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(400);
      expect(err.message).toMatch(/spo2 must be between 0 and 100/);
    }
  });

  it('absent fields are skipped (partial hourly entries)', () => {
    expect(() => assertIcuFlowsheetPlausibility({})).not.toThrow();
    expect(() => assertIcuFlowsheetPlausibility({ hr: null, spo2: undefined })).not.toThrow();
  });

  it('zero drip rate and zero urine output stay chartable', () => {
    expect(() => assertIcuFlowsheetPlausibility({
      noradrenaline_mcg_kg_min: 0,
      urine_output_ml: 0,
    })).not.toThrow();
  });

  it('non-numeric and non-integer values on integer columns are rejected', () => {
    expect(() => assertIcuFlowsheetPlausibility({ hr: 'fast' })).toThrow(/hr must be a number/);
    expect(() => assertIcuFlowsheetPlausibility({ spo2: '' })).toThrow(/spo2 must be a number/);
    expect(() => assertIcuFlowsheetPlausibility({ urine_output_ml: false })).toThrow(
      /urine_output_ml must be a number/,
    );
    expect(() => assertIcuFlowsheetPlausibility({ hr: 82.5 })).toThrow(/hr must be an integer/);
    expect(() => assertIcuFlowsheetPlausibility({ temp_c: 37.4 })).not.toThrow();
  });

  it('other_drips shape is bounded', () => {
    expect(() => assertIcuFlowsheetPlausibility({ other_drips: 'milrinone' })).toThrow(/other_drips/);
    expect(() => assertIcuFlowsheetPlausibility({ other_drips: [{ rate: 5 }] })).toThrow(/name/);
    expect(() => assertIcuFlowsheetPlausibility({
      other_drips: [{ name: 'milrinone', rate: -1 }],
    })).toThrow(/rate/);
    expect(() => assertIcuFlowsheetPlausibility({
      other_drips: [{ name: 'milrinone', rate: '' }],
    })).toThrow(/rate/);
    expect(() => assertIcuFlowsheetPlausibility({
      other_drips: [{ name: 'milrinone', rate: 0.375, unit: 'mcg/kg/min' }],
    })).not.toThrow();
  });

  it('recorded_at gets the staff sanity window (future + 72h backdate)', () => {
    const now = Date.now();
    expect(() => assertIcuFlowsheetPlausibility(
      { recorded_at: new Date(now - HOUR).toISOString() }, { now },
    )).not.toThrow();
    expect(() => assertIcuFlowsheetPlausibility(
      { recorded_at: new Date(now + RECORDED_AT_MAX_FUTURE_MS + MINUTE).toISOString() }, { now },
    )).toThrow(/future/);
    expect(() => assertIcuFlowsheetPlausibility(
      { recorded_at: new Date(now - RECORDED_AT_MAX_BACKDATE_MS - MINUTE).toISOString() }, { now },
    )).toThrow(/backdated/);
    expect(() => assertIcuFlowsheetPlausibility(
      { recorded_at: 'not-a-date' }, { now },
    )).toThrow(/valid ISO timestamp/);
  });
});

describe('ICU assessment bounds — edges', () => {
  const CASES = Object.entries(ICU_ASSESSMENT_BOUNDS).map(([field, b]) => [field, b.min, b.max]);

  it.each(CASES)('%s: accepts min (%d) and max (%d), rejects just outside', (field, min, max) => {
    expect(() => assertIcuAssessmentPlausibility({ [field]: min })).not.toThrow();
    expect(() => assertIcuAssessmentPlausibility({ [field]: max })).not.toThrow();
    expect(() => assertIcuAssessmentPlausibility({ [field]: min - 1 })).toThrow(AppError);
    expect(() => assertIcuAssessmentPlausibility({ [field]: max + 1 })).toThrow(AppError);
  });

  it('SOFA sub-scores are 0-4 and CPOT domains 0-2 (integers only)', () => {
    expect(() => assertIcuAssessmentPlausibility({ sofa_resp: 5 })).toThrow(/sofa_resp/);
    expect(() => assertIcuAssessmentPlausibility({ sofa_renal: 2.5 })).toThrow(/integer/);
    expect(() => assertIcuAssessmentPlausibility({ cpot_facial: 3 })).toThrow(/cpot_facial/);
    expect(() => assertIcuAssessmentPlausibility({ rass_score: -6 })).toThrow(/rass_score/);
    expect(() => assertIcuAssessmentPlausibility({ rass_score: -5, sofa_cns: 4, cpot_movement: 2 }))
      .not.toThrow();
  });
});
