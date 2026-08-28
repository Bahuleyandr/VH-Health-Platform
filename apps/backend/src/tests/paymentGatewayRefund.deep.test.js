// apps/backend/src/tests/paymentGatewayRefund.deep.test.js
//
// Gateway refund execution leg against a real database (migrations 697,
// 747 and 752):
// authority stays in billing_refunds (raiseRefund → approveRefund →
// markRefundPaid); the gateway adds only the provider execution row. The
// exact refund.processed evidence drives markRefundPaid with reference =
// provider_refund_id, posting the ledger REFUND_PAID entry under enforce
// wiring; replays touch nothing twice, and one live execution leg per
// billing refund is DB-enforced. dry_run provider — zero credentials.

import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import prisma, { setTenantTx } from '../lib/prisma.js';
import * as billing from '../services/billing/billingV2Service.js';
import * as gateway from '../services/billing/paymentGatewayService.js';
import * as refundRecovery from '../services/billing/gatewayRefundRecoveryService.js';
import dryRunAdapter from '../services/billing/gatewayProviders/dryRunAdapter.js';
import { toPaise } from '../utils/money.js';
import { notificationOutbox } from '../utils/notifications/notificationOutbox.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const cleanup = { invoiceIds: [], patientUids: [], orderIds: [], refundIds: [] };
let prevLedgerMode;
let prevGatewayEnabled;
let prevRefundRecoveryEnabled;
let config;
let refundActors;

async function makeUser(role = 'PATIENT') {
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
  return makeUser('PATIENT');
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
  prevRefundRecoveryEnabled = process.env.PAYMENT_GATEWAY_REFUND_RECOVERY_ENABLED;
  process.env.LEDGER_AUTHORITATIVE_MODE = 'enforce';
  process.env.PAYMENT_GATEWAY_ENABLED = 'true';
  process.env.PAYMENT_GATEWAY_REFUND_RECOVERY_ENABLED = 'true';
  refundActors = {
    raiser: await makeUser('RECEPTIONIST'),
    approver: await makeUser('FINANCE_INCHARGE'),
    initiator: await makeUser('FINANCE_INCHARGE'),
    reviewer: await makeUser('ADMIN'),
    payer: await makeUser('FINANCE_INCHARGE'),
  };
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
    if (cleanup.refundIds.length) {
      await prisma.$executeRawUnsafe(
        `UPDATE billing_refunds
            SET approval_status = CASE
                  WHEN approval_status = 'PAID' THEN 'APPROVED'
                  ELSE approval_status
                END,
                paid_by = NULL,
                paid_at = NULL,
                reference = NULL,
                payout_rail = NULL,
                payout_rail_claimed_at = NULL,
                gateway_refund_id = NULL
          WHERE id = ANY($1::int[])`,
        cleanup.refundIds,
      );
    }
    const recoveryRefs = await prisma.$queryRawUnsafe(
      `SELECT recovery_task_id, recovery_sla_instance_id
         FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid`,
      TENANT,
    );
    const recoveryTaskIds = recoveryRefs
      .map(row => row.recovery_task_id == null ? null : Number(row.recovery_task_id))
      .filter(id => id != null);
    const recoverySlaIds = recoveryRefs
      .map(row => row.recovery_sla_instance_id == null
        ? null
        : String(row.recovery_sla_instance_id))
      .filter(id => id != null);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM notification_outbox
          WHERE tenant_id = $1::uuid
            AND source_event_key LIKE 'gateway-refund-recovery:%'`,
        TENANT,
      );
      await tx.$executeRawUnsafe(
        `UPDATE payment_gateway_refunds
            SET recovery_task_id = NULL,
                recovery_sla_instance_id = NULL
          WHERE tenant_id = $1::uuid`,
        TENANT,
      );
      if (recoveryTaskIds.length) {
        await tx.$executeRawUnsafe(
          `DELETE FROM tasks WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
          TENANT,
          recoveryTaskIds,
        );
      }
      await tx.$executeRawUnsafe(
        `DELETE FROM payment_gateway_refunds WHERE tenant_id = $1::uuid`,
        TENANT,
      );
      if (recoverySlaIds.length) {
        await tx.$executeRawUnsafe(
          `DELETE FROM workflow_sla_instances
            WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
          TENANT,
          recoverySlaIds,
        );
      }
    });
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
  if (prevRefundRecoveryEnabled === undefined) {
    delete process.env.PAYMENT_GATEWAY_REFUND_RECOVERY_ENABLED;
  } else {
    process.env.PAYMENT_GATEWAY_REFUND_RECOVERY_ENABLED = prevRefundRecoveryEnabled;
  }
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
    expect(Number(order.id)).not.toBe(Number(order.provider_config_id));

    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 125, reason: 'synchronous processed refund', mode: 'UPI',
      raised_by: refundActors.raiser, tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, {
      approved_by: refundActors.approver, tenantId: TENANT,
    });

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
        initiated_by: refundActors.initiator,
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

  it('rejects a 747-approved actor from initiating the 752 gateway payout before provider execution', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId } = await makeCapturedGatewayPayment(patient, 180);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId,
      amount: 45,
      reason: 'stacked four-eyes check',
      mode: 'UPI',
      raised_by: refundActors.raiser,
      tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, {
      approved_by: refundActors.approver,
      tenantId: TENANT,
    });
    const createRefundSpy = jest.spyOn(dryRunAdapter, 'createRefund');
    try {
      await expect(gateway.initiateGatewayRefund({
        tenantId: TENANT,
        billing_refund_id: refund.id,
        gateway_order_id: orderId,
        initiated_by: refundActors.approver,
      })).rejects.toMatchObject({
        code: 'BILLING_REFUND_PAYER_MUST_DIFFER_FROM_APPROVER',
      });
      expect(createRefundSpy).not.toHaveBeenCalled();
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id FROM payment_gateway_refunds
          WHERE tenant_id = $1::uuid AND billing_refund_id = $2::int`,
        TENANT,
        Number(refund.id),
      );
      expect(rows).toHaveLength(0);
    } finally {
      createRefundSpy.mockRestore();
    }
  });

  it('APPROVED refund → provider execution row → processed webhook drives markRefundPaid + ledger REFUND_PAID; replay is inert', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(patient, 400);

    // Authority: billingV2 lifecycle.
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 150, reason: 'deep-test refund', mode: 'UPI',
      raised_by: refundActors.raiser, tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, {
      approved_by: refundActors.approver, tenantId: TENANT,
    });

    // Execution leg: provider refund against the original capture.
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
      initiated_by: refundActors.initiator,
    });
    expect(leg.status).toBe('pending');
    expect(leg.provider_refund_id).toMatch(/^rfnd_dry_pgr-[a-f0-9]{32}$/);
    expect(Number(leg.gateway_order_id)).toBe(orderId);
    expect(leg.provider_payment_id).toBe(providerPaymentId);
    expect(Number(leg.amount)).toBe(150);

    const [pendingRecovery] = await prisma.$queryRawUnsafe(
      `SELECT refund.provider_request_fingerprint, refund.recovery_state,
              refund.recovery_attempt_count, refund.recovery_task_id,
              refund.recovery_sla_instance_id,
              task.status AS task_status, task.assigned_to_role,
              task.workflow_sla_instance_id AS task_workflow_sla_instance_id,
              task.sla_completion_semantics,
              sla.status AS sla_status, sla.due_at
         FROM payment_gateway_refunds refund
         JOIN tasks task
           ON task.tenant_id = refund.tenant_id
          AND task.id = refund.recovery_task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = refund.tenant_id
          AND sla.id = refund.recovery_sla_instance_id
        WHERE refund.id = $1::int AND refund.tenant_id = $2::uuid`,
      Number(leg.id), TENANT,
    );
    expect(pendingRecovery.provider_request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(pendingRecovery).toMatchObject({
      recovery_state: 'provider_pending',
      recovery_attempt_count: 0,
      task_status: 'open',
      assigned_to_role: 'FINANCE_INCHARGE',
      sla_status: 'active',
    });
    expect(pendingRecovery.due_at).not.toBeNull();
    expect(String(pendingRecovery.task_workflow_sla_instance_id))
      .toBe(String(pendingRecovery.recovery_sla_instance_id));
    expect(pendingRecovery.sla_completion_semantics).toBe('domain_evidence');
    const recoveryOutbox = await prisma.$queryRawUnsafe(
      `SELECT id, source_event_key
         FROM notification_outbox
        WHERE tenant_id = $1::uuid AND source_event_key = $2`,
      TENANT,
      `gateway-refund-recovery:${Number(leg.id)}:opened`,
    );
    expect(recoveryOutbox.length).toBeGreaterThan(0);

    // One live execution leg per billing refund: a re-initiation (operator
    // retry / second tab) is an idempotent replay of the EXISTING row — the
    // provider is never called a second time and no second row appears.
    const replayLeg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
      initiated_by: refundActors.initiator,
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
      `SELECT refund.status, refund.processed_at, refund.recovery_state,
              refund.recovery_terminal_at, task.status AS task_status,
              task.completed_at AS task_completed_at,
              task.workflow_sla_instance_id AS task_workflow_sla_instance_id,
              task.sla_completion_semantics,
              sla.status AS sla_status, sla.completed_at AS sla_completed_at
         FROM payment_gateway_refunds refund
         JOIN tasks task
           ON task.tenant_id = refund.tenant_id
          AND task.id = refund.recovery_task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = refund.tenant_id
          AND sla.id = refund.recovery_sla_instance_id
        WHERE refund.id = $1::int`,
      Number(leg.id),
    );
    expect(legRows[0].status).toBe('processed');
    expect(legRows[0].processed_at).not.toBeNull();
    expect(legRows[0].recovery_state).toBe('succeeded');
    expect(legRows[0].recovery_terminal_at).not.toBeNull();
    expect(legRows[0].task_status).toBe('completed');
    expect(legRows[0].task_completed_at).not.toBeNull();
    expect(String(legRows[0].task_workflow_sla_instance_id))
      .toBe(String(pendingRecovery.recovery_sla_instance_id));
    expect(legRows[0].sla_completion_semantics).toBe('domain_evidence');
    expect(['completed', 'breached', 'escalated']).toContain(legRows[0].sla_status);
    expect(legRows[0].sla_completed_at).not.toBeNull();

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

  it('fences every processed-evidence mutation to the active recovery claim token', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(patient, 210);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId,
      amount: 65,
      reason: 'stale recovery worker fence',
      mode: 'UPI',
      raised_by: refundActors.raiser,
      tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, {
      approved_by: refundActors.approver,
      tenantId: TENANT,
    });
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT,
      billing_refund_id: refund.id,
      gateway_order_id: orderId,
      initiated_by: refundActors.initiator,
    });
    const activeClaimToken = randomUUID();
    const staleClaimToken = randomUUID();
    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET recovery_state = 'claimed',
              recovery_claim_token = $3::uuid,
              recovery_claimed_at = NOW(),
              recovery_lease_expires_at = NOW() + INTERVAL '5 minutes'
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(leg.id),
      TENANT,
      activeClaimToken,
    );
    const payload = {
      payload: { refund: { entity: {
        id: leg.provider_refund_id,
        payment_id: providerPaymentId,
        amount: toPaise(65),
        currency: 'INR',
        status: 'processed',
        notes: { billing_refund_id: String(refund.id) },
      } } },
    };

    await expect(gateway.handleRefundProcessedEvent({
      tenantId: TENANT,
      config,
      payload,
      claimToken: staleClaimToken,
    })).rejects.toMatchObject({ code: 'BILLING_REFUND_GATEWAY_EVIDENCE_INVALID' });

    const [authority] = await prisma.$queryRawUnsafe(
      `SELECT approval_status, reference
         FROM billing_refunds
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(refund.id),
      TENANT,
    );
    expect(authority).toMatchObject({ approval_status: 'APPROVED', reference: null });
    const [unchangedLeg] = await prisma.$queryRawUnsafe(
      `SELECT status, processed_at, recovery_state, recovery_claim_token
         FROM payment_gateway_refunds
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(leg.id),
      TENANT,
    );
    expect(unchangedLeg).toMatchObject({
      status: 'pending',
      processed_at: null,
      recovery_state: 'claimed',
      recovery_claim_token: activeClaimToken,
    });
  });

  it('rejects terminal operator failure during a live provider poll and preserves processed settlement', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(patient, 225);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId,
      amount: 75,
      reason: 'operator versus live provider claim',
      mode: 'UPI',
      raised_by: refundActors.raiser,
      tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, {
      approved_by: refundActors.approver,
      tenantId: TENANT,
    });
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT,
      billing_refund_id: refund.id,
      gateway_order_id: orderId,
      initiated_by: refundActors.initiator,
    });

    let releaseProvider;
    let providerStarted;
    const providerStartedPromise = new Promise((resolve) => { providerStarted = resolve; });
    const fetchSpy = jest.spyOn(dryRunAdapter, 'fetchRefund')
      .mockImplementationOnce((args) => {
        providerStarted();
        return new Promise((resolve) => {
          releaseProvider = () => resolve({
            providerRefundId: args.providerRefundId,
            providerPaymentId: args.providerPaymentId,
            amountPaise: args.amountPaise,
            currency: args.currency,
            billingRefundId: String(args.billingRefundId),
            status: 'processed',
          });
        });
      });
    let recoveryPromise;
    try {
      recoveryPromise = refundRecovery.recoverGatewayRefundNow({
        tenantId: TENANT,
        gatewayRefundId: leg.id,
        actorUid: refundActors.initiator,
      });
      await providerStartedPromise;

      await expect(gateway.resolveGatewayRefundReconciliation({
        tenantId: TENANT,
        id: leg.id,
        disposition: 'provider_failed',
        evidence: {
          source: 'provider_dashboard',
          reference: `provider-failure-race-${randomUUID()}`,
          observed_at: new Date().toISOString(),
          provider_status: 'failed',
        },
        resolved_by: refundActors.reviewer,
      })).rejects.toMatchObject({
        code: 'PAYMENT_GATEWAY_REFUND_RECOVERY_IN_PROGRESS',
      });

      releaseProvider();
      const recovered = await recoveryPromise;
      expect(recovered).toMatchObject({
        id: Number(leg.id),
        status: 'processed',
        recovery_state: 'succeeded',
      });
    } finally {
      if (releaseProvider) releaseProvider();
      if (recoveryPromise) await recoveryPromise.catch(() => {});
      fetchSpy.mockRestore();
    }

    const [settled] = await prisma.$queryRawUnsafe(
      `SELECT refund.status, refund.recovery_state, refund.reconciliation_disposition,
              refund.recovery_claim_token, billing.approval_status,
              task.status AS task_status, sla.completed_at AS sla_completed_at
         FROM payment_gateway_refunds refund
         JOIN billing_refunds billing
           ON billing.tenant_id = refund.tenant_id
          AND billing.id = refund.billing_refund_id
         JOIN tasks task
           ON task.tenant_id = refund.tenant_id
          AND task.id = refund.recovery_task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = refund.tenant_id
          AND sla.id = refund.recovery_sla_instance_id
        WHERE refund.id = $1::int AND refund.tenant_id = $2::uuid`,
      Number(leg.id),
      TENANT,
    );
    expect(settled).toMatchObject({
      status: 'processed',
      recovery_state: 'succeeded',
      reconciliation_disposition: null,
      recovery_claim_token: null,
      approval_status: 'PAID',
      task_status: 'completed',
    });
    expect(settled.sla_completed_at).not.toBeNull();

    await expect(gateway.initiateGatewayRefund({
      tenantId: TENANT,
      billing_refund_id: refund.id,
      gateway_order_id: orderId,
      initiated_by: refundActors.initiator,
    })).rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_REFUND_NOT_APPROVED' });
    const legs = await prisma.$queryRawUnsafe(
      `SELECT id FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid AND billing_refund_id = $2::int`,
      TENANT,
      Number(refund.id),
    );
    expect(legs).toHaveLength(1);
  });

  it('keeps every non-authoritative review observation open until trusted provider settlement', async () => {
    const actor = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(actor, 240);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 90, reason: 'late processed provider evidence', mode: 'UPI',
      raised_by: refundActors.raiser, tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, {
      approved_by: refundActors.approver, tenantId: TENANT,
    });
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
      initiated_by: refundActors.initiator,
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
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE payment_gateway_refunds
            SET reconciled_at = NOW(),
                reconciliation_note = 'Legacy free-text closure must remain inadmissible',
                reconciled_by = $3::uuid
          WHERE id = $1::int AND tenant_id = $2::uuid`,
        Number(leg.id),
        TENANT,
        refundActors.reviewer,
      ),
    ).rejects.toThrow(/chk_pg_refund_reconciliation_review|structured disposition/i);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE payment_gateway_refunds
            SET recovery_state = 'blocked_authority',
                recovery_next_attempt_at = NULL,
                recovery_terminal_at = NULL,
                recovery_task_id = NULL,
                recovery_sla_instance_id = NULL
          WHERE id = $1::int AND tenant_id = $2::uuid`,
        Number(leg.id),
        TENANT,
      ),
    ).rejects.toThrow(/typed task and SLA obligation/i);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE payment_gateway_refunds
            SET reconciliation_disposition = 'provider_pending',
                reconciliation_evidence = $3::jsonb,
                reconciliation_reviewed_by = $4::uuid,
                reconciliation_reviewed_at = NOW()
          WHERE id = $1::int AND tenant_id = $2::uuid`,
        Number(leg.id),
        TENANT,
        JSON.stringify({
          source: null,
          reference: 'provider-null-shape',
          observed_at: new Date().toISOString(),
          provider_status: 'pending',
        }),
        refundActors.reviewer,
      ),
    ).rejects.toThrow(/chk_pg_refund_reconciliation_review/);
    await expect(
      prisma.$transaction((tx) => tx.$executeRawUnsafe(
        `UPDATE payment_gateway_refunds
            SET reconciliation_disposition = 'provider_pending',
                reconciliation_evidence = $3::jsonb,
                reconciliation_reviewed_by = $4::uuid,
                reconciliation_reviewed_at = NOW()
          WHERE id = $1::int AND tenant_id = $2::uuid`,
        Number(leg.id),
        TENANT,
        JSON.stringify({
          source: 'provider_support',
          reference: `future-provider-evidence-${randomUUID()}`,
          observed_at: new Date(Date.now() + 60_000).toISOString(),
          provider_status: 'pending',
        }),
        refundActors.reviewer,
      )),
    ).rejects.toThrow(/cannot be future-dated/i);

    const [originalBinding] = await prisma.$queryRawUnsafe(
      `SELECT recovery_task_id, recovery_sla_instance_id
         FROM payment_gateway_refunds
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(leg.id),
      TENANT,
    );
    const bindingRefund = await billing.raiseRefund({
      invoice_id: invoiceId,
      amount: 5,
      reason: 'foreign recovery binding probe',
      mode: 'UPI',
      raised_by: refundActors.raiser,
      tenantId: TENANT,
    });
    cleanup.refundIds.push(bindingRefund.id);
    await billing.approveRefund(bindingRefund.id, {
      approved_by: refundActors.approver,
      tenantId: TENANT,
    });
    const bindingLeg = await gateway.initiateGatewayRefund({
      tenantId: TENANT,
      billing_refund_id: bindingRefund.id,
      gateway_order_id: orderId,
      initiated_by: refundActors.initiator,
    });
    const [foreignBinding] = await prisma.$queryRawUnsafe(
      `SELECT recovery_task_id, recovery_sla_instance_id
         FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid AND id = $2::int
          AND recovery_task_id IS NOT NULL
          AND recovery_sla_instance_id IS NOT NULL
        LIMIT 1`,
      TENANT,
      Number(bindingLeg.id),
    );
    expect(foreignBinding).toBeTruthy();
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE payment_gateway_refunds
              SET recovery_task_id = $3::int,
                  recovery_sla_instance_id = $4::uuid
            WHERE id = $1::int AND tenant_id = $2::uuid`,
          Number(leg.id),
          TENANT,
          Number(foreignBinding.recovery_task_id),
          String(foreignBinding.recovery_sla_instance_id),
        );
      }),
    ).rejects.toThrow(/gateway refund recovery task and SLA pointers are not an exact typed obligation/);
    const [preservedBinding] = await prisma.$queryRawUnsafe(
      `SELECT recovery_task_id, recovery_sla_instance_id
         FROM payment_gateway_refunds
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(leg.id),
      TENANT,
    );
    expect(Number(preservedBinding.recovery_task_id))
      .toBe(Number(originalBinding.recovery_task_id));
    expect(String(preservedBinding.recovery_sla_instance_id))
      .toBe(String(originalBinding.recovery_sla_instance_id));

    const observedAt = new Date().toISOString();
    const evidenceReference = `provider-case-${randomUUID()}`;
    await gateway.resolveGatewayRefundReconciliation({
      tenantId: TENANT,
      id: leg.id,
      disposition: 'provider_pending',
      evidence: {
        source: 'provider_dashboard',
        reference: evidenceReference,
        observed_at: observedAt,
        provider_status: 'pending',
        notes: 'Provider still processing the refund',
      },
      resolved_by: refundActors.reviewer,
    });
    const [pendingReview] = await prisma.$queryRawUnsafe(
      `SELECT refund.reconciled_at, refund.reconciliation_disposition,
              refund.reconciliation_evidence, refund.recovery_state,
              refund.recovery_next_attempt_at,
              task.status AS task_status, task.completed_at AS task_completed_at,
              sla.status AS sla_status, sla.completed_at AS sla_completed_at
         FROM payment_gateway_refunds refund
         JOIN tasks task
           ON task.tenant_id = refund.tenant_id
          AND task.id = refund.recovery_task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = refund.tenant_id
          AND sla.id = refund.recovery_sla_instance_id
        WHERE refund.tenant_id = $1::uuid AND refund.id = $2::int`,
      TENANT,
      Number(leg.id),
    );
    expect(pendingReview).toMatchObject({
      reconciled_at: null,
      reconciliation_disposition: 'provider_pending',
      recovery_state: 'provider_pending',
      task_status: 'open',
      task_completed_at: null,
      sla_completed_at: null,
    });
    expect(pendingReview.reconciliation_evidence).toMatchObject({
      source: 'provider_dashboard',
      reference: evidenceReference,
      provider_status: 'pending',
    });
    expect(pendingReview.recovery_next_attempt_at).not.toBeNull();
    expect(['active', 'breached']).toContain(pendingReview.sla_status);

    const unknownReference = `provider-support-${randomUUID()}`;
    await gateway.resolveGatewayRefundReconciliation({
      tenantId: TENANT,
      id: leg.id,
      disposition: 'provider_status_unknown',
      evidence: {
        source: 'provider_support',
        reference: unknownReference,
        observed_at: observedAt,
        provider_status: 'unknown',
        notes: 'Provider support could not yet establish a terminal state',
      },
      resolved_by: refundActors.reviewer,
    });
    const [unknownReview] = await prisma.$queryRawUnsafe(
      `SELECT refund.reconciled_at, refund.reconciliation_disposition,
              refund.recovery_state, refund.recovery_next_attempt_at,
              task.status AS task_status, task.completed_at AS task_completed_at
         FROM payment_gateway_refunds refund
         JOIN tasks task
           ON task.tenant_id = refund.tenant_id
          AND task.id = refund.recovery_task_id
        WHERE refund.tenant_id = $1::uuid AND refund.id = $2::int`,
      TENANT,
      Number(leg.id),
    );
    expect(unknownReview).toMatchObject({
      reconciled_at: null,
      reconciliation_disposition: 'provider_status_unknown',
      recovery_state: 'provider_pending',
      task_status: 'open',
      task_completed_at: null,
    });
    expect(unknownReview.recovery_next_attempt_at).not.toBeNull();

    const processedObservation = {
      source: 'provider_dashboard',
      reference: evidenceReference,
      observed_at: observedAt,
      provider_status: 'processed',
      notes: 'Provider dashboard now confirms processed',
    };
    await expect(gateway.resolveGatewayRefundReconciliation({
      tenantId: TENANT,
      id: leg.id,
      disposition: 'provider_processed',
      evidence: processedObservation,
      resolved_by: refundActors.approver,
    })).rejects.toMatchObject({
      code: 'PAYMENT_GATEWAY_REFUND_RECONCILIATION_REVIEWER_NOT_INDEPENDENT',
    });
    await gateway.resolveGatewayRefundReconciliation({
      tenantId: TENANT,
      id: leg.id,
      disposition: 'provider_processed',
      evidence: processedObservation,
      resolved_by: refundActors.reviewer,
    });
    const [operatorObservation] = await prisma.$queryRawUnsafe(
      `SELECT refund.reconciled_at, refund.reconciliation_disposition,
              refund.reconciliation_evidence, refund.reconciled_by,
              refund.reconciliation_reviewed_by, refund.recovery_state,
              refund.recovery_next_attempt_at,
              task.status AS task_status, task.completed_at AS task_completed_at,
              sla.status AS sla_status, sla.completed_at AS sla_completed_at
         FROM payment_gateway_refunds refund
         JOIN tasks task
           ON task.tenant_id = refund.tenant_id
          AND task.id = refund.recovery_task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = refund.tenant_id
          AND sla.id = refund.recovery_sla_instance_id
        WHERE refund.tenant_id = $1::uuid AND refund.id = $2::int`,
      TENANT,
      Number(leg.id),
    );
    expect(operatorObservation).toMatchObject({
      reconciled_at: null,
      reconciled_by: null,
      reconciliation_disposition: 'provider_processed',
      reconciliation_reviewed_by: refundActors.reviewer,
      recovery_state: 'provider_pending',
      task_status: 'open',
      task_completed_at: null,
      sla_completed_at: null,
    });
    expect(operatorObservation.reconciliation_evidence).toMatchObject(processedObservation);
    expect(operatorObservation.recovery_next_attempt_at).not.toBeNull();
    expect(['active', 'breached']).toContain(operatorObservation.sla_status);

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
        disposition: 'provider_processed',
        evidence: expect.objectContaining({
          source: 'provider_dashboard',
          reference: evidenceReference,
          provider_status: 'processed',
        }),
        reviewed_by: refundActors.reviewer,
        superseded_by: 'exact_provider_processed_evidence',
      }),
    ]);
  });

  it('keeps a no-id manual failure replacement-blocking until late processed evidence settles it', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(patient, 260);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId,
      amount: 70,
      reason: 'no provider id manual failure',
      mode: 'UPI',
      raised_by: refundActors.raiser,
      tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, {
      approved_by: refundActors.approver,
      tenantId: TENANT,
    });
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT,
      billing_refund_id: refund.id,
      gateway_order_id: orderId,
      initiated_by: refundActors.initiator,
    });
    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET status = 'requires_reconciliation',
              provider_refund_id = NULL,
              recovery_state = 'requires_reconciliation',
              recovery_next_attempt_at = NULL,
              recovery_terminal_at = NOW(),
              failure_code = 'provider_status_unknown',
              failure_reason = 'Provider identifier was not available',
              updated_at = NOW()
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(leg.id),
      TENANT,
    );

    const observedAt = new Date().toISOString();
    await gateway.resolveGatewayRefundReconciliation({
      tenantId: TENANT,
      id: leg.id,
      disposition: 'provider_failed',
      evidence: {
        source: 'provider_support',
        reference: `provider-failure-without-id-${randomUUID()}`,
        observed_at: observedAt,
        provider_status: 'failed',
      },
      resolved_by: refundActors.reviewer,
    });
    const [openFailure] = await prisma.$queryRawUnsafe(
      `SELECT refund.status, refund.provider_refund_id, refund.reconciled_at,
              refund.reconciliation_disposition, refund.recovery_state,
              task.status AS task_status, task.completed_at AS task_completed_at,
              sla.completed_at AS sla_completed_at,
              billing.approval_status
         FROM payment_gateway_refunds refund
         JOIN billing_refunds billing
           ON billing.tenant_id = refund.tenant_id
          AND billing.id = refund.billing_refund_id
         JOIN tasks task
           ON task.tenant_id = refund.tenant_id
          AND task.id = refund.recovery_task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = refund.tenant_id
          AND sla.id = refund.recovery_sla_instance_id
        WHERE refund.id = $1::int AND refund.tenant_id = $2::uuid`,
      Number(leg.id),
      TENANT,
    );
    expect(openFailure).toMatchObject({
      status: 'requires_reconciliation',
      provider_refund_id: null,
      reconciled_at: null,
      reconciliation_disposition: 'provider_failed',
      recovery_state: 'provider_pending',
      task_status: 'open',
      task_completed_at: null,
      sla_completed_at: null,
      approval_status: 'APPROVED',
    });

    const createRefundSpy = jest.spyOn(dryRunAdapter, 'createRefund');
    try {
      const replacementAttempt = await gateway.initiateGatewayRefund({
        tenantId: TENANT,
        billing_refund_id: refund.id,
        gateway_order_id: orderId,
        initiated_by: refundActors.initiator,
      });
      expect(replacementAttempt).toMatchObject({
        id: Number(leg.id),
        status: 'requires_reconciliation',
        replay: true,
      });
      expect(createRefundSpy).not.toHaveBeenCalled();
    } finally {
      createRefundSpy.mockRestore();
    }

    const lateProviderRefundId = `rfnd_dry_late${randomUUID().replaceAll('-', '')}`;
    const late = await gateway.handleRefundProcessedEvent({
      tenantId: TENANT,
      config,
      payload: { payload: { refund: { entity: {
        id: lateProviderRefundId,
        payment_id: providerPaymentId,
        amount: toPaise(70),
        currency: 'INR',
        status: 'processed',
        notes: { billing_refund_id: String(refund.id) },
      } } } },
    });
    expect(late).toMatchObject({
      outcome: 'refund_processed',
      gatewayRefundId: Number(leg.id),
      billingRefundId: Number(refund.id),
    });
    const [settled] = await prisma.$queryRawUnsafe(
      `SELECT refund.status, refund.provider_refund_id, refund.recovery_state,
              billing.approval_status, billing.reference,
              task.status AS task_status, sla.completed_at AS sla_completed_at
         FROM payment_gateway_refunds refund
         JOIN billing_refunds billing
           ON billing.tenant_id = refund.tenant_id
          AND billing.id = refund.billing_refund_id
         JOIN tasks task
           ON task.tenant_id = refund.tenant_id
          AND task.id = refund.recovery_task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = refund.tenant_id
          AND sla.id = refund.recovery_sla_instance_id
        WHERE refund.id = $1::int AND refund.tenant_id = $2::uuid`,
      Number(leg.id),
      TENANT,
    );
    expect(settled).toMatchObject({
      status: 'processed',
      provider_refund_id: lateProviderRefundId,
      recovery_state: 'succeeded',
      approval_status: 'PAID',
      reference: lateProviderRefundId,
      task_status: 'completed',
    });
    expect(settled.sla_completed_at).not.toBeNull();
  });

  it('atomically parks a processed payout conflict while retaining its open task and SLA', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(patient, 230);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId,
      amount: 85,
      reason: 'provider/manual payout conflict',
      mode: 'UPI',
      raised_by: refundActors.raiser,
      tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, {
      approved_by: refundActors.approver,
      tenantId: TENANT,
    });
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT,
      billing_refund_id: refund.id,
      gateway_order_id: orderId,
      initiated_by: refundActors.initiator,
    });
    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET status = 'requires_reconciliation',
              failure_code = 'provider_status_unknown',
              failure_reason = 'Operator checked provider status',
              updated_at = NOW()
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(leg.id),
      TENANT,
    );
    const observedAt = new Date().toISOString();
    await gateway.resolveGatewayRefundReconciliation({
      tenantId: TENANT,
      id: leg.id,
      disposition: 'provider_processed',
      evidence: {
        source: 'provider_dashboard',
        reference: `provider-conflict-${randomUUID()}`,
        observed_at: observedAt,
        provider_status: 'processed',
      },
      resolved_by: refundActors.reviewer,
    });
    const [openObligation] = await prisma.$queryRawUnsafe(
      `SELECT refund.recovery_task_id, refund.recovery_sla_instance_id,
              task.status AS task_status, task.completed_at AS task_completed_at,
              sla.status AS sla_status, sla.completed_at AS sla_completed_at
         FROM payment_gateway_refunds refund
         JOIN tasks task
           ON task.tenant_id = refund.tenant_id
          AND task.id = refund.recovery_task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = refund.tenant_id
          AND sla.id = refund.recovery_sla_instance_id
        WHERE refund.id = $1::int AND refund.tenant_id = $2::uuid`,
      Number(leg.id),
      TENANT,
    );
    expect(openObligation.task_status).toBe('open');
    expect(openObligation.task_completed_at).toBeNull();
    expect(openObligation.sla_completed_at).toBeNull();

    await prisma.$executeRawUnsafe(
      `UPDATE billing_refunds
          SET approval_status = 'PAID',
              paid_by = $3::uuid,
              paid_at = NOW(),
              reference = $4,
              payout_rail = 'manual',
              payout_rail_claimed_at = NOW(),
              gateway_refund_id = NULL,
              updated_at = NOW()
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(refund.id),
      TENANT,
      refundActors.payer,
      `manual-conflict-${randomUUID()}`,
    );

    const conflict = await gateway.handleRefundProcessedEvent({
      tenantId: TENANT,
      config,
      payload: { payload: { refund: { entity: {
        id: leg.provider_refund_id,
        payment_id: providerPaymentId,
        amount: toPaise(85),
        currency: 'INR',
        status: 'processed',
        notes: { billing_refund_id: String(refund.id) },
      } } } },
    });
    expect(conflict).toMatchObject({
      outcome: 'requires_reconciliation',
      gatewayRefundId: Number(leg.id),
      billingRefundId: Number(refund.id),
      reason: 'payout_rail_conflict',
    });

    const [rearmed] = await prisma.$queryRawUnsafe(
      `SELECT refund.status, refund.failure_code, refund.reconciled_at,
              refund.reconciliation_disposition,
              refund.recovery_task_id, refund.recovery_sla_instance_id,
              task.status AS task_status, task.completed_at AS task_completed_at,
              task.metadata AS task_metadata,
              sla.status AS sla_status, sla.completed_at AS sla_completed_at,
              sla.metadata AS sla_metadata
         FROM payment_gateway_refunds refund
         JOIN tasks task
           ON task.tenant_id = refund.tenant_id
          AND task.id = refund.recovery_task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = refund.tenant_id
          AND sla.id = refund.recovery_sla_instance_id
        WHERE refund.id = $1::int AND refund.tenant_id = $2::uuid`,
      Number(leg.id),
      TENANT,
    );
    expect(rearmed).toMatchObject({
      status: 'requires_reconciliation',
      failure_code: 'payout_rail_conflict',
      reconciled_at: null,
      reconciliation_disposition: null,
      task_status: 'open',
      task_completed_at: null,
      sla_status: 'active',
      sla_completed_at: null,
    });
    expect(Number(rearmed.recovery_task_id)).toBe(Number(openObligation.recovery_task_id));
    expect(String(rearmed.recovery_sla_instance_id))
      .toBe(String(openObligation.recovery_sla_instance_id));
    const rearmOutbox = await prisma.$queryRawUnsafe(
      `SELECT id FROM notification_outbox
        WHERE tenant_id = $1::uuid
          AND source_event_key LIKE $2`,
      TENANT,
      `gateway-refund-recovery:${Number(leg.id)}:requires_reconciliation:payout_rail_conflict:%`,
    );
    expect(rearmOutbox.length).toBeGreaterThan(0);
  });

  it('two concurrent initiations converge on one idempotent provider refund effect', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId } = await makeCapturedGatewayPayment(patient, 300);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 120, reason: 'race refund', mode: 'UPI',
      raised_by: refundActors.raiser, tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, {
      approved_by: refundActors.approver, tenantId: TENANT,
    });

    // Both racers reuse the committed provider key and converge on exactly
    // one execution row / provider refund effect.
    const [a, b] = await Promise.all([
      gateway.initiateGatewayRefund({
        tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
        initiated_by: refundActors.initiator,
      }),
      gateway.initiateGatewayRefund({
        tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
        initiated_by: refundActors.initiator,
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
      invoice_id: invoiceId, amount: 80, reason: 'rail race refund', mode: 'UPI',
      raised_by: refundActors.raiser, tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, {
      approved_by: refundActors.approver, tenantId: TENANT,
    });

    const outcomes = await Promise.allSettled([
      gateway.initiateGatewayRefund({
        tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
        initiated_by: refundActors.initiator,
      }),
      billing.markRefundPaid(refund.id, {
        tenantId: TENANT, reference: `manual-${randomUUID()}`,
        paid_by: refundActors.payer,
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
        paid_by: refundActors.payer,
      })).rejects.toMatchObject({ code: 'BILLING_REFUND_PAYOUT_RAIL_CONFLICT' });
    }
  });

  it('keeps the manual rail blocked across the provider-call crash window', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(patient, 260);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 70, reason: 'crash-window rail guard', mode: 'UPI',
      raised_by: refundActors.raiser, tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, {
      approved_by: refundActors.approver, tenantId: TENANT,
    });
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
      initiated_by: refundActors.initiator,
    });

    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET status = 'initiated', provider_refund_id = NULL
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      Number(leg.id), TENANT,
    );
    await expect(billing.markRefundPaid(refund.id, {
      tenantId: TENANT, reference: `manual-crash-${randomUUID()}`,
      paid_by: refundActors.payer,
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
      invoice_id: invoiceId, amount: 75, reason: 'failed provider refund', mode: 'UPI',
      raised_by: refundActors.raiser, tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, {
      approved_by: refundActors.approver, tenantId: TENANT,
    });
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
      initiated_by: refundActors.initiator,
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

  it('refund.failed evidence mismatch durably reconciles and an exact redelivery self-heals to failed', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(patient, 180);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 60, reason: 'mismatched failure evidence', mode: 'UPI',
      raised_by: refundActors.raiser, tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, {
      approved_by: refundActors.approver, tenantId: TENANT,
    });
    const leg = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
      initiated_by: refundActors.initiator,
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
      invoice_id: invoiceId, amount: 55, reason: 'retry after provider failure', mode: 'UPI',
      raised_by: refundActors.raiser, tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, {
      approved_by: refundActors.approver, tenantId: TENANT,
    });
    const first = await gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: refund.id, gateway_order_id: orderId,
      initiated_by: refundActors.initiator,
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
      initiated_by: refundActors.initiator,
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

  it('parks an independently claimed row with invalid historical authority before provider I/O', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId, providerPaymentId } = await makeCapturedGatewayPayment(patient, 205);
    const refund = await billing.raiseRefund({
      invoice_id: invoiceId,
      amount: 45,
      reason: 'historical authority recovery probe',
      mode: 'UPI',
      raised_by: refundActors.raiser,
      tenantId: TENANT,
    });
    cleanup.refundIds.push(refund.id);
    await billing.approveRefund(refund.id, {
      approved_by: refundActors.approver,
      tenantId: TENANT,
    });

    const invalidLeg = await setTenantTx(TENANT, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO payment_gateway_refunds
           (tenant_id, provider, environment, gateway_order_id, billing_refund_id,
            provider_payment_id, provider_refund_id, provider_idempotency_key,
            amount, currency, status, reason, initiated_by, initiated_at,
            webhook_credential_version, provider_request_replay_authorized,
            recovery_state, recovery_terminal_at)
         VALUES
           ($1::uuid, 'dry_run', 'sandbox', $2::int, $3::int,
            $4, $5, $6, 45::numeric, 'INR', 'requires_reconciliation',
            'historical invalid four-eyes row', $7::uuid, NOW(), 1, FALSE,
            'requires_reconciliation', NOW())
         RETURNING *`,
        TENANT,
        Number(orderId),
        Number(refund.id),
        providerPaymentId,
        `rfnd_dry_invalid${randomUUID().replaceAll('-', '')}`,
        `pgr_historical_invalid_${randomUUID().replaceAll('-', '')}`,
        refundActors.approver,
      );
      await tx.$executeRawUnsafe(
        `UPDATE billing_refunds
            SET payout_rail = 'gateway', payout_rail_claimed_at = NOW(),
                gateway_refund_id = $3::int, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        TENANT,
        Number(refund.id),
        Number(rows[0].id),
      );
      const obligation = await refundRecovery.ensureGatewayRefundRecoveryObligationTx({
        tx,
        tenantId: TENANT,
        gatewayRefundId: rows[0].id,
      });
      return obligation.row;
    });

    const fetchSpy = jest.spyOn(dryRunAdapter, 'fetchRefund');
    try {
      const result = await refundRecovery.recoverGatewayRefundNow({
        tenantId: TENANT,
        gatewayRefundId: invalidLeg.id,
        actorUid: refundActors.reviewer,
      });
      expect(result).toMatchObject({
        id: Number(invalidLeg.id),
        status: 'requires_reconciliation',
        recovery_state: 'requires_reconciliation',
        recovery_last_error_code: 'PAYMENT_GATEWAY_REFUND_INITIATOR_AUTHORITY_INVALID',
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('isolates a failed batch row, renews the next lease before provider I/O, and hides claim authority', async () => {
    const patient = await makePatient();
    const firstPayment = await makeCapturedGatewayPayment(patient, 190);
    const secondPayment = await makeCapturedGatewayPayment(patient, 195);
    const makePendingLeg = async (payment, amount, reason) => {
      const refund = await billing.raiseRefund({
        invoice_id: payment.invoiceId,
        amount,
        reason,
        mode: 'UPI',
        raised_by: refundActors.raiser,
        tenantId: TENANT,
      });
      cleanup.refundIds.push(refund.id);
      await billing.approveRefund(refund.id, {
        approved_by: refundActors.approver,
        tenantId: TENANT,
      });
      return gateway.initiateGatewayRefund({
        tenantId: TENANT,
        billing_refund_id: refund.id,
        gateway_order_id: payment.orderId,
        initiated_by: refundActors.initiator,
      });
    };
    const first = await makePendingLeg(firstPayment, 35, 'batch isolation first');
    const second = await makePendingLeg(secondPayment, 40, 'batch isolation second');
    const targetIds = [Number(first.id), Number(second.id)].sort((a, b) => a - b);
    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET recovery_next_attempt_at = NOW() + INTERVAL '1 day'
        WHERE tenant_id = $1::uuid
          AND recovery_state IN (
            'queued', 'provider_pending', 'retry_wait', 'requires_reconciliation'
          )
          AND id <> ALL($2::int[])`,
      TENANT,
      targetIds,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET recovery_state = 'queued',
              recovery_next_attempt_at = NOW() - INTERVAL '1 minute',
              recovery_terminal_at = NULL,
              recovery_claim_token = NULL,
              recovery_claimed_at = NULL,
              recovery_lease_expires_at = NULL
        WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
      TENANT,
      targetIds,
    );

    const outboxSpy = jest.spyOn(notificationOutbox, 'queue')
      .mockRejectedValueOnce(new Error('synthetic first-row strict outbox failure'));
    const fetchSpy = jest.spyOn(dryRunAdapter, 'fetchRefund')
      .mockImplementationOnce(async (args) => {
        const [liveClaim] = await prisma.$queryRawUnsafe(
          `SELECT recovery_state, recovery_claim_token,
                  recovery_claimed_at, recovery_lease_expires_at
             FROM payment_gateway_refunds
            WHERE tenant_id = $1::uuid AND provider_refund_id = $2`,
          TENANT,
          String(args.providerRefundId),
        );
        expect(liveClaim.recovery_state).toBe('claimed');
        expect(liveClaim.recovery_claim_token).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        expect(new Date(liveClaim.recovery_lease_expires_at).getTime())
          .toBeGreaterThan(new Date(liveClaim.recovery_claimed_at).getTime());
        return {
          providerRefundId: args.providerRefundId,
          providerPaymentId: args.providerPaymentId,
          amountPaise: args.amountPaise,
          currency: args.currency,
          billingRefundId: String(args.billingRefundId),
          status: 'pending',
        };
      });
    try {
      const result = await refundRecovery.runGatewayRefundRecoverySweep({
        tenantId: TENANT,
        limit: 2,
      });
      expect(result).toMatchObject({
        enabled: true,
        claimed: 2,
        processed: 1,
        failed: 1,
        lost_fence: 0,
        persistence_failures: [],
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      outboxSpy.mockRestore();
    }

    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, recovery_state, recovery_claim_token,
              recovery_claimed_at, recovery_lease_expires_at
         FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid AND id = ANY($2::int[])
        ORDER BY id`,
      TENANT,
      targetIds,
    );
    expect(rows.map(row => row.recovery_state)).toEqual(['retry_wait', 'provider_pending']);
    for (const row of rows) {
      expect(row.recovery_claim_token).toBeNull();
      expect(row.recovery_claimed_at).toBeNull();
      expect(row.recovery_lease_expires_at).toBeNull();
    }
    const listed = await refundRecovery.listGatewayRefundRecovery({
      tenantId: TENANT,
      include_terminal: true,
      limit: 100,
    });
    const visible = listed.refunds.filter(row => targetIds.includes(Number(row.id)));
    expect(visible).toHaveLength(2);
    for (const row of visible) {
      expect(row).not.toHaveProperty('provider_idempotency_key');
      expect(row).not.toHaveProperty('provider_request_replay_authorized');
      expect(row).not.toHaveProperty('recovery_claim_token');
      expect(row).not.toHaveProperty('key_secret_ciphertext');
      expect(row).not.toHaveProperty('billing_approved_by');
      expect(row).not.toHaveProperty('metadata');
    }
  });

  it('refuses execution for a refund that is not APPROVED or not gateway-collected', async () => {
    const patient = await makePatient();
    const { invoiceId, orderId } = await makeCapturedGatewayPayment(patient, 200);

    // PENDING (not yet approved) → rejected.
    const pendingRefund = await billing.raiseRefund({
      invoice_id: invoiceId, amount: 50, reason: 'not yet approved', mode: 'UPI',
      raised_by: refundActors.raiser, tenantId: TENANT,
    });
    cleanup.refundIds.push(pendingRefund.id);
    await expect(gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: pendingRefund.id,
      gateway_order_id: orderId,
      initiated_by: refundActors.initiator,
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
      invoice_id: inv2.id, amount: 40, reason: 'cash path', mode: 'CASH',
      raised_by: refundActors.raiser, tenantId: TENANT,
    });
    cleanup.refundIds.push(cashRefund.id);
    await billing.approveRefund(cashRefund.id, {
      approved_by: refundActors.approver, tenantId: TENANT,
    });
    await expect(gateway.initiateGatewayRefund({
      tenantId: TENANT, billing_refund_id: cashRefund.id,
      gateway_order_id: 2147483647,
      initiated_by: refundActors.initiator,
    })).rejects.toMatchObject({ code: 'PAYMENT_GATEWAY_REFUND_NOT_GATEWAY_COLLECTED' });
  });
});
