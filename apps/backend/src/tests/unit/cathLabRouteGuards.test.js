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
const { default: cathSchedulingRouter } = await import('../../routes/clinical/cathSchedulingRoutes.js');
const { selectCathCasePatient, selectCathReportPatient } = await import('../../routes/clinical/cathLabAccessGuards.js');

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
      'GET /cases/:id/quick-wins': byId,
      'POST /cases/:id/readiness/evidence/refresh': byId,
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

  it('POST /cases/:id/consumables runs the guard BEFORE the idempotency-key claim', () => {
    const layer = cathLabRouter.stack.find(
      (l) => l.route && l.route.path === '/cases/:id/consumables' && l.route.methods.post,
    );
    const names = layer.route.stack.map((s) => s.handle.name);
    const guardIndex = layer.route.stack.findIndex((s) => s.handle.patientGuardTag);
    const idempotencyIndex = names.findIndex((n) => /idempotency/i.test(n));
    expect(guardIndex).toBeGreaterThan(-1);
    expect(idempotencyIndex).toBeGreaterThan(-1);
    expect(guardIndex).toBeLessThan(idempotencyIndex);
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
