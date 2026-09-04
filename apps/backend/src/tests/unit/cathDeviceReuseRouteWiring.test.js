/**
 * Wiring census for the two device-reuse surfaces that are NOT on the cath
 * router (those live in cathLabRouteGuards.test.js):
 *
 *   - the CSSD reprocessable-device queue (six routes on cssdRoutes), where the
 *     five state transitions are commands that must each claim an idempotency
 *     key and the queue read must not; and
 *   - the admin reprocessing settings/policies (four routes on
 *     admin/cathConsumablesRoutes), which sit under the admin barrel's
 *     ADMIN_ROUTE_ROLES mount gate and carry an ADDITIONAL route-level role
 *     gate because reuse policy is clinical governance, not billing config.
 *
 * Both are census-style: the real routers are imported and their layer stacks
 * walked, so the pins are on the wiring. The two middleware FACTORIES are
 * spied so their options can be asserted and the exact function object each
 * router received can be matched by identity — a look-alike with the same name
 * cannot satisfy these tests. The middleware names the stand-ins use are
 * pinned against the real modules' source at the bottom of the file, so the
 * census cannot drift into agreeing only with itself.
 */

import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const IDEMPOTENCY_NAME = 'idempotencyMiddleware';
const RBAC_NAME = 'rbacRoleGate';
const POLICY_ROLES = ['QUALITY_OFFICER', 'INFECTION_CONTROL_OFFICER', 'SUPER_ADMIN'];

const requireIdempotencyKey = jest.fn(() => function idempotencyMiddleware(_req, _res, next) {
  return next();
});
jest.unstable_mockModule('../../middleware/idempotencyMiddleware.js', () => ({
  requireIdempotencyKey,
}));

const requireRole = jest.fn(() => function rbacRoleGate(_req, _res, next) {
  return next();
});
jest.unstable_mockModule('../../middleware/rbacMiddleware.js', () => ({
  __esModule: true,
  default: () => function rbacRoleGate(_req, _res, next) { return next(); },
  requireRole,
  requireAnyRole: requireRole,
}));

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  phiAccessLogger: () => (_req, _res, next) => next(),
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
};
jest.unstable_mockModule('../../services/clinical/cathDeviceReuseService.js', () => deviceService);

jest.unstable_mockModule('../../services/cssd/cssdService.js', () => ({
  getCssdBoard: jest.fn(), listInstrumentSets: jest.fn(), createInstrumentSet: jest.fn(),
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

// The exact instances each router built. cssdRoutes makes ONE device claim
// layer and reuses it across its five commands; the admin router makes ONE
// policy role gate and reuses it across its four routes.
const cssdClaimCall = requireIdempotencyKey.mock.calls
  .findIndex(([options]) => options?.scope === 'cssd_device_transition');
const cssdClaimInstance = cssdClaimCall === -1
  ? null
  : requireIdempotencyKey.mock.results[cssdClaimCall].value;
const policyRoleInstance = requireRole.mock.results[0]?.value ?? null;

function routeTable(router) {
  const table = new Map();
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]);
    const handles = layer.route.stack.map((s) => s.handle);
    for (const method of new Set(methods)) {
      table.set(`${method.toUpperCase()} ${layer.route.path}`, {
        handles,
        names: handles.map((h) => h.name),
        claimIndex: handles.indexOf(cssdClaimInstance),
        roleIndex: handles.indexOf(policyRoleInstance),
        layerCount: handles.length,
      });
    }
  }
  return table;
}

const CSSD = routeTable(cssdRouter);
const ADMIN = routeTable(adminCathRouter);

const CSSD_COMMANDS = [
  ['POST /devices/:id/receive', 'receiveDevice'],
  ['POST /devices/:id/reprocessed', 'markDeviceReprocessed'],
  ['POST /devices/:id/quarantine', 'quarantineDevice'],
  ['POST /devices/:id/release', 'releaseDevice'],
  ['POST /devices/:id/discard', 'discardDevice'],
];
const ADMIN_ROUTES = [
  'GET /reprocessing-settings',
  'PUT /reprocessing-settings',
  'GET /reprocessing-policies',
  'PUT /reprocessing-policies',
];

/** Drive one route's terminal handler with a fake req/res. */
async function invoke(entry, req) {
  const res = { statusCode: null, body: null, headersSent: false };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; res.headersSent = true; return res; };
  await entry.handles[entry.layerCount - 1](req, res, () => {});
  return res;
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
    expect(cssdClaimInstance).not.toBeNull();
    expect(requireIdempotencyKey.mock.calls[cssdClaimCall][0]).toEqual({
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
      user: { uid: ACTOR, role: 'CSSD_TECHNICIAN' },
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
      user: { uid: ACTOR, role: 'CSSD_TECHNICIAN' },
      get: () => undefined,
    });
    expect(deviceService.listDevices).toHaveBeenCalledWith({
      tenantId: TENANT, status: 'in_cssd', facilityId: '4', limit: '25',
    });
  });
});

describe('admin reprocessing policy wiring', () => {
  it('adds exactly the four reprocessing routes to the cath-consumables admin router', () => {
    const policyRoutes = [...ADMIN.keys()].filter((key) => key.includes('/reprocessing-'));
    expect(policyRoutes.sort()).toEqual([...ADMIN_ROUTES].sort());
  });

  it('builds ONE route-level role gate for exactly the two officers plus SUPER_ADMIN', () => {
    expect(requireRole).toHaveBeenCalledTimes(1);
    expect(requireRole).toHaveBeenCalledWith(...POLICY_ROLES);
    expect(policyRoleInstance).not.toBeNull();
  });

  it.each(ADMIN_ROUTES)('%s carries the reprocessing-policy role gate ahead of its handler', (route) => {
    const entry = ADMIN.get(route);
    expect({ route, gated: entry.roleIndex > -1 }).toEqual({ route, gated: true });
    expect(entry.roleIndex).toBeLessThan(entry.layerCount - 1);
  });

  it('the billing-facing routes on the same router do NOT carry the policy gate', () => {
    // The extra gate is scoped to governance: widening it to the catalogue or
    // billing settings would lock out the admins who legitimately hold those.
    for (const route of ['GET /catalog', 'PUT /catalog', 'GET /billing-settings', 'PUT /billing-settings']) {
      expect({ route, gated: ADMIN.get(route).roleIndex > -1 }).toEqual({ route, gated: false });
    }
  });

  it.each([
    ['GET /reprocessing-settings', 'getReprocessingSettings'],
    ['PUT /reprocessing-settings', 'upsertReprocessingSettings'],
    ['GET /reprocessing-policies', 'listCategoryPolicies'],
    ['PUT /reprocessing-policies', 'upsertCategoryPolicies'],
  ])('%s dispatches to %s pinned to the authenticated tenant', async (route, fnName) => {
    const OTHER_TENANT = '00000000-0000-4000-8000-000000000099';
    await invoke(ADMIN.get(route), {
      params: {},
      query: {},
      // A body-supplied tenantId must never win over req.tenantId.
      body: { tenantId: OTHER_TENANT, policies: [{ category: 'balloon', reprocessable: false }] },
      tenantId: TENANT,
      user: { uid: ACTOR, role: 'QUALITY_OFFICER' },
      get: () => undefined,
    });
    expect(deviceService[fnName]).toHaveBeenCalledTimes(1);
    expect(deviceService[fnName].mock.calls[0][0]).toMatchObject({ tenantId: TENANT });
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

  it('requireRole is a real named export of the rbac middleware', () => {
    const source = readFileSync(
      new URL('../../middleware/rbacMiddleware.js', import.meta.url),
      'utf8',
    );
    expect(source).toContain('export const requireRole =');
  });

  it('the three policy roles are real roles', async () => {
    const { ALL_ROLES } = await import('../../utils/roles.js');
    for (const role of POLICY_ROLES) expect(ALL_ROLES).toContain(role);
  });

  it('names the stand-ins use are not accidentally shared with a real layer', () => {
    expect(IDEMPOTENCY_NAME).not.toBe(RBAC_NAME);
  });
});
