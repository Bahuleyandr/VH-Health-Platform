import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — doctor-productivity twin of
// paediatricImmunisationRoutesAppErrorPropagation.test.js (#602 pattern).
//
// productivityRoutes.js wraps every handler in a local `wrap()` whose catch
// branch used to call `error(res, err.message, err.statusCode)` with no 4th
// arg (dropping `err.code` / `err.details` from the documented envelope) and
// to relay raw `err.message` on the generic 500. It now delegates to
// responseHelper.relayAppError with this file's generic 'Productivity error'.
// These tests drive an endpoint over HTTP and assert the response body.
//
// clinicalCalculators.js is deliberately NOT mocked — it is pure compute
// (imports only AppError) and is iterated at module load to register the
// per-calculator routes.

const listForUserMock = jest.fn();

jest.unstable_mockModule('../../services/productivity/smartPhrasesService.js', () => ({
  listForUser: listForUserMock,
}));

jest.unstable_mockModule('../../services/productivity/orderSetsService.js', () => ({}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

const { default: productivityRoutes } = await import('../../routes/productivity/productivityRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'DOCTOR' };
  next();
});
app.use('/api/v1/productivity', productivityRoutes);

beforeEach(() => {
  listForUserMock.mockReset();
});

describe('productivity route wrap() surfaces AppError code + details', () => {
  test('an AppError carrying code + details forwards both (envelope contract)', async () => {
    listForUserMock.mockRejectedValueOnce(AppError.conflict(
      'Smart-phrase library is mid-import for this tenant',
      'PRODUCTIVITY_PHRASE_IMPORT_IN_PROGRESS',
      { reason: 'import_lock' },
    ));

    const response = await request(app).get('/api/v1/productivity/phrases');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('PRODUCTIVITY_PHRASE_IMPORT_IN_PROGRESS');
    expect(response.body.details).toEqual({ reason: 'import_lock' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('unexpected (non-AppError) error returns the generic 500 and never leaks err.message', async () => {
    // Old wrap relayed `err.message || 'Productivity error'` — internals
    // leaked on non-prod deployments where sanitize does not genericise 5xx.
    listForUserMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'phrase_code')"),
    );

    const response = await request(app).get('/api/v1/productivity/phrases');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Productivity error');
    expect(JSON.stringify(response.body)).not.toContain('Cannot read properties');
  });
});
