import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const CLAIM_TOKEN = '00000000-0000-4000-8000-000000000099';
const HASH = 'a'.repeat(64);

const dispatchMock = jest.fn();
const getTenantSettingsMock = jest.fn();
const sendPushMock = jest.fn();
const queryRawUnsafeMock = jest.fn();
const beginProviderAttemptsMock = jest.fn();
const recordProviderReceiptMock = jest.fn();
const applyProviderReceiptToCursorMock = jest.fn();
const loggerMock = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
  setTenant: jest.fn(async (_tenantId, callback) => callback({
    $queryRawUnsafe: queryRawUnsafeMock,
  })),
  // notificationOutbox.js (imported below for its intent builder) needs this
  // export to link, even though the builder itself never touches the DB.
  setTenantTx: jest.fn(async (_tenantId, callback) => callback({
    $queryRawUnsafe: queryRawUnsafeMock,
  })),
}));
jest.unstable_mockModule('../../lib/tenantContext.js', () => ({
  runInTenantContext: (_tenantId, callback) => callback(),
  getCurrentTenantId: () => TENANT_ID,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../../services/tenant/tenantSettingsService.js', () => ({
  getTenantSettings: getTenantSettingsMock,
}));
jest.unstable_mockModule('../../utils/notifications/notificationDispatcher.js', () => ({
  dispatch: dispatchMock,
}));
jest.unstable_mockModule('../../utils/notifications/sendPushNotification.js', () => ({
  sendPushNotification: sendPushMock,
}));
jest.unstable_mockModule('../../services/smsService.js', () => ({
  sendSMS: jest.fn(),
  sendAppointmentConfirmationSMS: jest.fn(),
  sendAppointmentReminderSMS: jest.fn(),
}));
jest.unstable_mockModule('../../services/notification/notificationDeliveryLedgerService.js', () => ({
  beginProviderAttempts: beginProviderAttemptsMock,
  recordProviderReceipt: recordProviderReceiptMock,
  applyProviderReceiptToCursor: applyProviderReceiptToCursorMock,
}));

const { deliverNotificationOutboxRow, resolveRecipientTokens } = await import(
  '../../utils/notifications/notificationOutboxDelivery.js'
);
const { __testing__: outboxInternals } = await import(
  '../../utils/notifications/notificationOutbox.js'
);

function row(overrides = {}) {
  return {
    id: 1001,
    tenant_id: TENANT_ID,
    type: 'lab_result_ready',
    recipient_id: 42,
    recipient_phone: '+919000000001',
    title: 'Lab results ready',
    body: 'Your lab results are ready.',
    payload: { tenant_id: TENANT_ID, booking_id: 17 },
    claim_token: CLAIM_TOKEN,
    claim_generation: 1,
    rendered_intent_hash: HASH,
    ...overrides,
  };
}

function attempt(channel, state = 'ready') {
  return {
    attempt_id: `${channel.padEnd(8, '0')}-0000-4000-8000-000000000001`,
    notification_outbox_id: 1001,
    channel,
    state,
  };
}

describe('notification outbox durable provider delivery', () => {
  beforeEach(() => {
    dispatchMock.mockReset();
    getTenantSettingsMock.mockReset();
    sendPushMock.mockReset();
    queryRawUnsafeMock.mockReset();
    beginProviderAttemptsMock.mockReset();
    recordProviderReceiptMock.mockReset();
    applyProviderReceiptToCursorMock.mockReset();
    loggerMock.info.mockReset();
    delete process.env.WHATSAPP_PROVIDER;
    delete process.env.VOICE_PROVIDER;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_WHATSAPP_FROM;
    delete process.env.TWILIO_VOICE_FROM;
    recordProviderReceiptMock.mockImplementation(async input => ({
      receipt_id: `receipt-${input.channel}`,
      ...input,
    }));
    applyProviderReceiptToCursorMock.mockResolvedValue({ state: 'ready' });
  });

  test('resolves push tokens only from FCM registries, never staff device-trust secrets', async () => {
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      if (/FROM users\b/.test(sql)) return [{ t: 'users-fcm-token' }];
      if (/FROM user_devices\b/.test(sql)) {
        return [{ t: 'user-device-fcm-token' }, { t: 'users-fcm-token' }];
      }
      if (/FROM staff_devices\b/.test(sql)) return [{ t: 'device-trust-auth-secret' }];
      return [];
    });

    await expect(resolveRecipientTokens('77', TENANT_ID)).resolves.toEqual([
      'users-fcm-token',
      'user-device-fcm-token',
    ]);

    const tokenQueries = queryRawUnsafeMock.mock.calls.map(([sql]) => sql);
    expect(tokenQueries).toHaveLength(2);
    expect(tokenQueries.join('\n')).not.toMatch(/staff_devices/i);
  });

  test('classifies an FCM registry read fault as uncertain instead of a clean missing-token rejection', async () => {
    getTenantSettingsMock.mockResolvedValue({});
    beginProviderAttemptsMock.mockResolvedValue([attempt('push')]);
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('database connection reset'));

    const result = await deliverNotificationOutboxRow(row());

    expect(result).toMatchObject({ outcome: 'uncertain', terminal: false });
    expect(sendPushMock).not.toHaveBeenCalled();
    expect(recordProviderReceiptMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'push',
      outcome: 'uncertain',
      providerCode: 'recipient_token_lookup_failed',
      receiptSource: 'transport_failure',
    }));
  });

  test('keeps a successful empty FCM registry lookup as a terminal missing-token rejection', async () => {
    getTenantSettingsMock.mockResolvedValue({});
    beginProviderAttemptsMock.mockResolvedValue([attempt('push')]);
    queryRawUnsafeMock.mockResolvedValue([]);

    const result = await deliverNotificationOutboxRow(row());

    expect(result).toMatchObject({ outcome: 'rejected', terminal: true });
    expect(sendPushMock).not.toHaveBeenCalled();
    expect(recordProviderReceiptMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'push',
      outcome: 'rejected',
      providerCode: 'fcm_token_missing',
      receiptSource: 'provider_response',
    }));
  });

  test('does not mark an ambiguous attempt-ledger failure as safe to release', async () => {
    getTenantSettingsMock.mockResolvedValue({});
    beginProviderAttemptsMock.mockRejectedValue(new Error('commit response lost'));

    const failure = await deliverNotificationOutboxRow(row()).catch(error => error);
    expect(failure).toMatchObject({ message: 'commit response lost' });
    expect(failure).not.toHaveProperty('notificationDeliveryPhase');
    expect(sendPushMock).not.toHaveBeenCalled();
  });

  test('starts append-only attempts before dispatch and records each physical provider result', async () => {
    getTenantSettingsMock.mockResolvedValue({
      notificationChannels: { results_ready: ['push', 'whatsapp', 'voice'] },
    });
    beginProviderAttemptsMock.mockResolvedValue([
      attempt('push'), attempt('whatsapp'), attempt('voice'),
    ]);
    dispatchMock.mockResolvedValue({
      push: {
        outcome: 'acknowledged',
        providerReference: 'projects/test/messages/1',
        providerCode: 'accepted',
        evidence: { success_count: 1 },
      },
      whatsapp: {
        outcome: 'rejected', providerReference: null,
        providerCode: 'whatsapp_logged', evidence: {},
      },
      voice: {
        outcome: 'rejected', providerReference: null,
        providerCode: 'voice_logged', evidence: {},
      },
    });

    const result = await deliverNotificationOutboxRow(row());

    expect(beginProviderAttemptsMock).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      outboxId: 1001,
      claimToken: CLAIM_TOKEN,
      claimGeneration: 1,
      renderedIntentHash: HASH,
      channels: ['push', 'whatsapp', 'voice'],
    });
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: '42',
      channels: ['push', 'whatsapp', 'voice'],
      providerReceiptMode: true,
    }));
    expect(recordProviderReceiptMock).toHaveBeenCalledTimes(3);
    expect(applyProviderReceiptToCursorMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({
      mode: 'dispatcher',
      outcome: 'rejected',
      channels: ['push', 'whatsapp', 'voice'],
      tenantId: TENANT_ID,
    });
  });

  test('treats the legacy SMS dry-run as provider rejection, never local success', async () => {
    getTenantSettingsMock.mockResolvedValue({});
    beginProviderAttemptsMock.mockResolvedValue([attempt('sms')]);
    const result = await deliverNotificationOutboxRow(row({
      id: 1001,
      type: 'appointment_reminder',
      recipient_id: null,
      recipient_phone: '+919000000003',
    }));
    expect(result.outcome).toBe('rejected');
    expect(recordProviderReceiptMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'sms',
      outcome: 'rejected',
      providerCode: 'sms_gateway_not_configured',
      receiptSource: 'provider_response',
    }));
  });

  // Audit 2026-08-09 finding F7 — ties the two halves of the fix together:
  // an intent queued by utils/notifications/smsOutbox.js lands on the `sms`
  // channel, and draining that row produces an honest provider rejection
  // rather than a silent dry-run "success".
  test('a queuePatientSms-shaped intent drains to rejected(sms_gateway_not_configured)', async () => {
    const intent = outboxInternals.buildIntent({
      type: 'sms',
      tenantId: TENANT_ID,
      recipientId: 77,
      recipientPhone: '+919000000004',
      title: 'Investigation booking confirmed',
      body: 'Your investigation INV-5 is confirmed.',
      data: { type: 'investigation_confirmed', booking_id: '5' },
      templateVersion: 'sms.investigation_booking_confirmed.v1',
    });
    expect(intent.channel).toBe('sms');

    getTenantSettingsMock.mockResolvedValue({});
    beginProviderAttemptsMock.mockResolvedValue([attempt('sms')]);

    const result = await deliverNotificationOutboxRow(row({
      id: 1002,
      type: intent.type,
      recipient_id: intent.recipientId,
      recipient_phone: intent.recipientPhone,
      title: intent.title,
      body: intent.body,
      payload: { tenant_id: TENANT_ID, ...intent.data },
      rendered_intent_hash: intent.renderedIntentHash,
    }));

    expect(result.outcome).toBe('rejected');
    expect(result.mode).toBe('legacy');
    expect(recordProviderReceiptMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'sms',
      outcome: 'rejected',
      providerCode: 'sms_gateway_not_configured',
    }));
  });

  test('does not call a provider when the tenant/channel cursor is paused', async () => {
    getTenantSettingsMock.mockResolvedValue({
      notificationChannels: { results_ready: ['push'] },
    });
    beginProviderAttemptsMock.mockResolvedValue([{
      ...attempt('push', 'blocked'),
      reason: 'paused_uncertain',
      blockedOutboxId: 1000,
    }]);
    const result = await deliverNotificationOutboxRow(row());
    expect(result.outcome).toBe('deferred');
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(sendPushMock).not.toHaveBeenCalled();
    expect(recordProviderReceiptMock).not.toHaveBeenCalled();
  });

  test('does not turn a resolved transient FCM batch failure into terminal rejection', async () => {
    getTenantSettingsMock.mockResolvedValue({});
    beginProviderAttemptsMock.mockResolvedValue([attempt('push')]);
    queryRawUnsafeMock
      .mockResolvedValueOnce([{ t: 'fcm-token' }])
      .mockResolvedValueOnce([]);
    sendPushMock.mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      responses: [{ success: false, error: { code: 'messaging/server-unavailable' } }],
    });

    const result = await deliverNotificationOutboxRow(row());

    expect(result).toMatchObject({ outcome: 'uncertain', terminal: false });
    expect(recordProviderReceiptMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'push',
      outcome: 'uncertain',
      providerCode: 'fcm_no_acceptance_unresolved',
      receiptSource: 'transport_failure',
    }));
  });
});
