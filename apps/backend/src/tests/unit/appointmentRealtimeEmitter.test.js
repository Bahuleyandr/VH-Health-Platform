import { jest } from '@jest/globals';
const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({ broadcast, sendToUser: jest.fn() }));
const { emitAppointmentEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitAppointmentEvent', () => {
  beforeEach(() => jest.clearAllMocks());
  test('broadcasts on staff:appointments with the kind + explicit tenantId', () => {
    emitAppointmentEvent('confirm', { tenantId: 't1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith('staff:appointments', expect.objectContaining({ kind: 'confirm' }), { tenantId: 't1' });
  });
  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitAppointmentEvent('walk-in-created', { tenantId: 't1' })).not.toThrow();
  });
});
