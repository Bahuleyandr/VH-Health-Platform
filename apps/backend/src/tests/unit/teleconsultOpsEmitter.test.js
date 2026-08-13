import { jest } from '@jest/globals';

const broadcast = jest.fn();
const broadcastConfirmed = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  broadcastConfirmed,
  sendToUser: jest.fn(),
}));

const { emitTeleconsultOps, emitTeleconsultOpsConfirmed } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitTeleconsultOps', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts the snapshot on admin:teleconsult-ops with tenantId', () => {
    const snap = { active_count: 2, waiting_count: 3, join_failure_count: 1 };
    emitTeleconsultOps(snap, { tenantId: 't-1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('admin:teleconsult-ops', snap, { tenantId: 't-1' });
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitTeleconsultOps({ active_count: 0 }, {})).not.toThrow();
  });

  test('exposes confirmed broadcast failure to the scheduler', async () => {
    broadcastConfirmed.mockRejectedValueOnce(new Error('redis down'));
    await expect(emitTeleconsultOpsConfirmed({ active_count: 0 }, { tenantId: 't-1' }))
      .rejects.toThrow('redis down');
  });
});
