import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitLabEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitLabEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts on staff:lab with kind + tenantId', () => {
    emitLabEvent('alert-fired', { tenantId: 't-1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'staff:lab',
      expect.objectContaining({ kind: 'alert-fired' }),
      { tenantId: 't-1' },
    );
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitLabEvent('result-pending', { tenantId: 't-2' })).not.toThrow();
  });
});
