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
        { code: { coding: [{ system: 'http://loinc.org', code: '8480-6' }] }, valueQuantity: { value: 132, code: 'mm[Hg]' } },
        { code: { coding: [{ system: 'http://loinc.org', code: '8462-4' }] }, valueQuantity: { value: 84, code: 'mm[Hg]' } },
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

  test('normalizes source units using valueQuantity code or display unit', () => {
    const height = fhirObservationToVitals({
      code: { coding: [{ code: '8302-2' }] },
      valueQuantity: { value: 1.82, code: 'm', unit: 'metres' },
    });
    const saturation = fhirObservationToVitals({
      code: { coding: [{ code: '2708-6' }] },
      valueQuantity: { value: 0.88, code: '1', unit: 'fraction' },
    });
    const temperature = fhirObservationToVitals({
      code: { coding: [{ code: '8310-5' }] },
      valueQuantity: { value: 98.6, code: '[degF]' },
    });

    expect(height.vitals).toEqual({ height_cm: 182 });
    expect(saturation.vitals).toEqual({ spo2: 88 });
    expect(temperature.vitals.temperature).toBe(98.6);
    expect(temperature.temperatureUnit).toBe('F');
  });

  test.each([
    ['centimetres', '8302-2', 182, 'centimetres', 'height_cm', 182],
    ['millimetres', '8302-2', 1820, 'mm', 'height_cm', 182],
    ['pounds', '29463-7', 220.462262, '[lb_av]', 'weight_kg', 100],
    ['millimoles per litre', '2339-0', 5, 'mmol/L', 'blood_glucose', 90.091],
    ['unity saturation', '2708-6', 0.92, 'unity', 'spo2', 92],
    ['UCUM respirations per minute', '9279-1', 18, '{breaths}/min', 'respiratory_rate', 18],
  ])('normalizes %s into its canonical field', (_label, code, value, unit, field, expected) => {
    const out = fhirObservationToVitals({
      code: { coding: [{ code }] },
      valueQuantity: { value, code: unit },
    });

    expect(out.vitals[field]).toBeCloseTo(expected, 3);
  });

  test('rejects conflicting UCUM code and display units', () => {
    expect(() => fhirObservationToVitals({
      code: { coding: [{ code: '2708-6' }] },
      valueQuantity: { value: 0.92, code: '1', unit: '%' },
    })).toThrow(/conflicting source units/i);
  });

  test('does not let a display unit mask an invalid UCUM code', () => {
    expect(() => fhirObservationToVitals({
      code: { coding: [{ code: '8867-4' }] },
      valueQuantity: { value: 91, code: 'kg', unit: 'beats/minute' },
    })).toThrow(/unsupported source unit/i);
  });

  test.each([
    ['missing quantity value', { valueQuantity: { code: '/min' } }],
    ['junk numeric suffix', { valueQuantity: { value: '88junk', code: '/min' } }],
    ['unsupported source unit', { valueQuantity: { value: 88, code: 'kg' } }],
  ])('rejects a known vital with %s', (_label, measurement) => {
    expect(() => fhirObservationToVitals({
      code: { coding: [{ code: '8867-4' }] },
      ...measurement,
    })).toThrow(/FHIR Observation.*heart rate/i);
  });

  test('rejects a malformed known component instead of partially mapping the panel', () => {
    expect(() => fhirObservationToVitals({
      code: { coding: [{ code: '85354-9' }] },
      component: [
        { code: { coding: [{ code: '8480-6' }] }, valueQuantity: { value: 120, code: 'mm[Hg]' } },
        { code: { coding: [{ code: '8462-4' }] }, valueQuantity: { value: '80mmHg', code: 'mm[Hg]' } },
      ],
    })).toThrow(/FHIR Observation.*diastolic blood pressure/i);
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

  test('rejects junk numeric suffixes for known OBX vitals', () => {
    expect(() => obxResultsToVitals([
      { loinc_code: '8867-4', value_numeric: 91, value_text: '91bpm' },
    ])).toThrow(/finite numeric value/i);
  });
});

describe('mapping table', () => {
  test('covers the core monitor vitals', () => {
    for (const code of ['8867-4', '8480-6', '8462-4', '8310-5', '9279-1', '2708-6', '59408-5']) {
      expect(LOINC_TO_VITALS_FIELD[code]).toBeDefined();
    }
  });
});
