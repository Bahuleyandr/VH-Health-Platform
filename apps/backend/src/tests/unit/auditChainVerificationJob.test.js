// Platform audit 2026-06-18 §3 — scheduled audit-chain verifier.
//
// No-DB unit test for runAuditChainVerification (src/utils/scheduler.js): the
// cron body that recomputes the tamper-evident chain for every active tenant
// and raises a LOUD alert on any break. Proves:
//   * an intact chain → no alert, no error log;
//   * a tampered chain → error log + sendSecurityWebhook('AUDIT_CHAIN_TAMPERED');
//   * a verifier exception for one tenant is swallowed (sweep continues, other
//     tenants still checked) — the scheduler must never crash on a bad chain;
//   * it fans out over every active tenant plus the default-tenant floor;
//   * tenant-discovery failure degrades to the default tenant only.
//
// scheduler.js skips all cron registration under NODE_ENV==='test', so importing
// it here registers nothing and leaks no timers.

import { jest } from '@jest/globals';

const verifyAuditChainMock = jest.fn();
const sendSecurityWebhookMock = jest.fn();
const queryRawUnsafeMock = jest.fn();
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.unstable_mockModule('../../services/clinical/documentIntegrityService.js', () => ({
  verifyAuditChain: verifyAuditChainMock,
}));
jest.unstable_mockModule('../../utils/securityWebhook.js', () => ({
  sendSecurityWebhook: sendSecurityWebhookMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: loggerMock,
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: jest.fn(() => ({ open: false, consecutiveFailures: 0 })),
  default: { $queryRawUnsafe: queryRawUnsafeMock },
  setTenantTx: async (_t, fn) => fn({ $queryRawUnsafe: queryRawUnsafeMock }),
  setTenant: async (_t, fn) => fn({ $queryRawUnsafe: queryRawUnsafeMock }),
}));
// tenantContext is imported by scheduler.js at module load.
jest.unstable_mockModule('../../lib/tenantContext.js', () => ({
  runWithSuperAdmin: async (fn) => fn(),
  runInTenantContext: async (_t, fn) => fn(),
  getCurrentTenantId: () => null,
  getCurrentTenantContext: () => null,
  isSuperAdminContext: () => false,
}));

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';

const { runAuditChainVerification } = await import('../../utils/scheduler.js');

beforeEach(() => {
  verifyAuditChainMock.mockReset();
  sendSecurityWebhookMock.mockReset();
  queryRawUnsafeMock.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
});

function intact(tenantId) {
  return { tenant_id: tenantId, checked: 5, breaks: 0, intact: true, first_break_seq: null, first_break_id: null };
}
function broken(tenantId, breaks = 1, seq = 7, id = 'break-id') {
  return { tenant_id: tenantId, checked: 9, breaks, intact: false, first_break_seq: seq, first_break_id: id };
}

describe('runAuditChainVerification', () => {
  test('intact chain → no webhook, no error log, tenant counted', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]); // no extra active tenants
    verifyAuditChainMock.mockResolvedValueOnce(intact(DEFAULT_TENANT));

    const r = await runAuditChainVerification();

    expect(r).toEqual({ tenantsChecked: 1, breaks: 0, alerts: 0 });
    expect(sendSecurityWebhookMock).not.toHaveBeenCalled();
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(verifyAuditChainMock).toHaveBeenCalledWith({ tenantId: DEFAULT_TENANT });
  });

  test('tampered chain → error log + security webhook with the break detail', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    verifyAuditChainMock.mockResolvedValueOnce(broken(DEFAULT_TENANT, 2, 42, 'aaaa-bbbb'));

    const r = await runAuditChainVerification();

    expect(r).toEqual({ tenantsChecked: 1, breaks: 2, alerts: 1 });

    expect(loggerMock.error).toHaveBeenCalledWith(
      'AUDIT CHAIN TAMPER DETECTED',
      expect.objectContaining({ tenant_id: DEFAULT_TENANT, breaks: 2, first_break_seq: 42 }),
    );
    expect(sendSecurityWebhookMock).toHaveBeenCalledTimes(1);
    const [eventType, details] = sendSecurityWebhookMock.mock.calls[0];
    expect(eventType).toBe('AUDIT_CHAIN_TAMPERED');
    expect(details.tenantId).toBe(DEFAULT_TENANT);
    expect(details.reason).toMatch(/tamper detected/i);
  });

  test('a verifier exception for one tenant does NOT abort the sweep', async () => {
    // Two active tenants on top of the default. The first throws; the others
    // must still be verified and the function must resolve (not reject).
    const T2 = '00000000-0000-4000-8000-0000000000a2';
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: T2 }]);
    verifyAuditChainMock
      .mockRejectedValueOnce(new Error('connection reset')) // DEFAULT_TENANT throws
      .mockResolvedValueOnce(intact(T2));                    // T2 still checked

    const r = await runAuditChainVerification();

    // DEFAULT errored (not counted as checked), T2 checked intact.
    expect(r.tenantsChecked).toBe(1);
    expect(r.alerts).toBe(0);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining(`verification FAILED for tenant ${DEFAULT_TENANT}`),
      expect.any(Error),
    );
    // Sweep continued to T2.
    expect(verifyAuditChainMock).toHaveBeenCalledWith({ tenantId: T2 });
  });

  test('fans out over every active tenant plus the default-tenant floor', async () => {
    const T2 = '00000000-0000-4000-8000-0000000000a2';
    const T3 = '00000000-0000-4000-8000-0000000000a3';
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: T2 }, { id: T3 }]);
    verifyAuditChainMock.mockResolvedValue(intact('x'));

    const r = await runAuditChainVerification();

    expect(r.tenantsChecked).toBe(3);
    const verifiedTenants = verifyAuditChainMock.mock.calls.map((c) => c[0].tenantId);
    expect(verifiedTenants).toEqual(expect.arrayContaining([DEFAULT_TENANT, T2, T3]));
  });

  test('the default tenant is not double-counted if it is also in the active list', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ id: DEFAULT_TENANT }]);
    verifyAuditChainMock.mockResolvedValue(intact(DEFAULT_TENANT));

    const r = await runAuditChainVerification();

    expect(r.tenantsChecked).toBe(1); // de-duplicated
    expect(verifyAuditChainMock).toHaveBeenCalledTimes(1);
  });

  test('tenant-discovery failure degrades to the default tenant only', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('tenants table gone'));
    verifyAuditChainMock.mockResolvedValueOnce(intact(DEFAULT_TENANT));

    const r = await runAuditChainVerification();

    expect(r.tenantsChecked).toBe(1);
    expect(verifyAuditChainMock).toHaveBeenCalledWith({ tenantId: DEFAULT_TENANT });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('tenant discovery failed'),
    );
  });
});
