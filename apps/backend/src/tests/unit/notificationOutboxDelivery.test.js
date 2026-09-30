import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const CLAIM_TOKEN = '00000000-0000-4000-8000-000000000099';
const HASH = 'a'.repeat(64);

const dispatchMock = jest.fn();
const getTenantSettingsMock = jest.fn();
const sendPushMock = jest.fn();
const sendSmsMock = jest.fn();
const queryRawUnsafeMock = jest.fn();
const beginProviderAttemptsMock = jest.fn();
const recordProviderReceiptMock = jest.fn();
const applyProviderReceiptToCursorMock = jest.fn();
const setTenantMock = jest.fn(async (_tenantId, callback) => callback({
  $queryRawUnsafe: queryRawUnsafeMock,
}));
const loggerMock = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawUnsafeMock },
  setTenant: setTenantMock,
  // notificationOutbox.js (imported below for its intent builder) needs this
  // export to link, even though the builder itself never touches the DB.
  setTenantTx: jest.fn(async (_tenantId, callback) => callback({
    $queryRawUnsafe: queryRawUnsafeMock,
  })),
}));
jest.unstable_mockModule('../../lib/redis.js', () => ({ disconnectRedis: jest.fn() }));
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
  sendSMS: sendSmsMock,
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
    sendSmsMock.mockReset();
    // The provider seam's dry-run DEFAULT: nothing configured resolves to an
    // honest provider rejection (never a fake delivery).
    sendSmsMock.mockResolvedValue({
      outcome: 'rejected',
      providerReference: null,
      providerCode: 'sms_gateway_not_configured',
      evidence: { dry_run: true, reason: 'not_configured' },
    });
    queryRawUnsafeMock.mockReset();
    setTenantMock.mockClear();
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

  test('honours replay-only channels without exposing the routing control to providers', async () => {
    getTenantSettingsMock.mockResolvedValue({
      notificationChannels: { results_ready: ['push', 'whatsapp'] },
    });
    beginProviderAttemptsMock.mockResolvedValue([attempt('whatsapp')]);
    dispatchMock.mockResolvedValue({
      whatsapp: {
        outcome: 'acknowledged',
        providerReference: 'messages/replay-1',
        providerCode: 'accepted',
        evidence: {},
      },
    });

    await deliverNotificationOutboxRow(row({
      payload: {
        tenant_id: TENANT_ID,
        booking_id: 17,
        __delivery_channels: ['whatsapp'],
        __replay_chain_started_at_ms: Date.parse('2026-08-15T05:00:00.000Z'),
      },
    }));

    expect(beginProviderAttemptsMock).toHaveBeenCalledWith(expect.objectContaining({
      channels: ['whatsapp'],
    }));
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      channels: ['whatsapp'],
      data: { tenant_id: TENANT_ID, booking_id: 17 },
    }));
  });

  test('passes feed correlation only to the in-app persistence seam', async () => {
    getTenantSettingsMock.mockResolvedValue({
      notificationChannels: { results_ready: ['inapp'] },
    });
    beginProviderAttemptsMock.mockResolvedValue([attempt('inapp')]);
    dispatchMock.mockResolvedValue({
      inapp: {
        outcome: 'acknowledged',
        providerReference: 'notification:731',
        providerCode: 'precommitted',
        evidence: { notification_id: '731' },
      },
    });

    await deliverNotificationOutboxRow(row({
      payload: {
        tenant_id: TENANT_ID,
        booking_id: 17,
        __feed_notification_id: 731,
      },
    }));

    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      channels: ['inapp'],
      data: { tenant_id: TENANT_ID, booking_id: 17 },
      prePersistedInAppNotificationId: 731,
    }));
    expect(recordProviderReceiptMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'inapp',
      outcome: 'acknowledged',
      providerCode: 'precommitted',
    }));
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
    queryRawUnsafeMock.mockResolvedValue([{
      patient_id: '77', patient_uid: CLAIM_TOKEN, phone: '+919000000004',
    }]);

    const result = await deliverNotificationOutboxRow(row({
      id: 1002,
      type: intent.type,
      recipient_id: intent.recipientId,
      recipient_phone: intent.recipientPhone,
      title: intent.title,
      body: intent.body,
      payload: { tenant_id: TENANT_ID, ...intent.data },
      template_version: intent.templateVersion,
      rendered_intent_hash: intent.renderedIntentHash,
    }));

    expect(result.outcome).toBe('rejected');
    expect(result.mode).toBe('legacy');
    // The drain now calls the provider seam with delivery provenance so the
    // adapter can resolve tenant config + DLT template registration…
    expect(sendSmsMock).toHaveBeenCalledWith(
      intent.recipientPhone,
      expect.stringContaining(intent.body),
      expect.objectContaining({
        tenantId: TENANT_ID,
        templateVersion: 'sms.investigation_booking_confirmed.v1',
        outboxId: 1002,
      }),
    );
    // …and the dry-run default still records an honest provider rejection.
    expect(recordProviderReceiptMock).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'sms',
      outcome: 'rejected',
      providerCode: 'sms_gateway_not_configured',
    }));
  });

  describe('investigation booking SMS recipient binding at drain', () => {
    const patientUid = 'abcde123-1234-4123-8123-123456789abc';
    const currentPatient = { patient_id: '42', patient_uid: patientUid, phone: '+919000000001' };
    const bookingRow = (overrides = {}) => row({
      type: 'sms',
      template_version: 'sms.investigation_booking_confirmed.v1',
      source_event_key: 'investigation-booking-confirmed:17',
      payload: { type: 'investigation_confirmed', booking_id: '17' },
      ...overrides,
    });

    beforeEach(() => {
      getTenantSettingsMock.mockResolvedValue({});
      beginProviderAttemptsMock.mockResolvedValue([attempt('sms')]);
      queryRawUnsafeMock.mockResolvedValue([currentPatient]);
      sendSmsMock.mockResolvedValue({
        outcome: 'acknowledged', providerReference: 'test-provider-receipt',
        providerCode: 'accepted', evidence: {},
      });
    });

    test('rejects a queued phone that no longer belongs to the booking patient without retargeting', async () => {
      queryRawUnsafeMock.mockResolvedValue([{ ...currentPatient, phone: '+919000000002' }]);
      const result = await deliverNotificationOutboxRow(bookingRow());
      expect(result).toMatchObject({ outcome: 'rejected', terminal: true });
      expect(sendSmsMock).not.toHaveBeenCalled();
      expect(dispatchMock).not.toHaveBeenCalled();
      expect(recordProviderReceiptMock).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'sms', outcome: 'rejected', providerCode: 'booking_sms_recipient_mismatch',
        evidence: {},
      }));
      expect(applyProviderReceiptToCursorMock).toHaveBeenCalledWith({
        tenantId: TENANT_ID, receiptId: 'receipt-sms',
      });
    });

    test.each(['42', 42, 42n, '00042', patientUid, patientUid.toUpperCase()])(
      'accepts the current patient represented by %s', async recipientId => {
        const result = await deliverNotificationOutboxRow(bookingRow({ recipient_id: recipientId }));
        expect(result.outcome).toBe('acknowledged');
        expect(sendSmsMock).toHaveBeenCalledTimes(1);
        expect(setTenantMock).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
        const [sql, tenant, bookingId] = queryRawUnsafeMock.mock.calls[0];
        expect(tenant).toBe(TENANT_ID);
        expect(bookingId).toBe('17');
        expect(sql).toMatch(/b\.tenant_id = \$1::uuid/);
        expect(sql).toMatch(/p\.tenant_id = b\.tenant_id/);
        expect(sql).toMatch(/p\.role = 'PATIENT'/);
        expect(sql).toMatch(/p\.is_active = true/);
        expect(sql).toMatch(/p\.is_deleted = false/);
        expect(sql).toMatch(/p\.deleted_at IS NULL/);
        expect(sql).toMatch(/p\.merged_into_uid IS NULL/);
        expect(sql).toMatch(/p\.merged_at IS NULL/);
        expect(sql).toMatch(/p\.status = 'active'/);
      },
    );

    test.each(['9000000001', '919000000001', '+91 90000 00001', '09000000001', '(+91)-9000000001'])(
      'accepts equivalent provider-normalized phone %s without rewriting the immutable intent', async phone => {
        const result = await deliverNotificationOutboxRow(bookingRow({ recipient_phone: phone }));
        expect(result.outcome).toBe('acknowledged');
        expect(sendSmsMock.mock.calls[0][0]).toBe(phone);
      },
    );

    test('accepts a stored version-seven UUID without changing tenant UUID validation', async () => {
      const uid = '01234567-89ab-7cde-8123-0123456789ab';
      queryRawUnsafeMock.mockResolvedValue([{ ...currentPatient, patient_uid: uid }]);
      const result = await deliverNotificationOutboxRow(bookingRow({ recipient_id: uid.toUpperCase() }));
      expect(result.outcome).toBe('acknowledged');
      expect(sendSmsMock).toHaveBeenCalledTimes(1);
    });

    test.each([null, '', [], {}, '17suffix', '-17', '0', 1.5, Number.MAX_SAFE_INTEGER + 1, '9223372036854775808'])(
      'rejects malformed booking identity %s before lookup or send', async bookingId => {
        const result = await deliverNotificationOutboxRow(bookingRow({
          payload: { type: 'investigation_confirmed', booking_id: bookingId },
        }));
        expect(result).toMatchObject({ outcome: 'rejected', terminal: true });
        expect(queryRawUnsafeMock).not.toHaveBeenCalled();
        expect(sendSmsMock).not.toHaveBeenCalled();
      },
    );

    test('preserves PostgreSQL int8 booking identities beyond JavaScript safe integers', async () => {
      const result = await deliverNotificationOutboxRow(bookingRow({
        source_event_key: 'investigation-booking-confirmed:9223372036854775807:operator-replay:21',
        payload: { type: 'investigation_confirmed', booking_id: '9223372036854775807' },
      }));
      expect(result.outcome).toBe('acknowledged');
      expect(queryRawUnsafeMock.mock.calls[0][2]).toBe('9223372036854775807');
    });

    test.each(['investigation-booking-confirmed:18', 'investigation-result-ready:17suffix'])('rejects a conflicting source identity %s', async sourceEventKey => {
      const result = await deliverNotificationOutboxRow(bookingRow({ source_event_key: sourceEventKey }));
      expect(result).toMatchObject({ outcome: 'rejected', terminal: true });
      expect(queryRawUnsafeMock).not.toHaveBeenCalled();
      expect(sendSmsMock).not.toHaveBeenCalled();
    });

    test('does not revalidate unrelated SMS or alter its provider gate', async () => {
      const result = await deliverNotificationOutboxRow(bookingRow({
        template_version: 'sms.appointment_reminder.v1',
        source_event_key: 'appointment-reminder:17',
        payload: { type: 'appointment_reminder', appointment_id: '17' },
      }));
      expect(result.outcome).toBe('acknowledged');
      expect(queryRawUnsafeMock).not.toHaveBeenCalled();
      expect(sendSmsMock).toHaveBeenCalledTimes(1);
    });

    test.each([null, '', [], {}, '43', '42suffix', '0', Number.MAX_SAFE_INTEGER + 1,
      '01234567-89ab-7cde-8123-0123456789az', '01234567-89ab-7cde-8123-0123456789ab-extra'])(
      'rejects a missing, malformed or different recipient identity %s', async recipientId => {
        const result = await deliverNotificationOutboxRow(bookingRow({ recipient_id: recipientId }));
        expect(result).toMatchObject({ outcome: 'rejected', terminal: true });
        expect(sendSmsMock).not.toHaveBeenCalled();
      },
    );

    test.each([null, '', 'phone:9000000001', '+449000000001', [], {}])(
      'rejects malformed captured phones %s', async phone => {
        const result = await deliverNotificationOutboxRow(bookingRow({ recipient_phone: phone }));
        expect(result).toMatchObject({ outcome: 'rejected', terminal: true });
        expect(sendSmsMock).not.toHaveBeenCalled();
      },
    );

    test('keeps recipient lookup errors uncertain without persisting their potentially private text', async () => {
      queryRawUnsafeMock.mockRejectedValue(new Error('private phone +919000000001 database failure'));
      const result = await deliverNotificationOutboxRow(bookingRow());
      expect(result).toMatchObject({ outcome: 'uncertain', terminal: false });
      expect(sendSmsMock).not.toHaveBeenCalled();
      expect(recordProviderReceiptMock).toHaveBeenCalledWith(expect.objectContaining({
        outcome: 'uncertain', providerCode: 'booking_sms_recipient_lookup_failed',
        receiptSource: 'transport_failure', evidence: {},
      }));
    });

    test('rejects a missing or no-longer-active tenant patient binding', async () => {
      queryRawUnsafeMock.mockResolvedValue([]);
      const result = await deliverNotificationOutboxRow(bookingRow());
      expect(result).toMatchObject({ outcome: 'rejected', terminal: true });
      expect(sendSmsMock).not.toHaveBeenCalled();
    });

    test.each([
      { template_version: null, source_event_key: null },
      { payload: { booking_id: '17' }, source_event_key: null },
      { payload: { booking_id: '17' }, template_version: null },
      { payload: { booking_id: '17' }, template_version: null, source_event_key: 'investigation-result-ready:17:auto-replay:22:hash' },
      { payload: { type: 'investigation_result_ready', booking_id: '17' }, template_version: null, source_event_key: null },
    ])('recognizes each durable booking signal independently %#', async overrides => {
      queryRawUnsafeMock.mockResolvedValue([{ ...currentPatient, phone: '+919000000002' }]);
      const result = await deliverNotificationOutboxRow(bookingRow(overrides));
      expect(result).toMatchObject({ outcome: 'rejected', terminal: true });
      expect(sendSmsMock).not.toHaveBeenCalled();
    });

    describe.each([
      ['row uppercase', 'INVESTIGATION_RESULT_READY', null],
      ['row padded', ' INVESTIGATION_RESULT_READY ', null],
      ['payload uppercase', 'sms', 'INVESTIGATION_CONFIRMED'],
      ['payload padded', 'sms', ' INVESTIGATION_RESULT_READY '],
    ])('normalized booking type: %s', (_label, type, payloadType) => {
      const normalizedTypeRow = (bookingId = '17') => bookingRow({
        type,
        template_version: 'sms.v1', source_event_key: 'direct:synthetic-generic',
        payload: { booking_id: bookingId, ...(payloadType ? { type: payloadType } : {}) },
      });

      beforeEach(() => {
        getTenantSettingsMock.mockResolvedValue({ notificationChannels: { results_ready: ['sms'] } });
        dispatchMock.mockResolvedValue({ sms: {
          outcome: 'acknowledged', providerReference: 'dispatcher-provider-receipt',
          providerCode: 'accepted', evidence: {},
        } });
      });

      test('validates and sends the unchanged authorized intent', async () => {
        const result = await deliverNotificationOutboxRow(normalizedTypeRow());
        expect(result.outcome).toBe('acknowledged');
        expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
        expect(sendSmsMock).toHaveBeenCalledWith('+919000000001', expect.any(String), expect.objectContaining({ templateVersion: 'sms.v1' }));
        expect(dispatchMock).not.toHaveBeenCalled();
      });

      test('rejects a stale phone rather than bypassing into either provider route', async () => {
        queryRawUnsafeMock.mockResolvedValue([{ ...currentPatient, phone: '+919000000002' }]);
        const result = await deliverNotificationOutboxRow(normalizedTypeRow());
        expect(result).toMatchObject({ outcome: 'rejected', terminal: true });
        expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
        expect(sendSmsMock).not.toHaveBeenCalled();
        expect(dispatchMock).not.toHaveBeenCalled();
      });

      test('rejects missing booking authority despite generic template and source metadata', async () => {
        const result = await deliverNotificationOutboxRow(normalizedTypeRow(null));
        expect(result).toMatchObject({ outcome: 'rejected', terminal: true });
        expect(queryRawUnsafeMock).not.toHaveBeenCalled();
        expect(sendSmsMock).not.toHaveBeenCalled();
        expect(dispatchMock).not.toHaveBeenCalled();
      });
    });

    test('does not let tenant dispatch retarget a valid booking SMS while other channels remain unchanged', async () => {
      getTenantSettingsMock.mockResolvedValue({ notificationChannels: { results_ready: ['sms', 'push'] } });
      beginProviderAttemptsMock.mockResolvedValue([attempt('sms'), attempt('push')]);
      dispatchMock.mockResolvedValue({ push: {
        outcome: 'acknowledged', providerReference: 'push-receipt', providerCode: 'accepted', evidence: {},
      } });
      const result = await deliverNotificationOutboxRow(bookingRow({ type: 'lab_result_ready' }));
      expect(result).toMatchObject({ mode: 'dispatcher', outcome: 'acknowledged' });
      expect(sendSmsMock).toHaveBeenCalledWith('+919000000001', expect.any(String), expect.any(Object));
      expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ channels: ['push'] }));
      expect(recordProviderReceiptMock).toHaveBeenCalledTimes(2);
    });

    test('rejects only the stale SMS when a tenant-dispatched replay also carries push', async () => {
      getTenantSettingsMock.mockResolvedValue({ notificationChannels: { results_ready: ['sms', 'push'] } });
      beginProviderAttemptsMock.mockResolvedValue([attempt('sms'), attempt('push')]);
      queryRawUnsafeMock.mockResolvedValue([{ ...currentPatient, phone: '+919000000002' }]);
      dispatchMock.mockResolvedValue({ push: {
        outcome: 'acknowledged', providerReference: 'push-receipt', providerCode: 'accepted', evidence: {},
      } });
      const result = await deliverNotificationOutboxRow(bookingRow({
        type: 'lab_result_ready', payload: {
          booking_id: '17', __delivery_channels: ['sms', 'push'],
        },
      }));
      expect(result).toMatchObject({ outcome: 'rejected', terminal: true });
      expect(sendSmsMock).not.toHaveBeenCalled();
      expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({ channels: ['push'] }));
    });

    test.each(['blocked', 'acknowledged'])('does not revalidate or resend an already %s attempt', async state => {
      beginProviderAttemptsMock.mockResolvedValue([attempt('sms', state)]);
      await deliverNotificationOutboxRow(bookingRow());
      expect(queryRawUnsafeMock).not.toHaveBeenCalled();
      expect(sendSmsMock).not.toHaveBeenCalled();
      expect(recordProviderReceiptMock).not.toHaveBeenCalled();
    });
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
