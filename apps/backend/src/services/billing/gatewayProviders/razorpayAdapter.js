// src/services/billing/gatewayProviders/razorpayAdapter.js
//
// Razorpay-shaped REST adapter. Talks to the fixed Razorpay API host with
// HTTP Basic auth (key_id:key_secret) — no SDK dependency. All amounts at
// this boundary are PAISE INTEGERS (Razorpay's wire unit); the service layer
// converts from the DB's DECIMAL rupees via toPaise exactly once.
//
// This adapter is only reached when a tenant's enabled config row selects
// provider='razorpay' AND carries real credentials (migration 693 CHECK).
// Tests mock global.fetch; nothing here is exercised against the live API
// in CI.

import { AppError } from '../../../utils/AppError.js';
import { verifyHmacSha256Signature } from './webhookSignature.js';

export const provider = 'razorpay';

const API_BASE = 'https://api.razorpay.com/v1';
const REQUEST_TIMEOUT_MS = 15_000;

function basicAuthHeader(keyId, keySecret) {
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
}

async function razorpayRequest({ keyId, keySecret, method, path, body, headers = {} }) {
  if (!keyId || !keySecret) {
    throw new AppError('Payment gateway credentials are not configured', 503, 'PAYMENT_GATEWAY_CREDENTIALS_MISSING');
  }
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: basicAuthHeader(keyId, keySecret),
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // Network/timeout — never leak credentials or raw error internals upstream.
    throw new AppError(
      `Payment gateway request failed: ${err?.name === 'TimeoutError' ? 'timeout' : 'network error'}`,
      502,
      'PAYMENT_GATEWAY_UPSTREAM_UNAVAILABLE',
    );
  }
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const providerCode = parsed?.error?.code || `http_${response.status}`;
    const description = parsed?.error?.description || 'provider rejected the request';
    if (response.status === 409 && headers['X-Refund-Idempotency']) {
      throw new AppError(
        'Payment gateway refund request is still processing',
        409,
        'PAYMENT_GATEWAY_REFUND_IN_PROGRESS',
        { providerCode },
      );
    }
    throw new AppError(
      `Payment gateway rejected the request: ${description}`,
      response.status >= 500 ? 502 : 400,
      'PAYMENT_GATEWAY_PROVIDER_ERROR',
      { providerCode },
    );
  }
  return parsed;
}

export async function createOrder({ keyId, keySecret, amountPaise, currency = 'INR', receipt, notes = {} } = {}) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new AppError('amountPaise must be a positive integer', 400, 'PAYMENT_GATEWAY_BAD_AMOUNT');
  }
  const order = await razorpayRequest({
    keyId,
    keySecret,
    method: 'POST',
    path: '/orders',
    body: {
      amount: amountPaise,
      currency,
      receipt,
      notes,
      payment_capture: 1,
    },
  });
  return {
    providerOrderId: order?.id,
    amountPaise: Number(order?.amount ?? amountPaise),
    currency: order?.currency || currency,
    receipt: order?.receipt || receipt,
    status: order?.status || 'created',
    raw: order,
  };
}

export async function findOrderByReceipt({ keyId, keySecret, receipt } = {}) {
  if (!receipt) {
    throw new AppError('receipt is required', 400, 'PAYMENT_GATEWAY_BAD_RECEIPT');
  }
  const result = await razorpayRequest({
    keyId,
    keySecret,
    method: 'GET',
    path: `/orders?receipt=${encodeURIComponent(String(receipt))}&count=10`,
  });
  const matches = Array.isArray(result?.items)
    ? result.items.filter((order) => String(order?.receipt || '') === String(receipt))
    : [];
  if (!matches.length) return null;
  if (matches.length !== 1) {
    throw new AppError(
      'Payment gateway returned multiple orders for the durable receipt',
      502,
      'PAYMENT_GATEWAY_ORDER_RECOVERY_AMBIGUOUS',
    );
  }
  const order = matches[0];
  return {
    providerOrderId: order?.id,
    amountPaise: order?.amount == null ? null : Number(order.amount),
    currency: order?.currency,
    receipt: order?.receipt,
    status: order?.status,
    raw: order,
  };
}

export async function fetchPayment({ keyId, keySecret, paymentId } = {}) {
  const payment = await razorpayRequest({
    keyId,
    keySecret,
    method: 'GET',
    path: `/payments/${encodeURIComponent(String(paymentId))}`,
  });
  return {
    providerPaymentId: payment?.id,
    status: payment?.status,
    method: payment?.method,
    amountPaise: payment?.amount != null ? Number(payment.amount) : null,
    raw: payment,
  };
}

export async function createRefund({
  keyId, keySecret, providerPaymentId, amountPaise, receipt, notes = {}, idempotencyKey,
} = {}) {
  if (!providerPaymentId) {
    throw new AppError('providerPaymentId is required', 400, 'PAYMENT_GATEWAY_BAD_REFUND');
  }
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new AppError('amountPaise must be a positive integer', 400, 'PAYMENT_GATEWAY_BAD_AMOUNT');
  }
  if (!/^[A-Za-z0-9_-]{10,120}$/.test(String(idempotencyKey || ''))) {
    throw new AppError(
      'A valid provider refund idempotency key is required',
      400,
      'PAYMENT_GATEWAY_BAD_IDEMPOTENCY_KEY',
    );
  }
  const refund = await razorpayRequest({
    keyId,
    keySecret,
    method: 'POST',
    path: `/payments/${encodeURIComponent(String(providerPaymentId))}/refund`,
    body: { amount: amountPaise, receipt, notes },
    headers: { 'X-Refund-Idempotency': idempotencyKey },
  });
  if (!refund?.id) {
    throw new AppError(
      'Payment gateway refund response was missing its provider id',
      502,
      'PAYMENT_GATEWAY_UPSTREAM_UNRESOLVED',
    );
  }
  return {
    providerRefundId: refund?.id,
    providerPaymentId: refund?.payment_id,
    amountPaise: refund?.amount == null ? null : Number(refund.amount),
    currency: refund?.currency,
    // Razorpay refund status vocabulary: pending | processed | failed.
    status: refund?.status || 'pending',
    raw: refund,
  };
}

/** HMAC-SHA256 hex over the raw webhook body, timing-safe compare. */
export function verifyWebhookSignature(rawBody, signature, secret) {
  return verifyHmacSha256Signature(rawBody, signature, secret);
}

export default {
  provider,
  createOrder,
  findOrderByReceipt,
  fetchPayment,
  createRefund,
  verifyWebhookSignature,
};
