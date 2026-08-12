import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const USER_UID = '00000000-0000-4000-8000-000000000002';
const directQueryMock = jest.fn();
const tenantQueryMock = jest.fn();
const setTenantMock = jest.fn(async (_tenantId, callback) => callback({
  $queryRawUnsafe: tenantQueryMock,
}));
const sendPushMock = jest.fn();
const broadcastMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: directQueryMock },
  setTenant: setTenantMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../utils/notifications/sendPushNotification.js', () => ({
  sendPushNotification: sendPushMock,
}));
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  broadcast: broadcastMock,
  sendToUser: jest.fn(),
}));

const { emitCodeBlue } = await import('../../utils/websocket/realtimeEmitter.js');

const flushFanout = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));

beforeEach(() => {
  jest.clearAllMocks();
  directQueryMock.mockResolvedValue([{ device_token: 'device-trust-auth-secret' }]);
  tenantQueryMock.mockResolvedValue([
    {
      token: 'user-device-fcm-token',
      recipient_uid: USER_UID,
      device_id: '00000000-0000-4000-8000-000000000003',
      registration_epoch: '7',
      session_epoch: 'session-family-1',
      authorization_epoch: '4',
      expires_at: '1924992000',
    },
  ]);
  sendPushMock.mockResolvedValue({ successCount: 1, failureCount: 0, responses: [] });
});

test('Code Blue uses tenant-scoped FCM sources and never staff device-trust tokens', async () => {
  emitCodeBlue({
    tenantId: TENANT_ID,
    patientId: 'patient-1',
    ward: 'ICU',
    bedNumber: 'B4',
    reason: 'cardiac arrest',
  });
  await flushFanout();

  expect(broadcastMock).toHaveBeenCalledWith(
    'staff:code-blue',
    expect.objectContaining({ patientId: 'patient-1' }),
    { tenantId: TENANT_ID },
  );
  expect(setTenantMock).toHaveBeenCalledWith(
    TENANT_ID,
    expect.any(Function),
    { readOnly: true },
  );
  expect(directQueryMock).not.toHaveBeenCalled();
  const [sql] = tenantQueryMock.mock.calls[0];
  expect(sql).toMatch(/FROM users/i);
  expect(sql).toMatch(/FROM user_devices/i);
  expect(sql).toMatch(/user_active_sessions/i);
  expect(sql).toMatch(/expires_at\s*>\s*NOW\(\)/i);
  expect(sql).toMatch(/token_epoch_bumped_at/i);
  expect(sql).toMatch(/stable_device_id[\s\S]*ud\.device_id/i);
  expect(sql).toMatch(/ORDER BY token, source_priority, issued_at DESC/i);
  expect(sql).not.toMatch(/staff_devices/i);
  expect(sendPushMock).toHaveBeenCalledWith(expect.objectContaining({
    tokens: ['user-device-fcm-token'],
    priority: 'high',
    channelId: 'code_blue',
    data: expect.objectContaining({
      notification_authority_version: '1',
      notification_tenant_id: TENANT_ID,
      notification_recipient_uid: USER_UID,
      notification_device_id: '00000000-0000-4000-8000-000000000003',
      notification_registration_epoch: '7',
      notification_session_epoch: 'session-family-1',
      notification_authorization_epoch: '4',
      notification_expires_at: '1924992000',
    }),
  }));
});

test('Code Blue sends nothing when no live server-owned notification authority exists', async () => {
  tenantQueryMock.mockResolvedValueOnce([]);

  emitCodeBlue({
    tenantId: TENANT_ID,
    patientId: 'patient-1',
    ward: 'ICU',
    bedNumber: 'B4',
    reason: 'cardiac arrest',
  });
  await flushFanout();

  expect(sendPushMock).not.toHaveBeenCalled();
});

test('Code Blue refuses to broadcast or query without an explicit tenant scope', async () => {
  emitCodeBlue({
    patientId: 'patient-1',
    ward: 'ICU',
    bedNumber: 'B4',
    reason: 'cardiac arrest',
  });
  await flushFanout();

  expect(broadcastMock).not.toHaveBeenCalled();
  expect(setTenantMock).not.toHaveBeenCalled();
  expect(sendPushMock).not.toHaveBeenCalled();
});
