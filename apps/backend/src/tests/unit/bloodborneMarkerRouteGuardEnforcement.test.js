/**
 * Blood-borne marker routes — the guard actually DECIDES, end to end.
 *
 * bloodborneMarkerRouteGuards.test.js is a census: it mocks
 * phiAccessMiddleware and pins the wiring (every route guarded, the options,
 * the chain order). bloodborneMarkerRoutes.test.js mocks the guard too, so its
 * 400s describe layers that in production sit BEHIND a 403. Neither file can
 * fail if the guard stops refusing, because in both of them the guard is a
 * pass-through.
 *
 * ESM module mocks are per-file, so this is a separate file that mocks prisma
 * and the service/idempotency plumbing but runs the REAL patientAccessGuard.
 * It pins the one thing the census cannot: with `requirePatientContext: true`
 * and no care-team mode governance on this call site (so always enforce), a
 * :patientUid that resolves to no PATIENT row in the tenant is a 403
 * PATIENT_CONTEXT_REQUIRED that never reaches the service — on the read AND on
 * the void, where it also never reaches the idempotency claim.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const queryRawUnsafeMock = jest.fn();
const prismaMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
  $executeRawUnsafe: jest.fn(),
  $transaction: jest.fn(),
  $on: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  __esModule: true,
  default: prismaMock,
  prismaReadOnly: prismaMock,
  setTenant: jest.fn(),
  setTenantTx: jest.fn(),
  isTenantTransactionClient: () => false,
  circuitBreakerStatus: () => ({}),
  pinSessionTimeZoneToUrl: (url) => url,
  evaluateTenantRlsPosture: () => ({}),
  tenantRlsRuntimeRole: () => null,
  tenantRlsRolePosture: async () => ({}),
  logTenantRlsRolePosture: async () => {},
  rlsDisabledLogLevel: () => 'warn',
  tenantRlsPostureMustFailClosed: () => false,
  ensureTenantRlsRuntimeRoleGrants: async () => {},
}));

const listMarkersForPatient = jest.fn();
const voidMarker = jest.fn();

jest.unstable_mockModule('../../services/clinical/bloodborneMarkerService.js', () => ({
  DEFAULT_VALIDITY_DAYS: 90,
  listMarkersForPatient,
  voidMarker,
}));

// A jest.fn so "the request never reached the claim" is observable, not
// inferred from the status code.
const idempotencyMiddleware = jest.fn(function idempotencyMiddleware(_req, _res, next) {
  return next();
});

jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey: () => idempotencyMiddleware,
}));

// phiAccessMiddleware is deliberately NOT mocked — it is what is under test.
const { default: router } = await import('../../routes/clinical/bloodborneMarkerRoutes.js');

const PATIENT_UID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ACTOR_UID = '99999999-8888-4777-8666-555555554444';

/** Route prisma by the SQL the access engine issues; anything else → no rows. */
function dispatch(handlers) {
  queryRawUnsafeMock.mockImplementation(async (sql) => {
    for (const [needle, rows] of handlers) {
      if (sql.includes(needle)) return rows;
    }
    return [];
  });
}

// Distinct tenant id per test — tenantService caches tenant rows for 60s.
function appFor({ tenantId, role = 'OT_NURSE' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = tenantId;
    req.user = { uid: ACTOR_UID, id: 9, role };
    next();
  });
  app.use('/x', router);
  return app;
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  listMarkersForPatient.mockReset();
  voidMarker.mockReset();
  idempotencyMiddleware.mockClear();
  listMarkersForPatient.mockResolvedValue({ markers: [], reuse_status: { status: 'unknown' } });
  voidMarker.mockResolvedValue({ id: 1 });
});

describe('real patientAccessGuard on the blood-borne marker routes', () => {
  it('GET: a well-formed uid that is no PATIENT in this tenant is 403, not a read', async () => {
    // The uid passes requirePatientUidParam's shape check; it simply resolves
    // to nothing. Without requirePatientContext this is no_patient_context and
    // the handler would read blood-borne markers by that uid anyway.
    dispatch([['FROM users', []]]);

    const res = await request(appFor({ tenantId: '11111111-2222-4333-8444-0000000000a1' }))
      .get(`/x/patient/${PATIENT_UID}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PATIENT_CONTEXT_REQUIRED');
    expect(listMarkersForPatient).not.toHaveBeenCalled();
  });

  it('POST void: the same refusal, and the idempotency key is never claimed', async () => {
    dispatch([['FROM users', []]]);

    const res = await request(appFor({ tenantId: '11111111-2222-4333-8444-0000000000a2' }))
      .post(`/x/patient/${PATIENT_UID}/markers/1/void`)
      .set('Idempotency-Key', 'void-1-abc')
      .send({ reason: 'Entered in error' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PATIENT_CONTEXT_REQUIRED');
    expect(voidMarker).not.toHaveBeenCalled();
    // The guard is the first layer, so a refused void does not burn the
    // caller's key on a request that never happened.
    expect(idempotencyMiddleware).not.toHaveBeenCalled();
  });

  it('positive control: a resolvable patient the actor is on the care team for reaches the service', async () => {
    // Proves the two 403s above are the guard deciding, not the harness
    // failing to reach the router at all.
    dispatch([
      ['FROM users', [{ id: 7, uid: PATIENT_UID }]],
      ['FROM care_team_members ctm', [{ id: 1, care_team_id: 4 }]],
    ]);

    const res = await request(appFor({ tenantId: '11111111-2222-4333-8444-0000000000a3' }))
      .get(`/x/patient/${PATIENT_UID}`);

    expect(res.status).toBe(200);
    expect(listMarkersForPatient).toHaveBeenCalledTimes(1);
  });
});
