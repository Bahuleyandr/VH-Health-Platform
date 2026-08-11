import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
}));

const {
  clearGrowthReferenceCache,
  computeGrowthSnapshot,
  computePercentile,
} = await import('../../services/clinical/growthPercentileService.js');

describe('growth percentile evidence failures', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    clearGrowthReferenceCache();
  });

  test('does not replace a failed LMS lookup with an approximate clinical score', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('growth reference unavailable'));

    await expect(computePercentile({
      sex: 'M', ageInDays: 730, metric: 'weight_kg', value: 12.5,
    })).rejects.toThrow('growth reference unavailable');
  });

  test('does not silently omit a failed percentile from a growth snapshot', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('growth reference unavailable'));
    const birthday = new Date(Date.now() - (730 * 86400000));

    await expect(computeGrowthSnapshot({
      gender: 'M', birthday, weightKg: 12.5,
    })).rejects.toThrow('growth reference unavailable');
  });
});
