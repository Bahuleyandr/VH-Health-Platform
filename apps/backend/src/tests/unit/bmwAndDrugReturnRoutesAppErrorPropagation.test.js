import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — wrap-sweep sibling of
// paediatricImmunisationRoutesAppErrorPropagation.test.js (#602).
//
// bmwAndDrugReturnRoutes.js wraps every handler in a local `wrap()` whose
// catch branch must relay a thrown AppError as the documented envelope
// { success, message, code, details } (apps/backend/CLAUDE.md). Before the
// relayAppError port the catch dropped `err.code`/`err.details` AND relayed
// raw `err.message` on the 500 branch (`err.message || 'BMW / Drug returns
// error'`). The port hardens the 500 to the generic message only. The
// drug-return batch state machine's transition 409s are the codes a client
// must branch on.

const transitionMock = jest.fn();
const listWasteLogsMock = jest.fn();

jest.unstable_mockModule('../../services/compliance/bmwService.js', () => ({
  createWasteLog: jest.fn(async () => ({})),
  listWasteLogs: listWasteLogsMock,
  monthlyRollup: jest.fn(async () => []),
  annualSummary: jest.fn(async () => ({})),
}));

jest.unstable_mockModule('../../services/compliance/drugReturnsService.js', () => ({
  createBatch: jest.fn(async () => ({})),
  listBatches: jest.fn(async () => []),
  getBatch: jest.fn(async () => ({})),
  addLine: jest.fn(async () => ({})),
  transition: transitionMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: bmwAndDrugReturnRoutes } = await import('../../routes/compliance/bmwAndDrugReturnRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'PHARMACY_STAFF' };
  next();
});
app.use('/api/v1/compliance', bmwAndDrugReturnRoutes);

beforeEach(() => {
  transitionMock.mockReset();
  listWasteLogsMock.mockReset();
});

describe('BMW / drug-return route wrap() surfaces AppError code + details', () => {
  test('an AppError conflict relays statusCode, code, and details over HTTP', async () => {
    transitionMock.mockRejectedValueOnce(AppError.conflict(
      'Batch is already closed and cannot transition',
      'DRUG_RETURN_BATCH_CLOSED',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/compliance/drug-returns/batches/9/transition')
      .send({ to_status: 'dispatched' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('DRUG_RETURN_BATCH_CLOSED');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // The old catch relayed `err.message || 'BMW / Drug returns error'` —
    // this pins the hardened generic-only behaviour.
    listWasteLogsMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'bmw_waste_logs')"),
    );

    const response = await request(app).get('/api/v1/compliance/bmw/log');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('BMW / Drug returns error');
    expect(response.body.message).not.toMatch(/bmw_waste_logs/);
  });
});
