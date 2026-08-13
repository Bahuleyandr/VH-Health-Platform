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
const notificationOutboxQueueMock = jest.fn();
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
jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: notificationOutboxQueueMock },
  default: { queue: notificationOutboxQueueMock },
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
  notificationOutboxQueueMock.mockReset();
  sendPushNotificationMock.mockReset();
  recordCanonicalClinicalEventMock.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
  queuePatientSmsMock.mockResolvedValue({ queued: true, outboxId: 11, duplicate: false, reason: null });
  queueAppointmentReminderSmsMock.mockResolvedValue({ queued: true, outboxId: 12 });
  notificationOutboxQueueMock.mockResolvedValue({ id: 13, status: 'PENDING', duplicate: false });
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
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 501 }])
      .mockResolvedValue([]);

    await sendInvestigationNotifications();

    expect(queuePatientSmsMock).toHaveBeenCalledTimes(1);
    expect(queuePatientSmsMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      recipientId: 77,
      recipientPhone: '9000000001',
      sourceEventKey: 'investigation-report-ready:501',
    }));
    const insertCall = queryRawUnsafeMock.mock.calls.find(
      ([sql]) => String(sql).includes('INSERT INTO notifications'),
    );
    expect(String(insertCall?.[0])).toContain('tenant_id');
    expect(insertCall?.[1]).toBe(TENANT_ID);
    const stateCall = queryRawUnsafeMock.mock.calls.find(
      ([sql]) => String(sql).includes('UPDATE investigations'),
    );
    expect(String(stateCall?.[0])).toContain('tenant_id = $2::uuid');
    expect(stateCall?.[2]).toBe(TENANT_ID);
  });

  it('logs the intent as queued, never as sent', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 501, test_name: 'CBC', patient_id: 77, name: 'Asha',
        phone: '9000000001', device_token: null, user_id: 77, tenant_id: TENANT_ID,
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 501 }])
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
  function mockReminderQueries({ due24h = [], due1h = [] } = {}) {
    queryRawUnsafeMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('UPDATE appointments AS appointment')) return [];
      if (text.includes('appointment.reminder_24h_sent IS NOT TRUE')) return due24h;
      if (text.includes('appointment.reminder_1h_sent IS NOT TRUE')) return due1h;
      return [];
    });
  }

  it('queues 24h and 1h reminder intents with tenant + recipient provenance', async () => {
    mockReminderQueries({
      due24h: [{
        id: 31, tenant_id: TENANT_ID, appointment_time: '10:30', token_number: 4,
        patient_user_id: 77, patient_name: 'Asha', patient_phone: '9000000001',
        doctor_name: 'Rao', department: 'Cardiology',
      }],
      due1h: [{
        id: 32, tenant_id: TENANT_ID, appointment_time: '11:30', token_number: 5,
        patient_user_id: 78, patient_name: 'Bala', patient_phone: '9000000002',
        doctor_user_id: null, doctor_uid: null,
        doctor_name: 'Rao', department: 'Cardiology',
      }],
    });

    await sendTimedReminders({ tenantId: TENANT_ID, now: new Date('2030-01-01T04:00:00Z') });

    expect(queueAppointmentReminderSmsMock).toHaveBeenCalledTimes(2);
    expect(queueAppointmentReminderSmsMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      tenantId: TENANT_ID, recipientId: 77, hoursAhead: 24, appointmentId: 31,
    }));
    expect(queueAppointmentReminderSmsMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      tenantId: TENANT_ID, recipientId: 78, hoursAhead: 1, appointmentId: 32,
    }));
    expect(notificationOutboxQueueMock).toHaveBeenCalledTimes(2);
    expect(notificationOutboxQueueMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      tenantId: TENANT_ID,
      recipientId: 77,
      channel: 'push',
      sourceEventKey: 'appointment-reminder-24h:31',
    }));
    expect(notificationOutboxQueueMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      tenantId: TENANT_ID,
      recipientId: 78,
      channel: 'push',
      sourceEventKey: 'appointment-reminder-1h:32',
    }));
  });

  it('uses tenant-local appointment instants and half-open 24h/1h windows', async () => {
    mockReminderQueries();

    await sendTimedReminders({ tenantId: TENANT_ID, now: new Date('2030-01-01T04:00:00Z') });

    const selectCalls = queryRawUnsafeMock.mock.calls.filter(
      ([sql]) => String(sql).includes('FROM appointments AS appointment'),
    );
    expect(selectCalls).toHaveLength(2);
    for (const [sql, tenantId, fallbackTimezone, from, until] of selectCalls) {
      expect(String(sql)).toContain('appointment.appointment_date + appointment.appointment_time::time');
      expect(String(sql)).toContain('pg_timezone_names AS configured_timezone');
      expect(String(sql)).toContain('AT TIME ZONE tenant_clock.timezone');
      expect(String(sql)).toContain('appointment_at >= $3::timestamptz');
      expect(String(sql)).toContain('appointment_at < $4::timestamptz');
      expect(String(sql)).not.toContain('BETWEEN');
      expect(tenantId).toBe(TENANT_ID);
      expect(fallbackTimezone).toBeTruthy();
      expect(from).toBeInstanceOf(Date);
      expect(until).toBeInstanceOf(Date);
    }
    expect(selectCalls.map(([, , , from, until]) => until.getTime() - from.getTime()))
      .toEqual([60 * 60 * 1000, 60 * 60 * 1000]);
  });

  it('does not equate a queued SMS or push intent with provider delivery', async () => {
    queueAppointmentReminderSmsMock.mockResolvedValue({ queued: true, outboxId: 12 });
    notificationOutboxQueueMock.mockResolvedValue({ id: 13, status: 'PENDING' });
    mockReminderQueries({
      due24h: [{
        id: 33, tenant_id: TENANT_ID, appointment_time: '10:30', token_number: 6,
        patient_user_id: 79, patient_name: 'Chandra', patient_phone: '9000000003',
        doctor_name: 'Rao', department: 'Cardiology',
      }],
    });

    await sendTimedReminders({ tenantId: TENANT_ID, now: new Date('2030-01-01T04:00:00Z') });

    const flagWrites = queryRawUnsafeMock.mock.calls
      .map(([sql]) => String(sql))
      .filter(sql => sql.includes('SET reminder_24h_sent = TRUE'));
    expect(flagWrites).toHaveLength(1);
    expect(flagWrites[0]).toContain("receipt.outcome = 'acknowledged'");
    expect(flagWrites[0]).not.toContain('ANY($1)');
  });

  it('leaves the reminder eligible when neither patient intent can be recorded', async () => {
    queueAppointmentReminderSmsMock.mockResolvedValue({
      queued: false, outboxId: null, duplicate: false, reason: 'queue_failed',
    });
    notificationOutboxQueueMock.mockResolvedValue(null);
    mockReminderQueries({
      due24h: [{
        id: 34, tenant_id: TENANT_ID, appointment_time: '10:30', token_number: 7,
        patient_user_id: 80, patient_name: 'Devi', patient_phone: '9000000004',
        doctor_name: 'Rao', department: 'Cardiology',
      }],
    });

    const result = await sendTimedReminders({
      tenantId: TENANT_ID,
      now: new Date('2030-01-01T04:00:00Z'),
    });

    expect(result).toMatchObject({ due24h: 1, queued24h: 0 });
    expect(loggerMock.warn.mock.calls.some(
      ([line]) => String(line).includes('could not be recorded on any patient channel'),
    )).toBe(true);
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
