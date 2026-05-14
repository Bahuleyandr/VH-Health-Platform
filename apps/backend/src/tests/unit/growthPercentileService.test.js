// Unit tests for the growth-percentile helpers that wire WHO percentile
// computation into the vitals recording flow. Findings:
//   2026-05-09-pediatric-opd-nurse-growth-chart-not-linked-to-vitals
//   2026-05-11-pediatric-opd-nurse-4354eb08
//
// Pure functions — no DB. The 730-day / sex=M / weight=12.5 cohort and
// its expected percentiles (57.51 weight, 41.15 height@87cm) are taken
// straight from the 4354eb08 repro, so these assert that the snapshot
// helper delegates to computePercentile without distorting the math.

import {
  normaliseSex, ageInDaysFrom, computeGrowthSnapshot,
} from '../../services/clinical/growthPercentileService.js';

describe('normaliseSex', () => {
  it('maps common male spellings to M', () => {
    expect(normaliseSex('M')).toBe('M');
    expect(normaliseSex('male')).toBe('M');
    expect(normaliseSex(' Male ')).toBe('M');
  });

  it('maps common female spellings to F', () => {
    expect(normaliseSex('F')).toBe('F');
    expect(normaliseSex('FEMALE')).toBe('F');
  });

  it('returns null for unclassifiable input', () => {
    expect(normaliseSex('')).toBeNull();
    expect(normaliseSex(null)).toBeNull();
    expect(normaliseSex(undefined)).toBeNull();
    expect(normaliseSex('other')).toBeNull();
    expect(normaliseSex('unknown')).toBeNull();
  });
});

describe('ageInDaysFrom', () => {
  const asOf = new Date('2026-05-14T00:00:00Z');

  it('computes whole days between DOB and asOf', () => {
    expect(ageInDaysFrom('2026-05-04', asOf)).toBe(10);
    expect(ageInDaysFrom(new Date('2025-05-14T00:00:00Z'), asOf)).toBe(365);
  });

  it('returns null for missing / unparseable / future DOB', () => {
    expect(ageInDaysFrom(null, asOf)).toBeNull();
    expect(ageInDaysFrom('', asOf)).toBeNull();
    expect(ageInDaysFrom('not-a-date', asOf)).toBeNull();
    expect(ageInDaysFrom('2027-01-01', asOf)).toBeNull();
  });
});

describe('computeGrowthSnapshot', () => {
  const asOf = new Date('2026-05-14T00:00:00Z');
  // 2-year-old (730 days) — the Baby Aarav cohort from finding 4354eb08.
  const dobTwoYears = new Date(asOf.getTime() - 730 * 86400000);

  it('computes a weight percentile for a child with sex + DOB on file', () => {
    const snap = computeGrowthSnapshot({
      gender: 'M', birthday: dobTwoYears, weightKg: 12.5, asOf,
    });
    expect(snap).not.toBeNull();
    expect(snap.sex).toBe('M');
    expect(snap.age_in_days).toBe(730);
    expect(snap.reference_dataset).toBe('WHO_0_5');
    // Same number the finding's compute endpoint returned for this cohort.
    expect(snap.metrics.weight_kg.percentile).toBeCloseTo(57.51, 1);
  });

  it('computes both weight and height percentiles when both are present', () => {
    const snap = computeGrowthSnapshot({
      gender: 'M', birthday: dobTwoYears, weightKg: 12.5, heightCm: 87, asOf,
    });
    expect(Object.keys(snap.metrics).sort()).toEqual(['height_cm', 'weight_kg']);
    expect(snap.metrics.height_cm.percentile).toBeCloseTo(41.15, 1);
  });

  it('accepts free-text gender spellings', () => {
    const snap = computeGrowthSnapshot({
      gender: 'Male', birthday: dobTwoYears, weightKg: 12.5, asOf,
    });
    expect(snap).not.toBeNull();
    expect(snap.sex).toBe('M');
  });

  it('returns null when sex is unknown', () => {
    expect(computeGrowthSnapshot({
      gender: 'other', birthday: dobTwoYears, weightKg: 12.5, asOf,
    })).toBeNull();
  });

  it('returns null when DOB is missing', () => {
    expect(computeGrowthSnapshot({
      gender: 'M', birthday: null, weightKg: 12.5, asOf,
    })).toBeNull();
  });

  it('returns null for a child outside the embedded WHO 0-5 table', () => {
    const dobTenYears = new Date(asOf.getTime() - 3650 * 86400000);
    expect(computeGrowthSnapshot({
      gender: 'M', birthday: dobTenYears, weightKg: 30, asOf,
    })).toBeNull();
  });

  it('returns null when no measurements are supplied', () => {
    expect(computeGrowthSnapshot({
      gender: 'M', birthday: dobTwoYears, asOf,
    })).toBeNull();
  });
});
