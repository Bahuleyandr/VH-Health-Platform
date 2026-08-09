import { jest } from '@jest/globals';

const prismaMock = { $queryRawUnsafe: jest.fn() };
jest.unstable_mockModule('../../lib/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const { getHealthStatistics } = await import('../../services/health/healthStatsService.js');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('healthStatsService.getHealthStatistics', () => {
  it('returns real aggregates on success', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ total_records: 42, unique_patients: 10, recent_records: 3 }])
      .mockResolvedValueOnce([{ record_type: 'lab', count: 5 }])
      .mockResolvedValueOnce([{ date: '2026-08-09', records_count: 2 }]);

    const result = await getHealthStatistics(7);

    expect(result.totals).toEqual({ total_records: 42, unique_patients: 10, recent_records: 3 });
    expect(result.by_type).toEqual([{ record_type: 'lab', count: 5 }]);
  });

  it('propagates the error instead of masking a DB failure as empty statistics', async () => {
    prismaMock.$queryRawUnsafe.mockRejectedValue(new Error('relation "health_records" does not exist'));

    await expect(getHealthStatistics(7)).rejects.toThrow('relation "health_records" does not exist');
  });
});
