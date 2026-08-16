// Gap-audit 2026-08 (HL7 units): extractVitalsFromOru dropped OBX-6, so a
// device reporting blood glucose in mmol/L stored the raw number as "mg/dL" —
// a normal 3.9 mmol/L became 3.9 mg/dL, under vitalSignMonitor's adult
// critical_min of 50, firing a false CRITICAL-hypo alert chain
// (clinical_alerts + results-inbox task + dispatch).
//
// Pins:
//   * extractVitalsFromOru preserves OBX-6 (CE identifier form included),
//   * obxResultsToVitals converts known units to the canonical storage
//     contract (mmol/L→mg/dL ×18.0182, °F→°C, fraction→% SpO2),
//   * canonical-unit and unitless observations pass through unchanged
//     (unitless = the documented assume-canonical default: many bedside
//     monitors omit OBX-6),
//   * an unknown non-empty unit on a mappable vital REJECTS with
//     DEVICE_VITALS_UNSUPPORTED_UNIT (4xx → gateway dead-letter) instead of
//     storing a guess,
//   * an unmapped (non-vital) code with a weird unit stays merely unmapped.
import { parseHL7 } from '../../services/hl7/hl7Parser.js';
import { extractVitalsFromOru } from '../../services/emr/deviceVitalsService.js';
import { obxResultsToVitals, applyUnitConversion } from '../../services/fhir/observationVitalsMapper.js';

const UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const build = (segments) => extractVitalsFromOru(parseHL7(segments.join('\r')));

describe('extractVitalsFromOru OBX-6 units', () => {
  test('preserves plain and CE-form units per observation; absent OBX-6 yields empty string', () => {
    const out = build([
      'MSH|^~\\&|MON|ICU||VH|20260610130000||ORU^R01|CIDU1|P|2.5',
      `PID|1||${UID}||TS^Patient`,
      'OBR|1|||VITALS',
      'OBX|1|NM|2339-0^Glucose||3.9|mmol/L|||||F',
      'OBX|2|NM|8310-5^Temp||98.6|[degF]^degrees Fahrenheit^UCUM|||||F',
      'OBX|3|NM|8867-4^HR||80||||||F',
    ]);
    expect(out.observations).toEqual([
      expect.objectContaining({ loinc_code: '2339-0', value_numeric: 3.9, units: 'mmol/L' }),
      expect.objectContaining({ loinc_code: '8310-5', value_numeric: 98.6, units: '[degF]' }),
      expect.objectContaining({ loinc_code: '8867-4', value_numeric: 80, units: '' }),
    ]);
  });
});

describe('obxResultsToVitals unit normalization', () => {
  test('mmol/L glucose converts to canonical mg/dL — a normal 3.9 mmol/L can no longer read as CRITICAL hypo', () => {
    const out = obxResultsToVitals([{ loinc_code: '2339-0', value_text: '3.9', units: 'mmol/L' }]);
    expect(out.vitals.blood_glucose).toBeCloseTo(70.27, 1);
    // vitalSignMonitor ADULT_RANGES: blood_glucose critical_min 50, min 70
    // (mg/dL). The converted value sits in the normal band; the raw 3.9 was
    // deep inside the CRITICAL band.
    expect(out.vitals.blood_glucose).toBeGreaterThan(50);
    expect(out.vitals.blood_glucose).toBeGreaterThanOrEqual(70);
    expect(out.mapped).toEqual(['2339-0']);
  });

  test('°F converts to the °C canonical storage contract', () => {
    const out = obxResultsToVitals([{ loinc_code: '8310-5', value_text: '98.6', units: '[degF]' }]);
    expect(out.vitals.temperature).toBeCloseTo(37.0, 5);
  });

  test('canonical-unit observations pass through unchanged', () => {
    const out = obxResultsToVitals([
      { loinc_code: '2339-0', value_text: '85', units: 'mg/dL' },
      { loinc_code: '8310-5', value_text: '37.2', units: 'Cel' },
      { loinc_code: '8480-6', value_text: '120', units: 'mmHg' },
      { loinc_code: '8867-4', value_text: '80', units: '/min' },
    ]);
    expect(out.vitals).toEqual({
      blood_glucose: 85, temperature: 37.2, systolic_bp: 120, heart_rate: 80,
    });
  });

  test('unitless observations keep the historical assume-canonical behavior', () => {
    const out = obxResultsToVitals([
      { loinc_code: '2339-0', value_text: '85' },
      { loinc_code: '8867-4', value_text: '80', units: '' },
    ]);
    expect(out.vitals).toEqual({ blood_glucose: 85, heart_rate: 80 });
  });

  test('SpO2 reported as a fraction converts to percent', () => {
    const out = obxResultsToVitals([{ loinc_code: '59408-5', value_text: '0.97', units: '1' }]);
    expect(out.vitals.spo2).toBeCloseTo(97, 5);
  });

  test('unknown non-empty unit on a mappable vital is rejected with DEVICE_VITALS_UNSUPPORTED_UNIT', () => {
    let thrown;
    try {
      obxResultsToVitals([{ loinc_code: '2339-0', value_text: '3.9', units: 'mg/mL' }]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('DEVICE_VITALS_UNSUPPORTED_UNIT');
    expect(thrown.statusCode).toBe(400);
    expect(thrown.message).toMatch(/unsupported unit/i);
  });

  test('an unmapped non-vital code with a weird unit stays merely unmapped (no throw)', () => {
    const out = obxResultsToVitals([
      { loinc_code: '2160-0', value_text: '1.1', units: 'furlong/fortnight' },
      { loinc_code: '8867-4', value_text: '80', units: 'bpm' },
    ]);
    expect(out.vitals).toEqual({ heart_rate: 80 });
    expect(out.unmapped).toEqual(['2160-0']);
  });
});

describe('applyUnitConversion', () => {
  test('handles the affine fahrenheit case and plain factors', () => {
    expect(applyUnitConversion(98.6, { kind: 'fahrenheit', factor: 1 })).toBeCloseTo(37.0, 5);
    expect(applyUnitConversion(3.9, { kind: 'mmol_per_l', factor: 18.0182 })).toBeCloseTo(70.27, 1);
  });
});
