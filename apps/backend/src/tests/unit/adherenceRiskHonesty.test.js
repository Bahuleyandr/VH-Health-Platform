import { jest } from '@jest/globals';

const queryRawUnsafe = jest.fn();
const scoreViaModel = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafe },
}));

jest.unstable_mockModule('../../services/gamification/adherenceModelServing.js', () => ({
  scoreViaModel,
}));

const { scoreAdherenceRisk } = await import('../../services/gamification/adherenceRiskService.js');

beforeEach(() => {
  queryRawUnsafe.mockReset();
  scoreViaModel.mockReset();
});

test('a refill-history database fault cannot become zero late refills', async () => {
  queryRawUnsafe
    .mockResolvedValueOnce([{ id: 23, uid: '11111111-1111-4111-8111-111111111111' }])
    .mockResolvedValueOnce([{ missed_30: 0, overrides_30: 0 }])
    .mockRejectedValueOnce(new Error('refill history unavailable'));

  await expect(scoreAdherenceRisk(23, '22222222-2222-4222-8222-222222222222'))
    .rejects.toThrow('refill history unavailable');
  expect(scoreViaModel).not.toHaveBeenCalled();
});
