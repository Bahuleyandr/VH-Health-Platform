/**
 * Order placement and the open-order window, driven through the REAL
 * orderMissingLabs / refreshCaseLabReadiness against a stub client.
 *
 * The sibling suite (cathLabReadinessService.test.js) pins the pure resolver
 * and the pure validators. This one exists for the three behaviours that only
 * appear once the service is actually run end to end:
 *
 *   - the failure error a half-placed order set raises (its code, and which
 *     codes already reached the lab),
 *   - the priority the orders are placed at, which comes off the case's urgency,
 *   - open_order_codes, which must honour the SAME per-item freshness window
 *     the resolver does or a long-stale order both fails to be evidence and
 *     blocks the re-order that would produce some,
 *   - the two waiver actions, whose whole content is the order of their
 *     guards against a locked case row, the statements they then write, and
 *     the recorded_after_start / lifted_after_start marks they take off it.
 *
 * The stub answers each statement by its FROM target rather than by call order,
 * so reordering the reads inside the service does not silently feed one query
 * another's rows.
 */

import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-0000000c1b00';
const PATIENT = '00000000-0000-4000-8000-0000000c1b01';
const ACTOR = '00000000-0000-4000-8000-0000000c1baa';
const CASE_ID = 77;

const createInvestigationOrderMock = jest.fn();

let stubRows = {};
/** Every `$executeRawUnsafe` the service issued, in order. */
let executed = [];

/**
 * The two waiver statements, modelled in memory.
 *
 * Both the waiver guard and the refresh read `cath_case_lab_readiness_items`,
 * so a stub that answered the same fixed rows to both would show the refresh a
 * waiver the statement under test has just cleared — and the assertion would be
 * about the fixture rather than the service. Applying the two writes to
 * `stubRows.items` is what lets the refresh see what it would really see.
 */
function applyItemWrite(sql, params) {
  const item = params[2];
  if (/INSERT INTO cath_case_lab_readiness_items/.test(sql) && /'waived', 'waiver'/.test(sql)) {
    stubRows.items = [
      ...stubRows.items.filter((row) => row.item_code !== item),
      {
        item_code: item,
        required: true,
        state: 'waived',
        waived_by: params[3],
        waived_at: new Date().toISOString(),
        waive_reason: params[4],
        source: 'waiver',
      },
    ];
    return;
  }
  if (/UPDATE cath_case_lab_readiness_items/.test(sql) && /waive_reason = NULL/.test(sql)) {
    stubRows.items = stubRows.items.map((row) => (row.item_code === item
      ? {
        ...row, state: 'not_ordered', source: null, waived_by: null, waived_at: null, waive_reason: null,
      }
      : row));
  }
}

function stubClient() {
  return {
    $queryRawUnsafe: async (sql) => {
      // users FIRST: orderMissingLabs resolves the patient with
      // `FROM users u JOIN cath_lab_cases c`, which the cath_lab_cases pattern
      // below would otherwise never see.
      if (/FROM users/.test(sql)) return stubRows.patient;
      if (/FROM cath_lab_cases/.test(sql)) return stubRows.cathCase;
      if (/FROM cath_lab_readiness_settings/.test(sql)) return [];
      if (/FROM cath_reprocessing_settings/.test(sql)) return [];
      if (/FROM lab_results/.test(sql)) return stubRows.results;
      if (/FROM investigation_bookings/.test(sql)) return stubRows.bookings;
      if (/FROM investigations/.test(sql)) return stubRows.orders;
      if (/FROM lab_specimens/.test(sql)) return [];
      if (/FROM cath_case_lab_readiness_items/.test(sql)) return stubRows.items;
      if (/FROM cath_lab_readiness_checks/.test(sql)) return stubRows.checks;
      throw new Error(`unstubbed query: ${sql.slice(0, 120)}`);
    },
    $executeRawUnsafe: async (sql, ...params) => {
      executed.push({ sql, params });
      applyItemWrite(sql, params);
      return 1;
    },
  };
}

const prismaMock = {
  $queryRawUnsafe: (...args) => stubClient().$queryRawUnsafe(...args),
  $executeRawUnsafe: async () => 1,
  $transaction: jest.fn(),
  $on: jest.fn(),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  __esModule: true,
  default: prismaMock,
  prismaReadOnly: prismaMock,
  setTenant: (_tenantId, fn) => fn(stubClient()),
  setTenantTx: (_tenantId, fn) => fn(stubClient()),
  isTenantTransactionClient: () => false,
  tenantRlsRuntimeRole: () => null,
  ensureTenantRlsRuntimeRoleGrants: async () => {},
}));

jest.unstable_mockModule('../../services/investigation/orderService.js', () => ({
  createInvestigationOrder: createInvestigationOrderMock,
}));

// The readiness service statically imports these two for the outside-result
// path; stubbing the boundary keeps the module graph (and the suite) small,
// and the lab rail mock is what the idempotency-key block below inspects.
const recordExternalLabResultRowMock = jest.fn();
const recordMarkersMock = jest.fn();

jest.unstable_mockModule('../../services/lab/labResultsService.js', () => ({
  recordExternalLabResultRow: recordExternalLabResultRowMock,
}));
jest.unstable_mockModule('../../services/clinical/bloodborneMarkerService.js', () => ({
  recordMarkers: recordMarkersMock,
}));

const {
  orderMissingLabs,
  recordExternalLabResult,
  refreshCaseLabReadiness,
  unwaiveLabItem,
  waiveLabItem,
} = await import('../../services/clinical/cathLabReadinessService.js');

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
// Postgres always returns the `<col>_epoch_ms` twin beside a twinned column and
// the resolver prefers it over the driver-materialised Date
// (src/utils/dbInstant.js). Derive the twin from the same ISO string the row
// carries so both describe one instant.
const epochOf = (iso) => (iso == null ? null : BigInt(Date.parse(iso)));

const CASE_ROW = {
  id: BigInt(CASE_ID),
  tenant_id: TENANT,
  patient_uid: PATIENT,
  encounter_id: null,
  facility_id: 1,
  status: 'scheduled',
  urgency: 'elective',
  actual_start_at: null,
};

beforeEach(() => {
  executed = [];
  createInvestigationOrderMock.mockReset();
  recordExternalLabResultRowMock.mockReset();
  recordMarkersMock.mockReset();
  stubRows = {
    cathCase: [CASE_ROW],
    patient: [{ id: 501, urgency: 'elective' }],
    results: [],
    orders: [],
    bookings: [],
    items: [],
    checks: [],
  };
});

const ctx = { actorUid: ACTOR, actorRole: 'DOCTOR' };

describe('orderMissingLabs failure reporting', () => {
  test('a half-placed order set raises CATH_LAB_READINESS_ORDER_FAILED naming what already reached the lab', async () => {
    createInvestigationOrderMock
      .mockResolvedValueOnce({ investigation: { id: 900 } })
      .mockRejectedValueOnce(Object.assign(new Error('lab down'), { code: 'P2002' }));

    const failure = await orderMissingLabs(CASE_ID, { tenantId: TENANT }, ctx)
      .then(() => null, (err) => err);

    // AppError.internal takes (message, code) and nothing else — passing a
    // details object as a third argument dropped it AND left the code as the
    // default INTERNAL_ERROR, so the ward saw neither.
    expect(failure).toMatchObject({
      statusCode: 500,
      code: 'CATH_LAB_READINESS_ORDER_FAILED',
    });
    expect(failure.details).toMatchObject({ code: 'ELECTROLYTES', cause: 'P2002' });
    // CBC is already on the lab's worklist; re-running order-missing must not
    // place it twice, and the caller can only know that from here.
    expect(failure.details.created).toEqual(['CBC']);
  });
});

describe('order priority follows the case urgency', () => {
  test.each([
    ['emergency', 'STAT'],
    ['urgent', 'URGENT'],
    ['elective', 'NORMAL'],
  ])('a %s case places its bloods at %s', async (urgency, expected) => {
    stubRows.patient = [{ id: 501, urgency }];
    createInvestigationOrderMock.mockResolvedValue({ investigation: { id: 901 } });

    await orderMissingLabs(CASE_ID, { tenantId: TENANT }, ctx);

    expect(createInvestigationOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({ priority: expected, type: 'LAB' }),
    );
    for (const call of createInvestigationOrderMock.mock.calls) {
      expect(call[0].priority).toBe(expected);
    }
  });
});

describe('open_order_codes honours the per-item window', () => {
  // 60 days old against hb's 30-day validity window: the resolver will not
  // treat it as an open order, so neither may open_order_codes. Counting it
  // there left hb `not_ordered` AND refused to re-order it — a case the
  // checklist could never make ready.
  const staleOrder = () => {
    const requestedAt = daysAgo(60);
    return [{
      id: 61,
      test_code: 'CBC',
      status: 'REQUESTED',
      requested_at: requestedAt,
      requested_at_epoch_ms: epochOf(requestedAt),
      collected_at: null,
      collected_at_epoch_ms: null,
      booking_id: null,
    }];
  };

  test('an order older than the window is neither evidence nor a block', async () => {
    stubRows.orders = staleOrder();

    const out = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx });

    expect(out.items.find((item) => item.item_code === 'hb').state).toBe('not_ordered');
    expect(out.orderable_now).toContain('CBC');
    expect(out.open_order_codes).not.toContain('CBC');
  });

  test('an order inside the window still counts, and still blocks', async () => {
    // The twin, not the Date, is what the resolver reads, so the override has
    // to move both: leaving the 60-day twin in place would keep this order
    // outside the window and quietly invert the assertion below.
    const requestedAt = daysAgo(2);
    stubRows.orders = [{
      ...staleOrder()[0],
      requested_at: requestedAt,
      requested_at_epoch_ms: epochOf(requestedAt),
    }];

    const out = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx });

    expect(out.items.find((item) => item.item_code === 'hb').state)
      .toBe('ordered_awaiting_sample');
    expect(out.open_order_codes).toContain('CBC');
    expect(out.orderable_now).not.toContain('CBC');
  });

  test('order-missing places the CBC the stale order was blocking', async () => {
    stubRows.orders = staleOrder();
    createInvestigationOrderMock.mockResolvedValue({ investigation: { id: 902 } });

    const out = await orderMissingLabs(CASE_ID, { tenantId: TENANT }, ctx);

    expect(out.created.map((row) => row.code)).toContain('CBC');
    expect(out.skipped).toEqual([]);
  });
});

// The router's contextOf comment promises that an hiv/hbsag/hcv trio sent
// under ONE Idempotency-Key becomes three distinct lab commands. It only does
// so because the key handed to the lab rail carries the item code: the rail
// keys on (tenant_id, actor_uid, command_scope, command_key), so the bare
// header would make the second item collide with the first and answer
// LAB_RESULT_COMMAND_BODY_MISMATCH.
describe('outside-result entries key the lab rail per item', () => {
  const serology = (item, ref) => recordExternalLabResult(CASE_ID, item, {
    tenantId: TENANT,
    value_text: 'non-reactive',
    observed_on: '2026-09-01',
    external_lab_name: 'Outside Lab',
    external_report_ref: ref,
  }, { ...ctx, idempotencyKey: 'ward-key-1' });

  const keyOf = (call) => call[1].idempotencyKey;

  beforeEach(() => {
    recordExternalLabResultRowMock.mockImplementation(async () => ({ result: { id: 4242 } }));
  });

  test('the caller key reaches the rail suffixed with the item code', async () => {
    await serology('hiv', 'R-1');

    expect(recordExternalLabResultRowMock).toHaveBeenCalledTimes(1);
    expect(keyOf(recordExternalLabResultRowMock.mock.calls[0])).toBe('ward-key-1:hiv');
  });

  test('two items under one key become two different commands', async () => {
    await serology('hiv', 'R-1');
    await serology('hbsag', 'R-2');

    const keys = recordExternalLabResultRowMock.mock.calls.map(keyOf);
    expect(keys).toEqual(['ward-key-1:hiv', 'ward-key-1:hbsag']);
    expect(new Set(keys).size).toBe(2);
  });

  test('the same item under the same key still replays: one unchanged key', async () => {
    await serology('hcv', 'R-3');
    await serology('hcv', 'R-3');

    const keys = recordExternalLabResultRowMock.mock.calls.map(keyOf);
    expect(keys).toEqual(['ward-key-1:hcv', 'ward-key-1:hcv']);
    // The body hash is the rail's content fingerprint, and it is the same on
    // both calls — key AND hash unchanged is what makes the second a replay
    // rather than a BODY_MISMATCH.
    const hashes = recordExternalLabResultRowMock.mock.calls.map((call) => call[1].requestBodySha256);
    expect(hashes[0]).toBe(hashes[1]);
  });

  test('with no caller key the content-derived fallback still names the item', async () => {
    await recordExternalLabResult(CASE_ID, 'creatinine', {
      tenantId: TENANT,
      value_numeric: 1.1,
      unit: 'mg/dL',
      observed_on: '2026-09-01',
      external_lab_name: 'Outside Lab',
      external_report_ref: 'R-4',
    }, ctx);

    expect(keyOf(recordExternalLabResultRowMock.mock.calls[0]))
      .toMatch(/^cath-readiness-ext:\d+:creatinine:[0-9a-f]{32}$/);
  });

  // command_key is rejected above 200 characters, so the suffix has to be
  // budgeted rather than appended to an already-capped key.
  test('a caller key at the rail limit leaves room for the suffix', async () => {
    await recordExternalLabResult(CASE_ID, 'creatinine', {
      tenantId: TENANT,
      value_numeric: 1.1,
      unit: 'mg/dL',
      observed_on: '2026-09-01',
      external_lab_name: 'Outside Lab',
      external_report_ref: 'R-5',
    }, { ...ctx, idempotencyKey: 'k'.repeat(400) });

    const key = keyOf(recordExternalLabResultRowMock.mock.calls[0]);
    expect(key.endsWith(':creatinine')).toBe(true);
    expect(key.length).toBeLessThanOrEqual(200);
  });
});

describe('the waiver pair marks a late decision and guards the stored state', () => {
  // A start that is already in the PAST when the waiver statement runs, so
  // `waived_at > actual_start_at` is a fact about the fixture rather than a
  // race against the millisecond the two share.
  const startedCase = () => [{
    ...CASE_ROW,
    actual_start_at: new Date(Date.now() - 60_000).toISOString(),
  }];
  const auditActions = () => executed
    .filter((entry) => /INSERT INTO audit_logs/.test(entry.sql))
    .map((entry) => entry.params[3]);
  const itemWrites = () => executed.filter(
    (entry) => /(INSERT INTO|UPDATE) cath_case_lab_readiness_items/.test(entry.sql),
  );

  // OWNER DECISION, 2026-09-06: the pre-cath checklist is not restrictive. An
  // emergency team already at the table is exactly the team that has to record
  // "proceeding without HCV", so the waiver is ACCEPTED and marked, not
  // refused. These two tests are the inverse of the ones they replace.
  test('waive after the case has started is accepted and marked recorded_after_start', async () => {
    stubRows.cathCase = startedCase();

    const after = await waiveLabItem(
      CASE_ID, 'hcv', { tenantId: TENANT, reason: 'emergency PCI, no report yet' }, ctx,
    );

    expect(auditActions()).toContain('cath_lab.readiness.labs.item_waived');
    const audit = executed.find((entry) => /INSERT INTO audit_logs/.test(entry.sql));
    expect(JSON.parse(audit.params[6])).toMatchObject({
      item: 'hcv',
      reason: 'emergency PCI, no report yet',
      recorded_after_start: true,
    });
    // The waiver really landed — a mark on an unwritten row would be the worst
    // of both.
    expect(stubRows.items.find((row) => row.item_code === 'hcv').state).toBe('waived');
    // ...and the same fact reaches the ward on the item, derived from waived_at
    // against the case's actual_start_at rather than stored beside them.
    expect(after.items.find((row) => row.item_code === 'hcv')).toMatchObject({
      state: 'waived',
      recorded_after_start: true,
    });
  });

  test('waive before the case starts writes the item, the audit row and no late mark', async () => {
    const after = await waiveLabItem(
      CASE_ID, 'hcv', { tenantId: TENANT, reason: 'on file elsewhere' }, ctx,
    );

    expect(auditActions()).toContain('cath_lab.readiness.labs.item_waived');
    expect(stubRows.items.find((row) => row.item_code === 'hcv').state).toBe('waived');
    const audit = executed.find((entry) => /INSERT INTO audit_logs/.test(entry.sql));
    expect(JSON.parse(audit.params[6])).toMatchObject({ recorded_after_start: false });
    // The marker is an ASSERTION that a waiver was documented late; an ordinary
    // pre-procedure waiver must not carry it.
    expect(after.items.find((row) => row.item_code === 'hcv').recorded_after_start).toBe(false);
  });

  test('unwaive after the case has started is accepted and audited lifted_after_start', async () => {
    await waiveLabItem(CASE_ID, 'hcv', { tenantId: TENANT, reason: 'on file elsewhere' }, ctx);
    executed = [];
    stubRows.cathCase = startedCase();

    const after = await unwaiveLabItem(
      CASE_ID, 'hcv', { tenantId: TENANT, reason: 'the report arrived mid-case' }, ctx,
    );

    const audit = executed.find((entry) => /INSERT INTO audit_logs/.test(entry.sql));
    expect(audit.params[3]).toBe('cath_lab.readiness.labs.unwaived');
    expect(JSON.parse(audit.params[6])).toMatchObject({
      item: 'hcv',
      reason: 'the report arrived mid-case',
      previous_reason: 'on file elsewhere',
      lifted_after_start: true,
    });
    // The lift really happened: the report that turns up mid-procedure is the
    // reason a waiver comes off, and refusing it would leave the record saying
    // the team proceeded blind when it did not.
    expect(stubRows.items.find((row) => row.item_code === 'hcv')).toMatchObject({
      waived_by: null, waived_at: null, waive_reason: null,
    });
    expect(after.items.find((row) => row.item_code === 'hcv').state).toBe('not_ordered');
  });

  test('unwaive refuses an item that carries no waiver, and writes nothing', async () => {
    await expect(unwaiveLabItem(CASE_ID, 'hcv', { tenantId: TENANT }, ctx))
      .rejects.toMatchObject({ statusCode: 409, code: 'CATH_LAB_READINESS_NOT_WAIVED' });
    expect(itemWrites()).toEqual([]);
    expect(auditActions()).toEqual([]);
  });

  test('unwaive refuses an item resolved from evidence rather than waived', async () => {
    stubRows.items = [{
      item_code: 'hcv', required: true, state: 'result_final', source: 'lab_result',
      waived_by: null, waived_at: null, waive_reason: null,
    }];

    await expect(unwaiveLabItem(CASE_ID, 'hcv', { tenantId: TENANT }, ctx))
      .rejects.toMatchObject({ code: 'CATH_LAB_READINESS_NOT_WAIVED' });
  });

  test('unwaive clears the waiver, audits the reason it withdrew, and re-resolves the item', async () => {
    await waiveLabItem(
      CASE_ID, 'hcv', { tenantId: TENANT, reason: 'repeat on file elsewhere' }, ctx,
    );
    executed = [];

    const after = await unwaiveLabItem(
      CASE_ID, 'hcv', { tenantId: TENANT, reason: 'the report arrived' }, ctx,
    );

    const audit = executed.find((entry) => /INSERT INTO audit_logs/.test(entry.sql));
    expect(audit.params[3]).toBe('cath_lab.readiness.labs.unwaived');
    // The WITHDRAWN waiver's own reason rides on the row that withdraws it —
    // a log saying an override was lifted, without saying which override, is
    // not a trail.
    expect(JSON.parse(audit.params[6])).toMatchObject({
      item: 'hcv',
      reason: 'the report arrived',
      previous_reason: 'repeat on file elsewhere',
    });
    // The three waiver columns are gone from the stored row...
    expect(stubRows.items.find((row) => row.item_code === 'hcv')).toMatchObject({
      waived_by: null, waived_at: null, waive_reason: null,
    });
    // ...and the refresh that ran on the SAME transaction re-resolved the item
    // from evidence, which here is none: it is missing again and the check is
    // back to pending. That is the whole risk of this action, asserted.
    const item = after.items.find((row) => row.item_code === 'hcv');
    expect(item.state).toBe('not_ordered');
    expect(item.waive_reason).toBeNull();
    expect(after.missing.map((row) => row.item)).toContain('hcv');
    expect(after.check_status).toBe('pending');
  });
});
