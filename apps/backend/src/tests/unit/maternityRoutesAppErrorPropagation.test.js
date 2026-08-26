import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression (OBGyn merge train, D7 support lane).
//
// maternityRoutes.js wraps every handler in a local `wrap()` whose catch
// branch must relay a thrown AppError as the documented envelope
// { success, message, code, details } (apps/backend/CLAUDE.md → "AppError
// instances return structured { success, message, code, details }").
//
// The Sprint-7 wrap dropped `err.code` and `err.details` — it called
// `error(res, err.message, err.statusCode)` with no 4th arg — so every
// maternity HTTP client received only { success, message, requestId }. The
// merged maternity deep suites only assert via DIRECT SERVICE CALLS, so the
// route-layer drop was invisible. These tests drive the endpoints over HTTP
// (supertest) and assert the response body itself, which is the coverage gap.
//
// The two error shapes mirror src/services/maternity/newbornIdentity.js:
//   newbornIdentityInvalid(reason) → AppError.conflict(msg, 'NEWBORN_IDENTITY_INVALID', { reason })
//   newbornIdentityRequired()      → AppError.conflict(msg, 'NEWBORN_IDENTITY_REQUIRED')
// They are the real 409s the D7 immunisation/postnatal/apgar paths raise.

const recordApgarMock = jest.fn();
const seedScheduleForNewbornMock = jest.fn();
const recordAncVisitMock = jest.fn();

// Only the methods these tests drive need real mocks; the rest are present so
// the route module's `import * as` namespaces resolve cleanly.
const noop = jest.fn(async () => ({ id: 1 }));

jest.unstable_mockModule('../../services/maternity/maternityService.js', () => ({
  recordApgar: recordApgarMock,
  recordAncVisit: recordAncVisitMock,
  createPregnancy: noop,
  recordSupplement: noop,
  admitToLabor: noop,
  recordPartographEntry: noop,
  recordFetalKick: noop,
  recordDelivery: noop,
  recordNewborn: noop,
  recordPostnatalVisit: noop,
  getPregnancy: noop,
}));

jest.unstable_mockModule('../../services/maternity/immunisationService.js', () => ({
  seedScheduleForNewborn: seedScheduleForNewbornMock,
  recordDose: noop,
  markScheduleUpToDate: noop,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
}));

// Re-audit 2026-08 (M: mount guards): the router now carries per-route
// patientAccessGuard middleware. This suite pins the route layer's own
// contract, not authz — stub the guard factory to a pass-through so the real
// accessDecisionService import graph (and its DB reads) stays out of scope.
// Guard wiring + selectors are pinned by maternityRoutesPatientGuard.test.js.
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: () => (_req, _res, next) => next(),
}));

const { default: maternityRoutes } = await import('../../routes/maternity/maternityRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'NURSING_STAFF' };
  next();
});
app.use('/api/v1/maternity', maternityRoutes);

beforeEach(() => {
  recordApgarMock.mockReset();
  seedScheduleForNewbornMock.mockReset();
  recordAncVisitMock.mockReset();
});

describe('maternity route wrap() surfaces AppError code + details (contract compliance)', () => {
  test('409 AppError with code AND details.reason propagates both to the HTTP body', async () => {
    // Mirrors newbornIdentityInvalid('mother_identity') from the D7 identity guard.
    recordApgarMock.mockRejectedValueOnce(
      AppError.conflict(
        'The linked newborn patient identity is not a valid clinical subject',
        'NEWBORN_IDENTITY_INVALID',
        { reason: 'mother_identity' },
      ),
    );

    const response = await request(app)
      .post('/api/v1/maternity/newborns/79/apgar')
      .send({ time_minute: 5 });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    // The bug: these two assertions FAIL on the unmodified wrap (code + details
    // are dropped), and PASS once wrap forwards them through the error() helper.
    expect(response.body.code).toBe('NEWBORN_IDENTITY_INVALID');
    expect(response.body.details).toEqual({ reason: 'mother_identity' });
    // Message + requestId behaviour is preserved.
    expect(response.body.message).toBe('The linked newborn patient identity is not a valid clinical subject');
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('409 AppError with a code but no details surfaces code without an empty details key', async () => {
    // Mirrors newbornIdentityRequired() — code, no details payload.
    seedScheduleForNewbornMock.mockRejectedValueOnce(
      AppError.conflict(
        'This clinical action requires the newborn to have their own patient identity',
        'NEWBORN_IDENTITY_REQUIRED',
      ),
    );

    const response = await request(app)
      .post('/api/v1/maternity/newborns/17/immunisations/seed')
      .send({});

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('NEWBORN_IDENTITY_REQUIRED');
    // No details on this error → no `details` key at all (not `details: {}`).
    expect(response.body).not.toHaveProperty('details');
  });

  test('unexpected (non-AppError) error returns a generic 500 that never leaks err.message', async () => {
    // A programming error with no statusCode hits the 500 branch. sanitize only
    // genericises 5xx in production, so relaying err.message would leak
    // internals on non-prod (test/staging) deployments — the wrap must send a
    // hand-written generic message instead.
    recordAncVisitMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'patient_uid')"),
    );

    const response = await request(app)
      .post('/api/v1/maternity/anc-visits')
      .send({ pregnancy_id: 9, visit_date: '2026-05-14' });

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Maternity error');
    expect(response.body.message).not.toMatch(/patient_uid/);
  });
});
