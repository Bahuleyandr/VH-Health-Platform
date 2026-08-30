import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, '../..');
const billing = fs.readFileSync(
  path.join(sourceRoot, 'services/billing/billingV2Service.js'),
  'utf8',
);
const gateway = fs.readFileSync(
  path.join(sourceRoot, 'services/billing/paymentGatewayService.js'),
  'utf8',
);

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function expectOrdered(source, markers) {
  let previous = -1;
  for (const marker of markers) {
    const current = source.indexOf(marker);
    expect(current).toBeGreaterThan(previous);
    previous = current;
  }
}

describe('billing patient-funding lock source contract', () => {
  it('resolves inactive historical billing identity through one guarded tenant chain', () => {
    const resolver = sliceBetween(
      billing,
      'async function resolveBillingFundingPatientIdentityTx',
      'async function lockBillingPatientFundingAfterMergeTx',
    );

    expect(resolver).toContain('WITH RECURSIVE patient_chain');
    expect(resolver).toContain('successor.tenant_id = $1::uuid');
    expect(resolver).toContain("successor.role = 'PATIENT'");
    expect(resolver).toContain('chain.path || successor.uid');
    expect(resolver).toContain('successor.uid = ANY(chain.path) AS cycle');
    expect(resolver).toContain('chain.depth < $3::int');
    expect(resolver).toContain('terminalRows.length !== 1');
    expect(resolver).toContain('storedPatientUid: String(rows[0].uid)');
    expect(resolver).toContain('fundingPatientUid: String(terminal.uid)');
    expect(resolver).not.toContain('is_active');
    expect(resolver).not.toContain('is_deleted');
    expect(resolver).not.toContain("status = 'active'");
  });

  it('uses the terminal historical UID only for the patient funding advisory', () => {
    const helper = sliceBetween(
      billing,
      'async function lockBillingPatientFundingAfterMergeTx',
      'export async function lockBillingRefundFundingAuthorityTx',
    );
    expectOrdered(helper, [
      'resolveBillingFundingPatientIdentityTx(tx',
      'lockPharmacyFundingAuthorityTx(tx',
    ]);
    expect(helper).toContain('patientUid: identity.fundingPatientUid');
    expect(helper).not.toContain('lockTenantPatientMergeStability(tx');
    expect(helper).not.toContain('resolvePharmacyFundingPatientUidTx');
  });

  it('locks merge, refund funding, exact parent, then exact stored refund', () => {
    const helper = sliceBetween(
      billing,
      'export async function lockBillingRefundFundingAuthorityTx',
      'async function assertPatientInTenant',
    );
    const funding = helper.indexOf('lockBillingPatientFundingAfterMergeTx(tx');
    const invoice = helper.indexOf('parent = await lockBillingInvoice(');
    const advance = helper.indexOf('parent = await lockBillingAdvance(');
    const refundLock = helper.indexOf('SELECT ${REFUND_PUBLIC_COLUMNS}');

    expectOrdered(helper, [
      'if (!mergeStabilityHeld) await lockTenantPatientMergeStability(tx',
      'FROM billing_refunds',
      'lockBillingPatientFundingAfterMergeTx(tx',
    ]);
    expect(invoice).toBeGreaterThan(funding);
    expect(advance).toBeGreaterThan(funding);
    expect(refundLock).toBeGreaterThan(invoice);
    expect(refundLock).toBeGreaterThan(advance);
    expect(helper).toContain('String(candidate.patient_uid),');
    expect(helper).toContain('storedPatientUid: String(candidate.patient_uid)');
    expect(helper).toContain('fundingPatientUid: identity.fundingPatientUid');
  });

  it('takes shared merge stability before payment discovery and money row locks', () => {
    const collection = sliceBetween(
      billing,
      'async function collectPaymentTx',
      'export async function collectPayment',
    );
    expectOrdered(collection, [
      'if (!mergeStabilityHeld) await lockTenantPatientMergeStability(tx',
      'findBillingInvoice(',
      'lockBillingPatientFundingAfterMergeTx(tx',
      'lockBillingInvoice(',
      'INSERT INTO billing_payments',
    ]);
    expect(collection).toContain('resolvePharmacyFundingPatientUidTx(tx');
    expect(collection).toContain('lockPharmacyFundingAuthorityTx(tx');

    const reversal = sliceBetween(
      billing,
      'export async function reversePayment',
      'export async function collectAdvance',
    );
    expectOrdered(reversal, [
      'lockTenantPatientMergeStability(tx',
      'FROM billing_payments payment',
      'lockBillingPatientFundingAfterMergeTx(tx',
      'lockPaymentFundingEventAdvisoriesTx(tx',
      'const fundedOrderRows',
      'lockBillingInvoice(',
      'FOR UPDATE OF payment',
      'FOR UPDATE OF allocation',
      'calculateInvoiceRefundHeadroomTx(',
      'UPDATE billing_payments',
    ]);
    expect(reversal).toContain('BILLING_PAYMENT_REVERSAL_FUNDING_COMMITMENT_CONFLICT');
  });

  it('settles predecessor advance to survivor invoice under one terminal funding UID', () => {
    const collection = sliceBetween(
      billing,
      'export async function collectAdvance',
      'export async function listAdvances',
    );
    expectOrdered(collection, [
      'lockTenantPatientMergeStability(tx',
      'resolvePharmacyFundingPatientUidTx(tx',
      'lockPharmacyFundingAuthorityTx(tx',
      'insertAdvance(tx)',
    ]);

    const settlement = sliceBetween(
      billing,
      'export async function settleAdvance',
      'async function calculateNetBillingFundingCapacityTx',
    );
    expectOrdered(settlement, [
      'lockTenantPatientMergeStability(tx',
      'FROM billing_advances',
      'FROM billing_invoices',
      'const advanceIdentity = await resolveBillingFundingPatientIdentityTx',
      'const invoiceIdentity = await resolveBillingFundingPatientIdentityTx',
      'invoiceIdentity.fundingPatientUid !== advanceIdentity.fundingPatientUid',
      'lockPharmacyFundingAuthorityTx(tx',
      'lockBillingInvoice(',
      'lockBillingAdvance(tx',
      'calculateAdvanceFundingHeadroomTx(tx',
      'INSERT INTO billing_advance_settlements',
    ]);
    expect(settlement).toContain('invoiceIdentity.storedPatientUid');
    expect(settlement).toContain('advanceIdentity.storedPatientUid');
    expect(settlement).toContain('BILLING_ADVANCE_INVOICE_NOT_SETTLEABLE');
  });

  it('calculates one residual capacity across refunds and both allocation rails', () => {
    const capacity = sliceBetween(
      billing,
      'async function calculateNetBillingFundingCapacityTx',
      'async function loadAppliedCreditNoteForRefundTx',
    );
    expect(capacity).toContain("refund.approval_status<>'REJECTED'");
    expect(capacity).toContain('FROM pharmacy_payment_allocations allocation');
    expect(capacity).toContain('FROM pharmacy_payment_allocation_reversals');
    expect(capacity).toContain('FROM pharmacy_advance_allocations allocation');
    expect(capacity).toContain('FROM pharmacy_advance_allocation_reversals');
    expect(capacity).toContain('advance.balance::numeric AS current_balance');
    expect(capacity).toContain(
      'Math.min(currentBalance, sourceAmount - settlements - activeRefunds)',
    );
    expect(capacity).toContain('nonPharmacyAvailable - pharmacyAllocations');
  });

  it('keeps refund creation on exact parent UID and reserves residual capacity', () => {
    const raise = sliceBetween(
      billing,
      'export async function raiseRefund',
      'export async function approveRefund',
    );
    expectOrdered(raise, [
      'lockTenantPatientMergeStability(tx',
      'findBillingInvoice(',
      'lockBillingPatientFundingAfterMergeTx(tx',
      'lockBillingInvoice(',
      'calculateInvoiceRefundHeadroomTx(tx',
    ]);
    expect(raise).toContain('resolvedPatientUid = String(invoiceCandidate.patient_uid)');
    expect(raise).toContain('resolvedPatientUid = String(advanceCandidates[0].patient_uid)');
    expect(raise.match(/assertBillingFundingPatientMatchTx\(tx/g)).toHaveLength(2);
    expect(raise).toContain('expectedIdempotencyBody = null');
    expect(raise).toContain('idempotencyPath = REFUND_RAISE_IDEMPOTENCY_PATH');
    expect(raise).toContain('expectedIdempotencyBody ?? refundRaiseIdempotencyBody({');
    expect(raise).toContain('path: String(idempotencyPath || REFUND_RAISE_IDEMPOTENCY_PATH)');
    expect(raise).toContain('calculateAdvanceFundingHeadroomTx(tx, advance_id)');
    expect(raise).toContain('active_pharmacy_allocations');
    expectOrdered(raise, [
      'const advance = await lockBillingAdvance(',
      'await validateParentSourceTx({',
      'calculateAdvanceFundingHeadroomTx(tx, advance_id)',
      'INSERT INTO billing_refunds',
    ]);
    expect(raise.match(/await validateParentSourceTx\(\{/g)).toHaveLength(1);
    expect(raise.indexOf('calculateAdvanceFundingHeadroomTx(tx, advance_id)'))
      .toBeLessThan(raise.indexOf('INSERT INTO billing_refunds'));
  });

  it('caps posted-payment allocation by the same refund-aware residual capacity', () => {
    const allocator = sliceBetween(
      billing,
      'async function allocatePostedPharmacyPaymentsTx',
      'async function claimPharmacyFundingCommandTx',
    );
    expectOrdered(allocator, [
      'FROM billing_payments payment',
      'FROM pharmacy_payment_allocations allocation',
      'calculateInvoiceRefundHeadroomTx(tx, invoiceId)',
      'Math.min(remaining, available, uncommittedInvoiceFunding)',
      'INSERT INTO pharmacy_payment_allocations',
    ]);
    expect(allocator).toContain('uncommittedInvoiceFunding - amount');
    expect(allocator).toContain('UPPER(payment.mode)=ANY($5::text[])');
    expect(allocator).toContain('PHARMACY_PATIENT_PAYMENT_RAILS');
  });

  it('leaves funding-command lifecycle columns under the database ACL contract', () => {
    const claim = sliceBetween(
      billing,
      'async function claimPharmacyFundingCommandTx',
      'async function completePharmacyFundingCommandTx',
    );
    expect(claim).toContain('request_sha256,created_by)');
    expect(claim).not.toContain('request_sha256,status,created_by)');
    expect(claim).not.toContain("'IN_PROGRESS',$11::uuid");

    const completion = sliceBetween(
      billing,
      'async function completePharmacyFundingCommandTx',
      'export async function materializePharmacyFundingTaskTx',
    );
    expect(completion).toContain("SET status='COMPLETE',response_body=$3::jsonb");
    expect(completion).not.toContain('completed_at=NOW()');
    expect(completion).toContain('RETURNING *');
  });

  it('keeps historical payment identity distinct from active order identity on reversal', () => {
    const outer = sliceBetween(
      billing,
      'export async function reversePayment',
      'export async function collectAdvance',
    );
    expect(outer).toContain(
      'storedPaymentPatientUid: String(paymentRows[0].patient_uid)',
    );
    expect(outer).toContain(
      'fundingPaymentPatientUid: paymentFundingIdentity.fundingPatientUid',
    );

    const reversal = sliceBetween(
      billing,
      'export async function reversePharmacyPaymentAllocationTx',
      'async function lockPharmacyStockMovementEvidenceTx',
    );
    expectOrdered(reversal, [
      'resolvePharmacyFundingPatientUidTx(tx',
      'lockPharmacyFundingAuthorityTx(tx',
      'exactFundingPaymentPatientUid !== patientUid',
      'payment.patient_uid=$9::uuid',
    ]);
    expect(reversal).toContain('String(orderItemsSha256), exactPaymentPatientUid');
    expect(reversal).not.toContain('resolveBillingFundingPatientIdentityTx(tx');
  });

  it('routes approval, rejection, and payout through the exported authority helper', () => {
    for (const [start, end] of [
      ['export async function approveRefund', 'export async function rejectRefund'],
      ['export async function rejectRefund', 'function normalizeRefundPayoutReference'],
      ['async function settleRefundPaid', 'export async function markRefundPaid'],
    ]) {
      const mutation = sliceBetween(billing, start, end);
      expect(mutation).toContain('lockBillingRefundFundingAuthorityTx(tx');
    }
    expect(billing).not.toContain('lockCanonicalPatientFundingTx');
    expect(billing).not.toContain('lockRefundFundingMutationTx');
  });

  it('uses merge then branch evidence then funding across every refund rail', () => {
    const offline = sliceBetween(
      billing,
      'async function discoverOfflineElectronicRefundSourceBeforeFundingTx',
      'async function settleRefundPaid',
    );
    expectOrdered(offline, [
      'FROM billing_payments',
      'FROM payment_gateway_orders',
      'FOR UPDATE',
      'async function lockOfflineElectronicPaymentAfterFundingTx',
      'FROM billing_payments',
      'FOR UPDATE',
      'async function lockOfflineElectronicAdvanceSourceTx',
      'FROM advance_deposits',
      'FOR UPDATE',
    ]);
    expect(offline).toContain('LIMIT 2`');
    expect(offline).toContain('advance.ipd_advance_deposit_id == null');
    expect(offline).toContain('deposit.payment_reference');
    expect(offline).not.toContain("advance.reference LIKE 'IPD/%'");

    const payout = sliceBetween(
      billing,
      'async function settleRefundPaid',
      'export async function markRefundPaid',
    );
    expectOrdered(payout, [
      'lockTenantPatientMergeStability(tx',
      "payoutRail === 'offline_electronic'",
      'discoverOfflineElectronicRefundSourceBeforeFundingTx(tx',
      "payoutRail === 'gateway'",
      'FROM payment_gateway_refunds',
      'lockBillingRefundFundingAuthorityTx(tx',
      'lockOfflineElectronicPaymentAfterFundingTx(tx',
      'lockOfflineElectronicAdvanceSourceTx(tx',
    ]);
    expect(payout).toContain('mergeStabilityHeld: true');
    expect(payout.indexOf('discoverOfflineElectronicRefundSourceBeforeFundingTx(tx'))
      .toBeLessThan(payout.indexOf('lockBillingRefundFundingAuthorityTx(tx'));
    expect(payout.indexOf('lockBillingRefundFundingAuthorityTx(tx'))
      .toBeLessThan(payout.indexOf('lockOfflineElectronicPaymentAfterFundingTx(tx'));

    const gatewayHelper = sliceBetween(
      gateway,
      'async function lockGatewayRefundAuthorityTx',
      'function exactProcessedAuthority',
    );
    expectOrdered(gatewayHelper, [
      'lockTenantPatientMergeStability(tx',
      'FROM payment_gateway_refunds',
      'lockBillingRefundFundingAuthorityTx(tx',
    ]);
    expect(gatewayHelper).toContain('mergeStabilityHeld: true');
    expect(gatewayHelper).not.toContain('FROM billing_refunds');
  });

  it('keeps gateway capture and initiation on merge-before-evidence ordering', () => {
    const capture = sliceBetween(
      gateway,
      'export async function handleCaptureEvent',
      'async function handlePaymentFailedEvent',
    );
    expectOrdered(capture, [
      'lockTenantPatientMergeStability(tx',
      'FROM payment_gateway_orders',
      'FOR UPDATE',
      'collectPayment({',
      'mergeStabilityHeld: true',
    ]);

    const initiation = sliceBetween(
      gateway,
      'export async function initiateGatewayRefund',
      'if (!intent.callProvider)',
    );
    const discovery = initiation.indexOf('FROM billing_refunds');
    const secondDirectRefundRead = initiation.indexOf('FROM billing_refunds', discovery + 1);
    expect(discovery).toBeGreaterThanOrEqual(0);
    expect(secondDirectRefundRead).toBe(-1);
    expectOrdered(initiation, [
      'lockTenantPatientMergeStability(tx',
      'FROM billing_refunds',
      'const orderRows',
      'FOR UPDATE OF o',
      'vh:payment_gateway_refund_creation:',
      'const serializedExistingRows',
      'lockGatewayRefundAuthorityTx(tx',
      'lockBillingRefundFundingAuthorityTx(tx',
    ]);
    expect(initiation).toContain('mergeStabilityHeld: true');
    const gatewayAuthority = initiation.indexOf('lockGatewayRefundAuthorityTx(tx');
    const directAuthority = initiation.indexOf('lockBillingRefundFundingAuthorityTx(tx');
    const paymentLock = initiation.indexOf('const paymentRows');
    const intentInsert = initiation.indexOf('INSERT INTO payment_gateway_refunds');
    expect(paymentLock).toBeGreaterThan(gatewayAuthority);
    expect(paymentLock).toBeGreaterThan(directAuthority);
    expect(intentInsert).toBeGreaterThan(paymentLock);
    expect(initiation).toContain('FROM billing_payments');
    expect(initiation).toContain('tenant_id = $1::uuid AND id = $2::int');
    expect(initiation).toContain('invoice_id = $3::int AND patient_uid = $4::uuid');
    expect(initiation).toContain('UPPER(mode) = UPPER($5) AND reversed = FALSE');
    expectOrdered(initiation.slice(paymentLock), [
      'FROM billing_payments',
      'FOR UPDATE',
      'const payment = paymentRows[0]',
      'INSERT INTO payment_gateway_refunds',
    ]);
    expect(initiation).not.toContain('payment_invoice_id');
    expect(initiation).not.toContain('payment_patient_uid');
    expect(initiation).not.toContain('payment_mode');

    const reversal = sliceBetween(
      billing,
      'export async function reversePayment',
      'export async function collectAdvance',
    );
    expectOrdered(reversal, [
      'lockBillingPatientFundingAfterMergeTx(tx',
      'lockPaymentFundingEventAdvisoriesTx(tx',
      'FOR UPDATE OF payment',
      'UPDATE billing_payments',
    ]);
  });
});
