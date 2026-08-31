import { jest } from '@jest/globals';

const queryMock = jest.fn();
const executeMock = jest.fn();
const setTenantTxMock = jest.fn();
const lockSubstitutionAuthorityMock = jest.fn();
const resolvePatientUidMock = jest.fn();
const lockAuthorityMock = jest.fn();
const lockAdmissionMock = jest.fn();
const releaseCapMock = jest.fn();
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
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/pharmacy/pharmacyCapService.js', () => ({
  lockCounterFundingSubstitutionAuthorityTx: lockSubstitutionAuthorityMock,
  lockPharmacyFundingAdmissionTx: lockAdmissionMock,
  lockPharmacyFundingAuthorityTx: lockAuthorityMock,
  releasePharmacyCapReservationTx: releaseCapMock,
  resolvePharmacyFundingPatientUidTx: resolvePatientUidMock,
}));

jest.unstable_mockModule(
  '../../services/pharmacy/pharmacistVerificationService.js',
  () => ({ clinicalOrderItemsSha256: clinicalOrderItemsSha256Mock }),
);

jest.unstable_mockModule(
  '../../services/billing/ledger/ledgerAuthoritativeMode.js',
  () => ({
    resolveLedgerWiring: async () => ({
      mode: 'shadow', sameTx: false, postCommit: true, skip: false,
    }),
    resolveLedgerModeForTenant: async () => 'shadow',
  }),
);

const {
  getPharmacyFundingReconciliationCase,
  recordPharmacyFundingReconciliationDecision,
} = await import('../../services/billing/billingV2Service.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const OTHER_PATIENT = '11111111-1111-4111-8111-111111111112';
const PROPOSER = '22222222-2222-4222-8222-222222222222';
const APPROVER = '33333333-3333-4333-8333-333333333333';
const CASE_ID = 71;
const ORDER_ID = 41;
const TASK_ID = 81;
const KEEPER_ID = 101;
const SNAPSHOT_SHA256 = 'a'.repeat(64);
const OTHER_SNAPSHOT_SHA256 = 'b'.repeat(64);
const ORDER_ITEMS_SHA256 = 'c'.repeat(64);
const PROPOSAL_COMMAND = 'd'.repeat(64);
const APPROVAL_COMMAND = 'e'.repeat(64);
const RESOLVED_REPLAY_COMMAND = 'f'.repeat(64);

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function expectSqlFragments(sql, fragments) {
  for (const fragment of fragments) expect(sql).toContain(fragment);
}

function logicalLine(overrides = {}) {
  return {
    id: KEEPER_ID,
    invoiceId: 201,
    active: true,
    invoiceStatus: 'DRAFT',
    description: 'Pharmacy order PH-41',
    category: 'pharmacy',
    quantity: 1,
    unitPrice: 100,
    lineSubtotal: 100,
    cgstAmount: 0,
    sgstAmount: 0,
    igstAmount: 0,
    lineTotal: 100,
    sourceAuthorityVersion: 3,
    sourceAuthoritySha256: ORDER_ITEMS_SHA256,
    patientUid: PATIENT,
    admissionId: null,
    payments: [],
    allocations: [],
    ...overrides,
  };
}

function defaultDuplicateLines() {
  return [
    logicalLine(),
    logicalLine({ id: 102 }),
  ];
}

class ReconciliationSqlScenario {
  constructor({
    lines = defaultDuplicateLines(),
    order = {},
    caseRow = {},
    currentSnapshotSha256 = SNAPSHOT_SHA256,
    actorRoles = {},
    stockMovementIds = [],
    capReservations = [],
    currentFundingEvents = [],
    invoiceSafetyUnrelated = 0,
    activeCountOverride = null,
    preReadMissing = false,
    orderMissing = false,
    advanceAllocations = [],
    advanceAllocationReversals = [],
  } = {}) {
    this.lines = lines.map((line) => ({ ...line }));
    this.order = {
      id: ORDER_ID,
      facility_id: 5,
      status: 'READY',
      funding_admission_id: null,
      inventory_authority_version: 3,
      items_list: [{ medication: 'Paracetamol', quantity: 1 }],
      total_amount: '100',
      ...order,
    };
    this.case = {
      id: CASE_ID,
      tenant_id: TENANT,
      pharmacy_order_id: ORDER_ID,
      patient_uid: PATIENT,
      task_id: TASK_ID,
      task_resource_type: 'pharmacy_funding_reconciliation',
      task_resource_id: String(CASE_ID),
      status: 'OPEN',
      assigned_to_role: 'FINANCE_INCHARGE',
      task_status: 'open',
      task_metadata: {},
      proposal_sha256: null,
      resolution_path: null,
      keeper_invoice_item_id: null,
      proposed_by: null,
      outcome: null,
      ...caseRow,
    };
    this.currentSnapshotSha256 = currentSnapshotSha256;
    this.actorRoles = new Map(Object.entries({
      [PROPOSER]: 'FINANCE_INCHARGE',
      [APPROVER]: 'SUPER_ADMIN',
      ...actorRoles,
    }));
    this.stockMovementIds = stockMovementIds;
    this.capReservations = capReservations;
    this.currentFundingEvents = currentFundingEvents;
    this.invoiceSafetyUnrelated = invoiceSafetyUnrelated;
    this.activeCountOverride = activeCountOverride;
    this.preReadMissing = preReadMissing;
    this.orderMissing = orderMissing;
    this.advanceAllocations = advanceAllocations.map((allocation) => ({ ...allocation }));
    this.advanceAllocationReversals = advanceAllocationReversals.map(
      (reversal) => ({ ...reversal }),
    );
    this.receipts = new Map();
    this.eventLog = [];
    this.resolvedEvents = [];
    this.queryCalls = [];
    this.executeCalls = [];
    this.task = { id: TASK_ID, status: 'open', metadata: {} };
    this.invoiceStatuses = new Map(
      this.lines.map((line) => [Number(line.invoiceId), line.invoiceStatus]),
    );
    this.snapshot = this.buildSnapshot();
  }

  buildSnapshot() {
    const admissionId = this.order.funding_admission_id == null
      ? null : Number(this.order.funding_admission_id);
    return {
      order_version: Number(this.order.inventory_authority_version),
      funding_admission_id: admissionId,
      funding_admission_order_version: admissionId == null
        ? null : Number(this.order.inventory_authority_version),
      funding_admission_items_sha256: admissionId == null ? null : ORDER_ITEMS_SHA256,
      lines: this.lines.map((line) => ({
        invoice_item_id: Number(line.id),
        invoice_id: Number(line.invoiceId),
        description: line.description,
        category: line.category,
        quantity: String(line.quantity),
        unit_price: String(line.unitPrice),
        line_total: String(line.lineTotal),
        source_ref_active: line.active,
        source_authority_version: Number(line.sourceAuthorityVersion),
        source_authority_sha256: line.sourceAuthoritySha256,
        patient_uid: line.patientUid,
        admission_id: line.admissionId,
        invoice_status: line.invoiceStatus,
        payments: line.payments,
        allocations: line.allocations,
      })),
    };
  }

  lineRows() {
    return this.lines.map((line) => ({
      id: Number(line.id),
      invoice_id: Number(line.invoiceId),
      quantity: String(line.quantity),
      unit_price: String(line.unitPrice),
      line_subtotal: String(line.lineSubtotal),
      cgst_amount: String(line.cgstAmount),
      sgst_amount: String(line.sgstAmount),
      igst_amount: String(line.igstAmount),
      line_total: String(line.lineTotal),
      source_ref_type: 'pharmacy_order',
      source_ref_id: ORDER_ID,
      source_ref_active: line.active,
      invoice_status: line.invoiceStatus,
    }));
  }

  invoiceIds() {
    return [...new Set(this.lines.map((line) => Number(line.invoiceId)))];
  }

  invoiceRows() {
    return this.invoiceIds().map((id) => {
      const line = this.lines.find((candidate) => Number(candidate.invoiceId) === id);
      return {
        id,
        status: this.invoiceStatuses.get(id),
        patient_uid: line.patientUid,
        admission_id: line.admissionId,
        tenant_id: TENANT,
        subtotal: String(line.lineSubtotal),
        cgst_amount: String(line.cgstAmount),
        sgst_amount: String(line.sgstAmount),
        igst_amount: String(line.igstAmount),
        total_amount: String(line.lineTotal),
        amount_paid: '0',
        amount_due: String(line.lineTotal),
      };
    });
  }

  seedReceipt(command, receipt) {
    this.receipts.set(command, { ...receipt });
  }

  checkpoint() {
    return {
      lines: structuredClone(this.lines),
      case: structuredClone(this.case),
      task: structuredClone(this.task),
      invoiceStatuses: new Map(this.invoiceStatuses),
      receipts: new Map(
        [...this.receipts].map(([key, receipt]) => [key, structuredClone(receipt)]),
      ),
      eventLog: structuredClone(this.eventLog),
      resolvedEvents: structuredClone(this.resolvedEvents),
    };
  }

  restore(checkpoint) {
    this.lines = checkpoint.lines;
    this.case = checkpoint.case;
    this.task = checkpoint.task;
    this.invoiceStatuses = checkpoint.invoiceStatuses;
    this.receipts = checkpoint.receipts;
    this.eventLog = checkpoint.eventLog;
    this.resolvedEvents = checkpoint.resolvedEvents;
  }

  query(sql, params) {
    const normalized = normalizeSql(sql);
    this.queryCalls.push({ sql: normalized, params });

    if (normalized.includes('CROSS JOIN LATERAL public.pharmacy_funding_duplicate_line_snapshot_753')) {
      if (this.preReadMissing) return [];
      return [{
        ...this.case,
        current_snapshot: this.snapshot,
        current_snapshot_sha256: this.currentSnapshotSha256,
        active_line_count: this.lines.filter((line) => line.active).length,
      }];
    }
    if (normalized.includes('SELECT reconciliation.pharmacy_order_id,reconciliation.patient_uid')) {
      return this.preReadMissing ? [] : [{
        pharmacy_order_id: this.case.pharmacy_order_id,
        patient_uid: this.case.patient_uid,
      }];
    }
    if (normalized.includes('FROM pharmacy_orders pharmacy_order')
        && normalized.includes('FOR UPDATE OF pharmacy_order')) {
      return this.orderMissing ? [] : [{ ...this.order }];
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
    if (normalized.startsWith('SELECT id,patient_uid,status FROM admissions')) {
      return this.order.funding_admission_id == null ? [] : [{
        id: Number(this.order.funding_admission_id),
        patient_uid: PATIENT,
        status: 'admitted',
      }];
    }
    if (normalized.includes('SELECT item.id,item.invoice_id')
        && normalized.includes('FROM billing_invoice_items item')) {
      return this.lineRows().map((line) => ({ id: line.id, invoice_id: line.invoice_id }));
    }
    if (normalized.includes('FROM billing_invoices')
        && normalized.includes('id=ANY($2::int[])')
        && normalized.includes('ORDER BY id')
        && normalized.endsWith('FOR UPDATE')) {
      return this.invoiceRows();
    }
    if (normalized.includes('FROM billing_invoice_items')
        && normalized.includes('id=ANY($2::int[])')
        && normalized.includes('ORDER BY id')
        && normalized.endsWith('FOR UPDATE')) {
      return this.lineRows();
    }
    if (normalized.startsWith('SELECT id FROM billing_payments')
        && normalized.includes('invoice_id=ANY')) {
      return [];
    }
    if (normalized.startsWith('SELECT id FROM billing_refunds')
        && normalized.includes('invoice_id=ANY')) {
      return [];
    }
    if (normalized.startsWith('SELECT id FROM billing_advance_settlements')
        && normalized.includes('invoice_id=ANY')) {
      return [];
    }
    if (normalized.startsWith('SELECT claim.id,decision.id AS decision_id')) {
      return [];
    }
    if (normalized.startsWith('SELECT id FROM pharmacy_payment_allocations')
        && normalized.includes('invoice_item_id=ANY')) {
      return [];
    }
    if (normalized.includes('FROM pharmacy_advance_allocations allocation')
        && normalized.includes('allocation.pharmacy_order_id=$2::int')) {
      return this.advanceAllocations.map((allocation) => ({ ...allocation }));
    }
    if (normalized.includes('FROM pharmacy_advance_allocation_reversals')
        && normalized.includes('allocation_id=ANY($2::bigint[])')) {
      return this.advanceAllocationReversals.map((reversal) => ({ ...reversal }));
    }
    if (normalized.includes('SELECT reconciliation.*,task.status AS task_status')
        && normalized.includes('FOR UPDATE OF task,reconciliation')) {
      return [{ ...this.case, task_status: this.task.status }];
    }
    if (normalized.startsWith('SELECT uid,UPPER(role) AS role FROM users')) {
      const role = this.actorRoles.get(String(params[1]));
      return role ? [{ uid: params[1], role }] : [];
    }
    if (normalized.startsWith('SELECT * FROM pharmacy_funding_reconciliation_events')) {
      const receipt = this.receipts.get(String(params[1]));
      return receipt ? [{ ...receipt }] : [];
    }
    if (normalized.startsWith('SELECT * FROM public.pharmacy_funding_duplicate_line_snapshot_753')) {
      return [{ snapshot_sha256: this.currentSnapshotSha256, snapshot: this.snapshot }];
    }
    if (normalized.startsWith('SELECT id FROM pharmacy_stock_movements')) {
      return this.stockMovementIds.map((id) => ({ id }));
    }
    if (normalized.startsWith('SELECT id,status FROM billing_invoices')) {
      return this.invoiceIds().map((id) => ({
        id,
        status: this.invoiceStatuses.get(id),
      }));
    }
    if (normalized.includes('COUNT(item.id) FILTER')
        && normalized.includes('AS unrelated_active_items')) {
      return this.invoiceIds().map((id) => ({
        id,
        status: this.invoiceStatuses.get(id),
        unrelated_active_items: this.invoiceSafetyUnrelated,
      }));
    }
    if (normalized.startsWith('SELECT admission_id FROM pharmacy_cap_reservations')) {
      return this.capReservations.map((admissionId, index) => ({
        id: index + 1,
        admission_id: admissionId,
      }));
    }
    if (normalized.includes('SELECT allocation.*')
        && normalized.includes('FROM pharmacy_payment_allocations allocation')) {
      return [];
    }
    if (normalized.startsWith('SELECT pg_advisory_xact_lock(hashtextextended(')) {
      return [{ lock_acquired: null }];
    }
    // Shared tenant merge-stability lock: patientMergeStabilityLock via billingV2Service setTenantTx flows.
    if (normalized.startsWith('SELECT 1 AS locked FROM pg_advisory_xact_lock_shared(hashtextextended(')) {
      return [{ locked: 1 }];
    }
    if (normalized.includes('FROM pharmacy_funding_decision_events event')) {
      return this.currentFundingEvents.map((event) => ({ ...event }));
    }
    if (normalized.startsWith('UPDATE billing_invoice_items')) {
      return this.mutateDuplicateLines(normalized, params);
    }
    if (normalized.startsWith('SELECT id FROM billing_invoice_items')
        && normalized.includes('unit_price=0')) {
      const ids = new Set((params[1] || []).map(Number));
      return this.lines
        .filter((line) => ids.has(Number(line.id))
          && !line.active
          && [line.unitPrice, line.lineSubtotal, line.cgstAmount, line.sgstAmount,
            line.igstAmount, line.lineTotal].every((amount) => Number(amount) === 0))
        .map((line) => ({ id: Number(line.id) }));
    }
    if (normalized.startsWith('UPDATE tpa_claim_line_decisions')) {
      return (params[1] || []).map((_, index) => ({ id: 900 + index }));
    }
    if (normalized.includes('COALESCE(SUM(line_subtotal), 0)::numeric AS subtotal')) {
      const invoiceId = Number(params[0]);
      const active = this.lines.filter(
        (line) => line.active && Number(line.invoiceId) === invoiceId,
      );
      const sum = (key) => active.reduce((total, line) => total + Number(line[key]), 0);
      return [{
        subtotal: String(sum('lineSubtotal')),
        cgst: String(sum('cgstAmount')),
        sgst: String(sum('sgstAmount')),
        igst: String(sum('igstAmount')),
      }];
    }
    if (normalized.startsWith('SELECT discount_amount, credit_note_amount, amount_paid')) {
      return [{ discount_amount: '0', credit_note_amount: '0', amount_paid: '0' }];
    }
    if (normalized.startsWith('SELECT admission_id, patient_uid, tenant_id FROM billing_invoices')) {
      return [{ admission_id: null, patient_uid: PATIENT, tenant_id: TENANT }];
    }
    if (normalized.startsWith('UPDATE billing_invoices invoice')) {
      expectSqlFragments(normalized, [
        "SET status='VOID'",
        'voided_at=NOW()',
        'voided_by=$3::uuid',
        'WHERE invoice.tenant_id=$1::uuid',
        'invoice.id=ANY($2::int[])',
        "invoice.status='DRAFT'",
        'NOT EXISTS ( SELECT 1 FROM billing_invoice_items item',
        'item.tenant_id=invoice.tenant_id',
        'item.invoice_id=invoice.id',
        'item.source_ref_active=TRUE',
        'RETURNING invoice.id',
      ]);
      const invoiceIds = (params[1] || []).map(Number);
      expect(invoiceIds).toEqual(this.invoiceIds());
      expect(params).toEqual([
        TENANT,
        invoiceIds,
        APPROVER,
        `Empty draft after pharmacy funding reconciliation case ${CASE_ID}`,
      ]);
      const emptyDraftIds = invoiceIds.filter((invoiceId) => (
        this.invoiceStatuses.get(invoiceId) === 'DRAFT'
          && !this.lines.some((line) => line.active && Number(line.invoiceId) === invoiceId)
      ));
      emptyDraftIds.forEach((id) => this.invoiceStatuses.set(id, 'VOID'));
      return emptyDraftIds.map((id) => ({ id }));
    }
    if (normalized.startsWith('UPDATE billing_invoices')
        && normalized.includes('id=ANY($2::int[])')
        && normalized.includes("status='DRAFT'")) {
      expectSqlFragments(normalized, [
        "SET status='VOID'",
        'voided_at=NOW()',
        'voided_by=$3::uuid',
        'WHERE tenant_id=$1::uuid',
        'id=ANY($2::int[])',
        "status='DRAFT'",
        'RETURNING id',
      ]);
      const invoiceIds = (params[1] || []).map(Number);
      expect(invoiceIds).toEqual(this.invoiceIds());
      expect(params).toEqual([
        TENANT,
        invoiceIds,
        APPROVER,
        `Terminal pharmacy order ${ORDER_ID} duplicate-line reconciliation`,
      ]);
      const voided = invoiceIds.filter((id) => this.invoiceStatuses.get(id) === 'DRAFT');
      voided.forEach((id) => this.invoiceStatuses.set(id, 'VOID'));
      return voided.map((id) => ({ id }));
    }
    if (normalized.includes('SELECT COUNT(*)::int AS active_count')
        && normalized.includes("source_ref_type='pharmacy_order'")) {
      return [{
        active_count: this.activeCountOverride
          ?? this.lines.filter((line) => line.active).length,
      }];
    }

    throw new Error(`Unhandled reconciliation query SQL: ${normalized}`);
  }

  mutateDuplicateLines(sql, params) {
    let selected;
    if (sql.includes('COALESCE(source_ref_reconciliation_case_id')) {
      expectSqlFragments(sql, [
        'SET source_ref_reconciliation_case_id=COALESCE(source_ref_reconciliation_case_id,$3::bigint)',
        'unit_price=0,line_subtotal=0,cgst_amount=0,sgst_amount=0',
        'igst_amount=0,line_total=0',
        'WHERE tenant_id=$1::uuid',
        "source_ref_type='pharmacy_order'",
        'source_ref_id=$2::bigint',
        'source_ref_active=FALSE',
        'id<>$4::int',
        '(unit_price<>0 OR line_subtotal<>0 OR cgst_amount<>0',
        'RETURNING id,invoice_id,line_total',
      ]);
      const keeperId = Number(params[3]);
      expect(this.case.resolution_path).toBe('REBILL');
      expect(keeperId).toBe(KEEPER_ID);
      expect(params).toEqual([
        TENANT,
        ORDER_ID,
        CASE_ID,
        KEEPER_ID,
        `Governed rebill monetary compensation; reconciliation case ${CASE_ID}`,
      ]);
      selected = this.lines.filter((line) => (
        !line.active
          && Number(line.id) !== keeperId
          && [line.unitPrice, line.lineSubtotal, line.cgstAmount, line.sgstAmount,
            line.igstAmount, line.lineTotal].some((amount) => Math.abs(Number(amount)) > 0.001)
      ));
    } else {
      expectSqlFragments(sql, [
        'SET source_ref_active=FALSE',
        'source_ref_reconciliation_case_id=$3::bigint',
        'source_ref_deactivated_at=NOW()',
        'source_ref_deactivated_by=$4::uuid',
        'unit_price=0,line_subtotal=0,cgst_amount=0,sgst_amount=0',
        'igst_amount=0,line_total=0',
        'WHERE tenant_id=$1::uuid',
        "source_ref_type='pharmacy_order'",
        'source_ref_id=$2::bigint',
        'source_ref_active=TRUE',
        '($5::boolean=FALSE OR id<>$6::int)',
        'RETURNING id,invoice_id,line_total',
      ]);
      const retainKeeper = params[4] === true;
      const keeperId = Number(params[5]);
      expect(['SAFE_DEACTIVATE_DUPLICATES', 'KEEP_CURRENT_AUTHORITY', 'CANCEL_ORDER'])
        .toContain(this.case.resolution_path);
      expect(retainKeeper).toBe(this.case.resolution_path !== 'CANCEL_ORDER');
      expect(keeperId).toBe(KEEPER_ID);
      expect(params).toEqual([
        TENANT,
        ORDER_ID,
        CASE_ID,
        APPROVER,
        this.case.resolution_path !== 'CANCEL_ORDER',
        KEEPER_ID,
        `Governed duplicate-line monetary compensation; reconciliation case ${CASE_ID}`,
      ]);
      selected = this.lines.filter(
        (line) => line.active && (!retainKeeper || Number(line.id) !== keeperId),
      );
      selected.forEach((line) => { line.active = false; });
    }
    selected.forEach((line) => {
      line.unitPrice = 0;
      line.lineSubtotal = 0;
      line.cgstAmount = 0;
      line.sgstAmount = 0;
      line.igstAmount = 0;
      line.lineTotal = 0;
    });
    return selected.map((line) => ({
      id: Number(line.id),
      invoice_id: Number(line.invoiceId),
      line_total: '0',
    }));
  }

  execute(sql, params) {
    const normalized = normalizeSql(sql);
    this.executeCalls.push({ sql: normalized, params });

    if (normalized.startsWith('INSERT INTO pharmacy_funding_reconciliation_events')) {
      if (normalized.includes("'RESOLVED'")) {
        const resolved = {
          tenant_id: params[0],
          case_id: Number(params[1]),
          pharmacy_order_id: Number(params[2]),
          event_type: 'RESOLVED',
          snapshot_sha256: params[3],
          proposal_sha256: params[4],
          command_key_sha256: params[5],
          request_sha256: params[6],
          actor_uid: params[7],
          evidence: JSON.parse(params[8]),
        };
        this.resolvedEvents.push(resolved);
        this.eventLog.push(resolved);
        return 1;
      }
      const receipt = {
        tenant_id: params[0],
        case_id: Number(params[1]),
        pharmacy_order_id: Number(params[2]),
        event_type: params[3],
        snapshot_sha256: params[4],
        proposal_sha256: params[5],
        command_key_sha256: params[6],
        request_sha256: params[7],
        actor_uid: params[8],
        evidence: JSON.parse(params[9]),
      };
      if (!this.receipts.has(receipt.command_key_sha256)) {
        this.receipts.set(receipt.command_key_sha256, receipt);
        this.eventLog.push(receipt);
      }
      return 1;
    }
    if (normalized.startsWith('UPDATE pharmacy_funding_reconciliation_cases')
        && normalized.includes("SET status='PENDING_APPROVAL'")) {
      Object.assign(this.case, {
        status: 'PENDING_APPROVAL',
        snapshot_sha256: params[2],
        snapshot: JSON.parse(params[3]),
        resolution_path: params[4],
        keeper_invoice_item_id: Number(params[5]),
        proposal_sha256: params[6],
        proposed_by: params[7],
        outcome: null,
      });
      return 1;
    }
    if (normalized.startsWith('UPDATE pharmacy_funding_reconciliation_cases')
        && normalized.includes("SET status='BLOCKED'")) {
      this.case.status = 'BLOCKED';
      this.case.outcome = JSON.parse(params[2]);
      return 1;
    }
    if (normalized.startsWith('UPDATE pharmacy_funding_reconciliation_cases')
        && normalized.includes("SET status='RESOLVED'")) {
      this.case.status = 'RESOLVED';
      this.case.approved_by = params[2];
      this.case.outcome = JSON.parse(params[3]);
      return 1;
    }
    if (normalized.startsWith('UPDATE tasks SET status=\'blocked\'')) {
      this.task.status = 'blocked';
      this.task.metadata = { ...this.task.metadata, ...JSON.parse(params[2]) };
      return 1;
    }
    if (normalized.startsWith('UPDATE tasks SET status=\'completed\'')) {
      this.task.status = 'completed';
      this.task.metadata = { ...this.task.metadata, ...JSON.parse(params[2]) };
      return 1;
    }
    if (normalized.startsWith('UPDATE billing_invoices')
        && normalized.includes('SET subtotal = $1::numeric')) {
      return 1;
    }

    throw new Error(`Unhandled reconciliation execute SQL: ${normalized}`);
  }

  hasQuery(fragment) {
    return this.queryCalls.some((call) => call.sql.includes(fragment));
  }

  hasExecute(fragment) {
    return this.executeCalls.some((call) => call.sql.includes(fragment));
  }
}

let scenario;

function useScenario(nextScenario) {
  scenario = nextScenario;
  return scenario;
}

function decisionArgs({
  actorUid = PROPOSER,
  commandKeySha256 = PROPOSAL_COMMAND,
  resolutionPath = 'SAFE_DEACTIVATE_DUPLICATES',
  keeperInvoiceItemId = KEEPER_ID,
  expectedSnapshotSha256 = SNAPSHOT_SHA256,
} = {}) {
  return {
    tenantId: TENANT,
    caseId: CASE_ID,
    keeperInvoiceItemId,
    resolutionPath,
    expectedSnapshotSha256,
    actorUid,
    commandKeySha256,
  };
}

async function propose(activeScenario, {
  resolutionPath = 'SAFE_DEACTIVATE_DUPLICATES',
  keeperInvoiceItemId = KEEPER_ID,
  actorUid = PROPOSER,
  commandKeySha256 = PROPOSAL_COMMAND,
} = {}) {
  useScenario(activeScenario);
  return recordPharmacyFundingReconciliationDecision(decisionArgs({
    resolutionPath,
    keeperInvoiceItemId,
    actorUid,
    commandKeySha256,
  }));
}

async function approve(activeScenario, {
  resolutionPath = 'SAFE_DEACTIVATE_DUPLICATES',
  keeperInvoiceItemId = KEEPER_ID,
  actorUid = APPROVER,
  commandKeySha256 = APPROVAL_COMMAND,
} = {}) {
  useScenario(activeScenario);
  return recordPharmacyFundingReconciliationDecision(decisionArgs({
    resolutionPath,
    keeperInvoiceItemId,
    actorUid,
    commandKeySha256,
  }));
}

beforeEach(() => {
  scenario = null;
  queryMock.mockReset().mockImplementation((sql, ...params) => {
    if (!scenario) throw new Error('No reconciliation SQL scenario is active');
    return scenario.query(sql, params);
  });
  executeMock.mockReset().mockImplementation((sql, ...params) => {
    if (!scenario) throw new Error('No reconciliation SQL scenario is active');
    return scenario.execute(sql, params);
  });
  setTenantTxMock.mockReset().mockImplementation(async (_tenantId, fn) => {
    const transactionScenario = scenario;
    const checkpoint = transactionScenario?.checkpoint();
    try {
      return await fn(mockPrisma);
    } catch (error) {
      if (transactionScenario && checkpoint) transactionScenario.restore(checkpoint);
      throw error;
    }
  });
  resolvePatientUidMock.mockReset().mockImplementation(async (_tx, { patientUid }) => (
    patientUid == null ? PATIENT : String(patientUid)
  ));
  lockAuthorityMock.mockReset().mockResolvedValue(undefined);
  lockAdmissionMock.mockReset().mockResolvedValue({
    id: 77,
    patient_uid: PATIENT,
    status: 'admitted',
  });
  releaseCapMock.mockReset().mockResolvedValue({ id: 701, status: 'RELEASED' });
  clinicalOrderItemsSha256Mock.mockReset().mockReturnValue(ORDER_ITEMS_SHA256);
});

describe('pharmacy funding reconciliation lookup and request fences', () => {
  it('rejects invalid case lookup and decision identity without entering tenant SQL', async () => {
    await expect(getPharmacyFundingReconciliationCase({
      tenantId: TENANT,
      caseId: 0,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_FUNDING_RECONCILIATION_CASE_REQUIRED',
    });
    await expect(recordPharmacyFundingReconciliationDecision(decisionArgs({
      keeperInvoiceItemId: 0,
    }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_FUNDING_RECONCILIATION_DECISION_INVALID',
    });
    await expect(recordPharmacyFundingReconciliationDecision(decisionArgs({
      resolutionPath: 'UNSAFE_GUESS',
    }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_FUNDING_RECONCILIATION_DECISION_INVALID',
    });
    await expect(recordPharmacyFundingReconciliationDecision(decisionArgs({
      commandKeySha256: 'not-a-digest',
    }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'PHARMACY_FUNDING_RECONCILIATION_DECISION_INVALID',
    });
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('returns the joined case and current duplicate snapshot, and reports a missing case exactly', async () => {
    const found = useScenario(new ReconciliationSqlScenario());
    await expect(getPharmacyFundingReconciliationCase({
      tenantId: TENANT,
      caseId: CASE_ID,
    })).resolves.toMatchObject({
      id: CASE_ID,
      pharmacy_order_id: ORDER_ID,
      current_snapshot_sha256: SNAPSHOT_SHA256,
      active_line_count: 2,
    });
    expect(found.queryCalls).toHaveLength(1);

    const missing = useScenario(new ReconciliationSqlScenario({ preReadMissing: true }));
    await expect(getPharmacyFundingReconciliationCase({
      tenantId: TENANT,
      caseId: CASE_ID,
    })).rejects.toMatchObject({ statusCode: 404 });
    expect(missing.executeCalls).toHaveLength(0);
  });

  it('fails before authority mutation when the pre-read is missing', async () => {
    const active = useScenario(new ReconciliationSqlScenario({ preReadMissing: true }));
    await expect(recordPharmacyFundingReconciliationDecision(decisionArgs()))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(resolvePatientUidMock).not.toHaveBeenCalled();
    expect(lockAuthorityMock).not.toHaveBeenCalled();
    expect(active.executeCalls).toHaveLength(0);
  });

  it('fails closed when the locked order no longer belongs to its active tenant patient', async () => {
    const active = useScenario(new ReconciliationSqlScenario({ orderMissing: true }));
    await expect(recordPharmacyFundingReconciliationDecision(decisionArgs()))
      .rejects.toMatchObject({
        statusCode: 409,
        code: 'PHARMACY_FUNDING_RECONCILIATION_AUTHORITY_STALE',
      });
    expect(resolvePatientUidMock).toHaveBeenCalledWith(mockPrisma, {
      tenantId: TENANT,
      orderId: ORDER_ID,
      patientUid: PATIENT,
    });
    expect(lockAuthorityMock).toHaveBeenCalledWith(mockPrisma, {
      tenantId: TENANT,
      patientUid: PATIENT,
    });
    expect(active.executeCalls).toHaveLength(0);
  });

  it('rejects an inactive or non-finance actor before claiming a receipt', async () => {
    const active = useScenario(new ReconciliationSqlScenario({
      actorRoles: { [PROPOSER]: 'NURSE' },
    }));
    await expect(recordPharmacyFundingReconciliationDecision(decisionArgs()))
      .rejects.toMatchObject({
        statusCode: 403,
        code: 'PHARMACY_FUNDING_RECONCILIATION_ACTOR_FORBIDDEN',
      });
    expect(active.receipts.size).toBe(0);
    expect(active.executeCalls).toHaveLength(0);
  });

  it('rejects stale duplicate evidence before writing proposal or command evidence', async () => {
    const active = useScenario(new ReconciliationSqlScenario({
      currentSnapshotSha256: OTHER_SNAPSHOT_SHA256,
    }));
    await expect(recordPharmacyFundingReconciliationDecision(decisionArgs()))
      .rejects.toMatchObject({
        statusCode: 409,
        code: 'PHARMACY_FUNDING_RECONCILIATION_SNAPSHOT_STALE',
        details: { current_snapshot_sha256: OTHER_SNAPSHOT_SHA256 },
      });
    expect(active.executeCalls).toHaveLength(0);
    expect(active.receipts.size).toBe(0);
  });
});

describe('proposal, replay, and dual finance authority', () => {
  it('records the first exact proposal as PENDING_APPROVAL with a replayable receipt', async () => {
    const active = new ReconciliationSqlScenario();
    const result = await propose(active);

    expect(result).toEqual({
      status: 'pending_second_approval',
      replayed: false,
      caseId: CASE_ID,
      taskId: TASK_ID,
      proposalSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      snapshotSha256: SNAPSHOT_SHA256,
      resolutionPath: 'SAFE_DEACTIVATE_DUPLICATES',
      keeperInvoiceItemId: KEEPER_ID,
    });
    expect(active.case).toMatchObject({
      status: 'PENDING_APPROVAL',
      proposed_by: PROPOSER,
      proposal_sha256: result.proposalSha256,
      resolution_path: 'SAFE_DEACTIVATE_DUPLICATES',
      keeper_invoice_item_id: KEEPER_ID,
    });
    expect(active.receipts.get(PROPOSAL_COMMAND)).toMatchObject({
      event_type: 'PROPOSED',
      proposal_sha256: result.proposalSha256,
      actor_uid: PROPOSER,
      evidence: {
        contract: 'pharmacy_funding_reconciliation_proposal_v1',
        response: result,
      },
    });
    expect(active.hasQuery('UPDATE billing_invoice_items')).toBe(false);
  });

  it('returns the exact immutable proposal receipt on same-command replay without new writes', async () => {
    const active = new ReconciliationSqlScenario();
    const first = await propose(active);
    const writesBeforeReplay = active.executeCalls.length;
    const replay = await propose(active);

    expect(replay).toEqual({ ...first, replayed: true });
    expect(active.executeCalls).toHaveLength(writesBeforeReplay);
    expect(active.eventLog.filter((event) => event.event_type === 'PROPOSED')).toHaveLength(1);
  });

  it('rejects reuse of a command receipt by a different actor or request', async () => {
    const active = new ReconciliationSqlScenario();
    await propose(active);
    const writesBeforeMismatch = active.executeCalls.length;

    await expect(approve(active, { commandKeySha256: PROPOSAL_COMMAND }))
      .rejects.toMatchObject({
        statusCode: 422,
        code: 'PHARMACY_FUNDING_RECONCILIATION_COMMAND_MISMATCH',
      });
    expect(active.executeCalls).toHaveLength(writesBeforeMismatch);
  });

  it('requires a distinct second finance owner for the exact pending proposal', async () => {
    const active = new ReconciliationSqlScenario();
    await propose(active);
    const writesBeforeRefusal = active.executeCalls.length;

    await expect(approve(active, {
      actorUid: PROPOSER,
      commandKeySha256: APPROVAL_COMMAND,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'PHARMACY_FUNDING_RECONCILIATION_SECOND_ACTOR_REQUIRED',
    });
    expect(active.case.status).toBe('PENDING_APPROVAL');
    expect(active.executeCalls).toHaveLength(writesBeforeRefusal);
  });

  it('rejects a second approval whose keeper or path differs from the pending proposal', async () => {
    const active = new ReconciliationSqlScenario();
    await propose(active);
    const writesBeforeMismatch = active.executeCalls.length;

    await expect(approve(active, {
      resolutionPath: 'KEEP_CURRENT_AUTHORITY',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_FUNDING_RECONCILIATION_PROPOSAL_MISMATCH',
    });
    expect(active.executeCalls).toHaveLength(writesBeforeMismatch);
  });
});

describe('governed reconciliation blockers', () => {
  const blockerCases = [
    {
      name: 'missing active keeper',
      path: 'KEEP_CURRENT_AUTHORITY',
      keeperId: 999,
      scenario: () => new ReconciliationSqlScenario(),
      reason: 'KEEPER_NOT_ACTIVE',
    },
    {
      name: 'keeper outside the current patient authority',
      path: 'KEEP_CURRENT_AUTHORITY',
      scenario: () => new ReconciliationSqlScenario({
        lines: [
          logicalLine({ patientUid: OTHER_PATIENT }),
          logicalLine({ id: 102, invoiceId: 202 }),
        ],
      }),
      reason: 'KEEPER_DOES_NOT_MATCH_CURRENT_ORDER_AUTHORITY',
    },
    {
      name: 'non-identical SAFE lines',
      path: 'SAFE_DEACTIVATE_DUPLICATES',
      scenario: () => new ReconciliationSqlScenario({
        lines: [logicalLine(), logicalLine({ id: 102, description: 'Different line' })],
      }),
      reason: 'SAFE_RECONCILIATION_REQUIRES_IDENTICAL_SAME_INVOICE_LINES',
    },
    {
      name: 'multiple active REBILL authorities',
      path: 'REBILL',
      scenario: () => new ReconciliationSqlScenario(),
      reason: 'REBILL_CORRECTION_IS_NOT_ONE_UNPAID_DRAFT_AUTHORITY',
    },
    {
      name: 'non-terminal CANCEL order',
      path: 'CANCEL_ORDER',
      scenario: () => new ReconciliationSqlScenario(),
      reason: 'ORDER_IS_NOT_TERMINAL_CANCELLED',
    },
    {
      name: 'finalized finance line',
      path: 'KEEP_CURRENT_AUTHORITY',
      scenario: () => new ReconciliationSqlScenario({
        lines: [
          logicalLine({ invoiceStatus: 'ISSUED' }),
          logicalLine({ id: 102, invoiceStatus: 'ISSUED' }),
        ],
      }),
      reason: 'ISSUED_PAYMENT_OR_ALLOCATION_LINKED_LINES_REQUIRE_REBILL_OR_CANCEL',
    },
    {
      name: 'posted payment',
      path: 'KEEP_CURRENT_AUTHORITY',
      scenario: () => new ReconciliationSqlScenario({
        lines: [
          logicalLine({ payments: [{ id: 1, amount: '1', reversed: false }] }),
          logicalLine({ id: 102 }),
        ],
      }),
      reason: 'ISSUED_PAYMENT_OR_ALLOCATION_LINKED_LINES_REQUIRE_REBILL_OR_CANCEL',
    },
    {
      name: 'unreversed allocation',
      path: 'KEEP_CURRENT_AUTHORITY',
      scenario: () => new ReconciliationSqlScenario({
        lines: [
          logicalLine({ allocations: [{ allocated_amount: '5', reversed_amount: '0' }] }),
          logicalLine({ id: 102 }),
        ],
      }),
      reason: 'ISSUED_PAYMENT_OR_ALLOCATION_LINKED_LINES_REQUIRE_REBILL_OR_CANCEL',
    },
    {
      name: 'live patient advance allocation',
      path: 'KEEP_CURRENT_AUTHORITY',
      scenario: () => new ReconciliationSqlScenario({
        advanceAllocations: [{
          id: '801',
          allocated_amount: '25',
          billing_advance_id: 901,
          invoice_id: 201,
          invoice_item_id: KEEPER_ID,
          funding_task_id: 81,
          funding_approval_receipt_id: null,
        }],
      }),
      reason: 'LIVE_ADVANCE_ALLOCATION_REQUIRES_GOVERNED_RELEASE_OR_CONVERSION',
    },
    {
      name: 'terminal stock movement evidence',
      path: 'CANCEL_ORDER',
      scenario: () => new ReconciliationSqlScenario({
        order: { status: 'CANCELLED' },
        stockMovementIds: [501],
      }),
      reason: 'STOCK_MOVEMENT_EVIDENCE_FORBIDS_TERMINAL_FUNDING_COMPENSATION',
    },
    {
      name: 'shared or unrelated invoice authority',
      path: 'CANCEL_ORDER',
      scenario: () => new ReconciliationSqlScenario({
        order: { status: 'CANCELLED' },
        invoiceSafetyUnrelated: 1,
      }),
      reason: 'INVOICE_CONTAINS_FINALIZED_OR_UNRELATED_ACTIVE_AUTHORITY',
    },
  ];

  it.each(blockerCases)(
    'records $name as durable BLOCKED evidence without mutating billing authority',
    async ({ path, keeperId = KEEPER_ID, scenario: scenarioFactory, reason }) => {
      const active = scenarioFactory();
      await propose(active, { resolutionPath: path, keeperInvoiceItemId: keeperId });
      const result = await approve(active, {
        resolutionPath: path,
        keeperInvoiceItemId: keeperId,
      });

      expect(result).toMatchObject({
        status: 'blocked',
        replayed: false,
        caseId: CASE_ID,
        taskId: TASK_ID,
        blockReason: reason,
      });
      expect(active.case).toMatchObject({ status: 'BLOCKED', outcome: result });
      expect(active.task).toMatchObject({
        status: 'blocked',
        metadata: { reconciliation_block_reason: reason },
      });
      expect(active.eventLog.at(-1)).toMatchObject({
        event_type: 'BLOCKED',
        evidence: {
          contract: 'pharmacy_funding_reconciliation_blocked_v1',
          response: result,
        },
      });
      expect(active.hasQuery('UPDATE billing_invoice_items')).toBe(false);
      expect(active.hasExecute("SET status='RESOLVED'")).toBe(false);
      expect(active.resolvedEvents).toHaveLength(0);
    },
  );
});

describe('successful governed duplicate dispositions', () => {
  const successCases = [
    {
      name: 'SAFE_DEACTIVATE_DUPLICATES',
      path: 'SAFE_DEACTIVATE_DUPLICATES',
      scenario: () => new ReconciliationSqlScenario(),
      expectedDeactivated: [102],
      expectedVoided: [],
      expectedActive: 1,
    },
    {
      name: 'KEEP_CURRENT_AUTHORITY',
      path: 'KEEP_CURRENT_AUTHORITY',
      scenario: () => new ReconciliationSqlScenario({
        lines: [logicalLine(), logicalLine({ id: 102, description: 'Historical duplicate' })],
      }),
      expectedDeactivated: [102],
      expectedVoided: [],
      expectedActive: 1,
    },
    {
      name: 'REBILL',
      path: 'REBILL',
      scenario: () => new ReconciliationSqlScenario({
        lines: [
          logicalLine(),
          logicalLine({ id: 102, invoiceId: 202, active: false, description: 'Old rebill' }),
        ],
      }),
      expectedDeactivated: [102],
      expectedVoided: [202],
      expectedActive: 1,
    },
    {
      name: 'CANCEL_ORDER',
      path: 'CANCEL_ORDER',
      scenario: () => new ReconciliationSqlScenario({
        order: { status: 'CANCELLED' },
        capReservations: [77],
      }),
      expectedDeactivated: [101, 102],
      expectedVoided: [201],
      expectedActive: 0,
    },
  ];

  it.each(successCases)(
    'fully resolves $name with zeroed duplicates, invoice effects, and immutable receipts',
    async ({
      path,
      scenario: scenarioFactory,
      expectedDeactivated,
      expectedVoided,
      expectedActive,
    }) => {
      const active = scenarioFactory();
      const proposed = await propose(active, { resolutionPath: path });
      const outcome = await approve(active, { resolutionPath: path });

      expect(outcome).toMatchObject({
        status: 'resolved',
        replayed: false,
        caseId: CASE_ID,
        taskId: TASK_ID,
        proposalSha256: proposed.proposalSha256,
        snapshotSha256: SNAPSHOT_SHA256,
        resolutionPath: path,
        keeperInvoiceItemId: KEEPER_ID,
        deactivatedInvoiceItemIds: expectedDeactivated,
        voidedInvoiceIds: expectedVoided,
        invalidatedTpaDecisionIds: expectedDeactivated.map((_, index) => 900 + index),
      });
      expect(outcome.monetaryCompensations).toHaveLength(expectedDeactivated.length);
      for (const compensation of outcome.monetaryCompensations) {
        expect(compensation).toMatchObject({
          priorUnitPrice: 100,
          priorLineTotal: 100,
          resultingLineTotal: 0,
        });
      }
      expect(active.lines.filter((line) => line.active)).toHaveLength(expectedActive);
      for (const id of expectedDeactivated) {
        expect(active.lines.find((line) => Number(line.id) === id)).toMatchObject({
          active: false,
          unitPrice: 0,
          lineSubtotal: 0,
          cgstAmount: 0,
          sgstAmount: 0,
          igstAmount: 0,
          lineTotal: 0,
        });
      }
      expect(active.hasQuery('UPDATE tpa_claim_line_decisions')).toBe(true);
      expect(active.hasQuery('COALESCE(SUM(line_subtotal), 0)::numeric AS subtotal')).toBe(true);
      expect(active.hasQuery('SELECT COUNT(*)::int AS active_count')).toBe(true);
      expect(active.case).toMatchObject({
        status: 'RESOLVED',
        approved_by: APPROVER,
        outcome,
      });
      expect(active.task).toMatchObject({
        status: 'completed',
        metadata: { reconciliation_outcome: outcome },
      });
      expect(active.resolvedEvents).toHaveLength(1);
      expect(active.resolvedEvents[0]).toMatchObject({
        event_type: 'RESOLVED',
        proposal_sha256: proposed.proposalSha256,
        actor_uid: APPROVER,
        command_key_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        evidence: {
          contract: 'pharmacy_funding_reconciliation_resolved_v1',
          outcome,
        },
      });
      expect(active.resolvedEvents[0].command_key_sha256).not.toBe(APPROVAL_COMMAND);

      if (path === 'CANCEL_ORDER') {
        expect(releaseCapMock).toHaveBeenCalledWith(mockPrisma, expect.objectContaining({
          tenantId: TENANT,
          facilityId: 5,
          admissionId: 77,
          orderId: ORDER_ID,
          actorUid: APPROVER,
          actorRole: 'SUPER_ADMIN',
          commandKeySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          reason: 'terminal_order_cancelled',
        }));
        expect(outcome.terminalCompensation).toEqual({
          releasedCapReservation: { id: 701, status: 'RELEASED' },
          reversedAllocationIds: [],
          invalidatedFundingEventId: null,
        });
      } else {
        expect(outcome.terminalCompensation).toBeNull();
      }

      const writesBeforeReplay = active.executeCalls.length;
      const queryWritesBeforeReplay = active.queryCalls.filter(
        (call) => call.sql.startsWith('UPDATE '),
      ).length;
      const replay = await approve(active, { resolutionPath: path });
      expect(replay).toEqual({ ...outcome, replayed: true });
      expect(active.executeCalls).toHaveLength(writesBeforeReplay);
      expect(active.queryCalls.filter((call) => call.sql.startsWith('UPDATE ')))
        .toHaveLength(queryWritesBeforeReplay);
      expect(active.resolvedEvents).toHaveLength(1);

      const resolvedReplay = await approve(active, {
        resolutionPath: path,
        commandKeySha256: RESOLVED_REPLAY_COMMAND,
      });
      expect(resolvedReplay).toEqual({ ...outcome, replayed: true });
      expect(active.executeCalls).toHaveLength(writesBeforeReplay);
      expect(active.receipts.has(RESOLVED_REPLAY_COMMAND)).toBe(false);
    },
  );

  it('rolls back before case/task closure when the post-mutation active authority invariant fails', async () => {
    const active = new ReconciliationSqlScenario({ activeCountOverride: 2 });
    await propose(active);
    const linesBeforeApproval = structuredClone(active.lines);
    const invoiceStatusesBeforeApproval = [...active.invoiceStatuses];

    await expect(approve(active)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PHARMACY_FUNDING_RECONCILIATION_AUTHORITY_STALE',
    });
    expect(active.hasQuery('UPDATE billing_invoice_items')).toBe(true);
    expect(active.lines).toEqual(linesBeforeApproval);
    expect([...active.invoiceStatuses]).toEqual(invoiceStatusesBeforeApproval);
    expect(active.case.status).toBe('PENDING_APPROVAL');
    expect(active.task.status).toBe('open');
    expect(active.receipts.has(APPROVAL_COMMAND)).toBe(false);
    expect(active.eventLog.map((event) => event.event_type)).toEqual(['PROPOSED']);
    expect(active.hasExecute("SET status='RESOLVED'")).toBe(false);
    expect(active.resolvedEvents).toHaveLength(0);
  });
});
