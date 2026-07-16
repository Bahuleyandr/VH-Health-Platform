import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — the blood-bank sibling of
// paediatricImmunisationRoutesAppErrorPropagation.test.js.
//
// bloodBankRoutes.js had two catch shapes before the relayAppError port:
//
//  * six plain `err.isOperational` catches relaying
//    `error(res, err.message, err.statusCode)` with no 4th arg — dropping
//    `err.code` / `err.details` on the wire; and
//  * the handleLoopFailure / handleDonorFailure / handleProcessingFailure
//    trio, which relayed `err.details ?? { code: err.code }` — so a
//    detail-less AppError arrived with its code buried under `details.code`
//    instead of at the envelope root.
//
// The port lifts `err.code` to the root everywhere and nests `err.details`
// under `details`, while the non-operational tails (logger.error + next(err))
// stay byte-identical so the global handler / Sentry keep seeing programming
// errors.

const createRequestMock = jest.fn();
const getInventoryMock = jest.fn();
const registerUnitMock = jest.fn();
const registerDonorMock = jest.fn();
const listDonorCampsMock = jest.fn();

jest.unstable_mockModule('../../services/bloodbank/bloodBankService.js', () => ({
  default: {
    createRequest: createRequestMock,
    crossMatch: jest.fn(),
    issueBlood: jest.fn(),
    recordTransfusion: jest.fn(),
    getInventory: getInventoryMock,
    getPendingRequests: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/bloodbank/donorIntakeService.js', () => ({
  default: {
    listDonors: jest.fn(),
    registerDonor: registerDonorMock,
    screenDonor: jest.fn(),
    listDeferrals: jest.fn(),
    reactivateDeferral: jest.fn(),
    recordDonationCollection: jest.fn(),
    captureDonorConsent: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/bloodbank/donorProcessingService.js', () => ({
  default: {
    listDonorCamps: listDonorCampsMock,
    createDonorCamp: jest.fn(),
    recordTtiTest: jest.fn(),
    prepareComponents: jest.fn(),
    getTraceability: jest.fn(),
    confirmDiscard: jest.fn(),
    exportRegister: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/bloodbank/transfusionSafetyService.js', () => ({
  registerUnit: registerUnitMock,
  listUnits: jest.fn(),
  crossmatchUnit: jest.fn(),
  recordBedsideVerification: jest.fn(),
  startTransfusion: jest.fn(),
  completeTransfusion: jest.fn(),
  recordReaction: jest.fn(),
}));

jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitBloodBankEvent: jest.fn(),
}));

const { default: bloodBankRoutes } = await import('../../routes/bloodbank/bloodBankRoutes.js');

const capturedErrors = [];

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'BLOOD_BANK_TECHNICIAN' };
  next();
});
app.use('/api/v1/blood-bank', bloodBankRoutes);
// Trailing error middleware standing in for the app's global handler — the
// routes' non-operational tails must keep forwarding via next(err).
app.use((err, _req, res, _next) => {
  capturedErrors.push(err);
  res.status(500).json({ success: false, message: 'Global handler generic message' });
});

beforeEach(() => {
  createRequestMock.mockReset();
  getInventoryMock.mockReset();
  registerUnitMock.mockReset();
  registerDonorMock.mockReset();
  listDonorCampsMock.mockReset();
  capturedErrors.length = 0;
});

describe('blood-bank routes relay AppError code + details', () => {
  test('plain isOperational site: AppError carries code + details over HTTP', async () => {
    createRequestMock.mockRejectedValueOnce(AppError.conflict(
      'An identical blood request is already pending for this patient',
      'SOME_CODE',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/blood-bank/request')
      .send({
        patient_uid: '22222222-2222-4222-8222-222222222222',
        blood_group: 'O+',
        units: 2,
      });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('An identical blood request is already pending for this patient');
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
    expect(capturedErrors).toHaveLength(0);
  });

  test('B5 loop helper: detail-less AppError code moves from details.code to the root', async () => {
    // Pre-port wire shape from handleLoopFailure was `details: { code }`
    // (the `err.details ?? { code: err.code }` fallback). The audited-safe
    // wire change puts the code at the envelope root and emits no details
    // key at all for a detail-less error.
    registerUnitMock.mockRejectedValueOnce(new AppError(
      'A unit with this unit number already exists',
      409,
      'UNIT_DUPLICATE',
    ));

    const response = await request(app)
      .post('/api/v1/blood-bank/units')
      .send({ unit_number: 'UNIT-001', blood_group: 'O+', expiry_date: '2027-01-01' });

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('UNIT_DUPLICATE');
    expect(response.body).not.toHaveProperty('details');
  });

  test('donor helper: AppError details are nested and the code still reaches the root', async () => {
    // Mirrors donorIntakeService DONOR_DUPLICATE_REVIEW_REQUIRED — details
    // carried `matches` while the code previously never reached the wire root.
    registerDonorMock.mockRejectedValueOnce(AppError.conflict(
      'A donor with matching identity details already exists',
      'DONOR_DUPLICATE_REVIEW_REQUIRED',
      { matches: [{ id: 7, full_name: 'Existing Donor' }] },
    ));

    const response = await request(app)
      .post('/api/v1/blood-bank/donors')
      .send({ full_name: 'Existing Donor', phone: '9991000001' });

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('DONOR_DUPLICATE_REVIEW_REQUIRED');
    expect(response.body.details).toEqual({ matches: [{ id: 7, full_name: 'Existing Donor' }] });
  });

  test('non-AppError on a plain site keeps the next(err) tail — global handler receives it, nothing leaks', async () => {
    getInventoryMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'blood_units')"),
    );

    const response = await request(app).get('/api/v1/blood-bank/inventory');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Global handler generic message');
    expect(JSON.stringify(response.body)).not.toMatch(/blood_units/);
    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0].message).toMatch(/blood_units/);
  });

  test('non-AppError through a helper keeps the next(err) tail too', async () => {
    const err = new Error('donor camp query exploded');
    listDonorCampsMock.mockRejectedValueOnce(err);

    const response = await request(app).get('/api/v1/blood-bank/donor-camps');

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Global handler generic message');
    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0]).toBe(err);
  });
});
