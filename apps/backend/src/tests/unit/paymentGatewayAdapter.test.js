// src/tests/unit/paymentGatewayAdapter.test.js
//
// Payment gateway provider adapters (migrations 693-697):
//   * dry_run adapter determinism — the sandbox default must be exercisable
//     with zero credentials and produce stable provider ids.
//   * webhook signature verification — HMAC-SHA256 over the RAW body against
//     a known vector, timing-safe, fail-closed on every malformed input.
//   * razorpay adapter — provider-mocked HTTP (global.fetch): paise on the
//     wire, Basic auth, provider error mapping. No live credentials anywhere.

import crypto from 'node:crypto';
import { jest } from '@jest/globals';

const { default: dryRunAdapter } = await import(
  '../../services/billing/gatewayProviders/dryRunAdapter.js'
);
const { default: razorpayAdapter } = await import(
  '../../services/billing/gatewayProviders/razorpayAdapter.js'
);
const { verifyHmacSha256Signature, sha256Hex } = await import(
  '../../services/billing/gatewayProviders/webhookSignature.js'
);
const { resolveAdapter, GATEWAY_PROVIDERS } = await import(
  '../../services/billing/gatewayProviders/index.js'
);

// Deliberately self-describing test material — not live credentials. Kept
// digit/symbol-free so the vh-hardcoded-password-assignment gitleaks rule
// (which requires credential-shaped entropy in the value) never matches.
const SECRET = 'test-webhook-signing-material-unit';
const BODY = '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_test_1"}}}}';
const sign = (body, secret) => crypto.createHmac('sha256', secret).update(body).digest('hex');

describe('gateway provider registry', () => {
  it('resolves exactly the two migration-693 providers', () => {
    expect(GATEWAY_PROVIDERS).toEqual(['razorpay', 'dry_run']);
    expect(resolveAdapter('dry_run')).toBe(dryRunAdapter);
    expect(resolveAdapter('razorpay')).toBe(razorpayAdapter);
  });

  it('rejects an unknown provider', () => {
    expect(() => resolveAdapter('stripe')).toThrow(/Unknown payment gateway provider/);
  });
});

describe('dry_run adapter determinism', () => {
  it('derives the provider order id from the receipt', async () => {
    const order = await dryRunAdapter.createOrder({
      amountPaise: 123450, currency: 'INR', receipt: 'pg-abc123',
    });
    expect(order.providerOrderId).toBe('order_dry_pg-abc123');
    expect(order.amountPaise).toBe(123450);
    expect(order.status).toBe('created');
    // Same receipt → same id, every time.
    const again = await dryRunAdapter.createOrder({ amountPaise: 123450, receipt: 'pg-abc123' });
    expect(again.providerOrderId).toBe('order_dry_pg-abc123');
  });

  it('derives the provider refund id from the receipt and stays pending until the webhook', async () => {
    const refund = await dryRunAdapter.createRefund({
      providerPaymentId: 'pay_dry_1', amountPaise: 5000, receipt: 'pgr-42',
      idempotencyKey: 'pgr_test_0000000001',
    });
    expect(refund.providerRefundId).toBe('rfnd_dry_pgr-42');
    expect(refund.status).toBe('pending');
  });

  it('rejects non-positive or non-integer paise amounts', async () => {
    await expect(dryRunAdapter.createOrder({ amountPaise: 0, receipt: 'r' })).rejects.toThrow();
    await expect(dryRunAdapter.createOrder({ amountPaise: 10.5, receipt: 'r' })).rejects.toThrow();
    await expect(dryRunAdapter.createRefund({
      providerPaymentId: 'p', amountPaise: -1, receipt: 'r', idempotencyKey: 'pgr_test_0000000001',
    })).rejects.toThrow();
  });
});

describe('webhook signature verification (HMAC-SHA256 over raw body)', () => {
  it('accepts a known-good vector for both adapters', () => {
    const signature = sign(BODY, SECRET);
    expect(dryRunAdapter.verifyWebhookSignature(Buffer.from(BODY), signature, SECRET)).toBe(true);
    expect(razorpayAdapter.verifyWebhookSignature(Buffer.from(BODY), signature, SECRET)).toBe(true);
    // String bodies verify identically to Buffers (same bytes).
    expect(verifyHmacSha256Signature(BODY, signature, SECRET)).toBe(true);
  });

  it('rejects a signature computed with a different secret', () => {
    const wrong = sign(BODY, 'a-different-secret-000000000000');
    expect(verifyHmacSha256Signature(BODY, wrong, SECRET)).toBe(false);
  });

  it('rejects when a single body byte differs (raw-body binding)', () => {
    const signature = sign(BODY, SECRET);
    expect(verifyHmacSha256Signature(`${BODY} `, signature, SECRET)).toBe(false);
  });

  it('fails closed on malformed inputs — never throws, never verifies', () => {
    const signature = sign(BODY, SECRET);
    expect(verifyHmacSha256Signature(BODY, null, SECRET)).toBe(false);
    expect(verifyHmacSha256Signature(BODY, '', SECRET)).toBe(false);
    expect(verifyHmacSha256Signature(BODY, 'zz'.repeat(32), SECRET)).toBe(false); // non-hex
    expect(verifyHmacSha256Signature(BODY, signature.slice(0, 32), SECRET)).toBe(false); // truncated
    expect(verifyHmacSha256Signature(BODY, signature, '')).toBe(false); // no secret
    expect(verifyHmacSha256Signature(null, signature, SECRET)).toBe(false); // no body
  });

  it('uses a timing-safe comparison', () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    verifyHmacSha256Signature(BODY, sign(BODY, SECRET), SECRET);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('fingerprints the exact signed bytes', () => {
    expect(sha256Hex(BODY)).toBe(crypto.createHash('sha256').update(BODY).digest('hex'));
    expect(sha256Hex(BODY)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('razorpay adapter (provider HTTP mocked)', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  function mockFetchOnce(status, json) {
    global.fetch = jest.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    }));
    return global.fetch;
  }

  it('creates an order with paise on the wire and Basic auth', async () => {
    const fetchMock = mockFetchOnce(200, {
      id: 'order_R1', amount: 50000, currency: 'INR', receipt: 'pg-r1', status: 'created',
    });
    const order = await razorpayAdapter.createOrder({
      keyId: 'rzp_test_key', keySecret: 'rzp_test_secret',
      amountPaise: 50000, receipt: 'pg-r1',
    });
    expect(order.providerOrderId).toBe('order_R1');
    expect(order.amountPaise).toBe(50000);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.razorpay.com/v1/orders');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from('rzp_test_key:rzp_test_secret').toString('base64')}`,
    );
    const sent = JSON.parse(init.body);
    expect(sent.amount).toBe(50000); // paise integer, never rupees
    expect(sent.receipt).toBe('pg-r1');
  });

  it('recovers exactly one provider order by its durable receipt', async () => {
    const fetchMock = mockFetchOnce(200, {
      items: [{
        id: 'order_R1', amount: 50000, currency: 'INR', receipt: 'pg-r1', status: 'created',
      }],
    });
    const order = await razorpayAdapter.findOrderByReceipt({
      keyId: 'rzp_test_key', keySecret: 'rzp_test_secret', receipt: 'pg-r1',
    });
    expect(order).toMatchObject({
      providerOrderId: 'order_R1', amountPaise: 50000, currency: 'INR',
      receipt: 'pg-r1', status: 'created',
    });
    expect(fetchMock.mock.calls[0][0])
      .toBe('https://api.razorpay.com/v1/orders?receipt=pg-r1&count=10');
  });

  it('fails closed when provider receipt recovery is ambiguous', async () => {
    mockFetchOnce(200, {
      items: [
        { id: 'order_R1', receipt: 'pg-r1' },
        { id: 'order_R2', receipt: 'pg-r1' },
      ],
    });
    await expect(razorpayAdapter.findOrderByReceipt({
      keyId: 'rzp_test_key', keySecret: 'rzp_test_secret', receipt: 'pg-r1',
    })).rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_ORDER_RECOVERY_AMBIGUOUS' });
  });

  it('creates a refund against the original provider payment id', async () => {
    const fetchMock = mockFetchOnce(200, {
      id: 'rfnd_R1', payment_id: 'pay_R9', amount: 20000, currency: 'INR', status: 'pending',
    });
    const refund = await razorpayAdapter.createRefund({
      keyId: 'rzp_test_key', keySecret: 'rzp_test_secret',
      providerPaymentId: 'pay_R9', amountPaise: 20000, receipt: 'pgr-7',
      idempotencyKey: 'pgr_test_0000000001',
    });
    expect(refund.providerRefundId).toBe('rfnd_R1');
    expect(refund).toMatchObject({
      providerPaymentId: 'pay_R9', amountPaise: 20000, currency: 'INR',
    });
    expect(refund.status).toBe('pending');
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.razorpay.com/v1/payments/pay_R9/refund');
    expect(fetchMock.mock.calls[0][1].headers['X-Refund-Idempotency'])
      .toBe('pgr_test_0000000001');
  });

  it('treats a refund response without a provider id as unresolved', async () => {
    mockFetchOnce(200, { amount: 20000, status: 'pending' });
    await expect(razorpayAdapter.createRefund({
      keyId: 'rzp_test_key', keySecret: 'rzp_test_secret',
      providerPaymentId: 'pay_R9', amountPaise: 20000, receipt: 'pgr-7',
      idempotencyKey: 'pgr_test_0000000001',
    })).rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_UPSTREAM_UNRESOLVED', statusCode: 502 });
  });

  it('maps a provider 4xx to a clean AppError without leaking internals', async () => {
    mockFetchOnce(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'amount exceeds captured' } });
    await expect(razorpayAdapter.createOrder({
      keyId: 'k', keySecret: 's', amountPaise: 100, receipt: 'r',
    })).rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_PROVIDER_ERROR', statusCode: 400 });
  });

  it('classifies a concurrent idempotent refund as still in progress', async () => {
    mockFetchOnce(409, { error: { code: 'BAD_REQUEST_ERROR', description: 'request in progress' } });
    await expect(razorpayAdapter.createRefund({
      keyId: 'k', keySecret: 's', providerPaymentId: 'pay_R9',
      amountPaise: 100, receipt: 'pgr-9', idempotencyKey: 'pgr_test_0000000001',
    })).rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_REFUND_IN_PROGRESS', statusCode: 409 });
  });

  it('refuses to call the provider without credentials', async () => {
    const fetchMock = mockFetchOnce(200, {});
    await expect(razorpayAdapter.createOrder({ amountPaise: 100, receipt: 'r' }))
      .rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_CREDENTIALS_MISSING' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
