import { jest } from '@jest/globals';

const broadcast = jest.fn();
const broadcastConfirmed = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  broadcastConfirmed,
  sendToUser: jest.fn(),
}));

const { emitDailyOps, emitDailyOpsConfirmed } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitDailyOps', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts the snapshot on admin:daily-ops with tenantId', () => {
    const snap = { d: '2026-06-28', opd_today: 12, ip_in_house: 7, collections_today: '34500' };
    emitDailyOps(snap, { tenantId: 't-1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('admin:daily-ops', snap, { tenantId: 't-1' });
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitDailyOps({ d: 'x' }, {})).not.toThrow();
  });

  test('exposes confirmed broadcast failure to the scheduler', async () => {
    broadcastConfirmed.mockRejectedValueOnce(new Error('redis down'));
    await expect(emitDailyOpsConfirmed({ d: 'x' }, { tenantId: 't-1' }))
      .rejects.toThrow('redis down');
  });
});
