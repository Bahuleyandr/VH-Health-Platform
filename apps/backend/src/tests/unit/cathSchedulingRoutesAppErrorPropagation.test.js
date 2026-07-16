import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for cathSchedulingRoutes.js —
// relay-variants port of handleFailure() onto relayAppError (mirrors
// paediatricImmunisationRoutesAppErrorPropagation.test.js). The old helper
// relayed `err.details ?? { code: err.code }`; the relay lifts err.code to the
// envelope root unconditionally and keeps err.details under `details`.

const getScheduleStripMock = jest.fn();
const scheduleCaseMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/cathSchedulingRegistryService.js', () => ({
  addRegistryEntry: jest.fn(),
  cancelCaseSchedule: jest.fn(),
  getCaseSchedule: jest.fn(),
  getScheduleStrip: getScheduleStripMock,
  scheduleCase: scheduleCaseMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: cathSchedulingRoutes } = await import('../../routes/clinical/cathSchedulingRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = {
    uid: '11111111-1111-4111-8111-111111111111',
    role: 'DOCTOR',
    rawRole: 'DOCTOR',
    roles: ['DOCTOR'],
  };
  next();
});
app.use('/api/v1/cath-lab', cathSchedulingRoutes);

beforeEach(() => {
  getScheduleStripMock.mockReset();
  scheduleCaseMock.mockReset();
});

describe('cath scheduling handleFailure() relays AppError code + details', () => {
  test('AppError rejection surfaces status, root-level code and details', async () => {
    scheduleCaseMock.mockRejectedValueOnce(
      AppError.conflict('Requested slot is already booked', 'SOME_CODE', { reason: 'x' }),
    );

    const response = await request(app)
      .post('/api/v1/cath-lab/cases/42/schedule')
      .send({ resource_id: 7, starts_at: '2026-07-16T09:00:00Z' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError rejection returns the generic 500 and never leaks err.message', async () => {
    getScheduleStripMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'room_allocations')"),
    );

    const response = await request(app).get('/api/v1/cath-lab/schedule');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to load schedule strip');
    expect(response.body.message).not.toMatch(/room_allocations/);
  });
});
