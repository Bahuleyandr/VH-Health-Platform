import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';

const queryMock = jest.fn();
const executeMock = jest.fn();
const setTenantTxMock = jest.fn();
const lockSubstitutionAuthorityMock = jest.fn();
const resolvePatientUidMock = jest.fn();
const lockAuthorityMock = jest.fn();
const lockAdmissionMock = jest.fn();
const releaseCapReservationMock = jest.fn();
const clinicalOrderItemsSha256Mock = jest.fn();

const mockTx = {
  $queryRawUnsafe: queryMock,
  $executeRawUnsafe: executeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockTx,
  isTenantTransactionClient: (value) => value === mockTx,
  pickTenantClient: () => mockTx,
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockTx),
  setTenant: async (_tenantId, fn) => fn(mockTx),
  setTenantTx: setTenantTxMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/billing/ledger/ledgerAuthoritativeMode.js', () => ({
  resolveLedgerModeForTenant: jest.fn(async () => 'shadow'),
  resolveLedgerWiring: jest.fn(async () => ({
    mode: 'shadow',
    sameTx: false,
    postCommit: true,
    skip: false,
  })),
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacyCapService.js', () => ({
  lockCounterFundingSubstitutionAuthorityTx: lockSubstitutionAuthorityMock,
  lockPharmacyFundingAdmissionTx: lockAdmissionMock,
  lockPharmacyFundingAuthorityTx: lockAuthorityMock,
  releasePharmacyCapReservationTx: releaseCapReservationMock,
  resolvePharmacyFundingPatientUidTx: resolvePatientUidMock,
}));

jest.unstable_mockModule(
  '../../services/pharmacy/pharmacistVerificationService.js',
  () => ({ clinicalOrderItemsSha256: clinicalOrderItemsSha256Mock }),
);

const {
  getPharmacyFundingReconciliationCase,
  getPharmacyFundingRecovery,
  retryPharmacyFundingTask,
} = await import('../../services/billing/billingV2Service.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000941';
const PATIENT_UID = '11111111-1111-4111-8111-111111111941';
const ACTOR_UID = '22222222-2222-4222-8222-222222222941';
const ORDER_ID = 941;
const TASK_ID = 942;
const INVOICE_ID = 943;
const INVOICE_ITEM_ID = 944;
const PAYMENT_ID = 945;
const ALLOCATION_ID = 946;
const ORDER_VERSION = 7;
const ORDER_ITEMS_SHA256 = 'b'.repeat(64);
const RETRY_COMMAND_SHA256 = 'a'.repeat(64);

function pharmacyFundingHash(eventType, values) {
  return createHash('sha256')
    .update(JSON.stringify({ event_type: eventType, ...values }))
    .digest('hex');
}

function baseTask() {
  return {
    id: TASK_ID,
    status: 'open',
    assigned_to_role: 'FINANCE_INCHARGE',
    related_resource_type: 'pharmacy_posted_payment',
    related_resource_id: String(ORDER_ID),
    metadata: {
      contract: 'pharmacy_funding_task_v1',
      task_type: 'posted_payment',
      pharmacy_order_id: ORDER_ID,
      admission_id: null,
      invoice_id: INVOICE_ID,
      invoice_item_id: INVOICE_ITEM_ID,
      tpa_claim_id: null,
      order_version: ORDER_VERSION,
      order_items_sha256: ORDER_ITEMS_SHA256,
      authoritative_amount: 100,
      amount_outstanding: 100,
    },
  };
}

function baseOrder() {
  return {
    id: ORDER_ID,
    patient_id: 31,
    uid: PATIENT_UID,
    patient_name: 'Coverage Patient',
    patient_phone: '9000000941',
    patient_uid: PATIENT_UID,
    order_number: 'RX-941',
    facility_id: 41,
    payment_mode: 'cash',
    payment_metadata: { payment_mode: 'cash' },
    total_amount: 100,
    inventory_authority_version: ORDER_VERSION,
    items_list: [{ medication_id: 51, quantity: 1 }],
    status: 'PENDING',
    funding_admission_id: null,
    funding_admission_order_version: null,
    funding_admission_items_sha256: null,
  };
}

function baseSourceLine() {
  return {
    id: INVOICE_ITEM_ID,
    invoice_id: INVOICE_ID,
    line_total: 100,
    invoice_status: 'DRAFT',
    patient_uid: PATIENT_UID,
    admission_id: null,
    invoice_tenant_id: TENANT_ID,
    source_ref_type: 'pharmacy_order',
    source_ref_id: ORDER_ID,
    source_ref_active: true,
    source_authority_version: ORDER_VERSION,
    source_authority_sha256: ORDER_ITEMS_SHA256,
  };
}

function baseInvoice() {
  return {
    id: INVOICE_ID,
    status: 'DRAFT',
    patient_uid: PATIENT_UID,
    admission_id: null,
    tenant_id: TENANT_ID,
    subtotal: 100,
    cgst_amount: 0,
    sgst_amount: 0,
    igst_amount: 0,
    total_amount: 100,
    amount_paid: 0,
    amount_due: 100,
  };
}

function requestSha256(paymentId = PAYMENT_ID) {
  return pharmacyFundingHash('POSTED_PAYMENT_RETRY_REQUEST', {
    task_id: TASK_ID,
    order_id: ORDER_ID,
    invoice_item_id: INVOICE_ITEM_ID,
    payment_id: paymentId,
    order_version: ORDER_VERSION,
    order_items_sha256: ORDER_ITEMS_SHA256,
    actor_uid: ACTOR_UID,
  });
}

function baseReceipt(overrides = {}) {
  return {
    command_type: 'POSTED_PAYMENT_RETRY',
    task_id: TASK_ID,
    task_resource_type: 'pharmacy_posted_payment',
    task_resource_id: String(ORDER_ID),
    pharmacy_order_id: ORDER_ID,
    invoice_item_id: INVOICE_ITEM_ID,
    tpa_claim_id: null,
    request_sha256: requestSha256(),
    status: 'IN_PROGRESS',
    response_body: null,
    ...overrides,
  };
}

function buildState() {
  const task = baseTask();
  const order = baseOrder();
  return {
    taskPreRows: [task],
    lockedTaskRows: [structuredClone(task)],
    orderPreRows: [order],
    materializeOrderRows: [structuredClone(order)],
    retryClaimRows: [{ id: 71 }],
    actorRows: [{ uid: ACTOR_UID, role: 'FINANCE_INCHARGE' }],
    admissionRows: [],
    invoiceRows: [baseInvoice()],
    sourceLineRows: [baseSourceLine()],
    paymentRows: [{
      id: PAYMENT_ID,
      amount: 100,
      mode: 'CASH',
      reference: 'PAYMENT-945',
      collected_at: '2026-08-30T09:41:00.000Z',
    }],
    allocatedByPaymentRows: [],
    allocations: [],
    receipt: null,
    completeCommandConflict: false,
    currentAuthorityRows: [],
    recoveryRows: [],
    reconciliationRows: [],
    mutationLog: [],
  };
}

let state;

function compactSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function recordMutation(kind, sql, params) {
  state.mutationLog.push({ kind, sql: compactSql(sql), params });
}

function unhandledSql(kind, sql, params) {
  throw new Error(`Unhandled ${kind} SQL: ${compactSql(sql)} :: ${JSON.stringify(params)}`);
}

function routeQuery(sql, ...params) {
  const text = compactSql(sql);

  if (text.startsWith('SELECT patient.uid FROM users patient')) {
    return [{ uid: PATIENT_UID }];
  }
  if (text.includes('FROM pharmacy_funding_commands')
      && text.includes("command_type='SUBSTITUTION_FUNDING_APPROVAL'")) {
    return [];
  }
  if (text.includes('FROM approvals')
      && text.includes("approval_kind='pharmacy_substitution_funding_reauthorisation'")) {
    return [];
  }
  if (text.includes('FROM tasks') && text.includes('related_resource_type=ANY($3::text[])')
      && text.includes("metadata->>'contract'=$4")) {
    return [];
  }
  if (text.includes('SELECT * FROM tasks')
      && text.includes("related_resource_type='pharmacy_posted_payment'")) {
    return text.includes('related_resource_id=$3')
      ? state.lockedTaskRows
      : state.taskPreRows;
  }
  if (text.includes('SELECT po.id,po.patient_id,po.facility_id,po.payment_mode')) {
    return state.orderPreRows;
  }
  if (text.includes('SELECT po.id,po.patient_id,po.uid,po.patient_name')) {
    return state.materializeOrderRows;
  }
  if (text.startsWith('SELECT item.id,item.invoice_id FROM billing_invoice_items item')) {
    return state.sourceLineRows.map((line) => ({ id: line.id, invoice_id: line.invoice_id }));
  }
  if (text.startsWith('SELECT id,invoice_id,admission_id,patient_uid,status FROM tpa_claims')) {
    return state.retryClaimRows;
  }
  if (text.startsWith('SELECT uid, UPPER(role) AS role FROM users')) {
    return state.actorRows;
  }
  if (text.startsWith('SELECT id,patient_uid,status FROM admissions')) {
    return state.admissionRows;
  }
  if (text.includes('FROM billing_invoices') && text.includes('id=ANY($2::int[])')
      && text.endsWith('FOR UPDATE')) {
    return state.invoiceRows;
  }
  if (text.includes('FROM billing_invoice_items') && text.includes('id=ANY($2::int[])')
      && text.endsWith('FOR UPDATE')) {
    return state.sourceLineRows;
  }
  if (text.includes('FROM billing_payments') && text.includes('invoice_id=ANY($2::int[])')) {
    return [];
  }
  if (text.includes('FROM billing_refunds') && text.includes('invoice_id=ANY($2::int[])')) {
    return [];
  }
  if (text.includes('FROM billing_advance_settlements')
      && text.includes('invoice_id=ANY($2::int[])')) {
    return [];
  }
  if (text.includes('FROM pharmacy_advance_allocations allocation')
      && text.includes('allocation.pharmacy_order_id=$2::int')) {
    return [];
  }
  if (text.startsWith('UPDATE billing_invoice_items SET description=')) {
    recordMutation('query', sql, params);
    return state.sourceLineRows;
  }
  if (text.includes('COALESCE(SUM(line_subtotal), 0)::numeric AS subtotal')) {
    return [{ subtotal: 100, cgst: 0, sgst: 0, igst: 0 }];
  }
  if (text.startsWith('SELECT discount_amount, credit_note_amount, amount_paid')) {
    return [{ discount_amount: 0, credit_note_amount: 0, amount_paid: 100 }];
  }
  if (text.startsWith('SELECT admission_id, patient_uid, tenant_id FROM billing_invoices')) {
    return [{ admission_id: null, patient_uid: PATIENT_UID, tenant_id: TENANT_ID }];
  }
  if (text.startsWith('SELECT allocation.id AS allocation_id,')) {
    return state.allocations;
  }
  if (text.startsWith('INSERT INTO tasks')
      && text.includes("related_resource_type, related_resource_id")) {
    recordMutation('query', sql, params);
    return state.lockedTaskRows;
  }
  if (text.startsWith('SELECT id FROM billing_invoices') && text.endsWith('FOR UPDATE')) {
    return [{ id: INVOICE_ID }];
  }
  if (text.startsWith('SELECT payment.id,payment.amount,payment.mode')) {
    return state.paymentRows;
  }
  if (text.startsWith('SELECT allocation.billing_payment_id,')) {
    return state.allocatedByPaymentRows;
  }
  if (text.startsWith('INSERT INTO pharmacy_payment_allocations')) {
    recordMutation('query', sql, params);
    state.allocations = [{
      allocation_id: ALLOCATION_ID,
      allocated_amount: Number(params[7]),
      payment_id: Number(params[4]),
      mode: 'CASH',
      reference: 'PAYMENT-945',
      collected_at: '2026-08-30T09:41:00.000Z',
    }];
    return [{ id: ALLOCATION_ID }];
  }
  if (text.startsWith("UPDATE tasks SET status='completed'")) {
    recordMutation('query', sql, params);
    return [{
      id: TASK_ID,
      status: 'completed',
      assigned_to_role: 'FINANCE_INCHARGE',
      metadata: baseTask().metadata,
      completed_at: '2026-08-30T09:42:00.000Z',
    }];
  }
  if (text.startsWith('SELECT pg_advisory_xact_lock(hashtextextended(')
      && text.includes('vh:pharmacy_funding_event_chain:')) {
    return [{ lock_acquired: '' }];
  }
  if (text.startsWith('SELECT pg_advisory_xact_lock(hashtextextended($1::text,753)')) {
    return [{ lock_acquired: '' }];
  }
  // patientMergeStabilityLock takes a shared tenant-wide merge-stability lock
  // inside the billingV2Service setTenantTx flows before pharmacy funding work.
  // Posted-payment completion now rechecks invoice refund-source headroom
  // (billingV2Service resolveRefundSourceAuthorityTx, invoice branch). Return
  // generous headroom so the happy paths proceed; the guard tests pin their own
  // failures elsewhere.
  if (text.includes('AS source_amount')
      && text.includes('AS active_refunds')
      && text.includes('AS pharmacy_allocations')) {
    return [{ source_amount: '1000', active_refunds: '0', pharmacy_allocations: '0' }];
  }
  if (text.startsWith('SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(')
      && text.includes('hashtextextended($1::text, 0)')) {
    return [{ locked: 1 }];
  }
  if (text.startsWith('SELECT event.* FROM pharmacy_funding_decision_events event')) {
    return state.currentAuthorityRows;
  }
  if (text.startsWith('INSERT INTO pharmacy_funding_decision_events')
      && text.includes('authority_generation,supersedes_event_id')) {
    recordMutation('query', sql, params);
    return [{
      id: 947,
      event_type: params[4],
      command_key_sha256: params[13],
      evidence: JSON.parse(params[14]),
    }];
  }
  if (text.startsWith('SELECT * FROM pharmacy_funding_commands')) {
    return state.receipt ? [state.receipt] : [];
  }
  if (text.startsWith('UPDATE pharmacy_funding_commands')
      && text.includes("SET status='COMPLETE'")) {
    recordMutation('query', sql, params);
    if (state.completeCommandConflict) return [];
    state.receipt = {
      ...(state.receipt || baseReceipt()),
      status: 'COMPLETE',
      response_body: JSON.parse(params[2]),
    };
    return [state.receipt];
  }
  if (text.startsWith('SELECT task.id AS task_id,task.status AS task_status,')) {
    return state.recoveryRows
      .filter((row) => row.metadata?.contract == null
        || row.metadata.contract === params[4])
      .sort((left, right) => Number(right.task_id) - Number(left.task_id))
      .slice(0, 1);
  }
  if (text.startsWith('SELECT reconciliation.*,task.status AS task_status,')) {
    return state.reconciliationRows;
  }

  return unhandledSql('query', sql, params);
}

function routeExecute(sql, ...params) {
  const text = compactSql(sql);

  if (text.startsWith('INSERT INTO pharmacy_funding_commands')) {
    recordMutation('execute', sql, params);
    if (state.receipt == null) {
      state.receipt = {
        command_type: params[2],
        task_id: params[3],
        task_resource_type: params[4],
        task_resource_id: params[5],
        pharmacy_order_id: params[6],
        invoice_item_id: params[7],
        tpa_claim_id: params[8],
        request_sha256: params[9],
        status: 'IN_PROGRESS',
        response_body: null,
      };
    }
    return 1;
  }
  if (text.startsWith('UPDATE billing_invoices SET subtotal =')) {
    recordMutation('execute', sql, params);
    return 1;
  }
  if (text.startsWith('INSERT INTO pharmacy_funding_decision_events')
      && text.includes("'LINE_MATERIALIZED'")) {
    recordMutation('execute', sql, params);
    return 1;
  }
  if (text.startsWith('UPDATE tasks SET status=CASE WHEN $4::boolean')) {
    recordMutation('execute', sql, params);
    return 1;
  }

  return unhandledSql('execute', sql, params);
}

function retryArgs(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    taskId: TASK_ID,
    actorUid: ACTOR_UID,
    paymentId: PAYMENT_ID,
    commandKeySha256: RETRY_COMMAND_SHA256,
    ...overrides,
  };
}

function mutationsMatching(fragment) {
  return state.mutationLog.filter(({ sql }) => sql.includes(fragment));
}

function expectNoMutation() {
  expect(state.mutationLog).toEqual([]);
}

beforeEach(() => {
  state = buildState();
  queryMock.mockReset().mockImplementation(routeQuery);
  executeMock.mockReset().mockImplementation(routeExecute);
  setTenantTxMock.mockReset().mockImplementation(async (_tenantId, fn) => fn(mockTx));
  resolvePatientUidMock.mockReset().mockResolvedValue(PATIENT_UID);
  lockAuthorityMock.mockReset().mockResolvedValue(undefined);
  lockAdmissionMock.mockReset().mockResolvedValue({
    id: 81,
    patient_uid: PATIENT_UID,
    status: 'admitted',
  });
  releaseCapReservationMock.mockReset().mockResolvedValue(null);
  clinicalOrderItemsSha256Mock.mockReset().mockReturnValue(ORDER_ITEMS_SHA256);
});

describe('retryPharmacyFundingTask', () => {
  it.each([
    ['', 'missing'],
    ['f'.repeat(63), 'short'],
    ['g'.repeat(64), 'non-hex'],
  ])('rejects a %s durable command SHA before opening a tenant transaction (%s)', async (
    commandKeySha256,
  ) => {
    await expect(retryPharmacyFundingTask(retryArgs({ commandKeySha256 })))
      .rejects.toMatchObject({
        statusCode: 400,
        code: 'PHARMACY_FUNDING_RETRY_COMMAND_REQUIRED',
      });

    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('replays the exact COMPLETE receipt without materializing or allocating twice', async () => {
    const priorResponse = {
      status: 'funded',
      invoiceId: INVOICE_ID,
      invoiceItemId: INVOICE_ITEM_ID,
      paymentIds: [PAYMENT_ID],
      retryCommandSha256: RETRY_COMMAND_SHA256,
      requestSha256: requestSha256(),
    };
    state.receipt = baseReceipt({
      status: 'COMPLETE',
      response_body: priorResponse,
    });

    const result = await retryPharmacyFundingTask(retryArgs());

    expect(result).toEqual({ ...priorResponse, replayed: true });
    expect(state.receipt.request_sha256).toBe(requestSha256());
    expect(mutationsMatching('INSERT INTO pharmacy_funding_commands')).toHaveLength(1);
    expect(mutationsMatching('INSERT INTO pharmacy_payment_allocations')).toHaveLength(0);
    expect(mutationsMatching("SET status='COMPLETE'")).toHaveLength(0);
    expect(clinicalOrderItemsSha256Mock).toHaveBeenCalledTimes(1);
  });

  it('allocates an exact posted payment, re-resolves authority, and completes the command', async () => {
    const result = await retryPharmacyFundingTask(retryArgs());

    expect(result).toMatchObject({
      status: 'funded',
      collectedAmount: 100,
      fundedAmount: 100,
      fundingSource: 'billing_payment',
      fundingReference: `payments:${PAYMENT_ID}`,
      fundingTpaClaimId: null,
      invoiceId: INVOICE_ID,
      invoiceItemId: INVOICE_ITEM_ID,
      paymentIds: [PAYMENT_ID],
      replayed: false,
      retryCommandSha256: RETRY_COMMAND_SHA256,
      requestSha256: requestSha256(),
    });
    expect(result.task).toMatchObject({ id: TASK_ID, status: 'completed' });
    expect(result.fundingRecovery).toBeNull();
    expect(result.authorityEvidence).toMatchObject({
      contract: 'pharmacy_funding_authority_v1',
      pharmacy_order_id: ORDER_ID,
      invoice_id: INVOICE_ID,
      invoice_item_id: INVOICE_ITEM_ID,
      payment_ids: [PAYMENT_ID],
      payment_allocation_ids: [ALLOCATION_ID],
      order_version: ORDER_VERSION,
      order_items_sha256: ORDER_ITEMS_SHA256,
      authority_generation: 1,
      supersedes_event_id: null,
    });

    const commandClaim = mutationsMatching('INSERT INTO pharmacy_funding_commands');
    expect(commandClaim).toHaveLength(1);
    expect(commandClaim[0].params).toEqual([
      TENANT_ID,
      RETRY_COMMAND_SHA256,
      'POSTED_PAYMENT_RETRY',
      TASK_ID,
      'pharmacy_posted_payment',
      String(ORDER_ID),
      ORDER_ID,
      INVOICE_ITEM_ID,
      null,
      requestSha256(),
      ACTOR_UID,
    ]);

    const allocation = mutationsMatching('INSERT INTO pharmacy_payment_allocations');
    expect(allocation).toHaveLength(1);
    expect(allocation[0].params.slice(0, 10)).toEqual([
      TENANT_ID,
      ORDER_ID,
      INVOICE_ID,
      INVOICE_ITEM_ID,
      PAYMENT_ID,
      ORDER_VERSION,
      ORDER_ITEMS_SHA256,
      100,
      RETRY_COMMAND_SHA256,
      ACTOR_UID,
    ]);

    const expectedLineCommand = pharmacyFundingHash('LINE_MATERIALIZED', {
      tenant_id: TENANT_ID,
      order_id: ORDER_ID,
      order_version: ORDER_VERSION,
      order_items_sha256: ORDER_ITEMS_SHA256,
      invoice_item_id: INVOICE_ITEM_ID,
    });
    const lineEvents = mutationsMatching("'LINE_MATERIALIZED'");
    expect(lineEvents).toHaveLength(2);
    expect(lineEvents.map(({ params }) => params[10]))
      .toEqual([expectedLineCommand, expectedLineCommand]);

    const authorityEvent = mutationsMatching('authority_generation,supersedes_event_id');
    expect(authorityEvent).toHaveLength(1);
    const authorityEvidence = JSON.parse(authorityEvent[0].params[14]);
    const canonicalEvidence = { ...authorityEvidence };
    delete canonicalEvidence.authority_generation;
    delete canonicalEvidence.supersedes_event_id;
    delete canonicalEvidence.authority_fingerprint_sha256;
    expect(authorityEvidence.authority_fingerprint_sha256)
      .toBe(pharmacyFundingHash('FUNDING_RESOLVED', canonicalEvidence));
    expect(authorityEvent[0].params[13]).toBe(pharmacyFundingHash('FUNDING_RESOLVED', {
      authority_fingerprint_sha256: authorityEvidence.authority_fingerprint_sha256,
      authority_generation: 1,
      supersedes_event_id: null,
    }));

    const completion = mutationsMatching('UPDATE pharmacy_funding_commands');
    expect(completion).toHaveLength(1);
    expect(completion[0].params.slice(0, 2)).toEqual([TENANT_ID, RETRY_COMMAND_SHA256]);
    expect(JSON.parse(completion[0].params[2])).toEqual(result);
    expect(clinicalOrderItemsSha256Mock).toHaveBeenCalledTimes(3);
    expect(resolvePatientUidMock).toHaveBeenCalledTimes(3);
    expect(lockAuthorityMock).toHaveBeenCalledTimes(3);
  });

  it('returns and receipts the governed terminal response without allocating money', async () => {
    state.orderPreRows[0].status = 'DISPENSED';
    state.materializeOrderRows[0].status = 'DISPENSED';

    const result = await retryPharmacyFundingTask(retryArgs());

    expect(result).toEqual({
      status: 'closed',
      collectedAmount: 0,
      fundedAmount: 0,
      fundingSource: null,
      fundingReference: null,
      fundingTpaClaimId: null,
      invoiceId: null,
      invoiceItemId: null,
      paymentIds: [],
      task: null,
      fundingRecovery: null,
      authorityEvidence: null,
      invalidatedAuthority: {
        releasedCapReservation: null,
        reversedAllocationIds: [],
      },
      replayed: false,
      retryCommandSha256: RETRY_COMMAND_SHA256,
      requestSha256: requestSha256(),
    });
    expect(mutationsMatching('UPDATE tasks SET status=CASE')).toHaveLength(1);
    expect(mutationsMatching('INSERT INTO pharmacy_payment_allocations')).toHaveLength(0);
    expect(mutationsMatching('UPDATE pharmacy_funding_commands')).toHaveLength(1);
  });

  it('rejects a command receipt whose request SHA is bound to different authority', async () => {
    state.receipt = baseReceipt({ request_sha256: 'c'.repeat(64) });

    await expect(retryPharmacyFundingTask(retryArgs())).rejects.toMatchObject({
      statusCode: 422,
      code: 'PHARMACY_FUNDING_COMMAND_MISMATCH',
    });

    expect(mutationsMatching('INSERT INTO pharmacy_funding_commands')).toHaveLength(1);
    expect(mutationsMatching('INSERT INTO pharmacy_payment_allocations')).toHaveLength(0);
    expect(mutationsMatching('UPDATE pharmacy_funding_commands')).toHaveLength(0);
  });

  it('fails closed when the task is stale relative to the order tuple', async () => {
    state.taskPreRows[0].metadata.order_version = ORDER_VERSION - 1;

    await expect(retryPharmacyFundingTask(retryArgs())).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_PAYMENT_TASK_AUTHORITY_STALE',
    });

    expectNoMutation();
    expect(lockAdmissionMock).not.toHaveBeenCalled();
  });

  it('fails closed when the governed admission binding changed', async () => {
    state.taskPreRows[0].metadata.admission_id = 81;
    state.orderPreRows[0].funding_admission_id = 82;
    state.orderPreRows[0].funding_admission_order_version = ORDER_VERSION;
    state.orderPreRows[0].funding_admission_items_sha256 = ORDER_ITEMS_SHA256;

    await expect(retryPharmacyFundingTask(retryArgs())).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_PAYMENT_TASK_AUTHORITY_STALE',
    });

    expectNoMutation();
    expect(lockAdmissionMock).not.toHaveBeenCalled();
  });

  it('fails closed when the exact editable invoice line is stale', async () => {
    state.sourceLineRows = [];

    await expect(retryPharmacyFundingTask(retryArgs())).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_PAYMENT_TASK_AUTHORITY_STALE',
    });

    expectNoMutation();
  });

  it('fails closed when the exact TPA claim binding is stale', async () => {
    state.taskPreRows[0].metadata.admission_id = 81;
    state.taskPreRows[0].metadata.tpa_claim_id = 91;
    state.orderPreRows[0].funding_admission_id = 81;
    state.orderPreRows[0].funding_admission_order_version = ORDER_VERSION;
    state.orderPreRows[0].funding_admission_items_sha256 = ORDER_ITEMS_SHA256;
    state.admissionRows = [{ id: 81, patient_uid: PATIENT_UID, status: 'admitted' }];
    state.invoiceRows[0].admission_id = 81;
    state.sourceLineRows[0].admission_id = 81;
    state.retryClaimRows = [];

    await expect(retryPharmacyFundingTask(retryArgs())).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_PAYMENT_TASK_AUTHORITY_STALE',
    });

    expectNoMutation();
    expect(lockAdmissionMock).toHaveBeenCalledWith(mockTx, {
      tenantId: TENANT_ID,
      admissionId: 81,
      patientUid: PATIENT_UID,
    });
  });

  it('fails closed when the locked task no longer matches its pre-read authority', async () => {
    state.lockedTaskRows[0].metadata.invoice_item_id = INVOICE_ITEM_ID + 1;

    await expect(retryPharmacyFundingTask(retryArgs())).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_PAYMENT_TASK_AUTHORITY_MISMATCH',
    });

    expectNoMutation();
  });

  it.each(['completed', 'cancelled'])('rejects a %s retry task after claiming its rollback-safe receipt', async (
    status,
  ) => {
    state.lockedTaskRows[0].status = status;

    await expect(retryPharmacyFundingTask(retryArgs())).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_PAYMENT_TASK_ALREADY_COMPLETED',
    });

    expect(mutationsMatching('INSERT INTO pharmacy_funding_commands')).toHaveLength(1);
    expect(mutationsMatching('INSERT INTO pharmacy_payment_allocations')).toHaveLength(0);
    expect(mutationsMatching('UPDATE pharmacy_funding_commands')).toHaveLength(0);
  });

  it('throws the exact state-conflict code when command completion loses its claimed state', async () => {
    state.completeCommandConflict = true;

    await expect(retryPharmacyFundingTask(retryArgs())).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_FUNDING_COMMAND_STATE_CONFLICT',
    });

    expect(mutationsMatching('INSERT INTO pharmacy_payment_allocations')).toHaveLength(1);
    expect(mutationsMatching('authority_generation,supersedes_event_id')).toHaveLength(1);
    expect(mutationsMatching('UPDATE pharmacy_funding_commands')).toHaveLength(1);
  });
});

describe('getPharmacyFundingRecovery', () => {
  const recoveryRow = {
    task_id: TASK_ID,
    task_status: 'blocked',
    invoice_item_id: INVOICE_ITEM_ID,
    invoice_id: INVOICE_ID,
    source_authority_sha256: ORDER_ITEMS_SHA256,
    order_version: ORDER_VERSION,
    order_items_list: [{ medication_id: 51, quantity: 1 }],
    metadata: { contract: 'pharmacy_funding_task_v1', task_type: 'posted_payment' },
  };

  it('returns the exact recovery record when its current order hash matches', async () => {
    state.recoveryRows = [recoveryRow];

    const result = await getPharmacyFundingRecovery({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      invoiceItemId: INVOICE_ITEM_ID,
      tpaClaimId: 91,
    });

    expect(result).toBe(recoveryRow);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0].slice(1)).toEqual([
      TENANT_ID,
      String(ORDER_ID),
      INVOICE_ITEM_ID,
      91,
      'pharmacy_funding_task_v1',
    ]);
    expect(clinicalOrderItemsSha256Mock).toHaveBeenCalledWith(recoveryRow.order_items_list);
    expectNoMutation();
  });

  it('returns canonical recovery even when a newer substitution task shares the order', async () => {
    state.recoveryRows = [
      recoveryRow,
      {
        ...recoveryRow,
        task_id: TASK_ID + 100,
        metadata: {
          contract: 'pharmacy_substitution_funding_task_v1',
          task_type: 'patient_advance',
        },
      },
    ];

    const result = await getPharmacyFundingRecovery({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      invoiceItemId: INVOICE_ITEM_ID,
    });

    expect(result).toBe(recoveryRow);
    const sql = compactSql(queryMock.mock.calls[0][0]);
    expect(sql).toContain("task.metadata->>'contract'=$5");
    expect(sql).toContain("task.metadata->>'task_type'='posted_payment'");
    expect(sql).not.toContain("'pharmacy_patient_advance'");
    expectNoMutation();
  });

  it('returns NOT_FOUND when no exact recovery row exists', async () => {
    await expect(getPharmacyFundingRecovery({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      invoiceItemId: INVOICE_ITEM_ID,
    })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });

    expect(clinicalOrderItemsSha256Mock).not.toHaveBeenCalled();
    expectNoMutation();
  });

  it('returns NOT_FOUND when durable line authority drifts from the canonical order hash', async () => {
    state.recoveryRows = [{
      ...recoveryRow,
      source_authority_sha256: 'd'.repeat(64),
    }];

    await expect(getPharmacyFundingRecovery({
      tenantId: TENANT_ID,
      orderId: ORDER_ID,
      invoiceItemId: INVOICE_ITEM_ID,
    })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });

    expect(clinicalOrderItemsSha256Mock).toHaveBeenCalledWith(recoveryRow.order_items_list);
    expectNoMutation();
  });
});

describe('getPharmacyFundingReconciliationCase', () => {
  it.each([0, -1, 1.5, 'not-a-case'])('rejects invalid case id %s before SQL', async (caseId) => {
    await expect(getPharmacyFundingReconciliationCase({
      tenantId: TENANT_ID,
      caseId,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_FUNDING_RECONCILIATION_CASE_REQUIRED',
    });

    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('returns the exact reconciliation case and current snapshot', async () => {
    const reconciliation = {
      id: 951,
      status: 'OPEN',
      task_status: 'open',
      assigned_to_role: 'FINANCE_INCHARGE',
      current_snapshot: { lines: [{ invoice_item_id: INVOICE_ITEM_ID }] },
      current_snapshot_sha256: 'e'.repeat(64),
      active_line_count: 2,
    };
    state.reconciliationRows = [reconciliation];

    const result = await getPharmacyFundingReconciliationCase({
      tenantId: TENANT_ID,
      caseId: 951,
    });

    expect(result).toBe(reconciliation);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0].slice(1)).toEqual([TENANT_ID, 951]);
    expectNoMutation();
  });

  it('returns NOT_FOUND when the tenant owns no such reconciliation case', async () => {
    await expect(getPharmacyFundingReconciliationCase({
      tenantId: TENANT_ID,
      caseId: 951,
    })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });

    expectNoMutation();
  });
});
