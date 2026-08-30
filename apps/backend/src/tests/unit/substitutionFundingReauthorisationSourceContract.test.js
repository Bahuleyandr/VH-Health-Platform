import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '../..');
const read = (relativePath) => fs.readFileSync(path.join(sourceRoot, relativePath), 'utf8');

const service = read('services/pharmacy/substitutionFundingReauthorisationService.js');
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
    expect(service).toContain('substitutionFundingMaterializationKey');
    expect(service).toContain('proposalRequestSha256');
    expect(proposal).toContain('WHERE tenant_id=$1::uuid AND materialization_key=$2');
    expect(proposal).toContain('const lockedSnapshot = assertProposalReplay');
    expect(proposal.indexOf('locked.approval.is_expired')).toBeLessThan(
      proposal.indexOf('const replayAuthority = await resolveSubstitutionFundingAuthorityTx'),
    );
    expect(service).toContain('SUBSTITUTION_FUNDING_PROPOSAL_MISMATCH');
    expect(proposal).toContain('vh:substitution-funding:materialization:');
  });

  it('creates a standalone specialized approval and one schema-valid reciprocal task', () => {
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
    expect(approvalInsert).not.toContain('task_id');
    expect(proposal).toContain('SECURITY_CONFIG.controlledDispenseWitness.approvalTtlMinutes');
    expect(proposal).toContain("stage: SUBSTITUTION_FUNDING_TASK_STAGE");
    expect(service).toContain("taskResourceType: 'pharmacy_tpa_line_decision'");
    expect(service).toContain("taskResourceType: 'pharmacy_posted_payment'");
    expect(service).toContain("permittedRoles: Object.freeze(['FINANCE_INCHARGE'])");
    expect(proposal).toContain('JSON.stringify({ approval_id: Number(approval.id) })');
    expect(proposal).toContain('task_id: Number(task.id)');
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

  it('creates an approver-owned immutable receipt with exact task and invoice bindings', () => {
    const decision = sliceBetween(
      service,
      'export async function approveSubstitutionFundingProposal',
      'function assertExpectedProposal',
    );
    expect(decision).toContain("'SUBSTITUTION_FUNDING_APPROVAL'");
    expect(decision).toContain('Number(task.id)');
    expect(decision).toContain('Number(metadata.invoice_item_id)');
    expect(decision).toContain('approver.uid');
    expect(decision).toContain("SET status='COMPLETE',response_body=$3::jsonb,completed_at=NOW()");
    expect(decision).toContain('expires_at:');
    expect(decision).toContain('proposer: authority.proposer');
    expect(decision).toContain('approver_uid: approver.uid');
    expect(decision).toContain('invoice_item_id: authority.invoice_item_id');
    expect(decision).toContain('base: authority.base');
    expect(decision).toContain('prospective: authority.prospective');
    expect(decision).toContain('funding: authority.funding');
    expect(decision.indexOf('approvedSubstitutionFundingReceiptContract(response)')).toBeLessThan(
      decision.indexOf("SET status='COMPLETE',response_body=$3::jsonb,completed_at=NOW()"),
    );
    expect(service).toContain('prospective_fingerprint: sha256(prospectiveTuple)');

    expect(migration).toContain('task_id               INTEGER NOT NULL');
    expect(migration).toContain('invoice_item_id       INTEGER NOT NULL');
    expect(migration).toContain(
      "task_resource_type IN ('pharmacy_tpa_line_decision','pharmacy_posted_payment')",
    );
    expect(migration).toContain('REFERENCES tasks (tenant_id, id, related_resource_type, related_resource_id)');
    expect(migration).toContain('pharmacy funding command receipts cannot be deleted');
    expect(migration).toContain('pharmacy funding command identity and completed response are immutable');
  });

  it('rechecks expiry, exact tuples and current funding capacity in the caller transaction', () => {
    const consumer = sliceBetween(
      service,
      'export async function consumeApprovedSubstitutionFundingReauthorisationTx',
      'export function substitutionFundingReauthorisationEvidenceSnapshot',
    );
    expect(service).toContain('(expires_at IS NOT NULL AND expires_at<=NOW()) AS is_expired');
    expect(consumer).toContain('resolveSubstitutionFundingAuthorityTx(tx');
    expect(consumer).toContain('stableJson(authority.base)');
    expect(consumer).toContain('stableJson(authority.prospective)');
    expect(consumer).toContain('stableJson(authority.funding)');
    expect(consumer).toContain('assertExpectedProposal(expectedProposal');
    expect(consumer).toContain('reserveSubstitutionFundingPatientCapacityTx(tx');
    expect(consumer).toContain('SUBSTITUTION_FUNDING_AUTHORITY_DRIFT');
    expect(service).toContain('new WeakSet()');
    expect(service).toContain('new WeakMap()');
    expect(service).toContain('APPROVED_SUBSTITUTION_FUNDING_EVIDENCE.add(evidence)');
    expect(service).not.toContain('SUBSTITUTION_FUNDING_EVIDENCE = Symbol');
  });

  it('keeps proposal and approval phases read-only for clinical, stock and funding movement', () => {
    const phases = sliceBetween(
      service,
      'export async function createSubstitutionFundingProposal',
      'function assertExpectedProposal',
    );
    const forbiddenMutation = new RegExp(
      String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+` +
      String.raw`(?:pharmacy_orders|e_prescriptions|pharmacy_inventory_(?:items|batches|movements)|` +
      String.raw`billing_(?:invoices|invoice_items|payments)|pharmacy_payment_allocations|` +
      String.raw`tpa_claim_line_decisions|pharmacy_funding_decision_events)\b`,
      'i',
    );
    expect(phases).not.toMatch(forbiddenMutation);
  });

  it('atomically transfers base allocations and TPA authority only in the consumer phase', () => {
    const transfer = sliceBetween(
      service,
      'async function reserveSubstitutionFundingPatientCapacityTx',
      '// The caller must resolve durable final-command replay',
    );
    expect(transfer).toContain('INSERT INTO pharmacy_payment_allocation_reversals');
    expect(transfer).toContain('INSERT INTO pharmacy_payment_allocations');
    expect(transfer).toContain('UPDATE tpa_claim_line_decisions');
    expect(transfer).toContain('plan.patientAmountRequiredScaled');
    expect(transfer).toContain('liveBaseScaled !== 0n');
    expect(transfer).toContain('liveProspectiveScaled !== plan.patientAmountRequiredScaled');
    expect(transfer).toContain('SUBSTITUTION_FUNDING_CONSUMPTION_ALREADY_RECORDED');
    expect(transfer).not.toMatch(/(?:UPDATE|DELETE\s+FROM)\s+pharmacy_orders/i);
    expect(transfer).not.toMatch(/(?:UPDATE|DELETE\s+FROM)\s+pharmacy_inventory_/i);
  });

  it('uses exact scaled arithmetic and conservative source-specific capacity', () => {
    expect(service).toContain('multiplier: 10_000n');
    expect(service).toContain('maxScaled: 99_999_999_999_999n');
    expect(service).toContain('maxScaled: 999_999_999_999n');
    expect(service).toContain('maxScaled: 9_999_999_999n');
    expect(service).toContain('discarded >= 5_000n ? 1n : 0n');
    expect(service).not.toContain('.toFixed(');
    expect(service).not.toContain('Math.');
    expect(service).toContain("'CASH'");
    expect(service).toContain("'NETBANKING'");
    expect(service).toContain("UPPER(refund.approval_status)<>'REJECTED'");
    expect(service).toContain('insurance_or_tpa_payment_not_additive');
    expect(service).toContain('patientNetScaled - otherAllocatedScaled');
    expect(service).toContain('tpaUsedScaled + availableForOrderScaled');
    expect(service).toContain("? patientAmountRequiredScaled > 0n ? 'mixed' : 'tpa_claim'");
    expect(service).not.toContain('INSURANCE/TPA payments are additive');
  });

  it('locks funding and order advisories before approval/task rows and source rows', () => {
    const fundingLock = service.indexOf('lockPharmacyFundingAuthorityTx(tx');
    const orderAdvisory = service.indexOf('vh:substitution-funding:order:');
    expect(fundingLock).toBeGreaterThanOrEqual(0);
    expect(orderAdvisory).toBeGreaterThan(fundingLock);

    for (const [startMarker, endMarker] of [
      [
        'export async function approveSubstitutionFundingProposal',
        'function assertExpectedProposal',
      ],
      [
        'export async function consumeApprovedSubstitutionFundingReauthorisationTx',
        'export function substitutionFundingReauthorisationEvidenceSnapshot',
      ],
    ]) {
      const phase = sliceBetween(service, startMarker, endMarker);
      expect(phase.indexOf('lockSubstitutionFundingPatientAuthorityTx(tx')).toBeLessThan(
        phase.indexOf('vh:substitution-funding:approval:'),
      );
      expect(phase.indexOf('vh:substitution-funding:approval:')).toBeLessThan(
        phase.indexOf('lockSubstitutionFundingApprovalTaskTx(tx'),
      );
      expect(phase.indexOf('lockSubstitutionFundingApprovalTaskTx(tx')).toBeLessThan(
        phase.indexOf('resolveSubstitutionFundingAuthorityTx(tx'),
      );
    }
  });

  it('fails closed when the exact bound invoice is no longer draft', () => {
    expect(service).toContain('invoice.status AS invoice_status');
    expect(service).toContain("invoiceAuthority.invoice_status !== 'DRAFT'");
    expect(service).toContain('SUBSTITUTION_FUNDING_INVOICE_NOT_DRAFT');
    expect(service).toContain('complete_governed_credit_rebill_or_refund_before_substitution');
  });

  it('mounts canonical and compatibility routes before the broad pharmacy routers', () => {
    for (const mount of [
      '/api/v1/pharmacy-orders/orders/:orderId/substitution-funding/proposals/:approvalId/approve',
      '/api/v1/pharmacy/orders/:orderId/substitution-funding/proposals/:approvalId/approve',
      '/api/v1/pharmacy-orders/orders/:orderId/substitution-funding/proposals',
      '/api/v1/pharmacy/orders/:orderId/substitution-funding/proposals',
    ]) {
      expect(app).toContain(`'${mount}'`);
    }
    expect(app.indexOf('/substitution-funding/proposals')).toBeLessThan(
      app.indexOf("app.use('/api/v1/pharmacy', patientRateLimiter"),
    );
    expect(routes).toContain('durableDomainReceipt: true');
    expect(routes).toContain('retainOnServerError: true');
    expect(routes).toContain('revalidateCompletedReplay: true');
  });
});
