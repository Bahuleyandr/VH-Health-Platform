import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

const performBulkOperationMock = jest.fn();
const updateDoctorAvailabilityMock = jest.fn();
const deleteDoctorAccountMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {
    $queryRawUnsafe: jest.fn(),
  },
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.unstable_mockModule('../../services/doctor/adminDoctorService.js', () => ({
  adminDoctorService: {
    getDoctorOverview: jest.fn(),
    getDoctorManagementList: jest.fn(),
    createDoctorAccount: jest.fn(),
    performBulkOperation: performBulkOperationMock,
    updateDoctorAvailability: updateDoctorAvailabilityMock,
    deleteDoctorAccount: deleteDoctorAccountMock,
  },
}));
jest.unstable_mockModule('../../controllers/doctor/doctorStatsController.js', () => ({
  doctorStatsController: {
    getDoctorAnalytics: jest.fn(),
    getWorkloadAnalysis: jest.fn(),
  },
}));

const { default: adminDoctorRoutes } = await import(
  '../../routes/doctor/adminDoctorRoutes.js'
);

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = {
    uid: '11111111-1111-4111-8111-111111111111',
    role: 'ADMIN',
  };
  next();
});
app.use('/api/v1/admin/doctors', adminDoctorRoutes);

const convergenceConflict = () => AppError.conflict(
  'Active-pathway appointments must use the governed lifecycle',
  'DOCTOR_APPOINTMENT_PATHWAY_CONVERGENCE_REQUIRED',
  {
    operation: 'test',
    affected_appointment_count: 1,
  }
);

beforeEach(() => {
  jest.clearAllMocks();
});

test.each([
  [
    'bulk deactivate',
    () => performBulkOperationMock.mockRejectedValueOnce(convergenceConflict()),
    () => request(app)
      .post('/api/v1/admin/doctors/bulk-operations')
      .send({ operation: 'deactivate', doctor_ids: [31] }),
  ],
  [
    'availability update',
    () => updateDoctorAvailabilityMock.mockRejectedValueOnce(convergenceConflict()),
    () => request(app)
      .put('/api/v1/admin/doctors/31/availability')
      .send({ is_available: false, reason: 'Roster change' }),
  ],
  [
    'account deletion',
    () => deleteDoctorAccountMock.mockRejectedValueOnce(convergenceConflict()),
    () => request(app)
      .delete('/api/v1/admin/doctors/31/account')
      .send({ reason: 'Left service', transfer_patients_to: 41 }),
  ],
])('%s relays the active-pathway 409 code and details', async (
  _label,
  rejectService,
  makeRequest
) => {
  rejectService();

  const response = await makeRequest();

  expect(response.statusCode).toBe(409);
  expect(response.body).toMatchObject({
    success: false,
    message: 'Active-pathway appointments must use the governed lifecycle',
    code: 'DOCTOR_APPOINTMENT_PATHWAY_CONVERGENCE_REQUIRED',
    details: {
      operation: 'test',
      affected_appointment_count: 1,
    },
    requestId: 'test-request-id',
  });
});

test('bulk operation keeps a generic 500 for a non-AppError', async () => {
  performBulkOperationMock.mockRejectedValueOnce(
    new Error('database host 10.0.0.5 refused the connection')
  );

  const response = await request(app)
    .post('/api/v1/admin/doctors/bulk-operations')
    .send({ operation: 'deactivate', doctor_ids: [31] });

  expect(response.statusCode).toBe(500);
  expect(response.body.message).toBe('Failed to perform bulk operation');
  expect(response.body.message).not.toMatch(/10\.0\.0\.5/);
});
