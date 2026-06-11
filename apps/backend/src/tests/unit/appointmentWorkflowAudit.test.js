import { jest } from '@jest/globals';

const txQueryRawUnsafe = jest.fn();
const txExecuteRawUnsafe = jest.fn();
const prismaMock = {
  $transaction: jest.fn(),
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
};
const logAuditMock = jest.fn();
const ensureAppointmentQueueForAppointmentMock = jest.fn();
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

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

jest.unstable_mockModule('../../services/appointment/appointmentQueueService.js', () => ({
  ensureAppointmentQueueForAppointment: ensureAppointmentQueueForAppointmentMock,
}));

const {
  adviseForAdmission,
  cancelAppointment,
  completeAppointment,
  confirmAppointment,
  markNoShow,
  rescheduleAppointment,
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
      tenant_id: TENANT_ID,
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
    tenant_id: TENANT_ID,
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
    ensureAppointmentQueueForAppointmentMock.mockReset();
    ensureAppointmentQueueForAppointmentMock.mockResolvedValue(null);
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
    expect(txQueryRawUnsafe.mock.calls[0][0]).toContain('tenant_id=$2::uuid');
    expect(txQueryRawUnsafe.mock.calls[0][2]).toBe(TENANT_ID);
    expect(txQueryRawUnsafe.mock.calls[1][0]).toContain('AND tenant_id = $3::uuid');
    expect(txQueryRawUnsafe.mock.calls[1][3]).toBe(TENANT_ID);
    expect(txQueryRawUnsafe.mock.calls[2][0]).toContain('AND tenant_id = $6::uuid');
    expect(txQueryRawUnsafe.mock.calls[2][6]).toBe(TENANT_ID);
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toContain('tenant_id=$2::uuid');
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][2]).toBe(TENANT_ID);
    expect(req.phiContext).toEqual(expect.objectContaining({
      appointmentId: 42,
      appointment_id: 42,
      patientId: 123,
      patient_id: 123,
    }));
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
    expect(txQueryRawUnsafe.mock.calls[0][0]).toContain('tenant_id=$2::uuid');
    expect(txQueryRawUnsafe.mock.calls[0][2]).toBe(TENANT_ID);
    expect(txQueryRawUnsafe.mock.calls[1][0]).toContain('tenant_id=$2::uuid');
    expect(txQueryRawUnsafe.mock.calls[1][2]).toBe(TENANT_ID);
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

  it('marks the original appointment RESCHEDULED and audits the linked replacement', async () => {
    const previous = appointmentRow({ status: 'CONFIRMED' });
    const replacement = appointmentRow({
      id: 84,
      uid: '33333333-3333-4333-8333-333333333333',
      status: 'SCHEDULED',
      appointment_date: '2026-06-03',
      appointment_time: '11:30',
      token_number: null,
      visit_no: null,
      parent_appointment_id: 42,
    });
    const original = appointmentRow({ status: 'RESCHEDULED' });
    txQueryRawUnsafe
      .mockResolvedValueOnce([previous])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([replacement])
      .mockResolvedValueOnce([original]);
    txExecuteRawUnsafe
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const req = makeReq({
      body: {
        appointment_date: '2026-06-03',
        appointment_time: '11:30',
        confirmation_notes: 'Patient requested later visit',
      },
    });
    const res = makeRes(req);

    await rescheduleAppointment(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(ensureAppointmentQueueForAppointmentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 84,
        status: 'SCHEDULED',
        parent_appointment_id: 42,
      }),
      expect.objectContaining({ source: 'reschedule' }),
    );
    expect(logAuditMock).toHaveBeenCalledWith(
      req,
      'FRONT_OFFICE_APPOINTMENT_RESCHEDULED',
      expect.objectContaining({
        appointment_id: 42,
        from_status: 'CONFIRMED',
        to_status: 'RESCHEDULED',
        status: 'RESCHEDULED',
        replacement_appointment_id: 84,
        replacement_appointment_uid: '33333333-3333-4333-8333-333333333333',
        replacement_appointment_date: '2026-06-03',
        replacement_appointment_time: '11:30',
        reschedule_note: 'Patient requested later visit',
      }),
      { resource: 'appointment', resourceId: 42 },
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        original: expect.objectContaining({ status: 'RESCHEDULED' }),
        appointment: expect.objectContaining({
          id: 84,
          status: 'SCHEDULED',
          parent_appointment_id: 42,
        }),
      }),
    }));
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
    expect(txQueryRawUnsafe.mock.calls[0][0]).toContain('tenant_id=$2::uuid');
    expect(txQueryRawUnsafe.mock.calls[0][2]).toBe(TENANT_ID);
    expect(txQueryRawUnsafe.mock.calls[1][0]).toContain('tenant_id=$3::uuid');
    expect(txQueryRawUnsafe.mock.calls[1][3]).toBe(TENANT_ID);
    expect(req.phiContext).toEqual(expect.objectContaining({
      appointmentId: 42,
      patientId: 123,
    }));
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
    expect(txQueryRawUnsafe.mock.calls[0][0]).toContain('tenant_id=$2::uuid');
    expect(txQueryRawUnsafe.mock.calls[0][2]).toBe(TENANT_ID);
    expect(txQueryRawUnsafe.mock.calls[1][0]).toContain('tenant_id=$2::uuid');
    expect(txQueryRawUnsafe.mock.calls[1][2]).toBe(TENANT_ID);
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toContain('tenant_id=$2::uuid');
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][2]).toBe(TENANT_ID);
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

  it('scopes admission advice updates to the request tenant', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([
      appointmentRow({
        advised_for_admission_at: new Date('2026-06-01T05:00:00.000Z'),
        advised_for_admission_by: '11111111-1111-4111-8111-111111111111',
        advised_for_admission_note: 'Needs inpatient observation',
      }),
    ]);

    const req = makeReq({
      body: { note: 'Needs inpatient observation' },
      user: {
        id: 10,
        uid: '11111111-1111-4111-8111-111111111111',
        role: 'DOCTOR',
        tenant_id: TENANT_ID,
      },
    });
    const res = makeRes(req);

    await adviseForAdmission(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][0]).toContain('AND tenant_id = $4::uuid');
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][4]).toBe(TENANT_ID);
  });
});
