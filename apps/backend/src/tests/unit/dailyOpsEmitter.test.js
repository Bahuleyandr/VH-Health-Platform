import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitDailyOps } = await import('../../utils/websocket/realtimeEmitter.js');

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
});
