import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const recordClaimPaymentMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock },
}));

jest.unstable_mockModule('../../services/insurance/claimsService.js', () => ({
  recordClaimPayment: recordClaimPaymentMock,
}));

const {
  approvePaymentNoticeReview,
  listPaymentNoticeReviews,
  rejectPaymentNoticeReview,
} = await import('../../services/nhcx/nhcxPaymentNoticeService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';

function reviewIssue(overrides = {}) {
  return {
    severity: 'information',
    code: 'payment_notice_review',
    message: 'NHCX PaymentNotice captured for finance review',
    payment_notice: {
      review_status: 'manual_review',
      amount: 42000,
      currency: 'INR',
      payment_reference: 'STAR-UTR-9001',
      paid_at: '2026-07-06T12:00:00.000Z',
      claim: {
        id: 88,
        claim_number: 'CLM-88',
        status: 'approved',
        claimed_amount: 50000,
        approved_amount: 50000,
        paid_amount: null,
      },
      settlement_draft: {
        claim_id: 88,
        paid_amount: 42000,
        payment_reference: 'STAR-UTR-9001',
        paid_at: '2026-07-06T12:00:00.000Z',
        expected_amount: 50000,
        short_pay: true,
        disallowed_amount_preview: 8000,
      },
      discrepancies: [{ code: 'short_pay', severity: 'warning', message: 'Short pay' }],
      ...overrides,
    },
  };
}

function envelope(overrides = {}) {
  return {
    id: '70',
    tenant_id: TENANT,
    direction: 'inbound',
    cycle: 'payment_notice',
    status: 'manual_review',
    claim_id: 88,
    received_at: '2026-07-06T12:00:00.000Z',
    processed_at: null,
    hcx_api_call_id: 'payment-notice-1',
    hcx_correlation_id: 'claim-corr-1',
    hcx_workflow_id: '7001',
    participant_code_counterparty: 'PAYER-NHCX-SAMPLE',
    validation_issues: [reviewIssue()],
    last_error: null,
    ...overrides,
  };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  recordClaimPaymentMock.mockReset();
});

describe('nhcxPaymentNoticeService', () => {
  it('lists only tenant-scoped inbound payment notices for finance review', async () => {
    queryUnsafeMock.mockResolvedValueOnce([envelope()]);

    const result = await listPaymentNoticeReviews({ tenantId: TENANT, status: 'manual_review' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: '70',
      status: 'manual_review',
      notice: { amount: 42000, payment_reference: 'STAR-UTR-9001' },
      settlement_draft: { claim_id: 88, short_pay: true },
    });
    const sql = String(queryUnsafeMock.mock.calls[0][0]);
    expect(sql).toContain('m.tenant_id = $1::uuid');
    expect(sql).toContain("m.cycle = 'payment_notice'");
  });

  it('approval calls recordClaimPayment so payer-mismatch guardrails remain load-bearing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([envelope()]);
    recordClaimPaymentMock.mockResolvedValueOnce({ id: 88, status: 'settled_partial', paid_amount: 42000 });
    queryUnsafeMock.mockResolvedValueOnce([envelope({
      status: 'processed',
      processed_at: '2026-07-06T12:05:00.000Z',
    })]);

    const result = await approvePaymentNoticeReview({
      tenantId: TENANT,
      id: '70',
      reviewerUid: '22222222-2222-4222-8222-222222222222',
    });

    expect(recordClaimPaymentMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT,
      id: 88,
      paid_amount: 42000,
      payment_reference: 'STAR-UTR-9001',
      recorded_by: '22222222-2222-4222-8222-222222222222',
    }));
    expect(result.paymentResult).toMatchObject({ status: 'settled_partial' });
  });

  it('does not swallow payer-mismatch rejection from the settlement path', async () => {
    queryUnsafeMock.mockResolvedValueOnce([envelope()]);
    recordClaimPaymentMock.mockRejectedValueOnce(Object.assign(new Error('payer mismatch'), {
      code: 'CLAIM_SETTLEMENT_PAYER_MISMATCH',
      statusCode: 400,
    }));
    queryUnsafeMock.mockResolvedValueOnce([envelope({ last_error: 'payer mismatch' })]);

    await expect(approvePaymentNoticeReview({ tenantId: TENANT, id: '70' }))
      .rejects.toThrow('payer mismatch');
    expect(recordClaimPaymentMock).toHaveBeenCalledTimes(1);
    expect(String(queryUnsafeMock.mock.calls[1][0])).toContain('last_error');
  });

  it('rejecting a notice archives it without calling the settlement path', async () => {
    queryUnsafeMock.mockResolvedValueOnce([envelope()]);
    queryUnsafeMock.mockResolvedValueOnce([envelope({
      status: 'rejected',
      last_error: 'payer denied duplicate',
      processed_at: '2026-07-06T12:05:00.000Z',
    })]);

    const result = await rejectPaymentNoticeReview({
      tenantId: TENANT,
      id: '70',
      reviewerUid: '22222222-2222-4222-8222-222222222222',
      reason: 'payer denied duplicate',
    });

    expect(recordClaimPaymentMock).not.toHaveBeenCalled();
    expect(result.status).toBe('rejected');
  });
});
