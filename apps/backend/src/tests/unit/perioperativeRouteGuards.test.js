/**
 * Re-audit M — perioperative mount-guard fix (theatre / OR board / anesthesia).
 *
 * The /api/v1/theatre and /api/v1/anesthesia mounts used to wrap their routers
 * in patientAccessGuard(...) at the MOUNT, where req.params is empty, so the
 * guard returned no_patient_context without ever evaluating a policy — in
 * shadow AND in enforce. The guard now lives per route with an explicit
 * patientSelector. This suite pins, with a mocked prisma:
 *   (a) each selector resolves the subject from the right identifier with an
 *       explicit tenant predicate, and never throws on malformed input;
 *   (b) every single-patient route carries the guard (route middleware chain),
 *       bound to the intended selector (patientGuardTag) and the mount's
 *       record type;
 *   (c) board/list/catalog routes are NOT patient-context-forced;
 *   (d) end-to-end through the real router: in enforce mode the guard now
 *       actually DECIDES (403 on no relationship, 403 on unresolvable
 *       subject), and in shadow mode it never blocks.
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

const { default: theatreRouter, selectOtSchedulePatient } = await import('../../routes/theatre/theatreRoutes.js');
const { default: orBoardRouter } = await import('../../routes/theatre/orBoardRoutes.js');
const { default: anesthesiaRouter, selectAnesthesiaCasePatient } = await import('../../routes/theatre/anesthesiaChartRoutes.js');

const TENANT = '11111111-2222-4333-8444-555555555555';
const PATIENT_UID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ACTOR_UID = '99999999-8888-4777-8666-555555554444';

function routeTable(router) {
  const table = new Map();
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]);
    for (const method of new Set(methods)) {
      const names = layer.route.stack.map((s) => s.handle.name);
      const guards = layer.route.stack
        .map((s, index) => ({ index, tag: s.handle.patientGuardTag, recordType: s.handle.patientGuardRecordType }))
        .filter((entry) => entry.tag);
      table.set(`${method.toUpperCase()} ${layer.route.path}`, {
        names,
        guards,
        layerCount: layer.route.stack.length,
      });
    }
  }
  return table;
}

/** Assert the router's full surface matches the design table exactly. */
function expectCensus(router, expected, recordType) {
  const table = routeTable(router);
  // No route beyond the design table (a new route must make an explicit
  // guarded/deliberately-not decision here).
  expect([...table.keys()].sort()).toEqual(Object.keys(expected).sort());
  for (const [route, expectedTag] of Object.entries(expected)) {
    const entry = table.get(route);
    if (expectedTag === null) {
      expect({ route, guards: entry.guards }).toEqual({ route, guards: [] });
    } else {
      expect({ route, tags: entry.guards.map((g) => g.tag) }).toEqual({ route, tags: [expectedTag] });
      expect(entry.guards[0].recordType).toBe(recordType);
      // The guard runs before the terminal handler and after at least one
      // earlier middleware (role gate / validators).
      expect(entry.guards[0].index).toBeGreaterThan(0);
      expect(entry.guards[0].index).toBeLessThan(entry.layerCount - 1);
    }
  }
}

function dispatch(handlers) {
  queryRawUnsafeMock.mockImplementation(async (sql, ...params) => {
    for (const [needle, rows] of handlers) {
      if (sql.includes(needle)) {
        return typeof rows === 'function' ? rows(sql, params) : rows;
      }
    }
    return [];
  });
}

function appFor(router, { tenantId = TENANT, role = 'OT_NURSE' } = {}) {
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
});

describe('route census — guarded vs deliberately-not', () => {
  it('theatreRoutes: per-case routes guarded, boards role-gated only', () => {
    expectCensus(theatreRouter, {
      'POST /schedule': 'theatre:body-patient-uid',
      'GET /today': null, // today board — no single subject
      'GET /availability': null, // room availability — no patient at all
      'PUT /:id/status': 'theatre:ot-schedule-param',
      'PUT /:id/checklist': 'theatre:ot-schedule-param',
      'DELETE /:id': 'theatre:ot-schedule-param',
    }, 'OPERATING_THEATRE');
  });

  it('orBoardRoutes: only the booking create is a single-patient surface', () => {
    expectCensus(orBoardRouter, {
      'GET /rooms': null, // room master
      'POST /rooms': null, // room master upsert (admin)
      'GET /procedures': null, // procedure catalog
      'POST /bookings/conflict-check': null, // room/time overlap facts only
      'POST /bookings': 'or-board:body-patient-uid',
      'GET /board': null, // OR board
      'GET /throughput/daily': null, // aggregate
      'GET /safety/weekly': null, // aggregate
    }, 'OPERATING_THEATRE');
  });

  it('anesthesiaChartRoutes: every route is about one theatre case', () => {
    expectCensus(anesthesiaRouter, {
      'POST /entries': 'anesthesia:body-ot-schedule-id',
      'GET /entries/case/:scheduleId': 'anesthesia:ot-schedule-param',
      'GET /totals/case/:scheduleId': 'anesthesia:ot-schedule-param',
    }, 'ANESTHESIA_CHART');
  });
});

describe('ot_schedules selectors', () => {
  it.each([
    ['theatre', selectOtSchedulePatient],
    ['anesthesia', selectAnesthesiaCasePatient],
  ])('%s selector resolves the case row by id with a tenant predicate', async (_label, selector) => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    const result = await selector({ tenantId: TENANT }, '42');
    expect(result).toEqual({ uid: PATIENT_UID });
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    const [sql, tenantParam, idParam] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/FROM ot_schedules/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(sql).toMatch(/id = \$2::int/);
    expect(tenantParam).toBe(TENANT);
    expect(idParam).toBe(42);
  });

  it.each([
    ['non-numeric', 'abc'],
    ['negative', '-1'],
    ['zero', '0'],
    ['int4 overflow (phone-shaped)', '9000090011'],
    ['missing', undefined],
    ['empty', ''],
  ])('never throws and never queries on malformed input (%s)', async (_label, raw) => {
    await expect(selectOtSchedulePatient({ tenantId: TENANT }, raw)).resolves.toBeNull();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('resolves null when the case does not exist in the tenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    await expect(selectOtSchedulePatient({ tenantId: TENANT }, '42')).resolves.toBeNull();
  });

  it('propagates a genuine DB failure so the guard fails closed', async () => {
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('connection down'));
    await expect(selectOtSchedulePatient({ tenantId: TENANT }, '42')).rejects.toThrow('connection down');
  });
});

describe('end-to-end through the real router (mocked prisma)', () => {
  const tenantRow = (tenantId, mode) => [{
    id: tenantId,
    slug: 't',
    name: 'T',
    status: 'active',
    settings: { care_team_enforcement_mode: mode },
  }];

  it('enforce: the guard now actually decides — OT_NURSE with no relationship is denied', async () => {
    // Distinct tenant id per test — tenantService caches tenant rows for 60s.
    const tenant = '11111111-2222-4333-8444-000000000001';
    dispatch([
      ['FROM tenants', tenantRow(tenant, 'enforce')],
      ['FROM ot_schedules', [{ uid: PATIENT_UID }]],
      ['FROM users', [{ id: 7, uid: PATIENT_UID }]],
      // every relationship probe (care team etc.) returns no rows
    ]);
    const res = await request(appFor(theatreRouter, { tenantId: tenant }))
      .put('/x/42/status')
      .send({ status: 'in-progress' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PATIENT_ACCESS_DENIED');
    // The engine evaluated a real policy — the surgical-record family policy —
    // rather than returning no_patient_context.
    expect(res.body.policy_code).toBe('patient.surgical.view');
  });

  it('enforce: an unresolvable case refuses cleanly with PATIENT_CONTEXT_REQUIRED', async () => {
    const tenant = '11111111-2222-4333-8444-000000000002';
    dispatch([
      ['FROM tenants', tenantRow(tenant, 'enforce')],
      ['FROM ot_schedules', []], // no such case in this tenant
    ]);
    const res = await request(appFor(theatreRouter, { tenantId: tenant }))
      .put('/x/42/status')
      .send({ status: 'in-progress' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PATIENT_CONTEXT_REQUIRED');
  });

  it('shadow: never blocks — the would-be denial passes through to the handler', async () => {
    const tenant = '11111111-2222-4333-8444-000000000003';
    dispatch([
      ['FROM tenants', tenantRow(tenant, 'shadow')],
      ['FROM ot_schedules', [{ uid: PATIENT_UID }]],
      ['FROM users', [{ id: 7, uid: PATIENT_UID }]],
      ['FROM anesthesia_chart_entries', []],
    ]);
    const res = await request(appFor(anesthesiaRouter, { tenantId: tenant }))
      .get('/x/entries/case/42');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
