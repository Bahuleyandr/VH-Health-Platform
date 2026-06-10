// Roadmap D1 — chemo dosing pure helpers.

import {
  computeBsaMosteller,
  computeDose,
  applyReduction,
  projectCumulativePerM2,
} from '../../services/oncology/chemoService.js';

describe('chemo computeBsaMosteller', () => {
  test('170 cm / 70 kg → 1.82 m² (Mosteller)', () => {
    expect(computeBsaMosteller(170, 70)).toBe(1.82);
  });
  test('160 cm / 50 kg → 1.49 m²', () => {
    expect(computeBsaMosteller(160, 50)).toBe(1.49);
  });
  test('rejects junk anthropometry', () => {
    expect(computeBsaMosteller(0, 70)).toBeNull();
    expect(computeBsaMosteller(170, -1)).toBeNull();
    expect(computeBsaMosteller(NaN, 70)).toBeNull();
  });
});

describe('chemo computeDose / applyReduction', () => {
  test('per-m² dosing scales with BSA', () => {
    expect(computeDose({ dose_per_m2: 60 }, 1.82)).toBe(109.2);
  });
  test('fixed dosing ignores BSA', () => {
    expect(computeDose({ fixed_dose: 100, dose_per_m2: null }, 1.82)).toBe(100);
  });
  test('reduction percentage applies and rounds', () => {
    expect(applyReduction(109.2, 25)).toBe(81.9);
    expect(applyReduction(100, 0)).toBe(100);
  });
});

describe('chemo projectCumulativePerM2 (anthracycline ceilings)', () => {
  test('flags a breach over the lifetime ceiling', () => {
    // Doxorubicin ceiling 450 mg/m²: 400 given + 60 planned = 460 → breach.
    const p = projectCumulativePerM2({ existingPerM2: 400, dosePerM2Planned: 60, ceiling: 450 });
    expect(p.projected).toBe(460);
    expect(p.breached).toBe(true);
  });
  test('passes under the ceiling and with no ceiling', () => {
    expect(projectCumulativePerM2({ existingPerM2: 300, dosePerM2Planned: 60, ceiling: 450 }).breached).toBe(false);
    expect(projectCumulativePerM2({ existingPerM2: 1000, dosePerM2Planned: 60, ceiling: null }).breached).toBe(false);
  });
});
