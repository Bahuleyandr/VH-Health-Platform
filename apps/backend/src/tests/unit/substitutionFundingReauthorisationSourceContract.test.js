import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '../..');
const read = (relativePath) => fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8');

const service = read('services/pharmacy/substitutionFundingReauthorisationService.js');
const pharmacyCap = read('services/pharmacy/pharmacyCapService.js');
const routes = read('routes/pharmacy/substitutionFundingRoutes.js');
const app = read('app.js');
const taskService = read('services/workflow/taskService.js');
const migration = read('migrations/753_pharmacy_order_inventory_authority.sql');

function sliceBetween(source, start, end) {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt).toBeGreaterThanOrEqual(0);
  expect(endAt).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe('substitution funding reauthorisation source contract', () => {
  it('keeps proposal and decision authority on the narrow canonical role sets', () => {
    const roles = sliceBetween(
      service,
      'export const SUBSTITUTION_FUNDING_PROPOSER_ROLES',
      'const ACTIVE_TASK_STATUSES',
    );
    expect(roles).toContain("'PHARMACY_STAFF'");
    expect(roles).toContain("'PHARMACY_INCHARGE'");
    expect(roles).toContain("'INSURANCE_COORDINATOR'");
    expect(roles).toContain("'CLAIMS_MANAGER'");
    expect(roles).toContain("'FINANCE_INCHARGE'");
    expect(roles).toContain("'BILLING_INCHARGE'");
    expect(roles).not.toContain("'ADMIN'");
    expect(roles).not.toContain("'SUPER_ADMIN'");

    expect(service).toContain('is_active=TRUE');
    expect(service).toContain("status='active'");
    expect(service).toContain('is_deleted=FALSE');
    expect(service).toContain('merged_into_uid IS NULL');
    expect(service).toContain('SUBSTITUTION_FUNDING_SELF_APPROVAL_FORBIDDEN');
    expect(service).toContain('assertPharmacyFacilityGrant');
  });

  it('rejects all caller-selected patient, clinical, facility, price and funding authority', () => {
    const selector = sliceBetween(
      service,
      'export function normalizeSubstitutionFundingSelector',
      'export function substitutionFundingMaterializationKey',
    );
    for (const key of [
      'order_line_index',
      'final_catalog_id',
      'inventory_item_id',
      'inventory_batch_id',
      'quantity',
    ]) {
      expect(service).toContain(`'${key}'`);
    }
    expect(selector).toContain('SUBSTITUTION_FUNDING_CALLER_AUTHORITY_FORBIDDEN');
    expect(selector).toContain('forbidden_fields: forbiddenFields.sort()');
    expect(service).toContain('FOR UPDATE OF pharmacy_order,patient');
    expect(service).toContain('FOR UPDATE OF prescription,prescriber');
    expect(service).toContain('FOR UPDATE OF catalog');
    expect(service).toContain('FOR UPDATE OF item');
    expect(service).toContain('FOR UPDATE OF batch');
  });

  it('binds idempotent proposals to the tenant, proposer and exact request', () => {
    const proposal = sliceBetween(
      service,
      'export async function createSubstitutionFundingProposal',
      'function assertApprovalAndTaskContract',
    );
    const liveReplay = sliceBetween(
      proposal,
      'const replayFundingAuthorityLease',
      'const replayAuthority = await resolveSubstitutionFundingAuthorityTx',
    );
    expect(service).toContain('substitutionFundingMaterializationKey');
    expect(service).toContain('proposalRequestSha256');
    expect(proposal).toContain('WHERE tenant_id=$1::uuid AND materialization_key=$2');
    expect(proposal).toContain('const lockedSnapshot = assertProposalReplay');
    expect(proposal.indexOf('locked.approval.is_expired')).toBeLessThan(
      proposal.indexOf('const replayAuthority = await resolveSubstitutionFundingAuthorityTx'),
    );
    expect(liveReplay).toContain(
      'substitutionFundingGovernanceApprovalId: existingApprovalId',
    );
    expect(proposal.indexOf('const fundingLock = await lockSubstitutionFundingOrderAuthorityTx'))
      .toBeLessThan(proposal.indexOf('vh:substitution-funding:materialization:'));
    expect(proposal.indexOf('const fundingLock = await lockSubstitutionFundingOrderAuthorityTx'))
      .toBeLessThan(proposal.indexOf('lockSubstitutionFundingApprovalTaskTx(tx'));
    expect(liveReplay.indexOf('lockCounterFundingSubstitutionAuthorityTx(tx')).toBeLessThan(
      liveReplay.indexOf('lockSubstitutionFundingApprovalTaskTx(tx'),
    );
    expect(service).toContain('SUBSTITUTION_FUNDING_PROPOSAL_MISMATCH');
    expect(proposal).toContain('vh:substitution-funding:materialization:');
    expect(proposal.indexOf('lockTenantPatientMergeStability(tx, tid)')).toBeLessThan(
      proposal.indexOf('lockSubstitutionFundingCanonicalAuthorityTx(tx'),
    );
    expect(proposal.indexOf('lockSubstitutionFundingCanonicalAuthorityTx(tx')).toBeLessThan(
      proposal.indexOf('vh:substitution-funding:materialization:'),
    );
  });

  it('creates one specialized approval bound to its reciprocal schema-valid task', () => {
    const proposal = sliceBetween(
      service,
      'export async function createSubstitutionFundingProposal',
      'function assertApprovalAndTaskContract',
    );
    const approvalInsert = sliceBetween(
      proposal,
      '`INSERT INTO approvals',
      'RETURNING id,status,created_by,expires_at,metadata`',
    );
    expect(approvalInsert).not.toContain('workflow_run_id');
    expect(approvalInsert).not.toContain('workflow_step_id');
    expect(approvalInsert).toContain('created_by,task_id');
    expect(approvalInsert).toContain('$7::int');
    expect(proposal).toContain('SECURITY_CONFIG.controlledDispenseWitness.approvalTtlMinutes');
    expect(proposal).toContain("stage: SUBSTITUTION_FUNDING_TASK_STAGE");
    expect(service).toContain("taskResourceType: 'pharmacy_tpa_line_decision'");
    expect(service).toContain("taskResourceType: 'pharmacy_posted_payment'");
    expect(service).toContain("taskResourceType: 'pharmacy_patient_advance'");
    expect(service).toContain("permittedRoles: Object.freeze(['FINANCE_INCHARGE'])");
    expect(proposal).toContain('JSON.stringify({ approval_id: Number(approval.id) })');
    expect(proposal).toContain('task_id: Number(task.id)');
    expect(service).toContain('Number(approval.task_id) === expectedTaskId');
    expect(service).toContain("String(task.created_by || '').toLowerCase() === proposerUid");
    expect(service).toContain(
      "String(taskMetadata.proposer_uid || '').toLowerCase() === proposerUid",
    );
  });

  it('closes expired approvals and tasks before allowing a replacement proposal', () => {
    const expiry = sliceBetween(
      service,
      'async function expireSubstitutionFundingProposalTx',
      'function assertProposalReplay',
    );
    expect(expiry).toContain("SET status='expired'");
    expect(expiry).toContain("SET status='cancelled'");
    expect(expiry).toContain('cancelled_at=COALESCE(cancelled_at,NOW())');
    expect(expiry).toContain('cancellation_reason=COALESCE');
    expect(expiry).toContain("status IN ('open','in_progress','blocked','overdue','cancelled')");
    expect(service).toContain(
      "(ACTIVE_TASK_STATUSES.has(task.status) || task.status === 'cancelled')",
    );
    expect(expiry).toContain('approval.expires_at<=NOW()');
    expect(expiry).toContain('FOR UPDATE OF approval');
    expect(expiry).toContain('FOR UPDATE`');
    expect(service).toContain('return EXPIRED_APPROVAL_RESULT');
    expect(service).toContain('SUBSTITUTION_FUNDING_APPROVAL_EXPIRED');
  });

  it('prevents generic approval creation and decision for the domain-owned kind', () => {
    const denylist = sliceBetween(
      taskService,
      'const GENERIC_RUNTIME_DENIED_APPROVAL_KINDS',
      'const COVERING_TRANSFER_TASK_CONTRACT',
    );
    const createApproval = sliceBetween(
      taskService,
      'export async function createApproval',
      'export async function recordApprovalDecision',
    );
    const decideApproval = sliceBetween(
      taskService,
      'export async function recordApprovalDecision',
      'export async function listApprovals',
    );
    expect(denylist).toContain("'pharmacy_substitution_funding_reauthorisation'");
    expect(createApproval).toContain('assertGenericApprovalKindAllowed(cleanKind)');
    expect(decideApproval).toContain('assertGenericApprovalKindAllowed(current[0].approval_kind)');
  });

  it('prevents generic transition, reassignment, claim and acknowledgement of domain tasks', () => {
    expect(taskService).toContain('SUBSTITUTION_FUNDING_TASK_CONTRACT');
    expect(taskService).toContain('SUBSTITUTION_FUNDING_TASK_WORKFLOW_REQUIRED');
    for (const functionName of [
      'export async function transitionTask',
      'export async function reassignTask',
      'async function claimTaskForCurrentActorTx',
      'async function acknowledgeTaskInternal',
    ]) {
      const start = taskService.indexOf(functionName);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(taskService.slice(start, start + 5000)).toContain(
        'assertGenericTaskMutationAllowed(',
      );
    }
  });

  it('claims one DB-default receipt bound to immutable governance lineage', () => {
    const decision = sliceBetween(
      service,
      'export async function approveSubstitutionFundingProposal',
      'async function reserveSubstitutionFundingAdvanceCapacityTx',
    );
    const receiptInsert = sliceBetween(
      decision,
      '`INSERT INTO pharmacy_funding_commands',
      'RETURNING id::text AS id',
    );
    expect(receiptInsert).toContain("'SUBSTITUTION_FUNDING_APPROVAL'");
    expect(receiptInsert).toContain('pharmacy_order_id,facility_id,invoice_id');
    expect(receiptInsert).toContain('governance_approval_id,proposal_sha256,proposer_uid');
    expect(receiptInsert).not.toContain(',status');
    expect(service).toContain('Number(receipt.governance_approval_id) === Number(approval.id)');
    expect(service).toContain('Number(receipt.facility_id) === Number(metadata.facility_id)');
    expect(service).toContain('Number(receipt.invoice_id) === Number(metadata.invoice_id)');
    expect(service).toContain("String(receipt.proposer_uid || '').toLowerCase()");
    expect(decision).toContain("SET status='COMPLETE',response_body=$3::jsonb");
    expect(decision).not.toContain("response_body=$3::jsonb,completed_at=NOW()");
    expect(decision).toContain('proposer: authority.proposer');
    expect(decision).toContain('approver_uid: approver.uid');
    expect(decision).toContain('base: authority.base');
    expect(decision).toContain('prospective: authority.prospective');
    expect(decision).toContain('billing: authority.billing');
    expect(decision).toContain('advance_reservations: advanceReservations');
    expect(decision).toContain('preflight.is_expired && receiptRows.length === 0');
    expect(decision.indexOf('if (commandWasExisting) return completeReceiptResponse(command)'))
      .toBeLessThan(decision.indexOf('const authority = await resolveSubstitutionFundingAuthorityTx'));
    expect(decision).toContain('substitutionFundingApprovalReceiptId: command.id');
    expect(service).toContain('const substitutionFundingAuthorityLease = await');
    expect(service).toContain('lockCounterFundingSubstitutionAuthorityTx(tx');
    expect(service).toContain('substitutionFundingAuthorityLease,');
    expect(decision.indexOf('approvedSubstitutionFundingReceiptContract(response)')).toBeLessThan(
      decision.indexOf("SET status='COMPLETE',response_body=$3::jsonb"),
    );
    expect(service).toContain('prospective_fingerprint: sha256(prospectiveTuple)');

    expect(migration).toContain('governance_approval_id INTEGER');
    expect(migration).toContain('proposal_sha256       CHAR(64)');
    expect(migration).toContain('proposer_uid          UUID');
    expect(migration).toContain("status                VARCHAR(20) NOT NULL DEFAULT 'IN_PROGRESS'");
    expect(migration).toContain("'pharmacy_patient_advance'");
    expect(migration).toContain('pharmacy funding command receipts cannot be deleted');
    expect(migration).toContain('pharmacy funding command identity and completed response are immutable');
  });

  it('keeps consumption inert until the canonical final-dispense receipt is wired', () => {
    const consumer = sliceBetween(
      service,
      'export async function consumeApprovedSubstitutionFundingReauthorisationTx',
      'export function substitutionFundingReauthorisationEvidenceSnapshot',
    );
    expect(consumer).toContain('SUBSTITUTION_FUNDING_ORDER_MUTATION_UNWIRED');
    expect(consumer).toContain('immutable final-dispense mutation receipt');
    expect(consumer).not.toContain('INSERT INTO pharmacy_advance_allocation_consumptions');
    expect(consumer).not.toContain('UPDATE pharmacy_orders');
    expect(consumer).not.toContain('UPDATE billing_invoice_items');
    expect(consumer).not.toContain('SETTLED_TO_INVOICE');
    expect(service).toContain('new WeakSet()');
    expect(service).toContain('new WeakMap()');
    expect(service).not.toContain('APPROVED_SUBSTITUTION_FUNDING_EVIDENCE.add(evidence)');
  });

  it('keeps proposal and approval free of clinical, stock and finance lifecycle mutation', () => {
    const phases = sliceBetween(
      service,
      'export async function createSubstitutionFundingProposal',
      'export async function consumeApprovedSubstitutionFundingReauthorisationTx',
    );
    const forbiddenMutation = new RegExp(
      String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+` +
      String.raw`(?:pharmacy_orders|e_prescriptions|pharmacy_inventory_(?:items|batches|movements)|` +
      String.raw`billing_(?:invoices|invoice_items|payments)|pharmacy_payment_allocations|` +
      String.raw`tpa_claim_line_decisions|pharmacy_funding_decision_events)\b`,
      'i',
    );
    expect(phases).not.toMatch(forbiddenMutation);
    expect(phases).toContain('INSERT INTO pharmacy_advance_allocations');
    expect(phases).not.toContain('INSERT INTO billing_advance_settlements');
    expect(phases).not.toContain('INSERT INTO pharmacy_advance_allocation_reversals');
  });

  it('freezes exact structural and billing base/prospective tuples', () => {
    expect(service).toContain('items_list: orderItems');
    expect(service).toContain('items_list: projection.order_items');
    expect(service).toContain("contract: 'pharmacy_substitution_funding_billing_v1'");
    expect(service).toContain('invoice_credit_note_amount');
    expect(service).toContain('item_source_authority_version');
    expect(service).toContain('item_source_authority_sha256');
    expect(service).toContain('invoiceAuthority.item_source_ref_active !== true');
    expect(service).toContain('invoiceAuthority.item_source_authority_version');
    expect(service).toContain('invoiceAuthority.item_source_authority_sha256');
    expect(service).toContain('invoiceSubtotal.scaled - itemSubtotal.scaled + targetItemAmount.scaled');
    expect(service).toContain('billingBaseInvoice.status !== \'DRAFT\'');
    expect(service).toContain('billingProspectiveItem.source_authority_sha256');
    expect(service).toContain('stableJson(authority.billing)');
    const authority = sliceBetween(
      service,
      'async function resolveSubstitutionFundingAuthorityTx',
      'function proposalResponse',
    );
    expect(authority.indexOf('FROM billing_invoices invoice')).toBeLessThan(
      authority.indexOf('FROM billing_invoice_items item'),
    );
    expect(authority).not.toContain('FOR UPDATE OF item,invoice');
  });

  it('reserves exact patient advance capacity while the approval receipt is in progress', () => {
    const reservation = sliceBetween(
      service,
      'async function reserveSubstitutionFundingAdvanceCapacityTx',
      'export async function consumeApprovedSubstitutionFundingReauthorisationTx',
    );
    expect(reservation).toContain('INSERT INTO pharmacy_advance_allocations');
    expect(reservation).toContain('funding_approval_receipt_id');
    expect(reservation).toContain('governance_approval_id');
    expect(reservation).toContain('billing_advance_patient_uid');
    expect(reservation).toContain('billing_advance_terminal_patient_uid');
    expect(reservation).toContain("contract: 'pharmacy_advance_allocation_v1'");
    expect(reservation).toContain('source_authority_version: authority.base.order_version');
    expect(reservation).toContain('source_authority_sha256: authority.base.order_items_sha256');
    expect(reservation).toContain('prospective: {');
    expect(reservation).toContain('reservationTotalScaled !== plan.patientAmountRequiredScaled');
    expect(reservation).not.toContain('SETTLED_TO_INVOICE');
    expect(reservation).not.toMatch(/(?:UPDATE|DELETE\s+FROM)\s+pharmacy_orders/i);
    expect(reservation).not.toMatch(/(?:UPDATE|DELETE\s+FROM)\s+pharmacy_inventory_/i);
  });

  it('uses exact scaled arithmetic and conservative source-specific capacity', () => {
    const patientAdvanceRails = sliceBetween(
      service,
      'const PATIENT_ADVANCE_RAILS',
      'const SELECTOR_KEYS',
    );
    expect(service).toContain('multiplier: 10_000n');
    expect(service).toContain('maxScaled: 99_999_999_999_999n');
    expect(service).toContain('maxScaled: 999_999_999_999n');
    expect(service).toContain('maxScaled: 9_999_999_999n');
    expect(service).toContain('discarded >= 5_000n ? 1n : 0n');
    expect(service).not.toContain('.toFixed(');
    expect(service).not.toContain('Math.');
    expect(service).toContain("'CASH'");
    expect(service).toContain("'NETBANKING'");
    expect(service).toContain("'BANK_TRANSFER'");
    expect(patientAdvanceRails).not.toContain('INSURANCE');
    expect(patientAdvanceRails).not.toContain('CORPORATE_TPA');
    expect(service).toContain("refund.approval_status<>'REJECTED'");
    expect(service).toContain("advance.status='ACTIVE'");
    expect(service).toContain('advance.patient_uid=ANY($2::uuid[])');
    expect(service).toContain('pharmacy_order.uid=ANY($5::uuid[])');
    expect(service).toContain("UPPER(BTRIM(advance.mode))=ANY($5::text[])");
    expect(service).toContain('advance.collected_at<=$4::timestamptz');
    expect(service).toContain('($3::int IS NULL AND advance.admission_id IS NULL)');
    expect(service).toContain('advance.admission_id=$3::int');
    expect(service).toContain('funding_admission_started_at: admissionStartedAt');
    expect(service).toContain('patient_uid_family: fundingPatientUids');
    expect(service).toContain('stored_patient_uid: advance.patientUid');
    expect(service).toContain("public.digest($1::jsonb::text,'sha256')");
    expect(service).toContain('sourceEvidenceSha256 = await databaseJsonbSha256(');
    expect(service).toContain('evidenceSha256 = await databaseJsonbSha256(');
    expect(service).not.toContain('source_evidence_sha256: sha256(sourceEvidence)');
    expect(service).not.toContain('evidence_sha256: sha256(evidence)');
    expect(service).toContain('grossAvailableScaled - otherLiveScaled');
    expect(service).toContain('settledScaled + refundedScaled + otherLiveScaled + ownAllocationScaled');
    expect(service).toContain('tpaUsedScaled + availableForOrderScaled');
    expect(service).toContain("? patientAmountRequiredScaled > 0n ? 'mixed' : 'tpa_claim'");
    expect(service).toContain(": 'patient_advance'");
    expect(service).not.toContain('INSERT INTO pharmacy_payment_allocations');
  });

  it('locks merge stability and patient family before the receipt, advisory and domain rows', () => {
    const fundingLock = service.indexOf('lockPharmacyFundingAuthorityTx(tx');
    const orderAdvisory = service.indexOf('vh:substitution-funding:order:');
    expect(fundingLock).toBeGreaterThanOrEqual(0);
    expect(orderAdvisory).toBeGreaterThan(fundingLock);
    const advisory = sliceBetween(
      service,
      'async function lockSubstitutionFundingApprovalReceiptAdvisoryTx',
      'function proposalRequestSha256',
    );
    expect(advisory).toContain("'vh:pharmacy_advance_approval:'");
    expect(advisory).toContain("|| $2::text,0)");
    expect(advisory).toContain("approval_receipt_id");

    const decision = sliceBetween(
      service,
      'export async function approveSubstitutionFundingProposal',
      'async function reserveSubstitutionFundingAdvanceCapacityTx',
    );
    const newCommandDecision = sliceBetween(
      decision,
      'const commandWasExisting',
      'if (commandWasExisting) return completeReceiptResponse(command)',
    );
    expect(decision.indexOf('lockTenantPatientMergeStability(tx, tid)')).toBeLessThan(
      decision.indexOf('resolveSubstitutionFundingPatientPreflightTx(tx'),
    );
    expect(decision.indexOf('resolveSubstitutionFundingPatientPreflightTx(tx')).toBeLessThan(
      decision.indexOf('lockSubstitutionFundingCanonicalAuthorityTx(tx'),
    );
    expect(decision.indexOf('lockSubstitutionFundingCanonicalAuthorityTx(tx')).toBeLessThan(
      decision.indexOf('lockSubstitutionFundingOrderAuthorityTx(tx'),
    );
    expect(decision.indexOf('lockSubstitutionFundingOrderAuthorityTx(tx')).toBeLessThan(
      decision.indexOf('FROM pharmacy_funding_commands'),
    );
    expect(decision.indexOf('FROM pharmacy_funding_commands')).toBeLessThan(
      decision.indexOf('lockSubstitutionFundingApprovalReceiptAdvisoryTx(tx'),
    );
    expect(newCommandDecision.indexOf('lockSubstitutionFundingApprovalReceiptAdvisoryTx(tx'))
      .toBeLessThan(newCommandDecision.indexOf('lockCounterFundingSubstitutionAuthorityTx(tx'));
    expect(newCommandDecision.indexOf('lockCounterFundingSubstitutionAuthorityTx(tx'))
      .toBeLessThan(newCommandDecision.indexOf('lockSubstitutionFundingApprovalTaskTx(tx'));
    expect(decision.indexOf('if (preflight.is_expired && receiptRows.length === 0)'))
      .toBeLessThan(decision.indexOf('const commandWasExisting'));
    expect(sliceBetween(
      decision,
      'if (preflight.is_expired && receiptRows.length === 0)',
      'const commandWasExisting',
    )).not.toContain('resolveSubstitutionFundingAuthorityTx(tx');
    expect(decision.indexOf('if (commandWasExisting) return completeReceiptResponse(command)'))
      .toBeLessThan(
        decision.indexOf('const authority = await resolveSubstitutionFundingAuthorityTx'),
      );
    const patientFamily = sliceBetween(
      service,
      'async function resolveSubstitutionFundingPatientFamilyTx',
      'async function resolveLiveFundingCapacityTx',
    );
    expect(patientFamily).toContain('resolveMergedPatientUidSet(tx');
    expect(patientFamily).toContain('FOR KEY SHARE');
    expect(patientFamily).toContain('NOT (uid=ANY($2::uuid[]))');
    const capacity = sliceBetween(
      service,
      'async function resolveLiveFundingCapacityTx',
      'async function resolveSubstitutionFundingPatientPreflightTx',
    );
    expect(capacity).not.toContain('resolveMergedPatientUidSet');
    expect(capacity).not.toContain('FROM users');
  });

  it('uses the exact same canonical funding advisory in runtime and migration', () => {
    const runtimeFundingLock = sliceBetween(
      pharmacyCap,
      'export async function lockPharmacyFundingAuthorityTx',
      'function substitutionFundingMetadata',
    );
    expect(runtimeFundingLock).toContain("'vh:pharmacy_funding_authority:'");
    expect(runtimeFundingLock).toContain('753');
    expect(migration).toContain("'vh:pharmacy_funding_authority:'");
    expect(migration).toContain('753');
    expect(migration).not.toContain("'vhhealth:funding-patient:'");
  });

  it('fails closed after any invoice issuance, payment, refund or advance settlement', () => {
    const authority = sliceBetween(
      service,
      'async function resolveSubstitutionFundingAuthorityTx',
      'function proposalResponse',
    );
    expect(service).toContain('invoice.status AS invoice_status');
    expect(service).toContain("invoiceAuthority.invoice_status !== 'DRAFT'");
    expect(service).toContain('invoiceAuthority.invoice_number != null');
    expect(service).toContain('invoiceAuthority.invoice_issued_at != null');
    expect(service).toContain('invoiceAuthority.invoice_voided_at != null');
    expect(service).toContain("billing.base.invoice.amount_paid !== '0.00'");
    expect(service).toContain("billing.base.invoice.credit_note_amount !== '0.00'");
    expect(service).toContain('FROM billing_payments');
    expect(service).toContain('FROM billing_refunds');
    expect(service).toContain('FROM billing_advance_settlements');
    expect(service).toContain('SUBSTITUTION_FUNDING_INVOICE_FINANCE_LIFECYCLE_STARTED');
    expect(service).toContain('SUBSTITUTION_FUNDING_INVOICE_NOT_DRAFT');
    expect(service).toContain('complete_governed_credit_rebill_or_refund_before_substitution');
    expect(authority.indexOf('FROM billing_invoices invoice')).toBeLessThan(
      authority.indexOf('FROM billing_invoice_items item'),
    );
    expect(authority.indexOf('FROM billing_invoice_items item')).toBeLessThan(
      authority.indexOf('FROM admissions admission'),
    );
    expect(authority.indexOf('FROM admissions admission')).toBeLessThan(
      authority.indexOf('FROM billing_payments'),
    );
  });

  it('keeps every substitution funding route inert until lifecycle closure is wired', () => {
    expect(app).not.toContain('substitutionFundingRoutes');
    expect(app).not.toContain('/substitution-funding');
    expect(routes).toContain('/substitution-funding/proposals');
    expect(routes).toContain('durableDomainReceipt: true');
    expect(routes).toContain('retainOnServerError: true');
    expect(routes).toContain('revalidateCompletedReplay: true');
    expect(service).toContain('SUBSTITUTION_FUNDING_ORDER_MUTATION_UNWIRED');
  });
});
