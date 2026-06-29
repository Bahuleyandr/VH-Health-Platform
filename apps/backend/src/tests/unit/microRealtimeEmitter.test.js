import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitMicroEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitMicroEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts on staff:micro with kind + tenantId', () => {
    emitMicroEvent('isolate-added', { tenantId: 't-1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'staff:micro',
      expect.objectContaining({ kind: 'isolate-added' }),
      { tenantId: 't-1' },
    );
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitMicroEvent('order-created', { tenantId: 't-2' })).not.toThrow();
  });
});
