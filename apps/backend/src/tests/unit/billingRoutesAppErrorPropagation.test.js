import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — the V1 billing sibling of
// paediatricImmunisationRoutesAppErrorPropagation.test.js.
//
// billingRoutes.js guards every catch with `err.isOperational` and used to
// relay operational errors as `error(res, err.message, err.statusCode)` with
// no 4th arg, dropping `err.code` and `err.details` on the wire. The port to
// relayAppError() must forward both, while the non-operational tail
// (logger.error + next(err)) stays byte-identical — billing is a money
// surface where global-handler/Sentry visibility is deliberate.

const createInvoiceMock = jest.fn();
const getPatientInvoicesMock = jest.fn();
const getInvoiceDetailMock = jest.fn();
const recordPaymentMock = jest.fn();
const getRevenueStatsMock = jest.fn();
const submitInsuranceClaimMock = jest.fn();
const getInsuranceClaimsMock = jest.fn();
const updateClaimStatusMock = jest.fn();
const createEnhancementClaimMock = jest.fn();

jest.unstable_mockModule('../../services/billing/billingService.js', () => ({
  default: {
    createInvoice: createInvoiceMock,
    getPatientInvoices: getPatientInvoicesMock,
    getInvoiceDetail: getInvoiceDetailMock,
    recordPayment: recordPaymentMock,
    getRevenueStats: getRevenueStatsMock,
    submitInsuranceClaim: submitInsuranceClaimMock,
    getInsuranceClaims: getInsuranceClaimsMock,
    updateClaimStatus: updateClaimStatusMock,
    createEnhancementClaim: createEnhancementClaimMock,
  },
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => (_req, _res, next) => next(),
}));

jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: jest.fn(async () => {}),
}));

const { default: billingRoutes } = await import('../../routes/billing/billingRoutes.js');

const capturedErrors = [];

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  // ADMIN passes every in-file role guard (invoice/payment/claim gates).
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
  next();
});
app.use('/api/v1/billing', billingRoutes);
// Trailing error middleware standing in for the app's global handler — the
// routes' non-operational tail must keep forwarding via next(err).
app.use((err, _req, res, _next) => {
  capturedErrors.push(err);
  res.status(500).json({ success: false, message: 'Global handler generic message' });
});

beforeEach(() => {
  createInvoiceMock.mockReset();
  getPatientInvoicesMock.mockReset();
  getInvoiceDetailMock.mockReset();
  recordPaymentMock.mockReset();
  getRevenueStatsMock.mockReset();
  submitInsuranceClaimMock.mockReset();
  getInsuranceClaimsMock.mockReset();
  updateClaimStatusMock.mockReset();
  createEnhancementClaimMock.mockReset();
  capturedErrors.length = 0;
});

describe('billing routes relay AppError code + details', () => {
  test('operational AppError carries code + details over HTTP', async () => {
    createInvoiceMock.mockRejectedValueOnce(AppError.conflict(
      'An invoice already exists for this appointment',
      'SOME_CODE',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/billing/invoice')
      .send({
        patient_uid: '22222222-2222-4222-8222-222222222222',
        type: 'OP',
        items: [{ description: 'Consultation', amount: 100 }],
        subtotal: 100,
        total_amount: 100,
      });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('An invoice already exists for this appointment');
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
    expect(capturedErrors).toHaveLength(0);
  });

  test('an AppError without details produces no details key', async () => {
    getRevenueStatsMock.mockRejectedValueOnce(AppError.badRequest(
      'date_from must be before date_to',
      'REVENUE_BAD_RANGE',
    ));

    const response = await request(app)
      .get('/api/v1/billing/revenue')
      .query({ date_from: '2026-07-01', date_to: '2026-07-15' });

    expect(response.statusCode).toBe(400);
    expect(response.body.code).toBe('REVENUE_BAD_RANGE');
    expect(response.body).not.toHaveProperty('details');
  });

  test('non-AppError keeps the next(err) tail — global handler receives it, nothing leaks', async () => {
    getPatientInvoicesMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'invoice_items')"),
    );

    const response = await request(app)
      .get('/api/v1/billing/invoices/patient/33333333-3333-4333-8333-333333333333');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Global handler generic message');
    expect(JSON.stringify(response.body)).not.toMatch(/invoice_items/);
    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0].message).toMatch(/invoice_items/);
  });

  test('a statusCode-bearing but non-operational error is NOT relayed (predicate preserved)', async () => {
    const err = new Error('teapot from a library, not an AppError');
    err.statusCode = 418;
    getInvoiceDetailMock.mockRejectedValueOnce(err);

    const response = await request(app).get('/api/v1/billing/invoice/12');

    // isOperational is the file's guard — err.statusCode alone must still go
    // down the logger + next(err) tail.
    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Global handler generic message');
    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0]).toBe(err);
  });
});
