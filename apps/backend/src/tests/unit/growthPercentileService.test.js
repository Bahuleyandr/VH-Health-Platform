// Unit tests for growth-percentile helpers that wire pediatric percentile
// computation into vitals and growth-chart flows.

import prisma from '../../lib/prisma.js';
import {
  normaliseSex,
  ageInDaysFrom,
  computePercentile,
  computeGrowthSnapshot,
  clearGrowthReferenceCache,
} from '../../services/clinical/growthPercentileService.js';

const TEST_SOURCE_VERSION = 'jest-nl5-p4';

async function clearTestLmsRows() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM growth_reference_lms WHERE source_version = $1`,
    TEST_SOURCE_VERSION,
  ).catch(() => {});
  clearGrowthReferenceCache();
}

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

describe('computePercentile', () => {
  beforeEach(async () => {
    await clearTestLmsRows();
  });

  it('uses the embedded WHO approximation when reference LMS rows are absent', async () => {
    const result = await computePercentile({
      sex: 'M', ageInDays: 730, metric: 'weight_kg', value: 12.5,
    });
    expect(result.source).toBe('WHO_0_5_approx');
    expect(result.reference_dataset).toBe('WHO_0_5');
    expect(result.percentile).toBeCloseTo(57.51, 1);
  });

  it('prefers imported WHO LMS rows and marks the authoritative source', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO growth_reference_lms
         (dataset, sex, metric, age_days, l, m, s, source_version)
       VALUES
         ('WHO_0_5', 'M', 'weight_kg', 700, 0, 13.0, 0.10, $1),
         ('WHO_0_5', 'M', 'weight_kg', 760, 0, 13.0, 0.10, $1)
       ON CONFLICT (dataset, sex, metric, age_days) DO UPDATE SET
         l = EXCLUDED.l, m = EXCLUDED.m, s = EXCLUDED.s,
         source_version = EXCLUDED.source_version,
         updated_at = NOW()`,
      TEST_SOURCE_VERSION,
    );
    clearGrowthReferenceCache();

    const result = await computePercentile({
      sex: 'M', ageInDays: 730, metric: 'weight_kg', value: 13.0,
    });
    expect(result.source).toBe('WHO_0_5');
    expect(result.source_version).toBe(TEST_SOURCE_VERSION);
    expect(result.percentile).toBeCloseTo(50, 1);
    expect(result.z_score).toBeCloseTo(0, 3);
  });

  it('uses IAP 5-18 LMS rows for older pediatric cohorts', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO growth_reference_lms
         (dataset, sex, metric, age_days, l, m, s, source_version)
       VALUES
         ('IAP_5_18', 'F', 'height_cm', 3650, 1, 140.0, 0.04, $1),
         ('IAP_5_18', 'F', 'height_cm', 4380, 1, 148.0, 0.04, $1)
       ON CONFLICT (dataset, sex, metric, age_days) DO UPDATE SET
         l = EXCLUDED.l, m = EXCLUDED.m, s = EXCLUDED.s,
         source_version = EXCLUDED.source_version,
         updated_at = NOW()`,
      TEST_SOURCE_VERSION,
    );
    clearGrowthReferenceCache();

    const result = await computePercentile({
      sex: 'F', ageInDays: 4015, metric: 'height_cm', value: 144.0,
    });
    expect(result.source).toBe('IAP_5_18');
    expect(result.reference_dataset).toBe('IAP_5_18');
    expect(result.percentile).toBeCloseTo(50, 1);
  });
});

describe('computeGrowthSnapshot', () => {
  const asOf = new Date('2026-05-14T00:00:00Z');
  const dobTwoYears = new Date(asOf.getTime() - 730 * 86400000);

  it('computes a weight percentile for a child with sex + DOB on file', async () => {
    const snap = await computeGrowthSnapshot({
      gender: 'M', birthday: dobTwoYears, weightKg: 12.5, asOf,
    });
    expect(snap).not.toBeNull();
    expect(snap.sex).toBe('M');
    expect(snap.age_in_days).toBe(730);
    expect(snap.reference_dataset).toBe('WHO_0_5');
    expect(snap.metrics.weight_kg.percentile).toBeCloseTo(57.51, 1);
  });

  it('computes both weight and height percentiles when both are present', async () => {
    const snap = await computeGrowthSnapshot({
      gender: 'M', birthday: dobTwoYears, weightKg: 12.5, heightCm: 87, asOf,
    });
    expect(Object.keys(snap.metrics).sort()).toEqual(['height_cm', 'weight_kg']);
    expect(snap.metrics.height_cm.percentile).toBeCloseTo(41.15, 1);
  });

  it('uses imported IAP rows in the snapshot for school-age children', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO growth_reference_lms
         (dataset, sex, metric, age_days, l, m, s, source_version)
       VALUES
         ('IAP_5_18', 'M', 'bmi', 3650, 0, 16.0, 0.08, $1),
         ('IAP_5_18', 'M', 'bmi', 4380, 0, 18.0, 0.08, $1)
       ON CONFLICT (dataset, sex, metric, age_days) DO UPDATE SET
         l = EXCLUDED.l, m = EXCLUDED.m, s = EXCLUDED.s,
         source_version = EXCLUDED.source_version,
         updated_at = NOW()`,
      TEST_SOURCE_VERSION,
    );
    clearGrowthReferenceCache();
    const dobElevenYears = new Date(asOf.getTime() - 4015 * 86400000);

    const snap = await computeGrowthSnapshot({
      gender: 'M', birthday: dobElevenYears, bmi: 17.0, asOf,
    });
    expect(snap.reference_dataset).toBe('IAP_5_18');
    expect(snap.metrics.bmi.source).toBe('IAP_5_18');
    expect(snap.metrics.bmi.percentile).toBeCloseTo(50, 1);
  });

  it('accepts free-text gender spellings', async () => {
    const snap = await computeGrowthSnapshot({
      gender: 'Male', birthday: dobTwoYears, weightKg: 12.5, asOf,
    });
    expect(snap).not.toBeNull();
    expect(snap.sex).toBe('M');
  });

  it('returns null when sex is unknown', async () => {
    await expect(computeGrowthSnapshot({
      gender: 'other', birthday: dobTwoYears, weightKg: 12.5, asOf,
    })).resolves.toBeNull();
  });

  it('returns null when DOB is missing', async () => {
    await expect(computeGrowthSnapshot({
      gender: 'M', birthday: null, weightKg: 12.5, asOf,
    })).resolves.toBeNull();
  });

  it('returns null for a child outside available reference data', async () => {
    const dobTenYears = new Date(asOf.getTime() - 3650 * 86400000);
    await expect(computeGrowthSnapshot({
      gender: 'M', birthday: dobTenYears, weightKg: 30, asOf,
    })).resolves.toBeNull();
  });

  it('returns null when no measurements are supplied', async () => {
    await expect(computeGrowthSnapshot({
      gender: 'M', birthday: dobTwoYears, asOf,
    })).resolves.toBeNull();
  });
});

afterAll(async () => {
  await clearTestLmsRows();
  await prisma.$disconnect().catch(() => {});
});
