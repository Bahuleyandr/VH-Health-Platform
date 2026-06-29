import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitBloodBankEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitBloodBankEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts on staff:blood-bank with the kind + explicit tenantId', () => {
    emitBloodBankEvent('request-created', { tenantId: 't1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'staff:blood-bank',
      expect.objectContaining({ kind: 'request-created' }),
      { tenantId: 't1' },
    );
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitBloodBankEvent('reaction-recorded', { tenantId: 't1' })).not.toThrow();
  });
});
