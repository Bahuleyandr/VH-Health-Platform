import { createHash } from 'node:crypto';

import { jest } from '@jest/globals';

const queryMock = jest.fn();
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn({
  $queryRawUnsafe: queryMock,
}));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryMock },
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
const ACTOR = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';
const RAISE_COMMAND_KEY = ['refund', 'raise', '17'].join('-');
const BODY = Object.freeze({
  patient_uid: PATIENT,
  invoice_id: 17,
  amount: 25,
  reason: 'Duplicate payment',
  mode: 'UPI',
});
const AUDIT_CONTEXT = Object.freeze({
  actorUid: ACTOR,
  subjectUid: ACTOR,
  actorRole: 'BILLING_STAFF',
  actingAsDependent: false,
  requestId: 'req-refund-raise-17',
  deviceType: 'desktop',
  ipAddress: '127.0.0.1',
  userAgent: 'VH Staff Windows',
});

function fingerprint(body = BODY) {
  return createHash('sha256')
    .update(JSON.stringify(billing.refundRaiseIdempotencyBody(body)))
    .digest('hex');
}

beforeEach(() => {
  queryMock.mockReset();
  setTenantTxMock.mockClear();
});

describe('refund creation durable idempotency', () => {
  it('commits refund, audit, and permanent HTTP response in one transaction', async () => {
    const refund = {
      id: 31,
      tenant_id: TENANT,
      patient_uid: PATIENT,
      invoice_id: 17,
      advance_id: null,
      amount: '25.00',
      mode: 'UPI',
      reason: 'Duplicate payment',
      approval_status: 'PENDING',
    };
    queryMock
      .mockResolvedValueOnce([{ patient_uid: PATIENT, amount_paid: '25.00' }])
      .mockResolvedValueOnce([{ gross_paid: '25.00', active_refunds: '0.00' }])
      .mockResolvedValueOnce([refund])
      .mockResolvedValueOnce([{ id: 801 }])
      .mockResolvedValueOnce([{
        id: 901,
        status: 'complete',
        response_status: 200,
      }]);

    const result = await billing.raiseRefund({
      ...BODY,
      tenantId: TENANT,
      raised_by: ACTOR,
      commandKey: RAISE_COMMAND_KEY,
      requestFingerprint: fingerprint(),
      httpIdempotencyClaimId: 901,
      requestId: 'req-refund-raise-17',
      auditContext: AUDIT_CONTEXT,
    });

    expect(result).toEqual(refund);
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    const audit = queryMock.mock.calls[3];
    expect(audit[3]).toBe('FRONT_OFFICE_BILLING_REFUND_RAISED');
    expect(JSON.parse(audit[7])).toEqual(expect.objectContaining({
      request_id: 'req-refund-raise-17',
      refund_id: 31,
      invoice_id: 17,
      patient_uid: PATIENT,
      approval_status: 'PENDING',
    }));
    const finalise = queryMock.mock.calls[4];
    expect(finalise[0]).toContain("expires_at = 'infinity'::timestamptz");
    expect(finalise.slice(1, 6)).toEqual([
      901,
      TENANT,
      ACTOR,
      RAISE_COMMAND_KEY,
      fingerprint(),
    ]);
    expect(JSON.parse(finalise[6])).toEqual({
      success: true,
      message: 'Success',
      data: refund,
      requestId: 'req-refund-raise-17',
    });
    expect(finalise[7]).toBe(billing.REFUND_RAISE_IDEMPOTENCY_PATH);
  });

  it('rejects partial or changed command identity before opening a transaction', async () => {
    await expect(billing.raiseRefund({
      ...BODY,
      tenantId: TENANT,
      raised_by: ACTOR,
      commandKey: 'partial-command',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'BILLING_REFUND_RAISE_IDEMPOTENCY_INVALID',
    });
    await expect(billing.raiseRefund({
      ...BODY,
      tenantId: TENANT,
      raised_by: ACTOR,
      commandKey: 'changed-command',
      requestFingerprint: fingerprint({ ...BODY, amount: 24 }),
      httpIdempotencyClaimId: 902,
    })).rejects.toMatchObject({
      statusCode: 422,
      code: 'BILLING_REFUND_RAISE_COMMAND_MISMATCH',
    });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });
});
