/**
 * Phase F2 — clinicalAssessmentService unit tests.
 * Pain / fall-risk / growth-chart record + list flows.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

const {
  listFallRiskAssessments,
  listGrowthCharts,
  listPainAssessments,
  recordFallRiskAssessment,
  recordGrowthChart,
  recordPainAssessment,
  __testing__,
} = await import('../../services/clinical/clinicalAssessmentService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queryUnsafeMock.mockReset();
});

describe('Pain assessments', () => {
  it('rejects unknown scale', async () => {
    await expect(recordPainAssessment({
      tenantId: TENANT, patientUid: PATIENT, scale: 'magic', score: 5,
    })).rejects.toThrow(/scale must be one of/);
  });

  it('rejects out-of-range score', async () => {
    await expect(recordPainAssessment({
      tenantId: TENANT, patientUid: PATIENT, scale: 'NRS', score: 12,
    })).rejects.toThrow(/score must be <= 10/);
  });

  it('inserts an NRS=8 record', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, scale: 'NRS', score: 8 }]);
    const row = await recordPainAssessment({
      tenantId: TENANT, patientUid: PATIENT, scale: 'NRS', score: 8,
      location: 'right lower quadrant', characterStr: 'sharp', context: 'movement',
      interventions: ['paracetamol 1g PO'],
    });
    expect(row.id).toBe(1);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/INSERT INTO pain_assessments/);
  });

  it('lists with min_score filter', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listPainAssessments({ tenantId: TENANT, patientUid: PATIENT, minScore: 7 });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/score >= \$\d/);
    expect(sql).toMatch(/patient_uid = \$\d/);
  });

  it('list degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "pain_assessments" does not exist'));
    expect(await listPainAssessments({ tenantId: TENANT })).toEqual({ assessments: [], count: 0 });
  });
});

describe('Fall-risk assessments', () => {
  it('rejects unknown scale', async () => {
    await expect(recordFallRiskAssessment({
      tenantId: TENANT, patientUid: PATIENT, scale: 'magic',
      score: 50, riskLevel: 'high',
    })).rejects.toThrow(/scale must be one of/);
  });

  it('rejects unknown risk_level', async () => {
    await expect(recordFallRiskAssessment({
      tenantId: TENANT, patientUid: PATIENT, scale: 'MORSE',
      score: 50, riskLevel: 'extreme',
    })).rejects.toThrow(/risk_level must be one of/);
  });

  it('inserts Morse high-risk record + factors JSON', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, scale: 'MORSE', score: 65, risk_level: 'high',
    }]);
    const row = await recordFallRiskAssessment({
      tenantId: TENANT, patientUid: PATIENT,
      scale: 'MORSE', score: 65, riskLevel: 'high',
      factors: { history_of_falls: true, secondary_diagnosis: true, gait: 'weak' },
      interventions: ['bed rails up', 'low bed', 'fall risk band'],
    });
    expect(row.risk_level).toBe('high');
  });

  it('lists by risk_level', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listFallRiskAssessments({ tenantId: TENANT, riskLevel: 'very_high' });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/risk_level = \$\d/);
  });
});

describe('Growth charts', () => {
  it('rejects unknown reference_dataset', async () => {
    await expect(recordGrowthChart({
      tenantId: TENANT, patientUid: PATIENT, referenceDataset: 'magic', ageInDays: 365,
    })).rejects.toThrow(/reference_dataset must be one of/);
  });

  it('rejects negative ageInDays', async () => {
    await expect(recordGrowthChart({
      tenantId: TENANT, patientUid: PATIENT, referenceDataset: 'WHO_0_5', ageInDays: -1,
    })).rejects.toThrow(/age_in_days must be >= 0/);
  });

  it('inserts a WHO_0_5 record with classification', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, reference_dataset: 'WHO_0_5', classification: 'stunting',
    }]);
    const row = await recordGrowthChart({
      tenantId: TENANT, patientUid: PATIENT,
      referenceDataset: 'WHO_0_5', ageInDays: 540,
      heightCm: 78, weightKg: 9.2, headCircumferenceCm: 46,
      percentiles: { length_for_age: 3, weight_for_age: 5 },
      zScores: { length_for_age: -2.1, weight_for_age: -1.6 },
      classification: 'stunting',
    });
    expect(row.classification).toBe('stunting');
  });

  it('list filters by reference_dataset', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listGrowthCharts({ tenantId: TENANT, referenceDataset: 'IAP_5_18' });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/reference_dataset = \$\d/);
  });

  it('list degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "growth_charts" does not exist'));
    expect(await listGrowthCharts({ tenantId: TENANT })).toEqual({ charts: [], count: 0 });
  });
});

describe('exported enums', () => {
  it('declare Indian growth chart datasets', () => {
    expect(__testing__.GROWTH_DATASETS).toContain('IAP_5_18');
    expect(__testing__.GROWTH_DATASETS).toContain('WHO_0_5');
    expect(__testing__.GROWTH_DATASETS).toContain('FENTON');
  });
  it('declare standard fall-risk scales', () => {
    expect(__testing__.FALL_SCALES).toEqual(
      expect.arrayContaining(['MORSE', 'HENDRICH_II', 'HUMPTY_DUMPTY']),
    );
  });
});
