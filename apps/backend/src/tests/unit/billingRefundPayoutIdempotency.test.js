import { createHash } from 'node:crypto';

import { jest } from '@jest/globals';

const queryMock = jest.fn();
const executeMock = jest.fn();
const tx = {
  $queryRawUnsafe: queryMock,
  $executeRawUnsafe: executeMock,
};
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn(tx));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: tx,
  setTenantTx: setTenantTxMock,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/billing/ledger/ledgerPostings.js', () => ({
  postInvoiceIssueEntry: jest.fn(),
  postPaymentEntry: jest.fn(),
  postAdvanceCollectEntry: jest.fn(),
  postAdvanceSettleEntry: jest.fn(),
  postPaymentReversalEntry: jest.fn(),
  postRefundApproveEntry: jest.fn(),
  postRefundPaidEntry: jest.fn(),
}));

jest.unstable_mockModule('../../services/billing/ledger/ledgerAuthoritativeMode.js', () => ({
  resolveLedgerWiring: jest.fn(async () => ({
    mode: 'off', sameTx: false, postCommit: false, skip: true,
  })),
}));

jest.unstable_mockModule('../../services/ipd/wardIndentObligationService.js', () => ({
  advanceBillingCreditNoteRefundPayoutObligationTx: jest.fn(),
  completeBillingCreditNoteRefundObligationTx: jest.fn(),
}));

const billing = await import('../../services/billing/billingV2Service.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PAYER = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';
const PATIENT = '33333333-3333-4333-8333-333333333333';
const PAYOUT_COMMAND_KEY = ['refund', 'pay', '51'].join('-');
const AUDIT_CONTEXT = Object.freeze({
  actorUid: PAYER,
  subjectUid: PAYER,
  actorRole: 'FINANCE_INCHARGE',
  actingAsDependent: false,
  requestId: 'req-refund-pay-51',
  deviceType: 'desktop',
  ipAddress: '127.0.0.1',
  userAgent: 'VH Staff Windows',
});

function fingerprint(body) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function manualCommand(refundId, body) {
  return {
    commandKey: `refund-pay-${refundId}`,
    requestFingerprint: fingerprint(
      billing.refundManualPayoutIdempotencyBody(refundId, body),
    ),
    httpIdempotencyClaimId: 901,
    requestId: AUDIT_CONTEXT.requestId,
  };
}

function approvedRefund(overrides = {}) {
  return {
    id: 51,
    tenant_id: TENANT,
    patient_uid: PATIENT,
    invoice_id: null,
    advance_id: null,
    amount: '250.00',
    mode: 'CHEQUE',
    approval_status: 'APPROVED',
    approved_by: APPROVER,
    approved_at: '2026-08-28T08:00:00.000Z',
    payout_rail: null,
    ...overrides,
  };
}

beforeEach(() => {
  queryMock.mockReset();
  executeMock.mockReset();
  executeMock.mockResolvedValue(1);
  setTenantTxMock.mockClear();
});

describe('refund payout durable idempotency and audit', () => {
  it('projects exact manual and offline commands into separate stable scopes', () => {
    expect(billing.REFUND_MANUAL_PAYOUT_IDEMPOTENCY_PATH)
      .toBe('/api/v1/billing/v2/refunds/pay');
    expect(billing.REFUND_OFFLINE_ELECTRONIC_PAYOUT_IDEMPOTENCY_PATH)
      .toBe('/api/v1/billing/v2/refunds/pay/offline-electronic');
    expect(billing.refundManualPayoutIdempotencyBody('51', {
      cash_drawer_session_id: ' 7 ', reference: ' VOUCHER-51 ',
    })).toEqual({
      action: 'pay_refund_manual',
      refund_id: '51',
      cash_drawer_session_id: '7',
      reference: 'VOUCHER-51',
    });
  });

  it('persists payout audit and the exact permanent HTTP response in one transaction', async () => {
    const body = { reference: 'CHEQUE-51' };
    const paid = approvedRefund({
      approval_status: 'PAID',
      paid_by: PAYER,
      reference: body.reference,
      payout_rail: 'manual',
    });
    queryMock
      .mockResolvedValueOnce([approvedRefund()])
      .mockResolvedValueOnce([paid])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 701 }])
      .mockResolvedValueOnce([{ id: 901, status: 'complete' }]);

    await expect(billing.markRefundPaid('51', {
      tenantId: TENANT,
      paid_by: PAYER,
      ...body,
      ...manualCommand('51', body),
      auditContext: AUDIT_CONTEXT,
    })).resolves.toEqual(paid);

    const audit = queryMock.mock.calls[3];
    expect(audit[0]).toContain('INSERT INTO audit_logs');
    expect(audit.slice(1, 4)).toEqual([PAYER, 'FINANCE_INCHARGE', 'FRONT_OFFICE_BILLING_REFUND_PAID']);
    const finalise = queryMock.mock.calls[4];
    expect(finalise[0]).toContain("expires_at = 'infinity'::timestamptz");
    expect(finalise.at(-1)).toBe(billing.REFUND_MANUAL_PAYOUT_IDEMPOTENCY_PATH);
    expect(JSON.parse(finalise[6])).toEqual({
      success: true,
      message: 'Success',
      data: paid,
      requestId: AUDIT_CONTEXT.requestId,
    });
  });

  it('rolls back before permanent finalization when strict payout audit fails', async () => {
    const body = { reference: 'CHEQUE-51-AUDIT-FAIL' };
    queryMock
      .mockResolvedValueOnce([approvedRefund()])
      .mockResolvedValueOnce([approvedRefund({
        approval_status: 'PAID', paid_by: PAYER, reference: body.reference, payout_rail: 'manual',
      })])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(billing.markRefundPaid('51', {
      tenantId: TENANT,
      paid_by: PAYER,
      ...body,
      ...manualCommand('51', body),
      auditContext: AUDIT_CONTEXT,
    })).rejects.toThrow('audit unavailable');

    expect(queryMock.mock.calls.some(([sql]) => (
      sql.includes("expires_at = 'infinity'::timestamptz")
    ))).toBe(false);
  });

  it('rejects changed command identity and concurrent claim replacement', async () => {
    await expect(billing.markRefundPaid('51', {
      tenantId: TENANT,
      paid_by: PAYER,
      reference: 'CHEQUE-CHANGED',
      commandKey: PAYOUT_COMMAND_KEY,
      requestFingerprint: fingerprint(
        billing.refundManualPayoutIdempotencyBody('52', { reference: 'CHEQUE-CHANGED' }),
      ),
      httpIdempotencyClaimId: 901,
    })).rejects.toMatchObject({
      statusCode: 422,
      code: 'BILLING_REFUND_PAYOUT_COMMAND_MISMATCH',
    });

    const body = { reference: 'CHEQUE-CONCURRENT' };
    queryMock
      .mockResolvedValueOnce([approvedRefund()])
      .mockResolvedValueOnce([approvedRefund({
        approval_status: 'PAID', paid_by: PAYER, reference: body.reference, payout_rail: 'manual',
      })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 702 }])
      .mockResolvedValueOnce([]);
    await expect(billing.markRefundPaid('51', {
      tenantId: TENANT,
      paid_by: PAYER,
      ...body,
      ...manualCommand('51', body),
      auditContext: AUDIT_CONTEXT,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'BILLING_REFUND_PAYOUT_IDEMPOTENCY_CHANGED',
    });
  });

  it('fails closed on same approver/payer and manual electronic bypass', async () => {
    queryMock.mockResolvedValueOnce([approvedRefund({ approved_by: PAYER })]);
    await expect(billing.markRefundPaid('51', {
      tenantId: TENANT, paid_by: PAYER, reference: 'CHEQUE-SAME-ACTOR',
    })).rejects.toMatchObject({
      code: 'BILLING_REFUND_PAYER_MUST_DIFFER_FROM_APPROVER',
    });

    queryMock.mockResolvedValueOnce([approvedRefund({ mode: 'UPI' })]);
    await expect(billing.markRefundPaid('51', {
      tenantId: TENANT, paid_by: PAYER, reference: 'UPI-MANUAL-BYPASS',
    })).rejects.toMatchObject({
      code: 'BILLING_REFUND_MANUAL_ELECTRONIC_FORBIDDEN',
    });
  });

  it('requires an exact open owned drawer and returns live net totals for CASH', async () => {
    const cash = approvedRefund({ mode: 'CASH', amount: '100.00' });
    const paid = {
      ...cash,
      approval_status: 'PAID',
      paid_by: PAYER,
      payout_rail: 'manual',
      reference: 'CASH-VOUCHER-51',
      cash_drawer_session_id: '81',
    };
    queryMock
      .mockResolvedValueOnce([cash])
      .mockResolvedValueOnce([{
        id: '81', cashier_uid: PAYER, shift: 'MORNING',
        opened_at: '2026-08-28T08:00:00.000Z', opening_float: '500.00', status: 'open',
      }])
      .mockResolvedValueOnce([{ cash_inflow_total: '1000.00', cash_refund_total: '100.00' }])
      .mockResolvedValueOnce([paid])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ cash_inflow_total: '1000.00', cash_refund_total: '200.00' }]);

    await expect(billing.markRefundPaid('51', {
      tenantId: TENANT,
      paid_by: PAYER,
      reference: 'CASH-VOUCHER-51',
      cash_drawer_session_id: '81',
    })).resolves.toEqual(expect.objectContaining({
      cash_drawer_session_id: '81',
      cash_inflow_total: 1000,
      cash_refund_total: 200,
      system_total: 800,
    }));

    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce([cash])
      .mockResolvedValueOnce([]);
    await expect(billing.markRefundPaid('51', {
      tenantId: TENANT,
      paid_by: PAYER,
      reference: 'CASH-VOUCHER-OTHER',
      cash_drawer_session_id: '82',
    })).rejects.toMatchObject({ code: 'BILLING_REFUND_CASH_DRAWER_NOT_OPEN' });
  });

  it('persists exact offline-electronic evidence and rejects integrated gateway substitution', async () => {
    const upi = approvedRefund({
      mode: 'UPI', invoice_id: 17, amount: '250.00',
    });
    const evidence = {
      original_payment_reference: 'UPI-COLLECT-17',
      provider_name: 'Acquirer One',
      provider_refund_reference: 'UPI-REFUND-51',
      provider_refunded_at: new Date(Date.now() - 60_000).toISOString(),
    };
    queryMock
      .mockResolvedValueOnce([upi])
      .mockResolvedValueOnce([{ id: 33, amount: '250.00', mode: 'UPI', reference: 'UPI-COLLECT-17' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: '91' }])
      .mockResolvedValueOnce([{
        ...upi,
        approval_status: 'PAID',
        paid_by: PAYER,
        payout_rail: 'offline_electronic',
        reference: 'UPI-REFUND-51',
        offline_electronic_evidence_id: '91',
      }])
      .mockResolvedValueOnce([{ amount_paid: '250', total_amount: '250', credit_note_amount: '0' }])
      .mockResolvedValueOnce([]);

    await expect(billing.markOfflineElectronicRefundPaid('51', {
      tenantId: TENANT,
      paid_by: PAYER,
      ...evidence,
    })).resolves.toEqual(expect.objectContaining({
      payout_rail: 'offline_electronic',
      offline_electronic_evidence_id: '91',
    }));
    expect(queryMock.mock.calls[3][0]).toContain(
      'INSERT INTO billing_refund_offline_electronic_evidence',
    );

    queryMock.mockReset();
    queryMock
      .mockResolvedValueOnce([upi])
      .mockResolvedValueOnce([{ id: 33, amount: '250.00', mode: 'UPI', reference: 'UPI-COLLECT-17' }])
      .mockResolvedValueOnce([{ id: 44, provider: 'razorpay' }]);
    await expect(billing.markOfflineElectronicRefundPaid('51', {
      tenantId: TENANT,
      paid_by: PAYER,
      ...evidence,
    })).rejects.toMatchObject({ code: 'BILLING_REFUND_GATEWAY_CAPTURE_AUTHORITATIVE' });
  });

  it('atomically records exact provider success before the gateway PAID transition', async () => {
    const providerRefundId = 'rfnd_exact_51';
    const gatewayRefund = approvedRefund({
      mode: 'UPI',
      payout_rail: 'gateway',
      gateway_refund_id: 73,
    });
    const paid = {
      ...gatewayRefund,
      approval_status: 'PAID',
      paid_by: null,
      reference: providerRefundId,
    };
    queryMock
      .mockResolvedValueOnce([{
        id: 73,
        initiated_by: PAYER,
        initiated_at: '2026-08-28T09:00:00.000Z',
        status: 'pending',
        provider_refund_id: null,
        processed_at: null,
      }])
      .mockResolvedValueOnce([gatewayRefund])
      .mockResolvedValueOnce([{
        id: 73,
        status: 'processed',
        provider_refund_id: providerRefundId,
        processed_at: '2026-08-28T09:01:00.000Z',
      }])
      .mockResolvedValueOnce([paid])
      .mockResolvedValueOnce([]);

    await expect(billing.markGatewayRefundPaid('51', {
      tenantId: TENANT,
      gateway_refund_id: 73,
      provider_refund_id: providerRefundId,
    })).resolves.toMatchObject({
      approval_status: 'PAID',
      gateway_authority_transitioned: true,
    });

    expect(queryMock.mock.calls[2][0]).toContain("SET status = 'processed'");
    expect(queryMock.mock.calls[3][0]).toContain("SET approval_status = 'PAID'");
    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
  });

  it('rejects missing or mismatched provider success evidence', async () => {
    await expect(billing.markGatewayRefundPaid('51', {
      tenantId: TENANT,
      gateway_refund_id: 73,
      provider_refund_id: '',
    })).rejects.toMatchObject({
      code: 'BILLING_REFUND_GATEWAY_EXECUTION_REQUIRED',
    });
    expect(queryMock).not.toHaveBeenCalled();

    queryMock
      .mockResolvedValueOnce([]);
    await expect(billing.markGatewayRefundPaid('51', {
      tenantId: TENANT,
      gateway_refund_id: 73,
      provider_refund_id: 'rfnd_wrong_51',
    })).rejects.toMatchObject({
      code: 'BILLING_REFUND_GATEWAY_EVIDENCE_INVALID',
    });
  });

  it('does not finalize after a post-receipt billing failure in the atomic transaction', async () => {
    const providerRefundId = 'rfnd_rollback_51';
    queryMock
      .mockResolvedValueOnce([{
        id: 74,
        initiated_by: PAYER,
        initiated_at: '2026-08-28T09:00:00.000Z',
        status: 'pending',
        provider_refund_id: null,
        processed_at: null,
      }])
      .mockResolvedValueOnce([approvedRefund({
        mode: 'UPI', payout_rail: 'gateway', gateway_refund_id: 74,
      })])
      .mockResolvedValueOnce([{
        id: 74,
        status: 'processed',
        provider_refund_id: providerRefundId,
        processed_at: '2026-08-28T09:01:00.000Z',
      }])
      .mockRejectedValueOnce(new Error('billing authority write failed'));

    await expect(billing.markGatewayRefundPaid('51', {
      tenantId: TENANT,
      gateway_refund_id: 74,
      provider_refund_id: providerRefundId,
    })).rejects.toThrow('billing authority write failed');

    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls.some(([sql]) => (
      sql.includes("expires_at = 'infinity'::timestamptz")
    ))).toBe(false);
  });
});

describe('refund rejection durable idempotency and audit', () => {
  it('binds rejection reason and commits audit before the permanent response', async () => {
    const reason = 'Duplicate refund request';
    const body = billing.refundRejectionIdempotencyBody('51', { rejection_reason: reason });
    const rejected = approvedRefund({
      approval_status: 'REJECTED',
      approved_by: null,
      rejected_by: PAYER,
      rejection_reason: reason,
    });
    queryMock
      .mockResolvedValueOnce([{ id: 51, approval_status: 'PENDING' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([rejected])
      .mockResolvedValueOnce([{ id: 801 }])
      .mockResolvedValueOnce([{ id: 902, status: 'complete' }]);

    await expect(billing.rejectRefund('51', {
      tenantId: TENANT,
      rejected_by: PAYER,
      rejection_reason: reason,
      commandKey: 'refund-reject-51',
      requestFingerprint: fingerprint(body),
      httpIdempotencyClaimId: 902,
      requestId: AUDIT_CONTEXT.requestId,
      auditContext: AUDIT_CONTEXT,
    })).resolves.toEqual(rejected);

    expect(queryMock.mock.calls[3].slice(1, 4)).toEqual([
      PAYER,
      'FINANCE_INCHARGE',
      'FRONT_OFFICE_BILLING_REFUND_REJECTED',
    ]);
    expect(queryMock.mock.calls[4][0]).toContain("expires_at = 'infinity'::timestamptz");
    expect(queryMock.mock.calls[4].at(-1)).toBe(billing.REFUND_REJECTION_IDEMPOTENCY_PATH);
  });
});
