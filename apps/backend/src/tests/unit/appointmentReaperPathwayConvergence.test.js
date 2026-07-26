import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const createManyMock = jest.fn();
const setTenantTxMock = jest.fn();
const runWithSuperAdminMock = jest.fn();
const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();

const tx = {
  $queryRawUnsafe: queryRawUnsafeMock,
  appointment_status_history: {
    createMany: createManyMock,
  },
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../lib/tenantContext.js', () => ({
  runWithSuperAdmin: runWithSuperAdminMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
  },
}));

const { reapStaleScheduledVisits } = await import(
  '../../services/appointment/appointmentReaperService.js'
);

const ACTIVE_TENANT = '10000000-0000-4000-8000-000000000001';
const SHADOW_TENANT = '20000000-0000-4000-8000-000000000001';
const OFF_TENANT = '30000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  createManyMock.mockReset();
  setTenantTxMock.mockReset();
  runWithSuperAdminMock.mockReset();
  loggerInfoMock.mockReset();
  loggerWarnMock.mockReset();
  runWithSuperAdminMock.mockImplementation(callback => callback());
  setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(tx));
  createManyMock.mockResolvedValue({ count: 0 });
});

test('ACTIVE mode fails closed without mutating the stale appointment', async () => {
  queryRawUnsafeMock.mockResolvedValueOnce([{
    id: 11,
    tenant_id: ACTIVE_TENANT,
    pathway_mode: 'active',
  }]);

  await expect(reapStaleScheduledVisits()).resolves.toEqual({
    reaped: 0,
    skippedActive: 1,
  });

  expect(setTenantTxMock).toHaveBeenCalledWith(
    null,
    expect.any(Function),
    { superAdmin: true },
  );
  expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('FOR UPDATE OF appointment');
  expect(queryRawUnsafeMock.mock.calls[0][0]).toContain('FOR SHARE OF tenant');
  expect(queryRawUnsafeMock.mock.calls[0][2]).toBe('op_contact_to_recovery');
  expect(createManyMock).not.toHaveBeenCalled();
  expect(loggerWarnMock).toHaveBeenCalledWith(
    'Visit reaper left ACTIVE-pathway appointments unchanged',
    expect.objectContaining({ skipped: 1 }),
  );
});

test('OFF and SHADOW modes retain legacy MISSED bookkeeping with exact tenant history', async () => {
  queryRawUnsafeMock
    .mockResolvedValueOnce([
      { id: 21, tenant_id: SHADOW_TENANT, pathway_mode: 'shadow' },
      { id: 22, tenant_id: ACTIVE_TENANT, pathway_mode: 'active' },
      { id: 23, tenant_id: OFF_TENANT, pathway_mode: 'off' },
    ])
    .mockResolvedValueOnce([
      { id: 21, tenant_id: SHADOW_TENANT },
      { id: 23, tenant_id: OFF_TENANT },
    ]);
  createManyMock.mockResolvedValueOnce({ count: 2 });

  await expect(reapStaleScheduledVisits({ graceMinutes: 90 })).resolves.toEqual({
    reaped: 2,
    skippedActive: 1,
  });

  expect(queryRawUnsafeMock).toHaveBeenCalledTimes(2);
  expect(queryRawUnsafeMock.mock.calls[1][0]).toContain("SET status = 'MISSED'");
  expect(queryRawUnsafeMock.mock.calls[1][1]).toEqual([21, 23]);
  expect(createManyMock).toHaveBeenCalledWith({
    data: [
      expect.objectContaining({
        tenant_id: SHADOW_TENANT,
        appointment_id: 21,
        from_status: 'SCHEDULED',
        to_status: 'MISSED',
      }),
      expect.objectContaining({
        tenant_id: OFF_TENANT,
        appointment_id: 23,
        from_status: 'SCHEDULED',
        to_status: 'MISSED',
      }),
    ],
    skipDuplicates: false,
  });
  expect(loggerInfoMock).toHaveBeenCalledWith(
    expect.stringContaining('marked 2 stale SCHEDULED appointment(s) as MISSED'),
  );
});

test('a mode-read failure rolls back without a status or history write', async () => {
  const failure = new Error('tenant settings unavailable');
  queryRawUnsafeMock.mockRejectedValueOnce(failure);

  await expect(reapStaleScheduledVisits()).rejects.toBe(failure);

  expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
  expect(createManyMock).not.toHaveBeenCalled();
  expect(loggerInfoMock).not.toHaveBeenCalled();
});
