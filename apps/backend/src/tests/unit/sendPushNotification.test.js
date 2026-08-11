/**
 * FCM push sender unit tests.
 *
 * Added alongside the firebase-admin 13 → 14 migration. Every other suite in
 * the repo mocks `sendPushNotification.js` wholesale, so nothing exercised the
 * module against the Firebase boundary itself. Push is a clinical-safety path
 * (Code Blue, critical vitals), so the behaviours that must survive an SDK
 * major are pinned here: which SDK entry point is called, the transient-error
 * retry, FCM-token cleanup, and the thrown error's shape.
 *
 * Mocking 'firebase-admin/messaging' by that exact specifier is itself part of
 * the assertion — if the module ever imports the SDK a different way, the mock
 * stops applying and these tests fail rather than silently hitting the network.
 */

import { jest } from '@jest/globals';

const sendEachForMulticastMock = jest.fn();
const getMessagingMock = jest.fn(() => ({ sendEachForMulticast: sendEachForMulticastMock }));
jest.unstable_mockModule('firebase-admin/messaging', () => ({
  getMessaging: getMessagingMock,
}));

const txQueryRawUnsafeMock = jest.fn();
const queryRawUnsafeMock = jest.fn();
const setTenantMock = jest.fn(async (_tenantId, fn) => fn({ $queryRawUnsafe: txQueryRawUnsafeMock }));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
  setTenant: setTenantMock,
}));

const loggerWarnMock = jest.fn();
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: loggerWarnMock, error: jest.fn(), debug: jest.fn() },
}));

const sendToUserMock = jest.fn();
jest.unstable_mockModule('../../utils/websocket/wsServer.js', () => ({
  sendToUser: sendToUserMock,
}));

const { sendPushNotification } = await import('../../utils/notifications/sendPushNotification.js');

const okResponse = (count = 1) => ({
  successCount: count,
  failureCount: 0,
  responses: Array.from({ length: count }, (_, i) => ({ success: true, messageId: `msg-${i}` })),
});

beforeEach(() => {
  jest.clearAllMocks();
  sendEachForMulticastMock.mockResolvedValue(okResponse());
  queryRawUnsafeMock.mockResolvedValue([]);
});

describe('sendPushNotification — SDK entry point', () => {
  it('sends through getMessaging() from firebase-admin/messaging', async () => {
    await sendPushNotification({ tokens: 'tok-1', title: 'T', body: 'B' });

    expect(getMessagingMock).toHaveBeenCalledTimes(1);
    // Resolved with no argument — the default app, as `admin.messaging()` was.
    expect(getMessagingMock).toHaveBeenCalledWith();
    expect(sendEachForMulticastMock).toHaveBeenCalledTimes(1);
  });

  it('normalises a single token to an array', async () => {
    await sendPushNotification({ tokens: 'tok-1', title: 'T', body: 'B' });

    expect(sendEachForMulticastMock.mock.calls[0][0].tokens).toEqual(['tok-1']);
  });

  it('returns the normalised per-token response envelope', async () => {
    sendEachForMulticastMock.mockResolvedValue({
      successCount: 1,
      failureCount: 1,
      responses: [
        { success: true, messageId: 'msg-a' },
        { success: false, error: { code: 'messaging/internal-error', message: 'boom' } },
      ],
    });

    const out = await sendPushNotification({ tokens: ['a', 'b'], title: 'T', body: 'B' });

    expect(out).toEqual({
      successCount: 1,
      failureCount: 1,
      responses: [
        { tokenIndex: 0, success: true, messageId: 'msg-a', errorCode: null, errorMessage: null },
        { tokenIndex: 1, success: false, messageId: null, errorCode: 'messaging/internal-error', errorMessage: 'boom' },
      ],
    });
  });
});

describe('sendPushNotification — guards', () => {
  it('returns an empty result without calling FCM when no tokens are given', async () => {
    const out = await sendPushNotification({ tokens: [], title: 'T', body: 'B' });

    expect(out).toEqual({ successCount: 0, failureCount: 0, responses: [] });
    expect(getMessagingMock).not.toHaveBeenCalled();
  });

  it('throws above the 500-token multicast ceiling', async () => {
    const tokens = Array.from({ length: 501 }, (_, i) => `tok-${i}`);

    await expect(sendPushNotification({ tokens, title: 'T', body: 'B' }))
      .rejects.toThrow(/more than 500 tokens/);
    expect(sendEachForMulticastMock).not.toHaveBeenCalled();
  });

  it('still pushes over WebSocket when a userId is supplied', async () => {
    await sendPushNotification({
      tokens: 'tok-1',
      title: 'Prescription ready',
      body: 'Prescription RX-42 is ready',
      data: { type: 'prescription', prescriptionId: '42' },
      userId: 42,
    });

    expect(sendToUserMock).toHaveBeenCalledWith('42', 'notification', {
      title: 'Prescription ready',
      body: 'Prescription RX-42 is ready',
      data: { type: 'prescription', prescriptionId: '42' },
    });
  });
});

describe('sendPushNotification — message shape', () => {
  const expectOpaqueNormalEnvelope = (message) => {
    expect(message.notification).toEqual({
      title: 'VH Health',
      body: 'You have a new update. Open the app to view it.',
    });
    expect(message.data).toEqual({
      notification_id: expect.stringMatching(
        /^push_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      route: '/notifications',
      action: 'open_notification_inbox',
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    });
    expect(message.android).toEqual({
      notification: { visibility: 'private' },
    });
    expect(message.apns).toBeUndefined();
  };

  it('normal priority replaces display and data with an opaque private envelope', async () => {
    await sendPushNotification({
      tokens: 'tok-1',
      title: 'Investigation Report Ready',
      body: 'Patient Alex: biopsy result is ready',
      data: {
        k: 'v',
        title: 'Injected title',
        body: 'Injected body',
      },
    });

    const message = sendEachForMulticastMock.mock.calls[0][0];
    expectOpaqueNormalEnvelope(message);
  });

  it.each([
    ['prescription', { type: 'prescription', prescriptionId: '612' }],
    ['appointment', { type: 'appointment_confirmed', appointment_id: '93', token: '42' }],
    ['patient message', { type: 'patient_message', thread_id: '77', deep_link: '/portal/messages/77' }],
    ['arbitrary outbox', {
      title: 'Injected title',
      body: 'Injected body',
      route: '/portal/lab-results/88',
      action: 'open_record',
      patient_uid: 'patient-uid',
      unknown_clinical_field: 'biopsy',
    }],
  ])('normal %s data cannot escape the opaque FCM envelope', async (_label, data) => {
    await sendPushNotification({
      tokens: 'tok-1',
      title: 'Detailed authenticated title',
      body: 'Detailed authenticated body',
      data,
    });

    expectOpaqueNormalEnvelope(sendEachForMulticastMock.mock.calls[0][0]);
  });

  it('high priority is data-only with a 60s TTL and critical APNs headers', async () => {
    await sendPushNotification({
      tokens: 'tok-1',
      title: 'Code Blue',
      body: 'Ward 3',
      priority: 'high',
      channelId: 'code_blue',
      data: { type: 'code_blue', patientId: 'patient-42', ward: '3' },
    });

    const message = sendEachForMulticastMock.mock.calls[0][0];
    expect(message.notification).toBeUndefined();
    expect(message.data).toEqual({
      title: 'Code Blue',
      body: 'Ward 3',
      type: 'code_blue',
      patientId: 'patient-42',
      ward: '3',
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
    });
    expect(message.android).toEqual({
      priority: 'high',
      ttl: 60000,
      notification: { channelId: 'code_blue', priority: 'max', visibility: 'public' },
    });
    expect(message.apns.headers).toEqual({ 'apns-priority': '10' });
    expect(message.apns.payload.aps['interruption-level']).toBe('critical');
  });
});

describe('sendPushNotification — retry semantics', () => {
  it('retries a transient server-unavailable error and succeeds', async () => {
    const transient = Object.assign(new Error('unavailable'), { code: 'messaging/server-unavailable' });
    sendEachForMulticastMock
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce(okResponse());

    const out = await sendPushNotification({ tokens: 'tok-1', title: 'T', body: 'B' });

    expect(sendEachForMulticastMock).toHaveBeenCalledTimes(2);
    expect(out.successCount).toBe(1);
  });

  it('does not retry a non-transient error', async () => {
    const permanent = Object.assign(new Error('bad request'), { code: 'messaging/invalid-argument' });
    sendEachForMulticastMock.mockRejectedValue(permanent);

    await expect(sendPushNotification({ tokens: 'tok-1', title: 'T', body: 'B' })).rejects.toThrow();
    expect(sendEachForMulticastMock).toHaveBeenCalledTimes(1);
  });

  it('wraps a send failure with its original code and cause', async () => {
    const permanent = Object.assign(new Error('bad request'), { code: 'messaging/invalid-argument' });
    sendEachForMulticastMock.mockRejectedValue(permanent);

    await expect(sendPushNotification({ tokens: 'tok-1', title: 'T', body: 'B' }))
      .rejects.toMatchObject({
        message: 'Push notification failed',
        code: 'messaging/invalid-argument',
        cause: permanent,
      });
  });

  it('falls back to FCM_TRANSPORT_FAILURE when the error carries no code', async () => {
    sendEachForMulticastMock.mockRejectedValue(new Error('socket hang up'));

    await expect(sendPushNotification({ tokens: 'tok-1', title: 'T', body: 'B' }))
      .rejects.toMatchObject({ code: 'FCM_TRANSPORT_FAILURE' });
  });
});

describe('sendPushNotification — invalid token deactivation', () => {
  const flushDeferredCleanup = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));

  it('clears permanently-failed tokens only from FCM registries across every tenant', async () => {
    queryRawUnsafeMock.mockResolvedValue([{ id: 'tenant-1' }, { id: 'tenant-2' }]);
    sendEachForMulticastMock.mockResolvedValue({
      successCount: 1,
      failureCount: 2,
      responses: [
        { success: true, messageId: 'msg-a' },
        { success: false, error: { code: 'messaging/registration-token-not-registered', message: 'gone' } },
        { success: false, error: { code: 'messaging/invalid-registration-token', message: 'bad' } },
      ],
    });

    await sendPushNotification({ tokens: ['good', 'stale', 'bogus'], title: 'T', body: 'B' });
    await flushDeferredCleanup();

    expect(setTenantMock).toHaveBeenCalledTimes(2);
    // user_devices + users, per tenant. staff_devices.device_token is a
    // device-trust credential and must never be mutated by FCM cleanup.
    expect(txQueryRawUnsafeMock).toHaveBeenCalledTimes(4);

    // Tenants are cleaned concurrently (Promise.all), so the calls interleave —
    // assert the multiset, not the order.
    const tables = txQueryRawUnsafeMock.mock.calls.map(([sql]) => sql.match(/UPDATE (\w+)/)[1]);
    expect(tables.slice().sort()).toEqual([
      'user_devices', 'user_devices',
      'users', 'users',
    ]);
    expect(txQueryRawUnsafeMock.mock.calls.map(([sql]) => sql).join('\n'))
      .not.toMatch(/staff_devices/i);

    for (const [, tenantId, invalidTokens] of txQueryRawUnsafeMock.mock.calls) {
      expect(['tenant-1', 'tenant-2']).toContain(tenantId);
      expect(invalidTokens).toEqual(['stale', 'bogus']);
    }
    expect(loggerWarnMock.mock.calls.flat().join(' ')).not.toContain('stale');
    expect(loggerWarnMock.mock.calls.flat().join(' ')).not.toContain('bogus');
  });

  it('leaves transiently-failed tokens alone', async () => {
    sendEachForMulticastMock.mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      responses: [
        { success: false, error: { code: 'messaging/internal-error', message: 'retry later' } },
      ],
    });

    await sendPushNotification({ tokens: ['keep-me'], title: 'T', body: 'B' });
    await flushDeferredCleanup();

    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(setTenantMock).not.toHaveBeenCalled();
  });
});
