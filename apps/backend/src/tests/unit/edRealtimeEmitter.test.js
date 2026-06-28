import { jest } from '@jest/globals';

const broadcast = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

const { emitEdBoardEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitEdBoardEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts on admin:ed-board with kind, visit fields, and tenantId', () => {
    emitEdBoardEvent(
      'transition',
      { id: 7, visit_number: 'ED-007', status: 'in_treatment', triage_priority: 'esi_2', disposition: null },
      { tenantId: 't-1' },
    );

    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(
      'admin:ed-board',
      expect.objectContaining({
        kind: 'transition',
        id: 7,
        visitNumber: 'ED-007',
        status: 'in_treatment',
        triagePriority: 'esi_2',
        disposition: null,
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
      { tenantId: 't-1' },
    );
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitEdBoardEvent('arrival', { id: 1 }, {})).not.toThrow();
  });
});
