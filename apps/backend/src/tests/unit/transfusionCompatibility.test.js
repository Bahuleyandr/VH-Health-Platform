// Roadmap B5 — ABO/Rh compatibility matrix (pure).

import { checkUnitCompatibility } from '../../services/bloodbank/transfusionSafetyService.js';

describe('transfusion ABO/Rh matrix — red cells (prbc)', () => {
  test('identical group always passes', () => {
    expect(checkUnitCompatibility('A+', 'A+', 'prbc')).toEqual({ compatible: true, mode: 'identical' });
  });
  test('O- is the universal red-cell donor', () => {
    for (const recipient of ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']) {
      expect(checkUnitCompatibility('O-', recipient, 'prbc').compatible).toBe(true);
    }
  });
  test('AB+ is the universal red-cell recipient', () => {
    for (const donor of ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']) {
      expect(checkUnitCompatibility(donor, 'AB+', 'prbc').compatible).toBe(true);
    }
  });
  test('Rh-negative recipients reject Rh-positive cells', () => {
    expect(checkUnitCompatibility('A+', 'A-', 'prbc').compatible).toBe(false);
    expect(checkUnitCompatibility('O+', 'O-', 'prbc').compatible).toBe(false);
  });
  test('major ABO mismatch is incompatible', () => {
    expect(checkUnitCompatibility('A+', 'B+', 'prbc')).toEqual({ compatible: false, mode: 'incompatible' });
    expect(checkUnitCompatibility('AB+', 'O+', 'prbc').compatible).toBe(false);
  });
});

describe('transfusion matrix — plasma is inverted; whole blood identical-only; platelets caution', () => {
  test('AB plasma is the universal plasma donor (Rh ignored)', () => {
    for (const recipient of ['A+', 'B-', 'O+', 'AB-']) {
      expect(checkUnitCompatibility('AB+', recipient, 'ffp').compatible).toBe(true);
    }
  });
  test('O plasma only serves O recipients', () => {
    expect(checkUnitCompatibility('O+', 'O-', 'ffp').compatible).toBe(true);
    expect(checkUnitCompatibility('O+', 'A+', 'ffp').compatible).toBe(false);
  });
  test('whole blood must be identical', () => {
    expect(checkUnitCompatibility('O-', 'A+', 'whole_blood').compatible).toBe(false);
    expect(checkUnitCompatibility('A+', 'A+', 'whole_blood').compatible).toBe(true);
  });
  test('platelet mismatch returns caution (not silent pass)', () => {
    expect(checkUnitCompatibility('A+', 'B+', 'platelets')).toEqual({ compatible: false, mode: 'caution' });
  });
  test('unknown groups are rejected', () => {
    expect(checkUnitCompatibility('X+', 'A+', 'prbc').compatible).toBe(false);
  });
});
