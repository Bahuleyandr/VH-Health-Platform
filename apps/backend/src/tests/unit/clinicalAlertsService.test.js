import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (t) => t,
  resolveTenantOrThrow: (req) => req?.tenantId,
}));

const { listRecentAlerts } = await import('../../services/clinical/clinicalAlertsService.js');

const TID = '00000000-0000-4000-8000-000000000001';

describe('listRecentAlerts', () => {
  beforeEach(() => jest.clearAllMocks());

  test('queries clinical_alerts tenant-scoped/windowed/ordered/limited and normalizes rows', async () => {
    queryRawUnsafe.mockResolvedValueOnce([
      { id: 7, patient_id: 42, vital_name: 'SpO2', vital_value: '83.00', severity: 'CRITICAL', message: 'low O2', acknowledged: false, created_at: '2026-06-29T10:00:00.000Z' },
    ]);
    const out = await listRecentAlerts({ tenantId: TID, hours: 8, limit: 100 });

    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...params] = queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/FROM clinical_alerts/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(sql).toMatch(/make_interval\(hours => \$2::int\)/);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(sql).toMatch(/LIMIT \$3::int/);
    expect(params).toEqual([TID, 8, 100]);

    expect(out).toEqual([{
      kind: 'vital-anomaly', id: 7, patientId: '42', vitalName: 'SpO2',
      value: 83, unit: null, severity: 'CRITICAL', message: 'low O2',
      acknowledged: false, at: '2026-06-29T10:00:00.000Z',
    }]);
  });

  test('applies defaults (8h / 100) and clamps to maxes (72h / 200)', async () => {
    queryRawUnsafe.mockResolvedValue([]);
    await listRecentAlerts({ tenantId: TID });
    expect(queryRawUnsafe.mock.calls[0].slice(1)).toEqual([TID, 8, 100]);
    await listRecentAlerts({ tenantId: TID, hours: 999, limit: 9999 });
    expect(queryRawUnsafe.mock.calls[1].slice(1)).toEqual([TID, 72, 200]);
  });
});
