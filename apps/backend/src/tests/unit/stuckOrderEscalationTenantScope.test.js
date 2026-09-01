// The stuck-order sweep must do exactly ONE tenant's work, using the context
// the scheduler's fan-out establishes.
//
// It previously called runWithSuperAdmin, which replaced that context with a
// cross-tenant one and then re-read `tenants` and looped the whole fleet. That
// made every fan-out iteration repeat every tenant's work, and once the
// pharmacy advance lane lands its RESTRICTIVE explicit_tenant_context policy,
// a cross-tenant context is fail-closed on pharmacy_orders and users - so those
// reads return zero rows silently and the sweep escalates nothing while
// reporting success.
//
// These assertions fail if either half regresses: the fleet re-read comes back,
// or the tenant context stops being required.
import { jest } from '@jest/globals';

const TENANT_A = '00000000-0000-4000-8000-000000000001';

const queryRawUnsafe = jest.fn(async (sql) => {
  const text = String(sql);
  // Nothing stuck, and no admins to alert: the shape of the rows does not
  // matter here, only which queries are issued and with which tenant.
  if (text.includes('FROM tenants')) return [{ id: TENANT_A }, { id: 'other-tenant' }];
  return [];
});

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe, $executeRawUnsafe: jest.fn(async () => 0) },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { escalateStuckOrders } = await import('../../utils/notifications/stuckOrderEscalation.js');
const { runInTenantContext } = await import('../../lib/tenantContext.js');

beforeEach(() => {
  queryRawUnsafe.mockClear();
});

describe('stuck-order escalation is scoped to one tenant', () => {
  it('refuses to run without a tenant context instead of sweeping the fleet', async () => {
    await expect(escalateStuckOrders()).rejects.toThrow(/requires a tenant context/i);
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('never re-reads the tenants table', async () => {
    await runInTenantContext(TENANT_A, () => escalateStuckOrders());
    const fleetReads = queryRawUnsafe.mock.calls.filter(
      ([sql]) => String(sql).includes('FROM tenants'),
    );
    expect(fleetReads).toHaveLength(0);
  });

  it('passes the ambient tenant to every scoped query', async () => {
    await runInTenantContext(TENANT_A, () => escalateStuckOrders());
    expect(queryRawUnsafe).toHaveBeenCalled();
    const scoped = queryRawUnsafe.mock.calls.filter(
      ([sql]) => String(sql).includes('tenant_id = $1::uuid'),
    );
    expect(scoped.length).toBeGreaterThan(0);
    for (const call of scoped) {
      expect(call[1]).toBe(TENANT_A);
    }
  });

  it('honours an explicit tenant argument over the ambient context', async () => {
    await runInTenantContext(TENANT_A, () => escalateStuckOrders('11111111-1111-4111-8111-111111111111'));
    const scoped = queryRawUnsafe.mock.calls.filter(
      ([sql]) => String(sql).includes('tenant_id = $1::uuid'),
    );
    expect(scoped.length).toBeGreaterThan(0);
    for (const call of scoped) {
      expect(call[1]).toBe('11111111-1111-4111-8111-111111111111');
    }
  });
});
