import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Controller-layer contract regression — the bed member of the relayAppError
// sweep (paediatricImmunisationRoutesAppErrorPropagation twin).
//
// bedController.js repeated the pasted catch pattern inline in nine handlers.
// Five sites relayed `err.details` plainly and four (createWard / deleteWard /
// createBed / deleteBed) relayed `{ safe: true, ...(err.details || {}) }` —
// but every one of them dropped `err.code`, so a service AppError arrived as
// an anonymous status a client cannot branch on. All nine are ported to
// responseHelper.relayAppError; the four safe sites keep their confirmed-safe
// declaration via `{ safe: true }` (relayAppError forwards it as an opts flag,
// so production 5xx sanitization still honours it — see responseHelper.js).
//
// These tests drive the controller through the real routers that mount it
// (src/routes/bed/bedRoutes.js bedRouter + wardRouter) and assert the HTTP
// response body itself.

const listBedsMock = jest.fn();
const createWardMock = jest.fn();
const admitPatientMock = jest.fn();

jest.unstable_mockModule('../../services/bed/bedService.js', () => ({
  default: {
    listWards: jest.fn(async () => ({ wards: [], scope: 'tenant' })),
    createWard: createWardMock,
    updateWard: jest.fn(async () => null),
    deleteWard: jest.fn(async () => null),
    listBeds: listBedsMock,
    getBedsByWard: jest.fn(async () => ({ beds: [], scope: 'tenant' })),
    getBedSummary: jest.fn(async () => ({ summary: {} })),
    createBed: jest.fn(async () => ({})),
    updateBed: jest.fn(async () => null),
    deleteBed: jest.fn(async () => null),
    admitPatient: admitPatientMock,
    dischargePatient: jest.fn(async () => null),
    updateBedNotes: jest.fn(async () => null),
  },
}));

// The controller's success paths emit websocket events + audit rows; both pull
// in prisma/wsServer. Irrelevant to the catch blocks under test.
jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitBedEvent: jest.fn(),
}));
jest.unstable_mockModule('../../utils/logAudit.js', () => ({
  logAudit: jest.fn(async () => {}),
}));
// PHI access guards resolve care-team policy against the DB.
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  phiAccessLogger: () => (_req, _res, next) => next(),
  patientAccessGuard: () => (_req, _res, next) => next(),
  patientAccessGuardForResource: () => (_req, _res, next) => next(),
}));
jest.unstable_mockModule('../../services/security/accessDecisionService.js', () => ({
  ACCESS_POLICY_CODES: { PATIENT_BED_WRITE: 'PATIENT_BED_WRITE' },
}));
// securityAuditLogger (inside the requireRole denial path) imports the prisma
// singleton; stub it so the suite never touches a DB.
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn(async () => []) },
  prismaReadOnly: { $queryRawUnsafe: jest.fn(async () => []) },
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
  circuitBreakerStatus: jest.fn(() => ({})),
}));

const { bedRouter, wardRouter } = await import('../../routes/bed/bedRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  // SUPER_ADMIN satisfies every requireRole gate on these routers
  // (requireBedAdmin / requireClinical / requireBedAllocation).
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'SUPER_ADMIN' };
  req.tenantId = '00000000-0000-4000-8000-000000000001';
  next();
});
app.use('/api/v1/beds', bedRouter);
app.use('/api/v1/wards', wardRouter);

beforeEach(() => {
  listBedsMock.mockReset();
  createWardMock.mockReset();
  admitPatientMock.mockReset();
});

describe('bed controller catch blocks surface AppError code + details', () => {
  test('listBeds — an AppError carrying code + details forwards both', async () => {
    listBedsMock.mockRejectedValueOnce(AppError.conflict(
      'Bed board is locked for census reconciliation',
      'SOME_CODE',
      { reason: 'x' },
    ));

    const response = await request(app).get('/api/v1/beds');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Bed board is locked for census reconciliation');
    // The bug: these assertions FAIL on the unmodified catch (code was dropped).
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('admitPatient — the ICU-tier style AppError keeps status + code', async () => {
    admitPatientMock.mockRejectedValueOnce(AppError.forbidden(
      'Role cannot admit into an ICU-tier bed',
      'BED_ICU_TIER_FORBIDDEN',
    ));

    const response = await request(app)
      .post('/api/v1/beds/12/admit')
      .send({ patient_uid: '22222222-2222-4222-8222-222222222222' });

    expect(response.statusCode).toBe(403);
    expect(response.body.code).toBe('BED_ICU_TIER_FORBIDDEN');
    // No details on this error → no `details` key at all (not `details: {}`).
    expect(response.body).not.toHaveProperty('details');
  });
});

describe('bed controller { safe: true } sites (R4) keep the safe contract', () => {
  test('createWard — AppError relays message + code + details; the safe flag is consumed, never serialized', async () => {
    // The old site spread `{ safe: true, ...(err.details || {}) }` into the
    // details arg; the port passes `{ safe: true }` as relayAppError opts so
    // production 5xx sanitization still honours the hand-written message.
    // Either way `safe` must never reach the wire — pin that here alongside
    // the newly-lifted code.
    createWardMock.mockRejectedValueOnce(new AppError(
      'Ward sync backend rejected the ward create',
      502,
      'WARD_SYNC_UNAVAILABLE',
      { reason: 'x' },
    ));

    const response = await request(app)
      .post('/api/v1/wards')
      .send({ name: 'North Wing A' });

    expect(response.statusCode).toBe(502);
    expect(response.body.message).toBe('Ward sync backend rejected the ward create');
    expect(response.body.code).toBe('WARD_SYNC_UNAVAILABLE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.details).not.toHaveProperty('safe');
  });
});

describe('bed controller non-AppError paths keep their per-site generic 500', () => {
  test('listBeds — 500 body is the site generic, thrown text absent', async () => {
    listBedsMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'bed_rows')"),
    );

    const response = await request(app).get('/api/v1/beds');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Failed to list beds');
    expect(response.body.message).not.toMatch(/bed_rows/);
    expect(response.body).not.toHaveProperty('details');
  });

  test('createWard — 500 body is the site generic, thrown text absent', async () => {
    createWardMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'ward_insert')"),
    );

    const response = await request(app)
      .post('/api/v1/wards')
      .send({ name: 'North Wing A' });

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Failed to create ward');
    expect(response.body.message).not.toMatch(/ward_insert/);
  });
});
