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
const SUBJECT = '22222222-2222-4222-8222-222222222222';
const APPROVAL_COMMAND_KEY = ['refund', 'approval', '31'].join('-');
const AUDIT_CONTEXT = Object.freeze({
  actorUid: ACTOR,
  subjectUid: ACTOR,
  actorRole: 'ADMIN',
  actingAsDependent: false,
  requestId: 'req-refund-31',
  deviceType: 'desktop',
  ipAddress: '127.0.0.1',
  userAgent: 'VH Staff Windows',
});
const DELEGATED_AUDIT_CONTEXT = Object.freeze({
  ...AUDIT_CONTEXT,
  subjectUid: SUBJECT,
  actorRole: 'SUPER_ADMIN',
  actingAsDependent: true,
});

function fingerprint(refundId) {
  return createHash('sha256')
    .update(JSON.stringify(billing.refundApprovalIdempotencyBody(refundId)))
    .digest('hex');
}

function pendingRefund(overrides = {}) {
  return {
    id: 31,
    tenant_id: TENANT,
    patient_uid: SUBJECT,
    invoice_id: 17,
    advance_id: null,
    amount: '25.00',
    approval_status: 'PENDING',
    approved_by: null,
    ...overrides,
  };
}

function mockRefundAuthorityPrefix(refund = pendingRefund()) {
  return queryMock
    .mockResolvedValueOnce([{ locked: 1 }])
    .mockResolvedValueOnce([{
      id: refund.id,
      patient_uid: refund.patient_uid,
      invoice_id: refund.invoice_id,
      advance_id: refund.advance_id,
      approval_status: refund.approval_status,
    }])
    .mockResolvedValueOnce([{
      uid: refund.patient_uid, merged_into_uid: null, depth: 0, cycle: false,
    }])
    .mockResolvedValueOnce([{ lock_acquired: null }])
    .mockResolvedValueOnce([{
      id: 17,
      patient_uid: refund.patient_uid,
      status: 'PAID',
      total_amount: '25.00',
      credit_note_amount: '0.00',
      amount_paid: '25.00',
      amount_due: '0.00',
    }])
    .mockResolvedValueOnce([refund]);
}

beforeEach(() => {
  queryMock.mockReset();
  setTenantTxMock.mockClear();
});

describe('refund approval durable idempotency', () => {
  it('projects the refund identity into one stable command scope', () => {
    expect(billing.REFUND_APPROVAL_IDEMPOTENCY_PATH)
      .toBe('/api/v1/billing/v2/refunds/approve');
    expect(billing.refundApprovalIdempotencyBody('31')).toEqual({
      action: 'approve_refund',
      refund_id: '31',
    });
    expect(fingerprint('31')).not.toBe(fingerprint('32'));
  });

  it('commits the exact response into the bound HTTP claim with permanent retention', async () => {
    const refund = {
      id: 31,
      tenant_id: TENANT,
      patient_uid: SUBJECT,
      invoice_id: 17,
      advance_id: null,
      amount: '25.00',
      approval_status: 'APPROVED',
      approved_by: ACTOR,
    };
    mockRefundAuthorityPrefix()
      .mockResolvedValueOnce([refund])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 801 }])
      .mockResolvedValueOnce([{
        id: 901,
        status: 'complete',
        response_status: 200,
      }]);

    const result = await billing.approveRefund('31', {
      approved_by: ACTOR,
      tenantId: TENANT,
      commandKey: APPROVAL_COMMAND_KEY,
      requestFingerprint: fingerprint('31'),
      httpIdempotencyClaimId: 901,
      requestId: 'req-refund-31',
      auditContext: AUDIT_CONTEXT,
    });

    expect(result).toEqual(refund);
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    const audit = queryMock.mock.calls[8];
    expect(audit[0]).toContain('FRONT_OFFICE_BILLING_REFUND_APPROVED');
    expect(audit[0]).toContain("'billing_refund'");
    expect(audit.slice(1)).toEqual([
      ACTOR,
      'ADMIN',
      '31',
      '127.0.0.1',
      'VH Staff Windows',
      expect.any(String),
      ACTOR,
      false,
      TENANT,
    ]);
    expect(JSON.parse(audit[6])).toEqual(expect.objectContaining({
      request_id: 'req-refund-31',
      device_type: 'desktop',
      tenant_id: TENANT,
      actor_role: 'ADMIN',
      refund_id: 31,
      invoice_id: 17,
      patient_uid: refund.patient_uid,
      approval_status: 'APPROVED',
      source: 'billing_v2',
    }));
    const finalise = queryMock.mock.calls[9];
    expect(finalise[0]).toContain("expires_at = 'infinity'::timestamptz");
    expect(finalise[0]).toContain("request_method = 'POST'");
    expect(finalise.slice(1, 6)).toEqual([
      901,
      TENANT,
      ACTOR,
      APPROVAL_COMMAND_KEY,
      fingerprint('31'),
    ]);
    expect(JSON.parse(finalise[6])).toEqual({
      success: true,
      message: 'Success',
      data: refund,
      requestId: 'req-refund-31',
    });
    expect(finalise[7]).toBe(billing.REFUND_APPROVAL_IDEMPOTENCY_PATH);
  });

  it('writes delegated actor and rewritten subject identities into their canonical columns', async () => {
    const refund = {
      id: 31,
      tenant_id: TENANT,
      patient_uid: SUBJECT,
      invoice_id: 17,
      advance_id: null,
      approval_status: 'APPROVED',
      approved_by: ACTOR,
    };
    mockRefundAuthorityPrefix()
      .mockResolvedValueOnce([refund])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 802 }]);

    await expect(billing.approveRefund('31', {
      approved_by: ACTOR,
      tenantId: TENANT,
      auditContext: DELEGATED_AUDIT_CONTEXT,
    })).resolves.toEqual(refund);

    expect(queryMock.mock.calls[8].slice(1)).toEqual([
      ACTOR,
      'SUPER_ADMIN',
      '31',
      '127.0.0.1',
      'VH Staff Windows',
      expect.any(String),
      SUBJECT,
      true,
      TENANT,
    ]);
  });

  it('rejects a partial or changed command identity before approval', async () => {
    await expect(billing.approveRefund('31', {
      approved_by: ACTOR,
      tenantId: TENANT,
      commandKey: 'partial-command',
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'BILLING_REFUND_APPROVAL_IDEMPOTENCY_INVALID',
    });
    await expect(billing.approveRefund('31', {
      approved_by: ACTOR,
      tenantId: TENANT,
      commandKey: 'changed-command',
      requestFingerprint: fingerprint('32'),
      httpIdempotencyClaimId: 902,
    })).rejects.toMatchObject({
      statusCode: 422,
      code: 'BILLING_REFUND_APPROVAL_COMMAND_MISMATCH',
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects inverted actor identity or a mismatched audit request before approval', async () => {
    const command = {
      approved_by: ACTOR,
      tenantId: TENANT,
      commandKey: 'refund-approval-audit-binding',
      requestFingerprint: fingerprint('31'),
      httpIdempotencyClaimId: 905,
      requestId: 'req-refund-31',
    };

    await expect(billing.approveRefund('31', {
      ...command,
      auditContext: {
        ...AUDIT_CONTEXT,
        actorUid: SUBJECT,
        subjectUid: ACTOR,
      },
    })).rejects.toMatchObject({
      statusCode: 500,
      code: 'BILLING_REFUND_APPROVAL_AUDIT_CONTEXT_INVALID',
    });
    await expect(billing.approveRefund('31', {
      ...command,
      auditContext: {
        ...AUDIT_CONTEXT,
        requestId: 'req-other-command',
      },
    })).rejects.toMatchObject({
      statusCode: 500,
      code: 'BILLING_REFUND_APPROVAL_AUDIT_CONTEXT_INVALID',
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rolls the approval transaction back when the concurrent claim no longer matches', async () => {
    mockRefundAuthorityPrefix()
      .mockResolvedValueOnce([pendingRefund({
        approval_status: 'APPROVED', approved_by: ACTOR,
      })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 802 }])
      .mockResolvedValueOnce([]);

    await expect(billing.approveRefund('31', {
      approved_by: ACTOR,
      tenantId: TENANT,
      commandKey: 'refund-approval-concurrent',
      requestFingerprint: fingerprint('31'),
      httpIdempotencyClaimId: 903,
      requestId: 'req-refund-31',
      auditContext: AUDIT_CONTEXT,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'BILLING_REFUND_APPROVAL_IDEMPOTENCY_CHANGED',
    });
  });

  it('fails before permanent finalization when the strict audit insert fails', async () => {
    mockRefundAuthorityPrefix()
      .mockResolvedValueOnce([pendingRefund({
        approval_status: 'APPROVED', approved_by: ACTOR,
      })])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(billing.approveRefund('31', {
      approved_by: ACTOR,
      tenantId: TENANT,
      commandKey: 'refund-approval-audit-failure',
      requestFingerprint: fingerprint('31'),
      httpIdempotencyClaimId: 904,
      requestId: 'req-refund-31',
      auditContext: AUDIT_CONTEXT,
    })).rejects.toThrow('audit unavailable');

    expect(queryMock).toHaveBeenCalledTimes(9);
    expect(queryMock.mock.calls[8][0]).toContain(
      'FRONT_OFFICE_BILLING_REFUND_APPROVED',
    );
    expect(queryMock.mock.calls.some(([sql]) => (
      sql.includes("expires_at = 'infinity'::timestamptz")
    ))).toBe(false);
  });
});
