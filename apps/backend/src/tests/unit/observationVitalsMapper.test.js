// Roadmap C3/C5 — LOINC ↔ vitals mapping (pure).

import {
  fhirObservationToVitals,
  obxResultsToVitals,
  LOINC_TO_VITALS_FIELD,
} from '../../services/fhir/observationVitalsMapper.js';

describe('fhirObservationToVitals', () => {
  test('maps a single-code observation (heart rate)', () => {
    const out = fhirObservationToVitals({
      resourceType: 'Observation',
      code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
      valueQuantity: { value: 88, unit: 'beats/min' },
      effectiveDateTime: '2026-06-10T08:00:00Z',
    });
    expect(out.vitals).toEqual({ heart_rate: 88 });
    expect(out.mapped).toEqual(['8867-4']);
    expect(out.effective).toBe('2026-06-10T08:00:00Z');
  });

  test('maps a BP panel via components', () => {
    const out = fhirObservationToVitals({
      code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] },
      component: [
        { code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] }, valueQuantity: { value: 132 } },
        { code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] }, valueQuantity: { value: 84 } },
      ],
    });
    expect(out.vitals).toEqual({ systolic_bp: 132, diastolic_bp: 84 });
    expect(out.mapped.sort()).toEqual(['8462-4', '8480-6']);
    expect(out.unmapped).toEqual([]);
  });

  test('detects Fahrenheit temperatures', () => {
    const out = fhirObservationToVitals({
      code: { coding: [{ code: '8310-5' }] },
      valueQuantity: { value: 101.2, unit: 'degF' },
    });
    expect(out.vitals.temperature).toBe(101.2);
    expect(out.temperatureUnit).toBe('F');
  });

  test('unsupported codes are reported, not silently dropped', () => {
    const out = fhirObservationToVitals({
      code: { coding: [{ system: 'http://loinc.org', code: '718-7' }] }, // haemoglobin
      valueQuantity: { value: 11.2 },
    });
    expect(out.mapped).toEqual([]);
    expect(out.unmapped).toEqual(['718-7']);
  });
});

describe('obxResultsToVitals', () => {
  test('maps OBX-style rows and collects unmapped codes', () => {
    const out = obxResultsToVitals([
      { loinc_code: '8867-4', value_numeric: 91 },
      { test_code: '9279-1', value_numeric: 22 },
      { loinc_code: '2160-0', value_numeric: 1.1 }, // creatinine — not a vital
    ]);
    expect(out.vitals).toEqual({ heart_rate: 91, respiratory_rate: 22 });
    expect(out.unmapped).toEqual(['2160-0']);
  });
});

describe('mapping table', () => {
  test('covers the core monitor vitals', () => {
    for (const code of ['8867-4', '8480-6', '8462-4', '8310-5', '9279-1', '2708-6', '59408-5']) {
      expect(LOINC_TO_VITALS_FIELD[code]).toBeDefined();
    }
  });
});
