import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

import { AppError } from '../../utils/AppError.js';

// Route-layer contract regression — the paediatric twin of
// maternityRoutesAppErrorPropagation.test.js (#598).
//
// paediatricImmunisationRoutes.js wraps every handler in a local `wrap()`
// whose catch branch must relay a thrown AppError as the documented envelope
// { success, message, code, details } (apps/backend/CLAUDE.md). #598 fixed
// the maternity copy of this pasted pattern; the paediatric copy still called
// `error(res, err.message, err.statusCode)` with no 4th arg, dropping
// `err.code` and `err.details` — so over HTTP:
//
//   * the D6-R2 422 IMMUNISATION_SCHEDULE_NOT_CONFIGURED arrived as an
//     anonymous 422 a client cannot branch on, and
//   * the three documented 409s (HISTORY_FINAL / LINK_CHANGED /
//     LINK_NOT_EXACT — the #589 retry-semantics triple) were
//     indistinguishable from each other on the wire.
//
// The paediatric deep suites assert via direct service calls, so the
// route-layer drop was invisible. These tests drive the endpoints over HTTP
// (supertest) and assert the response body itself.

const seedScheduleForPatientMock = jest.fn();
const recordDoseMock = jest.fn();
const listForPatientMock = jest.fn();

jest.unstable_mockModule('../../services/paediatric/paediatricImmunisationService.js', () => ({
  listCatalogue: jest.fn(async () => []),
  seedScheduleForPatient: seedScheduleForPatientMock,
  listForPatient: listForPatientMock,
  listDueForPatient: jest.fn(async () => []),
  recordDose: recordDoseMock,
}));

// These are ROUTE unit tests — actor context and error propagation — not PHI
// authorization tests. The router now carries a per-route
// patientAccessGuardForResource, whose real implementation reaches the database;
// mock it to a pass-through so these suites keep testing what they are about.
// The guard's PRESENCE is asserted structurally by
// mountLevelPatientGuardCensus.test.js, so mocking it here weakens nothing.
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard: () => (_req, _res, next) => next(),
  patientAccessGuardForResource: () => (_req, _res, next) => next(),
  phiAccessLogger: () => (_req, _res, next) => next()
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => '00000000-0000-4000-8000-000000000001',
  // requireTenantId is reached through the router's new per-route
  // patientAccessGuardForResource -> accessDecisionService import chain. An ESM
  // mock factory must provide EVERY export the graph imports, or the suite fails
  // to LOAD with "does not provide an export named ..." — which reads like a
  // missing test rather than a missing mock line.
  requireTenantId: (tenantId) => tenantId,
  // careTeamEnforcement reads the tenant to resolve care_team_enforcement_mode.
  // null makes it fall back to the env/default posture, which is 'shadow' — the
  // behaviour these suites already assume.
  getTenantById: async () => null,
}));

const { default: paediatricRoutes } = await import('../../routes/paediatric/paediatricImmunisationRoutes.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.id = 'test-request-id';
  req.user = { uid: '11111111-1111-4111-8111-111111111111', role: 'NURSING_STAFF' };
  next();
});
app.use('/api/v1/paediatric', paediatricRoutes);

beforeEach(() => {
  seedScheduleForPatientMock.mockReset();
  recordDoseMock.mockReset();
  listForPatientMock.mockReset();
});

describe('paediatric immunisation route wrap() surfaces AppError code + details', () => {
  test('the D6-R2 422 IMMUNISATION_SCHEDULE_NOT_CONFIGURED carries its code over HTTP', async () => {
    // The exact error catalogueStatus.scheduleNotConfiguredError() raises when a
    // tenant has no active vaccine_catalogue rows (#599). Code, no details.
    seedScheduleForPatientMock.mockRejectedValueOnce(new AppError(
      'No immunisation schedule is configured for this facility. An administrator '
      + 'must import a vaccine schedule (after clinical sign-off) before doses can be scheduled.',
      422,
      'IMMUNISATION_SCHEDULE_NOT_CONFIGURED',
    ));

    const response = await request(app)
      .post('/api/v1/paediatric/immunisations/seed')
      .send({ patient_uid: '22222222-2222-4222-8222-222222222222', dob: '2026-06-08' });

    expect(response.statusCode).toBe(422);
    expect(response.body.success).toBe(false);
    // The bug: this assertion FAILS on the unmodified wrap (code is dropped).
    expect(response.body.code).toBe('IMMUNISATION_SCHEDULE_NOT_CONFIGURED');
    // No details on this error → no `details` key at all (not `details: {}`).
    expect(response.body).not.toHaveProperty('details');
    expect(response.body.requestId).toBe('test-request-id');
  });

  test('the 409 retry triple is disambiguated by code (HISTORY_FINAL shown)', async () => {
    // recordDose raises three distinct 409s (HISTORY_FINAL / LINK_CHANGED /
    // LINK_NOT_EXACT) that #589's client retry semantics branch on. Without
    // the code they are identical on the wire.
    recordDoseMock.mockRejectedValueOnce(AppError.conflict(
      'This dose is finalised on the newborn record and cannot be re-recorded',
      'PAEDIATRIC_IMMUNISATION_HISTORY_FINAL',
    ));

    const response = await request(app)
      .post('/api/v1/paediatric/immunisations/12/given')
      .send({ status: 'given' });

    expect(response.statusCode).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('PAEDIATRIC_IMMUNISATION_HISTORY_FINAL');
  });

  test('an AppError carrying details forwards them (envelope contract)', async () => {
    // No current paediatric error attaches details, but the documented envelope
    // mandates forwarding them whenever a service does — pinned here on a real
    // code so a future details payload cannot be silently dropped again.
    recordDoseMock.mockRejectedValueOnce(AppError.conflict(
      'Stored newborn link is no longer the unique exact match',
      'PAEDIATRIC_IMMUNISATION_LINK_NOT_EXACT',
      { newborn_count: 2, dose_count: 1 },
    ));

    const response = await request(app)
      .post('/api/v1/paediatric/immunisations/12/given')
      .send({ status: 'given' });

    expect(response.statusCode).toBe(409);
    expect(response.body.code).toBe('PAEDIATRIC_IMMUNISATION_LINK_NOT_EXACT');
    expect(response.body.details).toEqual({ newborn_count: 2, dose_count: 1 });
  });

  test('unexpected (non-AppError) error returns a generic 500 that never leaks err.message', async () => {
    // sanitize only genericises 5xx in production, so relaying err.message
    // would leak internals on non-prod (test/staging) deployments — the wrap
    // must send a hand-written generic message instead (mirrors #598).
    listForPatientMock.mockRejectedValueOnce(
      new Error("Cannot read properties of undefined (reading 'vaccine_catalogue_id')"),
    );

    const response = await request(app)
      .get('/api/v1/paediatric/immunisations/patient/33333333-3333-4333-8333-333333333333');

    expect(response.statusCode).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.message).toBe('Paediatric immunisation error');
    expect(response.body.message).not.toMatch(/vaccine_catalogue_id/);
  });
});
