import { jest } from '@jest/globals';

const queryMock = jest.fn();
const executeMock = jest.fn();
const setTenantTxMock = jest.fn();
const lockSubstitutionAuthorityMock = jest.fn();
const lockAuthorityMock = jest.fn();
const lockAdmissionMock = jest.fn();
const releaseReservationMock = jest.fn();
const resolvePatientUidMock = jest.fn();
const orderItemsSha256Mock = jest.fn();

const mockTx = {
  $queryRawUnsafe: queryMock,
  $executeRawUnsafe: executeMock,
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: mockTx,
  isTenantTransactionClient: (value) => value === mockTx,
  setTenantTx: setTenantTxMock,
  setTenant: async (_tenantId, fn) => fn(mockTx),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(mockTx),
  pickTenantClient: () => mockTx,
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
  resolveLedgerWiring: async () => ({
    mode: 'shadow', sameTx: false, postCommit: true, skip: false,
  }),
  resolveLedgerModeForTenant: async () => 'shadow',
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacyCapService.js', () => ({
  lockCounterFundingSubstitutionAuthorityTx: lockSubstitutionAuthorityMock,
  lockPharmacyFundingAdmissionTx: lockAdmissionMock,
  lockPharmacyFundingAuthorityTx: lockAuthorityMock,
  releasePharmacyCapReservationTx: releaseReservationMock,
  resolvePharmacyFundingPatientUidTx: resolvePatientUidMock,
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacistVerificationService.js', () => ({
  clinicalOrderItemsSha256: orderItemsSha256Mock,
}));

const service = await import('../../services/billing/billingV2Service.js');

const TENANT = '00000000-0000-4000-8000-000000000753';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const HASH = 'a'.repeat(64);
const COMMAND = 'c'.repeat(64);

function order(overrides = {}) {
  return {
    id: 41,
    patient_id: 7,
    uid: PATIENT,
    patient_uid: PATIENT,
    patient_name: 'Funding Patient',
    patient_phone: '9000000000',
    order_number: 'RX-41',
    facility_id: 9,
    total_amount: '100.00',
    inventory_authority_version: 3,
    status: 'READY',
    items_list: [{ medication_id: 5, quantity: 1 }],
    payment_mode: 'cash',
    payment_metadata: {},
    funding_admission_id: null,
    funding_admission_order_version: null,
    funding_admission_items_sha256: null,
    ...overrides,
  };
}

function line(overrides = {}) {
  return {
    id: 71,
    invoice_id: 61,
    description: 'Pharmacy order 41',
    line_total: '100.00',
    source_authority_version: 3,
    source_authority_sha256: HASH,
    invoice_status: 'DRAFT',
    patient_uid: PATIENT,
    admission_id: null,
    invoice_tenant_id: TENANT,
    source_ref_type: 'pharmacy_order',
    source_ref_id: 41,
    source_ref_active: true,
    ...overrides,
  };
}

function advanceAllocation(overrides = {}) {
  return {
    id: '801',
    allocated_amount: '100.00',
    billing_advance_id: 901,
    invoice_id: 61,
    invoice_item_id: 71,
    funding_task_id: 81,
    funding_approval_receipt_id: null,
    ...overrides,
  };
}

function financeTask(overrides = {}) {
  return {
    id: 81,
    status: 'open',
    assigned_to_role: 'FINANCE_INCHARGE',
    related_resource_type: 'pharmacy_posted_payment',
    related_resource_id: '41',
    metadata: {
      contract: 'pharmacy_funding_task_v1',
      task_type: 'posted_payment',
      stage: 'payment_posting',
      pharmacy_order_id: 41,
      admission_id: null,
      invoice_id: 61,
      invoice_item_id: 71,
      tpa_claim_id: null,
      order_version: 3,
      order_items_sha256: HASH,
      authoritative_amount: 100,
      amount_outstanding: 100,
    },
    ...overrides,
  };
}

function insuranceTask(overrides = {}) {
  return {
    id: 82,
    status: 'open',
    assigned_to_role: 'INSURANCE_COORDINATOR',
    related_resource_type: 'pharmacy_tpa_line_decision',
    related_resource_id: '41',
    metadata: {
      contract: 'pharmacy_funding_task_v1',
      task_type: 'tpa_line_decision',
      stage: 'line_decision',
      pharmacy_order_id: 41,
      admission_id: 51,
      invoice_id: 61,
      invoice_item_id: 71,
      tpa_claim_id: 91,
      order_version: 3,
      order_items_sha256: HASH,
      authoritative_amount: 100,
      amount_outstanding: 100,
    },
    ...overrides,
  };
}

function allocation(overrides = {}) {
  return {
    allocation_id: 401,
    allocated_amount: '100.00',
    payment_id: 301,
    mode: 'CASH',
    reference: 'cash-301',
    collected_at: '2026-08-30T05:00:00.000Z',
    ...overrides,
  };
}

function claim(overrides = {}) {
  return {
    id: 91,
    claim_number: 'CLM-91',
    tpa_reference_id: 'TPA-91',
    status: 'approved',
    approved_amount: '100.00',
    invoice_id: 61,
    preauth_id: 19,
    admission_id: 51,
    patient_uid: PATIENT,
    ...overrides,
  };
}

function decision(overrides = {}) {
  return {
    id: 501,
    claim_id: 91,
    invoice_item_id: 71,
    approved_amount: '100.00',
    non_payable_amount: '0.00',
    reason_code: 'other',
    source_authority_version: 3,
    source_authority_sha256: HASH,
    ...overrides,
  };
}

function baseState(overrides = {}) {
  const currentOrder = overrides.order ?? order();
  const currentLine = overrides.line ?? line({
    admission_id: currentOrder.funding_admission_id,
  });
  return {
    order: currentOrder,
    orderRows: [currentOrder],
    wrapperOrderRows: [currentOrder],
    actorRows: [{ uid: ACTOR, role: 'FINANCE_INCHARGE' }],
    facilityGrantRows: [{ id: 601, authority_version: 1 }],
    admissions: [],
    claimRows: [],
    sourceLines: [currentLine],
    reconciliationRows: [],
    allocations: [],
    terminalAllocations: [],
    allocatedByPaymentRows: [],
    payments: [],
    decisionRows: [],
    reservationRows: [],
    stockRows: [],
    substitutionTasks: [],
    substitutionApprovals: [],
    substitutionCommands: [],
    advanceAllocations: [],
    advanceAllocationReversals: [],
    currentEvents: [],
    aggregate: { subtotal: '100.00', cgst: '0', sgst: '0', igst: '0' },
    invoiceFinancial: { discount_amount: '0', credit_note_amount: '0', amount_paid: '0' },
    invoiceMeta: [{ admission_id: currentOrder.funding_admission_id, patient_uid: PATIENT, tenant_id: TENANT }],
    invoice: {
      id: 61,
      status: 'DRAFT',
      patient_uid: PATIENT,
      admission_id: currentOrder.funding_admission_id,
      tenant_id: TENANT,
      subtotal: '100.00',
      cgst_amount: '0',
      sgst_amount: '0',
      igst_amount: '0',
      total_amount: '100.00',
      amount_paid: '0',
      amount_due: '100.00',
    },
    financeTask: financeTask({
      metadata: {
        ...financeTask().metadata,
        admission_id: currentOrder.funding_admission_id,
      },
    }),
    insuranceTask: insuranceTask(),
    completePostedTask: { ...financeTask(), status: 'completed', completed_at: '2026-08-30T05:05:00.000Z' },
    completeInsuranceTask: { ...insuranceTask(), status: 'completed', completed_at: '2026-08-30T05:04:00.000Z' },
    receipt: null,
    upsertedTasks: [],
    createdInvoices: [],
    authorityEvents: [],
    tpaEvents: [],
    ...overrides,
  };
}

function compactSql(rawSql) {
  return String(rawSql).replace(/\s+/g, ' ').trim();
}

function json(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function installSqlRouter(overrides = {}) {
  const state = baseState(overrides);
  lockSubstitutionAuthorityMock.mockImplementation(async (_tx, { tenantId, orderId }) => {
    if (state.substitutionTasks.length || state.substitutionApprovals.length
        || state.substitutionCommands.length) {
      const error = new Error('A governed substitution funding workflow already owns this order');
      error.statusCode = 409;
      error.code = 'PHARMACY_SUBSTITUTION_FUNDING_AUTHORITY_CONFLICT';
      error.details = {
        pharmacy_order_id: Number(orderId),
        task_ids: state.substitutionTasks.map((row) => Number(row.id)),
        approval_ids: state.substitutionApprovals.map((row) => Number(row.id)),
        command_receipt_ids: state.substitutionCommands.map((row) => String(row.id)),
        next_action: 'complete_or_govern_release_of_substitution_funding_authority',
      };
      throw error;
    }
    return { tenantId, orderId: Number(orderId), patientUid: PATIENT };
  });

  queryMock.mockImplementation(async (rawSql, ...params) => {
    const sql = compactSql(rawSql);

    if (sql.includes('SELECT uid, UPPER(role) AS role') && sql.includes('FROM users')) {
      return state.actorRows;
    }
    if (sql.includes('SELECT uid FROM users') && sql.includes('tenant_id = $2::uuid')) {
      return [{ uid: PATIENT }];
    }
    if (sql.startsWith('SELECT patient.uid FROM users patient')) {
      return [{ uid: PATIENT }];
    }
    if (sql.includes('FROM pharmacy_staff_facility_grants')) return state.facilityGrantRows;

    if (sql.includes('SELECT pharmacy_order.*,patient.uid AS patient_uid')) {
      return state.orderRows;
    }
    if (sql.includes('FROM pharmacy_orders pharmacy_order')
        && sql.includes('patient.uid AS patient_uid')) {
      return state.wrapperOrderRows;
    }
    if (sql.includes('FROM pharmacy_orders po') && sql.includes('patient.uid AS patient_uid')) {
      return state.orderRows;
    }

    // TPA line-decision admission discovery selects status instead of
    // filtering on it; serve the same fixture rows.
    if (sql.startsWith('SELECT id,patient_uid,status')
        && sql.includes('FROM admissions')) {
      return state.admissions;
    }
    if (sql.includes('FROM admissions') && sql.includes("status='admitted'")) {
      return state.admissions;
    }
    if (sql.includes('SELECT patient_uid, billing_closed_at') && sql.includes('FROM admissions')) {
      return [{ patient_uid: PATIENT, billing_closed_at: null }];
    }

    if (sql.includes('FROM tpa_claims claim')) return state.claimRows;
    if (sql.includes('SELECT id,invoice_id,admission_id,patient_uid,status')
        && sql.includes('FROM tpa_claims')) {
      return state.claimRows;
    }
    if (sql.includes('SELECT * FROM tpa_claims')) return state.claimRows;
    if (sql.includes('SELECT id FROM tpa_claims')) {
      return state.claimRows.map((row) => ({ id: row.id }));
    }

    if (sql.includes('SELECT item.id AS invoice_item_id')
        && sql.includes("item.source_ref_type='pharmacy_order'")) {
      return state.sourceLines.map((item) => ({
        invoice_item_id: item.id,
        invoice_id: item.invoice_id,
        line_total: item.line_total,
        invoice_status: item.invoice_status,
      }));
    }
    if (sql.includes('SELECT item.id,item.invoice_id')
        && sql.includes("item.source_ref_type='pharmacy_order'")) {
      return state.sourceLines.map((item) => ({ id: item.id, invoice_id: item.invoice_id }));
    }
    if (sql.includes('SELECT id,invoice_id')
        && sql.includes('FROM billing_invoice_items')
        && sql.includes("source_ref_type='pharmacy_order'")) {
      return state.sourceLines.map((item) => ({ id: item.id, invoice_id: item.invoice_id }));
    }
    if (sql.includes('FROM billing_invoice_items')
        && sql.includes('id=ANY($2::int[])')
        && sql.includes('FOR UPDATE')) {
      const ids = new Set(params[1].map(Number));
      return state.sourceLines.filter((item) => ids.has(Number(item.id)));
    }
    if (sql.includes('SELECT item.*,invoice.status AS invoice_status')
        || sql.includes('SELECT item.*,invoice.patient_uid,invoice.admission_id')) {
      return state.sourceLines;
    }

    if (sql.includes('FROM pharmacy_funding_reconciliation_cases reconciliation')) {
      return state.reconciliationRows;
    }

    if (sql.startsWith('UPDATE billing_invoice_items') && sql.includes('RETURNING *')) {
      const existing = state.sourceLines.find((item) => Number(item.id) === Number(params[1]));
      const updated = {
        ...existing,
        description: params[2],
        unit_price: params[3],
        line_subtotal: params[3],
        line_total: params[3],
        source_authority_version: params[4],
        source_authority_sha256: params[5],
        ...(params[6] ? {
          tpa_decision: 'pending',
          tpa_non_payable_reason: null,
          tpa_decided_at: null,
          tpa_decided_by: null,
        } : {}),
      };
      state.sourceLines = [updated];
      return [updated];
    }
    if (sql.startsWith('INSERT INTO billing_invoice_items')) {
      const inserted = line({
        invoice_id: params[0],
        description: params[1],
        unit_price: params[2],
        line_subtotal: params[2],
        line_total: params[2],
        source_authority_version: params[6],
        source_authority_sha256: params[7],
      });
      state.sourceLines = [inserted];
      return [inserted];
    }

    if (sql.includes('COALESCE(SUM(line_subtotal)') && sql.includes('FROM billing_invoice_items')) {
      return [state.aggregate];
    }
    if (sql.includes('SELECT discount_amount, credit_note_amount, amount_paid')) {
      return [state.invoiceFinancial];
    }
    if (sql.includes('SELECT admission_id, patient_uid, tenant_id')
        && sql.includes('FROM billing_invoices')) {
      return state.invoiceMeta;
    }
    if (sql.startsWith('SELECT id,status,patient_uid,admission_id,tenant_id,subtotal')
        && sql.includes('FROM billing_invoices')
        && sql.includes('id=ANY($2::int[])')
        && sql.includes('FOR UPDATE')) {
      // lockPharmacyFundingInvoicesTx (billingV2Service materialize flow) now serves the
      // join fields the removed item+invoice JOIN read carried, so the invoice row must
      // honour line-level admission overrides from the suite's sourceLines fixtures.
      const ids = new Set(params[1].map(Number));
      if (!ids.has(Number(state.invoice.id))) return [];
      const joinedLine = state.sourceLines.find(
        (item) => Number(item.invoice_id) === Number(state.invoice.id),
      );
      return [{
        ...state.invoice,
        admission_id: joinedLine === undefined
          ? state.invoice.admission_id
          : joinedLine.admission_id,
      }];
    }
    if (sql.includes('FROM billing_invoices')
        && sql.includes('id=ANY($2::int[])')
        && sql.includes('FOR UPDATE')) {
      const ids = new Set(params[1].map(Number));
      return ids.has(Number(state.invoice.id)) ? [state.invoice] : [];
    }
    if (sql.includes('SELECT id FROM billing_invoices') && sql.includes('FOR UPDATE')) {
      return [{ id: state.invoice.id }];
    }
    if (sql.startsWith('INSERT INTO billing_invoices')) {
      const created = {
        ...state.invoice,
        patient_uid: params[0],
        patient_name: params[1],
        patient_phone: params[2],
        admission_id: params[3],
        department: params[5],
        invoice_type: params[6],
        notes: params[9],
        created_by: params[10],
        tenant_id: params[11],
      };
      state.invoice = created;
      state.createdInvoices.push(created);
      return [created];
    }
    if (sql.includes('SELECT * FROM billing_invoices')) return [state.invoice];

    if (sql.includes('SELECT allocation.billing_payment_id')) {
      return state.allocatedByPaymentRows;
    }
    if (sql.includes('FROM pharmacy_advance_allocations allocation')
        && sql.includes('allocation.pharmacy_order_id=$2::int')) {
      return state.advanceAllocations;
    }
    if (sql.includes('FROM pharmacy_advance_allocation_reversals')
        && sql.includes('allocation_id=ANY($2::bigint[])')) {
      return state.advanceAllocationReversals;
    }
    if (sql.includes('SELECT allocation.id AS allocation_id')) return state.allocations;
    if (sql.includes('SELECT allocation.*') && sql.includes('remaining_amount')) {
      return state.terminalAllocations;
    }
    if (sql.includes('FROM billing_payments payment') && sql.includes('FOR UPDATE')) {
      return state.payments;
    }
    if (sql.includes('FROM billing_payments') && sql.includes('invoice_id=ANY($2::int[])')) {
      return [];
    }
    if (sql.includes('FROM billing_refunds') && sql.includes('invoice_id=ANY($2::int[])')) {
      return [];
    }
    if (sql.includes('FROM billing_advance_settlements')
        && sql.includes('invoice_id=ANY($2::int[])')) {
      return [];
    }
    if (sql.startsWith('INSERT INTO pharmacy_payment_allocations')) {
      const inserted = allocation({
        allocation_id: 400 + state.allocations.length + 1,
        allocated_amount: Number(params[7]).toFixed(2),
        payment_id: Number(params[4]),
        mode: state.payments.find((payment) => Number(payment.id) === Number(params[4]))?.mode || 'CASH',
        reference: state.payments.find((payment) => Number(payment.id) === Number(params[4]))?.reference || null,
        collected_at: state.payments.find((payment) => Number(payment.id) === Number(params[4]))?.collected_at || null,
      });
      state.allocations.push(inserted);
      return [{ id: inserted.allocation_id }];
    }

    if (sql.includes('SELECT * FROM tpa_claim_line_decisions')) return state.decisionRows;
    if (sql.includes('SELECT COALESCE(SUM(approved_amount),0)::numeric AS approved')) {
      return [{ approved: state.otherApprovedAmount || 0 }];
    }
    if (sql.startsWith('INSERT INTO tpa_claim_line_decisions')) {
      const inserted = decision({
        approved_amount: params[5],
        non_payable_amount: params[6],
        reason_code: params[3],
        reason_text: params[4],
        source_authority_version: params[8],
        source_authority_sha256: params[9],
      });
      state.decisionRows = [inserted];
      return [inserted];
    }

    if (sql.includes('FROM tasks') && sql.includes('related_resource_type=ANY($3::text[])')
        && sql.includes("metadata->>'contract'=$4")) {
      return state.substitutionTasks;
    }
    if (sql.includes('FROM approvals')
        && sql.includes("approval_kind='pharmacy_substitution_funding_reauthorisation'")) {
      return state.substitutionApprovals;
    }
    if (sql.includes('FROM pharmacy_funding_commands')
        && sql.includes("command_type='SUBSTITUTION_FUNDING_APPROVAL'")) {
      return state.substitutionCommands;
    }

    if (sql.startsWith('INSERT INTO tasks')) {
      const metadata = json(params[8]);
      const task = {
        id: metadata.task_type === 'tpa_line_decision' ? 82 : 81,
        status: 'open',
        assigned_to_role: params[6],
        related_resource_type: params[4],
        related_resource_id: params[5],
        metadata,
        created_at: '2026-08-30T05:00:00.000Z',
        updated_at: '2026-08-30T05:00:00.000Z',
      };
      state.upsertedTasks.push(task);
      if (metadata.task_type === 'tpa_line_decision') state.insuranceTask = task;
      else state.financeTask = task;
      return [task];
    }
    if (sql.startsWith('UPDATE tasks') && sql.includes("status='completed'")) {
      const resourceType = params[1];
      if (resourceType === 'pharmacy_tpa_line_decision') {
        return state.completeInsuranceTask == null ? [] : [state.completeInsuranceTask];
      }
      return state.completePostedTask == null ? [] : [state.completePostedTask];
    }
    if (sql.includes('SELECT * FROM tasks')
        && sql.includes("related_resource_type='pharmacy_posted_payment'")) {
      return state.financeTask == null ? [] : [state.financeTask];
    }
    if (sql.includes('SELECT * FROM tasks')
        && sql.includes("related_resource_type='pharmacy_tpa_line_decision'")) {
      return state.insuranceTask == null ? [] : [state.insuranceTask];
    }

    if (sql.includes('SELECT * FROM pharmacy_funding_commands')) {
      return state.receipt == null ? [] : [state.receipt];
    }
    if (sql.startsWith('UPDATE pharmacy_funding_commands')) {
      if (state.receipt == null || state.receipt.status !== 'IN_PROGRESS') return [];
      state.receipt = {
        ...state.receipt,
        status: 'COMPLETE',
        response_body: json(params[2]),
        completed_at: '2026-08-30T05:06:00.000Z',
      };
      return [state.receipt];
    }

    if (sql.includes('SELECT pg_advisory_xact_lock')
        && sql.includes('vh:pharmacy_funding_event_chain:')) {
      return [{ lock_acquired: '1' }];
    }
    if (sql.includes('SELECT pg_advisory_xact_lock')
        && sql.includes('hashtextextended($1::text,753)')) {
      return [{ lock_acquired: '1' }];
    }
    // patientMergeStabilityLock takes a tenant-wide shared merge-stability lock at the
    // top of every billingV2Service setTenantTx funding flow.
    if (sql.includes('FROM pg_advisory_xact_lock_shared(hashtextextended($1::text, 0))')) {
      return [{ locked: 1 }];
    }
    if (sql.includes('FROM pharmacy_funding_decision_events event')) {
      return state.currentEvents;
    }
    if (sql.startsWith('INSERT INTO pharmacy_funding_decision_events')
        && sql.includes('authority_generation')) {
      const event = {
        id: 701 + state.authorityEvents.length,
        tenant_id: params[0],
        facility_id: params[1],
        pharmacy_order_id: params[2],
        admission_id: params[3],
        event_type: params[4],
        invoice_id: params[7],
        invoice_item_id: params[8],
        tpa_claim_id: params[9],
        billing_payment_id: params[10],
        task_id: params[11],
        amount: params[12],
        evidence: json(params[14]),
        authority_generation: params[16],
        supersedes_event_id: params[17],
      };
      state.authorityEvents.push(event);
      return [event];
    }
    if (sql.startsWith('INSERT INTO pharmacy_funding_decision_events')
        && sql.includes("'TPA_DECISION_RECORDED'")) {
      const event = { id: 751 + state.tpaEvents.length, evidence: json(params[12]) };
      state.tpaEvents.push(event);
      return [event];
    }

    // Posted-payment completion rechecks invoice refund-source headroom
    // (resolveRefundSourceAuthorityTx, invoice branch); return generous headroom
    // so the drivers proceed - mirrors the Authority/Retry suites' branch.
    if (sql.includes('AS source_amount')
        && sql.includes('AS active_refunds')
        && sql.includes('AS pharmacy_allocations')) {
      return [{ source_amount: '1000', active_refunds: '0', pharmacy_allocations: '0' }];
    }
    if (sql.includes('SELECT id FROM pharmacy_stock_movements')) return state.stockRows;
    if (sql.includes('SELECT admission_id FROM pharmacy_cap_reservations')) {
      return state.reservationRows;
    }

    throw new Error(`Unhandled pharmacy-funding query SQL: ${sql.slice(0, 220)}`);
  });

  executeMock.mockImplementation(async (rawSql, ...params) => {
    const sql = compactSql(rawSql);

    if (sql.startsWith('INSERT INTO pharmacy_funding_commands')) {
      if (state.receipt == null) {
        state.receipt = {
          tenant_id: params[0],
          command_key_sha256: params[1],
          command_type: params[2],
          task_id: params[3],
          task_resource_type: params[4],
          task_resource_id: params[5],
          pharmacy_order_id: params[6],
          invoice_item_id: params[7],
          tpa_claim_id: params[8],
          request_sha256: params[9],
          status: 'IN_PROGRESS',
          created_by: params[10],
        };
      }
      return 1;
    }
    if (sql.startsWith('UPDATE billing_invoices') && sql.includes('SET subtotal')) return 1;
    if (sql.startsWith('INSERT INTO pharmacy_funding_decision_events')) return 1;
    if (sql.startsWith('UPDATE pharmacy_orders') && sql.includes('funding_admission_id')) {
      state.order = {
        ...state.order,
        funding_admission_id: params[2],
        funding_admission_order_version: params[3],
        funding_admission_items_sha256: params[4],
      };
      state.orderRows = [state.order];
      return 1;
    }
    if (sql.startsWith('UPDATE tasks')) return 1;
    if (sql.startsWith('UPDATE tpa_claim_line_decisions')) return 1;
    if (sql.startsWith('UPDATE billing_invoice_items') && sql.includes('SET tpa_decision')) return 1;

    throw new Error(`Unhandled pharmacy-funding execute SQL: ${sql.slice(0, 220)}`);
  });

  return state;
}

function authority(overrides = {}) {
  return {
    tenantId: TENANT,
    facilityId: 9,
    orderId: 41,
    patientId: 7,
    patientUid: PATIENT,
    authoritativeAmount: 100,
    orderVersion: 3,
    orderItemsSha256: HASH,
    paymentMode: 'cash',
    actorUid: ACTOR,
    actorRole: 'FINANCE_INCHARGE',
    ...overrides,
  };
}

async function callExport(name, ...args) {
  expect(service[name]).toEqual(expect.any(Function));
  return service[name](...args);
}

function mutationCalls() {
  return [...queryMock.mock.calls, ...executeMock.mock.calls]
    .filter(([rawSql]) => /^(INSERT|UPDATE|DELETE)\b/i.test(compactSql(rawSql)));
}

function queryCallsContaining(fragment) {
  return queryMock.mock.calls.filter(([rawSql]) => compactSql(rawSql).includes(fragment));
}

function executeCallsContaining(fragment) {
  return executeMock.mock.calls.filter(([rawSql]) => compactSql(rawSql).includes(fragment));
}

function invocationOrder(mock, predicate) {
  const index = mock.mock.calls.findIndex(([rawSql]) => predicate(compactSql(rawSql)));
  expect(index).toBeGreaterThanOrEqual(0);
  return mock.mock.invocationCallOrder[index];
}

beforeEach(() => {
  queryMock.mockReset();
  executeMock.mockReset();
  setTenantTxMock.mockReset();
  lockSubstitutionAuthorityMock.mockReset();
  lockAuthorityMock.mockReset();
  lockAdmissionMock.mockReset();
  releaseReservationMock.mockReset();
  resolvePatientUidMock.mockReset();
  orderItemsSha256Mock.mockReset();

  setTenantTxMock.mockImplementation(async (_tenantId, fn) => fn(mockTx));
  resolvePatientUidMock.mockResolvedValue(PATIENT);
  lockAdmissionMock.mockResolvedValue({
    id: 51,
    patient_uid: PATIENT,
    status: 'admitted',
  });
  orderItemsSha256Mock.mockReturnValue(HASH);
});

describe('materializePharmacyFundingTaskTx cash state', () => {
  it('returns a finance-owned blocked tuple without inventing funding', async () => {
    const state = installSqlRouter();

    const result = await callExport('materializePharmacyFundingTaskTx', mockTx, authority());

    expect(result).toMatchObject({
      status: 'blocked',
      admissionId: null,
      invoiceId: 61,
      invoiceItemId: 71,
      tpaClaimId: null,
      approvedTpaAmount: 0,
      allocatedPaymentAmount: 0,
      fundingRecovery: {
        task_id: '81',
        task_type: 'posted_payment',
        owner_role: 'FINANCE_INCHARGE',
        pharmacy_order_id: 41,
        invoice_id: 61,
        invoice_item_id: 71,
        amount_outstanding: 100,
      },
    });
    expect(state.upsertedTasks[0].metadata).toMatchObject({
      stage: 'payment_posting',
      order_version: 3,
      order_items_sha256: HASH,
    });
    expect(executeCallsContaining("'LINE_MATERIALIZED'")).toHaveLength(1);
  });

  it('returns ready only when exact posted-payment allocations cover the tuple', async () => {
    installSqlRouter({ allocations: [allocation()] });

    const result = await callExport('materializePharmacyFundingTaskTx', mockTx, authority());

    expect(result).toMatchObject({
      status: 'ready',
      allocatedPaymentAmount: 100,
      task: null,
      fundingRecovery: null,
    });
    expect(result.paymentAllocations).toEqual([allocation()]);
    expect(queryCallsContaining('INSERT INTO tasks')).toHaveLength(0);
  });

  it('resolves ready cash as billing_payment funding and completes task plus authority event', async () => {
    const state = installSqlRouter({ allocations: [allocation()] });

    const result = await callExport('resolvePostedPharmacyFundingTx', mockTx, authority());

    expect(result).toMatchObject({
      status: 'funded',
      collectedAmount: 100,
      fundedAmount: 100,
      fundingSource: 'billing_payment',
      fundingReference: 'payments:301',
      fundingTpaClaimId: null,
      invoiceId: 61,
      invoiceItemId: 71,
      paymentIds: [301],
      task: { id: 81, status: 'completed' },
      fundingRecovery: null,
      authorityEvidence: {
        contract: 'pharmacy_funding_authority_v1',
        pharmacy_order_id: 41,
        payment_ids: [301],
        payment_allocation_ids: [401],
        combined_authority_amount: 100,
      },
    });
    expect(state.authorityEvents).toHaveLength(1);
    expect(state.authorityEvents[0]).toMatchObject({
      event_type: 'FUNDING_RESOLVED',
      billing_payment_id: 301,
      task_id: 81,
      amount: 100,
    });
    expect(queryCallsContaining("SET status='completed'")).toHaveLength(1);
  });
});

describe('materializePharmacyFundingTaskTx TPA recovery stages', () => {
  it.each([
    {
      name: 'claim selection when no exact claim exists',
      claims: [],
      expectedStage: 'claim_selection',
      expectedClaimStatus: null,
    },
    {
      name: 'claim approval while the selected claim is pending',
      claims: [claim({ status: 'submitted' })],
      expectedStage: 'claim_approval',
      expectedClaimStatus: 'submitted',
    },
    {
      name: 'line decision after claim approval',
      claims: [claim()],
      expectedStage: 'line_decision',
      expectedClaimStatus: 'approved',
    },
  ])('$name', async ({ claims, expectedStage, expectedClaimStatus }) => {
    const tpaOrder = order({
      payment_mode: 'insurance',
      funding_admission_id: 51,
      funding_admission_order_version: 3,
      funding_admission_items_sha256: HASH,
    });
    const state = installSqlRouter({
      order: tpaOrder,
      orderRows: [tpaOrder],
      admissions: [{ id: 51, patient_uid: PATIENT, status: 'admitted' }],
      claimRows: claims,
      sourceLines: [line({ admission_id: 51 })],
      actorRows: [{ uid: ACTOR, role: 'INSURANCE_COORDINATOR' }],
    });

    const result = await callExport(
      'materializePharmacyFundingTaskTx',
      mockTx,
      authority({
        paymentMode: 'insurance',
        actorRole: 'INSURANCE_COORDINATOR',
        tpaClaimId: claims[0]?.id ?? null,
      }),
    );

    expect(result).toMatchObject({
      status: 'blocked',
      admissionId: 51,
      tpaClaimId: claims[0]?.id ?? null,
      claimStatus: expectedClaimStatus,
      fundingRecovery: {
        task_type: 'tpa_line_decision',
        owner_role: 'INSURANCE_COORDINATOR',
        amount_outstanding: 100,
      },
    });
    expect(state.upsertedTasks[0].metadata).toMatchObject({
      stage: expectedStage,
      admission_id: 51,
      tpa_claim_id: claims[0]?.id ?? null,
    });
    expect(lockAdmissionMock).toHaveBeenCalledWith(mockTx, {
      tenantId: TENANT,
      admissionId: 51,
      patientUid: PATIENT,
    });
  });
});

describe('materialization writes missing or replaced authority', () => {
  it('auto-binds the admitted encounter to the exact TPA order authority', async () => {
    const unboundTpaOrder = order({ payment_mode: 'insurance' });
    const state = installSqlRouter({
      order: unboundTpaOrder,
      orderRows: [unboundTpaOrder],
      actorRows: [{ uid: ACTOR, role: 'INSURANCE_COORDINATOR' }],
      admissions: [{ id: 51, patient_uid: PATIENT, status: 'admitted' }],
      sourceLines: [line({ admission_id: 51 })],
    });

    const result = await callExport(
      'materializePharmacyFundingTaskTx',
      mockTx,
      authority({ paymentMode: 'insurance', actorRole: 'INSURANCE_COORDINATOR' }),
    );

    expect(result).toMatchObject({
      status: 'blocked',
      admissionId: 51,
      fundingRecovery: { task_type: 'tpa_line_decision' },
    });
    expect(state.order).toMatchObject({
      funding_admission_id: 51,
      funding_admission_order_version: 3,
      funding_admission_items_sha256: HASH,
    });
    const bindingWrite = executeCallsContaining('UPDATE pharmacy_orders')[0];
    expect(bindingWrite.slice(1)).toEqual([TENANT, 41, 51, 3, HASH]);
    expect(invocationOrder(
      executeMock,
      (sql) => sql.startsWith('UPDATE pharmacy_orders'),
    )).toBeLessThan(invocationOrder(
      queryMock,
      (sql) => sql.startsWith('UPDATE billing_invoice_items'),
    ));
  });

  it('creates one draft invoice and one active pharmacy line when neither exists', async () => {
    const state = installSqlRouter({ sourceLines: [] });

    const result = await callExport('materializePharmacyFundingTaskTx', mockTx, authority());

    expect(result).toMatchObject({
      status: 'blocked',
      invoiceId: 61,
      invoiceItemId: 71,
      fundingRecovery: { task_type: 'posted_payment', amount_outstanding: 100 },
    });
    expect(state.createdInvoices).toEqual([expect.objectContaining({
      id: 61,
      patient_uid: PATIENT,
      patient_name: 'Funding Patient',
      patient_phone: '9000000000',
      admission_id: null,
      invoice_type: 'PHARMACY',
      department: 'Pharmacy',
      created_by: ACTOR,
      tenant_id: TENANT,
      status: 'DRAFT',
    })]);
    expect(queryCallsContaining('INSERT INTO billing_invoices')).toHaveLength(1);
    expect(queryCallsContaining('INSERT INTO billing_invoice_items')).toHaveLength(1);
    expect(state.sourceLines[0]).toMatchObject({
      id: 71,
      invoice_id: 61,
      line_total: 100,
      source_authority_version: 3,
      source_authority_sha256: HASH,
    });
    expect(invocationOrder(
      queryMock,
      (sql) => sql.startsWith('INSERT INTO billing_invoices'),
    )).toBeLessThan(invocationOrder(
      queryMock,
      (sql) => sql.startsWith('INSERT INTO billing_invoice_items'),
    ));
  });

  it('invalidates the old TPA decision before resetting a changed line authority', async () => {
    const staleLine = line({
      source_authority_version: 2,
      source_authority_sha256: 'b'.repeat(64),
      tpa_decision: 'payable',
      tpa_non_payable_reason: 'other',
      tpa_decided_at: '2026-08-29T05:00:00.000Z',
      tpa_decided_by: ACTOR,
    });
    const state = installSqlRouter({ sourceLines: [staleLine] });

    const result = await callExport('materializePharmacyFundingTaskTx', mockTx, authority());

    expect(result).toMatchObject({ status: 'blocked', invoiceItemId: 71 });
    const invalidationWrite = executeCallsContaining('UPDATE tpa_claim_line_decisions')[0];
    expect(invalidationWrite.slice(1)).toEqual([TENANT, 71, ACTOR]);
    const lineReset = queryCallsContaining('UPDATE billing_invoice_items')[0];
    expect(lineReset.slice(1)).toEqual([
      TENANT, 71, 'Pharmacy order 41', 100, 3, HASH, true,
    ]);
    expect(state.sourceLines[0]).toMatchObject({
      source_authority_version: 3,
      source_authority_sha256: HASH,
      tpa_decision: 'pending',
      tpa_non_payable_reason: null,
      tpa_decided_at: null,
      tpa_decided_by: null,
    });
    expect(invocationOrder(
      executeMock,
      (sql) => sql.startsWith('UPDATE tpa_claim_line_decisions'),
    )).toBeLessThan(invocationOrder(
      queryMock,
      (sql) => sql.startsWith('UPDATE billing_invoice_items'),
    ));
  });
});

describe('materialization authority guards', () => {
  it('rejects a stale order tuple before any write', async () => {
    installSqlRouter({ orderRows: [order({ inventory_authority_version: 4 })] });

    await expect(callExport(
      'materializePharmacyFundingTaskTx', mockTx, authority(),
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_FUNDING_ORDER_AUTHORITY_STALE',
      details: {
        current_order_version: 4,
        current_total_amount: 100,
        current_order_items_sha256: HASH,
        current_payment_mode: 'cash',
      },
    });
    expect(mutationCalls()).toHaveLength(0);
  });

  it('rejects an order outside the exact patient, tenant, and facility scope', async () => {
    installSqlRouter({ orderRows: [] });

    await expect(callExport(
      'materializePharmacyFundingTaskTx', mockTx, authority(),
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_FUNDING_ORDER_SCOPE_MISMATCH',
    });
    expect(mutationCalls()).toHaveLength(0);
  });

  it('requires a current facility grant for a pharmacy actor', async () => {
    installSqlRouter({
      actorRows: [{ uid: ACTOR, role: 'PHARMACIST' }],
      facilityGrantRows: [],
    });

    await expect(callExport(
      'materializePharmacyFundingTaskTx',
      mockTx,
      authority({ actorRole: 'PHARMACIST' }),
    )).rejects.toMatchObject({
      statusCode: 403,
      code: 'PHARMACY_FUNDING_FACILITY_GRANT_REQUIRED',
    });
    expect(mutationCalls()).toHaveLength(0);
  });

  it('requires exactly one admitted patient encounter for TPA funding', async () => {
    const tpaOrder = order({ payment_mode: 'insurance' });
    installSqlRouter({ order: tpaOrder, orderRows: [tpaOrder], admissions: [] });

    await expect(callExport(
      'materializePharmacyFundingTaskTx',
      mockTx,
      authority({ paymentMode: 'insurance' }),
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_FUNDING_ADMISSION_REQUIRED',
    });
    expect(mutationCalls()).toHaveLength(0);
  });

  it('returns the exact duplicate-line recovery tuple without changing either line', async () => {
    installSqlRouter({
      sourceLines: [line(), line({ id: 72 })],
      reconciliationRows: [{
        case_id: 901,
        status: 'OPEN',
        snapshot_sha256: HASH,
        task_id: 902,
        assigned_to_role: 'FINANCE_INCHARGE',
      }],
    });

    await expect(callExport(
      'materializePharmacyFundingTaskTx', mockTx, authority(),
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_FUNDING_LINE_AMBIGUOUS',
      details: {
        funding_reconciliation: {
          case_id: 901,
          deep_link: '/billing-desk?funding_reconciliation_case_id=901',
        },
        next_action: 'open_exact_pharmacy_funding_reconciliation',
        funding_recovery: {
          task_id: '902',
          status: 'open',
          owner_role: 'FINANCE_INCHARGE',
        },
      },
    });
    expect(mutationCalls()).toHaveLength(0);
  });

  it('rejects a line owned by a different patient before line mutation', async () => {
    installSqlRouter({
      invoice: {
        ...baseState().invoice,
        patient_uid: '33333333-3333-4333-8333-333333333333',
      },
    });

    await expect(callExport(
      'materializePharmacyFundingTaskTx', mockTx, authority(),
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_FUNDING_LINE_OWNERSHIP_MISMATCH',
    });
    expect(mutationCalls()).toHaveLength(0);
  });

  it.each([
    'pharmacy_tpa_line_decision',
    'pharmacy_posted_payment',
    'pharmacy_patient_advance',
  ])('preserves a live %s substitution task instead of overwriting it', async (resourceType) => {
    const substitutionTask = {
      id: 811,
      related_resource_type: resourceType,
      status: 'open',
      metadata: { contract: 'pharmacy_substitution_funding_task_v1' },
    };
    const state = installSqlRouter({ substitutionTasks: [substitutionTask] });

    await expect(callExport(
      'materializePharmacyFundingTaskTx', mockTx, authority(),
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_SUBSTITUTION_FUNDING_AUTHORITY_CONFLICT',
      details: {
        pharmacy_order_id: 41,
        task_ids: [811],
        next_action: 'complete_or_govern_release_of_substitution_funding_authority',
      },
    });

    expect(state.substitutionTasks).toEqual([substitutionTask]);
    expect(queryCallsContaining('INSERT INTO tasks')).toHaveLength(0);
    expect(mutationCalls()).toHaveLength(0);
  });

  it('fails closed on a net-live patient advance before creating generic authority', async () => {
    installSqlRouter({ advanceAllocations: [advanceAllocation()] });

    await expect(callExport(
      'materializePharmacyFundingTaskTx', mockTx, authority(),
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_TERMINAL_FUNDING_ADVANCE_RELEASE_REQUIRED',
      details: {
        pharmacy_order_id: 41,
        live_advance_allocation_ids: ['801'],
        next_action: 'complete_governed_advance_allocation_release_or_conversion',
      },
    });

    expect(queryCallsContaining('INSERT INTO tasks')).toHaveLength(0);
    expect(mutationCalls()).toHaveLength(0);
  });

  it('locks invoice then item then admission and children before the exact TPA claim', async () => {
    const tpaOrder = order({
      payment_mode: 'insurance',
      funding_admission_id: 51,
      funding_admission_order_version: 3,
      funding_admission_items_sha256: HASH,
    });
    installSqlRouter({
      order: tpaOrder,
      orderRows: [tpaOrder],
      admissions: [{ id: 51, patient_uid: PATIENT, status: 'admitted' }],
      claimRows: [claim()],
      sourceLines: [line({ admission_id: 51 })],
      actorRows: [{ uid: ACTOR, role: 'INSURANCE_COORDINATOR' }],
    });

    await callExport('materializePharmacyFundingTaskTx', mockTx, authority({
      paymentMode: 'insurance',
      actorRole: 'INSURANCE_COORDINATOR',
      tpaClaimId: 91,
    }));

    const invoiceLock = invocationOrder(
      queryMock,
      (sql) => sql.includes('FROM billing_invoices')
        && sql.includes('id=ANY($2::int[])') && sql.includes('FOR UPDATE'),
    );
    const itemLock = invocationOrder(
      queryMock,
      (sql) => sql.includes('FROM billing_invoice_items')
        && sql.includes('id=ANY($2::int[])') && sql.includes('FOR UPDATE'),
    );
    const admissionLock = lockAdmissionMock.mock.invocationCallOrder[0];
    const childLock = invocationOrder(
      queryMock,
      (sql) => sql.includes('FROM billing_payments')
        && sql.includes('invoice_id=ANY($2::int[])'),
    );
    const claimLock = invocationOrder(
      queryMock,
      (sql) => sql.includes('FROM tpa_claims claim') && sql.includes('FOR UPDATE'),
    );
    expect(invoiceLock).toBeLessThan(itemLock);
    expect(itemLock).toBeLessThan(admissionLock);
    expect(admissionLock).toBeLessThan(childLock);
    expect(childLock).toBeLessThan(claimLock);
  });

  it('does not mutate when admission revalidation is lost after invoice locks', async () => {
    const tpaOrder = order({
      payment_mode: 'insurance',
      funding_admission_id: 51,
      funding_admission_order_version: 3,
      funding_admission_items_sha256: HASH,
    });
    installSqlRouter({
      order: tpaOrder,
      orderRows: [tpaOrder],
      admissions: [{ id: 51, patient_uid: PATIENT, status: 'admitted' }],
      sourceLines: [line({ admission_id: 51 })],
      actorRows: [{ uid: ACTOR, role: 'INSURANCE_COORDINATOR' }],
    });
    lockAdmissionMock.mockResolvedValueOnce({
      id: 51,
      patient_uid: PATIENT,
      status: 'discharged',
    });

    await expect(callExport(
      'materializePharmacyFundingTaskTx',
      mockTx,
      authority({ paymentMode: 'insurance', actorRole: 'INSURANCE_COORDINATOR' }),
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_FUNDING_ADMISSION_AUTHORITY_STALE',
    });

    expect(mutationCalls()).toHaveLength(0);
  });
});

describe('terminal order funding closure', () => {
  it('does not close a canonical target while substitution authority owns the order', async () => {
    const cancelled = order({ status: 'CANCELLED' });
    installSqlRouter({
      order: cancelled,
      orderRows: [cancelled],
      substitutionTasks: [{
        id: 812,
        related_resource_type: 'pharmacy_patient_advance',
        status: 'open',
        metadata: { contract: 'pharmacy_substitution_funding_task_v1' },
      }],
    });

    await expect(callExport(
      'materializePharmacyFundingTaskTx', mockTx, authority(),
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_SUBSTITUTION_FUNDING_AUTHORITY_CONFLICT',
      details: { task_ids: [812] },
    });

    expect(executeCallsContaining('UPDATE tasks')).toHaveLength(0);
    expect(mutationCalls()).toHaveLength(0);
  });

  it('cancels tasks, invalidates TPA evidence, and reports invalidated for a cancelled order', async () => {
    const cancelled = order({ status: 'CANCELLED' });
    const state = installSqlRouter({ order: cancelled, orderRows: [cancelled] });

    const result = await callExport('materializePharmacyFundingTaskTx', mockTx, authority());

    expect(result).toMatchObject({
      status: 'invalidated',
      admissionId: null,
      invoiceId: null,
      invoiceItemId: null,
      task: null,
      postedPayments: [],
      invalidatedAuthority: {
        releasedCapReservation: null,
        reversedAllocationIds: [],
        invalidatedFundingEventId: null,
      },
    });
    expect(executeCallsContaining('UPDATE tasks')).toHaveLength(1);
    expect(executeCallsContaining('UPDATE tpa_claim_line_decisions decision')).toHaveLength(1);
    expect(queryCallsContaining('FROM pharmacy_stock_movements')).toHaveLength(1);
    expect(state.authorityEvents).toHaveLength(0);
  });

  it.each(['DISPENSED', 'DELIVERED'])('completes recovery without invalidation for %s', async (status) => {
    const closedOrder = order({ status });
    installSqlRouter({ order: closedOrder, orderRows: [closedOrder] });

    const result = await callExport('materializePharmacyFundingTaskTx', mockTx, authority());

    expect(result).toMatchObject({
      status: 'closed',
      invoiceId: null,
      task: null,
      invalidatedAuthority: { releasedCapReservation: null, reversedAllocationIds: [] },
    });
    expect(executeCallsContaining('UPDATE tasks')).toHaveLength(1);
    expect(executeCallsContaining('UPDATE tpa_claim_line_decisions')).toHaveLength(0);
    expect(queryCallsContaining('FROM pharmacy_stock_movements')).toHaveLength(0);
  });
});

describe('materializePharmacyFundingAuthority wrapper', () => {
  it('rejects invalid wrapper authority before opening a transaction', async () => {
    installSqlRouter();

    await expect(callExport('materializePharmacyFundingAuthority', {
      tenantId: TENANT,
      orderId: 0,
      actorUid: '',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_FUNDING_MATERIALIZATION_AUTHORITY_REQUIRED',
    });
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns not found when the wrapper cannot bind one canonical patient order', async () => {
    installSqlRouter({ wrapperOrderRows: [] });

    await expect(callExport('materializePharmacyFundingAuthority', {
      tenantId: TENANT,
      orderId: 41,
      actorUid: ACTOR,
    })).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(mutationCalls()).toHaveLength(0);
  });

  it('derives the durable tuple and returns the real funded result', async () => {
    const state = installSqlRouter({ allocations: [allocation()] });

    const result = await callExport('materializePharmacyFundingAuthority', {
      tenantId: TENANT,
      orderId: 41,
      actorUid: ACTOR,
      actorRole: 'FINANCE_INCHARGE',
    });

    expect(result).toMatchObject({
      status: 'funded',
      fundingSource: 'billing_payment',
      fundingReference: 'payments:301',
      paymentIds: [301],
    });
    expect(orderItemsSha256Mock).toHaveBeenCalledWith(state.order.items_list);
    expect(resolvePatientUidMock).toHaveBeenCalledWith(mockTx, {
      tenantId: TENANT,
      orderId: 41,
      patientId: 7,
      patientUid: PATIENT,
    });
  });
});

describe('resolvePostedPharmacyFundingTx source resolution', () => {
  it('preserves the blocked recovery tuple and writes no resolved authority event', async () => {
    const state = installSqlRouter();

    const result = await callExport('resolvePostedPharmacyFundingTx', mockTx, authority());

    expect(result).toMatchObject({
      status: 'blocked',
      collectedAmount: 0,
      fundedAmount: 0,
      fundingSource: null,
      fundingReference: null,
      invoiceId: 61,
      invoiceItemId: 71,
      paymentIds: [],
      fundingRecovery: { task_id: '81', amount_outstanding: 100 },
      authorityEvidence: null,
    });
    expect(state.authorityEvents).toHaveLength(0);
    expect(queryCallsContaining("SET status='completed'")).toHaveLength(0);
  });

  it('returns the canonical closed tuple without task or authority event writes', async () => {
    const delivered = order({ status: 'DELIVERED' });
    const state = installSqlRouter({ order: delivered, orderRows: [delivered] });

    const result = await callExport('resolvePostedPharmacyFundingTx', mockTx, authority());

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
    });
    expect(state.authorityEvents).toHaveLength(0);
    expect(queryCallsContaining("SET status='completed'")).toHaveLength(0);
  });

  it.each([
    {
      name: 'TPA claim only',
      approvedAmount: 100,
      allocations: [],
      expectedSource: 'tpa_claim',
      expectedReference: 'tpa:91',
      expectedCollected: 0,
      expectedPaymentIds: [],
    },
    {
      name: 'mixed TPA claim and posted payment',
      approvedAmount: 60,
      allocations: [allocation({ allocated_amount: '40.00' })],
      expectedSource: 'mixed',
      expectedReference: 'tpa:91;payments:301',
      expectedCollected: 40,
      expectedPaymentIds: [301],
    },
  ])('funds from $name with exact evidence', async ({
    approvedAmount,
    allocations,
    expectedSource,
    expectedReference,
    expectedCollected,
    expectedPaymentIds,
  }) => {
    const tpaOrder = order({
      payment_mode: 'insurance',
      funding_admission_id: 51,
      funding_admission_order_version: 3,
      funding_admission_items_sha256: HASH,
    });
    const state = installSqlRouter({
      order: tpaOrder,
      orderRows: [tpaOrder],
      admissions: [{ id: 51, patient_uid: PATIENT, status: 'admitted' }],
      claimRows: [claim()],
      decisionRows: [decision({ approved_amount: String(approvedAmount) })],
      allocations,
      sourceLines: [line({ admission_id: 51 })],
      actorRows: [{ uid: ACTOR, role: 'INSURANCE_COORDINATOR' }],
    });

    const result = await callExport(
      'resolvePostedPharmacyFundingTx',
      mockTx,
      authority({ paymentMode: 'insurance', actorRole: 'INSURANCE_COORDINATOR' }),
    );

    expect(result).toMatchObject({
      status: 'funded',
      collectedAmount: expectedCollected,
      fundedAmount: 100,
      fundingSource: expectedSource,
      fundingReference: expectedReference,
      fundingTpaClaimId: 91,
      paymentIds: expectedPaymentIds,
      authorityEvidence: {
        tpa_claim_id: 91,
        approved_tpa_amount: approvedAmount,
        allocated_payment_amount: expectedCollected,
        combined_authority_amount: 100,
      },
    });
    expect(state.authorityEvents[0]).toMatchObject({
      event_type: 'FUNDING_RESOLVED',
      tpa_claim_id: 91,
      billing_payment_id: allocations.length === 1 ? 301 : null,
    });
    expect(queryCallsContaining("SET status='completed'")).toHaveLength(1);
  });
});

describe('public command drivers', () => {
  it('claims, allocates, resolves, and completes a posted-payment retry command', async () => {
    const state = installSqlRouter({
      payments: [{
        id: 301,
        amount: '100.00',
        mode: 'CASH',
        reference: 'cash-301',
        collected_at: '2026-08-30T05:00:00.000Z',
      }],
    });

    const result = await callExport('retryPharmacyFundingTask', {
      tenantId: TENANT,
      taskId: 81,
      actorUid: ACTOR,
      paymentId: 301,
      commandKeySha256: COMMAND,
    });

    expect(result).toMatchObject({
      status: 'funded',
      fundingSource: 'billing_payment',
      fundingReference: 'payments:301',
      paymentIds: [301],
      replayed: false,
      retryCommandSha256: COMMAND,
    });
    expect(state.receipt).toMatchObject({
      command_key_sha256: COMMAND,
      command_type: 'POSTED_PAYMENT_RETRY',
      task_id: 81,
      pharmacy_order_id: 41,
      invoice_item_id: 71,
      status: 'COMPLETE',
      response_body: { status: 'funded', replayed: false },
    });
    expect(queryCallsContaining('INSERT INTO pharmacy_payment_allocations')).toHaveLength(1);
    const allocationInsert = queryCallsContaining('INSERT INTO pharmacy_payment_allocations')[0];
    expect(allocationInsert.slice(1, 11)).toEqual([
      TENANT, 41, 61, 71, 301, 3, HASH, 100, COMMAND, ACTOR,
    ]);
    expect(executeCallsContaining('INSERT INTO pharmacy_funding_commands')).toHaveLength(1);
    expect(queryCallsContaining('UPDATE pharmacy_funding_commands')).toHaveLength(1);
    expect(state.authorityEvents).toHaveLength(1);
    const commandClaimOrder = invocationOrder(
      executeMock,
      (sql) => sql.startsWith('INSERT INTO pharmacy_funding_commands'),
    );
    const firstLineMaterializationOrder = invocationOrder(
      queryMock,
      (sql) => sql.startsWith('UPDATE billing_invoice_items'),
    );
    const allocationOrder = invocationOrder(
      queryMock,
      (sql) => sql.startsWith('INSERT INTO pharmacy_payment_allocations'),
    );
    const authorityResolutionOrder = invocationOrder(
      queryMock,
      (sql) => sql.startsWith('INSERT INTO pharmacy_funding_decision_events')
        && sql.includes('authority_generation'),
    );
    const commandCompletionOrder = invocationOrder(
      queryMock,
      (sql) => sql.startsWith('UPDATE pharmacy_funding_commands'),
    );
    expect(commandClaimOrder).toBeLessThan(firstLineMaterializationOrder);
    expect(commandClaimOrder).toBeLessThan(allocationOrder);
    expect(firstLineMaterializationOrder).toBeLessThan(allocationOrder);
    expect(authorityResolutionOrder).toBeLessThan(commandCompletionOrder);
  });

  it('claims and completes a balanced TPA line decision through its public driver', async () => {
    const tpaOrder = order({
      payment_mode: 'insurance',
      funding_admission_id: 51,
      funding_admission_order_version: 3,
      funding_admission_items_sha256: HASH,
    });
    const state = installSqlRouter({
      order: tpaOrder,
      orderRows: [tpaOrder],
      wrapperOrderRows: [tpaOrder],
      actorRows: [{ uid: ACTOR, role: 'INSURANCE_COORDINATOR' }],
      admissions: [{ id: 51, patient_uid: PATIENT, status: 'admitted' }],
      claimRows: [claim()],
      sourceLines: [line({ admission_id: 51 })],
      insuranceTask: insuranceTask(),
      decisionRows: [],
      completePostedTask: null,
    });

    const result = await callExport('recordPharmacyFundingLineDecision', {
      tenantId: TENANT,
      taskId: 82,
      orderId: 41,
      invoiceItemId: 71,
      tpaClaimId: 91,
      orderVersion: 3,
      orderItemsSha256: HASH,
      approvedAmount: 100,
      nonPayableAmount: 0,
      reasonCode: 'other',
      reasonText: 'Covered under exact claim authority',
      actorUid: ACTOR,
      commandKeySha256: COMMAND,
    });

    expect(result).toMatchObject({
      replayed: false,
      status: 'funded',
      decision: { id: 501, approved_amount: 100, non_payable_amount: 0 },
      task: { id: 82, status: 'completed' },
      nextTask: null,
      evidence: {
        contract: 'pharmacy_tpa_line_decision_v1',
        task_id: 82,
        pharmacy_order_id: 41,
        invoice_item_id: 71,
        tpa_claim_id: 91,
        approved_amount: 100,
        non_payable_amount: 0,
        command_key_sha256: COMMAND,
      },
      fundingAuthority: {
        status: 'funded',
        fundingSource: 'tpa_claim',
        fundingReference: 'tpa:91',
      },
    });
    expect(state.receipt).toMatchObject({
      command_type: 'TPA_LINE_DECISION',
      status: 'COMPLETE',
      response_body: { status: 'funded', replayed: false },
    });
    expect(state.tpaEvents).toHaveLength(1);
    expect(state.tpaEvents[0].evidence).toMatchObject({
      actor_role: 'INSURANCE_COORDINATOR',
      assigned_role: 'INSURANCE_COORDINATOR',
      amount_outstanding: 0,
    });
    expect(state.authorityEvents).toHaveLength(1);
    expect(executeCallsContaining('INSERT INTO pharmacy_funding_commands')).toHaveLength(1);
    expect(queryCallsContaining('UPDATE pharmacy_funding_commands')).toHaveLength(1);
    const commandClaimOrder = invocationOrder(
      executeMock,
      (sql) => sql.startsWith('INSERT INTO pharmacy_funding_commands'),
    );
    const decisionMaterializationOrder = invocationOrder(
      queryMock,
      (sql) => sql.startsWith('INSERT INTO tpa_claim_line_decisions'),
    );
    const tpaEventOrder = invocationOrder(
      queryMock,
      (sql) => sql.startsWith('INSERT INTO pharmacy_funding_decision_events')
        && sql.includes("'TPA_DECISION_RECORDED'"),
    );
    const authorityResolutionOrder = invocationOrder(
      queryMock,
      (sql) => sql.startsWith('INSERT INTO pharmacy_funding_decision_events')
        && sql.includes('authority_generation'),
    );
    const commandCompletionOrder = invocationOrder(
      queryMock,
      (sql) => sql.startsWith('UPDATE pharmacy_funding_commands'),
    );
    expect(commandClaimOrder).toBeLessThan(decisionMaterializationOrder);
    expect(decisionMaterializationOrder).toBeLessThan(tpaEventOrder);
    expect(tpaEventOrder).toBeLessThan(authorityResolutionOrder);
    expect(authorityResolutionOrder).toBeLessThan(commandCompletionOrder);
  });
});
