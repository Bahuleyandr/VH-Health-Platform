import { jest } from '@jest/globals';

// Findings:
//   2026-05-09-inpatient-admission-patient-no-smartphone-no-alternative-channel
//   2026-05-09-lab-walk-in-patient-no-smartphone-no-alternative
// Rural / feature-phone patients had no non-app delivery path. The fix
// adds a `users.preferred_channel` preference plus SMS / print channels
// to the dispatcher. `resolveDeliveryChannels` is the pure mapping from
// the stored preference to the dispatcher channel list — this pins that
// contract so a feature-phone patient never silently falls back to a
// push that can't land.

const mockPrisma = { $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() };
const sendEmailMock = jest.fn();
const queueMock = jest.fn();
const sendPushMock = jest.fn();
const placeVoiceCallMock = jest.fn();
const sendWhatsAppMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  setTenantTx: async (_tenantId, fn) => fn(mockPrisma),
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../../utils/notifications/sendEmailNotification.js', () => ({
  sendEmail: sendEmailMock,
}));
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: queueMock },
  default: { queue: queueMock },
}));
jest.unstable_mockModule('../../utils/notifications/sendPushNotification.js', () => ({
  sendPushNotification: sendPushMock,
}));
jest.unstable_mockModule('../../utils/notifications/sendVoiceNotification.js', () => ({
  placeVoiceCall: placeVoiceCallMock,
}));
jest.unstable_mockModule('../../utils/notifications/sendWhatsAppNotification.js', () => ({
  sendWhatsApp: sendWhatsAppMock,
}));

const { dispatch, resolveDeliveryChannels } = await import(
  '../../utils/notifications/notificationDispatcher.js'
);
const { runInTenantContext } = await import('../../lib/tenantContext.js');

describe('resolveDeliveryChannels — preferred_channel → dispatcher channels', () => {
  it('routes a feature-phone patient (sms) to SMS, never a silent push', () => {
    const channels = resolveDeliveryChannels('sms');
    expect(channels).toEqual(['sms', 'inapp']);
    expect(channels).not.toContain('push');
  });

  it('routes a no-phone patient (print) to a printed handout', () => {
    const channels = resolveDeliveryChannels('print');
    expect(channels).toEqual(['print', 'inapp']);
    expect(channels).not.toContain('push');
  });

  it('keeps an opted-out patient (none) to in-app only — no outbound contact', () => {
    expect(resolveDeliveryChannels('none')).toEqual(['inapp']);
  });

  it('defaults a smartphone patient (app) to push + in-app', () => {
    expect(resolveDeliveryChannels('app')).toEqual(['push', 'inapp']);
  });

  it('falls back to the app default for null / unknown preferences', () => {
    expect(resolveDeliveryChannels(null)).toEqual(['push', 'inapp']);
    expect(resolveDeliveryChannels(undefined)).toEqual(['push', 'inapp']);
    expect(resolveDeliveryChannels('garbage')).toEqual(['push', 'inapp']);
  });

  it('is case-insensitive on the stored preference', () => {
    expect(resolveDeliveryChannels('SMS')).toEqual(['sms', 'inapp']);
    expect(resolveDeliveryChannels('Print')).toEqual(['print', 'inapp']);
  });
});

// The in-app row is the sink CRITICAL vital-sign alerts land in. Its
// `tenant_id` column DEFAULT reads app.current_tenant_id and falls back to the
// LITERAL default tenant whenever that GUC is unset — which is every path
// outside a request with RLS enforcement on. A row stamped with the default
// tenant is invisible to the recipient, whose reader filters on tenant_id. So
// the tenant must be bound as a parameter, and a recipient who resolves into a
// different tenant than the dispatch context must be refused rather than
// written into either one.
describe('in-app channel binds tenant_id explicitly', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';

  const userRow = tenantId => ({
    id: 41,
    uid: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    phone: '+919000000001',
    email: 'patient@example.test',
    name: 'Patient',
    device_token: null,
    preferred_channel: 'app',
    tenant_id: tenantId,
  });

  beforeEach(() => {
    mockPrisma.$queryRawUnsafe.mockReset();
  });

  function inAppInsertCall() {
    return mockPrisma.$queryRawUnsafe.mock.calls.find(
      ([sql]) => /INSERT\s+INTO\s+notifications\b/i.test(String(sql)),
    );
  }

  it('names tenant_id and binds the dispatch context tenant', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([userRow(TENANT)]);

    const result = await runInTenantContext(TENANT, () => dispatch({
      userId: '41',
      title: 'CRITICAL Vital Alert',
      body: 'SpO2 82%',
      channels: ['inapp'],
      type: 'clinical_alert',
    }));

    expect(result.inapp).toBe('stored');
    const call = inAppInsertCall();
    expect(call).toBeDefined();
    expect(call[0]).toMatch(/INSERT INTO notifications \(tenant_id,/);
    // The tenant travels as a bound parameter, not as session state.
    expect(call.slice(1)).toContain(TENANT);
  });

  it('falls back to the recipient row tenant under a super-admin/cron context', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([userRow(OTHER_TENANT)]);

    // No tenant context at all — the cron / bootstrap shape.
    const result = await dispatch({
      userId: '41', title: 'Result ready', body: 'Report published',
      channels: ['inapp'],
    });

    expect(result.inapp).toBe('stored');
    expect(inAppInsertCall().slice(1)).toContain(OTHER_TENANT);
  });

  it('refuses terminally when the recipient belongs to another tenant', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([userRow(OTHER_TENANT)]);

    const result = await runInTenantContext(TENANT, () => dispatch({
      userId: '41', title: 'Cross-tenant', body: 'Must not be written',
      channels: ['inapp'],
      providerReceiptMode: true,
    }));

    expect(result.inapp).toMatchObject({
      outcome: 'rejected',
      providerCode: 'recipient_tenant_mismatch',
    });
    // Nothing was written into either tenant.
    expect(inAppInsertCall()).toBeUndefined();
  });

  // The outbox drain re-enters dispatch() with the OUTBOX ROW's type. For an
  // appointment reminder that type is the transport/template identity
  // `appointment_reminder_24h`, which is a transport alias rather than a
  // canonical action in the generated patient contract. The row must carry
  // the canonical inbox type.
  it('writes the routed inbox type for a suffixed reminder transport type', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([userRow(TENANT)]);

    await runInTenantContext(TENANT, () => dispatch({
      userId: '41',
      title: 'Appointment Tomorrow',
      body: 'Your appointment is tomorrow at 10:30',
      channels: ['inapp'],
      type: 'appointment_reminder_24h',
    }));

    const call = inAppInsertCall();
    expect(call).toBeDefined();
    // Params are (user.id, user.uid, user.phone, title, body, type, tenantId).
    expect(call[6]).toBe('appointment_reminder');
  });

  it('leaves a type the inbox already routes untouched', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([userRow(TENANT)]);

    await runInTenantContext(TENANT, () => dispatch({
      userId: '41',
      title: 'Lab results ready',
      body: 'Your lab results are ready to view.',
      channels: ['inapp'],
      type: 'lab_result_ready',
    }));

    expect(inAppInsertCall()[6]).toBe('lab_result_ready');
  });

  it('receipts a matching precommitted feed row without inserting a duplicate', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([userRow(TENANT)])
      .mockResolvedValueOnce([{ id: 731 }]);

    const result = await runInTenantContext(TENANT, () => dispatch({
      userId: '41',
      title: 'New report available',
      body: 'Open VH Health to securely view your latest report.',
      channels: ['inapp'],
      type: 'diagnostic_result_ready',
      providerReceiptMode: true,
      prePersistedInAppNotificationId: 731,
    }));

    expect(result.inapp).toEqual({
      outcome: 'acknowledged',
      providerReference: 'notification:731',
      providerCode: 'precommitted',
      evidence: { notification_id: '731', persistence: 'precommitted' },
    });
    expect(inAppInsertCall()).toBeUndefined();
    const verification = mockPrisma.$queryRawUnsafe.mock.calls[1];
    expect(String(verification[0])).toMatch(/AND type = \$5::text[\s\S]*AND title = \$6::text[\s\S]*AND body = \$7::text/);
    expect(verification.slice(1)).toEqual([
      731,
      TENANT,
      41,
      userRow(TENANT).uid,
      'diagnostic_result_ready',
      'New report available',
      'Open VH Health to securely view your latest report.',
    ]);
  });

  it('fails uncertain when a feed correlation does not match the intended row', async () => {
    mockPrisma.$queryRawUnsafe
      .mockResolvedValueOnce([userRow(TENANT)])
      .mockResolvedValueOnce([]);

    const result = await runInTenantContext(TENANT, () => dispatch({
      userId: '41',
      title: 'New report available',
      body: 'Open VH Health to securely view your latest report.',
      channels: ['inapp'],
      type: 'diagnostic_result_ready',
      providerReceiptMode: true,
      prePersistedInAppNotificationId: 731,
    }));

    expect(result.inapp).toMatchObject({
      outcome: 'uncertain',
      providerCode: 'inapp_commit_failed',
    });
    expect(inAppInsertCall()).toBeUndefined();
  });
});

describe('dispatcher provider receipt mode', () => {
  beforeEach(() => {
    mockPrisma.$queryRawUnsafe.mockReset();
    sendEmailMock.mockReset();
    sendPushMock.mockReset();
    placeVoiceCallMock.mockReset();
    sendWhatsAppMock.mockReset();
    queueMock.mockReset();
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{
      id: 41,
      uid: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      phone: '+919000000001',
      email: 'patient@example.test',
      name: 'Patient',
      device_token: 'fcm-token',
      preferred_channel: 'app',
    }]);
  });

  it('retains FCM message IDs and SMTP acceptance as durable acknowledgement evidence', async () => {
    sendPushMock.mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true, messageId: 'projects/test/messages/1' }],
    });
    sendEmailMock.mockResolvedValue({
      messageId: '<smtp-message-1@example.test>',
      accepted: ['patient@example.test'],
      rejected: [],
      response: '250 queued',
    });
    const result = await dispatch({
      userId: '41',
      title: 'Provider receipts',
      body: 'Exact evidence',
      channels: ['push', 'email'],
      providerReceiptMode: true,
    });
    expect(result.push).toMatchObject({
      outcome: 'acknowledged',
      providerReference: 'projects/test/messages/1',
      evidence: { success_count: 1, failure_count: 0 },
    });
    expect(result.email).toMatchObject({
      outcome: 'acknowledged',
      providerReference: '<smtp-message-1@example.test>',
      evidence: { response: '250 queued' },
    });
    expect(sendEmailMock).toHaveBeenCalledWith(expect.objectContaining({ receiptMode: true }));
  });

  it('does not mislabel missing providers or logger-only Twilio paths as sent', async () => {
    sendEmailMock.mockResolvedValue({
      outcome: 'rejected', code: 'smtp_not_configured', messageId: null,
    });
    sendWhatsAppMock.mockResolvedValue({ status: 'logged' });
    placeVoiceCallMock.mockResolvedValue({ status: 'invalid_phone' });
    const result = await dispatch({
      userId: '41',
      title: 'Provider unavailable',
      body: 'Must be rejected',
      channels: ['email', 'whatsapp', 'voice', 'sms', 'print'],
      providerReceiptMode: true,
    });
    expect(result.email).toMatchObject({ outcome: 'rejected', providerCode: 'smtp_not_configured' });
    expect(result.whatsapp).toMatchObject({ outcome: 'rejected', providerCode: 'whatsapp_logged' });
    expect(result.voice).toMatchObject({ outcome: 'rejected', providerCode: 'voice_invalid_phone' });
    expect(result.sms).toMatchObject({ outcome: 'rejected', providerCode: 'sms_gateway_not_configured' });
    expect(result.print).toMatchObject({ outcome: 'rejected', providerCode: 'print_queue_not_configured' });
    expect(queueMock).not.toHaveBeenCalled();
  });

  it('classifies thrown transport failures as uncertain rather than rejected', async () => {
    const error = Object.assign(new Error('socket closed after write'), { code: 'ECONNRESET' });
    sendPushMock.mockRejectedValue(error);
    const result = await dispatch({
      userId: '41',
      title: 'Ambiguous send',
      body: 'Outcome unknown',
      channels: ['push'],
      providerReceiptMode: true,
    });
    expect(result.push).toMatchObject({
      outcome: 'uncertain',
      providerCode: 'ECONNRESET',
      evidence: { message: 'socket closed after write' },
    });
  });

  it('keeps resolved FCM transient failures uncertain so critical pushes are retried safely', async () => {
    sendPushMock.mockResolvedValue({
      successCount: 0,
      failureCount: 1,
      responses: [{
        success: false,
        error: { code: 'messaging/internal-error', message: 'FCM unavailable' },
      }],
    });
    const result = await dispatch({
      userId: '41',
      title: 'Transient failure',
      body: 'Must not dead-letter',
      channels: ['push'],
      providerReceiptMode: true,
    });
    expect(result.push).toMatchObject({
      outcome: 'uncertain',
      providerCode: 'fcm_no_acceptance_unresolved',
    });
  });

  it('terminally rejects only when every FCM token is permanently invalid', async () => {
    sendPushMock.mockResolvedValue({
      successCount: 0,
      failureCount: 2,
      responses: [
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        { success: false, error: { code: 'messaging/invalid-registration-token' } },
      ],
    });
    const result = await dispatch({
      userId: '41',
      title: 'Invalid tokens',
      body: 'Permanent recipient failure',
      channels: ['push'],
      providerReceiptMode: true,
    });
    expect(result.push).toMatchObject({
      outcome: 'rejected',
      providerCode: 'fcm_all_tokens_invalid',
    });
  });

  it('terminally rejects the normalized sendPushNotification failure envelope', async () => {
    sendPushMock.mockResolvedValue({
      successCount: 0,
      failureCount: 2,
      responses: [
        {
          tokenIndex: 0,
          success: false,
          messageId: null,
          errorCode: 'messaging/registration-token-not-registered',
          errorMessage: 'gone',
        },
        {
          tokenIndex: 1,
          success: false,
          messageId: null,
          errorCode: 'messaging/invalid-registration-token',
          errorMessage: 'bad',
        },
      ],
    });

    const result = await dispatch({
      userId: '41',
      title: 'Permanent recipient failure',
      body: 'Normalized provider response',
      channels: ['push'],
      providerReceiptMode: true,
    });

    expect(result.push).toMatchObject({
      outcome: 'rejected',
      providerCode: 'fcm_all_tokens_invalid',
    });
  });
});
