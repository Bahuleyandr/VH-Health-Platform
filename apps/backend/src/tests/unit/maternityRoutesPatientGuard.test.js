// src/tests/unit/maternityRoutesPatientGuard.test.js
//
// Re-audit 2026-08 (M: mount guards). The MATERNITY_RECORD
// patientAccessGuard used to sit on the app.js mount, where req.params is
// empty (Express has not matched a route yet), so every path-id route in
// maternityRoutes.js got no_patient_context without a policy evaluation.
// The guard now sits on each single-subject route with an explicit
// patientSelector that resolves the MOTHER through the same
// pregnancy/labor/delivery/newborn joins maternityService asserts before
// serving the row (the two immunisation-status routes name an arbitrary
// child patient directly and bind that identifier instead). These tests pin,
// with a mocked prisma:
//   (a) each selector resolves the subject from the identifier its handler
//       serves, tenant-scoped on EVERY joined table, and degrades to null
//       (never a throw) on malformed input or a missing row;
//   (b) every single-subject route carries exactly one guard configured with
//       MATERNITY_RECORD + careTeamModeGoverned + requirePatientContext;
//   (c) cross-patient boards/worklists and subject-less content (labour
//       board, due list, catalogue, GA calculator, packages, ANC advice) are
//       NOT patient-context-forced — they carry no guard at all.
import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';

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

const getPregnancy = jest.fn();
const listActiveLaborAdmissions = jest.fn();
jest.unstable_mockModule('../../services/maternity/maternityService.js', () => ({
  getPregnancy,
  listActiveLaborAdmissions,
}));
jest.unstable_mockModule('../../services/maternity/immunisationService.js', () => ({}));

const { default: maternityRoutes } = await import(
  '../../routes/maternity/maternityRoutes.js'
);

function guardsByRoute() {
  const map = {};
  for (const layer of maternityRoutes.stack) {
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
  'POST /pregnancies',
  'GET /pregnancies/patient/:patientUid',
  'GET /pregnancies/:id',
  'PATCH /pregnancies/:id',
  'POST /anc-visits',
  'GET /anc-visits/pregnancy/:pregnancyId',
  'POST /labor-admissions',
  'GET /labor-admissions/:id',
  'POST /partograph',
  'GET /partograph/labor/:laborId',
  'POST /deliveries',
  'GET /deliveries/:id',
  'POST /newborns',
  'GET /newborns/delivery/:deliveryId',
  'GET /newborns/:id',
  'POST /newborns/:id/apgar',
  'POST /postnatal-visits',
  'GET /postnatal-visits/delivery/:deliveryId',
  'POST /newborns/:id/immunisations/seed',
  'GET /newborns/:id/immunisations',
  'PATCH /immunisations/:id/record',
  'POST /immunisations/up-to-date',
  'GET /immunisations/status/:patientUid',
  'GET /pregnancies/active/:patientUid',
  'GET /pregnancies/:id/timeline',
  'GET /timeline/patient/:patientUid',
  'POST /supplements',
  'GET /supplements/pregnancy/:pregnancyId',
  'GET /pregnancies/:id/prior-orders',
  'POST /fetal-kicks',
  'GET /fetal-kicks/pregnancy/:pregnancyId',
];

const UNGUARDED_ROUTES = [
  'GET /labor-admissions/active',
  'GET /immunisations/catalogue',
  'GET /immunisations/due',
  'GET /ga',
  'GET /packages',
  'GET /anc-advice',
];

function selectorFor(routeKey) {
  const guards = guardsByRoute()[routeKey];
  expect(guards).toHaveLength(1);
  return guards[0].options.patientSelector;
}

beforeEach(() => {
  $queryRawUnsafe.mockReset();
  getPregnancy.mockReset();
  listActiveLaborAdmissions.mockReset();
});

describe('maternityRoutes guard wiring', () => {
  it('covers every route in the router exactly once in this contract', () => {
    const allRoutes = Object.keys(guardsByRoute()).sort();
    expect(allRoutes).toEqual([...GUARDED_ROUTES, ...UNGUARDED_ROUTES].sort());
  });

  it.each(GUARDED_ROUTES)('%s carries exactly one MATERNITY_RECORD guard with a selector and required patient context', (routeKey) => {
    const guards = guardsByRoute()[routeKey];
    expect(guards).toHaveLength(1);
    const { recordType, options } = guards[0];
    expect(recordType).toBe('MATERNITY_RECORD');
    expect(options.careTeamModeGoverned).toBe(true);
    expect(options.requirePatientContext).toBe(true);
    expect(options.requireResolvedPatient).toBe(true);
    expect(typeof options.patientSelector).toBe('function');
  });

  it.each(UNGUARDED_ROUTES)('%s (no single patient subject) is not patient-context-forced', (routeKey) => {
    expect(guardsByRoute()[routeKey]).toHaveLength(0);
  });
});

describe('mother-from-pregnancy selectors', () => {
  it('GET /pregnancies/:id resolves the mother behind the pregnancy row, tenant-scoped', async () => {
    $queryRawUnsafe.mockResolvedValueOnce([{ uid: 'mother-uid-1' }]);
    const selector = selectorFor('GET /pregnancies/:id');

    const resolved = await selector({ tenantId: TENANT, params: { id: '12' } });

    expect(resolved).toEqual({ uid: 'mother-uid-1' });
    const [sql, boundTenant, boundId] = $queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/SELECT patient_uid AS uid/);
    expect(sql).toMatch(/FROM maternity_pregnancies/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(sql).toMatch(/id = \$2::int/);
    expect(boundTenant).toBe(TENANT);
    expect(boundId).toBe(12);
  });

  it('the :id, :id/timeline and :id/prior-orders routes share one pregnancy selector', () => {
    const reference = selectorFor('GET /pregnancies/:id');
    expect(selectorFor('PATCH /pregnancies/:id')).toBe(reference);
    expect(selectorFor('GET /pregnancies/:id/timeline')).toBe(reference);
    expect(selectorFor('GET /pregnancies/:id/prior-orders')).toBe(reference);
  });

  it('body-borne pregnancy creates resolve the same way from body.pregnancy_id', async () => {
    $queryRawUnsafe.mockResolvedValueOnce([{ uid: 'mother-uid-2' }]);
    const selector = selectorFor('POST /anc-visits');

    const resolved = await selector({ tenantId: TENANT, body: { pregnancy_id: 33 } });

    expect(resolved).toEqual({ uid: 'mother-uid-2' });
    const [sql, boundTenant, boundId] = $queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/FROM maternity_pregnancies/);
    expect(boundTenant).toBe(TENANT);
    expect(boundId).toBe(33);
    // Same resolver family across every pregnancy-id body write.
    expect(selectorFor('POST /labor-admissions')).toBe(selector);
    expect(selectorFor('POST /deliveries')).toBe(selector);
    expect(selectorFor('POST /supplements')).toBe(selector);
    expect(selectorFor('POST /fetal-kicks')).toBe(selector);
  });

  it('returns null on malformed ids without touching the database', async () => {
    const selector = selectorFor('GET /pregnancies/:id');
    await expect(selector({ tenantId: TENANT, params: { id: 'abc' } })).resolves.toBeNull();
    await expect(selector({ tenantId: TENANT, params: {} })).resolves.toBeNull();
    const bodySelector = selectorFor('POST /anc-visits');
    await expect(bodySelector({ tenantId: TENANT, body: {} })).resolves.toBeNull();
    expect($queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns null when the pregnancy does not exist in this tenant', async () => {
    $queryRawUnsafe.mockResolvedValueOnce([]);
    const selector = selectorFor('GET /pregnancies/:id');
    await expect(selector({ tenantId: TENANT, params: { id: '12' } })).resolves.toBeNull();
  });
});

describe('mother-from-labor selectors', () => {
  it('GET /labor-admissions/:id joins labor → pregnancy with tenant predicates on both tables', async () => {
    $queryRawUnsafe.mockResolvedValueOnce([{ uid: 'mother-uid-3' }]);
    const selector = selectorFor('GET /labor-admissions/:id');

    const resolved = await selector({ tenantId: TENANT, params: { id: '5' } });

    expect(resolved).toEqual({ uid: 'mother-uid-3' });
    const [sql, boundTenant, boundId] = $queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/FROM maternity_labor_admissions la/);
    expect(sql).toMatch(/JOIN maternity_pregnancies p/);
    expect(sql).toMatch(/p\.tenant_id = la\.tenant_id/);
    expect(sql).toMatch(/la\.tenant_id = \$1::uuid/);
    expect(sql).toMatch(/la\.id = \$2::int/);
    expect(boundTenant).toBe(TENANT);
    expect(boundId).toBe(5);
  });

  it('partograph routes resolve through the same labor chain (param and body forms)', async () => {
    $queryRawUnsafe.mockResolvedValue([{ uid: 'mother-uid-3' }]);
    await expect(selectorFor('GET /partograph/labor/:laborId')({ tenantId: TENANT, params: { laborId: '6' } }))
      .resolves.toEqual({ uid: 'mother-uid-3' });
    await expect(selectorFor('POST /partograph')({ tenantId: TENANT, body: { labor_admission_id: '7' } }))
      .resolves.toEqual({ uid: 'mother-uid-3' });
    expect($queryRawUnsafe.mock.calls[0][2]).toBe(6);
    expect($queryRawUnsafe.mock.calls[1][2]).toBe(7);
  });
});

describe('mother-from-delivery and mother-from-newborn selectors', () => {
  it('GET /deliveries/:id joins delivery → pregnancy with tenant predicates', async () => {
    $queryRawUnsafe.mockResolvedValueOnce([{ uid: 'mother-uid-4' }]);
    const resolved = await selectorFor('GET /deliveries/:id')({ tenantId: TENANT, params: { id: '8' } });
    expect(resolved).toEqual({ uid: 'mother-uid-4' });
    const [sql] = $queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/FROM maternity_deliveries d/);
    expect(sql).toMatch(/JOIN maternity_pregnancies p/);
    expect(sql).toMatch(/p\.tenant_id = d\.tenant_id/);
    expect(sql).toMatch(/d\.tenant_id = \$1::uuid/);
  });

  it('newborn routes resolve newborn → delivery → pregnancy, tenant-scoped throughout', async () => {
    $queryRawUnsafe.mockResolvedValueOnce([{ uid: 'mother-uid-5' }]);
    const selector = selectorFor('GET /newborns/:id');

    const resolved = await selector({ tenantId: TENANT, params: { id: '3' } });

    expect(resolved).toEqual({ uid: 'mother-uid-5' });
    const [sql, boundTenant, boundId] = $queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/FROM maternity_newborns n/);
    expect(sql).toMatch(/JOIN maternity_deliveries d/);
    expect(sql).toMatch(/d\.tenant_id = n\.tenant_id/);
    expect(sql).toMatch(/JOIN maternity_pregnancies p/);
    expect(sql).toMatch(/p\.tenant_id = n\.tenant_id/);
    expect(sql).toMatch(/n\.tenant_id = \$1::uuid/);
    expect(sql).toMatch(/n\.id = \$2::int/);
    expect(boundTenant).toBe(TENANT);
    expect(boundId).toBe(3);
    // Apgar + immunisation seed/read share the same newborn resolver.
    expect(selectorFor('POST /newborns/:id/apgar')).toBe(selector);
    expect(selectorFor('POST /newborns/:id/immunisations/seed')).toBe(selector);
    expect(selectorFor('GET /newborns/:id/immunisations')).toBe(selector);
  });

  it('PATCH /immunisations/:id/record resolves the full immunisation → newborn → delivery → pregnancy chain', async () => {
    $queryRawUnsafe.mockResolvedValueOnce([{ uid: 'mother-uid-6' }]);
    const selector = selectorFor('PATCH /immunisations/:id/record');

    const resolved = await selector({ tenantId: TENANT, params: { id: '77' } });

    expect(resolved).toEqual({ uid: 'mother-uid-6' });
    const [sql, boundTenant, boundId] = $queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/FROM newborn_immunisations i/);
    expect(sql).toMatch(/JOIN maternity_newborns n/);
    expect(sql).toMatch(/n\.tenant_id = i\.tenant_id/);
    expect(sql).toMatch(/JOIN maternity_deliveries d/);
    expect(sql).toMatch(/JOIN maternity_pregnancies p/);
    expect(sql).toMatch(/i\.tenant_id = \$1::uuid/);
    expect(sql).toMatch(/i\.id = \$2::int/);
    expect(boundTenant).toBe(TENANT);
    expect(boundId).toBe(77);
  });
});

describe('direct patient-uid selectors', () => {
  it('path-param routes bind req.params.patientUid — the identifier the handler lists by', async () => {
    const selector = selectorFor('GET /pregnancies/patient/:patientUid');
    expect(await selector({ params: { patientUid: 'mother-uid-9' } }))
      .toEqual({ uid: 'mother-uid-9' });
    expect(selectorFor('GET /pregnancies/active/:patientUid')).toBe(selector);
    expect(selectorFor('GET /timeline/patient/:patientUid')).toBe(selector);
    expect(selectorFor('GET /immunisations/status/:patientUid')).toBe(selector);
    expect($queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('body-uid routes bind body.patient_uid (pregnancy create; immunisation up-to-date names the child)', async () => {
    const selector = selectorFor('POST /pregnancies');
    expect(await selector({ body: { patient_uid: 'child-or-mother-uid' } }))
      .toEqual({ uid: 'child-or-mother-uid' });
    expect(selectorFor('POST /immunisations/up-to-date')).toBe(selector);
    expect($queryRawUnsafe).not.toHaveBeenCalled();
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
    app.use('/maternity', maternityRoutes);
    return app;
  }

  it('runs the guard on GET /pregnancies/:id after the role gate', async () => {
    getPregnancy.mockResolvedValue({ id: 12, patient_uid: 'mother-uid-1' });
    const routeGuard = guardsByRoute()['GET /pregnancies/:id'][0];
    routeGuard.middleware.mockClear();

    const res = await request(buildApp('DOCTOR')).get('/maternity/pregnancies/12');

    expect(res.status).toBe(200);
    expect(getPregnancy).toHaveBeenCalledWith({ tenantId: TENANT, id: '12' });
    expect(routeGuard.middleware).toHaveBeenCalledTimes(1);
  });

  it('never reaches the guard when the staff role gate refuses', async () => {
    const routeGuard = guardsByRoute()['GET /pregnancies/:id'][0];
    routeGuard.middleware.mockClear();

    const res = await request(buildApp('PATIENT')).get('/maternity/pregnancies/12');

    expect(res.status).toBe(403);
    expect(routeGuard.middleware).not.toHaveBeenCalled();
    expect(getPregnancy).not.toHaveBeenCalled();
  });

  it('serves the labour board with no patient guard in the chain', async () => {
    listActiveLaborAdmissions.mockResolvedValue([]);
    const res = await request(buildApp('NURSING_STAFF')).get('/maternity/labor-admissions/active');

    expect(res.status).toBe(200);
    expect(listActiveLaborAdmissions).toHaveBeenCalledWith({ tenantId: TENANT, limit: undefined });
  });
});
