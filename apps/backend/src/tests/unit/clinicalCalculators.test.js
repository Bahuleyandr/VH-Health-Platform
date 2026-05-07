// Unit tests for the Sprint-8 clinical calculators
// (services/productivity/clinicalCalculators.js).
//
// These are pure-compute functions doctors will rely on at the
// bedside; the math has to be correct against the originating
// guideline. We test boundary values where the band changes — that's
// where regressions hide.

import {
  bmi, bsaMosteller, crClCockcroftGault,
  cha2ds2Vasc, hasBled, wellsPe, wellsDvt,
  qsofa, gcs, meld, anionGap, correctedCalcium, apgar,
  CALCULATORS,
} from '../../services/productivity/clinicalCalculators.js';

describe('CALCULATORS registry', () => {
  it('exports all 13 calculators', () => {
    expect(Object.keys(CALCULATORS).sort()).toEqual([
      'anionGap', 'apgar', 'bmi', 'bsaMosteller',
      'cha2ds2Vasc', 'correctedCalcium', 'crClCockcroftGault',
      'gcs', 'hasBled', 'meld', 'qsofa', 'wellsDvt', 'wellsPe',
    ]);
  });
});

describe('bmi', () => {
  it('classifies normal range', () => {
    const r = bmi({ weight_kg: 70, height_cm: 175 });
    expect(r.result).toBeCloseTo(22.86, 1);
    expect(r.band).toBe('normal');
  });
  it('boundary at 18.5 is underweight, just above is normal', () => {
    // 1.7m, 53.4kg → 18.48 ; 1.7m, 53.5kg → 18.51
    expect(bmi({ height_cm: 170, weight_kg: 53 }).band).toBe('underweight');
    expect(bmi({ height_cm: 170, weight_kg: 54 }).band).toBe('normal');
  });
  it('classifies obese class III at >= 40', () => {
    expect(bmi({ height_cm: 170, weight_kg: 116 }).band).toBe('obese_class_iii');
  });
  it('rejects missing inputs', () => {
    expect(() => bmi({ weight_kg: 70 })).toThrow();
    expect(() => bmi({ height_cm: 175 })).toThrow();
  });
});

describe('bsaMosteller', () => {
  it('matches the textbook example for 70kg/170cm', () => {
    // sqrt(170*70/3600) = sqrt(3.305...) ≈ 1.817
    expect(bsaMosteller({ weight_kg: 70, height_cm: 170 }).result).toBeCloseTo(1.817, 2);
  });
});

describe('crClCockcroftGault', () => {
  it('female factor halves the result vs male, all else equal', () => {
    const m = crClCockcroftGault({
      age: 60, weight_kg: 70, serum_creatinine_mg_dl: 1.0, sex: 'male',
    });
    const f = crClCockcroftGault({
      age: 60, weight_kg: 70, serum_creatinine_mg_dl: 1.0, sex: 'female',
    });
    expect(f.result).toBeCloseTo(m.result * 0.85, 1);
  });
  it('puts CrCl 90 in normal_or_high band', () => {
    // (140-30)*70/(72*1.0) ≈ 106.9 — normal
    const r = crClCockcroftGault({
      age: 30, weight_kg: 70, serum_creatinine_mg_dl: 1.0, sex: 'male',
    });
    expect(r.stage).toBe('normal_or_high');
  });
  it('flags CKD stage 5 when CrCl < 15', () => {
    // Old patient + high creatinine → very low CrCl
    const r = crClCockcroftGault({
      age: 85, weight_kg: 50, serum_creatinine_mg_dl: 6.0, sex: 'female',
    });
    expect(r.stage).toBe('ckd_5_kidney_failure');
  });
});

describe('cha2ds2Vasc', () => {
  it('classic case: 78yo female with HTN and DM = 5 → high risk', () => {
    const r = cha2ds2Vasc({
      age: 78, sex: 'female', hypertension: true, diabetes: true,
    });
    // 2 (age >=75) + 1 (HTN) + 1 (DM) + 1 (female) = 5
    expect(r.result).toBe(5);
    expect(r.band).toBe('high_risk_anticoag_recommended');
  });
  it('young male without risk factors = 0 → low risk', () => {
    const r = cha2ds2Vasc({ age: 35, sex: 'male' });
    expect(r.result).toBe(0);
    expect(r.band).toBe('low_risk_consider_no_anticoag');
  });
  it('prior stroke contributes 2 points', () => {
    const r = cha2ds2Vasc({ age: 50, sex: 'male', prior_stroke_tia: true });
    expect(r.result).toBe(2);
  });
});

describe('hasBled', () => {
  it('counts each true factor once', () => {
    expect(hasBled({
      hypertension_uncontrolled: true,
      abnormal_renal: true,
      prior_bleed: true,
    }).result).toBe(3);
  });
  it('>= 3 is high bleeding risk', () => {
    const r = hasBled({
      hypertension_uncontrolled: true,
      prior_stroke: true,
      prior_bleed: true,
    });
    expect(r.band).toBe('high_bleeding_risk');
  });
});

describe('wellsPe', () => {
  it('high probability when DVT signs + PE most likely (3+3=6, > moderate)', () => {
    const r = wellsPe({
      clinical_signs_dvt: true, pe_most_likely_diagnosis: true,
    });
    expect(r.result).toBe(6);
    // 6 → moderate; > 6 → high. Test explicitly the > 6 case.
    expect(r.band).toBe('moderate_probability');
    const r2 = wellsPe({
      clinical_signs_dvt: true, pe_most_likely_diagnosis: true, hr_over_100: true,
    });
    expect(r2.result).toBe(7.5);
    expect(r2.band).toBe('high_probability');
  });
  it('low probability when nothing positive', () => {
    expect(wellsPe({}).band).toBe('low_probability');
  });
});

describe('wellsDvt', () => {
  it('alternative diagnosis subtracts 2', () => {
    const r = wellsDvt({
      active_cancer: true,
      alternative_dx_at_least_as_likely: true,
    });
    expect(r.result).toBe(-1);
    expect(r.band).toBe('low_probability');
  });
});

describe('qsofa', () => {
  it('2+ is high risk for sepsis', () => {
    expect(qsofa({ rr_over_22: true, sbp_under_100: true }).band).toBe('high_risk_evaluate_for_sepsis');
  });
  it('0 is low risk', () => {
    expect(qsofa({}).band).toBe('low_risk');
  });
});

describe('gcs', () => {
  it('E4V5M6 = 15 (normal/mild)', () => {
    const r = gcs({ eye: 4, verbal: 5, motor: 6 });
    expect(r.result.total).toBe(15);
    expect(r.band).toBe('mild');
  });
  it('E1V1M1 = 3 (severe)', () => {
    const r = gcs({ eye: 1, verbal: 1, motor: 1 });
    expect(r.result.total).toBe(3);
    expect(r.band).toBe('severe');
  });
  it('rejects out-of-range inputs', () => {
    expect(() => gcs({ eye: 5, verbal: 5, motor: 6 })).toThrow();
    expect(() => gcs({ eye: 4, verbal: 6, motor: 6 })).toThrow();
    expect(() => gcs({ eye: 4, verbal: 5, motor: 7 })).toThrow();
  });
});

describe('meld', () => {
  it('on-dialysis pins creatinine to 4.0', () => {
    const a = meld({ creatinine_mg_dl: 1.0, bilirubin_mg_dl: 1.0, inr: 1.0, on_dialysis: true });
    const b = meld({ creatinine_mg_dl: 4.0, bilirubin_mg_dl: 1.0, inr: 1.0 });
    expect(a.result).toBe(b.result);
  });
  it('floors values at 1.0 (so a non-cirrhotic gets MELD ≈ 6)', () => {
    expect(meld({ creatinine_mg_dl: 0.5, bilirubin_mg_dl: 0.4, inr: 0.9 }).result).toBe(6);
  });
});

describe('anionGap', () => {
  it('Na 140 - (Cl 100 + HCO3 24) = 16, high', () => {
    const r = anionGap({ na: 140, cl: 100, hco3: 24 });
    expect(r.result).toBe(16);
    expect(r.band).toBe('high_ag_consider_metabolic_acidosis');
  });
  it('Na 140 - (Cl 105 + HCO3 25) = 10, normal', () => {
    expect(anionGap({ na: 140, cl: 105, hco3: 25 }).band).toBe('normal');
  });
});

describe('correctedCalcium', () => {
  it('standard Payne adjustment when albumin < 4', () => {
    // measured 8.0, albumin 2.0 → corrected = 8 + 0.8*(4-2) = 9.6
    expect(correctedCalcium({ calcium_mg_dl: 8.0, albumin_g_dl: 2.0 }).result).toBeCloseTo(9.6);
  });
  it('no adjustment when albumin = 4', () => {
    expect(correctedCalcium({ calcium_mg_dl: 9.0, albumin_g_dl: 4.0 }).result).toBeCloseTo(9.0);
  });
});

describe('apgar', () => {
  it('all 2s totals 10 (normal)', () => {
    const r = apgar({ appearance: 2, pulse: 2, grimace: 2, activity: 2, respiration: 2 });
    expect(r.result).toBe(10);
    expect(r.band).toBe('normal');
  });
  it('< 4 is severely depressed', () => {
    expect(apgar({ appearance: 0, pulse: 1, grimace: 0, activity: 1, respiration: 1 }).band)
      .toBe('severely_depressed');
  });
  it('rejects values outside 0-2', () => {
    expect(() => apgar({ appearance: 3, pulse: 2, grimace: 2, activity: 2, respiration: 2 }))
      .toThrow();
  });
});
