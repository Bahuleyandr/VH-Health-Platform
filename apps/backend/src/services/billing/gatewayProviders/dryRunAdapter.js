// src/services/billing/gatewayProviders/dryRunAdapter.js
//
// Sandbox/dry-run payment gateway adapter — the DEFAULT provider. Echoes
// deterministic fake provider identifiers derived from the caller's receipt
// so the entire order → webhook → capture → refund flow is exercisable with
// zero live credentials (dev, CI, and tenants evaluating the feature).
//
// Determinism contract (pinned by src/tests/unit/paymentGatewayAdapter.test.js):
//   createOrder  → order_dry_<receipt>
//   createRefund → rfnd_dry_<receipt>
// No network I/O ever happens here.

import { verifyHmacSha256Signature } from './webhookSignature.js';

export const provider = 'dry_run';

export async function createOrder({ amountPaise, currency = 'INR', receipt, notes = {} } = {}) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new Error('dry_run createOrder requires a positive integer amountPaise');
  }
  if (!receipt) throw new Error('dry_run createOrder requires a receipt');
  return {
    providerOrderId: `order_dry_${receipt}`,
    amountPaise,
    currency,
    receipt,
    status: 'created',
    raw: { provider: 'dry_run', notes },
  };
}

export async function fetchPayment(paymentId) {
  if (!paymentId) throw new Error('dry_run fetchPayment requires a payment id');
  return {
    providerPaymentId: String(paymentId),
    status: 'captured',
    raw: { provider: 'dry_run' },
  };
}

export async function createRefund({ providerPaymentId, amountPaise, receipt, idempotencyKey } = {}) {
  if (!providerPaymentId) throw new Error('dry_run createRefund requires providerPaymentId');
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new Error('dry_run createRefund requires a positive integer amountPaise');
  }
  if (!receipt) throw new Error('dry_run createRefund requires a receipt');
  if (!idempotencyKey) throw new Error('dry_run createRefund requires an idempotency key');
  return {
    providerRefundId: `rfnd_dry_${receipt}`,
    providerPaymentId: String(providerPaymentId),
    amountPaise,
    // pending: the terminal `processed` arrives via the (simulated) webhook,
    // mirroring the live provider's asynchronous refund lifecycle.
    status: 'pending',
    raw: { provider: 'dry_run' },
  };
}

/** Same HMAC-SHA256-over-raw-body scheme as Razorpay, so one webhook code path. */
export function verifyWebhookSignature(rawBody, signature, secret) {
  return verifyHmacSha256Signature(rawBody, signature, secret);
}

export default { provider, createOrder, fetchPayment, createRefund, verifyWebhookSignature };
