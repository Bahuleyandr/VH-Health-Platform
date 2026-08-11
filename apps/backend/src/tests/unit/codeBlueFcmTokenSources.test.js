import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
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
    { token: 'users-fcm-token' },
    { token: 'user-device-fcm-token' },
  ]);
  sendPushMock.mockResolvedValue({ successCount: 2, failureCount: 0, responses: [] });
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
  expect(sql).not.toMatch(/staff_devices/i);
  expect(sendPushMock).toHaveBeenCalledWith(expect.objectContaining({
    tokens: ['users-fcm-token', 'user-device-fcm-token'],
    priority: 'high',
    channelId: 'code_blue',
  }));
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
