// src/tests/labPathologyNursingRouteGuards.test.js
//
// Re-audit M (mount guards): the LAB_RESULT / PATHOLOGY / NURSING_ASSESSMENT
// patientAccessGuard used to sit on the app.js mounts. A mount-level
// middleware runs before Express matches the route, so req.params was always
// empty there; routes that identify their patient only through a path param
// (or a resource id such as an investigation/result/alert/specimen/case) were
// authorised as no_patient_context WITHOUT a policy decision — in shadow AND
// in enforce. The guard now runs per route with selectors that resolve the
// row the handler serves (pattern: bcmaRoutes guardWristbandView,
// abdmHiuRoutes selector factories).
//
// Pure unit pins, no database:
//   (a) each selector resolves the subject from the identifier its handler
//       uses, with an explicit tenant predicate (prisma is stubbed and the
//       SQL + bind params are asserted);
//   (b) every single-subject route carries patientAccessGuardMiddleware in
//       its middleware chain;
//   (c) list/queue/pure-compute routes are NOT patient-context-forced;
//   (d) the result-release selector NEVER throws — selector errors return
//       null so the guard refuses cleanly instead of 500ing the critical
//       result-release write path.

import { jest } from '@jest/globals';

const TENANT = 'aaaa0000-0000-4000-8000-000000000001';
const PATIENT_UID = 'aaaa0000-0000-4000-8000-000000000101';

// ── Prisma stub ─────────────────────────────────────────────────────────────
// Selectors are the only code under test that touches the DB; stub the raw
// query surface and record every call. Everything else on the client is
// proxied through untouched (and never invoked by these tests).
const queryRawMock = jest.fn(async () => []);
const executeRawMock = jest.fn(async () => 0);

const actualPrismaModule = await import('../lib/prisma.js');
const prismaStub = new Proxy(actualPrismaModule.default, {
  get(target, prop, receiver) {
    if (prop === '$queryRawUnsafe') return queryRawMock;
    if (prop === '$executeRawUnsafe') return executeRawMock;
    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

jest.unstable_mockModule('../lib/prisma.js', () => ({
  ...actualPrismaModule,
  default: prismaStub,
}));

const { default: labRouter, __patientAccessSelectors: labSelectors } =
  await import('../routes/lab/labRoutes.js');
const { default: releaseRouter, __patientAccessSelectors: releaseSelectors } =
  await import('../routes/lab/resultReleaseRoutes.js');
const { default: pathologyRouter, __patientAccessSelectors: pathologySelectors } =
  await import('../routes/pathology/pathologyRoutes.js');
const { default: nursingRouter, __patientAccessSelectors: nursingSelectors } =
  await import('../routes/clinical/nursingAssessmentRoutes.js');

const GUARD_NAME = 'patientAccessGuardMiddleware';

function routeChain(router, method, path) {
  const layer = (router.stack ?? []).find(
    (l) => l.route?.path === path && l.route?.methods?.[method],
  );
  if (!layer) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle.name);
}

function req({ params = {}, body = {}, tenantId = TENANT } = {}) {
  return { tenantId, params, body };
}

beforeEach(() => {
  queryRawMock.mockClear();
  executeRawMock.mockClear();
  queryRawMock.mockImplementation(async () => []);
});

// ── (b)/(c) middleware chains ───────────────────────────────────────────────

describe('route middleware chains carry the per-route guard', () => {
  const guarded = [
    [releaseRouter, 'patch', '/:id/hold'],
    [releaseRouter, 'post', '/:id/release-now'],
    [labRouter, 'post', '/orders'],
    [labRouter, 'post', '/samples/:investigationId/collect'],
    [labRouter, 'get', '/samples/barcode/:barcode'],
    [labRouter, 'get', '/samples/:investigationId/barcode'],
    [labRouter, 'post', '/samples/:investigationId/reject'],
    [labRouter, 'post', '/results'],
    [labRouter, 'get', '/results/booking/:bookingId'],
    [labRouter, 'get', '/results/patient/:patientUid'],
    [labRouter, 'post', '/pathologist/signoff'],
    [labRouter, 'post', '/alerts/critical/:id/ack'],
    [labRouter, 'get', '/specimens/:id/label'],
    [labRouter, 'post', '/specimens/receive-scan'],
    [pathologyRouter, 'post', '/cases'],
    [pathologyRouter, 'get', '/cases/:id'],
    [pathologyRouter, 'post', '/cases/:id/gross'],
    [pathologyRouter, 'post', '/cases/:id/blocks'],
    [pathologyRouter, 'post', '/blocks/:id/slides'],
    [pathologyRouter, 'put', '/cases/:id/report'],
    [pathologyRouter, 'post', '/reports/:id/sign-off'],
    [pathologyRouter, 'post', '/reports/:id/addenda'],
    [nursingRouter, 'post', '/'],
    [nursingRouter, 'get', '/patient/:uid'],
  ];

  it.each(guarded.map(([router, method, path]) => [method, path, router]))(
    'guards %s %s',
    (method, path, router) => {
      expect(routeChain(router, method, path)).toContain(GUARD_NAME);
    },
  );

  const unguarded = [
    [labRouter, 'get', '/worklist'],
    [labRouter, 'get', '/worklist/ipd'],
    [labRouter, 'get', '/pathologist/pending'],
    [labRouter, 'get', '/alerts/critical'],
    [labRouter, 'get', '/interface/messages'],
    [pathologyRouter, 'get', '/worklist'],
    [pathologyRouter, 'get', '/tat-metrics'],
    [nursingRouter, 'post', '/score'],
    [nursingRouter, 'get', '/dashboard/overdue-or-high-risk'],
  ];

  it.each(unguarded.map(([router, method, path]) => [method, path, router]))(
    'deliberately does NOT patient-context-force %s %s',
    (method, path, router) => {
      expect(routeChain(router, method, path)).not.toContain(GUARD_NAME);
    },
  );

  it('runs the guard before the idempotency claim on manual entry and signoff', () => {
    for (const [method, path] of [['post', '/results'], ['post', '/pathologist/signoff']]) {
      const chain = routeChain(labRouter, method, path);
      const guardAt = chain.indexOf(GUARD_NAME);
      const idempotencyAt = chain.indexOf('idempotencyMiddleware');
      expect(guardAt).toBeGreaterThanOrEqual(0);
      expect(idempotencyAt).toBeGreaterThan(guardAt);
    }
  });
});

// ── (a) selector resolution ─────────────────────────────────────────────────

describe('lab selectors resolve the row the handler serves, tenant-scoped', () => {
  it('investigation selector resolves patient by investigation id within the tenant', async () => {
    queryRawMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    const out = await labSelectors.investigationPatientOf(
      req({ params: { investigationId: '42' } }),
    );
    expect(out).toEqual({ uid: PATIENT_UID });
    expect(queryRawMock).toHaveBeenCalledTimes(1);
    const [sql, ...params] = queryRawMock.mock.calls[0];
    expect(sql).toMatch(/FROM investigations/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(sql).toMatch(/id = \$2::int/);
    expect(params).toEqual([TENANT, 42]);
  });

  it('investigation selector refuses malformed ids without querying', async () => {
    for (const bad of ['abc', '-3', '0', '99999999999999999', undefined]) {
      expect(await labSelectors.investigationPatientOf(
        req({ params: { investigationId: bad } }),
      )).toBeNull();
    }
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it('sample barcode selector matches the service normalisation (trim, 40-char cap) within the tenant', async () => {
    queryRawMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    const longBarcode = `  ${'B'.repeat(60)}  `;
    const out = await labSelectors.sampleBarcodePatientOf(
      req({ params: { barcode: longBarcode } }),
    );
    expect(out).toEqual({ uid: PATIENT_UID });
    const [sql, ...params] = queryRawMock.mock.calls[0];
    expect(sql).toMatch(/FROM investigations/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(sql).toMatch(/sample_barcode = \$2/);
    expect(params).toEqual([TENANT, 'B'.repeat(40)]);
    expect(await labSelectors.sampleBarcodePatientOf(req({ params: { barcode: '   ' } }))).toBeNull();
  });

  it('order selector mirrors the handler body identifiers (patient_id / patient_uid)', () => {
    expect(labSelectors.orderBodyPatientOf(req({ body: { patient_uid: PATIENT_UID } })))
      .toEqual({ id: undefined, uid: PATIENT_UID });
    expect(labSelectors.orderBodyPatientOf(req({ body: { patient_id: 7 } })))
      .toEqual({ id: 7, uid: undefined });
    expect(labSelectors.orderBodyPatientOf(req({ body: {} }))).toBeNull();
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it('manual-result selector requires body.patient_uid like recordResultManual', () => {
    expect(labSelectors.manualResultPatientOf(req({ body: { patient_uid: PATIENT_UID } })))
      .toEqual({ uid: PATIENT_UID });
    expect(labSelectors.manualResultPatientOf(req({ body: {} }))).toBeNull();
  });

  it('booking selector resolves through the BOOKING row, so a booking with no results yet still decides', async () => {
    // Repinned (lane M review, F1): the old selector read DISTINCT patient_uid
    // FROM lab_results, so a booking in its normal pre-processing state — no
    // result rows yet — returned null and enforce mode 403'd a request the
    // handler answers with an empty list. The booking itself names exactly one
    // patient; the guard decides on that patient whether results exist or not.
    queryRawMock.mockResolvedValueOnce([{ id: 51, uid: PATIENT_UID }]);
    const out = await labSelectors.bookingResultsPatientOf(req({ params: { bookingId: '9' } }));
    expect(out).toEqual({ id: 51, uid: PATIENT_UID });
    const [sql, ...params] = queryRawMock.mock.calls[0];
    expect(sql).toMatch(/FROM investigation_bookings b/);
    expect(sql).toMatch(/JOIN users p/);
    expect(sql).toMatch(/p\.role = 'PATIENT'/);
    expect(sql).toMatch(/b\.tenant_id = \$1::uuid/);
    expect(sql).toMatch(/b\.id = \$2::int/);
    expect(params).toEqual([TENANT, 9]);

    // Unknown booking: refuse (null), never guess.
    queryRawMock.mockResolvedValueOnce([]);
    expect(await labSelectors.bookingResultsPatientOf(req({ params: { bookingId: '9' } }))).toBeNull();
  });

  it('patient-results selector passes the :patientUid path param through', () => {
    expect(labSelectors.resultsPatientParamOf(req({ params: { patientUid: PATIENT_UID } })))
      .toEqual({ uid: PATIENT_UID });
  });

  it('signoff selector resolves the single distinct patient of the tenant-owned result_ids', async () => {
    queryRawMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    const out = await labSelectors.signoffResultsPatientOf(
      req({ body: { result_ids: [3, 9, 3] } }),
    );
    expect(out).toEqual({ uid: PATIENT_UID });
    const [sql, ...params] = queryRawMock.mock.calls[0];
    expect(sql).toMatch(/SELECT DISTINCT patient_uid/);
    expect(sql).toMatch(/FROM lab_results/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(sql).toMatch(/id = ANY\(\$2::int\[\]\)/);
    expect(params).toEqual([TENANT, [3, 9, 3]]);
  });

  it('signoff selector refuses malformed id sets without querying, and mixed-patient sets', async () => {
    expect(await labSelectors.signoffResultsPatientOf(req({ body: {} }))).toBeNull();
    expect(await labSelectors.signoffResultsPatientOf(req({ body: { result_ids: [] } }))).toBeNull();
    expect(await labSelectors.signoffResultsPatientOf(
      req({ body: { result_ids: ['abc'] } }),
    )).toBeNull();
    expect(await labSelectors.signoffResultsPatientOf(
      req({ body: { result_ids: [1, 2147483648] } }),
    )).toBeNull();
    expect(queryRawMock).not.toHaveBeenCalled();

    queryRawMock.mockResolvedValueOnce([{ uid: PATIENT_UID }, { uid: 'other' }]);
    expect(await labSelectors.signoffResultsPatientOf(
      req({ body: { result_ids: [1, 2] } }),
    )).toBeNull();
  });

  it('critical-alert ack selector resolves the alert patient within the tenant', async () => {
    queryRawMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    const out = await labSelectors.criticalAlertPatientOf(req({ params: { id: '5' } }));
    expect(out).toEqual({ uid: PATIENT_UID });
    const [sql, ...params] = queryRawMock.mock.calls[0];
    expect(sql).toMatch(/FROM lab_critical_alerts/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(params).toEqual([TENANT, 5]);
    expect(await labSelectors.criticalAlertPatientOf(req({ params: { id: 'x' } }))).toBeNull();
  });

  it('specimen selectors resolve by id and by case-insensitive barcode within the tenant', async () => {
    queryRawMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    expect(await labSelectors.specimenPatientOf(req({ params: { id: '11' } })))
      .toEqual({ uid: PATIENT_UID });
    let [sql, ...params] = queryRawMock.mock.calls[0];
    expect(sql).toMatch(/FROM lab_specimens/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(params).toEqual([TENANT, 11]);

    queryRawMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    expect(await labSelectors.specimenScanPatientOf(req({ body: { barcode: ' acc-1 ' } })))
      .toEqual({ uid: PATIENT_UID });
    [sql, ...params] = queryRawMock.mock.calls[1];
    expect(sql).toMatch(/FROM lab_specimens/);
    expect(sql).toMatch(/UPPER\(barcode\) = UPPER\(\$2\)/);
    expect(params).toEqual([TENANT, 'acc-1']);
    expect(await labSelectors.specimenScanPatientOf(req({ body: {} }))).toBeNull();
  });
});

describe('result-release selector (critical release path)', () => {
  it('resolves the patient behind the lab_results row being held/released, tenant-scoped', async () => {
    queryRawMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    const out = await releaseSelectors.releaseResultPatientSelector(
      req({ params: { id: '77' } }),
    );
    expect(out).toEqual({ uid: PATIENT_UID });
    const [sql, ...params] = queryRawMock.mock.calls[0];
    expect(sql).toMatch(/FROM lab_results/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(sql).toMatch(/id = \$2::int/);
    expect(params).toEqual([TENANT, 77]);
  });

  it('returns null on malformed ids without querying', async () => {
    for (const bad of ['abc', '0', '-1', '2147483648', undefined]) {
      expect(await releaseSelectors.releaseResultPatientSelector(
        req({ params: { id: bad } }),
      )).toBeNull();
    }
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it('NEVER throws — a failing lookup returns null instead of 500ing the release path', async () => {
    queryRawMock.mockRejectedValueOnce(new Error('connection reset'));
    await expect(releaseSelectors.releaseResultPatientSelector(
      req({ params: { id: '77' } }),
    )).resolves.toBeNull();
    // Missing tenant context is also swallowed into a null (guard then
    // refuses via requirePatientContext) rather than thrown.
    await expect(releaseSelectors.releaseResultPatientSelector(
      { params: { id: '77' } },
    )).resolves.toBeNull();
  });
});

describe('pathology selectors resolve through the case the handler serves', () => {
  it('case selector reads ap_cases by id within the tenant', async () => {
    queryRawMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    expect(await pathologySelectors.apCasePatientOf(req({ params: { id: '12' } })))
      .toEqual({ uid: PATIENT_UID });
    const [sql, ...params] = queryRawMock.mock.calls[0];
    expect(sql).toMatch(/FROM ap_cases/);
    expect(sql).toMatch(/tenant_id = \$1::uuid/);
    expect(sql).toMatch(/id = \$2::bigint/);
    expect(params).toEqual([TENANT, 12]);
    expect(await pathologySelectors.apCasePatientOf(req({ params: { id: 'nope' } }))).toBeNull();
  });

  it('block selector joins block → case the way createSlide does', async () => {
    queryRawMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    expect(await pathologySelectors.apBlockPatientOf(req({ params: { id: '3' } })))
      .toEqual({ uid: PATIENT_UID });
    const [sql, ...params] = queryRawMock.mock.calls[0];
    expect(sql).toMatch(/FROM ap_blocks b/);
    expect(sql).toMatch(/JOIN ap_cases c ON c\.id = b\.ap_case_id AND c\.tenant_id = b\.tenant_id/);
    expect(sql).toMatch(/b\.tenant_id = \$1::uuid/);
    expect(params).toEqual([TENANT, 3]);
  });

  it('report selector joins report → case the way signOffReport does', async () => {
    queryRawMock.mockResolvedValueOnce([{ uid: PATIENT_UID }]);
    expect(await pathologySelectors.apReportPatientOf(req({ params: { id: '4' } })))
      .toEqual({ uid: PATIENT_UID });
    const [sql, ...params] = queryRawMock.mock.calls[0];
    expect(sql).toMatch(/FROM ap_reports r/);
    expect(sql).toMatch(/JOIN ap_cases c ON c\.id = r\.ap_case_id AND c\.tenant_id = r\.tenant_id/);
    expect(sql).toMatch(/r\.tenant_id = \$1::uuid/);
    expect(params).toEqual([TENANT, 4]);
  });

  it('case-create selector mirrors the service body fallback (patient_uid, then patientUid)', () => {
    expect(pathologySelectors.apCaseCreateBodyPatientOf(
      req({ body: { patient_uid: PATIENT_UID } }),
    )).toEqual({ uid: PATIENT_UID });
    expect(pathologySelectors.apCaseCreateBodyPatientOf(
      req({ body: { patientUid: PATIENT_UID } }),
    )).toEqual({ uid: PATIENT_UID });
    expect(pathologySelectors.apCaseCreateBodyPatientOf(req({ body: {} }))).toBeNull();
  });
});

describe('nursing assessment selectors', () => {
  it('write selector reads only the snake-case patient_uid recordAssessment destructures', () => {
    expect(nursingSelectors.assessmentBodyPatientOf(
      req({ body: { patient_uid: PATIENT_UID } }),
    )).toEqual({ uid: PATIENT_UID });
    // recordAssessment does NOT read camelCase patientUid, so neither does
    // the selector — the guard must not authorise an identifier the service
    // would reject as missing.
    expect(nursingSelectors.assessmentBodyPatientOf(
      req({ body: { patientUid: PATIENT_UID } }),
    )).toBeNull();
    expect(nursingSelectors.assessmentBodyPatientOf(req({ body: {} }))).toBeNull();
  });

  it('read selector passes the :uid path param through to the resolver', () => {
    expect(nursingSelectors.assessmentParamPatientOf(req({ params: { uid: PATIENT_UID } })))
      .toEqual({ uid: PATIENT_UID });
  });
});
