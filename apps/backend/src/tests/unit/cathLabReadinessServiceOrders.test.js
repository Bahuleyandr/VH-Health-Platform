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
 *     blocks the re-order that would produce some.
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
    $executeRawUnsafe: async () => 1,
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
// path, which this suite never exercises; stubbing the boundary keeps the
// module graph (and the suite) small.
jest.unstable_mockModule('../../services/lab/labResultsService.js', () => ({
  recordExternalLabResultRow: jest.fn(),
}));
jest.unstable_mockModule('../../services/clinical/bloodborneMarkerService.js', () => ({
  recordMarkers: jest.fn(),
}));

const { orderMissingLabs, refreshCaseLabReadiness } = await import(
  '../../services/clinical/cathLabReadinessService.js'
);

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

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
  createInvestigationOrderMock.mockReset();
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
  const staleOrder = () => ([{
    id: 61,
    test_code: 'CBC',
    status: 'REQUESTED',
    requested_at: daysAgo(60),
    collected_at: null,
    booking_id: null,
  }]);

  test('an order older than the window is neither evidence nor a block', async () => {
    stubRows.orders = staleOrder();

    const out = await refreshCaseLabReadiness({ tenantId: TENANT, caseId: CASE_ID, context: ctx });

    expect(out.items.find((item) => item.item_code === 'hb').state).toBe('not_ordered');
    expect(out.orderable_now).toContain('CBC');
    expect(out.open_order_codes).not.toContain('CBC');
  });

  test('an order inside the window still counts, and still blocks', async () => {
    stubRows.orders = [{ ...staleOrder()[0], requested_at: daysAgo(2) }];

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
