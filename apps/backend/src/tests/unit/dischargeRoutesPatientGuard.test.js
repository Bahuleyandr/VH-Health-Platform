// src/tests/unit/dischargeRoutesPatientGuard.test.js
//
// Re-audit 2026-08 (M: mount guards). The DISCHARGE_SUMMARY
// patientAccessGuard used to sit on the app.js mount, where req.params is
// empty (Express has not matched a route yet), so it returned
// no_patient_context without ever evaluating a policy. The guard now sits on
// each single-subject route in dischargeRoutes.js with an explicit
// patientSelector. These tests pin, with a mocked prisma:
//   (a) each selector resolves the subject from the identifier the handler
//       serves (summary id, admission id, path patient uid, body patient
//       uid), through a tenant-scoped query where a lookup is needed, and
//       degrades to null (never a throw) on malformed input;
//   (b) every single-subject route carries exactly one guard, configured
//       with the mount's record type + careTeamModeGoverned and with
//       requirePatientContext (discharge_summaries.patient_uid is NOT NULL);
//   (c) the template catalogue and the cross-patient pending worklist are
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

const getOne = jest.fn();
const listPending = jest.fn();
jest.unstable_mockModule('../../services/discharge/dischargeService.js', () => ({
  getOne,
  listPending,
}));

const { default: dischargeRoutes } = await import(
  '../../routes/discharge/dischargeRoutes.js'
);

function guardsByRoute() {
  const map = {};
  for (const layer of dischargeRoutes.stack) {
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
  'POST /',
  'GET /patient/:patientUid',
  'GET /admission/:admissionId/pdf',
  'GET /:id/pdf',
  'GET /:id',
  'PATCH /:id/sections/:key',
  'PATCH /:id/codes',
  'POST /:id/ready',
  'POST /:id/sign',
  'POST /:id/deliver',
  'PATCH /:id/sections/:key/translation',
];

const UNGUARDED_ROUTES = [
  'GET /templates',
  'GET /pending',
];

function selectorFor(routeKey) {
  const guards = guardsByRoute()[routeKey];
  expect(guards).toHaveLength(1);
  return guards[0].options.patientSelector;
}

beforeEach(() => {
  $queryRawUnsafe.mockReset();
  getOne.mockReset();
  listPending.mockReset();
});

describe('dischargeRoutes guard wiring', () => {
  it('covers every route in the router exactly once in this contract', () => {
    const allRoutes = Object.keys(guardsByRoute()).sort();
    expect(allRoutes).toEqual([...GUARDED_ROUTES, ...UNGUARDED_ROUTES].sort());
  });

  it.each(GUARDED_ROUTES)('%s carries exactly one DISCHARGE_SUMMARY guard with a selector and required patient context', (routeKey) => {
    const guards = guardsByRoute()[routeKey];
    expect(guards).toHaveLength(1);
    const { recordType, options } = guards[0];
    expect(recordType).toBe('DISCHARGE_SUMMARY');
    expect(options.careTeamModeGoverned).toBe(true);
    expect(options.requirePatientContext).toBe(true);
    expect(options.requireResolvedPatient).toBe(true);
    expect(typeof options.patientSelector).toBe('function');
  });

  it.each(UNGUARDED_ROUTES)('%s (no single patient subject) is not patient-context-forced', (routeKey) => {
    expect(guardsByRoute()[routeKey]).toHaveLength(0);
  });

  it('signs behind the doctor gate AND the patient guard (both in the chain)', () => {
    // POST /:id/sign keeps requireDoctorOrAdmin; the guard is additive, not a
    // replacement for the sign-off role gate.
    const signLayer = dischargeRoutes.stack.find(
      (layer) => layer.route?.path === '/:id/sign',
    );
    expect(signLayer.route.stack.length).toBeGreaterThanOrEqual(3);
  });
});

describe('summary-id selector (/:id family)', () => {
  it('resolves the patient behind the summary id with a tenant predicate', async () => {
    $queryRawUnsafe.mockResolvedValueOnce([{ uid: 'patient-uid-1' }]);
    const selector = selectorFor('GET /:id');

    const resolved = await selector({ tenantId: TENANT, params: { id: '17' } });

    expect(resolved).toEqual({ uid: 'patient-uid-1' });
    const [sql, boundTenant, boundId] = $queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/FROM discharge_summaries/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(sql).toMatch(/id = \$2::int/);
    expect(boundTenant).toBe(TENANT);
    expect(boundId).toBe(17);
  });

  it('is the same selector instance across the whole /:id family', () => {
    // One resolver, one behaviour: read, print, section edits, coding,
    // ready/sign/deliver all resolve the subject identically.
    const reference = selectorFor('GET /:id');
    for (const routeKey of ['GET /:id/pdf', 'PATCH /:id/sections/:key', 'PATCH /:id/codes', 'POST /:id/ready', 'POST /:id/sign', 'POST /:id/deliver', 'PATCH /:id/sections/:key/translation']) {
      expect(selectorFor(routeKey)).toBe(reference);
    }
  });

  it('returns null for a malformed id without touching the database', async () => {
    const selector = selectorFor('GET /:id');
    await expect(selector({ tenantId: TENANT, params: { id: 'abc' } })).resolves.toBeNull();
    expect($queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('returns null when the summary does not exist in this tenant', async () => {
    $queryRawUnsafe.mockResolvedValueOnce([]);
    const selector = selectorFor('GET /:id');
    await expect(selector({ tenantId: TENANT, params: { id: '17' } })).resolves.toBeNull();
  });
});

describe('admission selector (GET /admission/:admissionId/pdf)', () => {
  it('resolves the patient behind the admission row with a tenant predicate', async () => {
    $queryRawUnsafe.mockResolvedValueOnce([{ uid: 'patient-uid-2' }]);
    const selector = selectorFor('GET /admission/:admissionId/pdf');

    const resolved = await selector({ tenantId: TENANT, params: { admissionId: '301' } });

    expect(resolved).toEqual({ uid: 'patient-uid-2' });
    const [sql, boundTenant, boundId] = $queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/FROM admissions/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(sql).toMatch(/id = \$2::int/);
    expect(boundTenant).toBe(TENANT);
    expect(boundId).toBe(301);
  });
});

describe('direct-uid selectors', () => {
  it('GET /patient/:patientUid binds the path param the handler lists by', async () => {
    const selector = selectorFor('GET /patient/:patientUid');
    expect(await selector({ params: { patientUid: 'patient-uid-7' } }))
      .toEqual({ uid: 'patient-uid-7' });
    expect($queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('POST / binds body.patient_uid — the identifier createDraft requires', async () => {
    const selector = selectorFor('POST /');
    expect(await selector({ body: { patient_uid: 'patient-uid-8' } }))
      .toEqual({ uid: 'patient-uid-8' });
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
    app.use('/discharge-summaries', dischargeRoutes);
    return app;
  }

  it('runs the guard on GET /:id after the role gate', async () => {
    getOne.mockResolvedValue({ id: 17 });
    const routeGuard = guardsByRoute()['GET /:id'][0];
    routeGuard.middleware.mockClear();

    const res = await request(buildApp('DOCTOR')).get('/discharge-summaries/17');

    expect(res.status).toBe(200);
    expect(getOne).toHaveBeenCalledWith({ tenantId: TENANT, id: '17' });
    expect(routeGuard.middleware).toHaveBeenCalledTimes(1);
  });

  it('never reaches the guard when the role gate refuses', async () => {
    const routeGuard = guardsByRoute()['GET /:id'][0];
    routeGuard.middleware.mockClear();

    const res = await request(buildApp('PATIENT')).get('/discharge-summaries/17');

    expect(res.status).toBe(403);
    expect(routeGuard.middleware).not.toHaveBeenCalled();
    expect(getOne).not.toHaveBeenCalled();
  });

  it('serves the pending worklist with no patient guard in the chain', async () => {
    listPending.mockResolvedValue([]);
    const res = await request(buildApp('DOCTOR')).get('/discharge-summaries/pending');

    expect(res.status).toBe(200);
    expect(listPending).toHaveBeenCalledWith({ tenantId: TENANT, limit: undefined });
  });
});
