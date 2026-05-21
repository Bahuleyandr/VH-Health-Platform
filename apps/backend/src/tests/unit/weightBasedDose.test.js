// Unit test for finding
// 2026-05-21-pediatric-opd-patient-ffea3aba
//
// The pediatric prescription PDF showed only the per-kg dose rate (e.g.
// "15 mg/kg") and never the computed dose, so a parent/pharmacist could not
// verify the child's actual dose. computeWeightBasedDose() parses the mg/kg
// rate and computes the total against the patient's weight; the PDF renders
// "15 mg/kg × 12 kg = 180 mg per dose". Pure function — no DB.

import { computeWeightBasedDose } from '../../controllers/prescription/ePrescriptionController.js';

describe('computeWeightBasedDose (pediatric weight-based dose — ffea3aba)', () => {
  it('computes mg/kg × weight', () => {
    expect(computeWeightBasedDose('15 mg/kg', 12)).toEqual({
      mgPerKg: 15, weightKg: 12, totalMg: 180,
    });
  });

  it('parses a compact "10mg/kg/dose" rate', () => {
    expect(computeWeightBasedDose('10mg/kg/dose', 8)).toEqual({
      mgPerKg: 10, weightKg: 8, totalMg: 80,
    });
  });

  it('tolerates spaced "7.5 mg / kg"', () => {
    expect(computeWeightBasedDose('7.5 mg / kg', 10)).toEqual({
      mgPerKg: 7.5, weightKg: 10, totalMg: 75,
    });
  });

  it('keeps a fractional total', () => {
    expect(computeWeightBasedDose('12.5 mg/kg', 9)).toEqual({
      mgPerKg: 12.5, weightKg: 9, totalMg: 112.5,
    });
  });

  it('returns null for a flat (non-per-kg) dose', () => {
    expect(computeWeightBasedDose('500 mg', 12)).toBeNull();
  });

  it('does NOT mistake a mg/mL concentration for a per-kg rate', () => {
    expect(computeWeightBasedDose('250mg/5ml', 12)).toBeNull();
  });

  it('returns null when the weight is unknown or non-positive', () => {
    expect(computeWeightBasedDose('15 mg/kg', null)).toBeNull();
    expect(computeWeightBasedDose('15 mg/kg', 0)).toBeNull();
    expect(computeWeightBasedDose('15 mg/kg', -3)).toBeNull();
  });

  it('returns null for empty/garbage dose text', () => {
    expect(computeWeightBasedDose('', 12)).toBeNull();
    expect(computeWeightBasedDose(null, 12)).toBeNull();
  });
});
