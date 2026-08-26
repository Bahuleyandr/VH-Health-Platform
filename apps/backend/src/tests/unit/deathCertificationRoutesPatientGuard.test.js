// src/tests/unit/deathCertificationRoutesPatientGuard.test.js
//
// Re-audit 2026-08 (M: mount guards). The DEATH_CERTIFICATION
// patientAccessGuard used to sit on the app.js mount, where req.params is
// empty (Express has not matched a route yet), so it returned
// no_patient_context without ever evaluating a policy. The guard now sits on
// each single-subject route in deathCertificationRoutes.js with an explicit
// patientSelector. These tests pin, with a mocked prisma:
//   (a) each selector resolves the subject from the identifier the handler
//       serves, through a tenant-scoped query, and degrades to null (never a
//       throw) on malformed input or a missing row;
//   (b) every single-subject route carries exactly one guard, configured
//       with the mount's record type + careTeamModeGoverned and with
//       requirePatientContext (death_records.patient_uid is NOT NULL);
//   (c) register/board/inventory routes with no single patient subject are
//       NOT patient-context-forced — they carry no guard at all.
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';

// Capture every guard the route module creates. Each factory call returns a
// distinct middleware tagged with its config so the router's middleware chain
// can be read back route by route.
const patientAccessGuard = jest.fn((recordType, options = {}) => {
  const middleware = jest.fn((req, _res, next) => {
    if (!Array.isArray(req.guardTrail)) req.guardTrail = [];
    req.guardTrail.push(middleware.__guard);
    next();
  });
  middleware.__guard = { recordType, options, middleware };
  return middleware;
});
jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard,
}));

const $queryRawUnsafe = jest.fn();
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe },
}));

const getDeathRecord = jest.fn();
const mortuaryBoard = jest.fn();
jest.unstable_mockModule('../../services/clinical/deathCertificationService.js', () => ({
  getDeathRecord,
  mortuaryBoard,
}));

const { default: deathCertificationRoutes } = await import(
  '../../routes/clinical/deathCertificationRoutes.js'
);

function guardsByRoute() {
  const map = {};
  for (const layer of deathCertificationRoutes.stack) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods).sort().join(',');
    const key = `${methods.toUpperCase()} ${layer.route.path}`;
    map[key] = layer.route.stack
      .map((routeLayer) => routeLayer.handle.__guard)
      .filter(Boolean);
  }
  return map;
}

const GUARDED_ROUTES = [
  'POST /records',
  'GET /records/:id',
  'POST /records/:id/transition',
  'POST /records/:id/body-release',
  'POST /records/:id/police-clearance',
  'GET /records/:id/custody',
  'POST /records/:id/custody/receive',
  'POST /records/:id/custody/store',
  'POST /records/:id/custody/release',
  'POST /records/:id/review',
  'POST /reviews/:id/finalise',
];

const UNGUARDED_ROUTES = [
  'GET /records',
  'GET /mortuary/board',
  'GET /mortuary/slots',
  'POST /mortuary/slots',
  'GET /summary-30d',
];

function selectorFor(routeKey) {
  const guards = guardsByRoute()[routeKey];
  expect(guards).toHaveLength(1);
  return guards[0].options.patientSelector;
}

beforeEach(() => {
  $queryRawUnsafe.mockReset();
  getDeathRecord.mockReset();
  mortuaryBoard.mockReset();
});

describe('deathCertificationRoutes guard wiring', () => {
  it('covers every route in the router exactly once in this contract', () => {
    const allRoutes = Object.keys(guardsByRoute()).sort();
    expect(allRoutes).toEqual([...GUARDED_ROUTES, ...UNGUARDED_ROUTES].sort());
  });

  it.each(GUARDED_ROUTES)('%s carries exactly one DEATH_CERTIFICATION guard with a selector and required patient context', (routeKey) => {
    const guards = guardsByRoute()[routeKey];
    expect(guards).toHaveLength(1);
    const { recordType, options } = guards[0];
    expect(recordType).toBe('DEATH_CERTIFICATION');
    expect(options.careTeamModeGoverned).toBe(true);
    expect(options.requirePatientContext).toBe(true);
    expect(options.requireResolvedPatient).toBe(true);
    expect(typeof options.patientSelector).toBe('function');
  });

  it.each(UNGUARDED_ROUTES)('%s (no single patient subject) is not patient-context-forced', (routeKey) => {
    expect(guardsByRoute()[routeKey]).toHaveLength(0);
  });
});

describe('death record selector (records/:id family)', () => {
  it('resolves the deceased patient behind the record id with a tenant predicate', async () => {
    $queryRawUnsafe.mockResolvedValueOnce([{ uid: 'deceased-uid-1' }]);
    const selector = selectorFor('GET /records/:id');

    const resolved = await selector({ tenantId: TENANT, params: { id: '42' } });

    expect(resolved).toEqual({ uid: 'deceased-uid-1' });
    expect($queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, boundTenant, boundId] = $queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/FROM death_records/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(sql).toMatch(/id = \$2::int/);
    expect(boundTenant).toBe(TENANT);
    expect(boundId).toBe(42);
  });

  it('returns null for a malformed id without touching the database', async () => {
    const selector = selectorFor('POST /records/:id/transition');
    await expect(selector({ tenantId: TENANT, params: { id: 'not-a-number' } })).resolves.toBeNull();
    await expect(selector({ tenantId: TENANT, params: { id: '-3' } })).resolves.toBeNull();
    await expect(selector({ tenantId: TENANT, params: {} })).resolves.toBeNull();
    expect($queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns null when the record does not exist in this tenant', async () => {
    $queryRawUnsafe.mockResolvedValueOnce([]);
    const selector = selectorFor('GET /records/:id/custody');
    await expect(selector({ tenantId: TENANT, params: { id: '7' } })).resolves.toBeNull();
  });
});

describe('create selector (POST /records)', () => {
  it('resolves the subject from body.patient_uid — the identifier createDeathRecord persists', async () => {
    const selector = selectorFor('POST /records');
    expect(await selector({ tenantId: TENANT, body: { patient_uid: 'deceased-uid-9' } }))
      .toEqual({ uid: 'deceased-uid-9' });
    expect(await selector({ tenantId: TENANT, body: {} })).toEqual({ uid: undefined });
    expect($queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('mortality review selector (POST /reviews/:id/finalise)', () => {
  it('joins mortality_reviews to death_records tenant-scoped on both tables', async () => {
    $queryRawUnsafe.mockResolvedValueOnce([{ uid: 'deceased-uid-3' }]);
    const selector = selectorFor('POST /reviews/:id/finalise');

    const resolved = await selector({ tenantId: TENANT, params: { id: '11' } });

    expect(resolved).toEqual({ uid: 'deceased-uid-3' });
    const [sql, boundTenant, boundId] = $queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/FROM mortality_reviews mr/);
    expect(sql).toMatch(/JOIN death_records dr/);
    expect(sql).toMatch(/dr\.tenant_id = mr\.tenant_id/);
    expect(sql).toMatch(/mr\.tenant_id = \$1::uuid/);
    expect(sql).toMatch(/mr\.id = \$2::int/);
    expect(boundTenant).toBe(TENANT);
    expect(boundId).toBe(11);
  });
});

describe('request-time behaviour', () => {
  function buildApp(role = 'DOCTOR') {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.tenantId = TENANT;
      req.user = { uid: 'staff-uid-1', role };
      next();
    });
    app.use('/death-certification', deathCertificationRoutes);
    return app;
  }

  it('runs the guard on a guarded route after the role gate', async () => {
    getDeathRecord.mockResolvedValue({ id: 9 });
    const res = await request(buildApp('DOCTOR')).get('/death-certification/records/9');

    expect(res.status).toBe(200);
    expect(getDeathRecord).toHaveBeenCalledWith({ tenantId: TENANT, id: '9' });
    const routeGuard = guardsByRoute()['GET /records/:id'][0];
    expect(routeGuard.middleware).toHaveBeenCalledTimes(1);
  });

  it('never reaches the guard when the role gate refuses', async () => {
    const routeGuard = guardsByRoute()['GET /records/:id'][0];
    routeGuard.middleware.mockClear();

    const res = await request(buildApp('PATIENT')).get('/death-certification/records/9');

    expect(res.status).toBe(403);
    expect(routeGuard.middleware).not.toHaveBeenCalled();
    expect(getDeathRecord).not.toHaveBeenCalled();
  });

  it('serves the mortuary board with no patient guard in the chain', async () => {
    mortuaryBoard.mockResolvedValue([]);
    const res = await request(buildApp('DOCTOR')).get('/death-certification/mortuary/board');

    expect(res.status).toBe(200);
    expect(mortuaryBoard).toHaveBeenCalledWith({ tenantId: TENANT });
  });
});
