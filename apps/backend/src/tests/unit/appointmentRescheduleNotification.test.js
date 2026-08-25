// Staff-initiated reschedule must leave the patient something DURABLE.
//
// `rescheduleAppointment` used to emit only `emitAppointmentEvent('reschedule')`
// — a websocket fan-out that reaches the patient exactly when their app is
// open at that instant, and never otherwise. Confirm and cancel both send a
// push plus (for confirm) an SMS. So staff could move an appointment and the
// patient would arrive at the old time with nothing on their phone.
//
// This suite pins the three durable effects and, just as importantly, pins
// that none of them can fail the response: the reschedule is committed before
// any of this runs.

import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';

const queryRawUnsafeMock = jest.fn();
const executeRawUnsafeMock = jest.fn();
const getAppointmentByIdMock = jest.fn();
const rescheduleInPlaceMock = jest.fn();
const emitAppointmentEventMock = jest.fn();
const logAuditMock = jest.fn();
const sendPushNotificationMock = jest.fn();
const queueAppointmentRescheduleSmsMock = jest.fn();
const loggerMock = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
    $executeRawUnsafe: executeRawUnsafeMock,
  },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({ default: loggerMock }));
jest.unstable_mockModule('../../services/appointment/appointmentService.js', () => ({
  default: {
    getAppointmentById: getAppointmentByIdMock,
    rescheduleAppointmentInPlace: rescheduleInPlaceMock,
  },
}));
jest.unstable_mockModule('../../services/appointment/appointmentQueryService.js', () => ({
  default: { getAppointmentById: getAppointmentByIdMock },
}));
jest.unstable_mockModule('../../services/appointment/appointmentValidationService.js', () => ({
  default: { validateBookingRequest: jest.fn(), validateUpdateRequest: jest.fn() },
}));
jest.unstable_mockModule('../../utils/appointment/appointmentHelpers.js', () => ({
  checkAppointmentPermission: jest.fn(() => true),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: (req) => req.tenantId,
}));
jest.unstable_mockModule('../../utils/logAudit.js', () => ({ logAudit: logAuditMock }));
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitAppointmentEvent: emitAppointmentEventMock,
}));
jest.unstable_mockModule('../../utils/notifications/sendPushNotification.js', () => ({
  sendPushNotification: sendPushNotificationMock,
}));
jest.unstable_mockModule('../../utils/notifications/smsOutbox.js', () => ({
  queueAppointmentRescheduleSms: queueAppointmentRescheduleSmsMock,
}));

const { rescheduleAppointment } = await import(
  '../../controllers/appointment/appointmentCrudController.js'
);

function request(body = {}) {
  return {
    id: 'request-id',
    tenantId: TENANT_ID,
    params: { id: '77' },
    body: {
      appointment_date: '2026-09-02',
      appointment_time: '11:30',
      ...body,
    },
    user: {
      id: 9,
      uid: '11111111-1111-4111-8111-111111111111',
      role: 'RECEPTIONIST',
      name: 'Front Desk',
    },
  };
}

function response(req) {
  return {
    req,
    statusCode: null,
    body: null,
    status: jest.fn(function setStatus(code) { this.statusCode = code; return this; }),
    json: jest.fn(function sendJson(body) { this.body = body; return this; }),
  };
}

const EXISTING = {
  id: 77,
  uid: '33333333-3333-4333-8333-333333333333',
  patient_id: 41,
  patient_uid: PATIENT_UID,
  patient_name: 'Asha R',
  phone: '+919876500041',
  doctor_id: 12,
  doctor_name: 'Rao',
  department: 'Cardiology',
  status: 'CONFIRMED',
  appointment_date: '2026-08-14',
  appointment_time: '10:00',
  tenant_id: TENANT_ID,
};

const RESULT = {
  from_status: 'CONFIRMED',
  to_status: 'SCHEDULED',
  appointment: {
    ...EXISTING,
    status: 'SCHEDULED',
    appointment_date: '2026-09-02',
    appointment_time: '11:30',
    token_number: null,
  },
  previous: {
    appointment_date: '2026-08-14',
    appointment_time: '10:00',
    doctor_id: 12,
    status: 'CONFIRMED',
  },
};

/** The notification tail runs in setImmediate; let the macrotask queue drain. */
const flush = () => new Promise(resolve => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  queryRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockReset();
  executeRawUnsafeMock.mockResolvedValue(1);
  logAuditMock.mockResolvedValue(undefined);
  getAppointmentByIdMock.mockResolvedValue(EXISTING);
  rescheduleInPlaceMock.mockResolvedValue(RESULT);
  sendPushNotificationMock.mockResolvedValue({ successCount: 1 });
  queueAppointmentRescheduleSmsMock.mockResolvedValue({ queued: true, outboxId: 7 });
  queryRawUnsafeMock.mockResolvedValue([
    { id: 41, uid: PATIENT_UID, phone: '+919876500041', device_token: 'fcm-token' },
  ]);
});

// Drain any notification tail a test left pending, so its writes can never be
// counted against the next test.
afterEach(async () => {
  await flush();
});

describe('staff-initiated reschedule notifies the patient durably', () => {
  it('writes an in-app feed row with a type the patient inbox routes', async () => {
    const req = request();
    const res = response(req);

    await rescheduleAppointment(req, res);
    await flush();

    expect(executeRawUnsafeMock).toHaveBeenCalledTimes(1);
    const [sql, ...params] = executeRawUnsafeMock.mock.calls[0];
    expect(String(sql)).toContain('INSERT INTO notifications');
    // tenant bound explicitly ($8) — a defaulted tenant_id is invisible to the
    // recipient's tenant-filtered inbox reader.
    expect(String(sql)).toContain('$8::uuid');
    expect(params[7]).toBe(TENANT_ID);
    expect(params[0]).toBe(PATIENT_UID);
    expect(params[1]).toBe(41);
    // `appointment_rescheduled` is routed to /appointments by
    // apps/patient/lib/features/notifications/screens/notifications_screen.dart.
    expect(params[5]).toBe('appointment_rescheduled');
    // The body has to carry the new slot AND warn off the old one — arriving
    // at the old time is the failure this exists to prevent.
    expect(params[4]).toContain('11:30');
    expect(params[4]).toContain('do not attend at the earlier time');
  });

  it('sends the push and queues the SMS, mirroring confirm/cancel', async () => {
    const req = request();
    await rescheduleAppointment(req, response(req));
    await flush();

    expect(sendPushNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
      tokens: 'fcm-token',
      data: expect.objectContaining({
        type: 'appointment_rescheduled',
        appointment_id: '77',
      }),
    }));
    expect(queueAppointmentRescheduleSmsMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_ID,
      recipientId: 41,
      phone: '+919876500041',
      date: '2026-09-02',
      time: '11:30',
      previousDate: '2026-08-14',
      previousTime: '10:00',
      appointmentId: 77,
    }));
  });

  it('still emits the realtime event for an app that happens to be open', async () => {
    const req = request();
    await rescheduleAppointment(req, response(req));

    expect(emitAppointmentEventMock).toHaveBeenCalledWith('reschedule', expect.objectContaining({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      appointmentId: 77,
    }));
    await flush();
  });

  it('writes the in-app row even when the patient has no registered device', async () => {
    queryRawUnsafeMock.mockResolvedValue([
      { id: 41, uid: PATIENT_UID, phone: '+919876500041', device_token: null },
    ]);
    const req = request();
    await rescheduleAppointment(req, response(req));
    await flush();

    expect(executeRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(sendPushNotificationMock).not.toHaveBeenCalled();
    expect(queueAppointmentRescheduleSmsMock).toHaveBeenCalled();
  });

  // ── The notification tail must never be able to fail the write ──────────
  it('returns 200 even when every notification channel fails', async () => {
    queryRawUnsafeMock.mockRejectedValue(new Error('connection reset'));
    sendPushNotificationMock.mockRejectedValue(new Error('fcm down'));
    queueAppointmentRescheduleSmsMock.mockRejectedValue(new Error('outbox down'));

    const req = request();
    const res = response(req);
    await rescheduleAppointment(req, res);
    await flush();

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it('responds before the notification tail runs at all', async () => {
    const req = request();
    const res = response(req);

    await rescheduleAppointment(req, res);

    // setImmediate has not fired yet: the response is already sent.
    expect(res.statusCode).toBe(200);
    expect(executeRawUnsafeMock).not.toHaveBeenCalled();
    await flush();
    expect(executeRawUnsafeMock).toHaveBeenCalledTimes(1);
  });
});
