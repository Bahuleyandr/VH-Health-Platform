import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

process.env.METABASE_URL = 'https://metabase.example.test';
process.env.METABASE_EMBED_SECRET = 'unit-test-metabase-secret';
process.env.METABASE_DASH_DAILY_OPS = '42';

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

const snapshot = await import('../../services/dashboards/snapshotService.js');
const metabase = await import('../../services/dashboards/metabaseService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

describe('dashboard tenant scoping', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    queryRawUnsafeMock.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('builds daily ops from tenant-scoped source tables, not global BI views', async () => {
    await snapshot.getDailyOpsSnapshot({ tenantId: TENANT_ID });

    const call = queryRawUnsafeMock.mock.calls[0];
    expect(call[0]).not.toMatch(/FROM bi_/);
    expect(call[0]).toMatch(/FROM appointments[\s\S]*tenant_id = \$1::uuid/);
    expect(call[0]).toMatch(/FROM lab_critical_alerts[\s\S]*tenant_id = \$1::uuid/);
    expect(call[0]).toMatch(/FROM billing_payments[\s\S]*tenant_id = \$1::uuid/);
    expect(call[1]).toBe(TENANT_ID);
  });

  it('binds OPD daily snapshots to tenant_id before optional filters', async () => {
    await snapshot.getOpdDaily({
      tenantId: TENANT_ID,
      from: '2026-06-01',
      to: '2026-06-11',
      doctor_id: 12,
    });

    const call = queryRawUnsafeMock.mock.calls[0];
    expect(call[0]).not.toMatch(/bi_opd_daily/);
    expect(call[0]).toMatch(/tenant_id = \$1::uuid/);
    expect(call[0]).toMatch(/doctor_id = \$4::int/);
    expect(call.slice(1)).toEqual([TENANT_ID, '2026-06-01', '2026-06-11', 12]);
  });

  it('binds payer-mix snapshots to tenant_id and clamps months', async () => {
    await snapshot.getPayerMixMonthly({ tenantId: TENANT_ID, months: '999' });

    const call = queryRawUnsafeMock.mock.calls[0];
    expect(call[0]).not.toMatch(/bi_payer_mix_monthly/);
    expect(call[0]).toMatch(/FROM tpa_claims c/);
    expect(call[0]).toMatch(/c\.tenant_id = \$1::uuid/);
    expect(call.slice(1)).toEqual([TENANT_ID, '60']);
  });

  it('adds the server tenant to Metabase embed JWT params', () => {
    const { url } = metabase.buildEmbedUrl({
      key: 'daily_ops',
      tenantId: TENANT_ID,
      params: {
        department: 'lab',
      },
      ttlSeconds: 120,
    });

    const token = url.match(/\/embed\/dashboard\/([^#]+)/)?.[1];
    const payload = jwt.verify(token, process.env.METABASE_EMBED_SECRET);

    expect(payload.resource).toEqual({ dashboard: 42 });
    expect(payload.params).toMatchObject({
      tenant_id: TENANT_ID,
      department: 'lab',
    });
  });

  it('rejects client-supplied Metabase tenant params', () => {
    expect(() => metabase.buildEmbedUrl({
      key: 'daily_ops',
      tenantId: TENANT_ID,
      params: {
        tenant_id: '99999999-9999-4999-8999-999999999999',
      },
      ttlSeconds: 120,
    })).toThrow('Tenant scope is server-managed');

    expect(() => metabase.buildEmbedUrl({
      key: 'daily_ops',
      tenantId: TENANT_ID,
      params: {
        tenantId: '99999999-9999-4999-8999-999999999999',
      },
      ttlSeconds: 120,
    })).toThrow('Tenant scope is server-managed');
  });

  it('clamps Metabase embed TTLs and reports the effective TTL', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    const high = metabase.buildEmbedUrl({
      key: 'daily_ops',
      tenantId: TENANT_ID,
      ttlSeconds: 999999,
    });
    const highPayload = jwt.verify(
      high.url.match(/\/embed\/dashboard\/([^#]+)/)?.[1],
      process.env.METABASE_EMBED_SECRET
    );
    expect(high.ttlSeconds).toBe(86400);
    expect(highPayload.exp).toBe(1_700_000_000 + 86400);

    const low = metabase.buildEmbedUrl({
      key: 'daily_ops',
      tenantId: TENANT_ID,
      ttlSeconds: 10,
    });
    const lowPayload = jwt.verify(
      low.url.match(/\/embed\/dashboard\/([^#]+)/)?.[1],
      process.env.METABASE_EMBED_SECRET
    );
    expect(low.ttlSeconds).toBe(60);
    expect(lowPayload.exp).toBe(1_700_000_000 + 60);
  });
});
