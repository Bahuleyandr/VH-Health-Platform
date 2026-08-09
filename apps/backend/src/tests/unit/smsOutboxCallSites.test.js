// Audit 2026-08-09 finding F7 — every patient-facing SMS call site must
// record a notification-outbox intent instead of calling the dry-run
// smsService, and must not report a delivery it did not make.

import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const prismaDouble = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $executeRawUnsafe: executeRawUnsafeMock,
};

const queuePatientSmsMock = jest.fn();
const queueAppointmentReminderSmsMock = jest.fn();
const sendPushNotificationMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn();
const loggerMock = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaDouble,
  setTenantTx: async (_tenantId, fn) => fn(prismaDouble),
  setTenant: async (_tenantId, fn) => fn(prismaDouble),
}));
jest.unstable_mockModule('../../lib/tenantContext.js', () => ({
  runWithSuperAdmin: async fn => fn(),
  runInTenantContext: async (_tenantId, fn) => fn(),
  getCurrentTenantId: () => TENANT_ID,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../../utils/notifications/smsOutbox.js', () => ({
  queuePatientSms: queuePatientSmsMock,
  queueAppointmentReminderSms: queueAppointmentReminderSmsMock,
  queueAppointmentConfirmationSms: jest.fn(async () => ({ queued: true, outboxId: 1 })),
}));
jest.unstable_mockModule('../../utils/notifications/sendPushNotification.js', () => ({
  sendPushNotification: sendPushNotificationMock,
}));
jest.unstable_mockModule('../../services/notification/staffNotificationService.js', () => ({
  sendStaffNotifications: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
}));
jest.unstable_mockModule('../../services/notification/staffPushRecipientService.js', () => ({
  resolveStaffPushRecipients: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../observability/staffPushFanoutMetrics.js', () => ({
  recordStaffPushFanoutFailure: jest.fn(),
}));
jest.unstable_mockModule('../../utils/r2Storage.js', () => ({
  uploadFileToR2: jest.fn(),
  getSignedFileUrl: jest.fn(async () => 'https://signed'),
  deleteObject: jest.fn(),
}));
jest.unstable_mockModule('../../utils/phoneUtils.js', () => ({
  normalizePhone: s => s,
}));
jest.unstable_mockModule('../../controllers/delivery/deliveryTrackingController.js', () => ({
  calculateETA: jest.fn(() => ({ estimated_mins: 30, distance_km: 2 })),
}));

const { sendInvestigationNotifications } = await import(
  '../../utils/notifications/InvestigationNotificationJob.js'
);
const { sendTimedReminders } = await import(
  '../../utils/notifications/appointmentReminderJob.js'
);
const { sendSMSWithRetry, retryFailedNotifications } = await import(
  '../../services/notificationRetryService.js'
);
const { confirmBooking } = await import(
  '../../controllers/investigation/bookingController.js'
);

/** Let a `setImmediate` notification tail and its awaited mocks settle. */
async function flushNotificationTail() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise(resolve => { setImmediate(resolve); });
  }
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockReset();
  queuePatientSmsMock.mockReset();
  queueAppointmentReminderSmsMock.mockReset();
  sendPushNotificationMock.mockReset();
  recordCanonicalClinicalEventMock.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
  queuePatientSmsMock.mockResolvedValue({ queued: true, outboxId: 11, duplicate: false, reason: null });
  queueAppointmentReminderSmsMock.mockResolvedValue({ queued: true, outboxId: 12 });
  sendPushNotificationMock.mockResolvedValue({ successCount: 1, failureCount: 0, responses: [] });
  queryRawUnsafeMock.mockResolvedValue([]);
});

describe('investigation report notification job', () => {
  it('queues the SMS intent with the patient tenant instead of sending', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 501, test_name: 'CBC', patient_id: 77, name: 'Asha',
        phone: '9000000001', device_token: null, user_id: 77, tenant_id: TENANT_ID,
      }])
      .mockResolvedValue([]);

    await sendInvestigationNotifications();

    expect(queuePatientSmsMock).toHaveBeenCalledTimes(1);
    expect(queuePatientSmsMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      recipientId: 77,
      recipientPhone: '9000000001',
      sourceEventKey: 'investigation-report-ready:501',
    }));
  });

  it('logs the intent as queued, never as sent', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 501, test_name: 'CBC', patient_id: 77, name: 'Asha',
        phone: '9000000001', device_token: null, user_id: 77, tenant_id: TENANT_ID,
      }])
      .mockResolvedValue([]);

    await sendInvestigationNotifications();

    const smsLogs = loggerMock.info.mock.calls
      .map(args => String(args[0]))
      .filter(line => line.includes('SMS'));
    expect(smsLogs).toHaveLength(1);
    expect(smsLogs[0]).toContain('SMS intent queued');
    expect(smsLogs[0]).not.toMatch(/SMS sent/);
  });
});

describe('appointment reminder job', () => {
  it('queues 24h and 1h reminder intents with tenant + recipient provenance', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 31, tenant_id: TENANT_ID, appointment_time: '10:30', token_number: 4,
        patient_user_id: 77, patient_name: 'Asha', patient_phone: '9000000001',
        device_token: null, doctor_name: 'Rao', department: 'Cardiology',
      }])
      .mockResolvedValueOnce([{
        id: 32, tenant_id: TENANT_ID, appointment_time: '11:30', token_number: 5,
        patient_user_id: 78, patient_name: 'Bala', patient_phone: '9000000002',
        device_token: null, doctor_user_id: null, doctor_uid: null,
        doctor_name: 'Rao', department: 'Cardiology',
      }])
      .mockResolvedValue([]);

    await sendTimedReminders();

    expect(queueAppointmentReminderSmsMock).toHaveBeenCalledTimes(2);
    expect(queueAppointmentReminderSmsMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      tenantId: TENANT_ID, recipientId: 77, hoursAhead: 24, appointmentId: 31,
    }));
    expect(queueAppointmentReminderSmsMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      tenantId: TENANT_ID, recipientId: 78, hoursAhead: 1, appointmentId: 32,
    }));
  });

  it('does not report reminders as sent', async () => {
    queryRawUnsafeMock.mockResolvedValue([]);
    await sendTimedReminders();
    const lines = loggerMock.info.mock.calls.map(args => String(args[0]));
    expect(lines.some(line => /reminders sent/.test(line))).toBe(false);
    expect(lines.some(line => /reminders processed/.test(line))).toBe(true);
  });
});

describe('notification retry service', () => {
  it('hands an SMS intent to the outbox rather than the dry-run sender', async () => {
    await sendSMSWithRetry('9000000001', 'Body text', '00000000-0000-4000-8000-0000000000aa');

    expect(queuePatientSmsMock).toHaveBeenCalledWith(expect.objectContaining({
      recipientPhone: '9000000001',
      body: 'Body text',
    }));
    // Nothing lands in the legacy backoff table when the outbox accepted it.
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('falls back to the legacy backoff table when the outbox cannot record it', async () => {
    queuePatientSmsMock.mockResolvedValue({ queued: false, outboxId: null, reason: 'queue_failed' });
    executeRawUnsafeMock.mockResolvedValue(1);

    await sendSMSWithRetry('9000000001', 'Body text', null);

    expect(executeRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(String(executeRawUnsafeMock.mock.calls[0][0])).toContain('INSERT INTO failed_notifications');
  });

  it('retries a pending SMS row into the outbox and never marks it sent', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 9, user_id: 77, phone: '9000000001', device_token: null,
        title: 'Notification', body: 'Body text', type: 'sms', data: null,
        error_message: null, retry_count: 0, max_retries: 4,
        last_retry_at: null, created_at: new Date(), tenant_id: TENANT_ID,
      }])
      .mockResolvedValue([]);
    executeRawUnsafeMock.mockResolvedValue(1);

    await retryFailedNotifications();

    expect(queuePatientSmsMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID, recipientId: 77, recipientPhone: '9000000001',
    }));
    const statusWrites = executeRawUnsafeMock.mock.calls.map(args => String(args[0]));
    expect(statusWrites.join('\n')).toContain("status='queued_outbox'");
    expect(statusWrites.join('\n')).not.toContain("status='sent'");
  });
});

describe('investigation booking confirmation', () => {
  it('queues the confirmation SMS intent scoped to the booking tenant', async () => {
    recordCanonicalClinicalEventMock.mockResolvedValue({
      timeline: { id: 1 }, audit: { id: 2 },
    });
    queryRawUnsafeMock
      // controller: load the booking
      .mockResolvedValueOnce([{
        id: 5, booking_number: 'INV-5', investigation_id: 9, patient_id: 77,
        patient_name: 'Asha', patient_phone: '9000000001', test_name: 'CBC',
        collection_type: 'home', status: 'BOOKED', tenant_id: TENANT_ID,
      }])
      // tx: UPDATE ... RETURNING
      .mockResolvedValueOnce([{
        id: 5, booking_number: 'INV-5', investigation_id: 9, patient_id: 77,
        patient_name: 'Asha', status: 'CONFIRMED', final_cost: 450,
        tenant_id: TENANT_ID,
      }])
      // tx: INSERT history
      .mockResolvedValueOnce([])
      // tx: patient uid lookup for the canonical event
      .mockResolvedValueOnce([{ uid: '00000000-0000-4000-8000-0000000000bb' }])
      // notification tail: patient contact lookup
      .mockResolvedValueOnce([{ device_token: null, phone: '9000000001' }])
      .mockResolvedValue([]);

    const res = makeRes();
    await confirmBooking({
      params: { id: '5' },
      body: {},
      user: { id: 7, uid: 'staff-uid', role: 'LAB_STAFF' },
      tenantId: TENANT_ID,
    }, res);
    await flushNotificationTail();

    expect(res.status).toHaveBeenCalledWith(200);
    expect(queuePatientSmsMock).toHaveBeenCalledTimes(1);
    expect(queuePatientSmsMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      recipientId: 77,
      recipientPhone: '9000000001',
      sourceEventKey: 'investigation-booking-confirmed:5',
    }));
    expect(String(queuePatientSmsMock.mock.calls[0][0].body))
      .toContain('your investigation INV-5 is confirmed');
  });
});
