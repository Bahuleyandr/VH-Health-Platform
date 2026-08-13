import fs from 'node:fs';
import path from 'node:path';
import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const logger = { warn: jest.fn(), error: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: logger }));

const { runForEachTenant } = await import('../../utils/tenantFanout.js');

const scheduler = fs.readFileSync(
  path.resolve(process.cwd(), 'src/utils/scheduler.js'),
  'utf8',
);

describe('interface-engine scheduler wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('runs a locked tenant fanout with bounded dispatch inputs', () => {
    expect(scheduler).toContain(
      "registerCron('* * * * *', withJobLock('interface-engine-outbound-dispatch'",
    );
    expect(scheduler).toContain(
      "runForEachTenant('interface-engine-outbound-dispatch', tenantId => (",
    );
    expect(scheduler).toContain(
      'dispatchOutboundMessages({ tenantId, batchSize: 25, maxInFlight: 100 })',
    );
    expect(scheduler).toContain(
      "), { strict: true });",
    );
  });

  test('strict fanout rejects discovery fallback instead of reporting default-only success', async () => {
    queryRawUnsafe.mockRejectedValueOnce(new Error('tenant discovery unavailable'));
    const dispatch = jest.fn();

    await expect(runForEachTenant(
      'interface-engine-outbound-dispatch',
      dispatch,
      { strict: true },
    )).rejects.toThrow('tenant discovery unavailable');
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('strict fanout visits healthy tenants but rejects the aggregate on a tenant failure', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{ id: 'tenant-a' }, { id: 'tenant-b' }]);
    const dispatch = jest.fn(async (tenantId) => {
      if (tenantId === 'tenant-a') throw new Error('dispatch failed');
    });

    await expect(runForEachTenant(
      'interface-engine-outbound-dispatch',
      dispatch,
      { strict: true },
    )).rejects.toThrow('1 tenant run(s) failed');
    expect(dispatch).toHaveBeenCalledWith('tenant-b');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('interface-engine-outbound-dispatch: failed for tenant tenant-a'),
      expect.any(Error),
    );
  });
});
