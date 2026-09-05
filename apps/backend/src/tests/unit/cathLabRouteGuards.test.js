/**
 * Re-audit M — cath-lab mount-guard fix (CLINICAL_WORKFLOW).
 *
 * The /api/v1/cath-lab mount used to wrap cathLabRoutes (and its
 * cathSchedulingRoutes subrouter) in patientAccessGuard('CLINICAL_WORKFLOW'),
 * where req.params is empty before route match, so the guard returned
 * no_patient_context without ever evaluating a policy. The guard now lives
 * per route in BOTH routers (cathLabAccessGuards.js), with selectors that
 * resolve the exact case/report row the handler serves.
 *
 * Pins (mocked prisma): the full census of both routers, the case/report
 * selectors' identifier + tenant predicate (bigint-safe), and the never-throw
 * contract.
 */

import { jest } from '@jest/globals';

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

const { default: cathLabRouter } = await import('../../routes/clinical/cathLabRoutes.js');
const { default: cathDeviceHistoryHandler } = await import('../../routes/clinical/cathDeviceHistoryHandler.js');
const { default: cathSchedulingRouter } = await import('../../routes/clinical/cathSchedulingRoutes.js');
const { selectCathCasePatient, selectCathReportPatient } = await import('../../routes/clinical/cathLabAccessGuards.js');
const { canUseCathWorkflow, canViewCathReport } = await import('../../utils/roleHelpers.js');
const { ITEM_CODES } = await import('../../services/clinical/cathLabReadinessService.js');
const { ALL_ROLES } = await import('../../utils/roles.js');

const TENANT = '11111111-2222-4333-8444-555555555555';
const PATIENT_UID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function routeTable(router) {
  const table = new Map();
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]);
    for (const method of new Set(methods)) {
      const guards = layer.route.stack
        .map((s, index) => ({ index, tag: s.handle.patientGuardTag, recordType: s.handle.patientGuardRecordType }))
        .filter((entry) => entry.tag);
      table.set(`${method.toUpperCase()} ${layer.route.path}`, {
        guards,
        layerCount: layer.route.stack.length,
      });
    }
  }
  return table;
}

function expectCensus(router, expected) {
  const table = routeTable(router);
  expect([...table.keys()].sort()).toEqual(Object.keys(expected).sort());
  for (const [route, expectedTag] of Object.entries(expected)) {
    const entry = table.get(route);
    if (expectedTag === null) {
      expect({ route, guards: entry.guards }).toEqual({ route, guards: [] });
    } else {
      expect({ route, tags: entry.guards.map((g) => g.tag) }).toEqual({ route, tags: [expectedTag] });
      expect(entry.guards[0].recordType).toBe('CLINICAL_WORKFLOW');
      expect(entry.guards[0].index).toBeGreaterThan(0);
      expect(entry.guards[0].index).toBeLessThan(entry.layerCount - 1);
    }
  }
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
});

describe('route census — guarded vs deliberately-not', () => {
  it('cathLabRoutes: per-case, catalog-case, and report routes are guarded', () => {
    const byId = 'cath-lab:case-param:id';
    const byCaseId = 'cath-lab:case-param:caseId';
    const report = 'cath-lab:report-param';
    expectCensus(cathLabRouter, {
      'GET /report-templates': null, // template catalog
      'GET /consumables/catalog': 'cath-lab:case-query:case_id',
      'GET /consumables/catalog/:id/batches': 'cath-lab:case-query:case_id',
      'POST /report-templates/:id/supersede': null, // template governance
      'GET /cases/:caseId/reports': byCaseId,
      'POST /cases/:caseId/reports': byCaseId,
      'GET /cases/:caseId/viewer-link': byCaseId,
      'GET /reports/:id/pdf': report,
      'GET /reports/:id': report,
      'PATCH /reports/:id': report,
      'POST /reports/:id/preliminary': report,
      'POST /reports/:id/sign': report,
      'POST /reports/:id/addenda': report,
      'GET /cases': null, // day list
      'POST /cases': 'cath-lab:body-patient-uid',
      'GET /cases/:id': byId,
      'GET /cases/:id/consumables': byId,
      'POST /cases/:id/consumables': byId,
      'POST /cases/:id/consumables/:usageId/post-use': byId,
      'GET /devices/lookup': 'cath-lab:case-query:case_id',
      // Deliberately NOT patient-guarded: a reprocessable device spans
      // patients, so there is no single case or report row a selector could
      // resolve. The mount's phiAccessLogger('CATH_LAB') cannot be the trail
      // either — it resolves a patient from the request and this request
      // carries none, so it writes patient_id = NULL. The trail is the
      // explicit per-patient batch the shared handler writes; the authority is
      // the mount role gate plus the cath WORKFLOW gate pinned below.
      'GET /devices/:deviceId/history': null,
      'GET /cases/:id/quick-wins': byId,
      'POST /cases/:id/readiness/evidence/refresh': byId,
      // Pre-cath lab readiness (Plan 3). The GET carries per-item lab VALUES,
      // so it is PHI on the same terms as every other per-case read here: the
      // mount's phiAccessLogger('CATH_LAB') writes the access row against the
      // patient this guard has already resolved.
      'GET /cases/:id/readiness/labs': byId,
      'POST /cases/:id/readiness/labs/order-missing': byId,
      'POST /cases/:id/readiness/labs/:item/external-result': byId,
      'POST /cases/:id/readiness/labs/:item/waive': byId,
      'POST /cases/:id/order-sets/:slot/apply': byId,
      'POST /cases/:id/status': byId,
      'POST /cases/:id/readiness': byId,
      'POST /cases/:id/procedure-logs': byId,
      'POST /cases/:id/hemodynamics': byId,
      'POST /cases/:id/contrast-radiation': byId,
      'POST /cases/:id/post-orders': byId,
      'POST /cases/:id/device-links': byId,
    });
  });

  it('cathSchedulingRoutes: per-case schedule routes guarded; the day strip is not', () => {
    const byId = 'cath-lab:case-param:id';
    expectCensus(cathSchedulingRouter, {
      'GET /schedule': null, // day strip board
      'GET /cases/:id/schedule': byId,
      'POST /cases/:id/schedule': byId,
      'POST /cases/:id/schedule/cancel': byId,
      'POST /cases/:id/complications': byId,
    });
  });

  it.each([
    '/cases/:id/consumables',
    '/cases/:id/consumables/:usageId/post-use',
    '/cases/:id/readiness/labs/order-missing',
    '/cases/:id/readiness/labs/:item/external-result',
    '/cases/:id/readiness/labs/:item/waive',
  ])('POST %s runs the guard BEFORE the idempotency-key claim', (path) => {
    const layer = cathLabRouter.stack.find(
      (l) => l.route && l.route.path === path && l.route.methods.post,
    );
    const names = layer.route.stack.map((s) => s.handle.name);
    const guardIndex = layer.route.stack.findIndex((s) => s.handle.patientGuardTag);
    const idempotencyIndex = names.findIndex((n) => /idempotency/i.test(n));
    expect(guardIndex).toBeGreaterThan(-1);
    expect(idempotencyIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(idempotencyIndex);
  });
});

/**
 * Device-reuse routes (spec 2026-09-04): the role gates are anonymous closures
 * built by the router's own roleGuard(), so they cannot be identified by name.
 * Probe them instead — run the layer with a role that holds neither cath gate
 * and read back the refusal code. That pins WHICH gate is mounted, not merely
 * that some middleware sits in front of the handler.
 */
// A REAL role that holds neither cath gate. It has to be real: an invented
// string normalises to '' and would be refused by every gate, so the probe
// would pass against nothing. RECEPTIONIST is deliberately not used — it holds
// cath report-read, which is exactly the distinction being pinned here.
const NON_CATH_ROLE = 'PHARMACIST';

function refusalCodeOf(handle) {
  let payload = null;
  const res = {
    statusCode: null,
    req: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { payload = body; return this; },
  };
  let passed = false;
  handle({ user: { role: NON_CATH_ROLE }, get: () => undefined }, res, () => { passed = true; });
  if (passed) return null;
  return { status: res.statusCode, code: JSON.stringify(payload) };
}

function layerOf(method, path) {
  const layer = cathLabRouter.stack.find(
    (l) => l.route && l.route.path === path && l.route.methods[method],
  );
  expect(layer).toBeDefined();
  return layer.route.stack;
}

describe('device-reuse route chains', () => {
  it('the probe role is a real role that holds neither cath gate', () => {
    expect(ALL_ROLES).toContain(NON_CATH_ROLE);
    expect(canUseCathWorkflow(NON_CATH_ROLE)).toBe(false);
    expect(canViewCathReport(NON_CATH_ROLE)).toBe(false);
    // ...and the gates do let a cath role through, so a refusal below is the
    // gate deciding, not a gate that refuses everyone.
    expect(canUseCathWorkflow('CATH_LAB_STAFF')).toBe(true);
    expect(canViewCathReport('CATH_LAB_STAFF')).toBe(true);
  });

  it('POST /cases/:id/consumables/:usageId/post-use: workflow gate, case guard, claim, handler', () => {
    const stack = layerOf('post', '/cases/:id/consumables/:usageId/post-use');
    expect(stack).toHaveLength(4);
    const refusal = refusalCodeOf(stack[0].handle);
    expect(refusal.status).toBe(403);
    expect(refusal.code).toContain('CATH_LAB_WORKFLOW_FORBIDDEN');
    expect(stack[1].handle.patientGuardTag).toBe('cath-lab:case-param:id');
    expect(stack[1].handle.patientGuardRecordType).toBe('CLINICAL_WORKFLOW');
    expect(/idempotency/i.test(stack[2].handle.name)).toBe(true);
  });

  it('GET /devices/lookup: report-read gate then the case-query guard (facility pin)', () => {
    const stack = layerOf('get', '/devices/lookup');
    expect(stack).toHaveLength(3);
    const refusal = refusalCodeOf(stack[0].handle);
    expect(refusal.status).toBe(403);
    expect(refusal.code).toContain('CATH_REPORT_READ_FORBIDDEN');
    // The guard is what makes ?case_id a real authority check rather than a
    // hint: without it the lookup would describe any device in the tenant.
    expect(stack[1].handle.patientGuardTag).toBe('cath-lab:case-query:case_id');
    expect(stack.some((s) => /idempotency/i.test(s.handle.name))).toBe(false);
  });

  it('GET /devices/:deviceId/history: WORKFLOW gate, no per-route patient guard', () => {
    const stack = layerOf('get', '/devices/:deviceId/history');
    expect(stack).toHaveLength(2);
    const refusal = refusalCodeOf(stack[0].handle);
    expect(refusal.status).toBe(403);
    // The workflow gate, NOT report-read: report-read admits RECEPTIONIST and
    // TECHNICIAN, and a cross-patient blood-borne lookback is not a front-desk
    // or an imaging read. Infection control reaches the same handler on the
    // /api/v1/cath-reprocessing governance mount instead.
    expect(refusal.code).toContain('CATH_LAB_WORKFLOW_FORBIDDEN');
    expect(canViewCathReport('RECEPTIONIST')).toBe(true);
    expect(canUseCathWorkflow('RECEPTIONIST')).toBe(false);
    expect(canUseCathWorkflow('TECHNICIAN')).toBe(false);
    // Multi-patient by construction — asserted here so a later "fix" that
    // bolts a single-patient selector on has to argue with this test first.
    expect(stack.filter((s) => s.handle.patientGuardTag)).toEqual([]);
    // ...and the terminal handler is the SHARED one the governance router also
    // registers, so the per-patient access trail cannot exist on one mount and
    // not the other.
    expect(stack[1].handle).toBe(cathDeviceHistoryHandler);
  });
});

/**
 * Pre-cath lab readiness (Plan 3). Same probe technique as above: the role
 * gates are anonymous closures, so WHICH gate is mounted is read back from the
 * refusal code rather than assumed from a layer count.
 */
describe('lab readiness route chains', () => {
  it('GET /cases/:id/readiness/labs: report-read gate then the case guard', () => {
    const stack = layerOf('get', '/cases/:id/readiness/labs');
    expect(stack).toHaveLength(3);
    const refusal = refusalCodeOf(stack[0].handle);
    expect(refusal.status).toBe(403);
    // Report-read, not workflow: reading the checklist is what a scrub nurse,
    // a technician and the front desk all do before the case is called.
    expect(refusal.code).toContain('CATH_REPORT_READ_FORBIDDEN');
    expect(stack[1].handle.patientGuardTag).toBe('cath-lab:case-param:id');
    expect(stack[1].handle.patientGuardRecordType).toBe('CLINICAL_WORKFLOW');
    // A read must never burn an idempotency key.
    expect(stack.some((layer) => /idempotency/i.test(layer.handle.name))).toBe(false);
  });

  it.each([
    ['/cases/:id/readiness/labs/order-missing', 4],
    ['/cases/:id/readiness/labs/:item/external-result', 5],
    ['/cases/:id/readiness/labs/:item/waive', 5],
  ])('POST %s: workflow gate, case guard, claim, handler', (path, layers) => {
    const stack = layerOf('post', path);
    expect(stack).toHaveLength(layers);
    const refusal = refusalCodeOf(stack[0].handle);
    expect(refusal.status).toBe(403);
    // All three are WRITES — they place orders, mint an external lab result, or
    // record a clinical override — so report-read (which admits RECEPTIONIST
    // and TECHNICIAN) is not enough. The waive route in particular: the plan
    // that specified these routes left its claim off entirely.
    expect(refusal.code).toContain('CATH_LAB_WORKFLOW_FORBIDDEN');
    expect(stack[1].handle.patientGuardTag).toBe('cath-lab:case-param:id');
    expect(stack[1].handle.patientGuardRecordType).toBe('CLINICAL_WORKFLOW');
    expect(/idempotency/i.test(stack[layers - 2].handle.name)).toBe(true);
  });

  it.each([
    '/cases/:id/readiness/labs/:item/external-result',
    '/cases/:id/readiness/labs/:item/waive',
  ])('POST %s refuses an unknown :item BEFORE a key is burned', (path) => {
    const stack = layerOf('post', path);
    // The service answers 400 CATH_LAB_READINESS_ITEM_UNKNOWN for a code
    // outside ITEM_CODES, but it runs AFTER the claim layer, so a URL that can
    // never succeed would already have written a register row. This layer sits
    // in front of the claim and runs the SAME membership test against the
    // service's exported ITEM_CODES — not a shape heuristic, which passed
    // `banana` straight through to burn a key.
    const itemGuard = stack[2].handle;
    expect(itemGuard.name).toBe('requireReadinessItemParam');
    expect(/idempotency/i.test(stack[3].handle.name)).toBe(true);

    const probe = () => {
      const res = {
        statusCode: null,
        payload: null,
        req: {},
        status(code) { this.statusCode = code; return this; },
        json(body) { this.payload = body; return this; },
      };
      return res;
    };

    // A well-shaped segment that is not an item code: the old /^[a-z_]+$/ test
    // accepted it, and the claim in front of the service burned a key on it.
    for (const item of ['banana', '../../etc', 'HBSAG', '', 'hbsag ']) {
      const res = probe();
      let passed = false;
      itemGuard({ params: { item }, get: () => undefined }, res, () => { passed = true; });
      expect({ item, passed }).toEqual({ item, passed: false });
      expect({ item, status: res.statusCode }).toEqual({ item, status: 400 });
      // Top level, not nested under details — the shape relayAppError produces
      // for the service's own AppError, so a client reads one envelope
      // whichever layer refused.
      expect({ item, code: res.payload.code })
        .toEqual({ item, code: 'CATH_LAB_READINESS_ITEM_UNKNOWN' });
      expect(res.payload.details ?? null).toBeNull();
    }

    // ...and every real item code passes through to the claim.
    for (const item of ITEM_CODES) {
      const res = probe();
      let allowed = false;
      itemGuard({ params: { item }, get: () => undefined }, res, () => { allowed = true; });
      expect({ item, allowed }).toEqual({ item, allowed: true });
    }
    expect(ITEM_CODES).toContain('hbsag');
  });
});

describe('selectors', () => {
  it('case selector resolves cath_lab_cases by bigint id with a tenant predicate', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    await expect(selectCathCasePatient({ tenantId: TENANT }, '42')).resolves.toEqual({ uid: PATIENT_UID });
    const [sql, tenantParam, idParam] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/FROM cath_lab_cases/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(sql).toMatch(/id = \$2::bigint/);
    expect(tenantParam).toBe(TENANT);
    expect(idParam).toBe('42');
  });

  it('report selector resolves cath_procedure_reports by bigint id with a tenant predicate', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    await expect(selectCathReportPatient({ tenantId: TENANT }, '77')).resolves.toEqual({ uid: PATIENT_UID });
    const [sql, tenantParam, idParam] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/FROM cath_procedure_reports/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(sql).toMatch(/id = \$2::bigint/);
    expect(tenantParam).toBe(TENANT);
    expect(idParam).toBe('77');
  });

  it('accepts the full int8 range and refuses beyond it', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    await expect(selectCathCasePatient({ tenantId: TENANT }, '9223372036854775807')).resolves.toEqual({ uid: PATIENT_UID });
    expect(queryRawUnsafeMock.mock.calls[0][2]).toBe('9223372036854775807');
    queryRawUnsafeMock.mockClear();
    await expect(selectCathCasePatient({ tenantId: TENANT }, '9223372036854775808')).resolves.toBeNull();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it.each([
    ['case', selectCathCasePatient],
    ['report', selectCathReportPatient],
  ])('%s selector never throws and never queries on malformed ids', async (_label, selector) => {
    for (const raw of ['abc', '-1', '0', '', undefined, null, '1.5', 'ca11ab1e']) {
      await expect(selector({ tenantId: TENANT }, raw)).resolves.toBeNull();
    }
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('resolves null for a missing row and propagates DB failures', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    await expect(selectCathCasePatient({ tenantId: TENANT }, '42')).resolves.toBeNull();
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('connection down'));
    await expect(selectCathCasePatient({ tenantId: TENANT }, '42')).rejects.toThrow('connection down');
  });
});
