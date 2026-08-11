import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
  circuitBreakerStatus: jest.fn(() => ({ open: false })),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn() },
}));

const {
  tableExists,
  columnExists,
  safeQuery,
  safeScalar,
} = await import('../../routes/admin/services/common.js');
const { getModuleHealth } = await import('../../routes/admin/services/healthService.js');

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
});

describe('admin service query honesty', () => {
  test.each([
    ['table discovery', () => tableExists('doctors')],
    ['column discovery', () => columnExists('doctors', 'is_available')],
    ['row query', () => safeQuery('SELECT * FROM doctors')],
    ['scalar query', () => safeScalar('SELECT COUNT(*) FROM doctors')],
  ])('%s propagates database faults', async (_label, invoke) => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('admin database unavailable'));

    await expect(invoke()).rejects.toThrow('admin database unavailable');
  });

  it('still represents a successful schema absence as false', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ reg: null }]);

    await expect(tableExists('optional_table')).resolves.toBe(false);
  });

  it('marks a module unhealthy when its warning probe fails', async () => {
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (String(sql).includes('JOIN appointments a2')) {
        throw new Error('appointment conflict probe unavailable');
      }
      return [];
    });

    const health = await getModuleHealth();

    expect(health.appointments).toBe('unhealthy');
  });
});
