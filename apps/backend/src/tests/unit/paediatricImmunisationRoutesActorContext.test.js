import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const seedScheduleForPatientMock = jest.fn(async () => ({ inserted: 1 }));
const recordDoseMock = jest.fn(async () => ({ id: 22, status: 'given' }));

jest.unstable_mockModule('../../services/paediatric/paediatricImmunisationService.js', () => ({
  seedScheduleForPatient: seedScheduleForPatientMock,
  recordDose: recordDoseMock
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
  getTenantById: async () => null
}));

const { default: paediatricImmunisationRoutes } =
  await import('../../routes/paediatric/paediatricImmunisationRoutes.js');

const ACTOR_UID = '11111111-1111-4111-8111-111111111111';
const SPOOFED_UID = '99999999-9999-4999-8999-999999999999';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { uid: ACTOR_UID, role: 'NURSING_STAFF' };
  next();
});
app.use('/api/v1/paediatric', paediatricImmunisationRoutes);

beforeEach(() => {
  seedScheduleForPatientMock.mockClear();
  recordDoseMock.mockClear();
});

describe('paediatric immunisation route actor context', () => {
  test('explicit schedule seed forwards the authenticated actor', async () => {
    const response = await request(app).post('/api/v1/paediatric/immunisations/seed').send({
      patient_uid: '33333333-3333-4333-8333-333333333333',
      dob: '2024-01-01',
      actor_uid: SPOOFED_UID,
      actor_role: 'SUPER_ADMIN'
    });

    expect(response.statusCode).toBe(200);
    expect(seedScheduleForPatientMock).toHaveBeenCalledWith({
      patientUid: '33333333-3333-4333-8333-333333333333',
      dob: '2024-01-01',
      tenantId: '00000000-0000-4000-8000-000000000001',
      actorUid: ACTOR_UID,
      actorRole: 'NURSING_STAFF'
    });
  });

  test('dose actor ignores a body-spoofed given_by value', async () => {
    const response = await request(app).post('/api/v1/paediatric/immunisations/22/given').send({
      status: 'given',
      given_by: SPOOFED_UID,
      batch_number: 'BATCH-22'
    });

    expect(response.statusCode).toBe(200);
    expect(recordDoseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        immunisationId: '22',
        givenBy: ACTOR_UID,
        actorRole: 'NURSING_STAFF',
        batchNumber: 'BATCH-22'
      })
    );
  });
});
