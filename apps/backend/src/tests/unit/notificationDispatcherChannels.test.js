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
});
