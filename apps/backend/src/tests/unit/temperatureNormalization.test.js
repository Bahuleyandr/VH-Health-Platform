// Unit tests for normalizeTemperatureC — the pure converter that keeps the
// vital-sign alert engine from raising a false CRITICAL hyperthermia alert
// when a temperature is recorded in Fahrenheit. The alert thresholds in
// vitalSignMonitor.js are Celsius (critical_max 40.0), so a Fahrenheit value
// (e.g. 100.4°F ≈ 38°C) must be converted before the comparison.
// Finding 2026-05-21-walk-in-opd-doctor-126619d3.

import { normalizeTemperatureC } from '../../utils/clinical/vitalSignMonitor.js';

describe('normalizeTemperatureC', () => {
  describe('explicit Fahrenheit hint', () => {
    it('converts 100.4°F to exactly 38.0°C', () => {
      expect(normalizeTemperatureC(100.4, 'F')).toBeCloseTo(38.0, 10);
    });

    it('converts 98.6°F to exactly 37.0°C', () => {
      expect(normalizeTemperatureC(98.6, 'F')).toBeCloseTo(37.0, 10);
    });

    it('converts the freezing point 32°F to 0°C', () => {
      expect(normalizeTemperatureC(32, 'F')).toBeCloseTo(0, 10);
    });

    it('accepts the long form "fahrenheit" (case-insensitive)', () => {
      expect(normalizeTemperatureC(104, 'Fahrenheit')).toBeCloseTo(40.0, 10);
      expect(normalizeTemperatureC(104, 'fahrenheit')).toBeCloseTo(40.0, 10);
    });

    it('parses a string Fahrenheit value', () => {
      expect(normalizeTemperatureC('100.4', 'F')).toBeCloseTo(38.0, 10);
    });
  });

  describe('explicit Celsius hint', () => {
    it('leaves 38.2°C unchanged', () => {
      expect(normalizeTemperatureC(38.2, 'C')).toBe(38.2);
    });

    it('leaves a value in the Fahrenheit-looking band unchanged when told it is Celsius', () => {
      // Defends against a future caller that always sends 'C' — we trust the
      // explicit hint over range inference. (Not physiological, but the hint wins.)
      expect(normalizeTemperatureC(60, 'C')).toBe(60);
    });

    it('accepts the long form "celsius" (case-insensitive)', () => {
      expect(normalizeTemperatureC(37.5, 'celsius')).toBe(37.5);
    });
  });

  describe('no unit hint — inference by plausible range', () => {
    it('treats 100.4 (no unit) as Fahrenheit and converts to 38.0°C', () => {
      expect(normalizeTemperatureC(100.4)).toBeCloseTo(38.0, 10);
    });

    it('treats 38.2 (no unit) as Celsius and leaves it unchanged', () => {
      expect(normalizeTemperatureC(38.2)).toBe(38.2);
    });

    it('treats a genuine hyperpyrexia 41.5°C (no unit) as Celsius (not Fahrenheit)', () => {
      expect(normalizeTemperatureC(41.5)).toBe(41.5);
    });

    it('treats 95 (no unit) as the Fahrenheit lower body-temp band → 35.0°C', () => {
      expect(normalizeTemperatureC(95)).toBeCloseTo(35.0, 10);
    });

    it('treats an unrecognized unit string as no hint and infers by range', () => {
      expect(normalizeTemperatureC(100.4, 'degrees')).toBeCloseTo(38.0, 10);
      expect(normalizeTemperatureC(38.2, '°C')).toBe(38.2); // symbol not in our hint set → infer
    });
  });

  describe('null / undefined / non-numeric pass-through', () => {
    it('returns null unchanged', () => {
      expect(normalizeTemperatureC(null, 'F')).toBeNull();
    });

    it('returns undefined unchanged', () => {
      expect(normalizeTemperatureC(undefined)).toBeUndefined();
    });

    it('returns a non-numeric string unchanged', () => {
      expect(normalizeTemperatureC('not-a-temp', 'F')).toBe('not-a-temp');
    });
  });

  describe('regression: Fahrenheit fever must not read as critical Celsius', () => {
    // The alert engine flags CRITICAL at >= 40.0°C. A normothermic 100.4°F
    // reading (≈ 38°C, mild fever) must land WELL below that boundary.
    it('100.4°F normalizes below the 40.0°C critical threshold', () => {
      const celsius = normalizeTemperatureC(100.4, 'F');
      expect(celsius).toBeLessThan(40.0);
      expect(celsius).toBeCloseTo(38.0, 10);
    });

    it('a genuine 105°F hyperpyrexia still normalizes above the 40.0°C critical threshold', () => {
      const celsius = normalizeTemperatureC(105, 'F');
      expect(celsius).toBeGreaterThanOrEqual(40.0);
      expect(celsius).toBeCloseTo(40.555, 2);
    });
  });
});
