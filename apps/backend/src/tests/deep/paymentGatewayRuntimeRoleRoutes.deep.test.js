/**
 * Payment webhook + public /pay regression under a real NOBYPASSRLS role.
 *
 * The Prisma connection starts every session as rls_http_test_app. This makes
 * migration 726's FORCE + restrictive policies effective on the actual route
 * and service queries instead of relying on the owner/superuser test posture.
 */
import crypto, { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import express from 'express';
import pg from 'pg';
import request from 'supertest';

jest.setTimeout(60_000);

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const RUNTIME_ROLE = 'rls_http_test_app';
const WEBHOOK_SECRET = 'runtime-role-webhook-fixture';

const assertSharedReplayOnce = jest.fn(async () => true);
jest.unstable_mockModule('../../utils/signedRequest.js', () => ({
  assertSharedReplayOnce,
}));

function token() {
  return randomUUID().replaceAll('-', '');
}

function legacyEncryptedField(plaintext) {
  const key = crypto.scryptSync(
    process.env.FIELD_ENCRYPTION_KEY,
    'vh-field-encryption-v1',
    32,
  );
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

describeIfDb('payment gateway public routes under NOBYPASSRLS', () => {
  let owner;
  let prisma;
  let router;
  let getPublicPaymentLinkView;
  let tenantId;
  let configId;
  let webhookToken;
  let paymentLinkToken;
  let paymentLinkId;
  let authorizedOrder;
  let failedOrder;
  let captureMismatchOrder;
  let publicOrder;
  let refundOrder;
  let processedRefund;
  let failedRefund;

  const savedEnv = {
    databaseUrl: process.env.DATABASE_URL,
    enforceRls: process.env.AUTH_ENFORCE_TENANT_RLS,
    paymentGateway: process.env.PAYMENT_GATEWAY_ENABLED,
    runtimeRole: process.env.AUTH_TENANT_RLS_RUNTIME_ROLE,
    testRole: process.env.AUTH_TENANT_RLS_TEST_ROLE,
  };

  async function asOwnerTenant(fn) {
    await owner.query('BEGIN');
    try {
      await owner.query(
        "SELECT set_config('app.current_tenant_id', $1, true)",
        [tenantId],
      );
      const result = await fn(owner);
      await owner.query('COMMIT');
      return result;
    } catch (err) {
      await owner.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  async function insertOrder(client, {
    providerOrderId, status = 'created', paymentLink = null,
  }) {
    const result = await client.query(
      `INSERT INTO payment_gateway_orders
         (tenant_id, provider, environment, provider_config_id, patient_uid,
          payment_link_id, amount, currency, receipt, provider_order_id, status,
          webhook_credential_version)
       VALUES ($1::uuid, 'dry_run', 'sandbox', $2::int, $3::uuid,
               $4::int, 500.00, 'INR', $5::text, $6::text, $7::text, 1)
       RETURNING id`,
      [
        tenantId,
        configId,
        randomUUID(),
        paymentLink,
        `receipt-${token().slice(0, 20)}`,
        providerOrderId,
        status,
      ],
    );
    return Number(result.rows[0].id);
  }

  async function insertRefund(client, { gatewayOrderId, suffix }) {
    const providerPaymentId = `pay_runtime_${suffix}`;
    const providerRefundId = `rfnd_runtime_${suffix}`;
    const approvedBy = randomUUID();
    const billingRefund = await client.query(
      `INSERT INTO billing_refunds
         (tenant_id, patient_uid, amount, reason, mode, approval_status,
          raised_by, raised_at, approved_by, approved_at)
       VALUES ($1::uuid, $2::uuid, 150.00, $3::text, 'UPI', 'APPROVED',
               $4::uuid, NOW() - INTERVAL '2 minutes',
               $5::uuid, NOW() - INTERVAL '1 minute')
       RETURNING id`,
      [
        tenantId,
        randomUUID(),
        `Runtime-role ${suffix}`,
        randomUUID(),
        approvedBy,
      ],
    );
    const billingRefundId = Number(billingRefund.rows[0].id);
    const result = await client.query(
      `INSERT INTO payment_gateway_refunds
         (tenant_id, provider, environment, gateway_order_id,
          provider_payment_id, provider_refund_id, provider_idempotency_key,
          amount, currency, status, webhook_credential_version,
          billing_refund_id, initiated_by, initiated_at)
       VALUES ($1::uuid, 'dry_run', 'sandbox', $2::int,
               $3::text, $4::text, $5::text,
               150.00, 'INR', 'pending', 1,
               $6::int, $7::uuid, NOW())
       RETURNING id`,
      [
        tenantId,
        gatewayOrderId,
        providerPaymentId,
        providerRefundId,
        `pgr_runtime_${suffix}_${token().slice(0, 16)}`,
        billingRefundId,
        randomUUID(),
      ],
    );
    const id = Number(result.rows[0].id);
    await client.query(
      `UPDATE billing_refunds
          SET payout_rail = 'gateway', payout_rail_claimed_at = NOW(),
              gateway_refund_id = $1::int, updated_at = NOW()
        WHERE tenant_id = $2::uuid AND id = $3::int`,
      [id, tenantId, billingRefundId],
    );
    return {
      id,
      billingRefundId,
      providerPaymentId,
      providerRefundId,
    };
  }

  function app() {
    const instance = express();
    instance.use(express.json({
      verify: (req, _res, body) => {
        req.paymentGatewayRawBody = Buffer.from(body);
      },
    }));
    instance.use('/webhooks/payments', router);
    return instance;
  }

  function signedPost(payload, eventId) {
    const raw = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
    return request(app())
      .post(`/webhooks/payments/${webhookToken}`)
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', signature)
      .set('x-razorpay-event-id', eventId)
      .send(raw);
  }

  async function orderState(id) {
    const result = await asOwnerTenant((client) => client.query(
      `SELECT status, provider_payment_id, captured_at
         FROM payment_gateway_orders
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      [tenantId, id],
    ));
    return result.rows[0] || null;
  }

  async function refundState(id) {
    const result = await asOwnerTenant((client) => client.query(
      `SELECT status, processed_at, failed_at, failure_code
         FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      [tenantId, id],
    ));
    return result.rows[0] || null;
  }

  beforeAll(async () => {
    owner = new pg.Client({ connectionString: databaseUrl });
    await owner.connect();

    const role = await owner.query(
      `SELECT rolsuper, rolbypassrls
         FROM pg_roles
        WHERE rolname = $1`,
      [RUNTIME_ROLE],
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });

    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.searchParams.append('options', `-c role=${RUNTIME_ROLE}`);
    process.env.DATABASE_URL = runtimeUrl.toString();
    process.env.AUTH_ENFORCE_TENANT_RLS = 'true';
    process.env.PAYMENT_GATEWAY_ENABLED = 'true';
    delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    delete process.env.AUTH_TENANT_RLS_TEST_ROLE;

    tenantId = randomUUID();
    webhookToken = token();
    paymentLinkToken = token();
    await owner.query(
      `INSERT INTO tenants (id, slug, name, settings)
       VALUES ($1::uuid, $2::text, 'Payment runtime-role regression',
               '{"paymentGateway":{"enabled":true}}'::jsonb)`,
      [tenantId, `payment-runtime-${token()}`],
    );

    await asOwnerTenant(async (client) => {
      const config = await client.query(
        `INSERT INTO payment_gateway_provider_configs
           (tenant_id, provider, environment, enabled,
            webhook_secret_ciphertext, metadata)
         VALUES ($1::uuid, 'dry_run', 'sandbox', true, $2::text,
                 jsonb_build_object('webhook_token', $3::text))
         RETURNING id`,
        [tenantId, legacyEncryptedField(WEBHOOK_SECRET), webhookToken],
      );
      configId = Number(config.rows[0].id);

      const link = await client.query(
        `INSERT INTO billing_payment_links
           (link_token, patient_uid, amount, currency, status, expires_at,
            upi_payee_vpa, upi_payee_name, upi_deep_link, tenant_id)
         VALUES ($1::text, $2::uuid, 500.00, 'INR', 'sent',
                 NOW() + INTERVAL '1 day', 'hospital@upi', 'Runtime Hospital',
                 'upi://pay?pa=hospital@upi&am=500.00&cu=INR', $3::uuid)
         RETURNING id`,
        [paymentLinkToken, randomUUID(), tenantId],
      );
      paymentLinkId = Number(link.rows[0].id);

      authorizedOrder = await insertOrder(client, {
        providerOrderId: `order_runtime_authorized_${token().slice(0, 12)}`,
      });
      failedOrder = await insertOrder(client, {
        providerOrderId: `order_runtime_failed_${token().slice(0, 12)}`,
        status: 'attempted',
      });
      captureMismatchOrder = await insertOrder(client, {
        providerOrderId: `order_runtime_capture_${token().slice(0, 12)}`,
      });
      publicOrder = await insertOrder(client, {
        providerOrderId: `order_runtime_public_${token().slice(0, 12)}`,
        paymentLink: paymentLinkId,
      });
      refundOrder = await insertOrder(client, {
        providerOrderId: `order_runtime_refund_${token().slice(0, 12)}`,
        status: 'attempted',
      });
      processedRefund = await insertRefund(client, {
        gatewayOrderId: refundOrder,
        suffix: `processed_${token().slice(0, 10)}`,
      });
      failedRefund = await insertRefund(client, {
        gatewayOrderId: refundOrder,
        suffix: `failed_${token().slice(0, 10)}`,
      });
    });

    ({ default: prisma } = await import('../../lib/prisma.js'));
    ({ default: router } = await import('../../routes/billing/paymentGatewayWebhookRoutes.js'));
    ({ getPublicPaymentLinkView } = await import('../../services/billing/paymentLinkService.js'));
  });

  afterAll(async () => {
    if (owner && tenantId) {
      await asOwnerTenant(async (client) => {
        await client.query('DELETE FROM payment_gateway_webhook_events WHERE tenant_id = $1::uuid', [tenantId]);
        await client.query('DELETE FROM payment_gateway_refunds WHERE tenant_id = $1::uuid', [tenantId]);
        await client.query('DELETE FROM billing_refunds WHERE tenant_id = $1::uuid', [tenantId]);
        await client.query('DELETE FROM payment_gateway_orders WHERE tenant_id = $1::uuid', [tenantId]);
        await client.query('DELETE FROM payment_gateway_provider_configs WHERE tenant_id = $1::uuid', [tenantId]);
        await client.query('DELETE FROM billing_payment_links WHERE tenant_id = $1::uuid', [tenantId]);
      }).catch(() => {});
      await owner.query('DELETE FROM tenants WHERE id = $1::uuid', [tenantId]).catch(() => {});
    }
    await owner?.end().catch(() => {});
    if (savedEnv.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedEnv.databaseUrl;
    if (savedEnv.enforceRls === undefined) delete process.env.AUTH_ENFORCE_TENANT_RLS;
    else process.env.AUTH_ENFORCE_TENANT_RLS = savedEnv.enforceRls;
    if (savedEnv.paymentGateway === undefined) delete process.env.PAYMENT_GATEWAY_ENABLED;
    else process.env.PAYMENT_GATEWAY_ENABLED = savedEnv.paymentGateway;
    if (savedEnv.runtimeRole === undefined) delete process.env.AUTH_TENANT_RLS_RUNTIME_ROLE;
    else process.env.AUTH_TENANT_RLS_RUNTIME_ROLE = savedEnv.runtimeRole;
    if (savedEnv.testRole === undefined) delete process.env.AUTH_TENANT_RLS_TEST_ROLE;
    else process.env.AUTH_TENANT_RLS_TEST_ROLE = savedEnv.testRole;
  });

  it('runs the actual Prisma connection as a sealed NOBYPASSRLS role', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT current_user, session_user,
              current_setting('app.current_tenant_id', true) AS tenant_guc`,
    );
    expect(rows[0]).toEqual(expect.objectContaining({
      current_user: RUNTIME_ROLE,
      tenant_guc: null,
    }));
  });

  it('keeps the resolved tenant through payment.authorized dispatch', async () => {
    const providerOrderId = (await asOwnerTenant((client) => client.query(
      'SELECT provider_order_id FROM payment_gateway_orders WHERE id = $1::int',
      [authorizedOrder],
    ))).rows[0].provider_order_id;
    const response = await signedPost({
      event: 'payment.authorized',
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { order_id: providerOrderId, method: 'upi' } } },
    }, `evt-authorized-${token()}`);

    expect(response.status).toBe(200);
    expect(response.body.data.outcome).toBe('attempt_recorded');
    expect((await orderState(authorizedOrder)).status).toBe('attempted');
  });

  it('keeps the resolved tenant through payment.failed dispatch', async () => {
    const providerOrderId = (await asOwnerTenant((client) => client.query(
      'SELECT provider_order_id FROM payment_gateway_orders WHERE id = $1::int',
      [failedOrder],
    ))).rows[0].provider_order_id;
    const response = await signedPost({
      event: 'payment.failed',
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: {
        order_id: providerOrderId,
        error_code: 'BAD_REQUEST_ERROR',
        error_description: 'provider rejected payment',
      } } },
    }, `evt-failed-${token()}`);

    expect(response.status).toBe(200);
    expect(response.body.data.outcome).toBe('failed_recorded');
    expect((await orderState(failedOrder)).status).toBe('failed');
  });

  it('keeps tenant context through capture mismatch reconciliation parking', async () => {
    const providerOrderId = (await asOwnerTenant((client) => client.query(
      'SELECT provider_order_id FROM payment_gateway_orders WHERE id = $1::int',
      [captureMismatchOrder],
    ))).rows[0].provider_order_id;
    const response = await signedPost({
      event: 'payment.captured',
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: {
        id: `pay_runtime_capture_${token().slice(0, 10)}`,
        order_id: providerOrderId,
        method: 'upi',
        amount: 49_999,
        currency: 'INR',
      } } },
    }, `evt-capture-${token()}`);

    expect(response.status).toBe(200);
    expect(response.body.data.outcome).toBe('requires_reconciliation');
    const state = await orderState(captureMismatchOrder);
    expect(state.status).toBe('requires_reconciliation');
    expect(state.provider_payment_id).toMatch(/^pay_runtime_capture_/);
    expect(state.captured_at).not.toBeNull();
  });

  it('keeps the resolved tenant through refund.processed dispatch', async () => {
    const response = await signedPost({
      event: 'refund.processed',
      created_at: Math.floor(Date.now() / 1000),
      payload: { refund: { entity: {
        id: processedRefund.providerRefundId,
        payment_id: processedRefund.providerPaymentId,
        amount: 15_000,
        currency: 'INR',
        status: 'processed',
        notes: { billing_refund_id: String(processedRefund.billingRefundId) },
      } } },
    }, `evt-refund-processed-${token()}`);

    expect(response.status).toBe(200);
    expect(response.body.data.outcome).toBe('refund_processed');
    const state = await refundState(processedRefund.id);
    expect(state.status).toBe('processed');
    expect(state.processed_at).not.toBeNull();
  });

  it('keeps the resolved tenant through refund.failed dispatch', async () => {
    const response = await signedPost({
      event: 'refund.failed',
      created_at: Math.floor(Date.now() / 1000),
      payload: { refund: { entity: {
        id: failedRefund.providerRefundId,
        payment_id: failedRefund.providerPaymentId,
        amount: 15_000,
        currency: 'INR',
        status: 'failed',
        notes: { billing_refund_id: String(failedRefund.billingRefundId) },
        error_code: 'BAD_REQUEST_ERROR',
        error_description: 'provider rejected refund',
      } } },
    }, `evt-refund-failed-${token()}`);

    expect(response.status).toBe(200);
    expect(response.body.data.outcome).toBe('refund_failed_recorded');
    const state = await refundState(failedRefund.id);
    expect(state.status).toBe('failed');
    expect(state.failed_at).not.toBeNull();
    expect(state.failure_code).toBe('BAD_REQUEST_ERROR');
  });

  it('resolves the public /pay gateway config and active order under FORCE RLS', async () => {
    const providerOrderId = (await asOwnerTenant((client) => client.query(
      'SELECT provider_order_id FROM payment_gateway_orders WHERE id = $1::int',
      [publicOrder],
    ))).rows[0].provider_order_id;

    const view = await getPublicPaymentLinkView({ link_token: paymentLinkToken });

    expect(view).not.toBeNull();
    expect(view.gateway).toEqual({
      enabled: true,
      provider: 'dry_run',
      keyId: null,
      providerOrderId,
    });
  });
});
