import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const STAFF_UID = '11111111-1111-4111-8111-111111111111';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';

const getAppointmentByIdMock = jest.fn();
const validateBookingRequestMock = jest.fn();
const logAuditMock = jest.fn();
const queryRawUnsafeMock = jest.fn();
const setTenantTxMock = jest.fn();
const resolveDoctorRefMock = jest.fn();
const ensureAppointmentQueueMock = jest.fn();
const populateAppointmentCareTeamMock = jest.fn();
const recordAppointmentCreatedEvidenceMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
    users: { findFirst: jest.fn() },
  },
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn() },
}));
jest.unstable_mockModule(
  '../../controllers/appointment/appointmentWorkflowController.js',
  () => ({
    composeVisitNo: jest.fn(() => 'OPD-20260801-001'),
    deptPrefix: jest.fn(() => 'OPD'),
  }),
);
jest.unstable_mockModule('../../services/doctor/doctorRefService.js', () => ({
  resolveDoctorRef: resolveDoctorRefMock,
}));
jest.unstable_mockModule('../../services/appointment/appointmentQueueService.js', () => ({
  ensureAppointmentQueueForAppointment: ensureAppointmentQueueMock,
}));
jest.unstable_mockModule('../../services/security/careTeamPopulationService.js', () => ({
  populateAppointmentCareTeam: populateAppointmentCareTeamMock,
}));
jest.unstable_mockModule('../../services/appointment/appointmentLifecycleService.js', () => ({
  recordAppointmentCreatedEvidenceTx: recordAppointmentCreatedEvidenceMock,
  transitionAppointment: jest.fn(),
}));
jest.unstable_mockModule('../../services/appointment/appointmentQueryService.js', () => ({
  default: { getAppointmentById: getAppointmentByIdMock },
}));
jest.unstable_mockModule('../../services/appointment/appointmentValidationService.js', () => ({
  default: { validateBookingRequest: validateBookingRequestMock },
}));
jest.unstable_mockModule('../../utils/appointment/appointmentHelpers.js', () => ({
  checkAppointmentPermission: jest.fn(),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: (req) => req.tenantId,
  requireTenantId: (tenantId) => tenantId,
}));
jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: logAuditMock,
}));
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitAppointmentEvent: jest.fn(),
}));

const { default: appointmentService } = await import(
  '../../services/appointment/appointmentService.js'
);
const { createAppointment } = await import(
  '../../controllers/appointment/appointmentCrudController.js'
);

function makeResponse(req) {
  return {
    req,
    statusCode: null,
    body: null,
    status: jest.fn(function setStatus(statusCode) {
      this.statusCode = statusCode;
      return this;
    }),
    json: jest.fn(function sendJson(body) {
      this.body = body;
      return this;
    }),
  };
}

beforeEach(() => {
  getAppointmentByIdMock.mockReset();
  validateBookingRequestMock.mockReset();
  logAuditMock.mockReset();
  queryRawUnsafeMock.mockReset();
  setTenantTxMock.mockReset();
  resolveDoctorRefMock.mockReset();
  ensureAppointmentQueueMock.mockReset();
  populateAppointmentCareTeamMock.mockReset();
  recordAppointmentCreatedEvidenceMock.mockReset();
  queryRawUnsafeMock.mockResolvedValue([]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

test.each([
  {
    label: 'staff',
    user: {
      id: 9,
      uid: STAFF_UID,
      role: 'RECEPTIONIST',
      name: 'Front Desk',
    },
    patientId: 41,
  },
  {
    label: 'patient',
    user: {
      id: 42,
      uid: PATIENT_UID,
      role: 'PATIENT',
      name: 'Patient',
    },
    patientId: 42,
  },
])(
  '$label booking forwards only authenticated actor provenance',
  async ({ user, patientId }) => {
    const appointment = {
      id: 77,
      uid: '33333333-3333-4333-8333-333333333333',
      patient_id: patientId,
      doctor_id: 12,
      status: 'SCHEDULED',
      tenant_id: TENANT_ID,
    };
    validateBookingRequestMock.mockResolvedValue({
      valid: true,
      patient: {
        id: patientId,
        uid: user.role === 'PATIENT' ? user.uid : PATIENT_UID,
        name: 'Booked Patient',
        phone: '+919876543210',
      },
      doctor: { id: 12, name: 'Dr Example' },
    });
    const createAppointmentMock = jest
      .spyOn(appointmentService, 'createAppointment')
      .mockResolvedValue(appointment);
    getAppointmentByIdMock.mockResolvedValue(appointment);

    const req = {
      id: 'request-id',
      tenantId: TENANT_ID,
      user,
      body: {
        patient_id: patientId,
        doctor_id: 12,
        appointment_date: '2026-08-01',
        appointment_time: '10:00',
        reason: 'Consultation',
        confirm_duplicate: true,
        created_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        actorUid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        actorId: 999,
        actorRole: 'SUPER_ADMIN',
      },
    };
    const res = makeResponse(req);

    await createAppointment(req, res);

    expect(res.statusCode).toBe(201);
    expect(createAppointmentMock).toHaveBeenCalledTimes(1);
    const [appointmentData, actor] = createAppointmentMock.mock.calls[0];
    expect(appointmentData).toEqual(expect.objectContaining({
      patient_id: patientId,
      doctor_id: 12,
      tenant_id: TENANT_ID,
    }));
    expect(appointmentData).not.toHaveProperty('created_by');
    expect(appointmentData).not.toHaveProperty('actorUid');
    expect(appointmentData).not.toHaveProperty('actorId');
    expect(appointmentData).not.toHaveProperty('actorRole');
    expect(actor).toEqual({
      actorUid: user.uid,
      actorId: user.id,
      actorRole: user.role,
    });
  },
);

test('service passes the trusted actor identity into appointment creation evidence', async () => {
  const appointment = {
    id: 77,
    uid: '33333333-3333-4333-8333-333333333333',
    patient_id: 41,
    doctor_id: 12,
    status: 'SCHEDULED',
    tenant_id: TENANT_ID,
    created_at: new Date('2026-08-01T04:30:00.000Z'),
  };
  const tx = {
    $queryRaw: jest.fn()
      .mockResolvedValueOnce([{
        id: 41,
        uid: PATIENT_UID,
        phone: '+919876543210',
        name: 'Booked Patient',
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([appointment]),
  };
  setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(tx));
  resolveDoctorRefMock.mockResolvedValue({
    id: 12,
    uid: '44444444-4444-4444-8444-444444444444',
    name: 'Dr Example',
    department: 'General Medicine',
  });
  ensureAppointmentQueueMock.mockResolvedValue({ id: 91, queue_kind: 'op' });
  recordAppointmentCreatedEvidenceMock.mockResolvedValue({ mode: 'active' });
  populateAppointmentCareTeamMock.mockResolvedValue(null);

  await appointmentService.createAppointment({
    patient_id: 41,
    doctor_id: 12,
    appointment_date: '2026-08-01',
    appointment_time: '10:00',
    reason: 'Consultation',
    tenant_id: TENANT_ID,
    created_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }, {
    actorUid: STAFF_UID,
    actorId: 9,
    actorRole: 'RECEPTIONIST',
  });

  expect(recordAppointmentCreatedEvidenceMock).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      tenantId: TENANT_ID,
      actorUid: STAFF_UID,
      actorId: 9,
      actorRole: 'RECEPTIONIST',
      source: 'book',
    }),
  );
  expect(ensureAppointmentQueueMock).toHaveBeenCalledWith(
    tx,
    expect.any(Object),
    { actorUid: STAFF_UID, source: 'book' },
  );
  const insertValues = tx.$queryRaw.mock.calls[2].slice(1);
  expect(insertValues).toContain(STAFF_UID);
  expect(insertValues).not.toContain('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  expect(populateAppointmentCareTeamMock).toHaveBeenCalledWith(
    expect.objectContaining({ createdBy: STAFF_UID }),
  );
});
