import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

process.env.METABASE_URL = 'https://metabase.example.test';
process.env.METABASE_EMBED_SECRET = 'unit-test-metabase-secret';
process.env.METABASE_DASH_DAILY_OPS = '42';
process.env.METABASE_DASH_REVENUE_PAYER_MIX = '77';

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
const catalog = await import('../../services/dashboards/analyticsCatalogService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function dashboardRow(overrides = {}) {
  return {
    dashboard_key: 'daily_ops',
    title: 'Daily Operations Snapshot',
    description: 'Executive huddle metrics',
    metabase_env_var: 'METABASE_DASH_DAILY_OPS',
    dataset_keys: ['fct_encounters', 'mart_bed_flow_daily'],
    required_params: ['tenant_id'],
    embed_roles: ['ADMIN', 'SUPER_ADMIN', 'CMO'],
    owner_role: 'MEDICAL_SUPERINTENDENT',
    status: 'active',
    certification_status: 'certified',
    last_certified_at: '2026-07-09',
    display_order: 10,
    ...overrides,
  };
}

function datasetRow(overrides = {}) {
  return {
    dataset_key: 'dim_patient',
    display_name: 'Patient demographic dimension',
    dbt_relation: 'analytics_marts.dim_patient',
    grain: 'one row per pseudonymous patient',
    refresh_cadence: 'nightly dbt after warehouse replication',
    source_domain: 'patient_demographics',
    owner_role: 'DATA_PROTECTION_OFFICER',
    certification_status: 'internal_only',
    tenant_boundary_mode: 'pseudonymous_tenant_id',
    phi_class: 'pseudonymous_phi',
    min_cell_threshold: 20,
    allowed_roles: ['ADMIN', 'SUPER_ADMIN', 'CMO'],
    export_policy: 'blocked',
    deprecation_status: 'active',
    description: 'Age-banded pseudonymous demographic dimension',
    ...overrides,
  };
}

function fieldRow(overrides = {}) {
  return {
    dataset_key: 'dim_patient',
    field_name: 'patient_uid',
    display_label: 'Patient pseudonym',
    semantic_type: 'pseudonymous_identifier',
    aggregation_behavior: 'none',
    phi_class: 'pseudonymous_phi',
    hidden_by_default: true,
    allowed_filter: false,
    backend_drilldown_only: true,
    description: 'Hidden from BI authors',
    ...overrides,
  };
}

describe('dashboard tenant scoping', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    queryRawUnsafeMock.mockImplementation(async (sql, ...params) => {
      const text = String(sql);
      if (text.includes('analytics_dashboard_catalog')) {
        const rows = [
          dashboardRow(),
          dashboardRow({
            dashboard_key: 'revenue_payer_mix',
            title: 'Revenue and Payer Mix',
            metabase_env_var: 'METABASE_DASH_REVENUE_PAYER_MIX',
            dataset_keys: ['fct_revenue', 'mart_payer_mix_monthly'],
            embed_roles: ['ADMIN', 'SUPER_ADMIN', 'FINANCE_INCHARGE'],
            owner_role: 'FINANCE_INCHARGE',
            display_order: 40,
          }),
        ];
        if (text.includes('WHERE dashboard_key = $1')) {
          return rows.filter((row) => row.dashboard_key === params[0]);
        }
        return rows;
      }
      if (text.includes('analytics_dataset_catalog')) return [datasetRow()];
      if (text.includes('analytics_dataset_fields')) return [fieldRow()];
      return [];
    });
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

  it('adds the server tenant to Metabase embed JWT params', async () => {
    const { url } = await metabase.buildEmbedUrl({
      key: 'daily_ops',
      tenantId: TENANT_ID,
      role: 'ADMIN',
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

  it('rejects client-supplied Metabase tenant params', async () => {
    await expect(metabase.buildEmbedUrl({
      key: 'daily_ops',
      tenantId: TENANT_ID,
      role: 'ADMIN',
      params: {
        tenant_id: '99999999-9999-4999-8999-999999999999',
      },
      ttlSeconds: 120,
    })).rejects.toThrow('Tenant scope is server-managed');

    await expect(metabase.buildEmbedUrl({
      key: 'daily_ops',
      tenantId: TENANT_ID,
      role: 'ADMIN',
      params: {
        tenantId: '99999999-9999-4999-8999-999999999999',
      },
      ttlSeconds: 120,
    })).rejects.toThrow('Tenant scope is server-managed');
  });

  it('clamps Metabase embed TTLs and reports the effective TTL', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    const high = await metabase.buildEmbedUrl({
      key: 'daily_ops',
      tenantId: TENANT_ID,
      role: 'ADMIN',
      ttlSeconds: 999999,
    });
    const highPayload = jwt.verify(
      high.url.match(/\/embed\/dashboard\/([^#]+)/)?.[1],
      process.env.METABASE_EMBED_SECRET
    );
    expect(high.ttlSeconds).toBe(86400);
    expect(highPayload.exp).toBe(1_700_000_000 + 86400);

    const low = await metabase.buildEmbedUrl({
      key: 'daily_ops',
      tenantId: TENANT_ID,
      role: 'ADMIN',
      ttlSeconds: 10,
    });
    const lowPayload = jwt.verify(
      low.url.match(/\/embed\/dashboard\/([^#]+)/)?.[1],
      process.env.METABASE_EMBED_SECRET
    );
    expect(low.ttlSeconds).toBe(60);
    expect(lowPayload.exp).toBe(1_700_000_000 + 60);
  });

  it('keeps patient_uid hidden and backend-drilldown only in the governed catalog', async () => {
    const datasets = await catalog.listDatasetCatalog();
    const patient = datasets.find((dataset) => dataset.key === 'dim_patient');
    const patientUid = patient?.fields.find((field) => field.fieldName === 'patient_uid');

    expect(patient).toMatchObject({
      phiClass: 'pseudonymous_phi',
      exportPolicy: 'blocked',
    });
    expect(patientUid).toMatchObject({
      hiddenByDefault: true,
      allowedFilter: false,
      backendDrilldownOnly: true,
    });
  });

  it('filters curated dashboard embeds by catalog role policy', async () => {
    await expect(metabase.buildEmbedUrl({
      key: 'revenue_payer_mix',
      tenantId: TENANT_ID,
      role: 'QUALITY_OFFICER',
    })).rejects.toThrow('Dashboard is not available for this role');

    const allowed = await metabase.buildEmbedUrl({
      key: 'revenue_payer_mix',
      tenantId: TENANT_ID,
      role: 'FINANCE_INCHARGE',
    });
    expect(allowed.datasetKeys).toEqual(['fct_revenue', 'mart_payer_mix_monthly']);
  });
});
