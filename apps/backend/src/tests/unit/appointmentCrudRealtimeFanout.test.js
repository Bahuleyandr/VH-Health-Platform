import { jest } from '@jest/globals';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';

const createAppointmentMock = jest.fn();
const getAppointmentByIdMock = jest.fn();
const updateAppointmentMock = jest.fn();
const cancelAppointmentMock = jest.fn();
const hydratedAppointmentMock = jest.fn();
const validateBookingRequestMock = jest.fn();
const validateUpdateRequestMock = jest.fn();
const logAuditMock = jest.fn();
const emitAppointmentEventMock = jest.fn();

const fanoutQueryRawUnsafe = jest.fn().mockResolvedValue([]);
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: fanoutQueryRawUnsafe,
    users: { findFirst: jest.fn() },
    audit_logs: { create: jest.fn() },
  },
  // `setTenantTx` must be exported by the mock: the controllers under test
  // now open their identity-creating transaction through it, and an ESM mock
  // factory that omits a named export fails the whole module graph at link
  // time rather than at call time.
  setTenantTx: (_tenantId, run) => run({ $queryRawUnsafe: fanoutQueryRawUnsafe }),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), warn: jest.fn() },
}));
jest.unstable_mockModule('../../services/appointment/appointmentService.js', () => ({
  default: {
    createAppointment: createAppointmentMock,
    getAppointmentById: getAppointmentByIdMock,
    updateAppointment: updateAppointmentMock,
    cancelAppointment: cancelAppointmentMock,
    rescheduleAppointmentInPlace: jest.fn(),
  },
}));
jest.unstable_mockModule('../../services/appointment/appointmentQueryService.js', () => ({
  default: { getAppointmentById: hydratedAppointmentMock },
}));
jest.unstable_mockModule('../../services/appointment/appointmentValidationService.js', () => ({
  default: {
    validateBookingRequest: validateBookingRequestMock,
    validateUpdateRequest: validateUpdateRequestMock,
  },
}));
jest.unstable_mockModule('../../utils/appointment/appointmentHelpers.js', () => ({
  checkAppointmentPermission: jest.fn(() => true),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: (req) => req.tenantId,
}));
jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: logAuditMock,
}));
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitAppointmentEvent: emitAppointmentEventMock,
}));

const {
  createAppointment,
  updateAppointment,
  deleteAppointment,
} = await import('../../controllers/appointment/appointmentCrudController.js');

function request({ body = {}, id = '77' } = {}) {
  return {
    id: 'request-id',
    tenantId: TENANT_ID,
    params: { id },
    body,
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

function appointment(overrides = {}) {
  return {
    id: 77,
    uid: '33333333-3333-4333-8333-333333333333',
    patient_id: 41,
    patient_uid: PATIENT_UID,
    doctor_id: 12,
    status: 'SCHEDULED',
    appointment_date: '2026-08-14',
    appointment_time: '10:00',
    tenant_id: TENANT_ID,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  logAuditMock.mockResolvedValue(undefined);
});

test('POST /book emits the created appointment to the exact patient and tenant', async () => {
  const created = appointment();
  validateBookingRequestMock.mockResolvedValue({
    valid: true,
    patient: { id: 41, uid: PATIENT_UID, name: 'Patient' },
    doctor: { id: 12, name: 'Doctor' },
  });
  createAppointmentMock.mockResolvedValue(created);
  hydratedAppointmentMock.mockResolvedValue(created);
  const req = request({
    body: {
      patient_id: 41,
      doctor_id: 12,
      appointment_date: '2026-08-14',
      appointment_time: '10:00',
      confirm_duplicate: true,
    },
  });
  const res = response(req);

  await createAppointment(req, res);

  expect(res.statusCode).toBe(201);
  expect(emitAppointmentEventMock).toHaveBeenCalledWith('book', {
    tenantId: TENANT_ID,
    patientUid: PATIENT_UID,
    appointmentId: 77,
    status: 'SCHEDULED',
  });
  expect(createAppointmentMock.mock.invocationCallOrder[0])
    .toBeLessThan(emitAppointmentEventMock.mock.invocationCallOrder[0]);
});

test('PUT /:id emits after a successful non-status update', async () => {
  const current = appointment();
  getAppointmentByIdMock.mockResolvedValue(current);
  validateUpdateRequestMock.mockResolvedValue({ valid: true, isAddendum: false });
  updateAppointmentMock.mockResolvedValue({ id: 77, notes: 'Updated' });
  const req = request({ body: { notes: 'Updated' } });
  const res = response(req);

  await updateAppointment(req, res);

  expect(res.statusCode).toBe(200);
  expect(emitAppointmentEventMock).toHaveBeenCalledWith('update', {
    tenantId: TENANT_ID,
    patientUid: PATIENT_UID,
    appointmentId: 77,
    status: 'SCHEDULED',
  });
  expect(updateAppointmentMock.mock.invocationCallOrder[0])
    .toBeLessThan(emitAppointmentEventMock.mock.invocationCallOrder[0]);
});

test('DELETE /:id emits the successful cancellation', async () => {
  const current = appointment();
  const cancelled = appointment({ status: 'CANCELLED' });
  getAppointmentByIdMock.mockResolvedValue(current);
  cancelAppointmentMock.mockResolvedValue(cancelled);
  const req = request();
  const res = response(req);

  await deleteAppointment(req, res);

  expect(res.statusCode).toBe(200);
  expect(emitAppointmentEventMock).toHaveBeenCalledWith('cancel', {
    tenantId: TENANT_ID,
    patientUid: PATIENT_UID,
    appointmentId: 77,
    status: 'CANCELLED',
  });
  expect(cancelAppointmentMock.mock.invocationCallOrder[0])
    .toBeLessThan(emitAppointmentEventMock.mock.invocationCallOrder[0]);
});

test('failed creation never emits a false patient invalidation', async () => {
  validateBookingRequestMock.mockResolvedValue({
    valid: true,
    patient: { id: 41, uid: PATIENT_UID, name: 'Patient' },
    doctor: { id: 12, name: 'Doctor' },
  });
  createAppointmentMock.mockRejectedValue(new Error('database unavailable'));
  const req = request({
    body: {
      patient_id: 41,
      doctor_id: 12,
      appointment_date: '2026-08-14',
      appointment_time: '10:00',
      confirm_duplicate: true,
    },
  });
  const res = response(req);

  await createAppointment(req, res);

  expect(res.statusCode).toBe(500);
  expect(emitAppointmentEventMock).not.toHaveBeenCalled();
});

test('failed update never emits a false patient invalidation', async () => {
  getAppointmentByIdMock.mockResolvedValue(appointment());
  validateUpdateRequestMock.mockResolvedValue({ valid: true, isAddendum: false });
  updateAppointmentMock.mockRejectedValue(new Error('database unavailable'));
  const req = request({ body: { notes: 'Updated' } });
  const res = response(req);

  await updateAppointment(req, res);

  expect(res.statusCode).toBe(500);
  expect(emitAppointmentEventMock).not.toHaveBeenCalled();
});

test('failed cancellation never emits a false patient invalidation', async () => {
  getAppointmentByIdMock.mockResolvedValue(appointment());
  cancelAppointmentMock.mockRejectedValue(new Error('database unavailable'));
  const req = request();
  const res = response(req);

  await deleteAppointment(req, res);

  expect(res.statusCode).toBe(500);
  expect(emitAppointmentEventMock).not.toHaveBeenCalled();
});
