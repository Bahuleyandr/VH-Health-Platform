/**
 * Wiring census for the two device-reuse surfaces that are NOT on the cath
 * router (those live in cathLabRouteGuards.test.js):
 *
 *   - the CSSD reprocessable-device queue (six routes on cssdRoutes), where the
 *     five state transitions are commands that must each claim an idempotency
 *     key, the queue read must not, and the whole /devices sub-tree is narrowed
 *     to CSSD_DEVICE_ROUTE_ROLES — a strict subset of the mount audience,
 *     because the CSSD mount also admits the audit office and stores/purchase,
 *     and neither of those runs a sterilizer; and
 *   - the reprocessing settings/policies governance router, which USED to be
 *     four routes on admin/cathConsumablesRoutes behind ADMIN_ROUTE_ROLES plus
 *     a route-level gate naming QUALITY_OFFICER and INFECTION_CONTROL_OFFICER.
 *     That gate was DEAD: the admin mount had already refused both officers, so
 *     the surface its owners were named on was the one surface they could not
 *     reach. It now lives at /api/v1/cath-reprocessing with its own audience.
 *
 * The census part is structural: the real routers are imported and their layer
 * stacks walked, with the idempotency FACTORY spied so its options can be
 * asserted and the exact function object each router received matched by
 * identity — a look-alike with the same name cannot satisfy these tests.
 *
 * The ROLE part is behavioural, because a role list is only worth what the
 * gate does with it. rbacMiddleware is deliberately NOT mocked here: the
 * requests below run the real gate, and app.js's own source is pinned so the
 * harness cannot mount a different audience than production does.
 */

import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const IDEMPOTENCY_NAME = 'idempotencyMiddleware';

const requireIdempotencyKey = jest.fn(() => function idempotencyMiddleware(_req, _res, next) {
  return next();
});
jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey,
}));

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  phiAccessLogger: () => (_req, _res, next) => next(),
}));

// rbacMiddleware's denial path writes a security-audit row through prisma.
// Stub the client so a 403 in this suite stays a 403 and never touches a DB.
const prismaMock = {
  $queryRawUnsafe: jest.fn(),
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

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  resolveTenantOrThrow: () => TENANT,
  requireTenantId: (value) => value,
}));

const deviceService = {
  discardDevice: jest.fn(async () => ({ id: 1, status: 'discarded' })),
  listDevices: jest.fn(async () => []),
  markDeviceReprocessed: jest.fn(async () => ({ id: 1, status: 'available' })),
  quarantineDevice: jest.fn(async () => ({ id: 1, status: 'quarantined' })),
  receiveDevice: jest.fn(async () => ({ id: 1, status: 'in_cssd' })),
  releaseDevice: jest.fn(async () => ({ id: 1, status: 'awaiting_reprocessing' })),
  getReprocessingSettings: jest.fn(async () => ({ tenant_id: TENANT, configured: false })),
  listCategoryPolicies: jest.fn(async () => [{ category: 'balloon' }]),
  upsertCategoryPolicies: jest.fn(async () => [{ category: 'balloon' }]),
  upsertReprocessingSettings: jest.fn(async () => ({ tenant_id: TENANT, configured: true })),
  deviceHistory: jest.fn(async () => ({ device: { id: 1 }, uses: [], events: [] })),
  logDeviceHistoryAccess: jest.fn(async () => ({ logged: 0, skipped: 0 })),
};
jest.unstable_mockModule('../../services/clinical/cathDeviceReuseService.js', () => deviceService);

jest.unstable_mockModule('../../services/cssd/cssdService.js', () => ({
  getCssdBoard: jest.fn(async () => ({ board: [] })), listInstrumentSets: jest.fn(), createInstrumentSet: jest.fn(),
  getInstrumentSetLabel: jest.fn(), listSterilizationLoads: jest.fn(), createSterilizationLoad: jest.fn(),
  transitionSterilizationLoad: jest.fn(), listIssues: jest.fn(), issueSet: jest.fn(),
  markTheatreUse: jest.fn(), returnIssuedSet: jest.fn(), markDecontaminated: jest.fn(),
  cancelIssue: jest.fn(), getOtSterilityWarnings: jest.fn(),
}));

jest.unstable_mockModule('../../services/clinical/cathLabService.js', () => ({
  getCathConsumablesBillingSettings: jest.fn(), listConsumableCatalog: jest.fn(),
  listUnbilledConsumableUsage: jest.fn(), resolveCathConsumableAuthorityRecovery: jest.fn(),
  upsertCathConsumablesBillingSettings: jest.fn(), upsertConsumableCatalogItem: jest.fn(),
}));

const { default: cssdRouter } = await import('../../routes/cssd/cssdRoutes.js');
const { default: adminCathRouter } = await import('../../routes/admin/cathConsumablesRoutes.js');
const { default: governanceRouter } = await import('../../routes/clinical/cathReprocessingPolicyRoutes.js');
const { default: cathDeviceHistoryHandler } = await import('../../routes/clinical/cathDeviceHistoryHandler.js');
const { requireRole } = await import('../../middleware/rbacMiddleware.js');
const {
  CATH_REPROCESSING_POLICY_ROUTE_ROLES,
  CSSD_DEVICE_ROUTE_ROLES,
  CSSD_ROUTE_ROLES,
} = await import('../../config/routeRolePolicy.js');

const APP_SOURCE = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');

/** The exact claim instance a router built for a given scope. */
function claimInstanceFor(scope) {
  const index = requireIdempotencyKey.mock.calls.findIndex(([options]) => options?.scope === scope);
  return index === -1 ? null : { index, instance: requireIdempotencyKey.mock.results[index].value };
}
const cssdClaim = claimInstanceFor('cssd_device_transition');
const policyClaim = claimInstanceFor('cath_reprocessing_policy');

function routeTable(router, claimInstance) {
  const table = new Map();
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]);
    const handles = layer.route.stack.map((s) => s.handle);
    for (const method of new Set(methods)) {
      table.set(`${method.toUpperCase()} ${layer.route.path}`, {
        handles,
        names: handles.map((h) => h.name),
        claimIndex: claimInstance ? handles.indexOf(claimInstance) : -1,
        layerCount: handles.length,
      });
    }
  }
  return table;
}

const CSSD = routeTable(cssdRouter, cssdClaim?.instance ?? null);
const ADMIN = routeTable(adminCathRouter, null);
const POLICY = routeTable(governanceRouter, policyClaim?.instance ?? null);

const CSSD_COMMANDS = [
  ['POST /devices/:id/receive', 'receiveDevice'],
  ['POST /devices/:id/reprocessed', 'markDeviceReprocessed'],
  ['POST /devices/:id/quarantine', 'quarantineDevice'],
  ['POST /devices/:id/release', 'releaseDevice'],
  ['POST /devices/:id/discard', 'discardDevice'],
];
const POLICY_ROUTES = [
  'GET /settings',
  'PUT /settings',
  'GET /policies',
  'PUT /policies',
];

/** Drive one route's terminal handler with a fake req/res. */
async function invoke(entry, req) {
  const res = { statusCode: null, body: null, headersSent: false };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.headersSent = true; return res; };
  await entry.handles[entry.layerCount - 1](req, res, () => {});
  return res;
}

/**
 * An app shaped exactly like the production mount: the REAL requireRole in
 * front of the real router. `req.user` stands in for the decoded JWT, which is
 * all rbacMiddleware reads.
 */
function appFor(mountPath, roles, router, role) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.tenantId = TENANT;
    req.user = { uid: ACTOR, id: 9, role, scope: 'full' };
    next();
  });
  app.use(mountPath, requireRole(...roles), router);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(deviceService)) fn.mockClear();
});

describe('CSSD device queue wiring', () => {
  it('exposes exactly the queue read and the five transitions', () => {
    const deviceRoutes = [...CSSD.keys()].filter((key) => key.includes('/devices'));
    expect(deviceRoutes.sort()).toEqual(
      ['GET /devices', ...CSSD_COMMANDS.map(([route]) => route)].sort(),
    );
  });

  it('builds ONE device claim layer, required, scoped to cssd_device_transition', () => {
    expect(cssdClaim).not.toBeNull();
    expect(requireIdempotencyKey.mock.calls[cssdClaim.index][0]).toEqual({
      required: true,
      scope: 'cssd_device_transition',
    });
    // Scope matters as much as presence: a shared scope would let a receive and
    // a discard with the same key collide across different devices.
    const cssdScopes = requireIdempotencyKey.mock.calls
      .map(([options]) => options?.scope)
      .filter((scope) => scope === 'cssd_device_transition');
    expect(cssdScopes).toHaveLength(1);
  });

  it.each(CSSD_COMMANDS.map(([route]) => route))(
    '%s claims an idempotency key ahead of its handler',
    (route) => {
      const entry = CSSD.get(route);
      expect({ route, claimed: entry.claimIndex > -1 }).toEqual({ route, claimed: true });
      expect(entry.claimIndex).toBeLessThan(entry.layerCount - 1);
    },
  );

  it('GET /devices takes no idempotency key — a read must never burn one', () => {
    const entry = CSSD.get('GET /devices');
    expect(entry.claimIndex).toBe(-1);
    expect(entry.names.some((n) => /idempotency/i.test(n))).toBe(false);
    expect(entry.layerCount).toBe(1);
  });

  it.each(CSSD_COMMANDS)('%s dispatches to %s with the claimed key in its context', async (route, fnName) => {
    const entry = CSSD.get(route);
    await invoke(entry, {
      params: { id: '77' },
      query: {},
      body: { reason: 'damaged', cycle_type: 'steam' },
      user: { uid: ACTOR, role: 'OT_NURSE' },
      idempotencyClaim: { requestKey: 'cssd-key-77' },
      get: () => undefined,
    });
    expect(deviceService[fnName]).toHaveBeenCalledTimes(1);
    const context = deviceService[fnName].mock.calls[0].at(-1);
    // The claimed key is what makes the register's audit row replay-aware; a
    // context built from contextOf() alone would silently drop it.
    expect(context).toMatchObject({
      tenantId: TENANT,
      actorUid: ACTOR,
      idempotencyKey: 'cssd-key-77',
    });
    // Every other device service function stays untouched: the five commands
    // must not share a handler.
    for (const [otherRoute, otherFn] of CSSD_COMMANDS) {
      if (otherRoute !== route) expect(deviceService[otherFn]).not.toHaveBeenCalled();
    }
  });

  it('GET /devices passes the tenant and the three filters through', async () => {
    await invoke(CSSD.get('GET /devices'), {
      params: {},
      query: { status: 'in_cssd', facility_id: '4', limit: '25' },
      user: { uid: ACTOR, role: 'OT_NURSE' },
      get: () => undefined,
    });
    expect(deviceService.listDevices).toHaveBeenCalledWith({
      tenantId: TENANT, status: 'in_cssd', facilityId: '4', limit: '25',
    });
  });
});

describe('the CSSD /devices sub-tree is narrower than the CSSD mount', () => {
  it('CSSD_DEVICE_ROUTE_ROLES is a strict SUBSET of the mount audience', () => {
    // A role the mount already refuses cannot be admitted by a route gate, so
    // a device list naming one would be a dead entry — exactly the defect this
    // change removed from the reprocessing-policy routes.
    for (const role of CSSD_DEVICE_ROUTE_ROLES) expect(CSSD_ROUTE_ROLES).toContain(role);
    expect(CSSD_DEVICE_ROUTE_ROLES.length).toBeLessThan(CSSD_ROUTE_ROLES.length);
  });

  it('admits sterile processing, the wards, infection control, quality and admin', () => {
    expect(CSSD_DEVICE_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'OT_STAFF', 'OT_NURSE', 'OT_INCHARGE', 'NURSING_STAFF',
      'INFECTION_CONTROL_OFFICER', 'QUALITY_OFFICER', 'ADMIN', 'SUPER_ADMIN',
    ]));
  });

  it('excludes the audit office, stores/purchase and pharmacy — and the cath lab', () => {
    for (const role of [
      'HR_STAFF', 'DATA_PROTECTION_OFFICER', 'COMPLIANCE_OFFICER',
      'PHARMACY_INCHARGE', 'STORES_PURCHASE_INCHARGE',
      // Cath-lab roles hand devices to CSSD through the case post-use tap;
      // they must not be able to mark one reprocessed without it passing
      // through sterile processing.
      'CATH_LAB_STAFF', 'CATH_LAB_INCHARGE',
    ]) {
      expect(CSSD_DEVICE_ROUTE_ROLES).not.toContain(role);
    }
    // ...and three of those ARE on the mount, so the narrowing is doing work.
    expect(CSSD_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'HR_STAFF', 'PHARMACY_INCHARGE', 'STORES_PURCHASE_INCHARGE',
    ]));
  });

  it('the gate DECIDES: OT_NURSE reads the queue, HR_STAFF is refused', async () => {
    const allowed = await request(appFor('/api/v1/cssd', CSSD_ROUTE_ROLES, cssdRouter, 'OT_NURSE'))
      .get('/api/v1/cssd/devices');
    expect(allowed.status).toBe(200);
    expect(deviceService.listDevices).toHaveBeenCalledTimes(1);

    deviceService.listDevices.mockClear();
    const refused = await request(appFor('/api/v1/cssd', CSSD_ROUTE_ROLES, cssdRouter, 'HR_STAFF'))
      .get('/api/v1/cssd/devices');
    expect(refused.status).toBe(403);
    expect(deviceService.listDevices).not.toHaveBeenCalled();
  });

  it('...and the narrowing is scoped to /devices — HR_STAFF still reads the CSSD board', async () => {
    const res = await request(appFor('/api/v1/cssd', CSSD_ROUTE_ROLES, cssdRouter, 'HR_STAFF'))
      .get('/api/v1/cssd/board');
    expect(res.status).toBe(200);
  });
});

describe('reprocessing policy governance router', () => {
  it('serves exactly the four policy routes plus the infection-control history read', () => {
    expect([...POLICY.keys()].sort()).toEqual(
      [...POLICY_ROUTES, 'GET /devices/:deviceId/history'].sort(),
    );
  });

  it('the four policy routes are GONE from the admin cath-consumables barrel', () => {
    // The whole point of the move: nothing reprocessing-shaped may be reachable
    // behind ADMIN_ROUTE_ROLES any more.
    expect([...ADMIN.keys()].filter((key) => /reprocessing/i.test(key))).toEqual([]);
    // ...while the billing-facing surfaces it legitimately owns stay put.
    expect([...ADMIN.keys()].sort()).toEqual([
      'GET /billing-settings',
      'GET /catalog',
      'GET /unbilled-usage',
      'POST /authority-recovery/:id/resolve',
      'PUT /billing-settings',
      'PUT /catalog',
    ]);
  });

  it('builds ONE policy claim layer, required, scoped to cath_reprocessing_policy', () => {
    expect(policyClaim).not.toBeNull();
    expect(requireIdempotencyKey.mock.calls[policyClaim.index][0]).toEqual({
      required: true,
      scope: 'cath_reprocessing_policy',
    });
  });

  it.each(['PUT /settings', 'PUT /policies'])('%s claims an idempotency key ahead of its handler', (route) => {
    const entry = POLICY.get(route);
    expect({ route, claimed: entry.claimIndex > -1 }).toEqual({ route, claimed: true });
    expect(entry.claimIndex).toBeLessThan(entry.layerCount - 1);
  });

  it.each(['GET /settings', 'GET /policies'])('%s takes no idempotency key', (route) => {
    expect(POLICY.get(route).claimIndex).toBe(-1);
  });

  it('the history read is the SAME handler the cath router registers', () => {
    const entry = POLICY.get('GET /devices/:deviceId/history');
    expect(entry.layerCount).toBe(1);
    expect(entry.handles[0]).toBe(cathDeviceHistoryHandler);
  });

  it.each([
    ['GET /settings', 'getReprocessingSettings'],
    ['PUT /settings', 'upsertReprocessingSettings'],
    ['GET /policies', 'listCategoryPolicies'],
    ['PUT /policies', 'upsertCategoryPolicies'],
  ])('%s dispatches to %s pinned to the authenticated tenant and actor', async (route, fnName) => {
    const OTHER_TENANT = '00000000-0000-4000-8000-000000000099';
    await invoke(POLICY.get(route), {
      params: {},
      query: {},
      // A body-supplied tenantId must never win over the resolved tenant.
      body: { tenantId: OTHER_TENANT, policies: [{ category: 'balloon', reprocessable: false }] },
      user: { uid: ACTOR, role: 'QUALITY_OFFICER' },
      get: () => undefined,
    });
    expect(deviceService[fnName]).toHaveBeenCalledTimes(1);
    expect(deviceService[fnName].mock.calls[0][0]).toMatchObject({ tenantId: TENANT });
    if (route.startsWith('PUT')) {
      // The actor written to reviewed_by/updated_by and to the append-only
      // audit row is the JWT subject, never anything from the body.
      expect(deviceService[fnName].mock.calls[0][1]).toMatchObject({ actorUid: ACTOR });
    }
  });
});

describe('the reprocessing policy audience', () => {
  it('names the two officers who own device reuse, plus platform admin', () => {
    expect(CATH_REPROCESSING_POLICY_ROUTE_ROLES).toEqual(expect.arrayContaining([
      'QUALITY_OFFICER',
      'INFECTION_CONTROL_OFFICER',
      'ADMIN',
      'SUPER_ADMIN',
    ]));
    // Deliberately NOT the whole platform-admin console audience it used to
    // sit behind, and not the clinical floor.
    for (const role of ['DOCTOR', 'NURSING_STAFF', 'PHARMACIST', 'CATH_LAB_STAFF', 'HR_STAFF']) {
      expect(CATH_REPROCESSING_POLICY_ROUTE_ROLES).not.toContain(role);
    }
  });

  it('app.js mounts the router behind exactly that list', () => {
    // Pins the harness below to production: without this, the supertests would
    // only prove that SOME list decides, not that THIS one is mounted.
    expect(APP_SOURCE).toMatch(
      /app\.use\('\/api\/v1\/cath-reprocessing', requireRole\(\.\.\.CATH_REPROCESSING_POLICY_ROUTE_ROLES\)/,
    );
  });

  it('the gate DECIDES: a QUALITY_OFFICER reads the settings', async () => {
    const res = await request(
      appFor('/api/v1/cath-reprocessing', CATH_REPROCESSING_POLICY_ROUTE_ROLES, governanceRouter, 'QUALITY_OFFICER'),
    ).get('/api/v1/cath-reprocessing/settings');

    expect(res.status).toBe(200);
    expect(res.body.data.settings).toMatchObject({ tenant_id: TENANT });
    expect(deviceService.getReprocessingSettings).toHaveBeenCalledTimes(1);
  });

  it('the gate DECIDES: an INFECTION_CONTROL_OFFICER reads the settings', async () => {
    const res = await request(
      appFor('/api/v1/cath-reprocessing', CATH_REPROCESSING_POLICY_ROUTE_ROLES, governanceRouter, 'INFECTION_CONTROL_OFFICER'),
    ).get('/api/v1/cath-reprocessing/settings');

    expect(res.status).toBe(200);
    expect(deviceService.getReprocessingSettings).toHaveBeenCalledTimes(1);
  });

  it('the gate DECIDES: a PHARMACIST is refused and never reaches the service', async () => {
    const res = await request(
      appFor('/api/v1/cath-reprocessing', CATH_REPROCESSING_POLICY_ROUTE_ROLES, governanceRouter, 'PHARMACIST'),
    ).get('/api/v1/cath-reprocessing/settings');

    expect(res.status).toBe(403);
    expect(deviceService.getReprocessingSettings).not.toHaveBeenCalled();
  });
});

describe('the stand-in middleware match the real ones', () => {
  it('the claim layer name is the name the real middleware uses', () => {
    const source = readFileSync(
      new URL('../../middleware/idempotencyMiddleware.js', import.meta.url),
      'utf8',
    );
    expect(source).toContain(`return async function ${IDEMPOTENCY_NAME}(req, res, next)`);
  });

  it('every role these gates decide on is a real role', async () => {
    const { ALL_ROLES } = await import('../../utils/roles.js');
    for (const role of [...CATH_REPROCESSING_POLICY_ROUTE_ROLES, ...CSSD_DEVICE_ROUTE_ROLES]) {
      expect(ALL_ROLES).toContain(role);
    }
    // ...including the probe roles the refusals above rely on: an invented
    // string would be refused by every gate and prove nothing.
    for (const role of ['PHARMACIST', 'HR_STAFF', 'OT_NURSE']) expect(ALL_ROLES).toContain(role);
  });
});
