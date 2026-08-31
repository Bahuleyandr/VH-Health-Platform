import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';

const queryMock = jest.fn();
const executeMock = jest.fn();
const setTenantTxMock = jest.fn();
const lockSubstitutionAuthorityMock = jest.fn();
const resolvePatientUidMock = jest.fn();
const lockAuthorityMock = jest.fn();
const lockAdmissionMock = jest.fn();
const releaseCapReservationMock = jest.fn();
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

jest.unstable_mockModule('../../services/billing/ledger/ledgerAuthoritativeMode.js', () => ({
  resolveLedgerWiring: async () => ({
    mode: 'shadow', sameTx: false, postCommit: true, skip: false,
  }),
  resolveLedgerModeForTenant: async () => 'shadow',
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacyCapService.js', () => ({
  lockCounterFundingSubstitutionAuthorityTx: lockSubstitutionAuthorityMock,
  resolvePharmacyFundingPatientUidTx: resolvePatientUidMock,
  lockPharmacyFundingAuthorityTx: lockAuthorityMock,
  lockPharmacyFundingAdmissionTx: lockAdmissionMock,
  releasePharmacyCapReservationTx: releaseCapReservationMock,
}));

jest.unstable_mockModule(
  '../../services/pharmacy/pharmacistVerificationService.js',
  () => ({ clinicalOrderItemsSha256: clinicalOrderItemsSha256Mock }),
);

const { recordPharmacyFundingLineDecision } = await import(
  '../../services/billing/billingV2Service.js'
);

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const OTHER_PATIENT = '11111111-1111-4111-8111-111111111112';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const ORDER_HASH = 'a'.repeat(64);
const COMMAND_HASH = 'b'.repeat(64);
const TASK_ID = 31;
const ORDER_ID = 41;
const INVOICE_ITEM_ID = 51;
const TPA_CLAIM_ID = 61;
const INVOICE_ID = 71;
const ADMISSION_ID = 81;
const FACILITY_ID = 91;
const ORDER_VERSION = 3;

const BASE_ORDER = Object.freeze({
  id: ORDER_ID,
  patient_id: 11,
  patient_uid: PATIENT,
  patient_name: 'Coverage Patient',
  patient_phone: '9000000000',
  facility_id: FACILITY_ID,
  total_amount: '100.00',
  inventory_authority_version: ORDER_VERSION,
  items_list: [{ medicine_id: 1, quantity: 1 }],
  payment_mode: 'insurance',
  payment_metadata: { payment_mode: 'insurance', tpa_reference: 'TPA-61' },
  status: 'READY',
  funding_admission_id: ADMISSION_ID,
  funding_admission_order_version: ORDER_VERSION,
  funding_admission_items_sha256: ORDER_HASH,
  order_number: 'PH-41',
});

const BASE_LINE = Object.freeze({
  id: INVOICE_ITEM_ID,
  invoice_id: INVOICE_ID,
  invoice_status: 'DRAFT',
  patient_uid: PATIENT,
  admission_id: ADMISSION_ID,
  source_ref_type: 'pharmacy_order',
  source_ref_id: ORDER_ID,
  source_ref_active: true,
  source_authority_version: ORDER_VERSION,
  source_authority_sha256: ORDER_HASH,
  line_total: '100.00',
});

const BASE_CLAIM = Object.freeze({
  id: TPA_CLAIM_ID,
  invoice_id: INVOICE_ID,
  admission_id: ADMISSION_ID,
  patient_uid: PATIENT,
  status: 'approved',
  approved_amount: '100.00',
  claim_number: 'TPA-61',
  tpa_reference_id: 'TPA-61',
  preauth_id: 611,
});

const BASE_TASK_METADATA = Object.freeze({
  contract: 'pharmacy_funding_task_v1',
  task_type: 'tpa_line_decision',
  pharmacy_order_id: ORDER_ID,
  invoice_id: INVOICE_ID,
  invoice_item_id: INVOICE_ITEM_ID,
  tpa_claim_id: TPA_CLAIM_ID,
  order_version: ORDER_VERSION,
  order_items_sha256: ORDER_HASH,
  authoritative_amount: 100,
  admission_id: ADMISSION_ID,
});

const BASE_TASK = Object.freeze({
  id: TASK_ID,
  status: 'open',
  assigned_to_role: 'INSURANCE_COORDINATOR',
  related_resource_type: 'pharmacy_tpa_line_decision',
  related_resource_id: String(ORDER_ID),
  metadata: BASE_TASK_METADATA,
});

function decisionArgs(overrides = {}) {
  return {
    tenantId: TENANT,
    taskId: TASK_ID,
    orderId: ORDER_ID,
    invoiceItemId: INVOICE_ITEM_ID,
    tpaClaimId: TPA_CLAIM_ID,
    orderVersion: ORDER_VERSION,
    orderItemsSha256: ORDER_HASH,
    approvedAmount: 60,
    nonPayableAmount: 40,
    reasonCode: 'partial_approval',
    reasonText: 'Documented partial approval',
    actorUid: ACTOR,
    commandKeySha256: COMMAND_HASH,
    ...overrides,
  };
}

function requestFingerprint(overrides = {}) {
  const values = {
    task_id: TASK_ID,
    pharmacy_order_id: ORDER_ID,
    invoice_item_id: INVOICE_ITEM_ID,
    tpa_claim_id: TPA_CLAIM_ID,
    order_version: ORDER_VERSION,
    order_items_sha256: ORDER_HASH,
    approved_amount: 60,
    non_payable_amount: 40,
    reason_code: 'partial_approval',
    reason_text: 'Documented partial approval',
    actor_uid: ACTOR,
    ...overrides,
  };
  return createHash('sha256')
    .update(JSON.stringify({ event_type: 'TPA_LINE_DECISION_REQUEST', ...values }))
    .digest('hex');
}

function freshScenario() {
  return {
    canonicalOrderHash: ORDER_HASH,
    orderRows: [{ ...BASE_ORDER }],
    actorRows: [{ uid: ACTOR, role: 'INSURANCE_COORDINATOR' }],
    lineRows: [{ ...BASE_LINE }],
    claimRows: [{ ...BASE_CLAIM }],
    taskRows: [{ ...BASE_TASK, metadata: { ...BASE_TASK_METADATA } }],
    receiptMissing: false,
    receiptPatch: {},
    commandCompletionSucceeds: true,
    otherApprovedAmount: 0,
    allocations: [],
    completedLineTask: {
      id: TASK_ID,
      status: 'completed',
      assigned_to_role: 'INSURANCE_COORDINATOR',
      metadata: { ...BASE_TASK_METADATA },
      completed_at: '2026-08-30T00:00:00.000Z',
    },
    completedPostedTask: null,
    nextTaskId: 301,
    currentAuthorityEvent: null,
    stockMovementRows: [],
    capReservationRows: [],
    terminalAllocationRows: [],
    advanceAllocationRows: [],
    advanceAllocationReversalRows: [],
    admissionRows: [{ id: ADMISSION_ID, patient_uid: PATIENT, status: 'admitted' }],
  };
}

let scenario;
let captured;

function flatSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function receiptFromClaim() {
  if (scenario.receiptMissing) return [];
  const receipt = {
    tenant_id: TENANT,
    command_key_sha256: captured.commandClaim.commandKeySha256,
    command_type: captured.commandClaim.commandType,
    task_id: captured.commandClaim.taskId,
    task_resource_type: captured.commandClaim.taskResourceType,
    task_resource_id: captured.commandClaim.taskResourceId,
    pharmacy_order_id: captured.commandClaim.orderId,
    invoice_item_id: captured.commandClaim.invoiceItemId,
    tpa_claim_id: captured.commandClaim.tpaClaimId,
    request_sha256: captured.commandClaim.requestSha256,
    status: 'IN_PROGRESS',
    response_body: null,
    ...scenario.receiptPatch,
  };
  return [receipt];
}

function routeQuery(sql, params) {
  const normalized = flatSql(sql);
  captured.sql.push({ kind: 'query', sql: normalized, params });

  if (normalized.includes('SELECT pharmacy_order.*,patient.uid AS patient_uid')) {
    return scenario.orderRows;
  }
  if (normalized.includes('FROM pharmacy_funding_commands')
      && normalized.includes("command_type='SUBSTITUTION_FUNDING_APPROVAL'")) {
    return [];
  }
  if (normalized.includes('FROM approvals')
      && normalized.includes("approval_kind='pharmacy_substitution_funding_reauthorisation'")) {
    return [];
  }
  if (normalized.includes('FROM tasks')
      && normalized.includes('related_resource_type=ANY($3::text[])')
      && normalized.includes("metadata->>'contract'=$4")) {
    return [];
  }
  if (normalized.includes('SELECT uid, UPPER(role) AS role FROM users')) {
    return scenario.actorRows;
  }
  if (normalized.startsWith('SELECT id,invoice_id FROM billing_invoice_items')) {
    return scenario.lineRows.map((line) => ({ id: line.id, invoice_id: line.invoice_id }));
  }
  if (normalized.startsWith('SELECT item.id,item.invoice_id FROM billing_invoice_items item')) {
    return scenario.lineRows.map((line) => ({ id: line.id, invoice_id: line.invoice_id }));
  }
  if (normalized.includes('FROM billing_invoices')
      && normalized.includes('id=ANY($2::int[])')
      && normalized.endsWith('FOR UPDATE')) {
    return scenario.lineRows.length ? [{
      id: scenario.lineRows[0].invoice_id,
      status: scenario.lineRows[0].invoice_status,
      patient_uid: scenario.lineRows[0].patient_uid,
      admission_id: scenario.lineRows[0].admission_id,
      tenant_id: TENANT,
      subtotal: scenario.lineRows[0].line_total,
      cgst_amount: '0',
      sgst_amount: '0',
      igst_amount: '0',
      total_amount: scenario.lineRows[0].line_total,
      amount_paid: '0',
      amount_due: scenario.lineRows[0].line_total,
    }] : [];
  }
  if (normalized.includes('FROM billing_invoice_items')
      && normalized.includes('id=ANY($2::int[])')
      && normalized.endsWith('FOR UPDATE')) {
    return scenario.lineRows;
  }
  if (normalized.includes('FROM billing_payments')
      && normalized.includes('invoice_id=ANY($2::int[])')) {
    return [];
  }
  if (normalized.includes('FROM billing_refunds')
      && normalized.includes('invoice_id=ANY($2::int[])')) {
    return [];
  }
  if (normalized.includes('FROM billing_advance_settlements')
      && normalized.includes('invoice_id=ANY($2::int[])')) {
    return [];
  }
  if (normalized.includes('FROM pharmacy_advance_allocations allocation')
      && normalized.includes('allocation.pharmacy_order_id=$2::int')) {
    return scenario.advanceAllocationRows;
  }
  if (normalized.includes('FROM pharmacy_advance_allocation_reversals')
      && normalized.includes('allocation_id=ANY($2::bigint[])')) {
    return scenario.advanceAllocationReversalRows;
  }
  if (normalized.startsWith('SELECT id,invoice_id,admission_id,patient_uid,status FROM tpa_claims')
      || (normalized.startsWith('SELECT id,invoice_id,admission_id,patient_uid,status,approved_amount')
        && normalized.includes("status IN ('approved','partially_approved','paid')"))) {
    return scenario.claimRows;
  }
  if (normalized.startsWith('SELECT * FROM tasks')
      && normalized.includes("related_resource_type='pharmacy_tpa_line_decision'")) {
    return scenario.taskRows;
  }
  if (normalized.startsWith('SELECT * FROM pharmacy_funding_commands')) {
    return receiptFromClaim();
  }
  if (normalized.includes('SELECT COALESCE(SUM(approved_amount),0)::numeric AS approved')) {
    return [{ approved: scenario.otherApprovedAmount }];
  }
  if (normalized.startsWith('INSERT INTO tpa_claim_line_decisions')) {
    const decision = {
      id: 501,
      tenant_id: params[0],
      claim_id: params[1],
      invoice_item_id: params[2],
      reason_code: params[3],
      reason_text: params[4],
      approved_amount: params[5],
      non_payable_amount: params[6],
      recorded_by: params[7],
      source_authority_version: params[8],
      source_authority_sha256: params[9],
      invalidated_at: null,
      invalidated_by: null,
    };
    captured.decision = decision;
    return [decision];
  }
  if (normalized.includes('SELECT allocation.id AS allocation_id')
      && normalized.includes('FROM pharmacy_payment_allocations allocation')) {
    return scenario.allocations;
  }
  if (normalized.startsWith("UPDATE tasks SET status='completed'")) {
    const evidence = JSON.parse(params[3]);
    captured.taskCompletions.push({
      resourceType: params[1], orderId: params[2], evidence, taskId: params[4],
    });
    if (params[1] === 'pharmacy_tpa_line_decision') {
      return scenario.completedLineTask == null ? [] : [scenario.completedLineTask];
    }
    return scenario.completedPostedTask == null ? [] : [scenario.completedPostedTask];
  }
  if (normalized.startsWith('INSERT INTO tasks')) {
    const metadata = JSON.parse(params[8]);
    const task = {
      id: scenario.nextTaskId,
      status: 'open',
      assigned_to_role: params[6],
      related_resource_type: params[4],
      related_resource_id: params[5],
      metadata,
    };
    captured.nextTasks.push(task);
    return [task];
  }
  if (normalized.startsWith('INSERT INTO pharmacy_funding_decision_events')
      && normalized.includes("'TPA_DECISION_RECORDED'")) {
    const event = {
      sourceAuthorityVersion: params[4],
      sourceAuthoritySha256: params[5],
      amount: params[10],
      commandKeySha256: params[11],
      evidence: JSON.parse(params[12]),
      actorUid: params[13],
    };
    captured.tpaDecisionEvents.push(event);
    return [{ id: 601 }];
  }
  if (normalized.startsWith("UPDATE pharmacy_funding_commands SET status='COMPLETE'")) {
    const completion = {
      tenantId: params[0],
      commandKeySha256: params[1],
      responseBody: JSON.parse(params[2]),
    };
    captured.commandCompletions.push(completion);
    return scenario.commandCompletionSucceeds
      ? [{ status: 'COMPLETE', response_body: completion.responseBody }]
      : [];
  }
  if (normalized.startsWith('SELECT pg_advisory_xact_lock')) {
    return [{ lock_acquired: '' }];
  }
  // patientMergeStabilityLock (via billingV2Service setTenantTx flows) takes a
  // tenant-wide shared merge-stability lock before the domain advisory locks.
  if (normalized.startsWith('SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(')) {
    return [{ locked: 1 }];
  }
  if (normalized.startsWith('SELECT event.* FROM pharmacy_funding_decision_events event')) {
    return scenario.currentAuthorityEvent == null ? [] : [scenario.currentAuthorityEvent];
  }
  if (normalized.startsWith('INSERT INTO pharmacy_funding_decision_events')
      && normalized.includes('$17::bigint,$18::bigint')) {
    const evidence = JSON.parse(params[14]);
    const event = {
      id: 701 + captured.authorityEvents.length,
      tenant_id: params[0],
      facility_id: params[1],
      pharmacy_order_id: params[2],
      admission_id: params[3],
      event_type: params[4],
      source_authority_version: params[5],
      source_authority_sha256: params[6],
      invoice_id: params[7],
      invoice_item_id: params[8],
      tpa_claim_id: params[9],
      billing_payment_id: params[10],
      task_id: params[11],
      amount: params[12],
      command_key_sha256: params[13],
      evidence,
      authority_generation: params[16],
      supersedes_event_id: params[17],
      replayed: false,
    };
    captured.authorityEvents.push(event);
    return [event];
  }
  if (normalized.startsWith('SELECT id FROM pharmacy_stock_movements')) {
    return scenario.stockMovementRows;
  }
  if (normalized.startsWith('SELECT admission_id FROM pharmacy_cap_reservations')) {
    return scenario.capReservationRows;
  }
  if (normalized.startsWith('SELECT allocation.*,')) {
    return scenario.terminalAllocationRows;
  }
  if (normalized.startsWith('SELECT po.id,po.patient_id,po.uid,po.patient_name')) {
    return scenario.orderRows;
  }
  if (normalized.startsWith('SELECT id,patient_uid,status FROM admissions')) {
    return scenario.admissionRows;
  }
  if (normalized.startsWith('SELECT claim.id,claim.claim_number')) {
    return scenario.claimRows;
  }
  if (normalized.startsWith('UPDATE billing_invoice_items SET description=')) {
    const line = {
      ...scenario.lineRows[0],
      description: params[2],
      line_total: params[3],
      source_authority_version: params[4],
      source_authority_sha256: params[5],
    };
    scenario.lineRows = [line];
    return [line];
  }
  if (normalized.startsWith('SELECT COALESCE(SUM(line_subtotal), 0)::numeric AS subtotal')) {
    return [{ subtotal: 100, cgst: 0, sgst: 0, igst: 0 }];
  }
  if (normalized.startsWith('SELECT discount_amount, credit_note_amount, amount_paid')) {
    return [{ discount_amount: 0, credit_note_amount: 0, amount_paid: 0 }];
  }
  if (normalized.startsWith('SELECT admission_id, patient_uid, tenant_id FROM billing_invoices')) {
    return [{ admission_id: ADMISSION_ID, patient_uid: PATIENT, tenant_id: TENANT }];
  }
  if (normalized.startsWith('SELECT * FROM tpa_claim_line_decisions')) {
    const lookup = {
      tenantId: params[0],
      claimId: params[1],
      invoiceItemId: params[2],
      sourceAuthorityVersion: params[3],
      sourceAuthoritySha256: params[4],
    };
    captured.decisionLookups.push(lookup);
    if (captured.decision == null
        || captured.decision.tenant_id !== lookup.tenantId
        || Number(captured.decision.claim_id) !== Number(lookup.claimId)
        || Number(captured.decision.invoice_item_id) !== Number(lookup.invoiceItemId)
        || Number(captured.decision.source_authority_version)
          !== Number(lookup.sourceAuthorityVersion)
        || captured.decision.source_authority_sha256 !== lookup.sourceAuthoritySha256) {
      return [];
    }
    return [captured.decision];
  }

  throw new Error(`Unhandled query SQL: ${normalized}`);
}

function routeExecute(sql, params) {
  const normalized = flatSql(sql);
  captured.sql.push({ kind: 'execute', sql: normalized, params });

  if (normalized.startsWith('INSERT INTO pharmacy_funding_commands')) {
    captured.commandClaim = {
      tenantId: params[0],
      commandKeySha256: params[1],
      commandType: params[2],
      taskId: params[3],
      taskResourceType: params[4],
      taskResourceId: params[5],
      orderId: params[6],
      invoiceItemId: params[7],
      tpaClaimId: params[8],
      requestSha256: params[9],
      actorUid: params[10],
    };
    return 1;
  }
  if (normalized.startsWith('UPDATE tpa_claim_line_decisions')
      && normalized.includes('claim_id<>$3::int')) {
    captured.crossClaimInvalidations.push({ params });
    return 1;
  }
  if (normalized.startsWith('UPDATE billing_invoice_items')
      && normalized.includes('SET tpa_decision=$3')) {
    captured.billingLineUpdates.push({
      tenantId: params[0],
      invoiceItemId: params[1],
      decision: params[2],
      reasonCode: params[3],
      actorUid: params[4],
    });
    return 1;
  }
  if (normalized.startsWith('UPDATE tasks')
      && normalized.includes("status=CASE WHEN $3::boolean")) {
    captured.terminalTaskUpdates.push({
      tenantId: params[0], orderId: params[1], cancelled: params[2],
    });
    return 1;
  }
  if (normalized.startsWith('UPDATE tpa_claim_line_decisions decision')) {
    captured.terminalDecisionInvalidations.push({ params });
    return 1;
  }
  if (normalized.startsWith('UPDATE billing_invoices SET subtotal =')) {
    captured.invoiceRecomputes.push({ params });
    return 1;
  }
  if (normalized.startsWith('INSERT INTO pharmacy_funding_decision_events')
      && normalized.includes("'LINE_MATERIALIZED'")) {
    captured.lineMaterializedEvents.push({
      commandKeySha256: params[10], evidence: JSON.parse(params[11]), actorUid: params[12],
    });
    return 1;
  }

  throw new Error(`Unhandled execute SQL: ${normalized}`);
}

function mutationCalls() {
  return captured.sql.filter(({ sql }) => /^(?:INSERT|UPDATE|DELETE)\b/.test(sql));
}

function queryCallsContaining(fragment) {
  return captured.sql.filter(({ kind, sql }) => kind === 'query' && sql.includes(fragment));
}

function executeCallsContaining(fragment) {
  return captured.sql.filter(({ kind, sql }) => kind === 'execute' && sql.includes(fragment));
}

function expectExactCommandBinding() {
  expect(captured.commandClaim).toEqual({
    tenantId: TENANT,
    commandKeySha256: COMMAND_HASH,
    commandType: 'TPA_LINE_DECISION',
    taskId: TASK_ID,
    taskResourceType: 'pharmacy_tpa_line_decision',
    taskResourceId: String(ORDER_ID),
    orderId: ORDER_ID,
    invoiceItemId: INVOICE_ITEM_ID,
    tpaClaimId: TPA_CLAIM_ID,
    requestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    actorUid: ACTOR,
  });
}

async function expectDecisionError(overrides, code, statusCode) {
  await expect(recordPharmacyFundingLineDecision(decisionArgs(overrides))).rejects.toMatchObject({
    code,
    statusCode,
  });
}

beforeEach(() => {
  scenario = freshScenario();
  captured = {
    sql: [],
    commandClaim: null,
    commandCompletions: [],
    decision: null,
    decisionLookups: [],
    crossClaimInvalidations: [],
    billingLineUpdates: [],
    taskCompletions: [],
    nextTasks: [],
    tpaDecisionEvents: [],
    terminalTaskUpdates: [],
    terminalDecisionInvalidations: [],
    invoiceRecomputes: [],
    lineMaterializedEvents: [],
    authorityEvents: [],
  };

  queryMock.mockReset();
  executeMock.mockReset();
  setTenantTxMock.mockReset();
  resolvePatientUidMock.mockReset();
  lockAuthorityMock.mockReset();
  lockAdmissionMock.mockReset();
  releaseCapReservationMock.mockReset();
  clinicalOrderItemsSha256Mock.mockReset();

  queryMock.mockImplementation((sql, ...params) => routeQuery(sql, params));
  executeMock.mockImplementation((sql, ...params) => routeExecute(sql, params));
  setTenantTxMock.mockImplementation(async (_tenantId, fn) => fn(mockPrisma));
  resolvePatientUidMock.mockResolvedValue(PATIENT);
  lockAuthorityMock.mockResolvedValue(undefined);
  lockAdmissionMock.mockResolvedValue({
    id: ADMISSION_ID,
    patient_uid: PATIENT,
    status: 'admitted',
  });
  releaseCapReservationMock.mockResolvedValue({ id: '801', status: 'RELEASED' });
  clinicalOrderItemsSha256Mock.mockImplementation(() => scenario.canonicalOrderHash);
});

describe('recordPharmacyFundingLineDecision validation and fail-closed guards', () => {
  it.each([
    ['non-finite approved amount', { approvedAmount: 'not-a-number' }],
    ['negative approved amount', { approvedAmount: -0.01 }],
    ['non-finite non-payable amount', { nonPayableAmount: Number.POSITIVE_INFINITY }],
    ['negative non-payable amount', { nonPayableAmount: -0.01 }],
    ['third-decimal numeric approved amount', { approvedAmount: 60.001 }],
    ['third-decimal string approved amount', { approvedAmount: '60.001' }],
    ['third-decimal numeric non-payable amount', { nonPayableAmount: 40.001 }],
    ['third-decimal string non-payable amount', { nonPayableAmount: '40.001' }],
    ['approved dust that collapses to zero paise', {
      approvedAmount: 1e-10,
      nonPayableAmount: 100,
    }],
    ['non-payable dust that collapses to zero paise', {
      approvedAmount: 100,
      nonPayableAmount: 1e-10,
    }],
    ['non-positive task id', { taskId: 0 }],
    ['fractional order id', { orderId: 1.5 }],
    ['invalid invoice-item id', { invoiceItemId: 'line-51' }],
    ['non-positive claim id', { tpaClaimId: -1 }],
    ['non-positive order version', { orderVersion: 0 }],
    ['invalid order-items hash', { orderItemsSha256: 'not-a-sha256' }],
    ['invalid command hash', { commandKeySha256: 'not-a-sha256' }],
    ['unsupported reason code', { reasonCode: 'free_form_reason' }],
  ])('rejects %s before starting a transaction', async (_label, overrides) => {
    await expectDecisionError(overrides, 'PHARMACY_TPA_LINE_DECISION_INVALID', 400);
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it.each([
    ['missing order', []],
    ['patient changed', [{ ...BASE_ORDER, patient_uid: OTHER_PATIENT }]],
  ])('rejects order scope mismatch when %s without writing', async (_label, orderRows) => {
    scenario.orderRows = orderRows;
    await expectDecisionError({}, 'PHARMACY_FUNDING_ORDER_SCOPE_MISMATCH', 409);
    expect(mutationCalls()).toEqual([]);
  });

  it.each([
    ['the actor identity is inactive or absent', []],
    ['the actor role is not permitted', [{ uid: ACTOR, role: 'PATIENT' }]],
  ])('rejects the funding actor when %s without writing', async (_label, actorRows) => {
    scenario.actorRows = actorRows;
    await expectDecisionError({}, 'PHARMACY_FUNDING_ACTOR_FORBIDDEN', 403);
    expect(mutationCalls()).toEqual([]);
  });

  it.each([
    ['payment mode is no longer TPA', { payment_mode: 'cash', payment_metadata: {} }, ORDER_HASH],
    ['order version changed', { inventory_authority_version: ORDER_VERSION + 1 }, ORDER_HASH],
    ['canonical item hash changed', {}, 'c'.repeat(64)],
  ])('rejects stale order authority when %s without writing', async (
    _label,
    orderPatch,
    canonicalHash,
  ) => {
    scenario.orderRows = [{ ...BASE_ORDER, ...orderPatch }];
    scenario.canonicalOrderHash = canonicalHash;
    await expectDecisionError({}, 'PHARMACY_TPA_LINE_AUTHORITY_STALE', 409);
    expect(mutationCalls()).toEqual([]);
  });

  it('rejects an unknown non-actionable order status before admission or line writes', async () => {
    scenario.orderRows = [{ ...BASE_ORDER, status: 'ARCHIVED' }];
    await expectDecisionError({}, 'PHARMACY_FUNDING_ORDER_NOT_ACTIONABLE', 409);
    expect(lockAdmissionMock).not.toHaveBeenCalled();
    expect(mutationCalls()).toEqual([]);
  });

  it('requires an exact governed admission binding before locking a billing line', async () => {
    scenario.orderRows = [{ ...BASE_ORDER, funding_admission_id: null }];
    await expectDecisionError({}, 'PHARMACY_FUNDING_ADMISSION_REQUIRED', 409);
    expect(lockAdmissionMock).not.toHaveBeenCalled();
    expect(mutationCalls()).toEqual([]);
  });

  it('returns NOT_FOUND when the exact active order invoice line disappeared', async () => {
    scenario.lineRows = [];
    await expectDecisionError({}, 'NOT_FOUND', 404);
    expect(lockAdmissionMock).not.toHaveBeenCalled();
    expect(mutationCalls()).toEqual([]);
  });

  it.each([
    ['invoice is no longer draft', { invoice_status: 'ISSUED' }],
    ['line patient changed', { patient_uid: OTHER_PATIENT }],
    ['line admission changed', { admission_id: ADMISSION_ID + 1 }],
    ['line authority version changed', { source_authority_version: ORDER_VERSION + 1 }],
    ['line authority hash changed', { source_authority_sha256: 'd'.repeat(64) }],
    ['line is not balanced to the decision', { line_total: '100.01' }],
  ])('rejects stale line authority when %s without writing', async (_label, patch) => {
    scenario.lineRows = [{ ...BASE_LINE, ...patch }];
    await expectDecisionError({}, 'PHARMACY_TPA_LINE_AUTHORITY_STALE', 409);
    expect(mutationCalls()).toEqual([]);
  });

  it('rejects a claim that no longer owns the exact invoice, admission, and patient', async () => {
    scenario.claimRows = [];
    await expectDecisionError({}, 'PHARMACY_TPA_CLAIM_AUTHORITY_STALE', 409);
    expect(mutationCalls()).toEqual([]);
  });

  it('returns NOT_FOUND when the exact line-decision task disappeared', async () => {
    scenario.taskRows = [];
    await expectDecisionError({}, 'NOT_FOUND', 404);
    expect(mutationCalls()).toEqual([]);
  });

  it.each([
    ['assigned role changed', { assigned_to_role: 'FINANCE_INCHARGE' }, {}],
    ['contract changed', {}, { contract: 'legacy_task_v0' }],
    ['task type changed', {}, { task_type: 'posted_payment' }],
    ['invoice changed', {}, { invoice_id: INVOICE_ID + 1 }],
    ['invoice item changed', {}, { invoice_item_id: INVOICE_ITEM_ID + 1 }],
    ['claim changed', {}, { tpa_claim_id: TPA_CLAIM_ID + 1 }],
    ['order version changed', {}, { order_version: ORDER_VERSION + 1 }],
    ['order hash changed', {}, { order_items_sha256: 'e'.repeat(64) }],
  ])('rejects stale task authority when %s without writing', async (
    _label,
    taskPatch,
    metadataPatch,
  ) => {
    scenario.taskRows = [{
      ...BASE_TASK,
      ...taskPatch,
      metadata: { ...BASE_TASK_METADATA, ...metadataPatch },
    }];
    await expectDecisionError({}, 'PHARMACY_TPA_TASK_AUTHORITY_STALE', 409);
    expect(mutationCalls()).toEqual([]);
  });
});

describe('recordPharmacyFundingLineDecision command receipts', () => {
  it.each([
    ['missing receipt', null, true],
    ['command type', { command_type: 'POSTED_PAYMENT' }, false],
    ['task id', { task_id: TASK_ID + 1 }, false],
    ['task resource type', { task_resource_type: 'pharmacy_posted_payment' }, false],
    ['task resource id', { task_resource_id: String(ORDER_ID + 1) }, false],
    ['order id', { pharmacy_order_id: ORDER_ID + 1 }, false],
    ['invoice item id', { invoice_item_id: INVOICE_ITEM_ID + 1 }, false],
    ['claim id', { tpa_claim_id: null }, false],
    ['request hash', { request_sha256: 'f'.repeat(64) }, false],
  ])('rejects a command receipt bound to a different %s', async (
    _label,
    receiptPatch,
    receiptMissing,
  ) => {
    scenario.receiptMissing = receiptMissing;
    scenario.receiptPatch = receiptPatch || {};
    await expectDecisionError({}, 'PHARMACY_FUNDING_COMMAND_MISMATCH', 422);
    expectExactCommandBinding();
    expect(captured.decision).toBeNull();
    expect(captured.billingLineUpdates).toEqual([]);
    expect(captured.taskCompletions).toEqual([]);
    expect(captured.tpaDecisionEvents).toEqual([]);
  });

  it('returns the immutable COMPLETE receipt as a replay without domain writes', async () => {
    scenario.receiptPatch = {
      status: 'COMPLETE',
      response_body: {
        replayed: false,
        status: 'patient_responsibility_pending',
        decision: { id: 444 },
        task: { id: TASK_ID, status: 'completed' },
      },
    };

    const result = await recordPharmacyFundingLineDecision(decisionArgs());

    expect(result).toEqual({
      replayed: true,
      status: 'patient_responsibility_pending',
      decision: { id: 444 },
      task: { id: TASK_ID, status: 'completed' },
    });
    expectExactCommandBinding();
    expect(mutationCalls()).toHaveLength(1);
    expect(mutationCalls()[0].sql).toMatch(/^INSERT INTO pharmacy_funding_commands/);
    expect(captured.commandCompletions).toEqual([]);
    expect(captured.decision).toBeNull();
    const expectedFingerprint = requestFingerprint();
    expect(captured.commandClaim.requestSha256).toBe(expectedFingerprint);
    expect(requestFingerprint({ approved_amount: 59 })).not.toBe(expectedFingerprint);
    expect(requestFingerprint({ non_payable_amount: 39 })).not.toBe(expectedFingerprint);
    expect(requestFingerprint({ reason_code: 'other' })).not.toBe(expectedFingerprint);
    expect(requestFingerprint({ reason_text: 'Different evidence' })).not.toBe(expectedFingerprint);
    expect(requestFingerprint({
      actor_uid: '22222222-2222-4222-8222-222222222223',
    })).not.toBe(expectedFingerprint);
  });

  it('refuses an inactive task after claiming the exact command receipt', async () => {
    scenario.taskRows = [{
      ...BASE_TASK,
      status: 'completed',
      metadata: { ...BASE_TASK_METADATA },
    }];

    await expectDecisionError({}, 'PHARMACY_TPA_TASK_ALREADY_COMPLETED', 409);

    expectExactCommandBinding();
    expect(captured.decision).toBeNull();
    expect(captured.crossClaimInvalidations).toEqual([]);
    expect(captured.commandCompletions).toEqual([]);
  });
});

describe('recordPharmacyFundingLineDecision terminal order closure', () => {
  it.each(['DELIVERED', 'DISPENSED'])(
    'closes the command and active tasks when the order is already %s',
    async (status) => {
      scenario.orderRows = [{ ...BASE_ORDER, status }];

      const result = await recordPharmacyFundingLineDecision(decisionArgs());

      expect(result).toEqual({
        replayed: false,
        status: 'closed',
        decision: null,
        task: null,
        invalidatedAuthority: {
          releasedCapReservation: null,
          reversedAllocationIds: [],
        },
      });
      expectExactCommandBinding();
      expect(captured.terminalTaskUpdates).toEqual([{
        tenantId: TENANT,
        orderId: String(ORDER_ID),
        cancelled: false,
      }]);
      expect(captured.terminalDecisionInvalidations).toEqual([]);
      expect(captured.commandCompletions).toHaveLength(1);
      expect(captured.commandCompletions[0].responseBody).toEqual(result);
      expect(captured.decision).toBeNull();
      expect(captured.tpaDecisionEvents).toEqual([]);
    },
  );

  it('cancels tasks and invalidates claim, cap, and current funding authority', async () => {
    scenario.orderRows = [{ ...BASE_ORDER, status: 'CANCELLED' }];
    scenario.capReservationRows = [{ admission_id: ADMISSION_ID }];
    scenario.currentAuthorityEvent = {
      id: 700,
      event_type: 'FUNDING_RESOLVED',
      authority_generation: 4,
      admission_id: ADMISSION_ID,
      invoice_id: INVOICE_ID,
      invoice_item_id: INVOICE_ITEM_ID,
      tpa_claim_id: TPA_CLAIM_ID,
      billing_payment_id: null,
      task_id: 302,
      amount: 100,
      evidence: { contract: 'pharmacy_funding_authority_v1' },
    };

    const result = await recordPharmacyFundingLineDecision(decisionArgs());

    expect(result.status).toBe('invalidated');
    expect(result.replayed).toBe(false);
    expect(result.decision).toBeNull();
    expect(result.task).toBeNull();
    expect(result.invalidatedAuthority).toMatchObject({
      releasedCapReservation: { id: '801', status: 'RELEASED' },
      reversedAllocationIds: [],
      invalidatedFundingEventId: 701,
    });
    expect(captured.terminalTaskUpdates).toEqual([{
      tenantId: TENANT,
      orderId: String(ORDER_ID),
      cancelled: true,
    }]);
    expect(captured.terminalDecisionInvalidations).toHaveLength(1);
    expect(queryCallsContaining('FROM pharmacy_stock_movements')).toHaveLength(1);
    expect(releaseCapReservationMock).toHaveBeenCalledWith(mockPrisma, expect.objectContaining({
      tenantId: TENANT,
      facilityId: FACILITY_ID,
      admissionId: ADMISSION_ID,
      orderId: ORDER_ID,
      actorUid: ACTOR,
      actorRole: 'INSURANCE_COORDINATOR',
      reason: 'terminal_order_cancelled',
      commandKeySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
    expect(captured.authorityEvents).toHaveLength(1);
    expect(captured.authorityEvents[0]).toMatchObject({
      event_type: 'AUTHORITY_INVALIDATED',
      authority_generation: 5,
      supersedes_event_id: 700,
      command_key_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(captured.authorityEvents[0].evidence).toMatchObject({
      invalidation_reason: 'terminal_order_cancelled',
      prior_funding_event_id: 700,
    });
    expect(captured.commandCompletions[0].responseBody).toEqual(result);
  });
});

describe('recordPharmacyFundingLineDecision decisions and authority transitions', () => {
  it('rejects approvals above the authoritative claim cap before recording a decision', async () => {
    scenario.otherApprovedAmount = 40.01;

    await expectDecisionError({}, 'PHARMACY_TPA_APPROVAL_INCONSISTENT', 409);

    expectExactCommandBinding();
    expect(captured.crossClaimInvalidations).toHaveLength(1);
    expect(captured.decision).toBeNull();
    expect(captured.billingLineUpdates).toEqual([]);
    expect(captured.taskCompletions).toEqual([]);
    expect(captured.tpaDecisionEvents).toEqual([]);
    expect(captured.commandCompletions).toEqual([]);
  });

  it('canonicalizes harmless numeric representation dust to exact paise everywhere', async () => {
    const representationDust = 0.1 + 0.2;
    expect(representationDust).not.toBe(0.3);

    const result = await recordPharmacyFundingLineDecision(decisionArgs({
      approvedAmount: representationDust,
      nonPayableAmount: 99.7,
    }));

    const expectedFingerprint = requestFingerprint({
      approved_amount: 0.3,
      non_payable_amount: 99.7,
    });
    expect(captured.commandClaim.requestSha256).toBe(expectedFingerprint);
    expect(captured.decision).toMatchObject({
      approved_amount: 0.3,
      non_payable_amount: 99.7,
    });
    expect(result.evidence).toMatchObject({
      approved_amount: 0.3,
      non_payable_amount: 99.7,
      amount_outstanding: 99.7,
      request_sha256: expectedFingerprint,
    });
    expect(captured.tpaDecisionEvents).toEqual([
      expect.objectContaining({
        amount: 0.3,
        evidence: expect.objectContaining({
          approved_amount: 0.3,
          non_payable_amount: 99.7,
        }),
      }),
    ]);
    expect(captured.nextTasks[0].metadata.amount_outstanding).toBe(99.7);
    expect(captured.commandCompletions[0].responseBody).toEqual(result);
  });

  it.each([
    {
      label: 'partial',
      approvedAmount: 60,
      nonPayableAmount: 40,
      expectedDecision: 'partial',
      expectedOutstanding: 40,
      allocations: [],
      hasCurrentAuthority: true,
    },
    {
      label: 'non-payable',
      approvedAmount: 0,
      nonPayableAmount: 100,
      expectedDecision: 'non_payable',
      expectedOutstanding: 80,
      allocations: [{ allocation_id: 901, allocated_amount: '20.00', payment_id: 902 }],
      hasCurrentAuthority: false,
    },
  ])('records a $label decision and creates exact patient-responsibility authority', async ({
    approvedAmount,
    nonPayableAmount,
    expectedDecision,
    expectedOutstanding,
    allocations,
    hasCurrentAuthority,
  }) => {
    scenario.allocations = allocations;
    scenario.currentAuthorityEvent = hasCurrentAuthority ? {
      id: 710,
      event_type: 'FUNDING_RESOLVED',
      authority_generation: 2,
      admission_id: ADMISSION_ID,
      invoice_id: INVOICE_ID,
      invoice_item_id: INVOICE_ITEM_ID,
      tpa_claim_id: TPA_CLAIM_ID,
      billing_payment_id: null,
      task_id: 310,
      amount: 100,
      evidence: { contract: 'pharmacy_funding_authority_v1' },
    } : null;

    const result = await recordPharmacyFundingLineDecision(decisionArgs({
      approvedAmount,
      nonPayableAmount,
    }));

    expect(result).toMatchObject({
      replayed: false,
      status: 'patient_responsibility_pending',
      decision: {
        id: 501,
        approved_amount: approvedAmount,
        non_payable_amount: nonPayableAmount,
      },
      task: { id: TASK_ID, status: 'completed' },
      nextTask: {
        id: scenario.nextTaskId,
        assigned_to_role: 'FINANCE_INCHARGE',
        related_resource_type: 'pharmacy_posted_payment',
      },
      fundingAuthority: {
        status: 'invalidated',
        eventId: hasCurrentAuthority ? 701 : null,
      },
    });
    expectExactCommandBinding();
    expect(captured.billingLineUpdates).toEqual([{
      tenantId: TENANT,
      invoiceItemId: INVOICE_ITEM_ID,
      decision: expectedDecision,
      reasonCode: 'partial_approval',
      actorUid: ACTOR,
    }]);
    expect(captured.taskCompletions[0]).toMatchObject({
      resourceType: 'pharmacy_tpa_line_decision',
      orderId: String(ORDER_ID),
      taskId: TASK_ID,
    });
    expect(captured.nextTasks).toHaveLength(1);
    expect(captured.nextTasks[0].metadata).toMatchObject({
      contract: 'pharmacy_funding_task_v1',
      task_type: 'posted_payment',
      stage: 'patient_responsibility_payment',
      pharmacy_order_id: ORDER_ID,
      invoice_id: INVOICE_ID,
      invoice_item_id: INVOICE_ITEM_ID,
      tpa_claim_id: TPA_CLAIM_ID,
      order_version: ORDER_VERSION,
      order_items_sha256: ORDER_HASH,
      amount_outstanding: expectedOutstanding,
    });
    expect(result.evidence).toMatchObject({
      contract: 'pharmacy_tpa_line_decision_v1',
      command_key_sha256: COMMAND_HASH,
      request_sha256: captured.commandClaim.requestSha256,
      amount_outstanding: expectedOutstanding,
      payment_allocation_ids: allocations.map((row) => row.allocation_id),
      allocated_payment_amount: allocations.reduce(
        (sum, row) => sum + Number(row.allocated_amount),
        0,
      ),
    });
    expect(captured.tpaDecisionEvents).toHaveLength(1);
    expect(captured.tpaDecisionEvents[0]).toMatchObject({
      sourceAuthorityVersion: ORDER_VERSION,
      sourceAuthoritySha256: ORDER_HASH,
      commandKeySha256: COMMAND_HASH,
      actorUid: ACTOR,
      evidence: result.evidence,
    });
    if (hasCurrentAuthority) {
      expect(captured.authorityEvents).toHaveLength(1);
      expect(captured.authorityEvents[0]).toMatchObject({
        event_type: 'AUTHORITY_INVALIDATED',
        command_key_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        supersedes_event_id: 710,
        authority_generation: 3,
      });
      expect(captured.authorityEvents[0].evidence).toMatchObject({
        invalidation_reason: 'tpa_line_decision_changed',
        invalidation_command_key_sha256: COMMAND_HASH,
        prior_funding_event_id: 710,
      });
    } else {
      expect(captured.authorityEvents).toEqual([]);
      expect(result.fundingAuthority.authorityEvidence).toBeNull();
    }
    expect(captured.commandCompletions[0]).toEqual({
      tenantId: TENANT,
      commandKeySha256: COMMAND_HASH,
      responseBody: result,
    });
  });

  it('records a payable line and resolves fully funded authority in the same transaction', async () => {
    scenario.completedPostedTask = {
      id: 311,
      status: 'completed',
      assigned_to_role: 'FINANCE_INCHARGE',
      metadata: { contract: 'pharmacy_funding_task_v1', task_type: 'posted_payment' },
      completed_at: '2026-08-30T00:00:01.000Z',
    };

    const result = await recordPharmacyFundingLineDecision(decisionArgs({
      orderItemsSha256: `  ${ORDER_HASH.toUpperCase()}  `,
      approvedAmount: 100,
      nonPayableAmount: 0,
      reasonCode: 'other',
      reasonText: null,
    }));

    expect(result).toMatchObject({
      replayed: false,
      status: 'funded',
      decision: {
        id: 501,
        approved_amount: 100,
        non_payable_amount: 0,
      },
      task: { id: TASK_ID, status: 'completed' },
      nextTask: null,
      fundingAuthority: {
        status: 'funded',
        collectedAmount: 0,
        fundedAmount: 100,
        fundingSource: 'tpa_claim',
        fundingReference: `tpa:${TPA_CLAIM_ID}`,
        fundingTpaClaimId: TPA_CLAIM_ID,
        invoiceId: INVOICE_ID,
        invoiceItemId: INVOICE_ITEM_ID,
        paymentIds: [],
        task: { id: 311, status: 'completed' },
      },
    });
    expect(captured.billingLineUpdates).toEqual([{
      tenantId: TENANT,
      invoiceItemId: INVOICE_ITEM_ID,
      decision: 'payable',
      reasonCode: null,
      actorUid: ACTOR,
    }]);
    expect(captured.decision.source_authority_sha256).toBe(ORDER_HASH);
    expect(result.evidence.order_items_sha256).toBe(ORDER_HASH);
    expect(captured.taskCompletions.map(({ resourceType, taskId }) => ({
      resourceType,
      taskId,
    }))).toEqual([
      { resourceType: 'pharmacy_tpa_line_decision', taskId: TASK_ID },
      { resourceType: 'pharmacy_posted_payment', taskId: null },
    ]);
    expect(captured.nextTasks).toEqual([]);
    expect(captured.invoiceRecomputes).toHaveLength(1);
    expect(captured.lineMaterializedEvents).toHaveLength(1);
    expect(captured.lineMaterializedEvents[0]).toMatchObject({
      commandKeySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      actorUid: ACTOR,
      evidence: { authority_changed: false },
    });
    expect(captured.tpaDecisionEvents).toHaveLength(1);
    expect(captured.tpaDecisionEvents[0]).toMatchObject({
      sourceAuthorityVersion: ORDER_VERSION,
      sourceAuthoritySha256: ORDER_HASH,
      commandKeySha256: COMMAND_HASH,
      evidence: expect.objectContaining({ order_items_sha256: ORDER_HASH }),
    });
    expect(captured.decisionLookups).toEqual([{
      tenantId: TENANT,
      claimId: TPA_CLAIM_ID,
      invoiceItemId: INVOICE_ITEM_ID,
      sourceAuthorityVersion: ORDER_VERSION,
      sourceAuthoritySha256: ORDER_HASH,
    }]);
    expect(captured.authorityEvents).toHaveLength(1);
    expect(captured.authorityEvents[0]).toMatchObject({
      event_type: 'FUNDING_RESOLVED',
      task_id: 311,
      amount: 100,
      command_key_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      authority_generation: 1,
      supersedes_event_id: null,
    });
    expect(captured.authorityEvents[0].evidence).toMatchObject({
      contract: 'pharmacy_funding_authority_v1',
      pharmacy_order_id: ORDER_ID,
      invoice_id: INVOICE_ID,
      invoice_item_id: INVOICE_ITEM_ID,
      tpa_claim_id: TPA_CLAIM_ID,
      approved_tpa_amount: 100,
      combined_authority_amount: 100,
      authority_generation: 1,
      supersedes_event_id: null,
      authority_fingerprint_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(captured.commandCompletions).toHaveLength(1);
    expect(captured.commandCompletions[0].responseBody).toEqual(result);
    expect(resolvePatientUidMock).toHaveBeenCalledTimes(2);
    expect(lockAuthorityMock).toHaveBeenCalledTimes(2);
    expect(lockAdmissionMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the exact task update cannot complete', async () => {
    scenario.completedLineTask = null;

    await expectDecisionError({}, 'PHARMACY_TPA_TASK_AUTHORITY_STALE', 409);

    expect(captured.decision).toMatchObject({ id: 501 });
    expect(captured.billingLineUpdates).toHaveLength(1);
    expect(captured.taskCompletions).toHaveLength(1);
    expect(captured.nextTasks).toEqual([]);
    expect(captured.tpaDecisionEvents).toEqual([]);
    expect(captured.commandCompletions).toEqual([]);
  });

  it('fails closed when the claimed command cannot transition to COMPLETE', async () => {
    scenario.commandCompletionSucceeds = false;

    await expectDecisionError({}, 'PHARMACY_FUNDING_COMMAND_STATE_CONFLICT', 409);

    expect(captured.decision).toMatchObject({ id: 501 });
    expect(captured.taskCompletions).toHaveLength(1);
    expect(captured.nextTasks).toHaveLength(1);
    expect(captured.tpaDecisionEvents).toHaveLength(1);
    expect(captured.commandCompletions).toHaveLength(1);
  });
});

describe('recordPharmacyFundingLineDecision SQL router', () => {
  it('keeps SQL classification strict and exercises both query and execute mutations', async () => {
    await recordPharmacyFundingLineDecision(decisionArgs());

    expect(queryCallsContaining('INSERT INTO tpa_claim_line_decisions')).toHaveLength(1);
    expect(executeCallsContaining('INSERT INTO pharmacy_funding_commands')).toHaveLength(1);
    expect(mutationCalls().length).toBeGreaterThan(5);
  });
});
