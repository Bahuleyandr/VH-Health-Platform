// Unit tests for finding 2026-05-21-walk-in-opd-pharmacy-1646bc24
// (+ siblings 938226ba / b5f42707 / 4b182892) — pharmacy dispense safety.
//
// Two pure helpers exported from ePrescriptionController.js back the fix:
//   - isLiquidForm()        gates the "measure X ml with an oral syringe" /
//                           mL dose-conversion wording so a SOLID oral form
//                           (tablet/capsule) never gets liquid instructions.
//   - deriveDispenseQuantity() derives the prescribed count from frequency ×
//                           duration (1-1-1 × 3 days = 9) instead of silently
//                           defaulting a missing quantity to 1.
// Pure functions — no DB.

import {
  isLiquidForm,
  deriveDispenseQuantity,
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
