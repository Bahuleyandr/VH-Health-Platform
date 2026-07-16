import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — gdprRoutes member of the relayAppError
// sweep (mirrors paediatricImmunisationRoutesAppErrorPropagation.test.js).
//
// The POST /gdpr/erase catch used `{ code: err.code, ...(err.details || {}) }`
// as the 4th arg — err.code was NESTED under `details.code` instead of the
// documented envelope root. Ported to responseHelper.relayAppError: code now
// reaches the root, err.details stay under `details`.

const executeErasureMock = jest.fn();
const checkLegalHoldMock = jest.fn();

jest.unstable_mockModule('../../services/gdpr/dataErasureService.js', () => ({
  executeErasure: executeErasureMock,
  checkLegalHold: checkLegalHoldMock,
}));

jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  deriveTenantIdFromRequest: () => '00000000-0000-4000-8000-000000000001',
}));

jest.unstable_mockModule('../../middleware/rbacMiddleware.js', () => ({
  default: () => (_req, _res, next) => next(),
  requireRole: () => (_req, _res, next) => next(),
}));

const { default: gdprRoutes } = await import('../../routes/gdprRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
  next();
});
app.use('/api/v1/gdpr', gdprRoutes);

beforeEach(() => {
  executeErasureMock.mockReset();
  checkLegalHoldMock.mockReset();
  checkLegalHoldMock.mockResolvedValue({ hasHold: false });
});

describe('GDPR erase catch relays AppError code + details', () => {
  test('AppError code + details reach the envelope root / details key', async () => {
    executeErasureMock.mockRejectedValueOnce(AppError.conflict(
      'An erasure run is already in progress for this user',
      'GDPR_ERASURE_IN_PROGRESS',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/gdpr/erase')
      .send({ uid: '22222222-2222-4222-8222-222222222222', reason: 'patient request' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('An erasure run is already in progress for this user');
    expect(response.body.code).toBe('GDPR_ERASURE_IN_PROGRESS');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('non-AppError returns the site generic 500 and never leaks err.message', async () => {
    executeErasureMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'tables_processed')"),
    );

    const response = await request(app)
      .post('/api/v1/gdpr/erase')
      .send({ uid: '22222222-2222-4222-8222-222222222222', reason: 'patient request' });

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Data erasure failed');
    expect(response.body.message).not.toMatch(/tables_processed/);
  });

  test('pre-existing legal-hold 400/403 branches stay intact', async () => {
    checkLegalHoldMock.mockResolvedValueOnce({ hasHold: true });

    const response = await request(app)
      .post('/api/v1/gdpr/erase')
      .send({ uid: '22222222-2222-4222-8222-222222222222', reason: 'patient request' });

    expect(response.statusCode).toBe(403);
    expect(response.body.message).toBe('Cannot erase: user has an active legal hold');
    expect(response.body.details).toEqual({ code: 'LEGAL_HOLD_ACTIVE' });
  });
});
