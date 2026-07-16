import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — the dependents member of the
// relayAppError sweep (paediatricImmunisationRoutesAppErrorPropagation twin).
//
// dependentsRoutes.js funnels every catch through a local handleError() whose
// AppError branch called `error(res, err.message, err.statusCode,
// err.details || undefined)` — details survived but `err.code` was dropped.
// The branch now relays via relayAppError. The file's own predicate
// (`err instanceof AppError`, stricter than the helper's statusCode check)
// and the non-AppError tail (context-labelled log + 'Internal server error'
// 500) are KEPT, and pinned below.

const listDependentsMock = jest.fn();
const linkDependentMock = jest.fn();

jest.unstable_mockModule('../../services/user/dependentsService.js', () => ({
  DependentsService: {
    listDependents: listDependentsMock,
    linkDependent: linkDependentMock,
    unlinkDependent: jest.fn(async () => ({})),
  },
}));
// The PHI access logger writes hipaa_access_log rows via prisma.
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  phiAccessLogger: () => (_req, _res, next) => next(),
  patientAccessGuard: () => (_req, _res, next) => next(),
  patientAccessGuardForResource: () => (_req, _res, next) => next(),
}));

const { default: dependentsRoutes } = await import('../../routes/user/dependentsRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  // ensureAuthedUserId needs the int DB id alongside the uid.
  req.user = { id: 42, uid: '11111111-1111-4111-8111-111111111111', role: 'PATIENT' };
  next();
});
app.use('/api/v1/users/dependents', dependentsRoutes);

beforeEach(() => {
  listDependentsMock.mockReset();
  linkDependentMock.mockReset();
});

describe('dependents routes handleError surfaces AppError code + details', () => {
  test('GET / — an AppError carrying code + details forwards both', async () => {
    listDependentsMock.mockRejectedValueOnce(AppError.conflict(
      'Dependent link ledger is locked for this guardian',
      'SOME_CODE',
      { reason: 'x' },
    ));

    const response = await request(app).get('/api/v1/users/dependents');

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Dependent link ledger is locked for this guardian');
    // The bug: this assertion FAILS on the unmodified branch (code was dropped).
    expect(response.body.code).toBe('SOME_CODE');
    expect(response.body.details).toEqual({ reason: 'x' });
    expect(response.body.requestId).toBe('test-request-id');
  });
});

describe('dependents routes non-AppError tail keeps its generic 500', () => {
  test('POST /link — 500 body is the site generic, thrown text absent', async () => {
    linkDependentMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'dependent_row')"),
    );

    const response = await request(app)
      .post('/api/v1/users/dependents/link')
      .send({ dependent_uid_or_phone: '+919876543210' });

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Internal server error');
    expect(response.body.message).not.toMatch(/dependent_row/);
    expect(response.body).not.toHaveProperty('details');
  });

  test('GET / — an AppError-SHAPED plain Error still falls to the generic 500 (instanceof predicate kept)', async () => {
    // handleError guards on `err instanceof AppError`, deliberately stricter
    // than relayAppError's own statusCode check — a random object carrying a
    // statusCode must NOT be relayed to the patient app.
    const shaped = new Error('pg_ connection meta leaked via statusCode carrier');
    shaped.statusCode = 409;
    shaped.code = 'NOT_AN_APPERROR';
    listDependentsMock.mockRejectedValueOnce(shaped);

    const response = await request(app).get('/api/v1/users/dependents');

    expect(response.statusCode).toBe(500);
    expect(response.body.message).toBe('Internal server error');
    expect(response.body).not.toHaveProperty('code');
  });
});
