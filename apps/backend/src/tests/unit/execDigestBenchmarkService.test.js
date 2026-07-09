import { jest } from '@jest/globals';

const readOnlyQueryRawUnsafeMock = jest.fn();
const txQueryRawUnsafeMock = jest.fn();
const setTenantTxMock = jest.fn();

const txClient = { $queryRawUnsafe: txQueryRawUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  prismaReadOnly: { $queryRawUnsafe: readOnlyQueryRawUnsafeMock },
  setTenantTx: setTenantTxMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => {
    if (!tenantId) throw new Error('tenant required');
    return tenantId;
  },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  buildExecDigestSummary,
  buildInternalBenchmarkPack,
  queueExecDigestDelivery,
  __testing__,
} = await import('../../services/analytics/execDigestBenchmarkService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER_UID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  readOnlyQueryRawUnsafeMock.mockReset();
  txQueryRawUnsafeMock.mockReset();
  setTenantTxMock.mockReset().mockImplementation(async (_tenantId, fn) => fn(txClient));
});

describe('exec digest summary', () => {
  it('shapes mart aggregate rows into Decimal-safe in-app/push digest payloads', async () => {
    readOnlyQueryRawUnsafeMock
      .mockResolvedValueOnce([
        { encounter_type: 'opd', encounter_count: 12n },
        { encounter_type: 'ipd', encounter_count: 4 },
        { encounter_type: 'er', encounter_count: 2 },
      ])
      .mockResolvedValueOnce([{
        invoices: 7,
        gross_billed: { toNumber: () => 125000.5 },
        collected: { toNumber: () => 92000 },
        outstanding: { toNumber: () => 33000.5 },
      }])
      .mockResolvedValueOnce([{ cases_completed: 5, utilization_pct: { toNumber: () => 76.4 } }])
      .mockResolvedValueOnce([{
        midnight_census: 44,
        discharges_out: 6,
        occupancy_pct: { toNumber: () => 88.25 },
      }])
      .mockResolvedValueOnce([{ high_alerts: 1, critical_alerts: 0 }]);

    const digest = await buildExecDigestSummary({
      tenantId: TENANT,
      digestDate: '2026-07-08',
    });

    expect(readOnlyQueryRawUnsafeMock.mock.calls[0][0]).toMatch(/analytics_marts\.fct_encounters/);
    expect(readOnlyQueryRawUnsafeMock.mock.calls[0][0]).toMatch(/tenant_id = \$1::uuid/);
    expect(digest.summary).toMatchObject({
      digest_date: '2026-07-08',
      delivery_channels: ['inapp', 'push'],
      delivery_channel_policy: 'in_app_push_locked',
      source: 'analytics_marts',
      metrics: {
        volumes: { opd: 12, ipd: 4, er: 2 },
        bed_flow: { midnight_census: 44, occupancy_pct: 88.3, discharges_out: 6 },
        ot_utilization: { cases_completed: 5, utilization_pct: 76.4 },
        revenue: { invoices: 7, gross_billed: 125000.5 },
      },
    });
    expect(JSON.stringify(digest.summary)).not.toContain('"toNumber"');
    expect(JSON.stringify(digest.summary)).not.toContain('"s"');
  });

  it('queues only in-app plus push delivery records', async () => {
    readOnlyQueryRawUnsafeMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{}]);
    txQueryRawUnsafeMock
      .mockResolvedValueOnce([{ id: 1001 }])
      .mockResolvedValueOnce([{ id: 2001, status: 'PENDING' }])
      .mockResolvedValueOnce([{ id: '3001', status: 'queued', delivery_channels: ['inapp', 'push'] }]);

    const result = await queueExecDigestDelivery({
      tenantId: TENANT,
      subscription: { id: '9', target_role: 'ADMIN', metric_bundle: 'executive_core' },
      recipient: { id: 42, uid: USER_UID, phone: '+919000000001', role: 'ADMIN' },
      digestDate: '2026-07-08',
    });

    const notificationInsert = txQueryRawUnsafeMock.mock.calls[0];
    const outboxInsert = txQueryRawUnsafeMock.mock.calls[1];
    const deliveryInsert = txQueryRawUnsafeMock.mock.calls[2];

    expect(notificationInsert[0]).toMatch(/INSERT INTO notifications/);
    expect(notificationInsert[0]).toContain("'exec_digest'");
    expect(outboxInsert[0]).toMatch(/INSERT INTO notification_outbox/);
    expect(outboxInsert[0]).toContain("'exec_digest'");
    expect(deliveryInsert[0]).toContain("ARRAY['inapp','push']::text[]");
    expect(JSON.parse(outboxInsert[6])).toMatchObject({
      channels: ['inapp', 'push'],
      channel_policy: 'in_app_push_locked',
    });
    expect(JSON.parse(outboxInsert[6]).channels).not.toContain('email');
    expect(JSON.parse(outboxInsert[6]).channels).not.toContain('whatsapp');
    expect(result.delivery.delivery_channels).toEqual(['inapp', 'push']);
  });
});

describe('internal benchmark pack', () => {
  it('suppresses small cells and keeps packs internal-only', () => {
    const metrics = __testing__.buildBenchmarkMetrics({
      revenueRows: [
        {
          department: 'Cardiology',
          invoices: 3,
          gross_billed: { toNumber: () => 90000 },
          collected: { toNumber: () => 50000 },
          outstanding: { toNumber: () => 40000 },
        },
        {
          department: 'Radiology',
          invoices: 9,
          gross_billed: { toNumber: () => 180000 },
          collected: { toNumber: () => 160000 },
          outstanding: { toNumber: () => 20000 },
        },
      ],
      encounterRows: [{ encounter_type: 'opd', encounters: 4 }],
    });

    expect(metrics).toMatchObject({
      visibility: 'internal',
      suppression_policy: 'min_cell_locked',
      minimum_cell_threshold: 5,
      suppressed_cells_count: 2,
    });
    expect(metrics.datasets.department_revenue[0]).toMatchObject({
      department: 'Cardiology',
      invoices: 3,
      gross_billed: null,
      sample_visible: false,
    });
    expect(metrics.datasets.department_revenue[1]).toMatchObject({
      department: 'Radiology',
      invoices: 9,
      gross_billed: 180000,
      sample_visible: true,
    });
  });

  it('persists benchmark exports with locked internal visibility', async () => {
    readOnlyQueryRawUnsafeMock
      .mockResolvedValueOnce([{ department: 'Cardiology', invoices: 6, gross_billed: 1000 }])
      .mockResolvedValueOnce([{ encounter_type: 'opd', encounters: 6 }]);
    txQueryRawUnsafeMock.mockResolvedValueOnce([{
      id: '77',
      visibility: 'internal',
      external_sharing_allowed: false,
      minimum_cell_threshold: 5,
      suppression_policy: 'min_cell_locked',
      suppressed_cells_count: 0,
      metrics_payload: { ok: true },
      suppression_metadata: {},
    }]);

    const pack = await buildInternalBenchmarkPack({
      tenantId: TENANT,
      periodStart: '2026-07-01',
      periodEnd: '2026-07-08',
      generatedBy: USER_UID,
    });

    const insertCall = txQueryRawUnsafeMock.mock.calls[0];
    expect(readOnlyQueryRawUnsafeMock.mock.calls[0][0]).toMatch(/analytics_marts\.fct_revenue/);
    expect(readOnlyQueryRawUnsafeMock.mock.calls[0][0]).toMatch(/tenant_id = \$1::uuid/);
    expect(insertCall[0]).toContain("'internal'");
    expect(insertCall[0]).toContain('false');
    expect(insertCall[0]).toContain("'not_requested'");
    expect(pack).toMatchObject({
      visibility: 'internal',
      external_sharing_allowed: false,
      minimum_cell_threshold: 5,
      suppression_policy: 'min_cell_locked',
    });
  });
});

describe('migration 466 lock lines', () => {
  it('locks digest channels and benchmark external sharing at the DDL layer', async () => {
    const fs = await import('node:fs/promises');
    const migration = await fs.readFile(
      new URL('../../migrations/466_exec_digest_benchmark_pack.sql', import.meta.url),
      'utf8',
    );

    expect(migration).toMatch(/delivery_channel_policy = 'in_app_push_locked'/);
    expect(migration).toMatch(/delivery_channels @> ARRAY\['inapp','push'\]::TEXT\[\]/);
    expect(migration).toMatch(/visibility = 'internal'/);
    expect(migration).toMatch(/external_sharing_allowed = FALSE/);
    expect(migration).toMatch(/minimum_cell_threshold >= 5/);
  });
});
