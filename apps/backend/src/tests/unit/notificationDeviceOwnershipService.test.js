import { jest } from '@jest/globals';

const setTenantTxMock = jest.fn();
const setTenantMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  setTenantTx: setTenantTxMock,
  setTenant: setTenantMock,
}));

const {
  registerNotificationDevice,
  rotateNotificationDeviceToken,
  validateNotificationAuthority,
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
    setTenantMock.mockImplementation(async (tenantId, callback) => {
      expect(tenantId).toBe(TENANT_ID);
      return callback({ $queryRawUnsafe: queryRawUnsafe });
    });
  });

  it('returns the current server-owned notification audience after a session-bound claim', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([{ id: 17, device_name: 'Ward handset', is_new_registration: true }])
      .mockResolvedValueOnce([{
        tenant_id: TENANT_ID,
        recipient_uid: USER_UID,
        device_id: 'installation-1',
        registration_epoch: '3',
        session_epoch: 'session-family-1',
        authorization_epoch: '8',
        session_expires_at: new Date('2030-01-01T00:00:00.000Z'),
      }]);

    const result = await registerNotificationDevice({
      tenantId: TENANT_ID,
      userUid: USER_UID,
      deviceId: 'installation-1',
      fcmToken: 'token-1',
      sessionJti: 'current-jti',
    });

    expect(result.notification_authority).toEqual({
      version: 1,
      tenantId: TENANT_ID,
      recipientUid: USER_UID,
      deviceId: 'installation-1',
      registrationEpoch: '3',
      sessionEpoch: 'session-family-1',
      authorizationEpoch: '8',
      sessionExpiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(queryRawUnsafe.mock.calls[1][0]).toMatch(/user_active_sessions[\s\S]*uas\.jti = \$5/);
  });

  it('validates the exact current registration and bearer session tuple', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{ '?column?': 1 }]);

    await expect(validateNotificationAuthority({
      tenantId: TENANT_ID,
      userUid: USER_UID,
      sessionJti: 'current-jti',
      deviceId: 'installation-1',
      registrationEpoch: '3',
      sessionEpoch: 'session-family-1',
      authorizationEpoch: '8',
    })).resolves.toBe(true);

    const [sql] = queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/ud\.notification_epoch = \$4::bigint/);
    expect(sql).toMatch(/uas\.session_family_id = \$5::text/);
    expect(sql).toMatch(/u\.token_epoch = \$6::int/);
    expect(sql).toMatch(/uas\.jti = \$7::text/);
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
