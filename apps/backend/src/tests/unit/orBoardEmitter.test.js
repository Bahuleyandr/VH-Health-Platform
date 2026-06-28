import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitOrBoardEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitOrBoardEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts on staff:or-board with kind, scheduleId, status, and tenantId', () => {
    emitOrBoardEvent('status-changed', { scheduleId: 42, status: 'in_progress', tenantId: 't-1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'staff:or-board',
      expect.objectContaining({ kind: 'status-changed', scheduleId: 42, status: 'in_progress' }),
      { tenantId: 't-1' },
    );
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitOrBoardEvent('cancelled', { scheduleId: 1, status: 'cancelled' })).not.toThrow();
  });
});
