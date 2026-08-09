// Audit 2026-08-09 finding F7 — patient-facing SMS must leave a durable
// notification-outbox row, never a dry-run log that looks like a delivery.

import { jest } from '@jest/globals';

const queueMock = jest.fn();
const loggerMock = {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
};

jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: queueMock },
  default: { queue: queueMock },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));

const {
  queuePatientSms,
  queueAppointmentConfirmationSms,
  queueAppointmentReminderSms,
  renderAppointmentConfirmationSms,
  renderAppointmentReminderSms,
} = await import('../../utils/notifications/smsOutbox.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  queueMock.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  queueMock.mockResolvedValue({ id: 4242, status: 'PENDING', duplicate: false });
});

describe('queuePatientSms', () => {
  it('records the intent on the outbox as an sms row instead of sending', async () => {
    const result = await queuePatientSms({
      tenantId: TENANT_ID,
      recipientId: 77,
      recipientPhone: '9000000001',
      title: 'Investigation booking confirmed',
      body: 'Your investigation is confirmed.',
      data: { type: 'investigation_confirmed', booking_id: '5' },
      sourceEventKey: 'investigation-booking-confirmed:5',
      templateVersion: 'sms.investigation_booking_confirmed.v1',
      context: 'investigation-booking-confirmed',
    });

    expect(queueMock).toHaveBeenCalledTimes(1);
    expect(queueMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sms',
      tenantId: TENANT_ID,
      recipientId: 77,
      recipientPhone: '9000000001',
      body: 'Your investigation is confirmed.',
      sourceEventKey: 'investigation-booking-confirmed:5',
      templateVersion: 'sms.investigation_booking_confirmed.v1',
    }));
    expect(result).toEqual({
      queued: true, outboxId: 4242, duplicate: false, reason: null,
    });
  });

  it('never claims delivery in its log line', async () => {
    await queuePatientSms({
      tenantId: TENANT_ID, recipientPhone: '9000000001', title: 't', body: 'b',
    });
    const line = loggerMock.info.mock.calls.map(args => String(args[0])).join('\n');
    expect(line).toMatch(/NOT delivered/);
    expect(line).toMatch(/no SMS gateway is configured/);
    expect(line).not.toMatch(/\bsent\b/i);
  });

  it('records nothing and reports phone_missing when there is no phone', async () => {
    const result = await queuePatientSms({
      tenantId: TENANT_ID, recipientPhone: '   ', title: 't', body: 'b',
    });
    expect(queueMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ queued: false, reason: 'phone_missing' });
  });

  it('reports a queue failure loudly rather than silently swallowing the intent', async () => {
    queueMock.mockResolvedValue(null);
    const result = await queuePatientSms({
      tenantId: TENANT_ID, recipientPhone: '9000000001', title: 't', body: 'b',
    });
    expect(result).toMatchObject({ queued: false, reason: 'queue_failed' });
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('FAILED to record the SMS intent'),
    );
  });

  it('never throws when the outbox itself throws — the caller must not be broken', async () => {
    queueMock.mockRejectedValue(new Error('serialization failure'));
    await expect(queuePatientSms({
      tenantId: TENANT_ID, recipientPhone: '9000000001', title: 't', body: 'b',
    })).resolves.toMatchObject({ queued: false, reason: 'queue_failed' });
  });

  it('surfaces an outbox dedupe as duplicate rather than a new send', async () => {
    queueMock.mockResolvedValue({ id: 99, status: 'PENDING', duplicate: true });
    const result = await queuePatientSms({
      tenantId: TENANT_ID, recipientPhone: '9000000001', title: 't', body: 'b',
    });
    expect(result).toMatchObject({ queued: true, outboxId: 99, duplicate: true });
  });
});

describe('appointment SMS templates', () => {
  it('renders the confirmation copy that smsService used to compose', () => {
    process.env.HOSPITAL_PHONE = '044-12345678';
    const body = renderAppointmentConfirmationSms({
      patientName: 'Asha', doctorName: 'Rao', date: '2026-08-20',
      time: '10:30', tokenNumber: 12, department: 'Cardiology',
    });
    expect(body).toContain('Dear Asha, your appointment at Venkataeswara Hospitals is confirmed.');
    expect(body).toContain('Doctor: Dr. Rao (Cardiology)');
    expect(body).toContain('Token: #12');
    expect(body).toContain('For queries call: 044-12345678');
    delete process.env.HOSPITAL_PHONE;
  });

  it('renders the reminder copy that smsService used to compose', () => {
    expect(renderAppointmentReminderSms({
      patientName: 'Asha', doctorName: 'Rao', time: '10:30',
      hoursAhead: 24, tokenNumber: 12,
    })).toBe(
      'Reminder: Dear Asha, you have an appointment at Venkataeswara Hospitals in 24 hours.\n'
      + 'Time: 10:30 | Dr. Rao | Token #12',
    );
    expect(renderAppointmentReminderSms({
      patientName: 'Asha', doctorName: 'Rao', time: '10:30',
      hoursAhead: 1, tokenNumber: 12,
    })).toContain('in 1 hour.');
  });

  it('queues the confirmation as an idempotent sms intent', async () => {
    await queueAppointmentConfirmationSms({
      tenantId: TENANT_ID, recipientId: 77, phone: '9000000001',
      patientName: 'Asha', doctorName: 'Rao', date: '2026-08-20',
      time: '10:30', tokenNumber: 12, department: null, appointmentId: 31,
    });
    expect(queueMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'sms',
      tenantId: TENANT_ID,
      recipientId: 77,
      sourceEventKey: 'appointment-confirmed:31',
      templateVersion: 'sms.appointment_confirmation.v1',
    }));
  });

  it('queues 24h and 1h reminders under distinct idempotency keys', async () => {
    const base = {
      tenantId: TENANT_ID, recipientId: 77, phone: '9000000001',
      patientName: 'Asha', doctorName: 'Rao', time: '10:30',
      tokenNumber: 12, appointmentId: 31,
    };
    await queueAppointmentReminderSms({ ...base, hoursAhead: 24 });
    await queueAppointmentReminderSms({ ...base, hoursAhead: 1 });
    const keys = queueMock.mock.calls.map(([intent]) => intent.sourceEventKey);
    expect(keys).toEqual([
      'appointment-reminder-24h:31',
      'appointment-reminder-1h:31',
    ]);
  });

  it('does not queue an appointment SMS when the patient has no phone', async () => {
    await queueAppointmentConfirmationSms({
      tenantId: TENANT_ID, phone: null, patientName: 'Asha',
      doctorName: 'Rao', date: '2026-08-20', time: '10:30', tokenNumber: 12,
    });
    await queueAppointmentReminderSms({
      tenantId: TENANT_ID, phone: null, patientName: 'Asha',
      doctorName: 'Rao', time: '10:30', hoursAhead: 1, tokenNumber: 12,
    });
    expect(queueMock).not.toHaveBeenCalled();
  });
});

describe('outbox intent shape', () => {
  // notificationOutbox.canonicalize throws on `undefined`, and queue() would
  // swallow that as a generic failure — so the payloads built here must be
  // free of undefined values even when optional inputs are omitted.
  it('builds payloads with no undefined values', async () => {
    await queueAppointmentConfirmationSms({
      tenantId: TENANT_ID, phone: '9000000001', patientName: 'Asha',
      doctorName: 'Rao', date: '2026-08-20', time: '10:30', tokenNumber: 12,
    });
    await queueAppointmentReminderSms({
      tenantId: TENANT_ID, phone: '9000000001', patientName: 'Asha',
      doctorName: 'Rao', time: '10:30', hoursAhead: 1, tokenNumber: 12,
    });
    expect(queueMock).toHaveBeenCalledTimes(2);
    for (const [intent] of queueMock.mock.calls) {
      for (const [key, value] of Object.entries(intent.data)) {
        expect([key, value]).not.toContain(undefined);
      }
    }
  });
});
