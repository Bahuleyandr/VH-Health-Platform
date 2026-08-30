import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '../..');
const read = (relativePath) => fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8');

const billing = read('services/billing/billingV2Service.js');
const cap = read('services/pharmacy/pharmacyCapService.js');
const substitution = read('services/pharmacy/substitutionFundingReauthorisationService.js');
const migration = read('migrations/753_pharmacy_order_inventory_authority.sql');
const schema = read('../prisma/schema.prisma');

function expectOrdered(source, markers) {
  let previous = -1;
  for (const marker of markers) {
    const current = source.indexOf(marker);
    expect(current).toBeGreaterThan(previous);
    previous = current;
  }
}

describe('pharmacy funding authority source contracts', () => {
  it('uses one stable patient-scoped lock before row authority locks', () => {
    expect(cap).toContain(
      "'vh:pharmacy_funding_authority:' || $1::uuid::text || ':' || $2::uuid::text",
    );
    expect(cap).toContain('SELECT pg_advisory_xact_lock');
    expect(cap).toContain('tx.$queryRawUnsafe');
    expect(cap).not.toContain("'vh:pharmacy_funding_authority:' || $1::uuid::text,753");

    const materializer = billing.slice(
      billing.indexOf('export async function materializePharmacyFundingTaskTx'),
      billing.indexOf('export async function resolvePostedPharmacyFundingTx'),
    );
    expect(materializer.indexOf('lockPharmacyFundingAuthorityTx')).toBeLessThan(
      materializer.indexOf('FROM pharmacy_orders po'),
    );
    expect(materializer.indexOf('FROM pharmacy_orders po')).toBeLessThan(
      materializer.indexOf('lockPharmacyFundingAdmissionTx'),
    );
  });

  it('keeps outpatient non-TPA work admission-null and binds a dedicated pharmacy invoice', () => {
    expect(billing).toContain('tpaMode || order.funding_admission_id != null');
    expect(billing).toContain("invoice_type: 'PHARMACY'");
    expect(billing).toContain('PHARMACY_TPA_CLAIM_INVOICE_REQUIRED');
    expect(billing).toContain('funding_admission_order_version=$4::int');
    expect(billing).toContain('funding_admission_items_sha256=$5');
  });

  it('claims and body-binds a line decision command before any decision or task mutation', () => {
    const decision = billing.slice(
      billing.indexOf('export async function recordPharmacyFundingLineDecision'),
      billing.indexOf('// ─── Wave-5 batch-3'),
    );
    const receipt = decision.indexOf('claimPharmacyFundingCommandTx');
    expect(receipt).toBeGreaterThan(0);
    expect(receipt).toBeLessThan(decision.indexOf('INSERT INTO tpa_claim_line_decisions'));
    expect(receipt).toBeLessThan(decision.indexOf('completePharmacyFundingTaskTx'));
    expect(decision).toContain("commandType: 'TPA_LINE_DECISION'");
    expect(decision).toContain("assigned_to_role !== 'INSURANCE_COORDINATOR'");
    expect(decision).toContain("assignedRole: 'FINANCE_INCHARGE'");
  });

  it('locks posted payment rows before aggregating net allocation authority', () => {
    const allocator = billing.slice(
      billing.indexOf('async function allocatePostedPharmacyPaymentsTx'),
      billing.indexOf('async function claimPharmacyFundingCommandTx'),
    );
    expect(allocator.indexOf('FROM billing_payments payment')).toBeLessThan(
      allocator.indexOf('FROM pharmacy_payment_allocations allocation'),
    );
    expect(allocator).toContain('FOR UPDATE');
    expect(allocator).toContain('pharmacy_payment_allocation_reversals');
    expect(allocator).toContain('payment.amount || 0) - (allocatedByPayment');
  });

  it('compensates terminal authority but preserves consumed dispense evidence', () => {
    expect(billing).toContain("['CANCELLED', 'UNAVAILABLE', 'REJECTED']");
    expect(billing).toContain("reason: `terminal_order_${terminalStatus.toLowerCase()}`");
    expect(billing).toContain('reversePharmacyPaymentAllocationTx(tx');
    expect(billing).toContain('PHARMACY_TERMINAL_FUNDING_LINE_AUTHORITY_STALE');
    expect(billing).toContain('priorInvoiceTotalAmount: Number(line.invoice_total_amount)');
    expect(billing).toContain('monetaryCompensation,');
    expect(billing).toContain("status: authorityCancelled ? 'invalidated' : 'closed'");
  });

  it('requires exact dispensed stock evidence before a pharmacy line can be itemized', () => {
    expect(billing).toContain("po.status IN ('DISPENSED','DELIVERED')");
    expect(billing).toContain("movement.movement_kind='issue'");
    expect(billing).toContain('movement.quantity_delta < 0');
    expect(billing).toContain("'pharmacy_order_inventory_allocation_v1'");
    expect(billing).toContain("'pharmacy_dispense_substitution_v1'");
  });

  it('makes allocation and cap evidence append-only and exactly cross-bound', () => {
    expect(migration).toContain(
      'FOREIGN KEY (tenant_id, invoice_item_id, invoice_id)\n    REFERENCES billing_invoice_items (tenant_id, id, invoice_id)',
    );
    expect(migration).toContain(
      'FOREIGN KEY (tenant_id, billing_payment_id, invoice_id)\n    REFERENCES billing_payments (tenant_id, id, invoice_id)',
    );
    expect(migration).toContain(
      'FOREIGN KEY (tenant_id, reservation_id, pharmacy_order_id, admission_id)',
    );
    expect(migration).toContain('enforce_pharmacy_allocation_reversal_balance_753');
    expect(migration).toContain('prevent_pharmacy_payment_allocation_mutation_753');
    expect(migration).toContain('trg_pharmacy_funding_decision_events_append_only_753');
    expect(migration).toContain('prevent_new_duplicate_pharmacy_billing_line_753');
    expect(migration).toContain('pharmacy_funding_reconciliation_cases');
    expect(migration).toContain('pharmacy_funding_reconciliation_events');
    expect(migration).toContain("assigned_to_role,created_by,metadata");
    expect(migration).toContain("'FINANCE_INCHARGE'");
  });

  it('retains immutable funding history while exposing one supersession-chain head', () => {
    expect(migration).toContain('authority_generation  BIGINT');
    expect(migration).toContain('supersedes_event_id   BIGINT');
    expect(migration).toContain('enforce_pharmacy_funding_event_chain_753');
    expect(migration).toContain('ux_pharmacy_funding_events_generation_753');
    expect(migration).toContain('ux_pharmacy_funding_events_supersedes_753');
    expect(migration).toContain("event_type IN ('FUNDING_RESOLVED','AUTHORITY_INVALIDATED')\n      AND authority_generation IS NOT NULL");
    expect(migration).toContain("event_type='FUNDING_RESOLVED'\n          AND authority_generation=1");
    expect(migration).toContain('must alternate resolved and invalidated');
    expect(billing).toContain('appendPharmacyFundingAuthorityStateTx');
    const chainReader = billing.slice(
      billing.indexOf('async function currentPharmacyFundingAuthorityEventTx'),
      billing.indexOf('async function appendPharmacyFundingAuthorityStateTx'),
    );
    expect(chainReader.indexOf('pg_advisory_xact_lock')).toBeLessThan(
      chainReader.indexOf('FROM pharmacy_funding_decision_events event'),
    );
    expect(billing).toContain("eventType: 'AUTHORITY_INVALIDATED'");
    expect(billing).toContain("reason: 'billing_payment_allocation_reversed'");
    expect(cap).toContain('successor.supersedes_event_id=event.id');
    const capResolver = cap.slice(cap.indexOf('export async function resolveAuthoritativeCounterFundingTx'));
    expect(capResolver.indexOf('pg_advisory_xact_lock(hashtextextended(')).toBeLessThan(
      capResolver.indexOf('FROM pharmacy_funding_decision_events event'),
    );
    expect(schema).toContain('authority_generation     BigInt?');
    expect(schema).toContain('supersedes_event_id      BigInt?');
    expect(schema).toContain('pharmacy_funding_event_supersession_753');
  });

  it('gates substitution governance before counter-funding domain rows with a private lease', () => {
    expect(cap).toContain("SUBSTITUTION_FUNDING_TASK_STAGE = 'substitution_reauthorisation'");
    expect(substitution).toContain(
      "SUBSTITUTION_FUNDING_TASK_STAGE = 'substitution_reauthorisation'",
    );
    const barrier = cap.slice(
      cap.indexOf('export async function lockCounterFundingSubstitutionAuthorityTx'),
      cap.indexOf('function consumeCounterFundingSubstitutionAuthorityLease'),
    );
    const resolver = cap.slice(
      cap.indexOf('export async function resolveAuthoritativeCounterFundingTx'),
      cap.indexOf('export async function reservePharmacyCapReservationTx'),
    );
    expectOrdered(barrier, [
      'resolvePharmacyFundingPatientUidTx(tx',
      'lockPharmacyFundingAuthorityTx(tx',
      'vh:substitution-funding:order:',
      'FROM pharmacy_funding_commands',
      'vh:pharmacy_advance_approval:',
      'FROM approvals',
      'FROM tasks',
    ]);
    expectOrdered(resolver, [
      'consumeCounterFundingSubstitutionAuthorityLease(tx',
      'resolvePharmacyFundingPatientUidTx(tx',
      'lockPharmacyFundingAuthorityTx(tx',
      'vh:pharmacy_funding_event_chain:',
      'FROM pharmacy_orders',
      'FROM billing_invoices',
      'FROM billing_invoice_items',
      'lockPharmacyFundingAdmissionTx(tx',
    ]);
    expect(barrier).toContain("command_type='SUBSTITUTION_FUNDING_APPROVAL'");
    expect(barrier).toContain('substitutionFundingApprovalReceiptId = null');
    expect(barrier).toContain('substitutionFundingGovernanceApprovalId = null');
    expect(barrier).toContain('commandRows.length === 1');
    expect(barrier).toContain('approvalRows.length === 1');
    expect(barrier).toContain('taskRows.length === 1');
    expect(barrier).toContain('governance_approval_id');
    expect(barrier).toContain("String(approval.created_by || '').toLowerCase() === proposerUid");
    expect(barrier).toContain("String(task.created_by || '').toLowerCase() === proposerUid");
    expect(barrier).toContain("String(taskMetadata.proposer_uid || '').toLowerCase() === proposerUid");
    expect(barrier).toContain("? 'approval_receipt'");
    expect(barrier).toContain("? 'governance_approval' : 'generic'");
    expect(cap).toContain("Symbol('counterFundingSubstitutionLease')");
    expect(cap).toContain('consumedCounterFundingSubstitutionLeases.has(lease)');
    expect(resolver).toContain('substitutionFundingAuthorityLease = null');
    expect(resolver).not.toContain('FROM pharmacy_funding_commands');
    expect(resolver).not.toContain('FROM approvals');
    expect(resolver).not.toContain('FOR UPDATE OF pharmacy_order,item,invoice');
    expect(resolver).not.toContain('FOR UPDATE OF invoice,item');
  });

  it('never surfaces substitution authority as generic counter-funding recovery', () => {
    const resolver = cap.slice(
      cap.indexOf('export async function resolveAuthoritativeCounterFundingTx'),
      cap.indexOf('export async function reservePharmacyCapReservationTx'),
    );
    const recovery = resolver.slice(
      resolver.indexOf('const recoveryRows'),
      resolver.indexOf("throw AppError.conflict(\n      'No durable posted-payment"),
    );
    expect(recovery).toContain("task.metadata->>'contract'=$3");
    expect(recovery).toContain("task.metadata->>'task_type'='tpa_line_decision'");
    expect(recovery).toContain("task.metadata->>'task_type'='posted_payment'");
    expect(recovery).not.toContain("'pharmacy_patient_advance'");
    expect(resolver).toContain("'pharmacy_funding_task_v1'");
  });

  it('orders exact referenced keys before funding-event foreign keys', () => {
    const eventTable = migration.indexOf(
      'CREATE TABLE IF NOT EXISTS pharmacy_funding_decision_events',
    );
    for (const indexName of [
      'ux_tasks_pharmacy_funding_target_753',
      'ux_billing_items_invoice_scope_753',
      'ux_billing_payments_invoice_scope_753',
    ]) {
      const indexPosition = migration.indexOf(`CREATE UNIQUE INDEX IF NOT EXISTS ${indexName}`);
      expect(indexPosition).toBeGreaterThan(0);
      expect(indexPosition).toBeLessThan(eventTable);
    }
  });

  it('uses the established bypass-aware reconciliation RLS predicate', () => {
    const policies = migration.slice(
      migration.indexOf('CREATE POLICY pharmacy_funding_reconciliation_cases_tenant_isolation'),
      migration.indexOf('ALTER TABLE nhcx_messages'),
    );
    expect(policies.match(/public\.app_current_tenant_id_uuid\(\)/g)).toHaveLength(8);
    expect(policies).toContain("current_setting('app.current_tenant_id', TRUE) = 'bypass'");
    expect(policies).toContain("current_setting('app.current_tenant_id', TRUE) <> 'bypass'");
    expect(policies).not.toMatch(/(^|[^_])current_tenant_id\(\)/m);
  });

  it('binds cap evidence to the pinned order admission and exact claim', () => {
    expect(migration).toContain("funding_source IN ('tpa_claim','mixed')");
    expect(migration).toContain('fk_pharmacy_cap_reservation_order_admission_753');
    expect(migration).toContain(
      'FOREIGN KEY (tenant_id, funding_tpa_claim_id, admission_id)',
    );
    expect(cap).toContain('funding_admission_order_version');
    expect(cap).toContain('clinicalOrderItemsSha256(order.items_list)');
    expect(cap).toContain("AND status IN ('approved','partially_approved','paid')");
    expect(cap).not.toContain('ORDER BY admitted_at DESC NULLS LAST');
    expect(cap).toContain("'RELEASED',$5::numeric,\n             0");
    expect(migration).toContain("event_type='RELEASED' AND prior_amount IS NOT NULL");
  });

  it('persists NHCX 2xx transport authority before local projection', () => {
    expect(migration).toContain('transport_response_sha256 CHAR(64)');
    expect(migration).toContain('prevent_nhcx_transport_receipt_rewrite_753');
    expect(schema).toContain('transport_response_sha256     String?   @db.Char(64)');
    expect(schema).toContain('nhcx_projection_task_753');
  });

  it('models NHCX transport and projection authority on nhcx_messages only', () => {
    const hl7Model = schema.slice(
      schema.indexOf('model hl7_outbound_messages {'),
      schema.indexOf('model hl7_outbound_transport_attempts {'),
    );
    const nhcxModel = schema.slice(
      schema.indexOf('model nhcx_messages {'),
      schema.indexOf('model nicu_admission_newborn_links {'),
    );
    for (const field of [
      'transport_accepted_at', 'transport_response_sha256', 'projection_status',
      'projection_task_id', 'projection_task',
    ]) {
      expect(hl7Model).not.toContain(field);
      expect(nhcxModel).toContain(field);
    }
    expect(nhcxModel).toContain('idx_nhcx_projection_reconciliation_753');
    expect(schema).toContain(
      'nhcx_projection_messages nhcx_messages[] @relation("nhcx_projection_task_753")',
    );
    expect(schema.match(/@relation\("nhcx_projection_task_753"/g)).toHaveLength(2);
  });

  it('keeps the Prisma snapshot aligned with all five durable funding tables and relations', () => {
    for (const model of [
      'pharmacy_funding_decision_events',
      'pharmacy_funding_commands',
      'pharmacy_payment_allocations',
      'pharmacy_payment_allocation_reversals',
      'pharmacy_cap_reservation_events',
    ]) {
      expect(schema).toContain(`model ${model} {`);
    }
    expect(schema).toContain('pharmacy_funding_commands_task_753');
    expect(schema).toContain('pharmacy_payment_allocations_invoice_item_753');
    expect(schema).toContain('pharmacy_payment_allocations_payment_753');
    expect(schema).toContain('pharmacy_payment_allocation_reversals_exact_753');
    expect(schema).toContain('pharmacy_cap_reservation_events_reservation_753');
    expect(schema).toContain('authority_evidence        Json      @default("{}")');
  });
});
