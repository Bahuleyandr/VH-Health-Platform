import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '22222222-2222-4222-8222-222222222222';

const queryRawUnsafeMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  computeIndicators,
  snapshotIndicators,
  listSnapshots,
  getFrozenPeriodPack,
  INDICATOR_CODES,
} = await import('../../services/quality/nabhIndicatorService.js');

beforeEach(() => {
  jest.clearAllMocks();
  queryRawUnsafeMock.mockReset();
});

describe('NABH indicator tenant authorization', () => {
  it('requires tenant context for compute, snapshot, and list operations', async () => {
    await expect(computeIndicators({ from: '2026-06-01', to: '2026-06-30' })).rejects.toMatchObject({
      statusCode: 403,
      code: 'NABH_TENANT_REQUIRED',
    });
    await expect(snapshotIndicators({ from: '2026-06-01', to: '2026-06-30' })).rejects.toMatchObject({
      statusCode: 403,
      code: 'NABH_TENANT_REQUIRED',
    });
    await expect(listSnapshots()).rejects.toMatchObject({
      statusCode: 403,
      code: 'NABH_TENANT_REQUIRED',
    });
  });

  it('binds tenant_id into every source query while computing indicators', async () => {
    queryRawUnsafeMock.mockResolvedValue([]);

    const pack = await computeIndicators({
      from: '2026-06-01',
      to: '2026-06-30',
      tenantId: TENANT,
    });

    expect(pack.indicators).toHaveLength(INDICATOR_CODES.length);
    expect(pack.indicators.map((indicator) => indicator.code)).toContain('hai_device_rate_per_1000_device_days');
    expect(pack.indicators.map((indicator) => indicator.code)).toContain('patient_satisfaction_positive_pct');
    expect(pack.indicators.map((indicator) => indicator.code)).toContain('rca_completion_pct');
    expect(pack.indicators.map((indicator) => indicator.code)).toContain('cath_dose_outlier_count');
    // 15 queries for 13 indicators: medication_error + hai_rate issue two
    // queries each; cath_dose_outlier issues only its settings read here
    // (empty mock rows → thresholds_pending, fail-closed, no count query).
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(15);
    for (const call of queryRawUnsafeMock.mock.calls) {
      expect(call[0]).toContain('tenant_id = $1::uuid');
      expect(call[1]).toBe(TENANT);
    }

    const incidentSql = queryRawUnsafeMock.mock.calls[9][0];
    expect(incidentSql).toContain('TRIM(incident_type)');
    expect(incidentSql).not.toContain('TRIM(category)');

    const patientDaysCall = queryRawUnsafeMock.mock.calls[7];
    expect(patientDaysCall[0]).toContain('tenant_id = $1::uuid');
    expect(patientDaysCall[0]).toContain('GREATEST(admitted_at, $2::date::timestamptz)');
    expect(patientDaysCall[0]).toContain('LEAST(COALESCE(discharged_at, NOW()), ($3::date + 1)::timestamptz)');
    expect(patientDaysCall.slice(1)).toEqual([TENANT, '2026-06-01', '2026-06-30']);

    const deviceDaysCall = queryRawUnsafeMock.mock.calls[8];
    expect(deviceDaysCall[0]).toContain('FROM device_presence_logs');
    expect(deviceDaysCall[0]).toContain('tenant_id = $1::uuid');
    expect(deviceDaysCall.slice(1)).toEqual([TENANT, '2026-06-01', '2026-06-30']);

    const satisfactionCall = queryRawUnsafeMock.mock.calls[10];
    expect(satisfactionCall[0]).toContain('FROM feedback');
    expect(satisfactionCall[0]).toContain('FROM patient_feedback');
    expect(satisfactionCall.slice(1)).toEqual([TENANT, '2026-06-01', '2026-06-30']);

    const rcaCall = queryRawUnsafeMock.mock.calls[11];
    expect(rcaCall[0]).toContain('FROM quality_incidents');
    expect(rcaCall[0]).toContain("severity IN ('major', 'sentinel')");
    expect(rcaCall.slice(1)).toEqual([TENANT, '2026-06-01', '2026-06-30']);
  });

  it('writes and lists snapshots under the caller tenant', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ ama: 0, total: 0 }])
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([{ n: 0, p50: null, p90: null }])
      .mockResolvedValueOnce([{ n: 0, p50: null, p90: null }])
      .mockResolvedValueOnce([{ n: 0, p50: null, p90: null }])
      .mockResolvedValueOnce([{ n: 0 }])
      .mockResolvedValueOnce([{ patient_days: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ positive: 0, total: 0, average_rating: null }])
      .mockResolvedValueOnce([{ completed: 0, required: 0 }])
      .mockResolvedValue([{ id: 1 }]);

    const snapshot = await snapshotIndicators(
      { from: '2026-06-01', to: '2026-06-30' },
      { tenantId: TENANT, actorUid: ACTOR },
    );

    expect(snapshot.snapshot_saved).toBe(INDICATOR_CODES.length);
    // Compute issues 15 reads (see above; the NL13-P1f cath indicators consume
    // the catch-all mock rows) before the per-indicator snapshot INSERTs.
    const insertCalls = queryRawUnsafeMock.mock.calls.slice(15);
    for (const call of insertCalls) {
      expect(call[0]).toContain('INSERT INTO nabh_indicator_snapshots');
      expect(call[0]).toContain('(tenant_id, period_start');
      expect(call[1]).toBe(TENANT);
    }

    queryRawUnsafeMock.mockClear();
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    await listSnapshots({ tenantId: TENANT, from: '2026-06-01', to: '2026-06-30' });

    const [listSql, ...listParams] = queryRawUnsafeMock.mock.calls[0];
    expect(listSql).toContain('FROM nabh_indicator_snapshots WHERE tenant_id = $1::uuid');
    expect(listParams).toEqual([TENANT, '2026-06-01', '2026-06-30']);
  });

  it('maps frozen snapshot Decimal values to plain JSON for assessor packs', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      period_start: new Date('2026-06-01T00:00:00.000Z'),
      period_end: new Date('2026-06-30T00:00:00.000Z'),
      indicator_code: 'patient_satisfaction_positive_pct',
      label: 'Patient satisfaction positive responses',
      value: { toNumber: () => 87.5 },
      numerator: { toNumber: () => 7 },
      denominator: { toNumber: () => 8 },
      unit: '%',
      details: { average_rating: { toNumber: () => 4.6 } },
      computed_at: new Date('2026-07-01T10:00:00.000Z'),
    }]);

    const pack = await getFrozenPeriodPack({
      from: '2026-06-01',
      to: '2026-06-30',
      tenantId: TENANT,
    });

    expect(pack.indicators[0].value).toBe(87.5);
    expect(pack.indicators[0].details.average_rating).toBe(4.6);
    expect(pack.export_contract.canonical_format_status).toBe('pending_assessor_format');
    expect(pack.evidence_attachment.control_code).toBe('NABH_AUDIT_EXPORT');
  });
});
