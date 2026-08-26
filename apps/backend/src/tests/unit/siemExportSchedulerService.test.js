import { jest } from '@jest/globals';

const captureMock = jest.fn();
const enqueueMock = jest.fn();
const dispatchMock = jest.fn();

// tenantService (transitively imported for requireTenantId) pulls in
// lib/prisma.js → @prisma/client; mock the singleton so the client is not
// required at import time (sibling unit-test convention).
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
  setTenantTx: jest.fn(),
  setTenant: jest.fn(),
  prismaReadOnly: { $queryRawUnsafe: jest.fn() },
}));

jest.unstable_mockModule('../../services/security/siemExportService.js', () => ({
  capturePendingSecurityAuditEvents: captureMock,
  enqueueSiemDeliveries: enqueueMock,
  dispatchSiemDeliveries: dispatchMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const svc = await import('../../services/security/siemExportSchedulerService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  captureMock.mockReset();
  enqueueMock.mockReset();
  dispatchMock.mockReset();
  delete process.env.SIEM_EXPORT_SCHEDULER_ENABLED;
});

test('isSiemExportSchedulerEnvEnabled reflects the env kill switch', () => {
  expect(svc.isSiemExportSchedulerEnvEnabled()).toBe(false);
  process.env.SIEM_EXPORT_SCHEDULER_ENABLED = 'true';
  expect(svc.isSiemExportSchedulerEnvEnabled()).toBe(true);
});

test('runSiemExportForTenant short-circuits when no active target', async () => {
  captureMock.mockResolvedValue({ captured_count: 3 });
  enqueueMock.mockResolvedValue({ targets: 0, enqueued: 0, skipped_reason: 'no_active_siem_export_target' });
  const r = await svc.runSiemExportForTenant({ tenantId: TENANT });
  expect(r.captured).toBe(3);
  expect(r.skipped_reason).toBe('no_active_siem_export_target');
  expect(dispatchMock).not.toHaveBeenCalled();
});

test('runSiemExportForTenant captures → enqueues → dispatches when a target is active', async () => {
  captureMock.mockResolvedValue({ captured_count: 2 });
  enqueueMock.mockResolvedValue({ targets: 1, enqueued: 2 });
  dispatchMock.mockResolvedValue({ dispatched: 2, succeeded: 2, failed: 0, dead: 0 });
  const r = await svc.runSiemExportForTenant({ tenantId: TENANT });
  expect(r).toMatchObject({ captured: 2, enqueued: 2, dispatched: 2, succeeded: 2 });
  expect(captureMock).toHaveBeenCalledWith({ tenantId: TENANT, batchSize: 100 });
  expect(dispatchMock).toHaveBeenCalledTimes(1);
});
