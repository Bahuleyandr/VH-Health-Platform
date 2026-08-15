import { jest } from '@jest/globals';

const broadcast = jest.fn();
const broadcastConfirmed = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  broadcastConfirmed,
  sendToUser: jest.fn(),
}));

const { emitAdminKpi } = await import('../../utils/websocket/realtimeEmitter.js');

describe('emitAdminKpi', () => {
  beforeEach(() => jest.clearAllMocks());

  test('broadcasts the tile on admin:kpi with tenantId and the legacy payload shape', () => {
    const value = { total: 10, occupied: 5, available: 4, other: 1, occupancyPct: 50 };
    emitAdminKpi('bed-occupancy', value, { tenantId: 't-1' });
    expect(broadcast).toHaveBeenCalledTimes(1);
    const [channel, payload, opts] = broadcast.mock.calls[0];
    expect(channel).toBe('admin:kpi');
    // Payload shape is pinned: the admin LiveBedOccupancyTile reads exactly
    // { tile, value, at } — tenant scoping rides on the broadcast opts, not
    // inside the envelope.
    expect(Object.keys(payload).sort()).toEqual(['at', 'tile', 'value']);
    expect(payload.tile).toBe('bed-occupancy');
    expect(payload.value).toEqual(value);
    expect(opts).toEqual({ tenantId: 't-1' });
  });

  test('never throws when broadcast fails', () => {
    broadcast.mockImplementationOnce(() => { throw new Error('redis down'); });
    expect(() => emitAdminKpi('waiting-queue', { waiting: 1 }, { tenantId: 't-1' })).not.toThrow();
  });
});
