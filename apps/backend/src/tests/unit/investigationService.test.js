import { jest } from '@jest/globals';

const updateMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    investigations: {
      update: updateMock,
    },
  },
}));

const { updateStatus } = await import('../../services/investigation/investigationService.js');

const LAB_TECH_UID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-05-15T10:00:00.000Z');

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  updateMock.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('investigationService.updateStatus', () => {
  it('stamps collection audit fields when marking an investigation COLLECTED', async () => {
    updateMock.mockImplementation(async ({ data }) => ({ id: 20, ...data }));

    const result = await updateStatus(
      20,
      'COLLECTED',
      'Collected urgent IPD sample',
      LAB_TECH_UID
    );

    expect(updateMock).toHaveBeenCalledWith({
      where: { id: 20 },
      data: {
        status: 'COLLECTED',
        notes: 'Collected urgent IPD sample',
        collected_at: NOW,
        collected_by: LAB_TECH_UID,
      },
      select: expect.objectContaining({
        id: true,
        status: true,
        collected_at: true,
        collected_by: true,
      }),
    });
    expect(result.collected_at).toEqual(NOW);
    expect(result.collected_by).toBe(LAB_TECH_UID);
  });
});
