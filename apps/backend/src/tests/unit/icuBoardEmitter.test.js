import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitIcuBoardEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitIcuBoardEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts on staff:icu-board with kind, admissionId, status, and tenantId', () => {
    emitIcuBoardEvent('code-status', { admissionId: 42, status: 'dnr', tenantId: 't-1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'staff:icu-board',
      expect.objectContaining({ kind: 'code-status', admissionId: 42, status: 'dnr' }),
      { tenantId: 't-1' },
    );
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitIcuBoardEvent('flowsheet', { admissionId: 1 })).not.toThrow();
  });
});
