import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

const dispatchMock = jest.fn();
const getTenantSettingsMock = jest.fn();
const sendPushMock = jest.fn();
const sendSmsMock = jest.fn();
const queryRawUnsafeMock = jest.fn();
const loggerMock = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
  },
  setTenant: jest.fn(async (_tenantId, callback) => callback({
    $queryRawUnsafe: queryRawUnsafeMock,
  })),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: loggerMock,
}));

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
  __esModule: true,
  sendSMS: sendSmsMock,
  sendAppointmentConfirmationSMS: jest.fn(),
  sendAppointmentReminderSMS: jest.fn(),
  default: { sendSMS: sendSmsMock },
}));

const { deliverNotificationOutboxRow } = await import(
  '../../utils/notifications/notificationOutboxDelivery.js'
);

describe('notification outbox delivery channel fan-out', () => {
  beforeEach(() => {
    dispatchMock.mockReset();
    getTenantSettingsMock.mockReset();
    sendPushMock.mockReset();
    sendSmsMock.mockReset();
    queryRawUnsafeMock.mockReset();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
    loggerMock.error.mockReset();
    loggerMock.debug.mockReset();
    delete process.env.WHATSAPP_PROVIDER;
    delete process.env.VOICE_PROVIDER;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_WHATSAPP_FROM;
    delete process.env.TWILIO_VOICE_FROM;
  });

  it('routes configured results-ready rows through the dispatcher fan-out', async () => {
    getTenantSettingsMock.mockResolvedValue({
      notificationChannels: {
        results_ready: ['push', 'whatsapp', 'voice'],
      },
    });
    dispatchMock.mockResolvedValue({ push: 'sent', whatsapp: 'logged', voice: 'logged' });

    const result = await deliverNotificationOutboxRow({
      id: 1001,
      type: 'lab_result_ready',
      recipient_id: 42,
      recipient_phone: '+919000000001',
      title: 'Lab results ready',
      body: 'Your lab results are ready.',
      payload: { tenant_id: TENANT_ID, booking_id: 17 },
    });

    expect(result).toEqual({
      mode: 'dispatcher',
      channels: ['push', 'whatsapp', 'voice'],
      preferenceKey: 'results_ready',
      tenantId: TENANT_ID,
    });
    expect(dispatchMock).toHaveBeenCalledWith({
      userId: '42',
      title: 'Lab results ready',
      body: 'Your lab results are ready.',
      channels: ['push', 'whatsapp', 'voice'],
      data: { tenant_id: TENANT_ID, booking_id: 17 },
      type: 'lab_result_ready',
    });
    expect(sendPushMock).not.toHaveBeenCalled();
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith(
      'notification-outbox-drain: dry-run channel fan-out',
      expect.objectContaining({
        dry_run_channels: ['whatsapp', 'voice'],
        tenant_id: TENANT_ID,
        outbox_id: 1001,
      }),
    );
  });

  it('keeps prefs-unset result-ready rows on the legacy push path', async () => {
    getTenantSettingsMock.mockResolvedValue({});
    queryRawUnsafeMock.mockResolvedValue([]);
    sendPushMock.mockResolvedValue({ successCount: 0, failureCount: 0 });

    const result = await deliverNotificationOutboxRow({
      id: 1002,
      type: 'lab_result_ready',
      recipient_id: 43,
      recipient_phone: '+919000000002',
      title: 'Lab results ready',
      body: 'Your lab results are ready.',
      payload: { tenant_id: TENANT_ID, booking_id: 18 },
    });

    expect(result).toEqual({
      mode: 'legacy',
      channels: ['push'],
      preferenceKey: 'results_ready',
      tenantId: TENANT_ID,
    });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(sendPushMock).toHaveBeenCalledWith({
      tokens: [],
      title: 'Lab results ready',
      body: 'Your lab results are ready.',
      data: { tenant_id: TENANT_ID, booking_id: 18 },
      userId: 43,
    });
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it('keeps prefs-unset phone-only reminders on the legacy SMS path', async () => {
    getTenantSettingsMock.mockResolvedValue({});
    sendSmsMock.mockResolvedValue({ ok: true });

    const result = await deliverNotificationOutboxRow({
      id: 1003,
      type: 'appointment_reminder',
      recipient_id: null,
      recipient_phone: '+919000000003',
      title: 'Appointment reminder',
      body: 'Your appointment is tomorrow.',
      payload: { tenant_id: TENANT_ID, appointment_id: 19 },
    });

    expect(result).toEqual({
      mode: 'legacy',
      channels: ['sms'],
      preferenceKey: 'appointment_reminder',
      tenantId: TENANT_ID,
    });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(sendSmsMock).toHaveBeenCalledWith('+919000000003', 'Your appointment is tomorrow.');
    expect(sendPushMock).not.toHaveBeenCalled();
  });
});
