import { jest } from '@jest/globals';
const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({ broadcast, sendToUser: jest.fn() }));
const { emitRadiologyEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitRadiologyEvent', () => {
  beforeEach(() => jest.clearAllMocks());
  test('broadcasts on staff:radiology with the kind + explicit tenantId', () => {
    emitRadiologyEvent('order-created', { tenantId: 't1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('staff:radiology', expect.objectContaining({ kind: 'order-created' }), { tenantId: 't1' });
  });
  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitRadiologyEvent('order-cancelled', { tenantId: 't1' })).not.toThrow();
  });
});
