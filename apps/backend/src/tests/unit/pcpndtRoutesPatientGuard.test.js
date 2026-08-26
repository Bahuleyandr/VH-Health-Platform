// src/tests/unit/pcpndtRoutesPatientGuard.test.js
//
// Re-audit 2026-08 (M: mount guards). The CLINICAL_WORKFLOW
// patientAccessGuard used to sit on the app.js /api/v1/pcpndt mount
// (CAN-051), where req.params is empty, so GET /form-f/:id never produced a
// decision. The guard now sits on the two Form-F routes that can serve one
// patient's data, with selectors resolving the row's linked patient. These
// tests pin, with a mocked prisma:
//   (a) the Form-F selectors resolve the (optional) linked patient from the
//       row id / body, tenant-scoped, degrading to null on malformed input;
//   (b) both Form-F single-subject routes carry the guard with the mount's
//       record type + careTeamModeGoverned — and deliberately WITHOUT
//       requirePatientContext, because pcpndt_form_f.patient_uid is NULLABLE
//       ("internal link, not on the form"): forcing patient context would
//       lock the statutory register out for unlinked walk-ins;
//   (c) machines/sonologists/register-list/submission routes have no single
//       patient subject and carry no guard at all.
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

const getFormF = jest.fn();
const listFormF = jest.fn();
jest.unstable_mockModule('../../services/compliance/pcpndtService.js', () => ({
  getFormF,
  listFormF,
}));

const { default: pcpndtRoutes } = await import(
  '../../routes/compliance/pcpndtRoutes.js'
);

function guardsByRoute() {
  const map = {};
  for (const layer of pcpndtRoutes.stack) {
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
  'POST /form-f',
  'GET /form-f/:id',
];

const UNGUARDED_ROUTES = [
  'GET /machines',
  'POST /machines',
  'GET /sonologists',
  'POST /sonologists',
  'PATCH /sonologists/:id',
  'GET /form-f',
  'POST /submissions/generate',
  'GET /submissions',
  'POST /submissions/:id/acknowledge',
];

function selectorFor(routeKey) {
  const guards = guardsByRoute()[routeKey];
  expect(guards).toHaveLength(1);
  return guards[0].options.patientSelector;
}

beforeEach(() => {
  $queryRawUnsafe.mockReset();
  getFormF.mockReset();
  listFormF.mockReset();
});

describe('pcpndtRoutes guard wiring', () => {
  it('covers every route in the router exactly once in this contract', () => {
    const allRoutes = Object.keys(guardsByRoute()).sort();
    expect(allRoutes).toEqual([...GUARDED_ROUTES, ...UNGUARDED_ROUTES].sort());
  });

  it.each(GUARDED_ROUTES)('%s carries exactly one CLINICAL_WORKFLOW guard with a selector', (routeKey) => {
    const guards = guardsByRoute()[routeKey];
    expect(guards).toHaveLength(1);
    const { recordType, options } = guards[0];
    expect(recordType).toBe('CLINICAL_WORKFLOW');
    expect(options.careTeamModeGoverned).toBe(true);
    expect(typeof options.patientSelector).toBe('function');
  });

  it.each(GUARDED_ROUTES)('%s does NOT force patient context — Form F is valid without a linked VH patient', (routeKey) => {
    const { options } = guardsByRoute()[routeKey][0];
    expect(options.requirePatientContext).toBeUndefined();
    expect(options.requireResolvedPatient).toBeUndefined();
  });

  it.each(UNGUARDED_ROUTES)('%s (no single patient subject) carries no guard', (routeKey) => {
    expect(guardsByRoute()[routeKey]).toHaveLength(0);
  });
});

describe('Form-F row selector (GET /form-f/:id)', () => {
  it('resolves the linked patient behind the Form-F row with a tenant predicate', async () => {
    $queryRawUnsafe.mockResolvedValueOnce([{ uid: 'linked-patient-uid' }]);
    const selector = selectorFor('GET /form-f/:id');

    const resolved = await selector({ tenantId: TENANT, params: { id: '23' } });

    expect(resolved).toEqual({ uid: 'linked-patient-uid' });
    const [sql, boundTenant, boundId] = $queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/FROM pcpndt_form_f/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(sql).toMatch(/id = \$2::int/);
    expect(boundTenant).toBe(TENANT);
    expect(boundId).toBe(23);
  });

  it('surfaces an unlinked row as a null-uid subject (guard then passes to the role gate)', async () => {
    // patient_uid is NULLABLE — an unlinked walk-in row resolves to
    // { uid: null }, which resolvePatientForAccess treats as no patient
    // context; with requirePatientContext unset the guard does not block.
    $queryRawUnsafe.mockResolvedValueOnce([{ uid: null }]);
    const selector = selectorFor('GET /form-f/:id');
    await expect(selector({ tenantId: TENANT, params: { id: '23' } }))
      .resolves.toEqual({ uid: null });
  });

  it('returns null for a malformed id without touching the database', async () => {
    const selector = selectorFor('GET /form-f/:id');
    await expect(selector({ tenantId: TENANT, params: { id: 'abc' } })).resolves.toBeNull();
    expect($queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('Form-F create selector (POST /form-f)', () => {
  it('binds body.patient_uid — the identifier createFormF persists (optional by the Act)', async () => {
    const selector = selectorFor('POST /form-f');
    expect(await selector({ body: { patient_uid: 'patient-uid-5' } }))
      .toEqual({ uid: 'patient-uid-5' });
    expect(await selector({ body: {} })).toEqual({ uid: undefined });
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
    app.use('/pcpndt', pcpndtRoutes);
    return app;
  }

  it('runs the guard on GET /form-f/:id after the role gate', async () => {
    getFormF.mockResolvedValue({ id: 23 });
    const routeGuard = guardsByRoute()['GET /form-f/:id'][0];
    routeGuard.middleware.mockClear();

    const res = await request(buildApp('RADIOLOGIST')).get('/pcpndt/form-f/23');

    expect(res.status).toBe(200);
    expect(getFormF).toHaveBeenCalledWith({ tenantId: TENANT, id: '23' });
    expect(routeGuard.middleware).toHaveBeenCalledTimes(1);
  });

  it('serves the register listing with no patient guard in the chain', async () => {
    listFormF.mockResolvedValue([]);
    const res = await request(buildApp('RADIOLOGIST')).get('/pcpndt/form-f');

    expect(res.status).toBe(200);
    expect(listFormF).toHaveBeenCalledTimes(1);
  });
});
