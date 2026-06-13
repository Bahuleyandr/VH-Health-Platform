import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryUnsafeMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const { dailyCollection } = await import('../../services/billing/billingV2Service.js');

afterEach(() => {
  queryUnsafeMock.mockReset();
  jest.useRealTimers();
});

describe('billingV2Service.dailyCollection IST date handling', () => {
  it('defaults reports to the IST collection date', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-21T20:00:00Z'));
    queryUnsafeMock.mockResolvedValue([]);

    const result = await dailyCollection();

    expect(result.date).toBe('2026-05-22');
    expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
    expect(queryUnsafeMock.mock.calls.map((call) => call[1])).toEqual([
      '2026-05-22',
      '2026-05-22',
      '2026-05-22',
    ]);
  });
});
