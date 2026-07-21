import { jest } from '@jest/globals';

const defaultClient = { $queryRawUnsafe: jest.fn() };
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: defaultClient }));

const {
  assertConfiguredCriticalAnalytesNumeric,
  evaluateCriticalThreshold,
} = await import('../../services/lab/labCriticalThresholdService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function result(overrides = {}) {
  return {
    loinc_code: null,
    test_code: 'GLU',
    value_numeric: 5.8,
    unit: 'mmol/L',
    ...overrides,
  };
}

function threshold(overrides = {}) {
  return {
    id: 1,
    loinc_code: null,
    test_code: 'GLU',
    critical_low: 2,
    critical_high: 30,
    test_name: 'Configured analyte',
    unit: 'mmol/L',
    applies_to: 'all',
    match_rank: 1,
    ...overrides,
  };
}

describe('labCriticalThresholdService', () => {
  test('keeps raw and evaluated units coherent for the supported CBC conversion', async () => {
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        threshold({ unit: '10^3/uL', critical_low: 2, critical_high: 30 }),
      ]),
    };
    const assessment = await evaluateCriticalThreshold({
      client,
      tenantId: TENANT_ID,
      result: result({ test_code: 'WBC', value_numeric: 1000, unit: '/uL' }),
    });
    expect(assessment).toMatchObject({
      matched: true,
      breached: true,
      breachedSide: 'low',
      breachedValue: 2,
      evaluatedValue: 1,
      thresholdId: 1,
      thresholdTestCode: 'GLU',
      thresholdLoincCode: null,
      thresholdUnit: '10^3/uL',
      thresholdAppliesTo: 'all',
      conversion: 'per_microliter_to_thousands_per_microliter',
    });
  });

  test('rejects explicit GLU mmol/L against an mg/dL threshold instead of comparing raw', async () => {
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        threshold({ unit: 'mg/dL', critical_low: 50, critical_high: 500 }),
      ]),
    };
    await expect(evaluateCriticalThreshold({
      client,
      tenantId: TENANT_ID,
      result: result(),
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_CRITICAL_POLICY_MISMATCH',
      details: expect.objectContaining({ reasons: ['threshold_unit'] }),
    });
  });

  test('rejects a missing result unit when the threshold declares one', async () => {
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([threshold({ unit: 'mg/dL' })]),
    };
    await expect(evaluateCriticalThreshold({
      client,
      tenantId: TENANT_ID,
      result: result({ unit: null }),
    })).rejects.toMatchObject({
      code: 'LAB_CRITICAL_POLICY_MISMATCH',
      details: expect.objectContaining({ reasons: ['threshold_unit'] }),
    });
  });

  test('fails closed when population-specific thresholds cannot be resolved', async () => {
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        threshold({ id: 2, applies_to: 'adult' }),
      ]),
    };
    await expect(evaluateCriticalThreshold({
      client,
      tenantId: TENANT_ID,
      result: result({ unit: 'mmol/L' }),
    })).rejects.toMatchObject({
      code: 'LAB_CRITICAL_POLICY_MISMATCH',
      details: expect.objectContaining({ reasons: ['population_scope'] }),
    });
  });

  test('fails closed on duplicate best-rank universal policies', async () => {
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        threshold({ id: 3 }),
        threshold({ id: 4 }),
      ]),
    };
    await expect(evaluateCriticalThreshold({
      client,
      tenantId: TENANT_ID,
      result: result({ unit: 'mmol/L' }),
    })).rejects.toMatchObject({
      code: 'LAB_CRITICAL_POLICY_MISMATCH',
      details: expect.objectContaining({ reasons: ['threshold_ambiguous'] }),
    });
  });

  test('blocks a nonnumeric configured analyte but permits an unconfigured qualitative result', async () => {
    const client = { $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 9 }]) };
    await expect(assertConfiguredCriticalAnalytesNumeric({
      client,
      tenantId: TENANT_ID,
      results: [result({ value_numeric: null })],
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'NON_NUMERIC_FOR_CRITICAL_THRESHOLD',
    });

    client.$queryRawUnsafe.mockResolvedValueOnce([]);
    await expect(assertConfiguredCriticalAnalytesNumeric({
      client,
      tenantId: TENANT_ID,
      results: [{ test_code: 'CULTURE', value_numeric: null }],
    })).resolves.toBeUndefined();
  });
});
