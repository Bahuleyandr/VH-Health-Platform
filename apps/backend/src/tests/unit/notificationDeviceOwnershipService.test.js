import { jest } from '@jest/globals';

const setTenantTxMock = jest.fn();
const setTenantMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  setTenantTx: setTenantTxMock,
  setTenant: setTenantMock,
}));

const {
  createCodeBlueNotificationReference,
  getCodeBlueNotificationContent,
  registerNotificationDevice,
  retireNotificationDevice,
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
    expect(setTenantMock.mock.calls[0]).toHaveLength(2);
  });

  it('retires the exact device binding without deleting linked projection rows', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{
      device_name: 'Ward handset',
      platform: 'android',
    }]);

    await expect(retireNotificationDevice({
      tenantId: TENANT_ID,
      userUid: USER_UID,
      deviceId: 'installation-1',
    })).resolves.toEqual({
      device_name: 'Ward handset',
      platform: 'android',
    });

    const [sql, tenantId, userUid, deviceId] = queryRawUnsafe.mock.calls[0];
    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
    expect(sql).toMatch(/UPDATE user_devices[\s\S]*fcm_token = NULL/);
    expect(sql).toMatch(/notification_epoch = ud\.notification_epoch \+ 1/);
    expect(sql).toMatch(/UPDATE users[\s\S]*device_token = NULL/);
    expect(sql).toMatch(/u\.device_token = retired\.retired_fcm_token/);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+user_devices/i);
    expect([tenantId, userUid, deviceId]).toEqual([
      TENANT_ID,
      USER_UID,
      'installation-1',
    ]);
  });

  it('hydrates Code Blue PHI only through one primary authority-bound query', async () => {
    process.env.JWT_SECRET = 'test-code-blue-reference-secret-at-least-32-bytes';
    const codeBlueReference = createCodeBlueNotificationReference({
      tenantId: TENANT_ID,
      userUid: USER_UID,
      deviceId: 'installation-1',
      registrationEpoch: '3',
      sessionEpoch: 'session-family-1',
      authorizationEpoch: '8',
      eventId: '42',
      expiresAtUnix: Math.floor(Date.now() / 1000) + 60,
    });
    queryRawUnsafe.mockResolvedValueOnce([{
      event_id: '42',
      patient_id: 'patient-42',
      ward: 'ICU',
      bed_number: '4A',
      reason: 'Cardiac arrest',
      started_at: new Date('2030-01-01T00:00:00.000Z'),
    }]);

    await expect(getCodeBlueNotificationContent({
      tenantId: TENANT_ID,
      userUid: USER_UID,
      sessionJti: 'current-jti',
      deviceId: 'installation-1',
      registrationEpoch: '3',
      sessionEpoch: 'session-family-1',
      authorizationEpoch: '8',
      codeBlueReference,
    })).resolves.toEqual({
      eventId: '42',
      patientId: 'patient-42',
      ward: 'ICU',
      bedNumber: '4A',
      reason: 'Cardiac arrest',
      startedAt: '2030-01-01T00:00:00.000Z',
    });

    const [sql] = queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/JOIN resuscitation_events re/);
    expect(sql).toMatch(/re\.id = \$8::bigint/);
    expect(sql).toMatch(/uas\.jti = \$7::text/);
    expect(setTenantMock.mock.calls[0]).toHaveLength(2);
  });

  it('rejects tampered or audience-mismatched Code Blue references before querying PHI', async () => {
    process.env.JWT_SECRET = 'test-code-blue-reference-secret-at-least-32-bytes';
    const reference = createCodeBlueNotificationReference({
      tenantId: TENANT_ID,
      userUid: USER_UID,
      deviceId: 'installation-1',
      registrationEpoch: '3',
      sessionEpoch: 'session-family-1',
      authorizationEpoch: '8',
      eventId: '42',
      expiresAtUnix: Math.floor(Date.now() / 1000) + 60,
    });

    await expect(getCodeBlueNotificationContent({
      tenantId: TENANT_ID,
      userUid: USER_UID,
      sessionJti: 'current-jti',
      deviceId: 'installation-1',
      registrationEpoch: '3',
      sessionEpoch: 'session-family-1',
      authorizationEpoch: '8',
      codeBlueReference: `${reference.slice(0, -1)}x`,
    })).resolves.toBeNull();
    await expect(getCodeBlueNotificationContent({
      tenantId: TENANT_ID,
      userUid: USER_UID,
      sessionJti: 'current-jti',
      deviceId: 'other-installation',
      registrationEpoch: '3',
      sessionEpoch: 'session-family-1',
      authorizationEpoch: '8',
      codeBlueReference: reference,
    })).resolves.toBeNull();
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects an expired Code Blue reference before querying PHI', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    try {
      process.env.JWT_SECRET = 'test-code-blue-reference-secret-at-least-32-bytes';
      const reference = createCodeBlueNotificationReference({
        tenantId: TENANT_ID,
        userUid: USER_UID,
        deviceId: 'installation-1',
        registrationEpoch: '3',
        sessionEpoch: 'session-family-1',
        authorizationEpoch: '8',
        eventId: '42',
        expiresAtUnix: Math.floor(Date.now() / 1000) + 60,
      });
      jest.setSystemTime(new Date('2030-01-01T00:01:01.000Z'));

      await expect(getCodeBlueNotificationContent({
        tenantId: TENANT_ID,
        userUid: USER_UID,
        sessionJti: 'current-jti',
        deviceId: 'installation-1',
        registrationEpoch: '3',
        sessionEpoch: 'session-family-1',
        authorizationEpoch: '8',
        codeBlueReference: reference,
      })).resolves.toBeNull();
      expect(queryRawUnsafe).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
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
