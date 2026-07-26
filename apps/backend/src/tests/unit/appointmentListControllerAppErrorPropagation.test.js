import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const getAppointmentsMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn() },
}));
jest.unstable_mockModule('../../services/appointment/appointmentQueryService.js', () => ({
  default: {
    getAppointments: getAppointmentsMock,
  },
}));
jest.unstable_mockModule('../../services/doctor/doctorRefService.js', () => ({
  resolveDoctorFilterId: jest.fn(async () => null),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: req => req.tenantId,
}));

const { listAppointments } = await import(
  '../../controllers/appointment/appointmentListController.js'
);

const app = express();
app.use((req, _res, next) => {
  req.id = 'appointment-list-test';
  req.tenantId = TENANT_ID;
  req.user = { id: 7, role: 'ADMIN', name: 'Front Desk' };
  next();
});
app.get('/list', listAppointments);

beforeEach(() => {
  getAppointmentsMock.mockReset();
});

test('admission-source ambiguity relays its exact 409 contract', async () => {
  getAppointmentsMock.mockRejectedValueOnce(AppError.conflict(
    'Admission advice has ambiguous accepted OP-to-inpatient transfer lineage',
    'OP_INPATIENT_ADMISSION_SOURCE_AMBIGUOUS',
    { appointment_id: 71 },
  ));

  const response = await request(app)
    .get('/list?advised_for_admission=true');

  expect(response.statusCode).toBe(409);
  expect(response.body).toMatchObject({
    success: false,
    message: 'Admission advice has ambiguous accepted OP-to-inpatient transfer lineage',
    code: 'OP_INPATIENT_ADMISSION_SOURCE_AMBIGUOUS',
    details: { appointment_id: 71 },
  });
});

test('unexpected list failures retain the generic 500 contract', async () => {
  getAppointmentsMock.mockRejectedValueOnce(
    new Error('internal query text must not escape'),
  );

  const response = await request(app).get('/list');

  expect(response.statusCode).toBe(500);
  expect(response.body.message).toBe('Failed to retrieve appointments');
  expect(response.body.message).not.toMatch(/query text/i);
});
