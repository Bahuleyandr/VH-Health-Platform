// apps/backend/src/tests/paymentGatewayRefund.deep.test.js
//
// Gateway refund execution leg against a real database (migration 697):
// authority stays in billing_refunds (raiseRefund → approveRefund →
// markRefundPaid); the gateway adds only the provider execution row. The
// refund.processed webhook drives markRefundPaid with reference =
// provider_refund_id, posting the ledger REFUND_PAID entry under enforce
// wiring; replays touch nothing twice, and one live execution leg per
// billing refund is DB-enforced. dry_run provider — zero credentials.

import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import * as billing from '../services/billing/billingV2Service.js';
import * as gateway from '../services/billing/paymentGatewayService.js';
import { toPaise } from '../utils/money.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const cleanup = { invoiceIds: [], patientUids: [], orderIds: [], refundIds: [] };
let prevLedgerMode;
let prevGatewayEnabled;
let config;

async function makePatient() {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at)
     VALUES ($1::uuid, $2, 'PG Refund', 'PATIENT', $3::uuid, NOW())`,
    uid, phone, TENANT,
  );
  cleanup.patientUids.push(uid);
  return uid;
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
      payload: { payment: { entity: { id: providerPaymentId, order_id: order.providerOrderId, method: 'upi', amount: toPaise(total) } } },
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
    });
    await prisma.$executeRawUnsafe(`DELETE FROM payment_gateway_webhook_events WHERE tenant_id = $1::uuid`, TENANT);
    await prisma.$executeRawUnsafe(`DELETE FROM payment_gateway_refunds WHERE tenant_id = $1::uuid`, TENANT);
    if (cleanup.orderIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM payment_gateway_orders WHERE id = ANY($1::int[])`, cleanup.orderIds);
    }
    if (cleanup.refundIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_refunds WHERE id = ANY($1::int[])`, cleanup.refundIds);
    }
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
    await prisma.$executeRawUnsafe(`DELETE FROM payment_gateway_provider_configs WHERE tenant_id = $1::uuid`, TENANT);
    await prisma.$executeRawUnsafe(`UPDATE tenants SET settings = settings - 'paymentGateway' WHERE id = $1::uuid`, TENANT);
    if (cleanup.patientUids.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
    }
  } catch { /* best-effort teardown */ }
  if (prevLedgerMode === undefined) delete process.env.LEDGER_AUTHORITATIVE_MODE;
  else process.env.LEDGER_AUTHORITATIVE_MODE = prevLedgerMode;
  if (prevGatewayEnabled === undefined) delete process.env.PAYMENT_GATEWAY_ENABLED;
  else process.env.PAYMENT_GATEWAY_ENABLED = prevGatewayEnabled;
  await prisma.$disconnect().catch(() => {});
});

d('payment gateway refund execution leg (deep)', () => {
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
    expect(leg.provider_refund_id).toBe(`rfnd_dry_pgr-${refund.id}`);
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
    expect(rows[0].provider_refund_id).toBe(`rfnd_dry_pgr-${refund.id}`);
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
