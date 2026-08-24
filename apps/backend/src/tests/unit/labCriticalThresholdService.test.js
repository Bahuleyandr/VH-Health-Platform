import { jest } from '@jest/globals';

const defaultClient = { $queryRawUnsafe: jest.fn() };
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: defaultClient }));

const loggerMock = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
};
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));

const {
  assertConfiguredCriticalAnalytesNumeric,
  evaluateCriticalThreshold,
} = await import('../../services/lab/labCriticalThresholdService.js');
const {
  serializeLabCriticalThresholdMetrics,
} = await import('../../observability/labCriticalThresholdMetrics.js');

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

// A zero-row threshold lookup used to be indistinguishable from "this analyte
// has no critical limit", which is how a tenant that can NEVER raise a critical
// lab alert stayed invisible (docs/ROADMAP.md, "Explicitly parked"). These pin
// the two halves of the fix: the outcome is observable, and observing it never
// changes what evaluateCriticalThreshold returns or makes it throw.
describe('labCriticalThresholdService — an unconfigured tenant is observable', () => {
  function lookupCount(outcome) {
    const prefix = `vhhealth_lab_critical_threshold_lookups_total{outcome="${outcome}"}`;
    const line = serializeLabCriticalThresholdMetrics()
      .split('\n')
      .find((row) => row.startsWith(prefix));
    return line ? Number(line.slice(prefix.length).trim()) : 0;
  }

  beforeEach(() => {
    loggerMock.warn.mockClear();
  });

  // THE REGRESSION GUARD. An earlier revision probed a second statement here
  // to separate 'this analyte has no limit' from 'this tenant has none at
  // all'. Every production caller passes its OPEN TRANSACTION as `client`, and
  // a failed statement aborts that transaction in Postgres — the swallowed
  // rejection then surfaced as 25P02 on the next write and the lab result was
  // not recorded. Observability on a clinical write path must add no
  // statement, so this asserts the call count, not just the absence of a
  // throw: a mocked rejection cannot reproduce a real aborted transaction, so
  // 'it didn't throw' would have passed while production still broke.
  test('counts an unmatched lookup and issues NO second statement', async () => {
    const before = lookupCount('unmatched');
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValueOnce([]), // nothing matched
    };

    await expect(evaluateCriticalThreshold({
      client,
      tenantId: TENANT_ID,
      result: result({ test_code: 'K', loinc_code: '2823-3', value_numeric: 7.4 }),
    })).resolves.toEqual({ matched: false, breached: false, evaluatedValue: 7.4 });

    expect(client.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(lookupCount('unmatched')).toBe(before + 1);
  });

  test('the unmatched path neither warns nor throws', async () => {
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValueOnce([]),
    };

    await expect(evaluateCriticalThreshold({
      client,
      tenantId: TENANT_ID,
      result: result({ test_code: 'LIPASE', value_numeric: 42 }),
    })).resolves.toEqual({ matched: false, breached: false, evaluatedValue: 42 });

    // The tenant-wide question is answered by the canary check, on its own
    // connection — not by warning per result on the clinical path.
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  test('counts a matched lookup and issues no extra statement', async () => {
    const before = lookupCount('matched');
    const client = {
      $queryRawUnsafe: jest.fn().mockResolvedValueOnce([threshold()]),
    };

    await expect(evaluateCriticalThreshold({
      client,
      tenantId: TENANT_ID,
      result: result(),
    })).resolves.toMatchObject({ matched: true, breached: false });

    expect(client.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(lookupCount('matched')).toBe(before + 1);
  });
});
