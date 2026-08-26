import { jest } from '@jest/globals';

const defaultClient = { $queryRawUnsafe: jest.fn() };
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: defaultClient }));

const loggerMock = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
};
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));

const { evaluateCriticalThreshold } = await import(
  '../../services/lab/labCriticalThresholdService.js'
);
const {
  serializeLabCriticalThresholdMetrics,
} = await import('../../observability/labCriticalThresholdMetrics.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const BUNDLE_ID = '10000000-0000-4000-8000-000000000001';
const CATALOG_ID = '20000000-0000-4000-8000-000000000001';
const RULE_ID = '30000000-0000-4000-8000-000000000001';

function result(overrides = {}) {
  return {
    loinc_code: null,
    test_code: 'GLU',
    test_name: 'Glucose',
    value_numeric: 5.8,
    unit: 'mmol/L',
    facility_id: 1,
    specimen_type: 'serum',
    gender: 'female',
    birthday: '1990-01-01',
    is_pregnant: false,
    performed_at: '2026-08-26T12:00:00.000Z',
    ...overrides,
  };
}

function catalogEntry(overrides = {}) {
  return {
    id: CATALOG_ID,
    loinc_code: null,
    test_code: 'GLU',
    test_name: 'Glucose',
    specimen_type: 'serum',
    evaluation_mode: 'numeric_threshold',
    unit: 'mmol/L',
    normalized_unit: 'mmol/l',
    sex: null,
    age_min_days: null,
    age_max_days: null,
    pregnancy_scope: 'all',
    criticality_required: true,
    exemption_reason: null,
    rule_id: RULE_ID,
    reference_low: 3.9,
    reference_high: 7.8,
    critical_low: 2,
    critical_high: 30,
    ...overrides,
  };
}

function governedClient({
  state = { current_revision: 3, entry_count: 1 },
  bundles = [{
    id: BUNDLE_ID,
    facility_id: 1,
    bundle_version: 1,
    catalog_revision: 3,
    lifecycle_status: 'active',
    content_sha256: 'a'.repeat(64),
    effective_from: new Date('2026-01-01T00:00:00.000Z'),
    effective_until: null,
  }],
  entries = [catalogEntry()],
  facilities = [],
} = {}) {
  return {
    $queryRawUnsafe: jest.fn(async (sql) => {
      if (sql.includes('FROM facilities')) return facilities;
      if (sql.includes('FROM lab_threshold_catalog_states')) return state ? [state] : [];
      if (sql.includes('FROM lab_threshold_policy_bundles')) return bundles;
      if (sql.includes('FROM lab_threshold_catalog_entries AS catalog')) return entries;
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    }),
  };
}

function lookupCount(outcome) {
  const prefix = `vhhealth_lab_critical_threshold_lookups_total{outcome="${outcome}"}`;
  const line = serializeLabCriticalThresholdMetrics()
    .split('\n')
    .find((row) => row.startsWith(prefix));
  return line ? Number(line.slice(prefix.length).trim()) : 0;
}

describe('labCriticalThresholdService governed runtime', () => {
  beforeEach(() => loggerMock.warn.mockClear());

  test('uses one signed rule for reference and critical classification with supported conversion', async () => {
    const assessment = await evaluateCriticalThreshold({
      client: governedClient({
        entries: [catalogEntry({
          test_code: 'WBC',
          unit: '10^3/uL',
          normalized_unit: '10^3/ul',
          reference_low: 4,
          reference_high: 11,
          critical_low: 2,
          critical_high: 30,
        })],
      }),
      tenantId: TENANT_ID,
      result: result({
        test_code: 'WBC',
        test_name: 'White blood cells',
        value_numeric: 1000,
        unit: '/uL',
      }),
    });
    expect(assessment).toMatchObject({
      matched: true,
      breached: true,
      breachedSide: 'low',
      breachedValue: 2,
      evaluatedValue: 1,
      referenceLow: 4,
      referenceHigh: 11,
      policyBundleId: BUNDLE_ID,
      policyRuleId: RULE_ID,
      catalogEntryId: CATALOG_ID,
      criticalityStatus: 'critical',
      conversion: 'per_microliter_to_thousands_per_microliter',
    });
  });

  test('turns an incompatible or missing unit into an owned-policy exception assessment', async () => {
    const client = governedClient({
      entries: [catalogEntry({ unit: 'mg/dL', normalized_unit: 'mg/dl' })],
    });
    await expect(evaluateCriticalThreshold({
      client,
      tenantId: TENANT_ID,
      result: result(),
    })).resolves.toMatchObject({
      matched: false,
      breached: false,
      unmatchedReason: 'unit_mismatch',
      criticalityStatus: 'threshold_unavailable',
      policyBundleId: BUNDLE_ID,
      catalogEntryId: CATALOG_ID,
    });
    await expect(evaluateCriticalThreshold({
      client,
      tenantId: TENANT_ID,
      result: result({ unit: null }),
    })).resolves.toMatchObject({ unmatchedReason: 'unit_mismatch' });
  });

  test('makes unresolved demographics and ambiguity explicit without discarding the result', async () => {
    const demographic = await evaluateCriticalThreshold({
      client: governedClient({
        entries: [catalogEntry({ sex: 'M' })],
      }),
      tenantId: TENANT_ID,
      result: result({ gender: 'female' }),
    });
    expect(demographic).toMatchObject({
      matched: false,
      unmatchedReason: 'demographic_mismatch',
    });

    const ambiguous = await evaluateCriticalThreshold({
      client: governedClient({
        entries: [catalogEntry(), catalogEntry({
          id: '20000000-0000-4000-8000-000000000002',
          rule_id: '30000000-0000-4000-8000-000000000002',
        })],
      }),
      tenantId: TENANT_ID,
      result: result(),
    });
    expect(ambiguous).toMatchObject({
      matched: false,
      unmatchedReason: 'ambiguous_policy',
    });
  });

  test('requires explicit signed qualitative exemption for a nonnumeric analyte', async () => {
    const missingExemption = await evaluateCriticalThreshold({
      client: governedClient(),
      tenantId: TENANT_ID,
      result: result({ value_numeric: null, value_text: 'negative' }),
    });
    expect(missingExemption).toMatchObject({
      matched: false,
      unmatchedReason: 'non_numeric_value',
    });

    const exempt = await evaluateCriticalThreshold({
      client: governedClient({
        entries: [catalogEntry({
          test_code: 'CULTURE',
          evaluation_mode: 'qualitative_exempt',
          unit: null,
          normalized_unit: null,
          criticality_required: false,
          exemption_reason: 'No numeric critical threshold applies to this signed qualitative assay.',
          rule_id: null,
          reference_low: null,
          reference_high: null,
          critical_low: null,
          critical_high: null,
        })],
      }),
      tenantId: TENANT_ID,
      result: result({
        test_code: 'CULTURE',
        test_name: 'Culture',
        value_numeric: null,
        value_text: 'negative',
        unit: null,
      }),
    });
    expect(exempt).toMatchObject({
      matched: true,
      breached: false,
      evaluationMode: 'qualitative_exempt',
      criticalityStatus: 'not_applicable',
      policyRuleId: null,
      catalogEntryId: CATALOG_ID,
    });
  });

  test('reports missing catalog and matched outcomes through in-memory metrics only', async () => {
    const beforeUnmatched = lookupCount('unmatched');
    const missing = governedClient({ state: null });
    const assessment = await evaluateCriticalThreshold({
      client: missing,
      tenantId: TENANT_ID,
      result: result(),
    });
    expect(assessment).toMatchObject({ unmatchedReason: 'no_catalog' });
    expect(missing.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(lookupCount('unmatched')).toBe(beforeUnmatched + 1);

    const beforeMatched = lookupCount('matched');
    await expect(evaluateCriticalThreshold({
      client: governedClient(),
      tenantId: TENANT_ID,
      result: result(),
    })).resolves.toMatchObject({ matched: true, breached: false });
    expect(lookupCount('matched')).toBe(beforeMatched + 1);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  test('does not silently choose among multiple active facilities', async () => {
    const assessment = await evaluateCriticalThreshold({
      client: governedClient({
        facilities: [{ id: 1, is_default: false }, { id: 2, is_default: false }],
      }),
      tenantId: TENANT_ID,
      result: result({ facility_id: null }),
    });
    expect(assessment).toMatchObject({
      matched: false,
      unmatchedReason: 'facility_unresolved',
      details: { facility_issue: 'multiple_facilities' },
    });
  });
});
