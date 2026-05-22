// Unit tests for formatTemperatureForDisplay — the pure helper the
// prescription PDF uses to render the temperature vital. Both render sites
// (prescriptionPdfHelper.js + ePrescriptionController.js inline generator)
// used to hardcode a `°F` suffix, which printed a Celsius reading as nonsense
// (e.g. 38.2 → "38.2°F"). Since #171 the platform normalizes charted
// temperatures to Celsius, so a prescription's snapshotted temperature is —
// or should be — Celsius. This helper normalizes defensively (inferring and
// converting a stray Fahrenheit reading) and always labels the result °C.
// Finding D1 (Rx-PDF temperature unit label).

import { formatTemperatureForDisplay } from '../../services/prescription/prescriptionPdfHelper.js';

describe('formatTemperatureForDisplay', () => {
  describe('Celsius input (the post-#171 common case)', () => {
    it('renders a febrile Celsius reading with a °C label, not °F', () => {
      const out = formatTemperatureForDisplay(38.2);
      expect(out).toBe('38.2°C');
      // The whole point of the fix: a Celsius value must not be stamped °F.
      expect(out).not.toContain('°F');
    });

    it('renders a normal Celsius reading as °C', () => {
      expect(formatTemperatureForDisplay(37)).toBe('37°C');
    });

    it('honors an explicit Celsius unit hint without converting', () => {
      expect(formatTemperatureForDisplay(38.2, 'C')).toBe('38.2°C');
    });
  });

  describe('legacy / stray Fahrenheit input is converted, then labeled °C', () => {
    it('converts a value with an explicit F hint', () => {
      expect(formatTemperatureForDisplay(100.4, 'F')).toBe('38°C');
    });

    it('infers Fahrenheit for an out-of-Celsius-range value (>= 60) and converts', () => {
      // 100.4°F ≈ 38.0°C — without inference this would print "100.4°F".
      expect(formatTemperatureForDisplay(100.4)).toBe('38°C');
      expect(formatTemperatureForDisplay(98.6)).toBe('37°C');
    });
  });

  describe('rounding', () => {
    it('rounds to one decimal place (no float dust)', () => {
      // 99.5°F = 37.5°C exactly; 101.3°F = 38.5°C exactly — but pick a value
      // that would otherwise carry float noise.
      expect(formatTemperatureForDisplay(99.1, 'F')).toBe('37.3°C');
    });
  });

  describe('absent / non-renderable input', () => {
    it('returns null for null', () => {
      expect(formatTemperatureForDisplay(null)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(formatTemperatureForDisplay(undefined)).toBeNull();
    });

    it('returns null for a non-numeric string', () => {
      expect(formatTemperatureForDisplay('not-a-temp')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(formatTemperatureForDisplay('')).toBeNull();
    });
  });
});
