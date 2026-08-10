import { jest } from '@jest/globals';

const broadcastMock = jest.fn();

jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast: broadcastMock,
  sendToUser: jest.fn(),
}));

jest.unstable_mockModule('../../utils/notifications/sendPushNotification.js', () => ({
  sendPushNotification: jest.fn(),
}));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
  setTenant: jest.fn(),
}));

const { authorizeChannel, CHANNEL_CATALOG } = await import('../../utils/websocket/channelAuth.js');
const { emitColdChainEvent } = await import('../../utils/websocket/realtimeEmitter.js');

describe('cold-chain realtime channel', () => {
  beforeEach(() => {
    broadcastMock.mockReset();
  });

  it('publishes staff:cold-chain in the channel catalog and staff RBAC allows it', () => {
    expect(CHANNEL_CATALOG['staff:cold-chain']).toMatchObject({ roles: 'staff' });
    expect(authorizeChannel('staff:cold-chain', { role: 'PHARMACY_STAFF', userId: 'u1' })).toEqual({ allowed: true });
    expect(authorizeChannel('staff:cold-chain', { role: 'PATIENT', userId: 'u2' })).toMatchObject({ allowed: false });
  });

  it('emits cold-chain events on the tenant-scoped staff channel', () => {
    emitColdChainEvent('excursion-opened', {
      tenantId: '11111111-1111-4111-8111-111111111111',
      unitId: 12,
      excursionId: 33,
      status: 'open',
      severity: 'critical',
    });

    expect(broadcastMock).toHaveBeenCalledWith(
      'staff:cold-chain',
      expect.objectContaining({
        kind: 'excursion-opened',
        unitId: 12,
        excursionId: 33,
        status: 'open',
        severity: 'critical',
      }),
      { tenantId: '11111111-1111-4111-8111-111111111111' },
    );
  });
});
