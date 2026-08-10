// C-M4 pins for src/utils/clinical/vitalPlausibility.js — hard plausibility
// bounds on the core vitals and the recorded_at sanity window.

import {
  VITAL_PLAUSIBILITY_BOUNDS,
  RECORDED_AT_MAX_FUTURE_MS,
  RECORDED_AT_MAX_BACKDATE_MS,
  assertVitalPlausibility,
  assertRecordedAtPlausibility,
} from '../../utils/clinical/vitalPlausibility.js';
import { AppError } from '../../utils/AppError.js';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

describe('assertVitalPlausibility — bound edges', () => {
  const CASES = Object.entries(VITAL_PLAUSIBILITY_BOUNDS).map(([field, b]) => [field, b.min, b.max]);

  it.each(CASES)('%s: accepts min (%d) and max (%d), rejects just outside', (field, min, max) => {
    expect(() => assertVitalPlausibility({ [field]: min })).not.toThrow();
    expect(() => assertVitalPlausibility({ [field]: max })).not.toThrow();
    expect(() => assertVitalPlausibility({ [field]: min - 1 })).toThrow(AppError);
    expect(() => assertVitalPlausibility({ [field]: max + 1 })).toThrow(AppError);
  });

  it('rejections are 400s naming the field and range', () => {
    try {
      assertVitalPlausibility({ spo2: 101 });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(400);
      expect(err.message).toMatch(/spo2 must be between 0 and 100/);
    }
  });

  it('SpO2: 100 and 0 accepted; 101 and -1 rejected', () => {
    expect(() => assertVitalPlausibility({ spo2: 100 })).not.toThrow();
    expect(() => assertVitalPlausibility({ spo2: 0 })).not.toThrow();
    expect(() => assertVitalPlausibility({ spo2: 101 })).toThrow(/spo2/);
    expect(() => assertVitalPlausibility({ spo2: -1 })).toThrow(/spo2/);
  });

  it('absent fields are skipped; unrelated fields are ignored', () => {
    expect(() => assertVitalPlausibility({})).not.toThrow();
    expect(() => assertVitalPlausibility({ heart_rate: null, spo2: undefined })).not.toThrow();
    expect(() => assertVitalPlausibility({ notes: 'x', supplemental_o2: true, pain_score: 99 })).not.toThrow();
  });

  it('non-numeric present values are rejected, numeric strings accepted', () => {
    expect(() => assertVitalPlausibility({ heart_rate: 'abc' })).toThrow(/heart_rate must be a number/);
    expect(() => assertVitalPlausibility({ heart_rate: '72' })).not.toThrow();
  });

  // Audit 2026-08-10 R5 — floors are physically-impossible-only. The old
  // HR min 20 / SBP min 40 / DBP min 20 rejected peri-arrest documentation
  // (asystole = HR 0) and preterm-neonate truth (SBP in the 30s-40s) with a
  // hard 400 at the bedside.
  it('peri-arrest truth is chartable: HR 15 during a code, HR 0 asystole, arrest BP 0', () => {
    expect(() => assertVitalPlausibility({ heart_rate: 15 })).not.toThrow();
    expect(() => assertVitalPlausibility({ heart_rate: 0 })).not.toThrow();
    expect(() => assertVitalPlausibility({ systolic_bp: 0, diastolic_bp: 0 })).not.toThrow();
  });

  it('accepts the complete peri-arrest envelope without weakening upper bounds', () => {
    expect(() => assertVitalPlausibility({
      heart_rate: 0,
      systolic_bp: 0,
      diastolic_bp: 0,
      temperature: 12,
      spo2: 0,
      respiratory_rate: 120,
      blood_glucose: 0,
    })).not.toThrow();

    expect(() => assertVitalPlausibility({ temperature: 11.9 })).toThrow(/temperature/);
    expect(() => assertVitalPlausibility({ respiratory_rate: 121 })).toThrow(/respiratory_rate/);
    expect(() => assertVitalPlausibility({ blood_glucose: -1 })).toThrow(/blood_glucose/);
  });

  it('neonatal truth is chartable: preterm SBP 45 / DBP 18', () => {
    expect(() => assertVitalPlausibility({ systolic_bp: 45, diastolic_bp: 18 })).not.toThrow();
  });

  it('garbage still rejects: negative values and HR 900', () => {
    expect(() => assertVitalPlausibility({ heart_rate: -1 })).toThrow(/heart_rate/);
    expect(() => assertVitalPlausibility({ heart_rate: 900 })).toThrow(/heart_rate/);
    expect(() => assertVitalPlausibility({ systolic_bp: -5 })).toThrow(/systolic_bp/);
    expect(() => assertVitalPlausibility({ diastolic_bp: -5 })).toThrow(/diastolic_bp/);
  });

  it('multi-field payload rejects on the implausible one', () => {
    expect(() => assertVitalPlausibility({
      heart_rate: 72, systolic_bp: 120, diastolic_bp: 80, temperature: 36.8,
      spo2: 98, respiratory_rate: 16, blood_glucose: 95, o2_flow_rate: 2,
    })).not.toThrow();
    expect(() => assertVitalPlausibility({ heart_rate: 72, systolic_bp: 400 })).toThrow(/systolic_bp/);
  });
});

describe('assertRecordedAtPlausibility — future bound (all sources)', () => {
  const now = Date.UTC(2026, 7, 8, 12, 0, 0);

  it('accepts now and small skew (+4 min); rejects beyond +5 min for every source', () => {
    expect(() => assertRecordedAtPlausibility(new Date(now), { now })).not.toThrow();
    expect(() => assertRecordedAtPlausibility(new Date(now + 4 * MINUTE), { now })).not.toThrow();
    expect(() => assertRecordedAtPlausibility(new Date(now + RECORDED_AT_MAX_FUTURE_MS), { now })).not.toThrow();
    for (const source of ['staff', 'patient_app', 'device', 'fhir']) {
      expect(() => assertRecordedAtPlausibility(new Date(now + 6 * MINUTE), { source, now }))
        .toThrow(/future/);
    }
  });
});

describe('assertRecordedAtPlausibility — backdate bound (source-dependent)', () => {
  const now = Date.UTC(2026, 7, 8, 12, 0, 0);

  it('staff/patient_app: 71h ago accepted, exactly 72h accepted, 73h rejected', () => {
    for (const source of ['staff', 'patient_app']) {
      expect(() => assertRecordedAtPlausibility(new Date(now - 71 * HOUR), { source, now })).not.toThrow();
      expect(() => assertRecordedAtPlausibility(new Date(now - RECORDED_AT_MAX_BACKDATE_MS), { source, now })).not.toThrow();
      expect(() => assertRecordedAtPlausibility(new Date(now - 73 * HOUR), { source, now }))
        .toThrow(/backdated/);
    }
  });

  it('device/fhir ingest is EXEMPT from the backdate bound (spool replays carry old timestamps)', () => {
    for (const source of ['device', 'fhir']) {
      expect(() => assertRecordedAtPlausibility(new Date(now - 73 * HOUR), { source, now })).not.toThrow();
      expect(() => assertRecordedAtPlausibility(new Date(now - 30 * 24 * HOUR), { source, now })).not.toThrow();
    }
  });

  it('an unknown/absent source gets the strict human-entry window', () => {
    expect(() => assertRecordedAtPlausibility(new Date(now - 73 * HOUR), { now })).toThrow(/backdated/);
  });

  it('backdate rejections are 400s', () => {
    try {
      assertRecordedAtPlausibility(new Date(now - 73 * HOUR), { source: 'staff', now });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(400);
    }
  });

  it('absent recorded_at is a no-op (DB defaults to now())', () => {
    expect(() => assertRecordedAtPlausibility(undefined, { source: 'staff', now })).not.toThrow();
    expect(() => assertRecordedAtPlausibility(null, { source: 'staff', now })).not.toThrow();
  });
});
