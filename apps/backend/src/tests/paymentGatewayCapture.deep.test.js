// apps/backend/src/tests/paymentGatewayCapture.deep.test.js
//
// Full capture path against a real database (migrations 693-695 + the
// billing spine): order → capture webhook → collectPayment books EXACTLY ONE
// billing_payments row with reference = provider_payment_id, the order flips
// paid in the same transaction (694 paid-evidence CHECK), the ledger PAYMENT
// entry posts same-tx under enforce wiring, replays never double-book, the
// DB CHECK refuses a paid order without booked money, and an unbookable
// capture (voided invoice) parks as requires_reconciliation.
//
// dry_run provider throughout — zero live credentials. Self-skips without a DB.

import { randomUUID } from 'node:crypto';
import prisma from '../lib/prisma.js';
import * as billing from '../services/billing/billingV2Service.js';
import * as gateway from '../services/billing/paymentGatewayService.js';
import { getPublicPaymentLinkView, createPaymentLink } from '../services/billing/paymentLinkService.js';
import { toPaise } from '../utils/money.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const cleanup = { invoiceIds: [], patientUids: [], orderIds: [], linkIds: [] };
let prevLedgerMode;
let prevGatewayEnabled;

async function makePatient() {
  const uid = randomUUID();
  const phone = `9${Math.floor(100000000 + Math.random() * 899999999)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, tenant_id, updated_at)
     VALUES ($1::uuid, $2, 'PG Capture', 'PATIENT', $3::uuid, NOW())`,
    uid, phone, TENANT,
  );
  cleanup.patientUids.push(uid);
  return uid;
}

async function makeIssuedInvoice(patientUid, total) {
  const inv = await billing.createDraftInvoice({ patient_uid: patientUid, invoice_type: 'OP', tenantId: TENANT });
  await billing.addInvoiceItem(inv.id, {
    description: 'Consult', quantity: 1, unit_price: total, gst_rate: 0, tenantId: TENANT,
  });
  await billing.issueInvoice(inv.id, { tenantId: TENANT });
  cleanup.invoiceIds.push(inv.id);
  return inv.id;
}

function capturePayload({ providerOrderId, providerPaymentId, amountPaise, method = 'upi', currency = 'INR' }) {
  return {
    event: 'payment.captured',
    created_at: Math.floor(Date.now() / 1000),
    payload: { payment: { entity: {
      id: providerPaymentId, order_id: providerOrderId, method, amount: amountPaise, currency,
    } } },
  };
}

let config;

beforeAll(async () => {
  if (!DB_CONFIGURED) return;
  prevLedgerMode = process.env.LEDGER_AUTHORITATIVE_MODE;
  prevGatewayEnabled = process.env.PAYMENT_GATEWAY_ENABLED;
  // enforce: the ledger PAYMENT entry must post INSIDE the capture tx so the
  // "billing_payments row + ledger posting in the same tx" invariant is real.
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
    tenantId: TENANT,
    provider: 'dry_run',
    environment: 'sandbox',
    enabled: true,
    display_name: 'Deep test dry run',
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
    await prisma.$executeRawUnsafe(
      `DELETE FROM payment_gateway_webhook_events WHERE tenant_id = $1::uuid`, TENANT,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM payment_gateway_refunds WHERE tenant_id = $1::uuid`, TENANT,
    );
    if (cleanup.orderIds.length) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM payment_gateway_orders WHERE id = ANY($1::int[])`, cleanup.orderIds,
      );
    }
    if (cleanup.linkIds.length) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM billing_payment_links WHERE id = ANY($1::int[])`, cleanup.linkIds,
      );
    }
    if (cleanup.invoiceIds.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM billing_payments WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE invoice_id = ANY($1::int[])`, cleanup.invoiceIds);
      await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE id = ANY($1::int[])`, cleanup.invoiceIds);
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM payment_gateway_provider_configs WHERE tenant_id = $1::uuid`, TENANT,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE tenants SET settings = settings - 'paymentGateway' WHERE id = $1::uuid`, TENANT,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM interop_replay_guard WHERE namespace = 'payment-gateway-webhook'`,
    );
    if (cleanup.patientUids.length) {
      await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = ANY($1::uuid[])`, cleanup.patientUids);
    }
  } catch { /* best-effort teardown */ }
  if (prevLedgerMode === undefined) delete process.env.LEDGER_AUTHORITATIVE_MODE;
  else process.env.LEDGER_AUTHORITATIVE_MODE = prevLedgerMode;
  if (prevGatewayEnabled === undefined) delete process.env.PAYMENT_GATEWAY_ENABLED;
  else process.env.PAYMENT_GATEWAY_ENABLED = prevGatewayEnabled;
  await prisma.$disconnect().catch(() => {});
}, 30_000);

d('payment gateway capture (deep)', () => {
  it('recovers the same persisted order intent after a provider-bind crash window', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 125);
    const idempotencyKey = `deep-order-${randomUUID()}`;
    const first = await gateway.createGatewayOrder({
      tenantId: TENANT,
      invoice_id: invoiceId,
      actor: { uid: patient, role: 'PATIENT' },
      idempotency_key: idempotencyKey,
    });
    cleanup.orderIds.push(first.orderId);

    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_orders
          SET provider_order_id = NULL,
              metadata = metadata || '{"order_create_state":"intent_persisted"}'::jsonb
        WHERE id = $1::int`,
      first.orderId,
    );
    const recovered = await gateway.createGatewayOrder({
      tenantId: TENANT,
      invoice_id: invoiceId,
      actor: { uid: patient, role: 'PATIENT' },
      idempotency_key: idempotencyKey,
    });
    expect(recovered.orderId).toBe(first.orderId);
    expect(recovered.providerOrderId).toBe(first.providerOrderId);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM payment_gateway_orders
        WHERE tenant_id = $1::uuid AND receipt = (
          SELECT receipt FROM payment_gateway_orders WHERE id = $2::int
        )`,
      TENANT, first.orderId,
    );
    expect(rows[0].n).toBe(1);
  });

  it('books capture → ONE billing_payments row (reference = provider payment id) + same-tx ledger entry; replay stays one row', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 500);

    const order = await gateway.createGatewayOrder({
      tenantId: TENANT, invoice_id: invoiceId, created_by: patient,
      actor: { uid: patient, role: 'PATIENT' },
    });
    cleanup.orderIds.push(order.orderId);
    expect(order.provider).toBe('dry_run');
    expect(order.providerOrderId.startsWith('order_dry_pg-')).toBe(true);
    expect(order.amount).toBe(500);

    const providerPaymentId = `pay_dry_${randomUUID().slice(0, 8)}`;
    const payload = capturePayload({
      providerOrderId: order.providerOrderId, providerPaymentId, amountPaise: toPaise(500),
    });
    const result = await gateway.handleCaptureEvent({
      tenantId: TENANT, config, event: { event_type: 'payment.captured' }, payload,
    });
    expect(result.outcome).toBe('captured');

    // Exactly one money row, keyed the way migration 317 protects.
    const payments = await prisma.$queryRawUnsafe(
      `SELECT id, amount, mode, invoice_id FROM billing_payments
        WHERE tenant_id = $1::uuid AND reference = $2`,
      TENANT, providerPaymentId,
    );
    expect(payments.length).toBe(1);
    expect(payments[0].mode).toBe('UPI');
    expect(Number(payments[0].amount)).toBe(500);
    expect(Number(payments[0].invoice_id)).toBe(invoiceId);

    // Order paid with full evidence (the 694 CHECK held by construction).
    const orderRows = await prisma.$queryRawUnsafe(
      `SELECT status, billing_payment_id, provider_payment_id, captured_at, method
         FROM payment_gateway_orders WHERE id = $1::int`,
      order.orderId,
    );
    expect(orderRows[0].status).toBe('paid');
    expect(Number(orderRows[0].billing_payment_id)).toBe(Number(payments[0].id));
    expect(orderRows[0].provider_payment_id).toBe(providerPaymentId);
    expect(orderRows[0].captured_at).not.toBeNull();
    expect(orderRows[0].method).toBe('upi');

    // enforce wiring → the ledger PAYMENT entry was posted in the SAME tx.
    const entries = await prisma.$queryRawUnsafe(
      `SELECT id FROM ledger_entries WHERE idempotency_key = $1`,
      `payment-${payments[0].id}`,
    );
    expect(entries.length).toBe(1);

    // Invoice settled through the canonical path.
    const invRows = await prisma.$queryRawUnsafe(
      `SELECT status, amount_due, amount_paid FROM billing_invoices WHERE id = $1::int`, invoiceId,
    );
    expect(invRows[0].status).toBe('PAID');
    expect(Number(invRows[0].amount_due)).toBe(0);
    expect(Number(invRows[0].amount_paid)).toBe(500);

    // Replay of the same capture: no second booking, no second ledger entry.
    const replay = await gateway.handleCaptureEvent({
      tenantId: TENANT, config, event: { event_type: 'payment.captured' }, payload,
    });
    expect(replay.outcome).toBe('replay');
    const paymentsAfter = await prisma.$queryRawUnsafe(
      `SELECT id FROM billing_payments WHERE tenant_id = $1::uuid AND reference = $2`,
      TENANT, providerPaymentId,
    );
    expect(paymentsAfter.length).toBe(1);
  });

  it('capture through a payment link flips the link row paid in the same tx', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 250);
    process.env.HOSPITAL_UPI_VPA = process.env.HOSPITAL_UPI_VPA || 'hospital@upi';
    process.env.HOSPITAL_UPI_PAYEE_NAME = process.env.HOSPITAL_UPI_PAYEE_NAME || 'Deep Test Hospital';
    const link = await createPaymentLink({
      tenantId: TENANT, invoice_id: invoiceId, patient_uid: patient, amount: 250,
    });
    cleanup.linkIds.push(link.id);

    const order = await gateway.createGatewayOrder({
      tenantId: TENANT, payment_link_token: link.link_token,
      actor: { uid: patient, role: 'PATIENT' },
    });
    cleanup.orderIds.push(order.orderId);
    expect(order.paymentLinkId).toBe(Number(link.id));

    // The public /pay view now exposes the checkout bootstrap for this link.
    const view = await getPublicPaymentLinkView({ link_token: link.link_token });
    expect(view.gateway).toEqual({
      enabled: true, provider: 'dry_run', keyId: null, providerOrderId: order.providerOrderId,
    });

    const providerPaymentId = `pay_dry_${randomUUID().slice(0, 8)}`;
    const result = await gateway.handleCaptureEvent({
      tenantId: TENANT, config, event: { event_type: 'payment.captured' },
      payload: capturePayload({
        providerOrderId: order.providerOrderId, providerPaymentId, amountPaise: toPaise(250),
      }),
    });
    expect(result.outcome).toBe('captured');

    const linkRows = await prisma.$queryRawUnsafe(
      `SELECT status, paid_via, paid_reference, linked_payment_id
         FROM billing_payment_links WHERE id = $1::int`,
      Number(link.id),
    );
    expect(linkRows[0].status).toBe('paid');
    expect(linkRows[0].paid_reference).toBe(providerPaymentId);
    expect(Number(linkRows[0].linked_payment_id)).toBe(result.billingPaymentId);
  });

  it('the 694 paid-evidence CHECK refuses paid without a booked billing_payments row', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 100);
    const order = await gateway.createGatewayOrder({
      tenantId: TENANT, invoice_id: invoiceId, actor: { uid: patient, role: 'PATIENT' },
    });
    cleanup.orderIds.push(order.orderId);

    await expect(prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_orders SET status = 'paid' WHERE id = $1::int`,
      order.orderId,
    )).rejects.toThrow();
  });

  it('an unbookable capture (voided invoice) parks as requires_reconciliation — never silent, never paid', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 300);
    const order = await gateway.createGatewayOrder({
      tenantId: TENANT, invoice_id: invoiceId, actor: { uid: patient, role: 'PATIENT' },
    });
    cleanup.orderIds.push(order.orderId);

    await billing.voidInvoice(invoiceId, { reason: 'deep-test void', tenantId: TENANT });

    const providerPaymentId = `pay_dry_${randomUUID().slice(0, 8)}`;
    const result = await gateway.handleCaptureEvent({
      tenantId: TENANT, config, event: { event_type: 'payment.captured' },
      payload: capturePayload({
        providerOrderId: order.providerOrderId, providerPaymentId, amountPaise: toPaise(300),
      }),
    });
    expect(result.outcome).toBe('requires_reconciliation');

    const orderRows = await prisma.$queryRawUnsafe(
      `SELECT status, provider_payment_id, captured_at, failure_reason
         FROM payment_gateway_orders WHERE id = $1::int`,
      order.orderId,
    );
    expect(orderRows[0].status).toBe('requires_reconciliation');
    expect(orderRows[0].provider_payment_id).toBe(providerPaymentId);
    expect(orderRows[0].captured_at).not.toBeNull();
    expect(orderRows[0].failure_reason).toContain('VOID');

    // No money row was forged.
    const payments = await prisma.$queryRawUnsafe(
      `SELECT id FROM billing_payments WHERE tenant_id = $1::uuid AND reference = $2`,
      TENANT, providerPaymentId,
    );
    expect(payments.length).toBe(0);

    // The parked capture is VISIBLE on the admin work queue…
    const queue = await gateway.listReconciliationGatewayOrders({ tenantId: TENANT });
    const queued = queue.orders.find((o) => o.id === order.orderId);
    expect(queued).toBeTruthy();
    expect(queued.provider_payment_id).toBe(providerPaymentId);
    expect(queued.reconciled_at).toBeNull();

    // …and an operator stamp records the manual resolution + drops it from
    // the default listing (already-stamped and unknown orders are refused).
    const resolved = await gateway.resolveGatewayOrderReconciliation({
      tenantId: TENANT, id: order.orderId,
      note: 'Refunded at the provider dashboard; invoice was voided before capture.',
    });
    expect(resolved.reconciled_at).not.toBeNull();
    expect(resolved.reconciliation_note).toContain('provider dashboard');
    const after = await gateway.listReconciliationGatewayOrders({ tenantId: TENANT });
    expect(after.orders.find((o) => o.id === order.orderId)).toBeUndefined();
    const withResolved = await gateway.listReconciliationGatewayOrders({
      tenantId: TENANT, include_resolved: true,
    });
    expect(withResolved.orders.find((o) => o.id === order.orderId)).toBeTruthy();
    await expect(gateway.resolveGatewayOrderReconciliation({
      tenantId: TENANT, id: order.orderId, note: 'second stamp attempt should conflict',
    })).rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_ORDER_NOT_RECONCILABLE' });
  });

  it('never books a capture without exact amount and currency evidence', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 90);
    const order = await gateway.createGatewayOrder({
      tenantId: TENANT, invoice_id: invoiceId, actor: { uid: patient, role: 'PATIENT' },
    });
    cleanup.orderIds.push(order.orderId);
    const providerPaymentId = `pay_dry_${randomUUID().slice(0, 8)}`;
    const payload = capturePayload({
      providerOrderId: order.providerOrderId,
      providerPaymentId,
      amountPaise: toPaise(90),
    });
    delete payload.payload.payment.entity.currency;
    const result = await gateway.handleCaptureEvent({ tenantId: TENANT, config, payload });
    expect(result.outcome).toBe('requires_reconciliation');
    const payments = await prisma.$queryRawUnsafe(
      `SELECT id FROM billing_payments WHERE tenant_id = $1::uuid AND reference = $2`,
      TENANT, providerPaymentId,
    );
    expect(payments).toHaveLength(0);
  });

  it('webhook intake dedupes durably on (tenant, provider, provider_event_id)', async () => {
    const eventId = `evt_${randomUUID().slice(0, 12)}`;
    const payload = { event: 'payment.captured', payload: {} };
    const first = await gateway.recordWebhookEvent({
      tenantId: TENANT, provider: 'dry_run', environment: 'sandbox',
      providerEventId: eventId, eventType: 'payment.captured', payload, rawBody: JSON.stringify(payload),
    });
    expect(first.duplicate).toBe(false);
    expect(first.event.status).toBe('pending');

    const second = await gateway.recordWebhookEvent({
      tenantId: TENANT, provider: 'dry_run', environment: 'sandbox',
      providerEventId: eventId, eventType: 'payment.captured', payload, rawBody: JSON.stringify(payload),
    });
    expect(second.duplicate).toBe(true);
    expect(Number(second.event.id)).toBe(Number(first.event.id));
  });

  it('config gate OFF: orders 403 PAYMENT_GATEWAY_DISABLED and the public view shows the disabled marker', async () => {
    const patient = await makePatient();
    const invoiceId = await makeIssuedInvoice(patient, 50);
    const link = await createPaymentLink({
      tenantId: TENANT, invoice_id: invoiceId, patient_uid: patient, amount: 50,
    });
    cleanup.linkIds.push(link.id);

    process.env.PAYMENT_GATEWAY_ENABLED = 'false';
    try {
      await expect(gateway.createGatewayOrder({
        tenantId: TENANT, invoice_id: invoiceId, actor: { uid: patient, role: 'PATIENT' },
      })).rejects.toMatchObject({ statusCode: 403, code: 'PAYMENT_GATEWAY_DISABLED' });

      const view = await getPublicPaymentLinkView({ link_token: link.link_token });
      expect(view.gateway).toEqual({
        enabled: false, provider: null, keyId: null, providerOrderId: null,
      });
    } finally {
      process.env.PAYMENT_GATEWAY_ENABLED = 'true';
    }
  });
});
