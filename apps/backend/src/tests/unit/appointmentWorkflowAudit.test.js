import { jest } from '@jest/globals';

const txQueryRawUnsafe = jest.fn();
const txExecuteRawUnsafe = jest.fn();
const prismaMock = {
  $transaction: jest.fn(),
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};
const logAuditMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: logAuditMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/smsService.js', () => ({
  sendAppointmentConfirmationSMS: jest.fn(),
}));

jest.unstable_mockModule('../../utils/notifications/sendPushNotification.js', () => ({
  sendPushNotification: jest.fn(),
}));

const {
  cancelAppointment,
  completeAppointment,
  confirmAppointment,
  markNoShow,
} = await import('../../controllers/appointment/appointmentWorkflowController.js');

function makeReq(overrides = {}) {
  return {
    id: 'req-op-queue-1',
    params: { id: '42' },
    body: {},
    headers: { 'x-forwarded-for': '127.0.0.1' },
    connection: { remoteAddress: '127.0.0.1' },
    user: {
      id: 9,
      uid: '11111111-1111-4111-8111-111111111111',
      role: 'RECEPTIONIST',
      deviceType: 'desktop',
      tenant_id: '00000000-0000-4000-8000-000000000001',
    },
    ...overrides,
  };
}

function makeRes(req) {
  const res = {
    req,
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

function appointmentRow(overrides = {}) {
  return {
    id: 42,
    uid: '22222222-2222-4222-8222-222222222222',
    patient_id: 123,
    doctor_id: 456,
    appointment_date: '2026-06-01',
    appointment_time: '10:30',
    department: 'General Medicine',
    visit_no: 'OPD-20260601-007',
    token_number: '7',
    status: 'CONFIRMED',
    updated_at: new Date('2026-06-01T05:00:00.000Z'),
    ...overrides,
  };
}

describe('appointment workflow audit logging', () => {
  let setImmediateSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    txQueryRawUnsafe.mockReset();
    txExecuteRawUnsafe.mockReset();
    prismaMock.$transaction.mockImplementation(async (callback) => callback({
      $queryRawUnsafe: txQueryRawUnsafe,
      $executeRawUnsafe: txExecuteRawUnsafe,
    }));
    prismaMock.$queryRawUnsafe.mockReset();
    prismaMock.$executeRawUnsafe.mockReset();
    logAuditMock.mockResolvedValue(undefined);
    setImmediateSpy = jest
      .spyOn(global, 'setImmediate')
      .mockImplementation(() => null);
  });

  afterEach(() => {
    setImmediateSpy.mockRestore();
  });

  it('writes structured audit context when reception confirms an OP appointment', async () => {
    const previous = appointmentRow({
      uid: undefined,
      status: 'SCHEDULED',
      confirmed_at: null,
    });
    const updated = appointmentRow({ status: 'CONFIRMED' });
    txQueryRawUnsafe
      .mockResolvedValueOnce([previous])
      .mockResolvedValueOnce([{ next_token: '7' }])
      .mockResolvedValueOnce([updated]);
    txExecuteRawUnsafe.mockResolvedValueOnce({});
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([{ device_token: null, name: 'Patient Demo', phone: '+919999999999' }])
      .mockResolvedValueOnce([{ name: 'Dr Demo', department: 'General Medicine' }]);

    const req = makeReq({
      body: { confirmation_notes: 'Patient arrived at counter' },
    });
    const res = makeRes(req);

    await confirmAppointment(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(logAuditMock).toHaveBeenCalledWith(
      req,
      'FRONT_OFFICE_APPOINTMENT_CONFIRMED',
      expect.objectContaining({
        appointment_id: 42,
        appointment_uid: '22222222-2222-4222-8222-222222222222',
        patient_id: 123,
        doctor_id: 456,
        department: 'General Medicine',
        visit_no: 'OPD-20260601-007',
        token_number: '7',
        from_status: 'SCHEDULED',
        to_status: 'CONFIRMED',
        confirmation_notes: 'Patient arrived at counter',
      }),
      { resource: 'appointment', resourceId: 42 },
    );
  });

  it('writes structured audit context when reception marks an OP no-show', async () => {
    txQueryRawUnsafe
      .mockResolvedValueOnce([appointmentRow({ status: 'CONFIRMED' })])
      .mockResolvedValueOnce([appointmentRow({ status: 'NO_SHOW' })]);
    txExecuteRawUnsafe.mockResolvedValueOnce({});

    const req = makeReq();
    const res = makeRes(req);

    await markNoShow(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(logAuditMock).toHaveBeenCalledWith(
      req,
      'FRONT_OFFICE_APPOINTMENT_NO_SHOW',
      expect.objectContaining({
        appointment_id: 42,
        appointment_uid: '22222222-2222-4222-8222-222222222222',
        patient_id: 123,
        doctor_id: 456,
        from_status: 'CONFIRMED',
        to_status: 'NO_SHOW',
        status: 'NO_SHOW',
      }),
      { resource: 'appointment', resourceId: 42 },
    );
  });

  it('writes structured audit context when a permitted user completes an OP appointment', async () => {
    txQueryRawUnsafe
      .mockResolvedValueOnce([appointmentRow({ status: 'CONFIRMED' })])
      .mockResolvedValueOnce([appointmentRow({ status: 'COMPLETED', notes: 'Reviewed and closed' })]);
    txExecuteRawUnsafe.mockResolvedValueOnce({});

    const req = makeReq({
      body: { notes: 'Reviewed and closed' },
    });
    const res = makeRes(req);

    await completeAppointment(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(logAuditMock).toHaveBeenCalledWith(
      req,
      'FRONT_OFFICE_APPOINTMENT_COMPLETED',
      expect.objectContaining({
        appointment_id: 42,
        patient_id: 123,
        doctor_id: 456,
        from_status: 'CONFIRMED',
        to_status: 'COMPLETED',
        status: 'COMPLETED',
        clinical_notes_present: true,
      }),
      { resource: 'appointment', resourceId: 42 },
    );
  });

  it('writes structured audit context when reception cancels an OP appointment', async () => {
    txQueryRawUnsafe
      .mockResolvedValueOnce([appointmentRow({ status: 'SCHEDULED' })])
      .mockResolvedValueOnce([appointmentRow({ status: 'CANCELLED' })]);
    txExecuteRawUnsafe.mockResolvedValueOnce({});
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([]);

    const req = makeReq({
      body: { cancellation_reason: 'Patient requested reschedule' },
    });
    const res = makeRes(req);

    await cancelAppointment(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(logAuditMock).toHaveBeenCalledWith(
      req,
      'FRONT_OFFICE_APPOINTMENT_CANCELLED',
      expect.objectContaining({
        appointment_id: 42,
        patient_id: 123,
        doctor_id: 456,
        from_status: 'SCHEDULED',
        to_status: 'CANCELLED',
        status: 'CANCELLED',
        cancellation_reason: 'Patient requested reschedule',
      }),
      { resource: 'appointment', resourceId: 42 },
    );
  });
});
