// apps/backend/src/tests/paymentGatewayRefund.deep.test.js
//
// Gateway refund execution leg against a real database (migration 697):
// authority stays in billing_refunds (raiseRefund → approveRefund →
// markRefundPaid); the gateway adds only the provider execution row. The
// exact refund.processed evidence drives markRefundPaid with reference =
// provider_refund_id, posting the ledger REFUND_PAID entry under enforce
// wiring; replays touch nothing twice, and one live execution leg per
// billing refund is DB-enforced. dry_run provider — zero credentials.

import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import prisma from '../lib/prisma.js';
import * as billingService from '../services/billing/billingV2Service.js';
import * as gatewayService from '../services/billing/paymentGatewayService.js';
import dryRunAdapter from '../services/billing/gatewayProviders/dryRunAdapter.js';
import { toPaise } from '../utils/money.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const CROSS_TENANT = randomUUID();
const CROSS_TENANT_SLUG = `pg-refund-cross-${CROSS_TENANT.slice(0, 8)}`;
const cleanup = { invoiceIds: [], patientUids: [], orderIds: [], refundIds: [] };
let prevLedgerMode;
let prevGatewayEnabled;
let config;
let refundApprover;
let refundPayoutActor;

const billing = {
  ...billingService,
  approveRefund: (id, args = {}) => billingService.approveRefund(id, {
      ...args,
      approved_by: args.approved_by || refundApprover,
  }),
};

const gateway = {
  ...gatewayService,
  initiateGatewayRefund: args => gatewayService.initiateGatewayRefund({
      ...args,
      initiated_by: args?.initiated_by || refundPayoutActor,
  }),
};

async function makeTenantUser(role = 'PATIENT') {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at)
     VALUES ($1::uuid, $2, 'PG Refund', $3, $4::uuid, NOW())`,
    uid, phone, role, TENANT,
  );
  cleanup.patientUids.push(uid);
  return uid;
}

async function makePatient() {
  return makeTenantUser('PATIENT');
}

async function makeCapturedGatewayPayment(patient, total) {
  const inv = await billing.createDraftInvoice({ patient_uid: patient, invoice_type: 'OP', tenantId: TENANT });
  await billing.addInvoiceItem(inv.id, {
    description: 'Procedure', quantity: 1, unit_price: total, gst_rate: 0, tenantId: TENANT,
  });
  await billing.issueInvoice(inv.id, { tenantId: TENANT });
  cleanup.invoiceIds.push(inv.id);

  const order = await gateway.createGatewayOrder({
    tenantId: TENANT, invoice_id: inv.id, actor: { uid: patient, role: 'PATIENT' },
  });
  cleanup.orderIds.push(order.orderId);

  const providerPaymentId = `pay_dry_${randomUUID().slice(0, 8)}`;
  const result = await gateway.handleCaptureEvent({
    tenantId: TENANT, config, event: { event_type: 'payment.captured' },
    payload: {
      event: 'payment.captured',
      payload: { payment: { entity: {
        id: providerPaymentId, order_id: order.providerOrderId, method: 'upi',
        amount: toPaise(total), currency: 'INR',
      } } },
    },
  });
  expect(result.outcome).toBe('captured');
  return { invoiceId: inv.id, orderId: order.orderId, providerPaymentId };
}

beforeAll(async () => {
  if (!DB_CONFIGURED) return;
  prevLedgerMode = process.env.LEDGER_AUTHORITATIVE_MODE;
  prevGatewayEnabled = process.env.PAYMENT_GATEWAY_ENABLED;
  process.env.LEDGER_AUTHORITATIVE_MODE = 'enforce';
  process.env.PAYMENT_GATEWAY_ENABLED = 'true';
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2::varchar, 'PG refund cross-tenant fixture')`,
    CROSS_TENANT, CROSS_TENANT_SLUG,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE tenants
        SET settings = COALESCE(settings, '{}'::jsonb)
                       || '{"paymentGateway":{"enabled":true}}'::jsonb
      WHERE id = $1::uuid`,
    TENANT,
  );
  config = await gateway.upsertGatewayConfig({
    tenantId: TENANT, provider: 'dry_run', environment: 'sandbox', enabled: true,
    webhook_secret: 'test-webhook-secret-000000000000',
  });
  refundApprover = await makeTenantUser('ADMIN');
  refundPayoutActor = await makeTenantUser('FINANCE_INCHARGE');
});

afterAll(async () => {
  if (!DB_CONFIGURED) { await prisma.$disconnect().catch(() => {}); return; }
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
      const entryRows = await tx.$queryRawUnsafe(
        `SELECT DISTINCT entry_id AS id FROM ledger_postings
          WHERE invoice_id = ANY($1::int[]) OR patient_uid = ANY($2::uuid[])`,
        cleanup.invoiceIds, cleanup.patientUids,
      );
      const entryIds = entryRows.map((r) => Number(r.id));
      if (entryIds.length) {
        await tx.$executeRawUnsafe(`DELETE FROM ledger_postings WHERE entry_id = ANY($1::bigint[])`, entryIds);
        await tx.$executeRawUnsafe(`DELETE FROM ledger_entries WHERE id = ANY($1::bigint[])`, entryIds);
      }
      await tx.$executeRawUnsafe(`DELETE FROM payment_gateway_webhook_events WHERE tenant_id = $1::uuid`, TENANT);
      if (cleanup.refundIds.length) {
        await tx.$executeRawUnsafe(
        `UPDATE billing_refunds
            SET payout_rail = NULL, payout_rail_claimed_at = NULL, gateway_refund_id = NULL
          WHERE id = ANY($1::int[])`,
        cleanup.refundIds,
        );
      }
      await tx.$executeRawUnsafe(`DELETE FROM payment_gateway_refunds WHERE tenant_id = $1::uuid`, TENANT);
      if (cleanup.orderIds.length) {
        await tx.$executeRawUnsafe(`DELETE FROM payment_gateway_orders WHERE id = ANY($1::int[])`, cleanup.orderIds);
      }
      if (cleanup.refundIds.length) {
        await tx.$executeRawUnsafe(`DELETE FROM billing_refunds WHERE id = ANY($1::int[])`, cleanup.refundIds);
      }
      if (cleanup.invoiceIds.length) {
        await tx.$executeRawUnsafe(`DELETE FROM billing_payments WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
        await tx.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
        await tx.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
      }
      await tx.$executeRawUnsafe(`DELETE FROM payment_gateway_provider_configs WHERE tenant_id = $1::uuid`, TENANT);
      await tx.$executeRawUnsafe(`UPDATE tenants SET settings = settings - 'paymentGateway' WHERE id = $1::uuid`, TENANT);
      if (cleanup.patientUids.length) {
        await tx.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
      }
      await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, CROSS_TENANT);
    });
  } catch { /* best-effort teardown */ }
  if (prevLedgerMode === undefined) delete process.env.LEDGER_AUTHORITATIVE_MODE;
  else process.env.LEDGER_AUTHORITATIVE_MODE = prevLedgerMode;
  if (prevGatewayEnabled === undefined) delete process.env.PAYMENT_GATEWAY_ENABLED;
  else process.env.PAYMENT_GATEWAY_ENABLED = prevGatewayEnabled;
  await prisma.$disconnect().catch(() => {});
}, 30_000);

d('payment gateway refund execution leg (deep)', () => {
  it('correlates an immediate processed response by provider config id, not gateway order id', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(patient, 325);
    const [order] = await prisma.$queryRawUnsafe(
      `SELECT id, provider_config_id FROM payment_gateway_orders
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      orderId, TENANT,
    );
    expect(Number(order.id)).toBe(orderId);
    expect(Number(order.provider_config_id)).toBe(Number(config.id));

    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 125, reason: 'synchronous processed refund', mode: 'UPI', tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, { tenantId: TENANT });

    const createRefundSpy = jest.spyOn(dryRunAdapter, 'createRefund').mockImplementationOnce(async (args) => ({
      providerRefundId: `rfnd_dry_${args.receipt}`,
      providerPaymentId: args.providerPaymentId,
      amountPaise: args.amountPaise,
      currency: 'INR',
      status: 'processed',
    }));
    try {
      const leg = await gateway.initiateGatewayRefund({
        tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
      });
      expect(leg.status).toBe('processed');

      const [authority] = await prisma.$queryRawUnsafe(
        `SELECT approval_status, payout_rail, gateway_refund_id, reference
           FROM billing_refunds WHERE id = $1::int AND tenant_id = $2::uuid`,
        Number(refund.id), TENANT,
      );
      expect(authority).toMatchObject({
        approval_status: 'PAID',
        payout_rail: 'gateway',
        gateway_refund_id: Number(leg.id),
        reference: leg.provider_refund_id,
      });
    } finally {
      createRefundSpy.mockRestore();
    }
  });

  it('APPROVED refund → provider execution row → processed webhook drives markRefundPaid + ledger REFUND_PAID; replay is inert', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(patient, 400);

    // Authority: billingV2 lifecycle.
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 150, reason: 'deep-test refund', mode: 'UPI', tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, { tenantId: TENANT });

    // Execution leg: provider refund against the original capture.
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
    });
    expect(leg.status).toBe('pending');
    expect(leg.provider_refund_id).toMatch(/^rfnd_dry_pgr-[a-f0-9]{32}$/);
    expect(Number(leg.gateway_order_id)).toBe(orderId);
    expect(leg.provider_payment_id).toBe(providerPaymentId);
    expect(Number(leg.amount)).toBe(150);

    // One live execution leg per billing refund: a re-initiation (operator
    // retry / second tab) is an idempotent replay of the EXISTING row — the
    // provider is never called a second time and no second row appears.
    const replayLeg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
    });
    expect(replayLeg.replay).toBe(true);
    expect(Number(replayLeg.id)).toBe(Number(leg.id));
    const legCount = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid AND billing_refund_id = $2::int`,
      TENANT, Number(refund.id),
    );
    expect(legCount[0].n).toBe(1);

    // refund.processed webhook.
    const payload = {
      event: 'refund.processed',
      payload: { refund: { entity: {
        id: leg.provider_refund_id, payment_id: providerPaymentId, amount: toPaise(150),
        currency: 'INR', status: 'processed', notes: { billing_refund_id: String(refund.id) },
      } } },
    };
    const processed = await gateway.handleRefundProcessedEvent({ tenantId: TENANT, config, payload });
    expect(processed.outcome).toBe('refund_processed');

    // billing authority reached PAID with the provider refund id as reference.
    const refundRows = await prisma.$queryRawUnsafe(
      `SELECT approval_status, reference FROM billing_refunds WHERE id = $1::int`, Number(refund.id),
    );
    expect(refundRows[0].approval_status).toBe('PAID');
    expect(refundRows[0].reference).toBe(leg.provider_refund_id);

    // execution leg carries the processed evidence (697 CHECK satisfied).
    const legRows = await prisma.$queryRawUnsafe(
      `SELECT status, processed_at FROM payment_gateway_refunds WHERE id = $1::int`, Number(leg.id),
    );
    expect(legRows[0].status).toBe('processed');
    expect(legRows[0].processed_at).not.toBeNull();

    // enforce wiring → REFUND_PAID posted under its idempotency key, once.
    const entries = await prisma.$queryRawUnsafe(
      `SELECT id FROM ledger_entries WHERE idempotency_key = $1`, `refund-paid-${refund.id}`,
    );
    expect(entries.length).toBe(1);

    // Redelivery: replay, nothing re-runs, still one ledger entry.
    const replay = await gateway.handleRefundProcessedEvent({ tenantId: TENANT, config, payload });
    expect(replay.outcome).toBe('replay');
    const entriesAfter = await prisma.$queryRawUnsafe(
      `SELECT id FROM ledger_entries WHERE idempotency_key = $1`, `refund-paid-${refund.id}`,
    );
    expect(entriesAfter.length).toBe(1);
  });

  it('rolls provider processed state back when the billing PAID transition fails', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(patient, 275);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId,
      amount: 80,
      reason: 'atomic gateway rollback proof',
      mode: 'UPI',
      tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, { tenantId: TENANT });
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT,
      billing_refund_id: refund.id,
      gateway_order_id: orderId,
    });
    const payload = { payload: { refund: { entity: {
      id: leg.provider_refund_id,
      payment_id: providerPaymentId,
      amount: toPaise(80),
      currency: 'INR',
      status: 'processed',
      notes: { billing_refund_id: String(refund.id) },
    } } } };
    const functionName = `codex_gateway_atomic_rollback_${Number(refund.id)}`;
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION ${functionName}()
       RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
       BEGIN
         IF OLD.id = ${Number(refund.id)} AND NEW.approval_status = 'PAID' THEN
           RAISE EXCEPTION 'forced atomic gateway billing failure';
         END IF;
         RETURN NEW;
       END
       $fn$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER ${functionName}
       BEFORE UPDATE ON billing_refunds
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );
    try {
      await expect(gateway.handleRefundProcessedEvent({ tenantId: TENANT, config, payload }))
        .rejects.toThrow(/forced atomic gateway billing failure/i);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER ${functionName} ON billing_refunds`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION ${functionName}()`);
    }

    const [afterFailure] = await prisma.$queryRawUnsafe(
      `SELECT execution.status, execution.provider_refund_id, execution.processed_at,
              authority.approval_status
         FROM payment_gateway_refunds execution
         JOIN billing_refunds authority
           ON authority.tenant_id = execution.tenant_id
          AND authority.id = execution.billing_refund_id
        WHERE execution.tenant_id = $1::uuid AND execution.id = $2::int`,
      TENANT,
      Number(leg.id),
    );
    expect(afterFailure).toMatchObject({
      status: 'pending',
      provider_refund_id: leg.provider_refund_id,
      processed_at: null,
      approval_status: 'APPROVED',
    });

    await expect(gateway.handleRefundProcessedEvent({ tenantId: TENANT, config, payload }))
      .resolves.toMatchObject({ outcome: 'refund_processed', gatewayRefundId: Number(leg.id) });
  });

  it('settles later exact processed evidence after preserving a manual reconciliation audit', async () => {
    const actor = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(actor, 240);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 90, reason: 'late processed provider evidence', mode: 'UPI', tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, { tenantId: TENANT });
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
    });
    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET status = 'requires_reconciliation',
              failure_code = 'provider_status_unknown',
              failure_reason = 'Provider status required operator review',
              updated_at = NOW()
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(leg.id), TENANT,
    );
    const note = 'Provider portal showed pending during the original operator review';
    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET reconciled_at = NOW(), reconciliation_note = $1,
              reconciled_by = $2::uuid, updated_at = NOW()
        WHERE id = $3::int AND tenant_id = $4::uuid`,
      note, actor, Number(leg.id), TENANT,
    );

    const processed = await gateway.handleRefundProcessedEvent({
      tenantId: TENANT,
      config,
      payload: { payload: { refund: { entity: {
        id: leg.provider_refund_id,
        payment_id: providerPaymentId,
        amount: toPaise(90),
        currency: 'INR',
        status: 'processed',
        notes: { billing_refund_id: String(refund.id) },
      } } } },
    });
    expect(processed.outcome).toBe('refund_processed');

    const [authority] = await prisma.$queryRawUnsafe(
      `SELECT approval_status, payout_rail, gateway_refund_id, reference
         FROM billing_refunds WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(refund.id), TENANT,
    );
    expect(authority).toMatchObject({
      approval_status: 'PAID',
      payout_rail: 'gateway',
      gateway_refund_id: Number(leg.id),
      reference: leg.provider_refund_id,
    });

    const [updatedLeg] = await prisma.$queryRawUnsafe(
      `SELECT status, reconciled_at, reconciliation_note, reconciled_by, metadata
         FROM payment_gateway_refunds WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(leg.id), TENANT,
    );
    expect(updatedLeg).toMatchObject({
      status: 'processed', reconciled_at: null, reconciliation_note: null, reconciled_by: null,
    });
    expect(updatedLeg.metadata.provider_evidence_superseded_reconciliations).toEqual([
      expect.objectContaining({
        reconciliation_note: note,
        reconciled_by: actor,
        provider_refund_id: leg.provider_refund_id,
        superseded_by: 'exact_provider_processed_evidence',
      }),
    ]);
  });

  it('manual_settled reconciliation requires provider evidence and converges billing plus execution idempotently', async () => {
    const actor = await makePatient();
    const { invoiceId, orderId } = await makeCapturedGatewayPayment(actor, 230);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 85, reason: 'manual provider settlement', mode: 'UPI', tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, { tenantId: TENANT });
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
    });
    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET status = 'requires_reconciliation',
              failure_code = 'provider_status_unknown',
              failure_reason = 'Provider status required operator review',
              updated_at = NOW()
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(leg.id), TENANT,
    );

    const input = {
      tenantId: TENANT,
      id: leg.id,
      disposition: 'manual_settled',
      evidence_reference: leg.provider_refund_id,
      note: 'Provider portal confirms the refund settled under this exact refund identifier',
      resolved_by: actor,
    };
    const settled = await gateway.resolveGatewayRefundReconciliation(input);
    const replay = await gateway.resolveGatewayRefundReconciliation(input);
    expect(settled).toMatchObject({ status: 'processed', replay: false });
    expect(replay).toMatchObject({ id: Number(leg.id), status: 'processed', replay: true });

    const [authority] = await prisma.$queryRawUnsafe(
      `SELECT approval_status, payout_rail, gateway_refund_id, reference
         FROM billing_refunds WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(refund.id), TENANT,
    );
    expect(authority).toMatchObject({
      approval_status: 'PAID',
      payout_rail: 'gateway',
      gateway_refund_id: Number(leg.id),
      reference: leg.provider_refund_id,
    });
    const [execution] = await prisma.$queryRawUnsafe(
      `SELECT status, processed_at, metadata
         FROM payment_gateway_refunds WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(leg.id), TENANT,
    );
    expect(execution.status).toBe('processed');
    expect(execution.processed_at).not.toBeNull();
    expect(execution.metadata.reconciliation_resolutions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        disposition: 'manual_settled',
        evidence_reference: leg.provider_refund_id,
        resolved_by: actor,
        outcome: 'settlement_completed',
      }),
    ]));
  });

  it('provider_not_refunded retains gateway retry ownership and rejects manual electronic release', async () => {
    const actor = await makePatient();
    const retrySource = await makeCapturedGatewayPayment(actor, 260);
    const retryRefund = await billing.raiseRefund({
      invoice_id: retrySource.invoiceId, amount: 65,
      reason: 'provider negative retry path', mode: 'UPI', tenantId: TENANT,
    });
    cleanup.refundIds.push(retryRefund.id);
    await billing.approveRefund(retryRefund.id, { tenantId: TENANT });
    const firstLeg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: retryRefund.id,
      gateway_order_id: retrySource.orderId,
    });
    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET status = 'requires_reconciliation', updated_at = NOW()
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(firstLeg.id), TENANT,
    );
    const closedForRetry = await gateway.resolveGatewayRefundReconciliation({
      tenantId: TENANT,
      id: firstLeg.id,
      disposition: 'provider_not_refunded',
      evidence_reference: 'provider-case-retry-441',
      recovery_path: 'gateway_retry',
      note: 'Provider support confirmed no money left the account; authorize an exact gateway retry',
      resolved_by: actor,
    });
    expect(closedForRetry).toMatchObject({ status: 'failed', replay: false });
    const retryLeg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: retryRefund.id,
      gateway_order_id: retrySource.orderId,
    });
    expect(Number(retryLeg.id)).not.toBe(Number(firstLeg.id));
    let [authority] = await prisma.$queryRawUnsafe(
      `SELECT approval_status, payout_rail, gateway_refund_id
         FROM billing_refunds WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(retryRefund.id), TENANT,
    );
    expect(authority).toMatchObject({
      approval_status: 'APPROVED', payout_rail: 'gateway',
      gateway_refund_id: Number(retryLeg.id),
    });

    const manualSource = await makeCapturedGatewayPayment(actor, 210);
    const manualRefund = await billing.raiseRefund({
      invoice_id: manualSource.invoiceId, amount: 45,
      reason: 'provider negative manual path', mode: 'UPI', tenantId: TENANT,
    });
    cleanup.refundIds.push(manualRefund.id);
    await billing.approveRefund(manualRefund.id, { tenantId: TENANT });
    const manualLeg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: manualRefund.id,
      gateway_order_id: manualSource.orderId,
    });
    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET status = 'requires_reconciliation', updated_at = NOW()
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(manualLeg.id), TENANT,
    );
    const forbiddenManualResolution = {
      tenantId: TENANT,
      id: manualLeg.id,
      disposition: 'provider_not_refunded',
      evidence_reference: 'provider-case-manual-662',
      recovery_path: 'manual_payout',
      note: 'Provider support confirmed no refund; release the approved payout to the cashier',
      resolved_by: actor,
    };
    const [beforeForbidden] = await prisma.$queryRawUnsafe(
      `SELECT status, failure_code, metadata, reconciled_at
         FROM payment_gateway_refunds
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(manualLeg.id), TENANT,
    );
    await expect(gateway.resolveGatewayRefundReconciliation(forbiddenManualResolution))
      .rejects.toMatchObject({
        statusCode: 400,
        code: 'PAYMENT_GATEWAY_REFUND_MANUAL_PAYOUT_FORBIDDEN',
      });
    await expect(gateway.resolveGatewayRefundReconciliation(forbiddenManualResolution))
      .rejects.toMatchObject({
        statusCode: 400,
        code: 'PAYMENT_GATEWAY_REFUND_MANUAL_PAYOUT_FORBIDDEN',
      });
    [authority] = await prisma.$queryRawUnsafe(
      `SELECT approval_status, payout_rail, gateway_refund_id
         FROM billing_refunds WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(manualRefund.id), TENANT,
    );
    expect(authority).toMatchObject({
      approval_status: 'APPROVED', payout_rail: 'gateway',
      gateway_refund_id: Number(manualLeg.id),
    });
    const [afterForbidden] = await prisma.$queryRawUnsafe(
      `SELECT status, failure_code, metadata, reconciled_at
         FROM payment_gateway_refunds
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(manualLeg.id), TENANT,
    );
    expect(afterForbidden).toEqual(beforeForbidden);

    const lateProcessed = await gateway.handleRefundProcessedEvent({
      tenantId: TENANT,
      config,
      payload: { payload: { refund: { entity: {
        id: manualLeg.provider_refund_id,
        payment_id: manualSource.providerPaymentId,
        amount: toPaise(45),
        currency: 'INR',
        status: 'processed',
        notes: { billing_refund_id: String(manualRefund.id) },
      } } } },
    });
    expect(lateProcessed).toMatchObject({
      outcome: 'refund_processed',
      gatewayRefundId: Number(manualLeg.id),
    });
    const lateReplay = await gateway.handleRefundProcessedEvent({
      tenantId: TENANT,
      config,
      payload: { payload: { refund: { entity: {
        id: manualLeg.provider_refund_id,
        payment_id: manualSource.providerPaymentId,
        amount: toPaise(45),
        currency: 'INR',
        status: 'processed',
        notes: { billing_refund_id: String(manualRefund.id) },
      } } } },
    });
    expect(lateReplay).toMatchObject({
      outcome: 'replay',
      gatewayRefundId: Number(manualLeg.id),
    });
    const [lateExecution] = await prisma.$queryRawUnsafe(
      `SELECT status, failure_code
         FROM payment_gateway_refunds
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(manualLeg.id), TENANT,
    );
    expect(lateExecution).toMatchObject({
      status: 'processed',
      failure_code: null,
    });
  });

  it('two concurrent initiations converge on one idempotent provider refund effect', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId } = await makeCapturedGatewayPayment(patient, 300);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 120, reason: 'race refund', mode: 'UPI', tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, { tenantId: TENANT });

    // Both racers reuse the committed provider key and converge on exactly
    // one execution row / provider refund effect.
    const [a, b] = await Promise.all([
      gateway.initiateGatewayRefund({
        tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
      }),
      gateway.initiateGatewayRefund({
        tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
      }),
    ]);
    expect(Number(a.id)).toBe(Number(b.id));
    expect([a.replay, b.replay].filter(Boolean)).toHaveLength(1);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, provider_refund_id FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid AND billing_refund_id = $2::int`,
      TENANT, Number(refund.id),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].provider_refund_id).toMatch(/^rfnd_dry_pgr-[a-f0-9]{32}$/);
  });

  it('serializes manual and gateway payout claims so exactly one rail can win', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId } = await makeCapturedGatewayPayment(patient, 275);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 80, reason: 'rail race refund', mode: 'UPI', tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, { tenantId: TENANT });

    const outcomes = await Promise.allSettled([
      gateway.initiateGatewayRefund({
        tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
      }),
      billing.markRefundPaid(refund.id, {
        tenantId: TENANT, reference: `manual-${randomUUID()}`,
      }),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);

    const [authority] = await prisma.$queryRawUnsafe(
      `SELECT approval_status, payout_rail, gateway_refund_id
         FROM billing_refunds WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(refund.id), TENANT,
    );
    expect(['manual', 'gateway']).toContain(authority.payout_rail);
    if (authority.payout_rail === 'manual') {
      expect(authority.approval_status).toBe('PAID');
      expect(authority.gateway_refund_id).toBeNull();
    } else {
      expect(authority.approval_status).toBe('APPROVED');
      expect(Number(authority.gateway_refund_id)).toBeGreaterThan(0);
      await expect(billing.markRefundPaid(refund.id, {
        tenantId: TENANT, reference: `late-manual-${randomUUID()}`,
      })).rejects.toMatchObject({ code: 'BILLING_REFUND_PAYOUT_RAIL_CONFLICT' });
    }
  });

  it('keeps the manual rail blocked across the provider-call crash window', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(patient, 260);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 70, reason: 'crash-window rail guard', mode: 'UPI', tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, { tenantId: TENANT });
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
    });

    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET status = 'initiated', provider_refund_id = NULL
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(leg.id), TENANT,
    );
    await expect(billing.markRefundPaid(refund.id, {
      tenantId: TENANT, reference: `manual-crash-${randomUUID()}`,
    })).rejects.toMatchObject({ code: 'BILLING_REFUND_PAYOUT_RAIL_CONFLICT' });

    const processedProviderRefundId = `rfnd_crash_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const processed = await gateway.handleRefundProcessedEvent({
      tenantId: TENANT,
      config,
      payload: { payload: { refund: { entity: {
        id: processedProviderRefundId,
        payment_id: providerPaymentId,
        amount: toPaise(70),
        currency: 'INR',
        status: 'processed',
        notes: { billing_refund_id: String(refund.id) },
      } } } },
    });
    expect(processed.outcome).toBe('refund_processed');
    const [authority] = await prisma.$queryRawUnsafe(
      `SELECT approval_status, payout_rail, gateway_refund_id, reference
         FROM billing_refunds WHERE id = $1::int`, Number(refund.id),
    );
    expect(authority).toMatchObject({
      approval_status: 'PAID',
      payout_rail: 'gateway',
      gateway_refund_id: Number(leg.id),
      reference: processedProviderRefundId,
    });
  });

  it('refund.failed recovers an initiated crash-window intent and is inert on redelivery', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(patient, 250);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 75, reason: 'failed provider refund', mode: 'UPI', tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, { tenantId: TENANT });
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
    });

    // Simulate a process crash after the provider accepted the request but
    // before phase 3 persisted its refund id/status evidence.
    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET status = 'initiated', provider_refund_id = NULL
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(leg.id), TENANT,
    );
    const providerRefundId = `rfnd_failed_${randomUUID().slice(0, 8)}`;
    const input = {
      tenantId: TENANT, config, event: { event_type: 'refund.failed' },
      payload: { payload: { refund: { entity: {
        id: providerRefundId, payment_id: providerPaymentId, amount: toPaise(75),
        currency: 'INR', status: 'failed', notes: { billing_refund_id: String(refund.id) },
        error_code: 'BAD_REQUEST_ERROR', error_description: 'provider rejected refund',
      } } } },
    };

    const first = await gateway.processWebhookEvent(input);
    const redelivery = await gateway.processWebhookEvent(input);
    expect(first).toMatchObject({ outcome: 'refund_failed_recorded', gatewayRefundId: Number(leg.id) });
    expect(redelivery).toMatchObject({ outcome: 'replay', gatewayRefundId: Number(leg.id) });

    const [updatedLeg] = await prisma.$queryRawUnsafe(
      `SELECT status, provider_refund_id FROM payment_gateway_refunds WHERE id = $1::int`,
      Number(leg.id),
    );
    expect(updatedLeg).toMatchObject({ status: 'failed', provider_refund_id: providerRefundId });
    const [billingRefund] = await prisma.$queryRawUnsafe(
      `SELECT approval_status, reference FROM billing_refunds WHERE id = $1::int`,
      Number(refund.id),
    );
    expect(billingRefund).toMatchObject({ approval_status: 'APPROVED', reference: null });
  });

  it('concurrent refund.processed and refund.failed evidence converges billing and execution on processed', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(patient, 280);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 95,
      reason: 'terminal webhook race', mode: 'UPI', tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, { tenantId: TENANT });
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
    });
    const common = {
      id: leg.provider_refund_id,
      payment_id: providerPaymentId,
      amount: toPaise(95),
      currency: 'INR',
      notes: { billing_refund_id: String(refund.id) },
    };

    const outcomes = await Promise.allSettled([
      gateway.processWebhookEvent({
        tenantId: TENANT,
        config,
        event: { event_type: 'refund.processed' },
        payload: { payload: { refund: { entity: { ...common, status: 'processed' } } } },
      }),
      gateway.processWebhookEvent({
        tenantId: TENANT,
        config,
        event: { event_type: 'refund.failed' },
        payload: { payload: { refund: { entity: {
          ...common,
          status: 'failed',
          error_code: 'PROVIDER_RACE_FAILURE',
          error_description: 'Concurrent contradictory provider terminal delivery',
        } } } },
      }),
    ]);
    expect(outcomes.every(outcome => outcome.status === 'fulfilled')).toBe(true);

    const [authority] = await prisma.$queryRawUnsafe(
      `SELECT approval_status, payout_rail, gateway_refund_id, reference
         FROM billing_refunds WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(refund.id), TENANT,
    );
    const [execution] = await prisma.$queryRawUnsafe(
      `SELECT status, provider_refund_id, processed_at, failed_at, metadata
         FROM payment_gateway_refunds WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(leg.id), TENANT,
    );
    expect(authority).toMatchObject({
      approval_status: 'PAID',
      payout_rail: 'gateway',
      gateway_refund_id: Number(leg.id),
      reference: leg.provider_refund_id,
    });
    expect(execution).toMatchObject({
      status: 'processed',
      provider_refund_id: leg.provider_refund_id,
      failed_at: null,
    });
    expect(execution.processed_at).not.toBeNull();
    const entries = await prisma.$queryRawUnsafe(
      `SELECT id FROM ledger_entries WHERE idempotency_key = $1`,
      `refund-paid-${refund.id}`,
    );
    expect(entries).toHaveLength(1);
  });

  it('exact failed evidence supersedes a prior note stamp instead of being ignored', async () => {
    const actor = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(actor, 190);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 50,
      reason: 'stamped failure evidence', mode: 'UPI', tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, { tenantId: TENANT });
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
    });
    const stampedNote = 'Operator previously recorded a provider portal review note';
    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET status = 'requires_reconciliation', reconciled_at = NOW(),
              reconciliation_note = $1, reconciled_by = $2::uuid,
              updated_at = NOW()
        WHERE id = $3::int AND tenant_id = $4::uuid`,
      stampedNote, actor, Number(leg.id), TENANT,
    );

    const result = await gateway.processWebhookEvent({
      tenantId: TENANT,
      config,
      event: { event_type: 'refund.failed' },
      payload: { payload: { refund: { entity: {
        id: leg.provider_refund_id,
        payment_id: providerPaymentId,
        amount: toPaise(50),
        currency: 'INR',
        status: 'failed',
        notes: { billing_refund_id: String(refund.id) },
        error_code: 'BAD_REQUEST_ERROR',
        error_description: 'Provider rejected refund after operator review',
      } } } },
    });
    expect(result).toMatchObject({
      outcome: 'refund_failed_recorded', gatewayRefundId: Number(leg.id),
    });
    const [execution] = await prisma.$queryRawUnsafe(
      `SELECT status, reconciled_at, reconciliation_note, reconciled_by, metadata
         FROM payment_gateway_refunds WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(leg.id), TENANT,
    );
    expect(execution).toMatchObject({
      status: 'failed', reconciled_at: null, reconciliation_note: null, reconciled_by: null,
    });
    expect(execution.metadata.provider_terminal_evidence_history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        terminal_status: 'failed',
        reconciliation_note: stampedNote,
        reconciled_by: actor,
      }),
    ]));
  });

  it('refund.failed evidence mismatch durably reconciles and an exact redelivery self-heals to failed', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(patient, 180);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 60, reason: 'mismatched failure evidence', mode: 'UPI', tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, { tenantId: TENANT });
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
    });
    const entity = {
      id: leg.provider_refund_id, payment_id: providerPaymentId, amount: toPaise(60),
      currency: 'INR', status: 'failed', notes: { billing_refund_id: String(refund.id) },
      error_code: 'BAD_REQUEST_ERROR', error_description: 'provider rejected refund',
    };

    const mismatch = await gateway.processWebhookEvent({
      tenantId: TENANT, config, event: { event_type: 'refund.failed' },
      payload: { payload: { refund: { entity: { ...entity, currency: 'USD' } } } },
    });
    expect(mismatch).toMatchObject({ outcome: 'requires_reconciliation', gatewayRefundId: Number(leg.id) });
    let [updatedLeg] = await prisma.$queryRawUnsafe(
      `SELECT status, failure_code, failure_reason
         FROM payment_gateway_refunds WHERE id = $1::int`,
      Number(leg.id),
    );
    expect(updatedLeg).toMatchObject({
      status: 'requires_reconciliation', failure_code: 'provider_evidence_mismatch',
    });
    expect(updatedLeg.failure_reason).toContain('currency');

    const exact = await gateway.processWebhookEvent({
      tenantId: TENANT, config, event: { event_type: 'refund.failed' },
      payload: { payload: { refund: { entity } } },
    });
    expect(exact).toMatchObject({ outcome: 'refund_failed_recorded', gatewayRefundId: Number(leg.id) });
    [updatedLeg] = await prisma.$queryRawUnsafe(
      `SELECT status, provider_refund_id FROM payment_gateway_refunds WHERE id = $1::int`,
      Number(leg.id),
    );
    expect(updatedLeg).toMatchObject({ status: 'failed', provider_refund_id: leg.provider_refund_id });
  });

  it('a failed refund retry gets a new provider-safe receipt/id and survives the prior failed evidence', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(patient, 220);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 55, reason: 'retry after provider failure', mode: 'UPI', tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, { tenantId: TENANT });
    const first = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
    });
    await gateway.processWebhookEvent({
      tenantId: TENANT,
      config,
      event: { event_type: 'refund.failed' },
      payload: { payload: { refund: { entity: {
        id: first.provider_refund_id,
        payment_id: providerPaymentId,
        amount: toPaise(55),
        currency: 'INR',
        status: 'failed',
        notes: { billing_refund_id: String(refund.id) },
      } } } },
    });

    const retry = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
    });
    expect(retry.id).not.toBe(first.id);
    expect(retry.provider_refund_id).not.toBe(first.provider_refund_id);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, status, provider_refund_id, provider_idempotency_key
         FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid AND billing_refund_id = $2::int
        ORDER BY id`,
      TENANT, Number(refund.id),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('failed');
    expect(rows[1].status).toBe('pending');
    expect(rows[1].provider_refund_id).not.toBe(rows[0].provider_refund_id);
    expect(rows[1].provider_idempotency_key).not.toBe(rows[0].provider_idempotency_key);
  });

  it('database rejects gateway refund links to an order or billing authority owned by another tenant', async () => {
    const patient = await makePatient();
    const { orderId, providerPaymentId } = await makeCapturedGatewayPayment(patient, 160);
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);

    let orderFailure;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO payment_gateway_refunds
           (tenant_id, provider, environment, gateway_order_id, billing_refund_id,
            provider_payment_id, provider_idempotency_key, amount, currency,
            status, webhook_credential_version)
         VALUES ($1::uuid, 'dry_run', 'sandbox', $2::int, NULL,
                 $3::varchar, $4::varchar, 10, 'INR', 'pending', 1)`,
        CROSS_TENANT, Number(orderId), providerPaymentId, `pgr_cross_order_${suffix}`,
      );
    } catch (error) {
      orderFailure = error;
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid AND provider_idempotency_key = $2::varchar`,
      CROSS_TENANT, `pgr_cross_order_${suffix}`,
    );
    expect(`${orderFailure?.meta?.code || ''} ${orderFailure?.message || ''}`)
      .toMatch(/23503|foreign key/i);
    expect(orderFailure?.message || '').toContain('fk_pg_refund_gateway_order_tenant_med03');

    const crossPatient = randomUUID();
    cleanup.patientUids.push(crossPatient);
    const [crossInvoice] = await prisma.$queryRawUnsafe(
      `INSERT INTO billing_invoices
         (tenant_id, patient_uid, invoice_type, total_amount, amount_paid,
          amount_due, status, updated_at)
       VALUES ($1::uuid, $2::uuid, 'OP', 10, 10, 0, 'PAID', NOW())
       RETURNING id`,
      CROSS_TENANT, crossPatient,
    );
    cleanup.invoiceIds.push(Number(crossInvoice.id));
    const crossApprover = randomUUID();
    cleanup.patientUids.push(crossApprover);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at)
       VALUES
         ($1::uuid, $2, 'Cross tenant refund approver', 'ADMIN', $4::uuid, NOW()),
         ($3::uuid, $5, 'Cross tenant refund patient', 'PATIENT', $4::uuid, NOW())`,
      crossApprover,
      `8${Math.floor(100000000 + Math.random() * 899999999)}`,
      crossPatient,
      CROSS_TENANT,
      `7${Math.floor(100000000 + Math.random() * 899999999)}`,
    );
    const [crossRefund] = await prisma.$queryRawUnsafe(
      `INSERT INTO billing_refunds
         (tenant_id, patient_uid, invoice_id, amount, reason, mode,
           approval_status, raised_by)
        SELECT $1::uuid, invoice.patient_uid, invoice.id, 10,
               'Cross tenant FK regression', 'UPI', 'PENDING', $3::uuid
          FROM billing_invoices AS invoice
         WHERE invoice.id = $2::int AND invoice.tenant_id = $1::uuid
        RETURNING id`,
      CROSS_TENANT, Number(crossInvoice.id), crossApprover,
    );
    cleanup.refundIds.push(Number(crossRefund.id));
    await prisma.$executeRawUnsafe(
      `UPDATE billing_refunds
          SET approval_status = 'APPROVED', approved_by = $1::uuid,
              approved_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $2::uuid AND id = $3::int`,
      crossApprover,
      CROSS_TENANT,
      Number(crossRefund.id),
    );

    let authorityFailure;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO payment_gateway_refunds
           (tenant_id, provider, environment, gateway_order_id, billing_refund_id,
            provider_payment_id, provider_idempotency_key, amount, currency,
            status, webhook_credential_version)
         VALUES ($1::uuid, 'dry_run', 'sandbox', $2::int, $3::int,
                 $4::varchar, $5::varchar, 10, 'INR', 'pending', 1)`,
        TENANT, Number(orderId), Number(crossRefund.id),
        providerPaymentId, `pgr_cross_refund_${suffix}`,
      );
    } catch (error) {
      authorityFailure = error;
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid AND provider_idempotency_key = $2::varchar`,
      TENANT, `pgr_cross_refund_${suffix}`,
    );
    expect(`${authorityFailure?.meta?.code || ''} ${authorityFailure?.message || ''}`)
      .toMatch(/23503|foreign key/i);
    expect(authorityFailure?.message || '').toContain('fk_pg_refund_billing_refund_tenant_med03');
  });

  it('refuses execution for a refund that is not APPROVED or not gateway-collected', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId } = await makeCapturedGatewayPayment(patient, 200);

    // PENDING (not yet approved) → rejected.
    const pendingRefund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 50, reason: 'not yet approved', mode: 'UPI', tenantId: TENANT,
    });
    cleanup.refundIds.push(pendingRefund.id);
    await expect(gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: pendingRefund.id,
      gateway_order_id: orderId,
    })).rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_REFUND_NOT_APPROVED' });

    // Cash-collected invoice (no gateway order) → rejected.
    const inv2 = await billing.createDraftInvoice({ patient_uid: patient, invoice_type: 'OP', tenantId: TENANT });
    await billing.addInvoiceItem(inv2.id, { description: 'X', quantity: 1, unit_price: 100, gst_rate: 0, tenantId: TENANT });
    await billing.issueInvoice(inv2.id, { tenantId: TENANT });
    cleanup.invoiceIds.push(inv2.id);
    await billing.collectPayment({
      invoice_id: inv2.id, amount: 100, mode: 'CASH', shift: 'MORNING', tenantId: TENANT,
    });
    const cashRefund = await billing.raiseRefund({
      invoice_id: inv2.id, amount: 40, reason: 'cash path', mode: 'CASH', tenantId: TENANT,
    });
    cleanup.refundIds.push(cashRefund.id);
    await billing.approveRefund(cashRefund.id, { tenantId: TENANT });
    await expect(gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: cashRefund.id,
      gateway_order_id: 2147483647,
    })).rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_REFUND_NOT_GATEWAY_COLLECTED' });
  });
});
