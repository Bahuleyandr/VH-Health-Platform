// src/services/billing/gatewayProviders/index.js
//
// Provider abstraction seam. Every provider module exposes the same surface:
//   createOrder({ keyId, keySecret, amountPaise, currency, receipt, notes })
//   fetchPayment(...)
//   createRefund({ keyId, keySecret, providerPaymentId, amountPaise, receipt })
//   fetchRefund({ keyId, keySecret, providerRefundId })
//   verifyWebhookSignature(rawBody, signature, secret)
// Amounts cross this boundary as PAISE INTEGERS only.

import { AppError } from '../../../utils/AppError.js';
import dryRunAdapter from './dryRunAdapter.js';
import razorpayAdapter from './razorpayAdapter.js';

export const GATEWAY_PROVIDERS = Object.freeze(['razorpay', 'dry_run']);

const ADAPTERS = Object.freeze({
  dry_run: dryRunAdapter,
  razorpay: razorpayAdapter,
});

export function resolveAdapter(provider) {
  const adapter = ADAPTERS[String(provider || '').trim().toLowerCase()];
  if (!adapter) {
    throw AppError.badRequest(
      `Unknown payment gateway provider. Allowed: ${GATEWAY_PROVIDERS.join(', ')}`,
      'PAYMENT_GATEWAY_UNKNOWN_PROVIDER',
    );
  }
  return adapter;
}

export default { GATEWAY_PROVIDERS, resolveAdapter };
