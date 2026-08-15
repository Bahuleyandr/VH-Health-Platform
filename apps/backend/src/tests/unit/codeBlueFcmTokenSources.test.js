import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const USER_UID = '00000000-0000-4000-8000-000000000002';
const DEVICE_ID = '00000000-0000-4000-8000-000000000003';
const EVENT_ID = 42;
const SESSION_EPOCH = 'session-family-1';
const OTHER_SERVER_SECRET = 'a-different-code-blue-reference-secret-at-least-32-bytes';
const directQueryMock = jest.fn();
const tenantQueryMock = jest.fn();
const setTenantMock = jest.fn(async (_tenantId, callback) => callback({
  $queryRawUnsafe: tenantQueryMock,
}));
const sendPushMock = jest.fn();
const broadcastMock = jest.fn();
process.env.JWT_SECRET = 'test-code-blue-reference-secret-at-least-32-bytes';

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
// The real (unmocked) reader — the server-side counterpart of the sealed
// reference the emitter puts on the wire. Used below to prove the event id is
// recoverable ONLY by a holder of the server secret.
const { readCodeBlueNotificationReference } = await import(
  '../../utils/notifications/codeBlueNotificationReference.js'
);

const flushFanout = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));

beforeEach(() => {
  jest.clearAllMocks();
  directQueryMock.mockResolvedValue([{ device_token: 'device-trust-auth-secret' }]);
  tenantQueryMock.mockResolvedValue([
    {
      token: 'user-device-fcm-token',
      recipient_uid: USER_UID,
      device_id: DEVICE_ID,
      registration_epoch: '7',
      session_epoch: SESSION_EPOCH,
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
    eventId: EVENT_ID,
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
    title: 'CODE BLUE',
    body: 'Respond immediately',
    priority: 'high',
    channelId: 'code_blue',
    data: expect.objectContaining({
      type: 'code_blue',
      code_blue_reference: expect.stringMatching(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
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
  const pushData = sendPushMock.mock.calls[0][0].data;
  expect(pushData).not.toHaveProperty('eventId');
  expect(pushData).not.toHaveProperty('patientId');
  expect(pushData).not.toHaveProperty('bedNumber');
  expect(pushData).not.toHaveProperty('ward');
  expect(pushData).not.toHaveProperty('reason');

  // --- The event id must not be RECOVERABLE from the push payload ---------
  //
  // This block replaces `expect(pushData.code_blue_reference).not.toContain('42')`,
  // which was both flaky and weak. The reference is a ~330-char random
  // base64url string over a 64-char alphabet, so the 2-char needle "42" turns
  // up by coincidence in ~7.4% of references (measured over 200,000 samples) —
  // roughly one CI failure in 13, and a coincidental hit was indistinguishable
  // from a real leak. It was also weak in the other direction: an id that was
  // encoded rather than embedded verbatim would have sailed straight past it.
  //
  // The property actually being guaranteed is narrower and stronger: a staff
  // device receiving this push learns nothing about which resuscitation event
  // fired. The id is deliberately INSIDE the reference — sealed with AES-256-GCM
  // under the server secret and bound to this recipient's authority tuple — so
  // "absent from the payload" was never the right question. "Sealed, and
  // readable only by the server" is. Each assertion below is deterministic:
  // none of them scans random bytes for a short needle.
  const { code_blue_reference: reference, ...clearFields } = pushData;

  // (1) The clear-text surface is closed. Every key is enumerated here and
  //     every value is pinned to a literal by the assertion above, so there is
  //     no unpinned field left for an id to ride along in.
  expect(Object.keys(pushData).sort()).toEqual([
    'code_blue_reference',
    'notification_authority_version',
    'notification_authorization_epoch',
    'notification_device_id',
    'notification_expires_at',
    'notification_recipient_uid',
    'notification_registration_epoch',
    'notification_session_epoch',
    'notification_tenant_id',
    'type',
  ]);
  expect(Object.values(clearFields)).not.toContain(String(EVENT_ID));

  // (2) The id IS sealed in the reference, and the server can get exactly it
  //     back — proving the handle really is this event's handle, bound to this
  //     tenant/user/device/epoch tuple, not a blank or a stale envelope.
  const audience = {
    tenantId: TENANT_ID,
    userUid: USER_UID,
    deviceId: DEVICE_ID,
    registrationEpoch: '7',
    sessionEpoch: SESSION_EPOCH,
    authorizationEpoch: '4',
  };
  const sealed = readCodeBlueNotificationReference(reference, audience);
  expect(sealed).not.toBeNull();
  expect(sealed.eventId).toBe(String(EVENT_ID));

  // (3) ...and ONLY the server can. Re-read the same reference under a
  //     different server secret: the device holds the bytes but not the key,
  //     so the id stays unreachable. This is what makes the handle opaque
  //     rather than merely obscure.
  const realSecret = process.env.CODE_BLUE_NOTIFICATION_SECRET;
  try {
    process.env.CODE_BLUE_NOTIFICATION_SECRET = OTHER_SERVER_SECRET;
    expect(readCodeBlueNotificationReference(reference, audience)).toBeNull();
  } finally {
    if (realSecret === undefined) delete process.env.CODE_BLUE_NOTIFICATION_SECRET;
    else process.env.CODE_BLUE_NOTIFICATION_SECRET = realSecret;
  }

  // (4) Nor can a different device replay it: the reference is bound to the
  //     recipient it was minted for, so a leaked handle buys nothing.
  expect(readCodeBlueNotificationReference(reference, {
    ...audience,
    deviceId: '00000000-0000-4000-8000-0000000000ff',
  })).toBeNull();

  // (5) The sealed segment is ciphertext, not an encoding. If the envelope
  //     ever stopped being encrypted, its claim set would be plainly readable
  //     here. Scan it for the 36-char tenant/recipient UUIDs and the session
  //     epoch rather than the 2-char event id: those needles are long enough
  //     that a coincidental hit in random bytes is impossible (~2^-288),
  //     whereas the short needle is precisely what made this test flaky.
  const [, , sealedSegment] = reference.split('.');
  const sealedBytes = Buffer.from(sealedSegment, 'base64url').toString('latin1');
  expect(sealedBytes).not.toContain(TENANT_ID);
  expect(sealedBytes).not.toContain(USER_UID);
  expect(sealedBytes).not.toContain(DEVICE_ID);
  expect(sealedBytes).not.toContain(SESSION_EPOCH);
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
