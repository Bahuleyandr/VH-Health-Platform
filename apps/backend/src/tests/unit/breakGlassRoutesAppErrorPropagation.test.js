import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — the break-glass member of the
// relayAppError sweep (paediatricImmunisationRoutesAppErrorPropagation twin).
//
// breakGlassRoutes.js activate/revoke handlers relayed
// `error(res, err.message, err.statusCode, err.details || null)` — details
// survived, but `err.code` was dropped, so the service's machine-readable
// eligibility/validation codes never reached the wire. Both catches are
// folded into relayAppError, which also keeps the old `|| null` behaviour of
// never emitting a spurious `details` key for a details-less AppError.

const activateBreakGlassMock = jest.fn();
const revokeBreakGlassMock = jest.fn();

jest.unstable_mockModule('../../services/security/breakGlassService.js', () => ({
  activateBreakGlass: activateBreakGlassMock,
  revokeBreakGlass: revokeBreakGlassMock,
  listActiveBreakGlass: jest.fn(async () => []),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));
jest.unstable_mockModule('../../utils/hipaaAudit.js', () => ({
  logPhiAccess: jest.fn(),
}));
// securityAuditLogger inside the wrapAutoRBAC stack imports the prisma
// singleton; stub it so the suite never touches a DB.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(async () => []) },
  prismaReadOnly: { $queryRawUnsafe: jest.fn(async () => []) },
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
  circuitBreakerStatus: jest.fn(() => ({})),
}));
// Rate limiting pulls in redis + tenant settings; irrelevant to the catch
// blocks under test.
jest.unstable_mockModule('../../middleware/rateLimitMiddleware.js', () => ({
  dynamicRoleRateLimiter: (_req, _res, next) => next(),
  getRateLimiter: () => (_req, _res, next) => next(),
}));

const { default: breakGlassRoutes } = await import('../../routes/security/breakGlassRoutes.js');

const PATIENT_UID = '22222222-2222-4222-8222-222222222222';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  // ADMIN is in the patientAccessBreakGlassRoutes RBAC set
  // (rbacConfig.js — SUPER_ADMIN / ADMIN / CMO / MEDICAL_SUPERINTENDENT).
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' };
  next();
});
app.use('/api/v1/patient-access/break-glass', breakGlassRoutes);

beforeEach(() => {
  activateBreakGlassMock.mockReset();
  revokeBreakGlassMock.mockReset();
});

describe('break-glass handlers surface AppError code + details', () => {
  test('POST activate — an AppError carrying code + details forwards both', async () => {
    activateBreakGlassMock.mockRejectedValueOnce(AppError.conflict(
      'An active break-glass session already exists for this patient',
      'SOME_CODE',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/patient-access/break-glass')
      .send({ patient_uid: PATIENT_UID, reason: 'Emergency cross-team access for this patient' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('An active break-glass session already exists for this patient');
    // The bug: this assertion FAILS on the unmodified catch (code was dropped).
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('DELETE revoke — a details-less AppError keeps code but emits no spurious details key', async () => {
    // The old site passed `err.details || null` as the 4th arg; relayAppError
    // must preserve that: no `details: {}` (and no `details: null`) on the wire.
    revokeBreakGlassMock.mockRejectedValueOnce(AppError.notFound(
      'Break-glass session not found',
      'BREAK_GLASS_NOT_FOUND',
    ));

    const response = await request(app)
      .delete('/api/v1/patient-access/break-glass/12');

    expect(response.statusCode).toBe(404);
    expect(response.body.code).toBe('BREAK_GLASS_NOT_FOUND');
    expect(response.body).not.toHaveProperty('details');
  });
});

describe('break-glass handlers keep their per-site generic 500 for programming errors', () => {
  test('POST activate — 500 body is the site generic, thrown text absent', async () => {
    activateBreakGlassMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'break_glass_row')"),
    );

    const response = await request(app)
      .post('/api/v1/patient-access/break-glass')
      .send({ patient_uid: PATIENT_UID, reason: 'Emergency cross-team access for this patient' });

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to activate break-glass access');
    expect(response.body.message).not.toMatch(/break_glass_row/);
    expect(response.body).not.toHaveProperty('details');
  });

  test('DELETE revoke — 500 body is the site generic, thrown text absent', async () => {
    revokeBreakGlassMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'revoke_row')"),
    );

    const response = await request(app)
      .delete('/api/v1/patient-access/break-glass/12');

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed to revoke break-glass access');
    expect(response.body.message).not.toMatch(/revoke_row/);
  });
});
