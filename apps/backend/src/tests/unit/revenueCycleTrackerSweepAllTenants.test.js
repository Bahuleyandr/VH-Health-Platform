// Platform audit §3 (Revenue cycle) — per-tenant fan-out for the revenue-cycle
// tracker cron.
//
// No-DB unit test for runRevenueCycleSweepAllTenants
// (src/services/billing/revenueCycleTrackerService.js): the cron entry must run
// the sweep once PER tenant, not just the default. Previously the scheduler
// called runRevenueCycleSweep({}) and resolveTenantId(undefined) collapsed to
// DEFAULT_TENANT_ID, so every other tenant's denied-PA / appeal cases were
// silently never tracked.
//
// Proves (mirroring escalateStuckOrders' per-tenant fan-out + the audit-chain
// verifier's no-DB unit precedent):
//   * it discovers tenants via SELECT id FROM tenants and runs the sweep once
//     per tenant id — observed through the tenant-scoped prisma call each sweep
//     makes (its WHERE tenant_id = $1::uuid param carries the specific tenant);
//   * one tenant's sweep failure does NOT abort the others (fault isolation);
//   * empty tenants list → no per-tenant work, no throw;
//   * tenant-discovery failure is swallowed (the scheduler tick never crashes).
//
// ESM module namespaces are read-only, so we cannot jest.spyOn the sibling
// runRevenueCycleSweep export. Instead we mock the prisma singleton: the FIRST
// $queryRawUnsafe call is the `SELECT id FROM tenants` discovery; each
// per-tenant sweep's first DB touch is loadPriorAuths' tenant-scoped SELECT,
// whose $1 param is the tenant id. Returning [] there short-circuits the sweep
// cleanly while still proving the fan-out reached that tenant. This exercises
// the real sweep code path — no DB.

import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
  setTenant: async (_t, fn) => fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: loggerMock,
}));

const T1 = '00000000-0000-4000-8000-000000000001';
const T2 = '00000000-0000-4000-8000-0000000000a2';
const T3 = '00000000-0000-4000-8000-0000000000a3';

const { runRevenueCycleSweepAllTenants } = await import(
  '../../services/billing/revenueCycleTrackerService.js'
);

// Helper: the SQL strings the sweep issues. We only need to distinguish the
// tenant-discovery query from the per-tenant prior-auth load.
const isTenantDiscovery = (sql) => /FROM\s+tenants/i.test(sql);
const isPriorAuthLoad = (sql) => /clinical_ai_prior_auth_requests/i.test(sql);

// Collect the tenant ids that the per-tenant sweeps were actually scoped to,
// from loadPriorAuths' `WHERE tenant_id = $1::uuid` param.
function sweptTenantIds() {
  return queryRawUnsafeMock.mock.calls
    .filter((c) => isPriorAuthLoad(c[0]))
    .map((c) => c[1]);
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
});

describe('runRevenueCycleSweepAllTenants', () => {
  test('exports a fan-out entrypoint', () => {
    expect(typeof runRevenueCycleSweepAllTenants).toBe('function');
  });

  test('runs the sweep once PER tenant (not just the default)', async () => {
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (isTenantDiscovery(sql)) return [{ id: T1 }, { id: T2 }, { id: T3 }];
      if (isPriorAuthLoad(sql)) return []; // no PA rows → sweep short-circuits
      return [];
    });

    const r = await runRevenueCycleSweepAllTenants();

    // A per-tenant sweep ran for each discovered tenant id.
    const swept = sweptTenantIds();
    expect(swept).toHaveLength(3);
    expect(swept).toEqual(expect.arrayContaining([T1, T2, T3]));

    // Aggregate roll-up across tenants (all empty here).
    expect(r.tenantsSwept).toBe(3);
    expect(r.processed).toBe(0);
    expect(r.errors).toBe(0);
  });

  test("one tenant's failure does NOT abort the others (fault isolation)", async () => {
    queryRawUnsafeMock.mockImplementation(async (sql, p1) => {
      if (isTenantDiscovery(sql)) return [{ id: T1 }, { id: T2 }, { id: T3 }];
      if (isPriorAuthLoad(sql)) {
        if (p1 === T2) throw new Error('connection reset'); // T2's sweep blows up
        return [];
      }
      return [];
    });

    const r = await runRevenueCycleSweepAllTenants();

    // All three tenants were attempted despite T2 throwing.
    const swept = sweptTenantIds();
    expect(swept).toEqual(expect.arrayContaining([T1, T2, T3]));

    // The failure is surfaced and folded into the aggregate error count; the
    // fan-out still completed every tenant.
    expect(r.tenantsSwept).toBe(3);
    expect(r.errors).toBeGreaterThanOrEqual(1);
  });

  test('empty tenants list → no per-tenant sweeps, no throw', async () => {
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (isTenantDiscovery(sql)) return [];
      return [];
    });

    const r = await runRevenueCycleSweepAllTenants();

    expect(sweptTenantIds()).toHaveLength(0);
    expect(r.tenantsSwept).toBe(0);
    expect(r.processed).toBe(0);
    expect(r.errors).toBe(0);
  });

  test('tenant-discovery failure is swallowed (sweep never crashes the scheduler)', async () => {
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (isTenantDiscovery(sql)) throw new Error('tenants table gone');
      return [];
    });

    const r = await runRevenueCycleSweepAllTenants();

    expect(sweptTenantIds()).toHaveLength(0);
    expect(loggerMock.error).toHaveBeenCalled();
    expect(r.tenantsSwept).toBe(0);
  });
});
