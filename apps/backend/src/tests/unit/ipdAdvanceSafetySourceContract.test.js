import { readFileSync } from 'node:fs';

const service = readFileSync(
  new URL('../../services/ipd/ipdSupportService.js', import.meta.url),
  'utf8',
);
const routes = readFileSync(
  new URL('../../routes/ipd/ipdSupportRoutes.js', import.meta.url),
  'utf8',
);
const app = readFileSync(new URL('../../app.js', import.meta.url), 'utf8');
const { IPD_SUPPORT_ROUTE_ROLES } = await import('../../config/routeRolePolicy.js');

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('IPD advance safety source contract', () => {
  it('uses a canonical IPD command body and path for the refund idempotency claim', () => {
    const normalize = functionSource(
      service,
      'normalizeIpdAdvanceRefundRequest',
      'tenantOr',
    );
    expect(normalize).toContain("action: 'raise_ipd_advance_refund'");
    expect(normalize).toContain('parent_deposit_id: String(normalizedParentDepositId)');
    expect(normalize).toContain('amount: normalizedAmount.amount');
    expect(normalize).toContain('reason');
    expect(normalize).toContain('mode');
    expect(normalize).toContain('/api/v1/ipd/advance-deposits/${normalizedParentDepositId}/refund');

    const routeStart = routes.indexOf("'/advance-deposits/:depositId/refund'");
    const routeEnd = routes.indexOf('// ── Attendant passes', routeStart);
    const refundRoute = routes.slice(routeStart, routeEnd);
    expect(refundRoute.indexOf('prepareIpdAdvanceRefundRequest'))
      .toBeLessThan(refundRoute.indexOf('ipdMoneyIdempotency'));
    expect(refundRoute).toContain('(req) => req.ipdAdvanceRefundCommand.idempotencyPath');
    expect(refundRoute).toContain('(req) => req.ipdAdvanceRefundCommand.idempotencyBody');
    expect(refundRoute).toContain('requestFingerprint: req.idempotencyClaim?.requestBodyHash');
    expect(refundRoute).toContain('success(res, refund);');
    expect(refundRoute).not.toContain('HTTP_STATUS.CREATED');

    const collectStart = routes.indexOf("'/admissions/:id/advance-deposits'");
    const collectEnd = routes.indexOf('router.get(', collectStart);
    expect(collectStart).toBeGreaterThanOrEqual(0);
    expect(collectEnd).toBeGreaterThan(collectStart);
    const collectRoute = routes.slice(collectStart, collectEnd);
    expect(collectRoute.indexOf('prepareIpdAdvanceCollection'))
      .toBeLessThan(collectRoute.indexOf('ipdMoneyIdempotency'));
    expect(collectRoute).toContain(
      '(req) => req.ipdAdvanceCollectionCommand.idempotencyPath',
    );
    expect(collectRoute).toContain(
      'admissionId: req.ipdAdvanceCollectionCommand.admissionId',
    );
  });

  it('keeps the IPD alias inside the existing outer-mount authority', () => {
    const rolesStart = routes.indexOf('const DEPOSIT_REFUND_REQUEST_ROLES');
    const rolesEnd = routes.indexOf('// Attendant passes', rolesStart);
    const refundRoles = routes.slice(rolesStart, rolesEnd);
    expect(refundRoles).toContain("'BILLING_STAFF'");
    expect(refundRoles).not.toContain("'CASHIER'");
    expect(IPD_SUPPORT_ROUTE_ROLES).not.toContain('CASHIER');
    expect(app).toMatch(
      /app\.use\(\s*'\/api\/v1\/ipd',\s*requireRole\(\.\.\.IPD_SUPPORT_ROUTE_ROLES\)/,
    );
  });

  it('locks merge stability, canonical funding, then the admission for collection', () => {
    const lockSource = functionSource(
      service,
      'lockCanonicalIpdFundingAdmissionTx',
      'storedMoneyPaise',
    );
    const merge = lockSource.indexOf('lockTenantPatientMergeStability');
    const canonical = lockSource.indexOf('resolvePharmacyFundingPatientUidTx');
    const funding = lockSource.indexOf('lockPharmacyFundingAuthorityTx');
    const admission = lockSource.indexOf('FROM admissions');
    expect(merge).toBeGreaterThanOrEqual(0);
    expect(canonical).toBeGreaterThan(merge);
    expect(funding).toBeGreaterThan(canonical);
    expect(admission).toBeGreaterThan(funding);
    expect(lockSource).toMatch(/billing_closed_at[\s\S]*FOR UPDATE/);
    expect(lockSource).toContain('IPD_ADVANCE_BILLING_CLOSED');
  });

  it('creates one immutable source-bound mirror using the DB source timestamp', () => {
    const collect = service.slice(
      service.indexOf('export async function collectAdvanceDeposit'),
      service.indexOf('export async function refundAdvanceDeposit'),
    );
    expect(collect).toContain("paymentMethod === 'corporate_tpa'");
    expect(collect).toContain('deferred deposits must carry an exact zero amount');
    expect(collect).toContain('ipd_advance_deposit_id');
    expect(collect).toContain('ipd_advance_deposit_payment_method');
    expect(collect).toContain('ipd_advance_deposit_collected_at');
    expect(collect).toMatch(/INSERT INTO billing_advances[\s\S]*SELECT source\.patient_uid/);
    expect(collect).toMatch(/source\.collected_at, source\.id, source\.payment_method,[\s\S]*source\.collected_at/);
    expect(collect).not.toContain('deposit.collected_at');
    expect(collect).toContain('lockExactIpdAdvanceMirrorTx(tx');
    expect(collect).toMatch(/postAdvanceCollectEntry\([\s\S]*deriveAdvanceBalanceFromLedgerTx/);

    const mirrorLock = functionSource(
      service,
      'lockExactIpdAdvanceMirrorTx',
      'assertRefundableIpdDepositSource',
    );
    expect(mirrorLock).toContain('mirror.ipd_advance_deposit_id = $2::int');
    expect(mirrorLock).toContain('source.id = mirror.ipd_advance_deposit_id');
    expect(mirrorLock).toContain('FOR UPDATE OF mirror, source');
  });

  it('allows only CASH/CHEQUE requests and never accepts payout evidence', () => {
    expect(service).toMatch(/IPD_REFUND_MODE_BY_INPUT[\s\S]*\['cash', 'CASH'\][\s\S]*\['cheque', 'CHEQUE'\]/);
    expect(service).toMatch(/IPD_REFUND_RECONCILIATION_MODES[\s\S]*'card'[\s\S]*'upi'[\s\S]*'online'[\s\S]*'bank_transfer'/);
    const normalize = functionSource(
      service,
      'normalizeIpdAdvanceRefundRequest',
      'tenantOr',
    );
    expect(normalize).toContain('IPD_ADVANCE_REFUND_MODE_RECONCILIATION_REQUIRED');
    expect(normalize).toContain('IPD_ADVANCE_REFUND_NON_PAYOUT_MODE');
    expect(normalize).toContain('IPD_ADVANCE_REFUND_PAYOUT_REFERENCE_FORBIDDEN');
    expect(normalize).not.toContain('payment_reference:');
  });

  it('raises a governed PENDING refund and leaves all payout mutations to billing', () => {
    const refund = service.slice(
      service.indexOf('export async function refundAdvanceDeposit'),
      service.indexOf('export async function getAdmissionDepositBalance'),
    );
    expect(refund).toContain('raiseBillingRefund({');
    expect(refund).toContain('expectedIdempotencyBody: command.idempotencyBody');
    expect(refund).toContain('idempotencyPath: command.idempotencyPath');
    expect(refund).toContain('validateParentSourceTx:');
    expect(refund).not.toContain('setTenantTx(');
    expect(refund).not.toContain('advance_deposits.create');
    expect(refund).not.toContain('postAdvanceRefundEntry');
    expect(refund).not.toContain('UPDATE billing_advances');

    const callback = functionSource(
      service,
      'validateIpdAdvanceRefundParentSourceTx',
      'defaultAttendantPassExpiry',
    );
    expect(callback).toContain('FOR UPDATE OF source, admission');
    expect(callback).toContain('admission.billing_closed_at');
    expect(callback).toContain('source_collected_at_matches');
    expect(callback).toContain('mirror.ipd_advance_deposit_payment_method');
    expect(callback).toContain('fundingPatientUid');
    expect(callback).toContain('IPD_REFUND_MODE_BY_INPUT.get(sourceEvidence.paymentMethod)');
    expect(callback).toContain('sourceRefundMode !== command.mode');
    expect(callback).toContain('IPD_ADVANCE_REFUND_MODE_RECONCILIATION_REQUIRED');
    expect(callback).not.toContain('IPD_ADVANCE_BILLING_CLOSED');
  });

  it('keeps the governed refund lifecycle visible without payout evidence', () => {
    const listRefunds = service.slice(
      service.indexOf('export async function listAdmissionAdvanceRefundRequests'),
      service.indexOf('export async function getAdmissionDepositBalance'),
    );
    expect(listRefunds).toContain('mirror.ipd_advance_deposit_id AS parent_deposit_id');
    expect(listRefunds).toContain('refund.approval_status');
    expect(listRefunds).toContain('refund.rejected_at');
    expect(listRefunds).toContain('refund.paid_at');
    expect(listRefunds).not.toContain('refund.reference');
    expect(listRefunds).not.toContain('refund.payout_rail');
    expect(listRefunds).not.toContain('refund.gateway_refund_id');

    const admissionPath = "'/admissions/:id/advance-deposits'";
    const firstAdmissionRoute = routes.indexOf(admissionPath);
    const routeStart = routes.indexOf(admissionPath, firstAdmissionRoute + 1);
    const routeEnd = routes.indexOf("'/advance-deposits/:depositId/refund'", routeStart);
    const lifecycleRoute = routes.slice(routeStart, routeEnd);
    expect(routeStart).toBeGreaterThanOrEqual(0);
    expect(lifecycleRoute).toContain('DEPOSIT_REFUND_REQUEST_ROLES.includes(role)');
    expect(lifecycleRoute).toContain('listAdmissionAdvanceRefundRequests');
    expect(lifecycleRoute).toContain('refund_requests: refundRequests');
    expect(lifecycleRoute).toContain('Promise.resolve(null)');
  });

  it('uses exact source binding to de-duplicate admission balances', () => {
    const balance = service.slice(
      service.indexOf('export async function getAdmissionDepositBalance'),
      service.indexOf('export async function listAdmissionDeposits'),
    );
    expect(balance).toContain('WITH RECURSIVE admission_scope');
    expect(balance).toContain('patient_uid_family(uid)');
    expect(balance).toContain('predecessor.merged_into_uid = family.uid');
    expect(balance).toContain('family.uid = deposit.patient_uid');
    expect(balance).toContain('family.uid = advance.patient_uid');
    expect(balance).not.toContain('deposit.patient_uid = admission.patient_uid');
    expect(balance).not.toContain('advance.patient_uid = admission.patient_uid');
    expect(balance).toContain('root_state.mirror_count = 0');
    expect(balance).toContain('SUM(advance.balance)');
    expect(balance).toContain('mirror.ipd_advance_deposit_id = root.id');
    expect(balance).toContain('mirror.patient_uid = root.patient_uid');
    expect(balance).toContain('refund.patient_uid IS DISTINCT FROM root.patient_uid');
    expect(balance).toContain("mirror.reference = 'IPD/' || root.receipt_number");
    expect(balance).toContain('mirror.ipd_advance_deposit_payment_method');
    expect(balance).toContain('mirror.ipd_advance_deposit_collected_at');
    expect(balance).toContain("DATE_TRUNC('milliseconds', mirror.collected_at)");
    expect(balance).toContain("NULLIF(BTRIM(root_state.receipt_number), '') IS NULL");
    expect(balance).toContain("NULLIF(BTRIM(root_state.payment_reference), '') IS NULL");
    expect(balance).toContain('advance.ipd_advance_deposit_id IS NULL');
    expect(balance).toContain("'CASH', 'CARD', 'UPI', 'NETBANKING', 'CHEQUE', 'DD'");
    expect(balance).toContain('invalid_patient_identity_rows');
    expect(balance).toContain('patient_identity_rows');
    expect(balance).toContain('IPD_ADVANCE_BALANCE_EVIDENCE_INVALID');
  });
});
