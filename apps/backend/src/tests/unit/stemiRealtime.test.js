import { jest } from '@jest/globals';

const broadcast = jest.fn();

jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast,
  sendToUser: jest.fn(),
}));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
  setTenant: jest.fn(async (_tenantId, callback) => callback({
    $queryRawUnsafe: jest.fn(),
  })),
}));

const { CHANNEL_CATALOG, authorizeChannel } = await import('../../utils/websocket/channelAuth.js');
const { emitCodeStemi } = await import('../../utils/websocket/realtimeEmitter.js');
const { STEMI_ROUTE_ROLES } = await import('../../config/routeRolePolicy.js');

describe('staff:code-stemi realtime contract', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is staff-only in the channel catalog', () => {
    expect(CHANNEL_CATALOG['staff:code-stemi']).toMatchObject({ roles: 'staff' });
    expect(authorizeChannel('staff:code-stemi', { role: 'DOCTOR', userId: '1' }).allowed).toBe(true);
    expect(authorizeChannel('staff:code-stemi', { role: 'PATIENT', userId: '2' }).allowed).toBe(false);
  });

  it.each(STEMI_ROUTE_ROLES)(
    'admits the %s role accepted by the REST STEMI role policy',
    (role) => {
      expect(authorizeChannel('staff:code-stemi', { role, userId: '1' }).allowed).toBe(true);
    },
  );

  it('broadcasts a tenant-scoped notification-only board invalidation', () => {
    emitCodeStemi({
      kind: 'activation-created',
      tenantId: 'tenant-a',
      activation: {
        id: 41n,
        patient_uid: 'patient-a',
        emergency_visit_id: 12,
        cath_case_id: 8n,
        status: 'lab_notified',
        activated_at: '2026-07-11T10:05:00.000Z',
      },
    });

    expect(broadcast).toHaveBeenCalledWith(
      'staff:code-stemi',
      expect.objectContaining({
        kind: 'code-stemi',
        eventKind: 'activation-created',
        activationId: '41',
        cathCaseId: '8',
        status: 'lab_notified',
      }),
      { tenantId: 'tenant-a' },
    );
  });

  it('does not broadcast without an explicit tenant', () => {
    emitCodeStemi({ kind: 'activation-created', activation: { id: 41 } });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
