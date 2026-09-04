/**
 * Guard wiring for the blood-borne marker read/void surface.
 *
 * /api/v1/bloodborne-markers is mounted behind a mount-level
 * patientAccessGuard that can never see :patientUid (it runs before Express
 * has matched a route — mountLevelPatientGuardCensus.test.js exempts this
 * pair for exactly that reason), so the ONLY patient-access control on this
 * PHI surface is the per-route guardMarkerAccess inside the router. A route
 * added without it, or with the guard demoted below the idempotency claim,
 * would read PHI with no patient check and nothing else in the suite would
 * notice.
 *
 * This is a census, not a behaviour test: the real router is imported and its
 * layer stack walked, so the pins are on the wiring itself — every route
 * guarded, the guard's options (fail-closed requirePatientContext), the void
 * route's idempotency layer, the chain ORDER, and the exact route set.
 */

import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';

const POLICY_CODE = 'patient.clinical_workflow.access';

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

// The guard factory is spied so its options can be asserted; the middleware it
// returns keeps the REAL middleware's function name, which is what both this
// census and mountLevelPatientGuardCensus.test.js detect guards by. That the
// name still matches the real module is pinned below, so this stand-in cannot
// drift into agreeing only with itself.
const patientAccessGuard = jest.fn(() => function patientAccessGuardMiddleware(_req, _res, next) {
  return next();
});

jest.unstable_mockModule('../../middleware/phiAccessMiddleware.js', () => ({
  patientAccessGuard,
  patientAccessGuardForResource: () => function patientAccessGuardForResourceMiddleware(_req, _res, next) {
    return next();
  },
  phiAccessLogger: () => (_req, _res, next) => next(),
}));

// requireIdempotencyKey is the REAL middleware here — the claim layer's
// presence and position are the point, and its declared options are pinned in
// bloodborneMarkerRoutes.test.js.
const { default: router } = await import('../../routes/clinical/bloodborneMarkerRoutes.js');

const GUARD_NAME = 'patientAccessGuardMiddleware';
const ROUTES = {
  'GET /patient/:patientUid': { idempotent: false },
  'POST /patient/:patientUid/markers/:id/void': { idempotent: true },
};

function routeTable() {
  const table = new Map();
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]);
    const names = layer.route.stack.map((s) => s.handle.name);
    for (const method of new Set(methods)) {
      table.set(`${method.toUpperCase()} ${layer.route.path}`, {
        names,
        guardIndex: names.indexOf(GUARD_NAME),
        uidIndex: names.indexOf('requirePatientUidParam'),
        idempotencyIndex: names.findIndex((n) => /idempotency/i.test(n)),
        layerCount: layer.route.stack.length,
      });
    }
  }
  return table;
}

const TABLE = routeTable();

describe('blood-borne marker route guard census', () => {
  it('exposes exactly the read and the void — a third route must be censused deliberately', () => {
    expect([...TABLE.keys()].sort()).toEqual(Object.keys(ROUTES).sort());
  });

  it.each(Object.keys(ROUTES))('%s carries the per-route patient-access guard', (route) => {
    const entry = TABLE.get(route);
    expect({ route, guarded: entry.guardIndex > -1 }).toEqual({ route, guarded: true });
    // The guard is a real layer ahead of the handler, not the handler itself.
    expect(entry.guardIndex).toBeLessThan(entry.layerCount - 1);
  });

  it.each(Object.keys(ROUTES))('%s validates :patientUid in its own layer, after the guard', (route) => {
    const entry = TABLE.get(route);
    expect({ route, index: entry.uidIndex > -1 }).toEqual({ route, index: true });
    // Guard first: an unauthorised caller must not be able to tell a
    // well-formed uid from a malformed one by the status code.
    expect(entry.guardIndex).toBeLessThan(entry.uidIndex);
  });

  it('the void route claims an idempotency key, AFTER the guard and the uid check', () => {
    const entry = TABLE.get('POST /patient/:patientUid/markers/:id/void');
    expect(entry.idempotencyIndex).toBeGreaterThan(-1);
    expect(entry.guardIndex).toBeLessThan(entry.idempotencyIndex);
    // A malformed uid must be rejected before a key is burned on it.
    expect(entry.uidIndex).toBeLessThan(entry.idempotencyIndex);
  });

  it('the read route takes no idempotency key', () => {
    expect(TABLE.get('GET /patient/:patientUid').idempotencyIndex).toBe(-1);
  });

  it('builds ONE guard, declared fail-closed on an unresolvable patient', () => {
    // requirePatientContext is the fail-closed bit: without it a uid that does
    // not resolve to a patient in this tenant yields no_patient_context and
    // falls through to the handler, which then reads by that uid anyway.
    expect(patientAccessGuard).toHaveBeenCalledTimes(1);
    expect(patientAccessGuard).toHaveBeenCalledWith('BLOODBORNE_MARKERS', {
      policyCode: POLICY_CODE,
      requirePatientContext: true,
    });
  });

  it('detects guards by the name the real middleware actually uses', () => {
    // Without this the census above would pass against a stand-in whose name
    // no longer matches production's, i.e. against nothing at all.
    const source = readFileSync(
      new URL('../../middleware/phiAccessMiddleware.js', import.meta.url),
      'utf8',
    );
    expect(source).toContain(`function ${GUARD_NAME}(req, res, next)`);
  });
});
