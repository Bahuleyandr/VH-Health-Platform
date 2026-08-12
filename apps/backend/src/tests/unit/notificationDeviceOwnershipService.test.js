import { jest } from '@jest/globals';

const setTenantTxMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  setTenantTx: setTenantTxMock,
}));

const {
  registerNotificationDevice,
  rotateNotificationDeviceToken,
} = await import('../../services/notification/deviceRegistrationService.js');

const TENANT_ID = '00000000-0000-4000-8000-0000000000a1';
const USER_UID = '00000000-0000-4000-8000-0000000000b2';

describe('notification device ownership adapter', () => {
  let queryRawUnsafe;

  beforeEach(() => {
    queryRawUnsafe = jest.fn();
    setTenantTxMock.mockReset();
    setTenantTxMock.mockImplementation(async (tenantId, callback) => {
      expect(tenantId).toBe(TENANT_ID);
      return callback({ $queryRawUnsafe: queryRawUnsafe });
    });
  });

  it('registers through the tenant-scoped migration-owned handoff only', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{
      id: 17,
      device_name: 'Ward handset',
      is_new_registration: true,
    }]);

    const result = await registerNotificationDevice({
      tenantId: TENANT_ID,
      userUid: USER_UID,
      deviceId: 'installation-1',
      fcmToken: 'token-1',
      deviceName: 'Ward handset',
      platform: 'android',
      appVersion: '1.2.3',
      osVersion: '16',
    });

    expect(result).toEqual({
      id: 17,
      device_name: 'Ward handset',
      is_new_registration: true,
    });
    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringMatching(/FROM public\.notification_device_handoff\([\s\S]*\$9::boolean/),
      TENANT_ID,
      USER_UID,
      'installation-1',
      'token-1',
      'Ward handset',
      'android',
      '1.2.3',
      '16',
      false,
    );
    const sql = queryRawUnsafe.mock.calls[0][0];
    expect(sql).not.toMatch(/DELETE\s+FROM\s+user_devices/i);
    expect(sql).not.toMatch(/pg_advisory_xact_lock/i);
  });

  it('uses the update-only contract and preserves an absent projection result', async () => {
    queryRawUnsafe.mockResolvedValueOnce([]);

    const result = await rotateNotificationDeviceToken({
      tenantId: TENANT_ID,
      userUid: USER_UID,
      deviceId: 'installation-1',
      fcmToken: 'token-2',
    });

    expect(result).toBeUndefined();
    expect(queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('public.notification_device_handoff'),
      TENANT_ID,
      USER_UID,
      'installation-1',
      'token-2',
      null,
      null,
      null,
      null,
      true,
    );
  });
});
