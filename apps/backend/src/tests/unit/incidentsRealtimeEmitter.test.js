import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitIncidentEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitIncidentEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts on staff:incidents with the kind', () => {
    emitIncidentEvent('submitted');
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'staff:incidents',
      expect.objectContaining({ kind: 'submitted' }),
      expect.anything(),
    );
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitIncidentEvent('updated')).not.toThrow();
  });
});
