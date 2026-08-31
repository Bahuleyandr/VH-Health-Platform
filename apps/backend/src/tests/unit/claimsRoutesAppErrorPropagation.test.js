import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — insurance/TPA twin of
// paediatricImmunisationRoutesAppErrorPropagation.test.js (#602 pattern).
//
// claimsRoutes.js wraps every handler in a local `wrap()` whose catch branch
// used to call `error(res, err.message, err.statusCode)` with no 4th arg
// (dropping `err.code` / `err.details` from the documented envelope) and to
// relay raw `err.message` on the generic 500. It now delegates to
// responseHelper.relayAppError with this file's generic 'Insurance error'.
// These tests drive an endpoint over HTTP and assert the response body.

const upsertPolicyMock = jest.fn();

// `submitClaim` is reached by the (unmocked) NHCX outbound dispatcher, not by
// the routes under test; it resolves to the submitted claim the real one returns.
jest.unstable_mockModule('../../services/insurance/claimsService.js', () => ({
  upsertPolicy: upsertPolicyMock,
  submitClaim: jest.fn(async ({ id }) => ({ id, status: 'submitted' })),
}));

jest.unstable_mockModule('../../services/insurance/claimCapsService.js', () => ({}));

jest.unstable_mockModule('../../services/insurance/packagesService.js', () => ({}));

// A module stub must mirror EVERY export the router's import graph reaches, or
// ESM fails the whole graph at load with "does not provide an export named X"
// and the suite reports 0 tests rather than a readable assertion failure.
// `requireTenantId` is reachable via the (deliberately unmocked) NHCX outbound
// dispatcher and `getTenantById`/`updateTenant` via nhcxTenantConfigService; the
// pass-through keeps the real guard's fail-closed shape visible, and the tenant
// getters resolve to a row so a caller takes the found branch, not its 404 one.
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const TENANT_ROW = { id: TENANT_ID, slug: 'test-tenant', status: 'ACTIVE', settings: {} };

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => TENANT_ID,
  requireTenantId: (tenantId) => tenantId || TENANT_ID,
  getTenantById: jest.fn(async () => ({ ...TENANT_ROW })),
  updateTenant: jest.fn(async (_tenantId, patch = {}) => ({ ...TENANT_ROW, ...patch })),
}));

const { default: claimsRoutes } = await import('../../routes/insurance/claimsRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'INSURANCE_COORDINATOR' };
  next();
});
app.use('/api/v1/insurance', claimsRoutes);

beforeEach(() => {
  upsertPolicyMock.mockReset();
});

describe('insurance claims route wrap() surfaces AppError code + details', () => {
  test('an AppError carrying code + details forwards both (envelope contract)', async () => {
    upsertPolicyMock.mockRejectedValueOnce(AppError.conflict(
      'A policy with this number already exists for another patient',
      'INSURANCE_POLICY_NUMBER_TAKEN',
      { reason: 'policy_number_taken' },
    ));

    const response = await request(app)
      .post('/api/v1/insurance/policies')
      .send({ policy_number: 'POL-001' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('INSURANCE_POLICY_NUMBER_TAKEN');
    expect(response.body.details).toEqual({ reason: 'policy_number_taken' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // Old wrap relayed `err.message || 'Insurance error'` — internals leaked
    // on non-prod deployments where sanitize does not genericise 5xx.
    upsertPolicyMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'policy_number')"),
    );

    const response = await request(app)
      .post('/api/v1/insurance/policies')
      .send({ policy_number: 'POL-001' });

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Insurance error');
    expect(JSON.stringify(response.body)).not.toContain('Cannot read properties');
  });
});
