import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression for radiationOncologyRoutes.js —
// relay-variants port of handleFailure() onto relayAppError (mirrors
// paediatricImmunisationRoutesAppErrorPropagation.test.js). The old helper
// relayed `err.details ?? { code: err.code }`; the relay lifts err.code to the
// envelope root unconditionally and keeps err.details under `details`.

const createReferralMock = jest.fn();
const listReferralsMock = jest.fn();

jest.unstable_mockModule('../../services/clinical/radiationCoordinationService.js', () => ({
  getRadiationCoordinationSettings: jest.fn(),
  setRadiationCoordinationSettings: jest.fn(),
  createReferral: createReferralMock,
  listReferrals: listReferralsMock,
  getReferralDetail: jest.fn(),
  transitionReferralStatus: jest.fn(),
  createPlanRef: jest.fn(),
  transitionPlanStatus: jest.fn(),
  scheduleFraction: jest.fn(),
  transitionFractionStatus: jest.fn(),
  createNuclearOrder: jest.fn(),
  transitionNuclearOrderStatus: jest.fn(),
  recordRadioisotopeAdministration: jest.fn(),
  recordSafetyEvidence: jest.fn(),
  listSafetyEvidence: jest.fn(),
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: radiationOncologyRoutes } = await import('../../routes/clinical/radiationOncologyRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  // DOCTOR passes the canManage() gates.
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  next();
});
app.use('/api/v1/radiation-oncology', radiationOncologyRoutes);

beforeEach(() => {
  createReferralMock.mockReset();
  listReferralsMock.mockReset();
});

describe('radiation-oncology handleFailure() relays AppError code + details', () => {
  test('AppError rejection surfaces status, root-level code and details', async () => {
    createReferralMock.mockRejectedValueOnce(
      AppError.conflict('An open referral already exists for this patient', 'SOME_CODE', { reason: 'x' }),
    );

    const response = await request(app)
      .post('/api/v1/radiation-oncology/referrals')
      .send({ patient_uid: '22222222-2222-4222-8222-222222222222' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError rejection returns the generic 500 and never leaks err.message', async () => {
    listReferralsMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'fraction_count')"),
    );

    const response = await request(app).get('/api/v1/radiation-oncology/referrals');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to list referrals');
    expect(response.body.message).not.toMatch(/fraction_count/);
  });
});
