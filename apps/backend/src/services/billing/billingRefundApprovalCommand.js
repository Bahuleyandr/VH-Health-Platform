import { createHash } from 'node:crypto';

export const REFUND_APPROVAL_IDEMPOTENCY_PATH = '/api/v1/billing/v2/refunds/approve';

export function refundApprovalIdempotencyBody(refundId) {
  return {
    action: 'approve_refund',
    refund_id: String(refundId ?? ''),
  };
}

export function refundApprovalRequestFingerprint(refundId) {
  return createHash('sha256')
    .update(JSON.stringify(refundApprovalIdempotencyBody(refundId)))
    .digest('hex');
}

export default {
  REFUND_APPROVAL_IDEMPOTENCY_PATH,
  refundApprovalIdempotencyBody,
  refundApprovalRequestFingerprint,
};
