// Unit tests for finding 2026-05-21-walk-in-opd-pharmacy-1646bc24
// (+ siblings 938226ba / b5f42707 / 4b182892) — pharmacy dispense safety.
//
// Pure helpers exported from ePrescriptionController.js back the fix:
//   - isLiquidForm()        gates the "measure X ml with an oral syringe" /
//                           mL dose-conversion wording so a SOLID oral form
//                           (tablet/capsule) never gets liquid instructions.
//   - deriveDispenseQuantity() derives the prescribed count from frequency ×
//                           duration (1-1-1 × 3 days = 9) instead of silently
//                           defaulting a missing quantity to 1.
//   - deriveLiquidDoseMl()  derives the per-dose VOLUME for a pediatric liquid
//                           from weight × mg/kg ÷ concentration — NOT the
//                           concentration's own mL denominator (finding
//                           2026-05-22-pediatric-opd-pharmacy-f346bf82).
// Pure functions — no DB.

import {
  isLiquidForm,
  deriveDispenseQuantity,
  deriveLiquidDoseMl,
} from '../../controllers/prescription/ePrescriptionController.js';

describe('isLiquidForm (solid vs liquid dispense-label gate — 1646bc24)', () => {
  it('classifies explicit liquid forms as liquid', () => {
    expect(isLiquidForm('Paracetamol Syrup 125mg/5ml')).toBe(true);
    expect(isLiquidForm('Amoxicillin Oral Suspension')).toBe(true);
    expect(isLiquidForm('Cetirizine Solution')).toBe(true);
    expect(isLiquidForm('Vitamin D Drops')).toBe(true);
    expect(isLiquidForm('Paediatric Elixir')).toBe(true);
  });

  it('treats an explicit mg/mL concentration as a liquid signal', () => {
    expect(isLiquidForm('250mg/5ml')).toBe(true);
    // Concentration wins even when an incidental solid token is present.
    expect(isLiquidForm('Ibuprofen 100mg/5ml tab-free syrup')).toBe(true);
  });

  it('classifies solid oral forms as NOT liquid', () => {
    expect(isLiquidForm('Paracetamol 500mg tablet')).toBe(false);
    expect(isLiquidForm('Paracetamol 500mg Tab')).toBe(false);
    expect(isLiquidForm('Amoxicillin 500mg Capsule')).toBe(false);
    expect(isLiquidForm('Omeprazole Cap')).toBe(false);
    expect(isLiquidForm('Chewable tablet')).toBe(false);
  });

  it('returns false the moment ANY argument names a solid form (the b5f42707 bug)', () => {
    // Catalog name "Paracetamol 500mg" + requested "Paracetamol 500 mg":
    // a tablet matched to its own row must not be classed liquid.
    expect(isLiquidForm('Paracetamol 500mg', 'Paracetamol 500 mg tablet')).toBe(false);
  });

  it('returns null when there is no form signal at all', () => {
    expect(isLiquidForm('Paracetamol 500mg')).toBeNull();
    expect(isLiquidForm('', null, undefined)).toBeNull();
    expect(isLiquidForm()).toBeNull();
  });

  it('does not mistake mg-only strength for a liquid', () => {
    expect(isLiquidForm('500 mg')).toBeNull();
    expect(isLiquidForm('15 mg/kg')).toBeNull();
  });
});

describe('deriveDispenseQuantity (frequency × duration — 938226ba)', () => {
  it('derives 9 for a 1-1-1 TDS course over 3 days', () => {
    expect(deriveDispenseQuantity({ frequency: '1-1-1', duration: '3 days' })).toBe(9);
    expect(deriveDispenseQuantity({ frequency: 'TDS', duration: '3 days' })).toBe(9);
    expect(deriveDispenseQuantity({ frequency: 'TID', duration: '3' })).toBe(9);
  });

  it('handles dash patterns with zero slots (1-0-1 BD)', () => {
    expect(deriveDispenseQuantity({ frequency: '1-0-1', duration: '5 days' })).toBe(10);
    expect(deriveDispenseQuantity({ frequency: '0-0-1', duration: '7 days' })).toBe(7);
    expect(deriveDispenseQuantity({ frequency: '1-1-1-1', duration: '2 days' })).toBe(8);
  });

  it('maps OD/BD/QID codes and longhand', () => {
    expect(deriveDispenseQuantity({ frequency: 'OD', duration: '10 days' })).toBe(10);
    expect(deriveDispenseQuantity({ frequency: 'BD', duration: '5 days' })).toBe(10);
    expect(deriveDispenseQuantity({ frequency: 'QID', duration: '3 days' })).toBe(12);
    expect(deriveDispenseQuantity({ frequency: 'twice daily', duration: '4 days' })).toBe(8);
    expect(deriveDispenseQuantity({ frequency: '3 times a day', duration: '2 days' })).toBe(6);
  });

  it('parses week durations', () => {
    expect(deriveDispenseQuantity({ frequency: 'OD', duration: '1 week' })).toBe(7);
    expect(deriveDispenseQuantity({ frequency: 'BD', duration: '2 weeks' })).toBe(28);
  });

  it('multiplies by units-per-dose when given', () => {
    expect(deriveDispenseQuantity({ frequency: 'BD', duration: '3 days', unitsPerDose: 2 })).toBe(12);
  });

  it('returns null for SOS/PRN (no fixed daily count) — caller must flag', () => {
    expect(deriveDispenseQuantity({ frequency: 'SOS', duration: '3 days' })).toBeNull();
    expect(deriveDispenseQuantity({ frequency: 'PRN', duration: '5 days' })).toBeNull();
    expect(deriveDispenseQuantity({ frequency: 'as needed', duration: '5 days' })).toBeNull();
  });

  it('returns null when frequency or duration is unparseable', () => {
    expect(deriveDispenseQuantity({ frequency: '', duration: '3 days' })).toBeNull();
    expect(deriveDispenseQuantity({ frequency: 'TDS', duration: '' })).toBeNull();
    expect(deriveDispenseQuantity({ frequency: 'TDS', duration: 'until better' })).toBeNull();
    expect(deriveDispenseQuantity({})).toBeNull();
    expect(deriveDispenseQuantity()).toBeNull();
  });
});

describe('deriveLiquidDoseMl (pediatric liquid dose VOLUME — f346bf82)', () => {
  // The reproduced finding: Baby Aarav, 12.5 kg, Paracetamol 125mg/5ml syrup,
  // dose "187.5mg = 7.5ml of 125mg/5ml syrup", "15mg/kg for 12.5kg child".
  // The old parseMlFromText() grabbed the trailing "5ml" from the
  // concentration and labelled a flat 5 mL — a ~33% underdose. The dose MUST
  // derive from weight × mg/kg ÷ concentration = 187.5mg ÷ 25mg/mL = 7.5 mL.
  it('derives the weight-based volume for the exact finding, NEVER the 5 mL denominator', () => {
    const out = deriveLiquidDoseMl({
      doseText: '187.5mg = 7.5ml of 125mg/5ml syrup',
      instructionText: 'Dose calculated at 15mg/kg for 12.5kg child',
      concentrationMgPerMl: 125 / 5, // 25 mg/mL
      concentrationMl: 5,
      weightKg: 12.5,
    });
    expect(out).toEqual({
      ml: 7.5, source: 'weight_based', totalMg: 187.5, mgPerKg: 15, weightKg: 12.5,
    });
    expect(out.ml).not.toBe(5); // the bug value
  });

  it('computes (mg/kg × weight) ÷ concentration for a clean rate', () => {
    // 15 mg/kg × 10 kg = 150 mg; ÷ 25 mg/mL = 6 mL.
    expect(deriveLiquidDoseMl({
      doseText: '15 mg/kg', concentrationMgPerMl: 25, concentrationMl: 5, weightKg: 10,
    })).toMatchObject({ ml: 6, source: 'weight_based', totalMg: 150 });
  });

  it('falls back to explicit mg ÷ concentration when weight is unknown', () => {
    // "187.5 mg" dose ÷ 25 mg/mL = 7.5 mL — the strength mg numerator is
    // stripped first so it is not mistaken for the dose.
    expect(deriveLiquidDoseMl({
      doseText: '187.5mg = 7.5ml of 125mg/5ml syrup',
      concentrationMgPerMl: 25, concentrationMl: 5, weightKg: null,
    })).toMatchObject({ ml: 7.5, source: 'mg_per_concentration', totalMg: 187.5 });
  });

  it('takes a free-text dose mL that is NOT the concentration denominator', () => {
    // "Syrup 250 mg/5 mL: 3.75 mL" → dose is 3.75 mL, not the 5 mL denominator
    // and not 250mg÷50=5 (the 250mg is the strength numerator, stripped).
    expect(deriveLiquidDoseMl({
      doseText: 'Syrup 250 mg/5 mL: 3.75 mL',
      concentrationMgPerMl: 50, concentrationMl: 5, weightKg: null,
    })).toEqual({ ml: 3.75, source: 'dose_text_ml' });
  });

  it('uses a plain dose mL when there is no concentration at all (e.g. K-Lyte 15mL)', () => {
    expect(deriveLiquidDoseMl({ doseText: '15mL' })).toEqual({ ml: 15, source: 'dose_text_ml' });
  });

  it('returns null for a bare concentration with no dose — never the denominator', () => {
    expect(deriveLiquidDoseMl({
      doseText: '125mg/5ml', concentrationMgPerMl: 25, concentrationMl: 5,
    })).toBeNull();
  });

  it('prefers the weight-based volume over a (correct) free-text mL', () => {
    // Both present and agree — weight-based path wins and reports the math.
    const out = deriveLiquidDoseMl({
      doseText: '187.5mg = 7.5ml',
      instructionText: '15 mg/kg, weight 12.5 kg',
      concentrationMgPerMl: 25, concentrationMl: 5, weightKg: 12.5,
    });
    expect(out.source).toBe('weight_based');
    expect(out.ml).toBe(7.5);
  });

  it('returns null when nothing is parseable', () => {
    expect(deriveLiquidDoseMl({ doseText: 'take as directed' })).toBeNull();
    expect(deriveLiquidDoseMl({})).toBeNull();
    expect(deriveLiquidDoseMl()).toBeNull();
  });
});
