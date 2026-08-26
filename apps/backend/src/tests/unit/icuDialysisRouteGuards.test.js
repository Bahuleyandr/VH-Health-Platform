/**
 * Re-audit M — critical-care mount-guard fix (ICU + dialysis).
 *
 * The /api/v1/icu and /api/v1/dialysis mounts used to wrap their routers in
 * patientAccessGuard(...) at the MOUNT, where req.params is empty, so the
 * guard returned no_patient_context without ever evaluating a policy. The
 * guard now lives per route with selectors that resolve the exact
 * admission/roster/session/access row the handler serves — each one indexed,
 * tenant-scoped lookup that never throws on malformed input (bedside surfaces
 * must refuse cleanly, never 500 on a bad id).
 *
 * Pins (mocked prisma): the full route census (guarded vs deliberately-not),
 * each selector's identifier + tenant predicate, and the never-throw contract.
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

const {
  default: icuRouter,
  selectIcuAdmissionPatient,
  selectErVisitPatient,
  selectVentilationEpisodePatient,
  selectLineEventPatient,
  selectNicuObservationPatient,
} = await import('../../routes/clinical/icuRoutes.js');
const {
  default: dialysisRouter,
  selectDialysisRosterPatient,
  selectDialysisSessionPatient,
  selectVascularAccessPatient,
} = await import('../../routes/clinical/dialysisRoutes.js');

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

function expectCensus(router, expected, recordType) {
  const table = routeTable(router);
  expect([...table.keys()].sort()).toEqual(Object.keys(expected).sort());
  for (const [route, expectedTag] of Object.entries(expected)) {
    const entry = table.get(route);
    if (expectedTag === null) {
      expect({ route, guards: entry.guards }).toEqual({ route, guards: [] });
    } else {
      expect({ route, tags: entry.guards.map((g) => g.tag) }).toEqual({ route, tags: [expectedTag] });
      expect(entry.guards[0].recordType).toBe(recordType);
      expect(entry.guards[0].index).toBeGreaterThan(0);
      expect(entry.guards[0].index).toBeLessThan(entry.layerCount - 1);
    }
  }
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
});

describe('route census — guarded vs deliberately-not', () => {
  it('icuRoutes: every single-patient route is guarded; census/settings/governance are not', () => {
    const admission = 'icu:admission-param';
    expectCensus(icuRouter, {
      'POST /admissions': 'icu:body-patient-uid',
      'POST /admissions/from-er/:emergencyVisitId': 'icu:er-visit-param',
      'GET /admissions': null, // unit census board
      'GET /admissions/:id': admission,
      'PATCH /admissions/:id/code-status': admission,
      'PATCH /admissions/:id/monitoring-interval': admission,
      'PATCH /admissions/:id': admission,
      'POST /admissions/:id/discharge': admission,
      'GET /chart-settings': null, // tenant-level settings
      'PUT /chart-settings': null, // tenant-level settings
      'GET /admissions/:id/chart': admission,
      'GET /admissions/:id/ventilation': admission,
      'POST /admissions/:id/ventilation': admission,
      'PATCH /ventilation/:episodeId/stop': 'icu:ventilation-episode-param',
      'GET /admissions/:id/weaning-trials': admission,
      'POST /admissions/:id/weaning-trials': admission,
      'GET /admissions/:id/lines': admission,
      'POST /admissions/:id/lines': admission,
      'PATCH /lines/:lineEventId/stop': 'icu:line-event-param',
      'GET /admissions/:id/scoring-outputs': admission,
      'POST /admissions/:id/scoring-outputs': admission,
      'POST /admissions/:id/device-observation-links': admission,
      'GET /nicu-chart-settings': null, // tenant-level settings
      'PUT /nicu-chart-settings': null, // governance
      'GET /admissions/:id/nicu-chart': admission,
      'GET /admissions/:id/feed-fluid': admission,
      'POST /admissions/:id/feed-fluid': admission,
      'GET /admissions/:id/feed-fluid/balance': admission,
      'GET /admissions/:id/respiratory-support': admission,
      'POST /admissions/:id/respiratory-support': admission,
      'GET /admissions/:id/cardioresp-events': admission,
      'POST /admissions/:id/cardioresp-events': admission,
      'GET /admissions/:id/jaundice-phototherapy': admission,
      'POST /admissions/:id/jaundice-phototherapy': admission,
      'GET /admissions/:id/thermal-observations': admission,
      'POST /admissions/:id/thermal-observations': admission,
      'PATCH /nicu/:resource/:id/verify': 'icu:nicu-verify-param',
      'GET /admissions/:id/newborn-context': admission,
      'POST /admissions/:id/newborn-link': admission,
      'GET /nicu-score-definitions': null, // governance catalog
      'PUT /nicu-score-definitions': null, // governance
      'GET /admissions/:id/nicu-scores': admission,
      'POST /admissions/:id/nicu-scores': admission,
      'GET /admissions/:id/growth-snapshot': admission,
      'POST /admissions/:id/flowsheet': admission,
      'GET /admissions/:id/flowsheet': admission,
      'GET /admissions/:id/io-summary': admission,
      'POST /admissions/:id/assessments': admission,
      'GET /admissions/:id/assessments': admission,
      'POST /admissions/:id/bundle': admission,
      'GET /admissions/:id/bundle': admission,
      'GET /bundle-compliance': null, // 30-day aggregate
    }, 'ICU');
  });

  it('dialysisRoutes: per-patient/session/access routes guarded; boards + machine surfaces are not', () => {
    const roster = 'dialysis:roster-param';
    const session = 'dialysis:session-param';
    expectCensus(dialysisRouter, {
      'POST /patients': 'dialysis:body-patient-uid',
      'GET /patients': null, // unit roster
      'GET /patients/:id': roster,
      'PATCH /patients/:id/dry-weight': roster,
      'POST /patients/:id/prescription': roster,
      'GET /patients/:id/prescription': roster,
      'POST /patients/:id/access': roster,
      'POST /access/:id/abandon': 'dialysis:access-param',
      'POST /sessions': 'dialysis:body-roster-id',
      'GET /sessions': null, // schedule list board
      'GET /today': null, // today board
      'POST /sessions/:id/start': session,
      'POST /sessions/:id/complete': session,
      'POST /sessions/:id/reuse-register': session,
      'GET /sessions/:id/reuse-register': session,
      'POST /sessions/:id/cancel': session,
      'POST /sessions/:id/obs': session,
      'GET /sessions/:id/obs': session,
      'POST /sessions/:id/events': session,
      'GET /sessions/:id/events': session,
      'POST /machine-qa': null, // machine QA log, no single patient
      'GET /machine-qa': null, // machine QA log
      'POST /machines/ingest': null, // device payload matched by machine_no server-side
      'POST /patients/:id/serology': roster,
    }, 'DIALYSIS');
  });
});

describe('ICU selectors', () => {
  it('admission selector resolves icu_admissions by id with a tenant predicate', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    await expect(selectIcuAdmissionPatient({ tenantId: TENANT }, '42')).resolves.toEqual({ uid: PATIENT_UID });
    const [sql, tenantParam, idParam] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/FROM icu_admissions/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(sql).toMatch(/id = \$2::int/);
    expect(tenantParam).toBe(TENANT);
    expect(idParam).toBe(42);
  });

  it('ER-visit selector resolves emergency_visits by id with a tenant predicate', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    await expect(selectErVisitPatient({ tenantId: TENANT }, '7')).resolves.toEqual({ uid: PATIENT_UID });
    const [sql, tenantParam, idParam] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/FROM emergency_visits/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(tenantParam).toBe(TENANT);
    expect(idParam).toBe(7);
  });

  it.each([
    ['ventilation episode', selectVentilationEpisodePatient, /FROM icu_ventilation_episodes e/],
    ['line event', selectLineEventPatient, /FROM icu_line_tube_drain_events e/],
  ])('%s selector resolves through the admission join, tenant-scoped on both tables', async (_label, selector, fromRe) => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    await expect(selector({ tenantId: TENANT }, '31')).resolves.toEqual({ uid: PATIENT_UID });
    const [sql, tenantParam, idParam] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(fromRe);
    expect(sql).toMatch(/JOIN icu_admissions a/);
    expect(sql).toMatch(/a\.tenant_id = e\.tenant_id/);
    expect(sql).toMatch(/e\.tenant_id = \$1::uuid AND e\.id = \$2::bigint/);
    expect(tenantParam).toBe(TENANT);
    expect(idParam).toBe('31');
  });

  it('NICU verify selector maps the resource through the service allowlist', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    await expect(selectNicuObservationPatient({ tenantId: TENANT }, 'feed-fluid', '5')).resolves.toEqual({ uid: PATIENT_UID });
    const [sql, tenantParam, idParam] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/FROM nicu_feed_fluid_entries t/);
    expect(sql).toMatch(/JOIN icu_admissions a/);
    expect(sql).toMatch(/t\.tenant_id = \$1::uuid AND t\.id = \$2::bigint/);
    expect(tenantParam).toBe(TENANT);
    expect(idParam).toBe('5');
  });

  it('NICU verify selector refuses an unknown resource without querying', async () => {
    await expect(selectNicuObservationPatient({ tenantId: TENANT }, 'users; DROP', '5')).resolves.toBeNull();
    await expect(selectNicuObservationPatient({ tenantId: TENANT }, undefined, '5')).resolves.toBeNull();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it.each([
    ['admission', selectIcuAdmissionPatient],
    ['ER visit', selectErVisitPatient],
    ['ventilation episode', selectVentilationEpisodePatient],
    ['line event', selectLineEventPatient],
  ])('%s selector never throws and never queries on malformed ids', async (_label, selector) => {
    for (const raw of ['abc', '-1', '0', '', undefined, null, '1.5']) {
      await expect(selector({ tenantId: TENANT }, raw)).resolves.toBeNull();
    }
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });
});

describe('dialysis selectors', () => {
  it('roster selector resolves dialysis_patients by id with a tenant predicate', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    await expect(selectDialysisRosterPatient({ tenantId: TENANT }, '12')).resolves.toEqual({ uid: PATIENT_UID });
    const [sql, tenantParam, idParam] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/FROM dialysis_patients/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(tenantParam).toBe(TENANT);
    expect(idParam).toBe(12);
  });

  it('session selector joins dialysis_patients exactly like getDialysisSessionInTenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    await expect(selectDialysisSessionPatient({ tenantId: TENANT }, '8')).resolves.toEqual({ uid: PATIENT_UID });
    const [sql, tenantParam, idParam] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/FROM dialysis_sessions s/);
    expect(sql).toMatch(/JOIN dialysis_patients p/);
    expect(sql).toMatch(/p\.tenant_id = s\.tenant_id/);
    expect(sql).toMatch(/s\.tenant_id = \$1::uuid AND s\.id = \$2::int/);
    expect(tenantParam).toBe(TENANT);
    expect(idParam).toBe(8);
  });

  it('vascular-access selector tenant-scopes through the roster join like getAccessInTenant', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    await expect(selectVascularAccessPatient({ tenantId: TENANT }, '3')).resolves.toEqual({ uid: PATIENT_UID });
    const [sql, tenantParam, idParam] = queryRawUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/FROM vascular_access va/);
    expect(sql).toMatch(/JOIN dialysis_patients p/);
    expect(sql).toMatch(/p\.tenant_id = \$1::uuid/);
    expect(tenantParam).toBe(TENANT);
    expect(idParam).toBe(3);
  });

  it.each([
    ['roster', selectDialysisRosterPatient],
    ['session', selectDialysisSessionPatient],
    ['vascular access', selectVascularAccessPatient],
  ])('%s selector never throws and never queries on malformed ids', async (_label, selector) => {
    for (const raw of ['abc', '-1', '0', '', undefined, null, '9000090011']) {
      await expect(selector({ tenantId: TENANT }, raw)).resolves.toBeNull();
    }
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('selectors resolve null for a row missing in the tenant and propagate DB failures', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([]);
    await expect(selectDialysisRosterPatient({ tenantId: TENANT }, '12')).resolves.toBeNull();
    queryRawUnsafeMock.mockRejectedValueOnce(new Error('connection down'));
    await expect(selectDialysisRosterPatient({ tenantId: TENANT }, '12')).rejects.toThrow('connection down');
  });
});
