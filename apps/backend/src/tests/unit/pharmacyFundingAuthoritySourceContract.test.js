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
    // There are now two "Wave-5 batch-3" banners in this service; the bare
    // prefix resolves to the earlier one (the admission invoice auto-itemizer),
    // which sits ABOVE this function and silently collapsed the slice to ''.
    // Anchor on the full banner so the ordering below is actually evaluated.
    const decision = billing.slice(
      billing.indexOf('export async function recordPharmacyFundingLineDecision'),
      billing.indexOf('// ─── Wave-5 batch-3 — TPA decision UI helpers'),
    );
    expect(decision.length).toBeGreaterThan(0);
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
    // Bound to the owning constraint name, and matched across whitespace rather
    // than a literal '\n': core.autocrlf=true checks this LF blob out as CRLF on
    // Windows, so a '\n'-literal probe fails on every Windows host even when the
    // committed SQL has not drifted at all — and an unbound probe could be
    // satisfied by the same column list on a different table entirely.
    expect(migration).toMatch(
      /CONSTRAINT fk_pharmacy_payment_allocation_item_753\s*FOREIGN KEY \(tenant_id, invoice_item_id, invoice_id\)\s*REFERENCES billing_invoice_items \(tenant_id, id, invoice_id\)/,
    );
    expect(migration).toMatch(
      /CONSTRAINT fk_pharmacy_payment_allocation_payment_753\s*FOREIGN KEY \(tenant_id, billing_payment_id, invoice_id\)\s*REFERENCES billing_payments \(tenant_id, id, invoice_id\)/,
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
    // A migration has no acting user and tasks.created_by is nullable, so the
    // seeded reconciliation task has never carried one — 'created_by' in this
    // column list could never fire. Pin the provenance the row DOES carry: its
    // exact column list, the dual-control owner role, and the versioned task
    // contract that the runtime worklist reader matches on.
    expect(migration).toContain('related_resource_id,priority,status,assigned_to_role,metadata');
    expect(migration).toContain("'high','open','FINANCE_INCHARGE',");
    expect(migration).toContain("'pharmacy_funding_reconciliation_task_v1'");
    expect(migration).toContain("'FINANCE_INCHARGE'");
  });

  it('retains immutable funding history while exposing one supersession-chain head', () => {
    expect(migration).toContain('authority_generation  BIGINT');
    expect(migration).toContain('supersedes_event_id   BIGINT');
    expect(migration).toContain('enforce_pharmacy_funding_event_chain_753');
    expect(migration).toContain('ux_pharmacy_funding_events_generation_753');
    expect(migration).toContain('ux_pharmacy_funding_events_supersedes_753');
    // Whitespace-tolerant for the same core.autocrlf reason as above.
    expect(migration).toMatch(
      /event_type IN \('FUNDING_RESOLVED','AUTHORITY_INVALIDATED'\)\s*AND authority_generation IS NOT NULL/,
    );
    expect(migration).toMatch(
      /event_type='FUNDING_RESOLVED'\s*AND authority_generation=1/,
    );
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
    // No named @relation for a 753 table has ever existed in this snapshot —
    // the repo emulates these raw-SQL relations (migrations 749/750) and keeps
    // the FK in SQL. The "one supersession-chain head" guarantee is carried by
    // the partial unique indexes, which the snapshot DOES mirror; pin those on
    // both sides plus the SQL FK, which is what actually enforces the chain.
    expect(schema).toContain('map: "ux_pharmacy_funding_events_supersedes_753"');
    expect(schema).toContain('map: "ux_pharmacy_funding_events_generation_753"');
    expect(migration).toContain('ADD CONSTRAINT fk_pharmacy_funding_event_supersedes_753');
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
    // The approval/task identity binding was lifted out of the barrier into the
    // pure exactSubstitutionApprovalTask predicate, which the barrier calls to
    // decide the exact pair. It now binds the approval kind, subject resource,
    // contract, stage, order and both task-id directions on top of the three
    // proposer identities this used to pin — assert it there.
    const exactPair = cap.slice(
      cap.indexOf('function exactSubstitutionApprovalTask'),
      cap.indexOf('function substitutionFundingConflict'),
    );
    expect(exactPair.length).toBeGreaterThan(0);
    expect(barrier).toContain('exactSubstitutionApprovalTask({ approval, task, orderId');
    expect(exactPair).toContain(
      "approval.approval_kind === 'pharmacy_substitution_funding_reauthorisation'",
    );
    expect(exactPair).toContain(
      "approval.subject_resource_type === 'pharmacy_substitution_funding_proposal'",
    );
    expect(exactPair).toContain('approval.subject_resource_id === proposalSha256');
    expect(exactPair).toContain('Number(approval.task_id) === Number(task.id)');
    expect(exactPair).toContain('Number(taskMetadata.approval_id) === Number(approval.id)');
    expect(exactPair).toContain('proposerUid.length > 0');
    expect(exactPair).toContain("String(approval.created_by || '').toLowerCase() === proposerUid");
    expect(exactPair).toContain("String(task.created_by || '').toLowerCase() === proposerUid");
    expect(exactPair).toContain(
      "String(taskMetadata.proposer_uid || '').toLowerCase() === proposerUid",
    );
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
    // The permissive policy on each reconciliation table is named plainly
    // (`tenant_isolation`), matching every other table in this migration; only
    // the RESTRICTIVE half carries the table-qualified name. Anchor the slice
    // on the RLS enablement instead, which is unambiguous, and pin both policy
    // names so a silently renamed or dropped half is caught.
    const policies = migration.slice(
      migration.indexOf(
        'ALTER TABLE pharmacy_funding_reconciliation_cases ENABLE ROW LEVEL SECURITY',
      ),
      migration.indexOf('ALTER TABLE nhcx_messages'),
    );
    expect(policies).toContain('CREATE POLICY pharmacy_funding_reconciliation_cases_tenant_restrictive');
    expect(policies).toContain('CREATE POLICY pharmacy_funding_reconciliation_events_tenant_restrictive');
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
    // The projection→task binding is a SQL foreign key plus a scalar in the
    // relation-emulated snapshot, never a named Prisma relation. Pin both.
    expect(migration).toContain('ADD CONSTRAINT fk_nhcx_projection_task_753');
    expect(schema).toContain('projection_task_id            Int?');
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
    // No 753 table is modelled with a named Prisma relation in this repo — the
    // raw-SQL authority tables are relation-emulated (migrations 749/750) and
    // the snapshot mirrors scalars plus index maps only. Pin that no such
    // relation has crept in (it would silently change the generated client's
    // shape) and pin the SQL foreign key that actually binds the projection to
    // its tenant-scoped task.
    expect(schema).not.toMatch(/@relation\("[A-Za-z_0-9]*_753"/);
    expect(migration).toMatch(
      /ADD CONSTRAINT fk_nhcx_projection_task_753\s*FOREIGN KEY \(tenant_id,projection_task_id\)\s*REFERENCES tasks \(tenant_id,id\)/,
    );
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
    // These five names were relation names the snapshot has never carried, and
    // four of them named no database object at all. The alignment this test is
    // for is between the snapshot's index/constraint MAPS and the migration
    // that creates them — assert that on both sides, so a map renamed on either
    // side is caught instead of a name that could never match.
    for (const indexMap of [
      'ux_pharmacy_funding_events_command_753',
      'ux_pharmacy_funding_events_generation_753',
      'ux_pharmacy_funding_events_supersedes_753',
      'ux_pharmacy_funding_commands_key_753',
      'idx_pharmacy_funding_commands_task_753',
      'idx_pharmacy_funding_commands_item_753',
      'ux_pharmacy_payment_allocations_exact_753',
      'ux_pharmacy_payment_allocations_identity_753',
      'idx_pharmacy_payment_allocations_payment_753',
      'ux_pharmacy_payment_allocation_reversals_command_753',
      'idx_pharmacy_payment_allocation_reversals_allocation_753',
      'ux_pharmacy_cap_reservation_events_command_753',
      'idx_pharmacy_cap_reservation_events_order_753',
    ]) {
      expect(schema).toContain(`map: "${indexMap}"`);
      expect(migration).toContain(indexMap);
    }
    expect(schema).toContain('authority_evidence        Json      @default("{}")');
  });
});
