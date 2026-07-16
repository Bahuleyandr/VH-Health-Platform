import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — PM-JAY twin of
// paediatricImmunisationRoutesAppErrorPropagation.test.js (#602 pattern).
//
// pmjayRoutes.js wraps every handler in a local `wrap()` whose catch branch
// used to call `error(res, err.message, err.statusCode)` with no 4th arg
// (dropping `err.code` / `err.details` from the documented envelope) and to
// relay raw `err.message` on the generic 500. It now delegates to
// responseHelper.relayAppError with this file's generic 'PMJAY error'.
// These tests drive an endpoint over HTTP and assert the response body.

const upsertBeneficiaryMock = jest.fn();

jest.unstable_mockModule('../../services/insurance/pmjayService.js', () => ({
  upsertBeneficiary: upsertBeneficiaryMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: pmjayRoutes } = await import('../../routes/insurance/pmjayRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'INSURANCE_COORDINATOR' };
  next();
});
app.use('/api/v1/insurance/pmjay', pmjayRoutes);

beforeEach(() => {
  upsertBeneficiaryMock.mockReset();
});

describe('pmjay route wrap() surfaces AppError code + details', () => {
  test('an AppError carrying code + details forwards both (envelope contract)', async () => {
    upsertBeneficiaryMock.mockRejectedValueOnce(AppError.conflict(
      'This PM-JAY card is already linked to another patient',
      'PMJAY_CARD_ALREADY_LINKED',
      { reason: 'card_linked_elsewhere' },
    ));

    const response = await request(app)
      .post('/api/v1/insurance/pmjay/beneficiaries')
      .send({ pmjay_card_number: 'PMJAY-001' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('PMJAY_CARD_ALREADY_LINKED');
    expect(response.body.details).toEqual({ reason: 'card_linked_elsewhere' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // Old wrap relayed `err.message || 'PMJAY error'` — internals leaked on
    // non-prod deployments where sanitize does not genericise 5xx.
    upsertBeneficiaryMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'family_id')"),
    );

    const response = await request(app)
      .post('/api/v1/insurance/pmjay/beneficiaries')
      .send({ pmjay_card_number: 'PMJAY-001' });

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('PMJAY error');
    expect(JSON.stringify(response.body)).not.toContain('Cannot read properties');
  });
});
