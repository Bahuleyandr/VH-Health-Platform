import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';

const queryMock = jest.fn();
const executeMock = jest.fn();
const setTenantTxMock = jest.fn();
const lockSubstitutionAuthorityMock = jest.fn();
const resolveLedgerWiringMock = jest.fn();
const resolvePharmacyFundingPatientUidTxMock = jest.fn();
const lockPharmacyFundingAuthorityTxMock = jest.fn();
const lockPharmacyFundingAdmissionTxMock = jest.fn();
const releasePharmacyCapReservationTxMock = jest.fn();
const clinicalOrderItemsSha256Mock = jest.fn();

const mockPrisma = {
  $queryRawUnsafe: queryMock,
  $executeRawUnsafe: executeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockPrisma,
  isTenantTransactionClient: (value) => value === mockPrisma,
  setTenantTx: setTenantTxMock,
  setTenant: async (_tenantId, fn) => fn(mockPrisma),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockPrisma),
  pickTenantClient: () => mockPrisma,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

jest.unstable_mockModule(
  '../../services/billing/ledger/ledgerAuthoritativeMode.js',
  () => ({
    resolveLedgerWiring: resolveLedgerWiringMock,
    resolveLedgerModeForTenant: async () => 'off',
  }),
);

jest.unstable_mockModule('../../services/pharmacy/pharmacyCapService.js', () => ({
  lockCounterFundingSubstitutionAuthorityTx: lockSubstitutionAuthorityMock,
  lockPharmacyFundingAdmissionTx: lockPharmacyFundingAdmissionTxMock,
  lockPharmacyFundingAuthorityTx: lockPharmacyFundingAuthorityTxMock,
  releasePharmacyCapReservationTx: releasePharmacyCapReservationTxMock,
  resolvePharmacyFundingPatientUidTx: resolvePharmacyFundingPatientUidTxMock,
}));

jest.unstable_mockModule(
  '../../services/pharmacy/pharmacistVerificationService.js',
  () => ({ clinicalOrderItemsSha256: clinicalOrderItemsSha256Mock }),
);

const svc = await import('../../services/billing/billingV2Service.js');

const TENANT = '10000000-0000-4000-8000-000000000001';
const PATIENT = '20000000-0000-4000-8000-000000000002';
const ACTOR = '30000000-0000-4000-8000-000000000003';
const ITEMS_SHA256 = 'a'.repeat(64);
const COMMAND_SHA256 = 'b'.repeat(64);
const ITEMS = [{ catalog_id: 7, quantity: 1, unit_price: 100 }];

function route(match, reply, times = 1) {
  return { match, reply, remaining: times };
}

function matchesSql(match, sql, params) {
  if (typeof match === 'function') return match(sql, params);
  if (match instanceof RegExp) return match.test(sql);
  if (Array.isArray(match)) return match.every((fragment) => sql.includes(fragment));
  return sql.includes(match);
}

function sqlRouter({ queries = [], executes = [] } = {}) {
  const queryRoutes = queries.map((entry) => ({ ...entry }));
  const executeRoutes = executes.map((entry) => ({ ...entry }));

  const dispatch = async (kind, routes, sql, params) => {
    const selected = routes.find((entry) => entry.remaining !== 0
      && matchesSql(entry.match, sql, params));
    if (!selected) {
      throw new Error(`Unhandled ${kind} SQL: ${sql}\nparams=${JSON.stringify(params)}`);
    }
    if (Number.isFinite(selected.remaining)) selected.remaining -= 1;
    return typeof selected.reply === 'function'
      ? selected.reply({ sql, params })
      : selected.reply;
  };

  const query = jest.fn((sql, ...params) => dispatch('query', queryRoutes, sql, params));
  const execute = jest.fn((sql, ...params) => dispatch('execute', executeRoutes, sql, params));
  const tx = { $queryRawUnsafe: query, $executeRawUnsafe: execute };

  return {
    tx,
    query,
    execute,
    assertDrained() {
      const pending = [...queryRoutes, ...executeRoutes]
        .filter((entry) => Number.isFinite(entry.remaining) && entry.remaining !== 0);
      expect(pending).toEqual([]);
    },
  };
}

function usePrismaRouter(router) {
  queryMock.mockImplementation((...args) => router.tx.$queryRawUnsafe(...args));
  executeMock.mockImplementation((...args) => router.tx.$executeRawUnsafe(...args));
}

function writeCalls(router) {
  return router.query.mock.calls.filter(([sql]) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql));
}

function fundingHash(eventType, values) {
  return createHash('sha256')
    .update(JSON.stringify({ event_type: eventType, ...values }))
    .digest('hex');
}

const PAYMENT_ALLOCATION_REVERSAL_COMMAND_SHA256 = fundingHash(
  'PAYMENT_ALLOCATION_REVERSAL',
  {
    parent_command_sha256: COMMAND_SHA256,
    allocation_id: 51,
    payment_id: 41,
  },
);

function expectDerivedAllocationReversalCommand(router, returnedRow) {
  const insert = router.query.mock.calls.find(([sql]) => (
    sql.includes('INSERT INTO pharmacy_payment_allocation_reversals')
  ));
  expect(insert[10]).toBe(PAYMENT_ALLOCATION_REVERSAL_COMMAND_SHA256);
  expect(insert[10]).not.toBe(COMMAND_SHA256);
  const commandReads = router.query.mock.calls.filter(([sql]) => (
    sql.includes('SELECT * FROM pharmacy_payment_allocation_reversals')
    && sql.includes('reversal_command_sha256=$2')
  ));
  expect(commandReads.length).toBeGreaterThan(0);
  expect(commandReads.every((call) => (
    call[2] === PAYMENT_ALLOCATION_REVERSAL_COMMAND_SHA256
  ))).toBe(true);
  expect(returnedRow.reversal_command_sha256)
    .toBe(PAYMENT_ALLOCATION_REVERSAL_COMMAND_SHA256);
}

function authority(overrides = {}) {
  return {
    tenantId: TENANT,
    facilityId: 7,
    orderId: 71,
    patientId: 91,
    patientUid: PATIENT,
    authoritativeAmount: 100,
    orderVersion: 3,
    orderItemsSha256: ITEMS_SHA256,
    paymentMode: 'cash',
    actorUid: ACTOR,
    ...overrides,
  };
}

function eventArgs(overrides = {}) {
  return {
    authority: authority(),
    eventType: 'FUNDING_RESOLVED',
    admissionId: null,
    invoiceId: 21,
    invoiceItemId: 31,
    amount: 100,
    evidence: { contract: 'pharmacy_funding_authority_v1', payment_ids: [41] },
    ...overrides,
  };
}

function allocationRow(overrides = {}) {
  return {
    id: 51,
    tenant_id: TENANT,
    pharmacy_order_id: 71,
    invoice_id: 21,
    invoice_item_id: 31,
    billing_payment_id: 41,
    source_authority_version: 3,
    source_authority_sha256: ITEMS_SHA256,
    allocated_amount: '100',
    remaining_amount: '100',
    ...overrides,
  };
}

function reversalRow(overrides = {}) {
  return {
    id: 61,
    allocation_id: 51,
    pharmacy_order_id: 71,
    invoice_id: 21,
    invoice_item_id: 31,
    billing_payment_id: 41,
    source_authority_version: 3,
    source_authority_sha256: ITEMS_SHA256,
    reversed_amount: '25',
    reversal_command_sha256: COMMAND_SHA256,
    reason: 'entry correction',
    reversed_by: ACTOR,
    ...overrides,
  };
}

function reversalArgs(overrides = {}) {
  return {
    tenantId: TENANT,
    allocationId: 51,
    pharmacyOrderId: 71,
    invoiceId: 21,
    invoiceItemId: 31,
    billingPaymentId: 41,
    orderVersion: 3,
    orderItemsSha256: ITEMS_SHA256,
    reversedAmount: 25,
    actorUid: ACTOR,
    reason: 'entry correction',
    commandKeySha256: COMMAND_SHA256,
    ...overrides,
  };
}

function allocationReversalRoutes({
  orderStatus = 'READY',
  actorRole = 'FINANCE_INCHARGE',
  existing = [],
  reversedTotal = '0',
  inserted = [reversalRow()],
  raced = null,
} = {}) {
  const queries = [
    route(['SELECT id,status FROM pharmacy_orders', 'FOR UPDATE'], [{ id: 71, status: orderStatus }]),
    route(['SELECT uid, UPPER(role) AS role', 'FROM users'], [{ uid: ACTOR, role: actorRole }]),
    route([
      'FROM pharmacy_payment_allocations allocation',
      'JOIN billing_payments payment',
      'allocation.id=$2::bigint',
    ], [allocationRow()]),
    route(['SELECT * FROM pharmacy_payment_allocation_reversals', 'reversal_command_sha256=$2'], existing),
  ];
  if (!existing.length) {
    queries.push(
      route(['COALESCE(SUM(reversed_amount),0)', 'allocation_id=$2::bigint'], [{ reversed_amount: reversedTotal }]),
      route('INSERT INTO pharmacy_payment_allocation_reversals', inserted),
    );
    if (!inserted.length) {
      queries.push(route(
        ['SELECT * FROM pharmacy_payment_allocation_reversals', 'reversal_command_sha256=$2'],
        raced == null ? [] : [raced],
      ));
    }
  }
  return queries;
}

function validOrder(overrides = {}) {
  return {
    id: 71,
    facility_id: 7,
    patient_id: 91,
    patient_uid: PATIENT,
    patient_name: 'Coverage Patient',
    patient_phone: '9000000000',
    order_number: 'RX-71',
    status: 'CANCELLED',
    total_amount: '100',
    inventory_authority_version: 3,
    items_list: ITEMS,
    payment_mode: 'cash',
    payment_metadata: { payment_mode: 'cash' },
    funding_admission_id: null,
    funding_admission_order_version: null,
    funding_admission_items_sha256: null,
    ...overrides,
  };
}

function validLine(overrides = {}) {
  return {
    id: 31,
    invoice_id: 21,
    quantity: '1',
    unit_price: '100',
    line_subtotal: '100',
    cgst_amount: '0',
    sgst_amount: '0',
    igst_amount: '0',
    line_total: '100',
    source_authority_version: 3,
    source_authority_sha256: ITEMS_SHA256,
    invoice_status: 'DRAFT',
    patient_uid: PATIENT,
    admission_id: null,
    invoice_subtotal: '100',
    invoice_cgst_amount: '0',
    invoice_sgst_amount: '0',
    invoice_igst_amount: '0',
    invoice_total_amount: '100',
    invoice_amount_paid: '0',
    invoice_amount_due: '100',
    source_ref_type: 'pharmacy_order',
    source_ref_id: 71,
    source_ref_active: true,
    ...overrides,
  };
}

function validInvoice(overrides = {}) {
  return {
    id: 21,
    status: 'DRAFT',
    patient_uid: PATIENT,
    admission_id: null,
    tenant_id: TENANT,
    subtotal: '100',
    cgst_amount: '0',
    sgst_amount: '0',
    igst_amount: '0',
    total_amount: '100',
    amount_paid: '0',
    amount_due: '100',
    ...overrides,
  };
}

function advanceAllocationRow(overrides = {}) {
  return {
    id: '801',
    allocated_amount: '100',
    billing_advance_id: 901,
    invoice_id: 21,
    invoice_item_id: 31,
    funding_task_id: 91,
    funding_approval_receipt_id: null,
    ...overrides,
  };
}

function noSubstitutionAuthorityRoutes(times = 1) {
  return [
    route(['FROM tasks', 'related_resource_type=ANY($3::text[])', "metadata->>'contract'=$4"], [], times),
    route(['FROM approvals', "approval_kind='pharmacy_substitution_funding_reauthorisation'"], [], times),
    route(['FROM pharmacy_funding_commands', "command_type='SUBSTITUTION_FUNDING_APPROVAL'"], [], times),
  ];
}

function noAdvanceAllocationRoutes(times = 1) {
  return [route([
    'FROM pharmacy_advance_allocations allocation',
    'allocation.pharmacy_order_id=$2::int',
    'FOR UPDATE OF allocation',
  ], [], times)];
}

function fundingDomainLockRoutes({ lines = [validLine()] } = {}) {
  const invoiceIds = [...new Set(lines.map((line) => Number(line.invoice_id)))];
  return [
    route(['SELECT item.id,item.invoice_id', "item.source_ref_type='pharmacy_order'"],
      lines.map((line) => ({ id: line.id, invoice_id: line.invoice_id }))),
    route(['FROM billing_invoices', 'id=ANY($2::int[])', 'ORDER BY id', 'FOR UPDATE'],
      invoiceIds.map((id) => validInvoice({ id }))),
    route(['FROM billing_invoice_items', 'id=ANY($2::int[])', 'ORDER BY id', 'FOR UPDATE'], lines),
    route(['FROM billing_payments', 'invoice_id=ANY($2::int[])'], []),
    route(['FROM billing_refunds', 'invoice_id=ANY($2::int[])'], []),
    route(['FROM billing_advance_settlements', 'invoice_id=ANY($2::int[])'], []),
  ];
}

function reversePaymentPreludeRoutes({ fundedOrders = [], allocations = [allocationRow()] } = {}) {
  const fundingAuthorities = [...new Map(allocations.map((allocation) => {
    const row = {
      pharmacy_order_id: Number(allocation.pharmacy_order_id),
      source_authority_version: Number(allocation.source_authority_version),
      source_authority_sha256: String(allocation.source_authority_sha256),
    };
    return [[
      row.pharmacy_order_id,
      row.source_authority_version,
      row.source_authority_sha256,
    ].join(':'), row];
  })).values()].sort((left, right) => (
    left.pharmacy_order_id - right.pharmacy_order_id
      || left.source_authority_version - right.source_authority_version
      || left.source_authority_sha256.localeCompare(right.source_authority_sha256)
  ));
  return [
    // patientMergeStabilityLock via billingV2Service setTenantTx flows: the
    // tenant key travels as $1, so the namespace must be matched in params.
    route(
      (sql, params) => sql.includes('pg_advisory_xact_lock_shared')
        && String(params[0] ?? '').startsWith('vhhealth:patient-merge-tenant:'),
      [{ locked: 1 }],
    ),
    route(['SELECT payment.patient_uid', 'has_pharmacy_allocations'], [{
      patient_uid: PATIENT,
      invoice_id: 21,
      has_pharmacy_allocations: true,
    }]),
    route(['WITH RECURSIVE patient_chain', 'FROM users patient'], [{
      uid: PATIENT, merged_into_uid: null, depth: 0, cycle: false,
    }]),
    route([
      'SELECT DISTINCT allocation.pharmacy_order_id',
      'allocation.source_authority_sha256',
    ], fundingAuthorities),
    ...fundingAuthorities.map((authorityRow) => route(
      (sql, params) => sql.includes('vh:pharmacy_funding_event_chain')
        && Number(params[1]) === authorityRow.pharmacy_order_id
        && Number(params[2]) === authorityRow.source_authority_version
        && String(params[3]) === authorityRow.source_authority_sha256,
      [{ lock_acquired: null }],
    )),
    // assertNoSubstitutionFundingAuthorityTx delegates to the mocked
    // pharmacyCapService.lockCounterFundingSubstitutionAuthorityTx here, so no
    // raw substitution-authority reads reach the router in this flow.
    route(['FROM pharmacy_orders pharmacy_order', 'billing_payment_id=$2::int'], fundedOrders),
    route(['SELECT id, patient_uid, status', 'FROM billing_invoices', 'FOR UPDATE'], [{
      id: 21, patient_uid: PATIENT, status: 'ISSUED',
    }]),
    route(['SELECT payment.id,payment.invoice_id', 'immutable_drawer_close'], [{
      id: 41,
      invoice_id: 21,
      patient_uid: PATIENT,
      amount: '100',
      reversed: false,
      mode: 'UPI',
      immutable_drawer_close: false,
    }]),
    route([
      'SELECT allocation.id, allocation.tenant_id',
      'allocation.billing_payment_id=$2::int',
      'FOR UPDATE OF allocation',
    ], allocations),
  ];
}

function paymentResidualFundingCapacityRoute() {
  return route([
    'AS source_amount',
    'AS active_refunds',
    'AS pharmacy_allocations',
  ], [{
    source_amount: '100', active_refunds: '0', pharmacy_allocations: '0',
  }]);
}

function paymentInvoiceRecomputeRoutes() {
  return [
    route(['SELECT id', 'FROM billing_invoices', 'LIMIT 1', 'FOR UPDATE'], [{ id: 21 }]),
    route(['SELECT (', 'FROM billing_payments', 'FROM billing_advance_settlements'], [{ paid: '0' }]),
    route(['SELECT total_amount, credit_note_amount FROM billing_invoices'], [{
      total_amount: '100', credit_note_amount: '0',
    }]),
    route(['SELECT id, admission_id', 'FROM billing_invoices'], [{ id: 21, admission_id: null }]),
  ];
}

function orderAuthorityRow(overrides = {}) {
  return {
    ...validOrder({ status: 'READY' }),
    invoice_item_id: 31,
    invoice_id: 21,
    source_authority_version: 3,
    source_authority_sha256: ITEMS_SHA256,
    admission_id: null,
    ...overrides,
  };
}

function liveAllocation(overrides = {}) {
  return {
    allocation_id: 52,
    allocated_amount: '100',
    payment_id: 42,
    mode: 'UPI',
    reference: 'UTR-42',
    collected_at: '2026-08-30T08:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  queryMock.mockReset();
  executeMock.mockReset();
  setTenantTxMock.mockImplementation(async (_tenantId, callback) => callback(mockPrisma));
  resolveLedgerWiringMock.mockResolvedValue({
    mode: 'off', sameTx: false, postCommit: false, skip: true,
  });
  resolvePharmacyFundingPatientUidTxMock.mockResolvedValue(PATIENT);
  lockPharmacyFundingAuthorityTxMock.mockResolvedValue(undefined);
  lockPharmacyFundingAdmissionTxMock.mockResolvedValue(undefined);
  releasePharmacyCapReservationTxMock.mockResolvedValue({ id: 81, status: 'RELEASED' });
  clinicalOrderItemsSha256Mock.mockReturnValue(ITEMS_SHA256);
});

describe('pharmacy funding authority event chain', () => {
  it('rejects unsupported state transitions before touching SQL', async () => {
    const router = sqlRouter();

    await expect(svc.appendPharmacyFundingAuthorityStateTx(router.tx, eventArgs({
      eventType: 'LINE_MATERIALIZED',
    }))).rejects.toMatchObject({
      statusCode: 500,
      code: 'PHARMACY_FUNDING_EVENT_TYPE_INVALID',
    });

    expect(router.query).not.toHaveBeenCalled();
    expect(router.execute).not.toHaveBeenCalled();
  });

  it('fails closed when two event-chain heads survive', async () => {
    const router = sqlRouter({
      queries: [
        route('pg_advisory_xact_lock', [{ lock_acquired: null }]),
        route('FROM pharmacy_funding_decision_events event', [
          { id: 1, authority_generation: 2 },
          { id: 2, authority_generation: 2 },
        ]),
      ],
    });

    await expect(svc.appendPharmacyFundingAuthorityStateTx(
      router.tx,
      eventArgs(),
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_FUNDING_CURRENT_EVENT_AMBIGUOUS',
    });

    expect(writeCalls(router)).toEqual([]);
    router.assertDrained();
  });

  it('replays an identical current authority without inserting another event', async () => {
    const evidence = { contract: 'pharmacy_funding_authority_v1', payment_ids: [41] };
    const fingerprint = fundingHash('FUNDING_RESOLVED', evidence);
    const current = {
      id: 91,
      event_type: 'FUNDING_RESOLVED',
      authority_generation: 4,
      evidence: { ...evidence, authority_fingerprint_sha256: fingerprint },
    };
    const router = sqlRouter({
      queries: [
        route('pg_advisory_xact_lock', [{ lock_acquired: null }]),
        route('FROM pharmacy_funding_decision_events event', [current]),
      ],
    });

    await expect(svc.appendPharmacyFundingAuthorityStateTx(
      router.tx,
      eventArgs({ evidence }),
    )).resolves.toEqual({ ...current, replayed: true });

    expect(writeCalls(router)).toEqual([]);
    router.assertDrained();
  });

  it('recursively invalidates changed evidence before appending its replacement', async () => {
    let current = {
      id: 101,
      event_type: 'FUNDING_RESOLVED',
      authority_generation: 1,
      admission_id: null,
      invoice_id: 21,
      invoice_item_id: 31,
      tpa_claim_id: null,
      billing_payment_id: 41,
      task_id: 51,
      amount: '100',
      evidence: {
        contract: 'pharmacy_funding_authority_v1',
        authority_fingerprint_sha256: fundingHash('FUNDING_RESOLVED', {
          contract: 'pharmacy_funding_authority_v1', payment_ids: [40],
        }),
      },
    };
    let nextId = 102;
    const inserted = [];
    const router = sqlRouter({
      queries: [
        route('pg_advisory_xact_lock', [{ lock_acquired: null }], 3),
        route('FROM pharmacy_funding_decision_events event', () => [current], 3),
        route('INSERT INTO pharmacy_funding_decision_events', ({ params }) => {
          const row = {
            id: nextId++,
            event_type: params[4],
            admission_id: params[3],
            invoice_id: params[7],
            invoice_item_id: params[8],
            tpa_claim_id: params[9],
            billing_payment_id: params[10],
            task_id: params[11],
            amount: params[12],
            evidence: JSON.parse(params[14]),
            authority_generation: params[16],
            supersedes_event_id: params[17],
          };
          inserted.push(row);
          current = row;
          return [row];
        }, 2),
      ],
    });

    const result = await svc.appendPharmacyFundingAuthorityStateTx(router.tx, eventArgs({
      evidence: { contract: 'pharmacy_funding_authority_v1', payment_ids: [42] },
    }));

    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({
      event_type: 'AUTHORITY_INVALIDATED',
      authority_generation: 2,
      supersedes_event_id: 101,
      evidence: expect.objectContaining({
        invalidation_reason: 'funding_evidence_replaced',
        prior_funding_event_id: 101,
      }),
    });
    expect(inserted[1]).toMatchObject({
      event_type: 'FUNDING_RESOLVED',
      authority_generation: 3,
      supersedes_event_id: 102,
    });
    expect(result).toMatchObject({ id: 103, replayed: false });
    router.assertDrained();
  });
});

describe('pharmacy payment allocation reversal authority', () => {
  it('rejects an incomplete target before patient resolution or SQL', async () => {
    const router = sqlRouter();

    await expect(svc.reversePharmacyPaymentAllocationTx(router.tx, reversalArgs({
      allocationId: 0,
    }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_PAYMENT_ALLOCATION_REVERSAL_INVALID',
    });

    expect(resolvePharmacyFundingPatientUidTxMock).not.toHaveBeenCalled();
    expect(router.query).not.toHaveBeenCalled();
  });

  it('records a fresh reversal with exact authority and monetary evidence', async () => {
    const fresh = reversalRow();
    const router = sqlRouter({ queries: allocationReversalRoutes({ inserted: [fresh] }) });

    await expect(svc.reversePharmacyPaymentAllocationTx(
      router.tx,
      reversalArgs(),
    )).resolves.toEqual({ ...fresh, replayed: false });

    expect(resolvePharmacyFundingPatientUidTxMock).toHaveBeenCalledWith(router.tx, {
      tenantId: TENANT,
      orderId: 71,
    });
    expect(lockPharmacyFundingAuthorityTxMock).toHaveBeenCalledWith(router.tx, {
      tenantId: TENANT,
      patientUid: PATIENT,
    });
    const insert = router.query.mock.calls.find(([sql]) => (
      sql.includes('INSERT INTO pharmacy_payment_allocation_reversals')
    ));
    expect(insert.slice(1, 13)).toEqual([
      TENANT, 51, 71, 21, 31, 41, 3, ITEMS_SHA256, 25,
      COMMAND_SHA256, 'entry correction', ACTOR,
    ]);
    expect(JSON.parse(insert[13])).toEqual({
      contract: 'pharmacy_payment_allocation_reversal_v1',
      prior_unreversed_amount: 100,
      resulting_unreversed_amount: 75,
    });
    router.assertDrained();
  });

  it('returns a terminal-role replay only when every command binding matches', async () => {
    const existing = reversalRow({ reason: 'terminal_order_cancelled' });
    const router = sqlRouter({
      queries: allocationReversalRoutes({
        orderStatus: 'CANCELLED',
        actorRole: 'PHARMACIST',
        existing: [existing],
      }),
    });

    await expect(svc.reversePharmacyPaymentAllocationTx(router.tx, reversalArgs({
      reason: 'terminal_order_cancelled',
    }))).resolves.toEqual({ ...existing, replayed: true });

    expect(writeCalls(router)).toEqual([]);
    router.assertDrained();
  });

  it('does not grant terminal reversal roles to an actionable non-terminal order', async () => {
    const router = sqlRouter({
      queries: [
        route(['SELECT id,status FROM pharmacy_orders', 'FOR UPDATE'], [{ id: 71, status: 'READY' }]),
        route(['SELECT uid, UPPER(role) AS role', 'FROM users'], [{ uid: ACTOR, role: 'PHARMACIST' }]),
      ],
    });

    await expect(svc.reversePharmacyPaymentAllocationTx(
      router.tx,
      reversalArgs(),
    )).rejects.toMatchObject({
      statusCode: 403,
      code: 'PHARMACY_FUNDING_ACTOR_FORBIDDEN',
    });

    expect(writeCalls(router)).toEqual([]);
    router.assertDrained();
  });

  it('rejects an existing command bound to different authority', async () => {
    const router = sqlRouter({
      queries: allocationReversalRoutes({
        existing: [reversalRow({ invoice_item_id: 999 })],
      }),
    });

    await expect(svc.reversePharmacyPaymentAllocationTx(
      router.tx,
      reversalArgs(),
    )).rejects.toMatchObject({
      statusCode: 422,
      code: 'PHARMACY_PAYMENT_ALLOCATION_REVERSAL_COMMAND_MISMATCH',
    });

    expect(writeCalls(router)).toEqual([]);
    router.assertDrained();
  });

  it('returns the exact raced insert as a replay', async () => {
    const raced = reversalRow();
    const router = sqlRouter({
      queries: allocationReversalRoutes({ inserted: [], raced }),
    });

    await expect(svc.reversePharmacyPaymentAllocationTx(
      router.tx,
      reversalArgs(),
    )).resolves.toEqual({ ...raced, replayed: true });

    router.assertDrained();
  });

  it('fails closed when a raced command has different monetary evidence', async () => {
    const router = sqlRouter({
      queries: allocationReversalRoutes({
        inserted: [],
        raced: reversalRow({ reversed_amount: '24.99' }),
      }),
    });

    await expect(svc.reversePharmacyPaymentAllocationTx(
      router.tx,
      reversalArgs(),
    )).rejects.toMatchObject({
      statusCode: 422,
      code: 'PHARMACY_PAYMENT_ALLOCATION_REVERSAL_COMMAND_MISMATCH',
    });

    router.assertDrained();
  });

  it('rejects an over-balance reversal before inserting evidence', async () => {
    const router = sqlRouter({
      queries: allocationReversalRoutes({
        reversedTotal: '90',
        inserted: [reversalRow()],
      }).slice(0, -1),
    });

    await expect(svc.reversePharmacyPaymentAllocationTx(
      router.tx,
      reversalArgs(),
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_PAYMENT_ALLOCATION_REVERSAL_EXCEEDS_BALANCE',
      details: { remaining_amount: 10 },
    });

    expect(writeCalls(router)).toEqual([]);
    router.assertDrained();
  });
});

// The public probe does not acquire the pharmacy-order lock itself. Its callers
// retain that serialization boundary while it reads all three evidence planes.
describe('unresolved-patient funding evidence probe under a caller-retained order lock', () => {
  it('probes all four evidence planes while the caller retains order serialization', async () => {
    const router = sqlRouter({
      queries: [
        ...noSubstitutionAuthorityRoutes(),
        route(['FROM billing_invoice_items item', 'source_ref_active=TRUE'], []),
        route(['FROM pharmacy_cap_reservations', "status='ACTIVE'"], []),
        route(['FROM pharmacy_payment_allocations allocation', 'GROUP BY allocation.id'], []),
        ...noAdvanceAllocationRoutes(),
      ],
    });

    await expect(svc.assertNoLivePharmacyOrderFundingAuthorityTx(router.tx, {
      tenantId: TENANT,
      orderId: 71,
    })).resolves.toEqual({
      pharmacyOrderId: 71,
      liveFundingAuthority: false,
    });

    expect(router.query.mock.calls.slice(-4).map((call) => call.slice(1))).toEqual([
      [TENANT, 71], [TENANT, 71], [TENANT, 71], [TENANT, 71],
    ]);
    expect(router.query.mock.calls.slice(0, 3).every(([sql]) => (
      !sql.includes('FOR UPDATE')
    ))).toBe(true);
    expect(writeCalls(router)).toEqual([]);
    router.assertDrained();
  });

  it('rejects an invalid exact order before probing any evidence plane', async () => {
    const router = sqlRouter();

    await expect(svc.assertNoLivePharmacyOrderFundingAuthorityTx(router.tx, {
      tenantId: TENANT,
      orderId: 0,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_TERMINAL_FUNDING_AUTHORITY_REQUIRED',
    });

    expect(router.query).not.toHaveBeenCalled();
    expect(router.execute).not.toHaveBeenCalled();
  });

  it('reports every surviving authority and does not mutate it', async () => {
    const router = sqlRouter({
      queries: [
        ...noSubstitutionAuthorityRoutes(),
        route(['FROM billing_invoice_items item', 'source_ref_active=TRUE'], [{ id: '31' }]),
        route(['FROM pharmacy_cap_reservations', "status='ACTIVE'"], [{ id: '81' }]),
        route(['FROM pharmacy_payment_allocations allocation', 'GROUP BY allocation.id'], [{ id: '51' }]),
        route([
          'FROM pharmacy_advance_allocations allocation',
          'allocation.pharmacy_order_id=$2::int',
          'FOR UPDATE OF allocation',
        ], [advanceAllocationRow()]),
        route(['FROM pharmacy_advance_allocation_reversals', 'allocation_id=ANY($2::bigint[])'], []),
      ],
    });

    await expect(svc.assertNoLivePharmacyOrderFundingAuthorityTx(router.tx, {
      tenantId: TENANT,
      orderId: 71,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_TERMINAL_FUNDING_PATIENT_AUTHORITY_UNRESOLVED',
      details: {
        pharmacy_order_id: 71,
        active_invoice_item_ids: [31],
        active_cap_reservation_ids: [81],
        open_allocation_ids: [51],
        open_advance_allocation_ids: ['801'],
        next_action: 'resolve_order_patient_tenant_mismatch_recovery_then_retry',
      },
    });

    expect(writeCalls(router)).toEqual([]);
    expect(router.execute).not.toHaveBeenCalled();
    router.assertDrained();
  });
});

describe('terminal pharmacy funding compensation', () => {
  it('issues cap, allocation, authority, draft-line, and empty-invoice closure writes', async () => {
    const currentEvent = {
      id: 701,
      event_type: 'FUNDING_RESOLVED',
      authority_generation: 1,
      admission_id: null,
      invoice_id: 21,
      invoice_item_id: 31,
      tpa_claim_id: null,
      billing_payment_id: 41,
      task_id: 91,
      amount: '100',
      evidence: { contract: 'pharmacy_funding_authority_v1' },
    };
    const router = sqlRouter({
      queries: [
        route(['SELECT uid, UPPER(role) AS role', 'FROM users'], [{ uid: ACTOR, role: 'ADMIN' }], 2),
        route([
          'SELECT pharmacy_order.id,pharmacy_order.facility_id,pharmacy_order.status',
          'JOIN users patient',
        ], [validOrder()]),
        route('FROM pharmacy_stock_movements', [], 2),
        ...fundingDomainLockRoutes(),
        ...noAdvanceAllocationRoutes(2),
        route(['SELECT id FROM billing_payments', 'reversed=FALSE'], []),
        route(['SELECT admission_id FROM pharmacy_cap_reservations', "status='ACTIVE'"], [{ admission_id: 44 }]),
        route([
          'SELECT allocation.*',
          'allocation.pharmacy_order_id=$2::int',
          'remaining_amount',
        ], [allocationRow()]),
        route(['SELECT id,status FROM pharmacy_orders', 'FOR UPDATE'], [{ id: 71, status: 'CANCELLED' }]),
        route([
          'FROM pharmacy_payment_allocations allocation',
          'JOIN billing_payments payment',
          'allocation.id=$2::bigint',
        ], [allocationRow()]),
        route(['SELECT * FROM pharmacy_payment_allocation_reversals', 'reversal_command_sha256=$2'], []),
        route(['COALESCE(SUM(reversed_amount),0)', 'allocation_id=$2::bigint'], [{ reversed_amount: '0' }]),
        route('INSERT INTO pharmacy_payment_allocation_reversals', ({ params }) => [{
          id: 61,
          allocation_id: params[1],
          pharmacy_order_id: params[2],
          invoice_id: params[3],
          invoice_item_id: params[4],
          billing_payment_id: params[5],
          source_authority_version: params[6],
          source_authority_sha256: params[7],
          reversed_amount: params[8],
          reversal_command_sha256: params[9],
          reason: params[10],
          reversed_by: params[11],
        }]),
        route('pg_advisory_xact_lock', [{ lock_acquired: null }], 2),
        route('FROM pharmacy_funding_decision_events event', [currentEvent], 2),
        route('INSERT INTO pharmacy_funding_decision_events', ({ params }) => [{
          id: 702,
          event_type: params[4],
          evidence: JSON.parse(params[14]),
          authority_generation: params[16],
          supersedes_event_id: params[17],
        }]),
        route(['UPDATE tasks', "status='cancelled'"], [{ id: 91 }]),
        route(['UPDATE billing_invoice_items', 'source_ref_active=FALSE'], [{ id: 31 }]),
        route(['COALESCE(SUM(line_subtotal), 0)', 'FROM billing_invoice_items'], [{
          subtotal: '0', cgst: '0', sgst: '0', igst: '0',
        }]),
        route(['SELECT discount_amount', 'FROM billing_invoices'], [{
          discount_amount: '0', credit_note_amount: '0', amount_paid: '0',
        }]),
        route(['SELECT admission_id, patient_uid, tenant_id', 'FROM billing_invoices'], []),
        route(['SELECT COUNT(*)::int AS active_count', 'source_ref_active=TRUE'], [{ active_count: 0 }]),
        route(['UPDATE billing_invoices', "status='VOID'"], [{ id: 21 }]),
      ],
      executes: [
        route(['UPDATE tpa_claim_line_decisions decision', 'invalidated_at=NOW()'], 1),
        route(['UPDATE billing_invoices', 'SET subtotal = $1::numeric'], 1),
      ],
    });

    const result = await svc.compensateTerminalPharmacyFundingAuthorityTx(router.tx, {
      tenantId: TENANT,
      orderId: 71,
      actorUid: ACTOR,
      actorRole: 'ADMIN',
    });

    expect(result).toMatchObject({
      status: 'compensated',
      pharmacyOrderId: 71,
      terminalOrderStatus: 'CANCELLED',
      closedTaskIds: [91],
      deactivatedInvoiceItemId: 31,
      voidedInvoiceId: 21,
      reversedAllocationIds: [51],
      invalidatedFundingEventId: 702,
      releasedCapReservation: { id: 81, status: 'RELEASED' },
      monetaryCompensation: {
        invoiceItemId: 31,
        invoiceId: 21,
        priorLineTotal: 100,
        priorInvoiceTotalAmount: 100,
        resultingLineTotal: 0,
      },
      recomputedInvoice: {
        invoiceId: 21,
        total: 0,
        due: 0,
      },
    });
    expect(releasePharmacyCapReservationTxMock).toHaveBeenCalledWith(router.tx, expect.objectContaining({
      tenantId: TENANT,
      facilityId: 7,
      admissionId: 44,
      orderId: 71,
      actorUid: ACTOR,
      actorRole: 'ADMIN',
      reason: 'terminal_order_cancelled',
      commandKeySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    const reversalInsert = router.query.mock.calls.find(([sql]) => (
      sql.includes('INSERT INTO pharmacy_payment_allocation_reversals')
    ));
    expect(reversalInsert.slice(1, 13)).toEqual([
      TENANT, 51, 71, 21, 31, 41, 3, ITEMS_SHA256, 100,
      expect.stringMatching(/^[0-9a-f]{64}$/), 'terminal_order_cancelled', ACTOR,
    ]);
    expect(router.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE billing_invoices'),
      0, 0, 0, 0, 0, 0, 21,
    );
    const invoiceLockIndex = router.query.mock.calls.findIndex(([sql]) => (
      sql.includes('FROM billing_invoices') && sql.includes('id=ANY($2::int[])')
    ));
    const itemLockIndex = router.query.mock.calls.findIndex(([sql]) => (
      sql.includes('FROM billing_invoice_items') && sql.includes('id=ANY($2::int[])')
    ));
    expect(invoiceLockIndex).toBeGreaterThanOrEqual(0);
    expect(itemLockIndex).toBeGreaterThan(invoiceLockIndex);
    router.assertDrained();
  });

  it('blocks before line or money writes when stock movement evidence exists', async () => {
    const router = sqlRouter({
      queries: [
        route(['SELECT uid, UPPER(role) AS role', 'FROM users'], [{ uid: ACTOR, role: 'ADMIN' }]),
        route([
          'SELECT pharmacy_order.id,pharmacy_order.facility_id,pharmacy_order.status',
          'JOIN users patient',
        ], [validOrder()]),
        route('FROM pharmacy_stock_movements', [{ id: 501 }]),
      ],
    });

    await expect(svc.compensateTerminalPharmacyFundingAuthorityTx(router.tx, {
      tenantId: TENANT, orderId: 71, actorUid: ACTOR,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_TERMINAL_FUNDING_STOCK_EXISTS',
    });

    expect(writeCalls(router)).toEqual([]);
    expect(router.execute).not.toHaveBeenCalled();
    expect(releasePharmacyCapReservationTxMock).not.toHaveBeenCalled();
    router.assertDrained();
  });

  it('blocks a stale active line before cap, allocation, or invoice mutation', async () => {
    const router = sqlRouter({
      queries: [
        route(['SELECT uid, UPPER(role) AS role', 'FROM users'], [{ uid: ACTOR, role: 'ADMIN' }]),
        route([
          'SELECT pharmacy_order.id,pharmacy_order.facility_id,pharmacy_order.status',
          'JOIN users patient',
        ], [validOrder()]),
        route('FROM pharmacy_stock_movements', []),
        ...fundingDomainLockRoutes({
          lines: [validLine({ source_authority_version: 2 })],
        }),
        ...noAdvanceAllocationRoutes(),
      ],
    });

    await expect(svc.compensateTerminalPharmacyFundingAuthorityTx(router.tx, {
      tenantId: TENANT, orderId: 71, actorUid: ACTOR,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_TERMINAL_FUNDING_LINE_AUTHORITY_STALE',
    });

    expect(writeCalls(router)).toEqual([]);
    expect(router.execute).not.toHaveBeenCalled();
    expect(releasePharmacyCapReservationTxMock).not.toHaveBeenCalled();
    router.assertDrained();
  });

  it('requires governed finance reversal when a live payment owns the draft invoice', async () => {
    const router = sqlRouter({
      queries: [
        route(['SELECT uid, UPPER(role) AS role', 'FROM users'], [{ uid: ACTOR, role: 'ADMIN' }]),
        route([
          'SELECT pharmacy_order.id,pharmacy_order.facility_id,pharmacy_order.status',
          'JOIN users patient',
        ], [validOrder()]),
        route('FROM pharmacy_stock_movements', []),
        ...fundingDomainLockRoutes(),
        ...noAdvanceAllocationRoutes(),
        route(['SELECT id FROM billing_payments', 'reversed=FALSE'], [{ id: 41 }]),
      ],
    });

    await expect(svc.compensateTerminalPharmacyFundingAuthorityTx(router.tx, {
      tenantId: TENANT, orderId: 71, actorUid: ACTOR,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_TERMINAL_FUNDING_FINANCE_REVERSAL_REQUIRED',
      details: {
        invoice_id: 21,
        invoice_item_id: 31,
        next_action: 'complete_governed_credit_refund_then_retry_terminal_order',
      },
    });

    expect(writeCalls(router)).toEqual([]);
    expect(router.execute).not.toHaveBeenCalled();
    router.assertDrained();
  });

  it('blocks live patient-advance allocation before cap, payment, task, or invoice mutation', async () => {
    const router = sqlRouter({
      queries: [
        route(['SELECT uid, UPPER(role) AS role', 'FROM users'], [{ uid: ACTOR, role: 'ADMIN' }]),
        route([
          'SELECT pharmacy_order.id,pharmacy_order.facility_id,pharmacy_order.status',
          'JOIN users patient',
        ], [validOrder()]),
        route('FROM pharmacy_stock_movements', []),
        ...fundingDomainLockRoutes(),
        route([
          'FROM pharmacy_advance_allocations allocation',
          'allocation.pharmacy_order_id=$2::int',
          'FOR UPDATE OF allocation',
        ], [advanceAllocationRow()]),
        route(['FROM pharmacy_advance_allocation_reversals', 'allocation_id=ANY($2::bigint[])'], []),
      ],
    });

    await expect(svc.compensateTerminalPharmacyFundingAuthorityTx(router.tx, {
      tenantId: TENANT, orderId: 71, actorUid: ACTOR,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_TERMINAL_FUNDING_ADVANCE_RELEASE_REQUIRED',
      details: {
        pharmacy_order_id: 71,
        live_advance_allocation_ids: ['801'],
        next_action: 'complete_governed_advance_allocation_release_or_conversion',
      },
    });

    expect(writeCalls(router)).toEqual([]);
    expect(router.execute).not.toHaveBeenCalled();
    expect(releasePharmacyCapReservationTxMock).not.toHaveBeenCalled();
    router.assertDrained();
  });

  it('fails closed when the active line loses its compare-and-set race', async () => {
    const router = sqlRouter({
      queries: [
        route(['SELECT uid, UPPER(role) AS role', 'FROM users'], [{ uid: ACTOR, role: 'ADMIN' }]),
        route([
          'SELECT pharmacy_order.id,pharmacy_order.facility_id,pharmacy_order.status',
          'JOIN users patient',
        ], [validOrder()]),
        route('FROM pharmacy_stock_movements', [], 2),
        ...fundingDomainLockRoutes(),
        ...noAdvanceAllocationRoutes(2),
        route(['SELECT id FROM billing_payments', 'reversed=FALSE'], []),
        route(['SELECT admission_id FROM pharmacy_cap_reservations', "status='ACTIVE'"], []),
        route([
          'SELECT allocation.*',
          'allocation.pharmacy_order_id=$2::int',
          'remaining_amount',
        ], []),
        route('pg_advisory_xact_lock', [{ lock_acquired: null }]),
        route('FROM pharmacy_funding_decision_events event', []),
        route(['UPDATE tasks', "status='cancelled'"], []),
        route(['UPDATE billing_invoice_items', 'source_ref_active=FALSE'], []),
      ],
      executes: [
        route(['UPDATE tpa_claim_line_decisions decision', 'invalidated_at=NOW()'], 1),
      ],
    });

    await expect(svc.compensateTerminalPharmacyFundingAuthorityTx(router.tx, {
      tenantId: TENANT, orderId: 71, actorUid: ACTOR,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_TERMINAL_FUNDING_LINE_AUTHORITY_STALE',
    });

    expect(router.query.mock.calls.some(([sql]) => sql.includes('COALESCE(SUM(line_subtotal)'))).toBe(false);
    expect(router.query.mock.calls.some(([sql]) => (
      sql.includes('UPDATE billing_invoices') && sql.includes("status='VOID'")
    ))).toBe(false);
    router.assertDrained();
  });
});

describe('allocated reversePayment funding closure', () => {
  it('requires a durable command before any allocation or payment mutation', async () => {
    const router = sqlRouter({ queries: reversePaymentPreludeRoutes() });
    usePrismaRouter(router);

    await expect(svc.reversePayment(41, {
      tenantId: TENANT,
      reversed_by: ACTOR,
      reason: 'entry correction',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'BILLING_PAYMENT_REVERSAL_COMMAND_REQUIRED',
    });

    expect(resolvePharmacyFundingPatientUidTxMock).not.toHaveBeenCalled();
    expect(lockPharmacyFundingAuthorityTxMock).toHaveBeenCalledWith(mockPrisma, {
      tenantId: TENANT,
      patientUid: PATIENT,
    });
    expect(writeCalls(router)).toEqual([]);
    expect(router.execute).not.toHaveBeenCalled();
    router.assertDrained();
  });

  it('blocks allocated reversal before the payment lock when stock already moved', async () => {
    const router = sqlRouter({
      // Prelude cut after the funded-orders read: the flow rejects before
      // the invoice, payment, and allocation locks.
      queries: reversePaymentPreludeRoutes({
        fundedOrders: [{ id: 71, status: 'READY', has_stock_movement: true }],
      }).slice(0, 6),
    });
    usePrismaRouter(router);

    await expect(svc.reversePayment(41, {
      tenantId: TENANT,
      reversed_by: ACTOR,
      reason: 'entry correction',
      commandKeySha256: COMMAND_SHA256,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_PAYMENT_ALLOCATION_REVERSAL_ORDER_NOT_ACTIONABLE',
      details: { pharmacy_order_id: 71, order_status: 'READY' },
    });

    expect(writeCalls(router)).toEqual([]);
    expect(router.execute).not.toHaveBeenCalled();
    router.assertDrained();
  });

  it('reports target mismatch and withholds later closure writes when the active line disappears', async () => {
    const childReversal = reversalRow({
      reversed_amount: '100',
      reversal_command_sha256: PAYMENT_ALLOCATION_REVERSAL_COMMAND_SHA256,
    });
    const reversalRoutes = allocationReversalRoutes({
      inserted: [],
      raced: childReversal,
    });
    const router = sqlRouter({
      queries: [
        ...reversePaymentPreludeRoutes(),
        ...reversalRoutes,
        paymentResidualFundingCapacityRoute(),
        route(['UPDATE billing_payments', 'reversed = true'], [{
          id: 41, invoice_id: null, reversed: true,
        }]),
        route([
          'SELECT pharmacy_order.id,pharmacy_order.facility_id',
          'item.source_ref_active=TRUE',
        ], []),
      ],
    });
    usePrismaRouter(router);

    await expect(svc.reversePayment(41, {
      tenantId: TENANT,
      reversed_by: ACTOR,
      reason: 'entry correction',
      commandKeySha256: COMMAND_SHA256,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_PAYMENT_ALLOCATION_REVERSAL_TARGET_MISMATCH',
    });

    expect(router.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO tasks'))).toBe(false);
    expect(router.query.mock.calls.some(([sql]) => (
      sql.includes('INSERT INTO pharmacy_funding_decision_events')
    ))).toBe(false);
    expectDerivedAllocationReversalCommand(router, childReversal);
    router.assertDrained();
  });

  it('invalidates stale funding and opens an exact recovery task when a balance remains', async () => {
    const childReversal = reversalRow({
      reversed_amount: '100',
      reversal_command_sha256: PAYMENT_ALLOCATION_REVERSAL_COMMAND_SHA256,
    });
    const currentEvent = {
      id: 701,
      event_type: 'FUNDING_RESOLVED',
      authority_generation: 1,
      admission_id: null,
      invoice_id: 21,
      invoice_item_id: 31,
      tpa_claim_id: null,
      billing_payment_id: 41,
      task_id: 91,
      amount: '100',
      evidence: { contract: 'pharmacy_funding_authority_v1' },
    };
    const router = sqlRouter({
      queries: [
        ...reversePaymentPreludeRoutes(),
        ...allocationReversalRoutes({ inserted: [childReversal] }),
        paymentResidualFundingCapacityRoute(),
        route(['UPDATE billing_payments', 'reversed = true'], [{
          id: 41, invoice_id: 21, reversed: true,
        }]),
        ...paymentInvoiceRecomputeRoutes(),
        route([
          'SELECT pharmacy_order.id,pharmacy_order.facility_id',
          'item.source_ref_active=TRUE',
        ], [orderAuthorityRow()]),
        route([
          'FROM pharmacy_payment_allocations allocation',
          'payment.patient_uid=$7::uuid',
        ], [liveAllocation({ allocated_amount: '20' })]),
        route('pg_advisory_xact_lock', [{ lock_acquired: null }], 2),
        route('FROM pharmacy_funding_decision_events event', [currentEvent], 2),
        route('INSERT INTO pharmacy_funding_decision_events', ({ params }) => [{
          id: 702,
          event_type: params[4],
          evidence: JSON.parse(params[14]),
          authority_generation: params[16],
          supersedes_event_id: params[17],
        }]),
        route('INSERT INTO tasks', ({ params }) => [{
          id: 92,
          status: 'open',
          assigned_to_role: params[6],
          metadata: JSON.parse(params[8]),
        }]),
      ],
      executes: [
        route(['UPDATE billing_invoices', 'SET amount_paid = $1::numeric'], 1),
      ],
    });
    usePrismaRouter(router);

    await expect(svc.reversePayment(41, {
      tenantId: TENANT,
      reversed_by: ACTOR,
      reason: 'entry correction',
      commandKeySha256: COMMAND_SHA256,
    })).resolves.toMatchObject({ id: 41, reversed: true });

    const eventInsert = router.query.mock.calls.find(([sql]) => (
      sql.includes('INSERT INTO pharmacy_funding_decision_events')
    ));
    expect(eventInsert[5]).toBe('AUTHORITY_INVALIDATED');
    expect(JSON.parse(eventInsert[15])).toMatchObject({
      invalidation_reason: 'billing_payment_allocation_reversed',
      invalidation_command_key_sha256: COMMAND_SHA256,
      prior_funding_event_id: 701,
    });
    const taskInsert = router.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO tasks'));
    const taskMetadata = JSON.parse(taskInsert[9]);
    expect(taskMetadata).toMatchObject({
      contract: 'pharmacy_funding_task_v1',
      task_type: 'posted_payment',
      stage: 'payment_reversal_recovery',
      pharmacy_order_id: 71,
      invoice_id: 21,
      invoice_item_id: 31,
      amount_outstanding: 80,
      permitted_roles: ['FINANCE_INCHARGE', 'BILLING_INCHARGE', 'ADMIN', 'SUPER_ADMIN'],
    });
    expectDerivedAllocationReversalCommand(router, childReversal);
    router.assertDrained();
  });

  it('re-materializes and records funded authority when other posted allocation fully covers it', async () => {
    const childReversal = reversalRow({
      reversed_amount: '100',
      reversal_command_sha256: PAYMENT_ALLOCATION_REVERSAL_COMMAND_SHA256,
    });
    const remainingFunding = [liveAllocation({ allocated_amount: '100' })];
    const router = sqlRouter({
      queries: [
        ...reversePaymentPreludeRoutes(),
        ...allocationReversalRoutes({ inserted: [childReversal] }),
        paymentResidualFundingCapacityRoute(),
        route(['UPDATE billing_payments', 'reversed = true'], [{
          id: 41, invoice_id: 21, reversed: true,
        }]),
        ...paymentInvoiceRecomputeRoutes(),
        route([
          'SELECT pharmacy_order.id,pharmacy_order.facility_id',
          'item.source_ref_active=TRUE',
        ], [orderAuthorityRow()]),
        route([
          'FROM pharmacy_payment_allocations allocation',
          'payment.patient_uid=$7::uuid',
        ], remainingFunding, 3),
        route(['SELECT uid, UPPER(role) AS role', 'FROM users'], [{ uid: ACTOR, role: 'ADMIN' }]),
        route([
          'FROM pharmacy_orders po',
          'po.facility_id=$3::int',
        ], [validOrder({ status: 'READY' })]),
        route(['SELECT id,patient_uid,status', 'FROM admissions'], []),
        route(['SELECT item.id,item.invoice_id', "item.source_ref_type='pharmacy_order'"], [{
          id: 31, invoice_id: 21,
        }]),
        route(['FROM billing_invoices', 'id=ANY($2::int[])', 'FOR UPDATE'], [validInvoice()]),
        route(['FROM billing_invoice_items', 'id=ANY($2::int[])', 'FOR UPDATE'], [validLine()]),
        route(['FROM billing_payments', 'invoice_id=ANY($2::int[])'], []),
        route(['FROM billing_refunds', 'invoice_id=ANY($2::int[])'], []),
        route(['FROM billing_advance_settlements', 'invoice_id=ANY($2::int[])'], []),
        ...noAdvanceAllocationRoutes(),
        route(['UPDATE billing_invoice_items', 'source_authority_version=$5::int'], [validLine()]),
        route(['COALESCE(SUM(line_subtotal), 0)', 'FROM billing_invoice_items'], [{
          subtotal: '100', cgst: '0', sgst: '0', igst: '0',
        }]),
        route(['SELECT discount_amount', 'FROM billing_invoices'], [{
          discount_amount: '0', credit_note_amount: '0', amount_paid: '0',
        }]),
        route(['SELECT admission_id, patient_uid, tenant_id', 'FROM billing_invoices'], []),
        route(['UPDATE tasks', "status='completed'"], [{
          id: 92, status: 'completed', assigned_to_role: 'FINANCE_INCHARGE', metadata: {},
        }]),
        route('pg_advisory_xact_lock', [{ lock_acquired: null }]),
        route('FROM pharmacy_funding_decision_events event', []),
        route('INSERT INTO pharmacy_funding_decision_events', ({ params }) => [{
          id: 703,
          event_type: params[4],
          evidence: JSON.parse(params[14]),
          authority_generation: params[16],
          supersedes_event_id: params[17],
        }]),
      ],
      executes: [
        route(['UPDATE billing_invoices', 'SET amount_paid = $1::numeric'], 1),
        route(['UPDATE billing_invoices', 'SET subtotal = $1::numeric'], 1),
        route(['INSERT INTO pharmacy_funding_decision_events', "'LINE_MATERIALIZED'"], 1),
      ],
    });
    usePrismaRouter(router);

    await expect(svc.reversePayment(41, {
      tenantId: TENANT,
      reversed_by: ACTOR,
      reason: 'entry correction',
      commandKeySha256: COMMAND_SHA256,
    })).resolves.toMatchObject({ id: 41, reversed: true });

    expect(router.query.mock.calls.filter(([sql]) => (
      sql.includes('payment.patient_uid=$7::uuid')
    ))).toHaveLength(3);
    const completion = router.query.mock.calls.find(([sql]) => (
      sql.includes('UPDATE tasks') && sql.includes("status='completed'")
    ));
    expect(completion.slice(1)).toEqual([
      TENANT,
      'pharmacy_posted_payment',
      '71',
      expect.any(String),
      null,
      'pharmacy_funding_task_v1',
      'posted_payment',
      21,
      31,
      null,
      3,
      ITEMS_SHA256,
      ['payment_posting', 'patient_responsibility_payment', 'payment_reversal_recovery'],
    ]);
    expect(JSON.parse(completion[4])).toMatchObject({
      domain_evidence: {
        contract: 'pharmacy_funding_authority_v1',
        pharmacy_order_id: 71,
        invoice_id: 21,
        invoice_item_id: 31,
        payment_ids: [42],
        payment_allocation_ids: [52],
        allocated_payment_amount: 100,
        combined_authority_amount: 100,
      },
    });
    const fundingEvent = router.query.mock.calls.find(([sql]) => (
      sql.includes('INSERT INTO pharmacy_funding_decision_events')
    ));
    expect(fundingEvent[5]).toBe('FUNDING_RESOLVED');
    expect(JSON.parse(fundingEvent[15])).toMatchObject({
      contract: 'pharmacy_funding_authority_v1',
      payment_ids: [42],
      payment_allocation_ids: [52],
    });
    expectDerivedAllocationReversalCommand(router, childReversal);
    router.assertDrained();
  });
});
