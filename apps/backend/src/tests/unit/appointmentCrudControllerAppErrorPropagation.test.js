import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for the relayAppError port of
// appointmentCrudController.js (createAppointment + rescheduleAppointment
// catches). Driven over HTTP through the real appointmentCrudRoutes module,
// mirroring paediatricImmunisationRoutesAppErrorPropagation.test.js.
//
// Both catches keep site-local conflict branches (createAppointment's
// `err.isConflict`, rescheduleAppointment's conflictDetailsFromError) whose
// details are built from non-envelope sources — those stay on the local
// error() call (with an err.code -> topLevel lift added) and are pinned here.

const TENANT_ID = '00000000-0000-4000-8000-000000000001';

const createAppointmentMock = jest.fn();
const getAppointmentByIdMock = jest.fn();
const rescheduleInPlaceMock = jest.fn();
const updateAppointmentMock = jest.fn();
const validateBookingRequestMock = jest.fn();
const validateUpdateRequestMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(async () => []) },
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../services/appointment/appointmentService.js', () => ({
  default: {
    createAppointment: createAppointmentMock,
    getAppointmentById: getAppointmentByIdMock,
    updateAppointment: updateAppointmentMock,
    cancelAppointment: jest.fn(),
    rescheduleAppointmentInPlace: rescheduleInPlaceMock,
  },
}));
jest.unstable_mockModule('../../services/appointment/appointmentQueryService.js', () => ({
  default: { getAppointmentById: jest.fn(async () => null) },
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
  DEFAULT_TENANT_ID: TENANT_ID,
  resolveTenantOrThrow: () => TENANT_ID,
}));
jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitAppointmentEvent: jest.fn(),
}));

// Sibling controller + route-level guards.
jest.unstable_mockModule('../../controllers/appointment/appointmentStatusController.js', () => ({
  updateAppointmentStatus: jest.fn((_req, res) => res.status(200).json({})),
}));
const passThrough = (_req, _res, next) => next();
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: () => passThrough,
  patientAccessGuardForResource: () => passThrough,
}));
jest.unstable_mockModule('../../middleware/sanitizeMiddleware.js', () => ({
  sanitizeAppointmentFields: passThrough,
}));
jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  ACCESS_POLICY_CODES: {
    PATIENT_APPOINTMENT_VIEW: 'PATIENT_APPOINTMENT_VIEW',
    PATIENT_APPOINTMENT_WRITE: 'PATIENT_APPOINTMENT_WRITE',
  },
  authorizePatientAccessRequest: jest.fn(async () => ({ allowed: true })),
  SAFE_PATIENT_ACCESS_DENIAL_MESSAGE: 'Access denied',
}));
jest.unstable_mockModule('../../validators/appointment/appointmentValidators.js', () => ({
  createAppointmentValidators: [],
  updateAppointmentValidators: [],
  rescheduleAppointmentValidators: [],
  updateStatusValidators: [],
}));

const { default: crudRoutes } = await import('../../routes/appointment/appointmentCrudRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.tenantId = TENANT_ID;
  req.user = { id: 9, uid: '11111111-1111-4111-8111-111111111111', role: 'RECEPTIONIST', name: 'Front Desk' };
  next();
});
app.use('/api/v1/appointments', crudRoutes);

beforeEach(() => {
  createAppointmentMock.mockReset();
  getAppointmentByIdMock.mockReset();
  rescheduleInPlaceMock.mockReset();
  updateAppointmentMock.mockReset();
  validateBookingRequestMock.mockReset();
  validateUpdateRequestMock.mockReset();
});

describe('appointmentCrudController relays AppError code + details over HTTP', () => {
  test('book relays an AppError with code and details (409)', async () => {
    validateBookingRequestMock.mockRejectedValueOnce(AppError.conflict(
      'Doctor is not accepting bookings',
      'SOME_CODE',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/appointments/book')
      .send({ patient_id: 1, doctor_id: 2, appointment_date: '2026-08-01', appointment_time: '10:00' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Doctor is not accepting bookings');
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
  });

  test('book returns the generic 500 for a non-AppError and never leaks err.message', async () => {
    validateBookingRequestMock.mockRejectedValueOnce(new Error('pg pool exhausted at 10.0.0.5'));

    const response = await request(app)
      .post('/api/v1/appointments/book')
      .send({ patient_id: 1, doctor_id: 2, appointment_date: '2026-08-01', appointment_time: '10:00' });

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed to book appointment');
    expect(response.body.message).not.toMatch(/pool exhausted/);
  });

  test('book keeps the site-local isConflict branch (details from err.conflictingId)', async () => {
    validateBookingRequestMock.mockResolvedValueOnce({
      valid: true,
      patient: { id: 1, uid: 'p-uid', name: 'Pat', phone: '+919876543210' },
      doctor: { id: 2, name: 'Dr X' },
    });
    createAppointmentMock.mockRejectedValueOnce(Object.assign(
      new Error('Slot no longer available'),
      { isConflict: true, conflictingId: 42 },
    ));

    const response = await request(app)
      .post('/api/v1/appointments/book')
      .send({
        patient_id: 1,
        doctor_id: 2,
        appointment_date: '2026-08-01',
        appointment_time: '10:00',
        confirm_duplicate: true,
      });

    expect(response.statusCode).toBe(409);
    expect(response.body.message).toBe('Time slot already booked');
    expect(response.body.details).toEqual({ conflicting_appointment_id: 42 });
    expect(response.body).not.toHaveProperty('code');
  });

  test('reschedule keeps the conflictDetailsFromError branch (statusCode 409 + conflictingId)', async () => {
    getAppointmentByIdMock.mockResolvedValueOnce({
      id: 55, patient_id: 1, doctor_id: 2, status: 'SCHEDULED',
    });
    rescheduleInPlaceMock.mockRejectedValueOnce(Object.assign(
      new Error('Time slot already booked'),
      { statusCode: 409, conflictingId: 77, conflictingTime: '13:00' },
    ));

    const response = await request(app)
      .patch('/api/v1/appointments/55/reschedule')
      .send({ appointment_date: '2026-08-01', appointment_time: '13:15' });

    expect(response.statusCode).toBe(409);
    expect(response.body.message).toBe('Time slot already booked');
    expect(response.body.details).toEqual({
      code: 'APPOINTMENT_SLOT_CONFLICT',
      conflicting_appointment_id: 77,
      conflicting_appointment_time: '13:00',
    });
  });

  test('reschedule relays a non-conflict AppError with code and details', async () => {
    getAppointmentByIdMock.mockResolvedValueOnce({
      id: 55, patient_id: 1, doctor_id: 2, status: 'SCHEDULED',
    });
    rescheduleInPlaceMock.mockRejectedValueOnce(AppError.forbidden(
      'Appointment can no longer be rescheduled',
      'RESCHEDULE_WINDOW_CLOSED',
      { reason: 'x' },
    ));

    const response = await request(app)
      .patch('/api/v1/appointments/55/reschedule')
      .send({ appointment_date: '2026-08-01', appointment_time: '13:15' });

    expect(response.statusCode).toBe(403);
    expect(response.body.code).toBe('RESCHEDULE_WINDOW_CLOSED');
    expect(response.body.details).toEqual({ reason: 'x' });
  });

  test('reschedule preserves an OP ownership-integrity conflict instead of calling it a slot conflict', async () => {
    getAppointmentByIdMock.mockResolvedValueOnce({
      id: 55, patient_id: 1, doctor_id: 2, status: 'SCHEDULED',
    });
    rescheduleInPlaceMock.mockRejectedValueOnce(AppError.conflict(
      'Changing the doctor requires an explicit accepted OP ownership handoff',
      'APPOINTMENT_RESCHEDULE_OWNER_CHANGE_REQUIRES_HANDOFF',
    ));

    const response = await request(app)
      .patch('/api/v1/appointments/55/reschedule')
      .send({
        appointment_date: '2026-08-01',
        appointment_time: '13:15',
        doctor_id: 3,
      });

    expect(response.statusCode).toBe(409);
    expect(response.body.message).toBe(
      'Changing the doctor requires an explicit accepted OP ownership handoff',
    );
    expect(response.body.code).toBe(
      'APPOINTMENT_RESCHEDULE_OWNER_CHANGE_REQUIRES_HANDOFF',
    );
    expect(response.body.details?.code).not.toBe('APPOINTMENT_SLOT_CONFLICT');
  });

  test('PUT scheduling changes use the governed same-row reschedule seam', async () => {
    getAppointmentByIdMock.mockResolvedValueOnce({
      id: 55,
      patient_id: 1,
      doctor_id: 2,
      status: 'SCHEDULED',
      appointment_date: '2026-08-01',
      appointment_time: '10:00',
    });
    validateUpdateRequestMock.mockResolvedValueOnce({ valid: true });
    rescheduleInPlaceMock.mockResolvedValueOnce({
      appointment: {
        id: 55,
        status: 'SCHEDULED',
        appointment_date: '2026-08-02',
        appointment_time: '13:15',
      },
    });

    const response = await request(app)
      .put('/api/v1/appointments/55')
      .send({
        appointment_date: '2026-08-02',
        appointment_time: '13:15',
      });

    expect(response.statusCode).toBe(200);
    expect(rescheduleInPlaceMock).toHaveBeenCalledWith(
      '55',
      expect.objectContaining({
        appointment_date: '2026-08-02',
        appointment_time: '13:15',
      }),
      expect.objectContaining({
        tenantId: TENANT_ID,
        actorRole: 'RECEPTIONIST',
      }),
    );
    expect(updateAppointmentMock).not.toHaveBeenCalled();
  });

  test('PUT relays a live OP reschedule integrity rejection', async () => {
    getAppointmentByIdMock.mockResolvedValueOnce({
      id: 55,
      patient_id: 1,
      doctor_id: 2,
      status: 'SCHEDULED',
      appointment_date: '2026-08-01',
      appointment_time: '10:00',
    });
    validateUpdateRequestMock.mockResolvedValueOnce({ valid: true });
    rescheduleInPlaceMock.mockRejectedValueOnce(AppError.conflict(
      'Changing the schedule requires the governed OP reschedule workflow',
      'APPOINTMENT_RESCHEDULE_OWNER_CHANGE_REQUIRES_HANDOFF',
    ));

    const response = await request(app)
      .put('/api/v1/appointments/55')
      .send({ appointment_date: '2026-08-02' });

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe(
      'APPOINTMENT_RESCHEDULE_OWNER_CHANGE_REQUIRES_HANDOFF',
    );
    expect(updateAppointmentMock).not.toHaveBeenCalled();
  });

  test('reschedule returns the generic 500 for a non-AppError and never leaks err.message', async () => {
    getAppointmentByIdMock.mockResolvedValueOnce({
      id: 55, patient_id: 1, doctor_id: 2, status: 'SCHEDULED',
    });
    rescheduleInPlaceMock.mockRejectedValueOnce(new Error('unexpected column ghost_column'));

    const response = await request(app)
      .patch('/api/v1/appointments/55/reschedule')
      .send({ appointment_date: '2026-08-01', appointment_time: '13:15' });

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed to reschedule appointment');
    expect(response.body.message).not.toMatch(/ghost_column/);
  });
});
