import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const ADMIN_UID = '20000000-0000-4000-8000-000000000001';

const transitionAppointmentMock = jest.fn();
const createAppointmentMock = jest.fn();
const rescheduleAppointmentInPlaceMock = jest.fn();
const queryRawUnsafeMock = jest.fn();

jest.unstable_mockModule('../../config/routeWrapper.js', () => ({
  wrapAutoRBAC: (router, _name, routeMap) => {
    for (const [method, routes] of Object.entries(routeMap)) {
      for (const [path, handler] of routes) router[method](path, handler);
    }
  },
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: queryRawUnsafeMock,
  },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.unstable_mockModule(
  '../../services/appointment/appointmentLifecycleService.js',
  () => ({
    transitionAppointment: transitionAppointmentMock,
  }),
);
jest.unstable_mockModule(
  '../../services/appointment/appointmentService.js',
  () => ({
    default: {
      createAppointment: createAppointmentMock,
      rescheduleAppointmentInPlace: rescheduleAppointmentInPlaceMock,
    },
  }),
);
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: req => req.tenantId,
}));

const { default: appointmentAdminRoutes } = await import(
  '../../routes/appointment/appointmentAdminRoutes.js'
);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.tenantId = TENANT_ID;
  req.user = {
    id: 9,
    uid: ADMIN_UID,
    role: 'ADMIN',
    name: 'Admin One',
  };
  next();
});
app.use('/api/v1/appointments/admin', appointmentAdminRoutes);
app.use('/api/v1/admin/appointments', appointmentAdminRoutes);

beforeEach(() => {
  transitionAppointmentMock.mockReset();
  createAppointmentMock.mockReset();
  rescheduleAppointmentInPlaceMock.mockReset();
  queryRawUnsafeMock.mockReset();
  transitionAppointmentMock.mockImplementation(async input => ({
    appointment: {
      id: Number(input.appointmentId),
      status: input.toStatus,
      tenant_id: input.tenantId,
    },
  }));
  createAppointmentMock.mockResolvedValue({
    id: 41,
    status: 'SCHEDULED',
    tenant_id: TENANT_ID,
  });
});

test.each([
  '/api/v1/appointments/admin',
  '/api/v1/admin/appointments',
])('%s bulk cancellation uses the canonical tenant-scoped lifecycle', async prefix => {
  const response = await request(app)
    .post(`${prefix}/bulk-update-status`)
    .send({
      appointment_ids: [11],
      status: 'cancelled',
      reason: 'Duplicate booking',
    });

  expect(response.status).toBe(200);
  expect(transitionAppointmentMock).toHaveBeenCalledTimes(1);
  expect(transitionAppointmentMock).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: TENANT_ID,
      appointmentId: 11,
      toStatus: 'CANCELLED',
      actorUid: ADMIN_UID,
      source: 'admin_bulk_update',
    }),
  );
  expect(queryRawUnsafeMock).not.toHaveBeenCalled();
});

test.each([
  '/api/v1/appointments/admin',
  '/api/v1/admin/appointments',
])('%s rejects a multi-ID batch before the first item can commit', async prefix => {
  const response = await request(app)
    .post(`${prefix}/bulk-update-status`)
    .send({
      appointment_ids: [11, 12],
      status: 'cancelled',
      reason: 'Second row would fail',
    });

  expect(response.status).toBe(409);
  expect(response.body.code).toBe('APPOINTMENT_MULTI_STATUS_UPDATE_RETIRED');
  expect(transitionAppointmentMock).not.toHaveBeenCalled();
  expect(queryRawUnsafeMock).not.toHaveBeenCalled();
});

test.each([
  '/api/v1/appointments/admin',
  '/api/v1/admin/appointments',
])('%s rejects unsupported bulk completion before any mutation', async prefix => {
  const response = await request(app)
    .post(`${prefix}/bulk-update-status`)
    .send({
      appointment_ids: [11],
      status: 'completed',
    });

  expect(response.status).toBe(409);
  expect(response.body).toMatchObject({
    success: false,
    code: 'APPOINTMENT_BULK_COMPLETION_UNSUPPORTED',
  });
  expect(transitionAppointmentMock).not.toHaveBeenCalled();
  expect(queryRawUnsafeMock).not.toHaveBeenCalled();
});

test.each([
  '/api/v1/appointments/admin',
  '/api/v1/admin/appointments',
])('%s conflict cancellation cannot bypass lifecycle evidence', async prefix => {
  const response = await request(app)
    .post(`${prefix}/resolve-conflict`)
    .send({
      conflict_appointments: [21, 22],
      resolution_action: 'cancel_second',
    });

  expect(response.status).toBe(200);
  expect(transitionAppointmentMock).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: TENANT_ID,
      appointmentId: 22,
      toStatus: 'CANCELLED',
      source: 'admin_conflict_resolution',
    }),
  );
  expect(queryRawUnsafeMock).not.toHaveBeenCalled();
});

test.each([
  '/api/v1/appointments/admin',
  '/api/v1/admin/appointments',
])('%s override booking uses the canonical creation-evidence seam', async prefix => {
  const response = await request(app)
    .post(`${prefix}/override-book`)
    .send({
      patient_id: 31,
      doctor_id: 32,
      appointment_date: '2026-07-24T09:30:00.000Z',
      reason: 'Urgent review',
      override_reason: 'Clinician approved',
      ignore_conflicts: true,
    });

  expect(response.status).toBe(200);
  expect(createAppointmentMock).toHaveBeenCalledWith(
    expect.objectContaining({
      patient_id: 31,
      doctor_id: 32,
      appointment_date: '2026-07-24',
      appointment_time: '09:30',
      admin_override: true,
      tenant_id: TENANT_ID,
    }),
    expect.objectContaining({
      actorUid: ADMIN_UID,
      ignoreConflicts: true,
      source: 'admin_override_book',
    }),
  );
  expect(queryRawUnsafeMock).not.toHaveBeenCalled();
});

test.each([
  '/api/v1/appointments/admin',
  '/api/v1/admin/appointments',
])('%s retires appointment hard deletion without touching a live source', async prefix => {
  const response = await request(app)
    .delete(`${prefix}/bulk-delete`)
    .send({
      appointment_ids: [41],
      reason: 'cleanup',
    });

  expect(response.status).toBe(410);
  expect(response.body).toMatchObject({
    success: false,
    code: 'APPOINTMENT_HARD_DELETE_RETIRED',
  });
  expect(transitionAppointmentMock).not.toHaveBeenCalled();
  expect(queryRawUnsafeMock).not.toHaveBeenCalled();
});
