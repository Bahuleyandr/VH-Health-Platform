import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitDialysisEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitDialysisEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts on staff:dialysis-board with the kind + explicit tenantId', () => {
    emitDialysisEvent('session-started', { tenantId: 't1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'staff:dialysis-board',
      expect.objectContaining({ kind: 'session-started' }),
      { tenantId: 't1' },
    );
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitDialysisEvent('session-completed', { tenantId: 't1' })).not.toThrow();
  });
});
