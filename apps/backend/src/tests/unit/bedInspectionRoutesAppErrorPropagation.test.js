import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — wrap-sweep sibling of
// paediatricImmunisationRoutesAppErrorPropagation.test.js (#602).
//
// bedInspectionRoutes.js wraps every handler in a local `wrap()` whose
// catch branch must relay a thrown AppError as the documented envelope
// { success, message, code, details } (apps/backend/CLAUDE.md). Before the
// relayAppError port the catch dropped `err.code`/`err.details` AND relayed
// raw `err.message` on the 500 branch (`err.message || 'Bed inspection
// error'`). The port hardens the 500 to the generic message only.

const recordDecisionMock = jest.fn();
const getActiveForPatientMock = jest.fn();

jest.unstable_mockModule('../../services/bed/bedInspectionService.js', () => ({
  startInspection: jest.fn(async () => ({})),
  recordDecision: recordDecisionMock,
  getActiveForPatient: getActiveForPatientMock,
  listForAppointment: jest.fn(async () => []),
  expireStaleInspections: jest.fn(async () => ({ expired: 0 })),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: bedInspectionRoutes } = await import('../../routes/bed/bedInspectionRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMISSION_OFFICER' };
  next();
});
app.use('/api/v1/bed-inspections', bedInspectionRoutes);

beforeEach(() => {
  recordDecisionMock.mockReset();
  getActiveForPatientMock.mockReset();
});

describe('bed inspection route wrap() surfaces AppError code + details', () => {
  test('an AppError conflict relays statusCode, code, and details over HTTP', async () => {
    recordDecisionMock.mockRejectedValueOnce(AppError.conflict(
      'This inspection already has a recorded decision',
      'BED_INSPECTION_ALREADY_DECIDED',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/bed-inspections/7/decide')
      .send({ decision: 'accepted', chosen_bed_id: 42 });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('BED_INSPECTION_ALREADY_DECIDED');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // The old catch relayed `err.message || 'Bed inspection error'` — this
    // pins the hardened generic-only behaviour.
    getActiveForPatientMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'bed_inspections')"),
    );

    const response = await request(app)
      .get('/api/v1/bed-inspections/patient/33333333-3333-4333-8333-333333333333/active');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Bed inspection error');
    expect(response.body.message).not.toMatch(/bed_inspections/);
  });
});
