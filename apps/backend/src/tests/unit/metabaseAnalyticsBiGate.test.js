// src/tests/unit/metabaseAnalyticsBiGate.test.js
//
// Analytics-BI gate resolution in metabaseService (wt/bi-app, slate C2):
//   * fail-closed ORDER — a missing METABASE_URL/METABASE_EMBED_SECRET env
//     refuses BEFORE the tenant flag is even consulted, so gate-off and
//     unconfigured-env behave identically from the caller's side (refusal);
//   * the tenant flag alone can never open the gate (env ANDs first);
//   * listDashboards marks every entry unavailable while the gate is off;
//   * getAnalyticsBiGate reports the two layers separately for the admin
//     page's "not enabled" vs "not configured" states.
//
// Env vars are deleted before import — metabaseService reads them at call
// time, so both states are exercisable in one file.

import { jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

delete process.env.METABASE_URL;
delete process.env.METABASE_EMBED_SECRET;
process.env.METABASE_DASH_DAILY_OPS = '42';

const queryRawUnsafeMock = jest.fn();
const __prismaDefaultMock = { $queryRawUnsafe: queryRawUnsafeMock };
// Same factory shape as dashboardTenantAuthorization.test.js — the loaded
// dashboards/tenant service graph imports these named helpers too.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

const getAnalyticsBiSettingsMock = jest.fn(async () => ({ enabled: false }));
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getAnalyticsBiSettings: getAnalyticsBiSettingsMock,
}));

const metabase = await import('../../services/dashboards/metabaseService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function dashboardRow(overrides = {}) {
  return {
    dashboard_key: 'daily_ops',
    title: 'Daily Operations Snapshot',
    description: 'Executive huddle metrics',
    metabase_env_var: 'METABASE_DASH_DAILY_OPS',
    dataset_keys: ['fct_encounters'],
    required_params: ['tenant_id'],
    embed_roles: ['ADMIN', 'SUPER_ADMIN'],
    owner_role: 'MEDICAL_SUPERINTENDENT',
    status: 'active',
    certification_status: 'certified',
    last_certified_at: '2026-07-09',
    display_order: 10,
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env.METABASE_URL;
  delete process.env.METABASE_EMBED_SECRET;
  queryRawUnsafeMock.mockReset();
  queryRawUnsafeMock.mockResolvedValue([dashboardRow()]);
  getAnalyticsBiSettingsMock.mockClear();
  getAnalyticsBiSettingsMock.mockImplementation(async () => ({ enabled: false }));
});

describe('buildEmbedUrl fail-closed ordering', () => {
  it('unconfigured env refuses with 400 before consulting the tenant flag', async () => {
    getAnalyticsBiSettingsMock.mockImplementation(async () => ({ enabled: true }));

    await expect(metabase.buildEmbedUrl({
      key: 'daily_ops', tenantId: TENANT_ID, role: 'ADMIN',
    })).rejects.toMatchObject({ statusCode: 400 });

    expect(getAnalyticsBiSettingsMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('env configured but tenant gate off refuses 403 ANALYTICS_BI_TENANT_DISABLED', async () => {
    process.env.METABASE_URL = 'https://metabase.example.test';
    process.env.METABASE_EMBED_SECRET = 'unit-test-metabase-secret';

    await expect(metabase.buildEmbedUrl({
      key: 'daily_ops', tenantId: TENANT_ID, role: 'ADMIN',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'ANALYTICS_BI_TENANT_DISABLED',
    });
    expect(getAnalyticsBiSettingsMock).toHaveBeenCalledWith(TENANT_ID);
    // Refusal happens before any catalog read.
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('both layers on signs the embed with the server tenant param', async () => {
    process.env.METABASE_URL = 'https://metabase.example.test';
    process.env.METABASE_EMBED_SECRET = 'unit-test-metabase-secret';
    getAnalyticsBiSettingsMock.mockImplementation(async () => ({ enabled: true }));

    const { url } = await metabase.buildEmbedUrl({
      key: 'daily_ops', tenantId: TENANT_ID, role: 'ADMIN', ttlSeconds: 120,
    });
    const token = url.match(/\/embed\/dashboard\/([^#]+)/)?.[1];
    const payload = jwt.verify(token, 'unit-test-metabase-secret');
    expect(payload.resource).toEqual({ dashboard: 42 });
    expect(payload.params.tenant_id).toBe(TENANT_ID);
  });
});

describe('listDashboards under the gate', () => {
  it('marks every entry unavailable while the gate is off, without dropping rows', async () => {
    process.env.METABASE_URL = 'https://metabase.example.test';
    process.env.METABASE_EMBED_SECRET = 'unit-test-metabase-secret';

    const closed = await metabase.listDashboards({ role: 'ADMIN', tenantId: TENANT_ID });
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ key: 'daily_ops', available: false });

    getAnalyticsBiSettingsMock.mockImplementation(async () => ({ enabled: true }));
    const open = await metabase.listDashboards({ role: 'ADMIN', tenantId: TENANT_ID });
    expect(open[0]).toMatchObject({ key: 'daily_ops', available: true });
  });

  it('gate open still leaves an id-less dashboard unavailable (per-dashboard config layer)', async () => {
    process.env.METABASE_URL = 'https://metabase.example.test';
    process.env.METABASE_EMBED_SECRET = 'unit-test-metabase-secret';
    getAnalyticsBiSettingsMock.mockImplementation(async () => ({ enabled: true }));
    queryRawUnsafeMock.mockResolvedValue([
      dashboardRow({ dashboard_key: 'pharmacy_ops', metabase_env_var: 'METABASE_DASH_PHARMACY_OPS' }),
    ]);

    const rows = await metabase.listDashboards({ role: 'ADMIN', tenantId: TENANT_ID });
    expect(rows[0]).toMatchObject({ key: 'pharmacy_ops', available: false });
  });
});

describe('getAnalyticsBiGate layer reporting', () => {
  it('reports env and tenant layers separately, effective as the AND', async () => {
    expect(await metabase.getAnalyticsBiGate(TENANT_ID)).toEqual({
      envConfigured: false, tenantEnabled: false, effective: false,
    });

    getAnalyticsBiSettingsMock.mockImplementation(async () => ({ enabled: true }));
    expect(await metabase.getAnalyticsBiGate(TENANT_ID)).toEqual({
      envConfigured: false, tenantEnabled: true, effective: false,
    });

    process.env.METABASE_URL = 'https://metabase.example.test';
    process.env.METABASE_EMBED_SECRET = 'unit-test-metabase-secret';
    expect(await metabase.getAnalyticsBiGate(TENANT_ID)).toEqual({
      envConfigured: true, tenantEnabled: true, effective: true,
    });
  });
});
