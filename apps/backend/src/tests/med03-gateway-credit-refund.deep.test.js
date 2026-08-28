import { randomUUID } from 'node:crypto';

import prisma from '../lib/prisma.js';
import {
  applyBillingCreditNote,
  approveBillingCreditNote,
  listBillingCreditNotes,
} from '../services/billing/billingCreditNoteService.js';
import { approveRefund, issueInvoice } from '../services/billing/billingV2Service.js';
import * as gateway from '../services/billing/paymentGatewayService.js';
import {
  approveWardIndent,
  createWardIndent,
  issueWardIndent,
  receiveWardIndent,
  reconcileWardIndent,
  requestWardIndentReturn,
  reserveWardIndent,
} from '../services/ipd/ipdSupportService.js';
import { toPaise } from '../utils/money.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb('MED-03 gateway ward-credit refund closure', () => {
  const tenantId = randomUUID();
  const requester = randomUUID();
  const pharmacist = randomUUID();
  const receiver = randomUUID();
  const billingOwner = randomUUID();
  const admin = randomUUID();
  const patient = randomUUID();
  const run = `${process.pid}-${Date.now()}`;
  const previousGatewayEnabled = process.env.PAYMENT_GATEWAY_ENABLED;
  const previousLedgerMode = process.env.LEDGER_AUTHORITATIVE_MODE;
  let wardId;
  let catalogId;
  let config;

  beforeAll(async () => {
    process.env.PAYMENT_GATEWAY_ENABLED = 'true';
    process.env.LEDGER_AUTHORITATIVE_MODE = 'enforce';
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants
         (id, slug, name, region, status, settings, created_at, updated_at)
       VALUES
         ($1::uuid, $2::text, 'MED-03 Gateway Credit Test', 'IN', 'active',
          '{"paymentGateway":{"enabled":true}}'::jsonb, NOW(), NOW())`,
      tenantId,
      `med03-gateway-credit-${run}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO ledger_accounts (tenant_id, code, type, description)
         SELECT $1::uuid, code, type, description
           FROM ledger_accounts
          WHERE tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
        ON CONFLICT (tenant_id, code) DO NOTHING`,
      tenantId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, name, role, is_active, status, updated_at)
       VALUES
         ($1::uuid, $7::uuid, 'Request Nurse', 'IP_STAFF_NURSE', TRUE, 'active', NOW()),
         ($2::uuid, $7::uuid, 'Pharmacist', 'PHARMACY_INCHARGE', TRUE, 'active', NOW()),
         ($3::uuid, $7::uuid, 'Receipt Nurse', 'NURSING_INCHARGE', TRUE, 'active', NOW()),
         ($4::uuid, $7::uuid, 'Billing Owner', 'BILLING_INCHARGE', TRUE, 'active', NOW()),
         ($5::uuid, $7::uuid, 'Admin Approver', 'ADMIN', TRUE, 'active', NOW()),
         ($6::uuid, $7::uuid, 'Patient', 'PATIENT', TRUE, 'active', NOW())`,
      requester,
      pharmacist,
      receiver,
      billingOwner,
      admin,
      patient,
      tenantId,
    );
    wardId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO wards (tenant_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $2::text, 10, NOW(), NOW()) RETURNING id`,
      tenantId,
      `MED-03 Gateway Credit Ward ${run}`,
    ))[0].id);
    catalogId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, is_active, stock_quantity, unit_price, price,
          strength, strength_key, form, form_key, route, updated_at)
       VALUES ($1::uuid, $2::text, TRUE, 20, 12.50, 12.50,
               '500 mg', '500mg', 'tablet', 'tablet', 'oral', NOW())
       RETURNING id`,
      tenantId,
      `MED-03 Gateway Credit Medicine ${run}`,
    ))[0].id);
    const inventoryItemId = Number((await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, strength, form,
          unit_label, schedule_class, is_narcotic)
       VALUES ($1::uuid, $2::text, $3::text, $4::int, '500 mg', 'tablet',
               'unit', 'OTC', FALSE) RETURNING id`,
      tenantId,
      `MED03-GATEWAY-CREDIT-${run}`,
      `MED-03 Gateway Credit Medicine ${run}`,
      catalogId,
    ))[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, expiry_date,
          received_quantity, remaining_quantity, status)
       VALUES ($1::uuid, $2::int, $3::text, (NOW() + INTERVAL '365 days')::date,
               20, 20, 'in_stock')`,
      tenantId,
      inventoryItemId,
      `MED03-GATEWAY-CREDIT-BATCH-${run}`,
    );
    config = await gateway.upsertGatewayConfig({
      tenantId,
      provider: 'dry_run',
      environment: 'sandbox',
      enabled: true,
      webhook_secret: `med03-gateway-credit-${run}-webhook-secret`,
    });
  });

  afterAll(async () => {
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        for (const table of ['ledger_postings', 'ledger_entries', 'ledger_balances']) {
          await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, tenantId);
        }
        for (const table of [
          'idempotency_keys',
          'task_comments',
          'tasks',
          'notification_outbox',
          'workflow_sla_instances',
          'payment_gateway_webhook_events',
          'payment_gateway_refunds',
          'payment_gateway_orders',
          'payment_gateway_provider_configs',
          'billing_credit_note_events',
          'billing_credit_notes',
          'billing_refunds',
          'ward_indent_financial_events',
          'ward_indent_inventory_movement_links',
          'ward_indent_inventory_allocations',
          'ward_indent_events',
          'clinical_timeline_events',
          'clinical_audit_events',
          'billing_payments',
          'billing_invoice_items',
          'billing_invoices',
          'pharmacy_stock_movements',
          'pharmacy_inventory_batches',
          'pharmacy_inventory_items',
          'ward_indent_items',
          'ward_indents',
          'clinical_orders',
          'ledger_accounts',
          'pharmacy_catalog',
          'wards',
          'users',
        ]) {
          await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, tenantId);
        }
        await tx.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, tenantId);
      });
    } finally {
      if (previousGatewayEnabled === undefined) delete process.env.PAYMENT_GATEWAY_ENABLED;
      else process.env.PAYMENT_GATEWAY_ENABLED = previousGatewayEnabled;
      if (previousLedgerMode === undefined) delete process.env.LEDGER_AUTHORITATIVE_MODE;
      else process.env.LEDGER_AUTHORITATIVE_MODE = previousLedgerMode;
      if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
    }
  });

  test('settles a paid ward credit through one exact gateway refund across concurrent replay', async () => {
    const created = await createWardIndent({
      wardId,
      patientUid: patient,
      indentType: 'pharmacy',
      items: [{
        pharmacy_catalog_id: catalogId,
        item_name: 'Caller name is not authoritative',
        quantity_requested: 2,
      }],
      requestedBy: requester,
      commandKey: `create-${run}`,
      tenantId,
    });
    const reserved = await reserveWardIndent({
      indentId: created.id,
      reservedBy: pharmacist,
      expectedVersion: 1,
      commandKey: `reserve-${run}`,
      tenantId,
    });
    const approved = await approveWardIndent({
      indentId: created.id,
      approvedBy: pharmacist,
      expectedVersion: reserved.state_version,
      commandKey: `approve-${run}`,
      tenantId,
    });
    const issued = await issueWardIndent({
      indentId: created.id,
      issuedBy: pharmacist,
      expectedVersion: approved.state_version,
      commandKey: `issue-${run}`,
      tenantId,
    });
    const charge = (await prisma.$queryRawUnsafe(
      `SELECT invoice_id FROM ward_indent_financial_events
        WHERE tenant_id = $1::uuid AND ward_indent_id = $2::int
          AND event_kind = 'charge' LIMIT 1`,
      tenantId,
      Number(created.id),
    ))[0];
    const invoiceId = Number(charge.invoice_id);
    const invoice = await issueInvoice(invoiceId, { tenantId });
    const order = await gateway.createGatewayOrder({
      tenantId,
      invoice_id: invoiceId,
      actor: { uid: patient, role: 'PATIENT' },
    });
    const providerPaymentId = `pay_dry_${randomUUID().slice(0, 8)}`;
    const captured = await gateway.handleCaptureEvent({
      tenantId,
      config,
      payload: {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: providerPaymentId,
              order_id: order.providerOrderId,
              method: 'upi',
              amount: toPaise(invoice.total_amount),
              currency: 'INR',
            },
          },
        },
      },
    });
    expect(captured.outcome).toBe('captured');

    const received = await receiveWardIndent({
      indentId: created.id,
      receivedBy: receiver,
      expectedVersion: issued.state_version,
      commandKey: `receive-${run}`,
      tenantId,
    });
    const returnPending = await requestWardIndentReturn({
      indentId: created.id,
      requestedBy: receiver,
      itemQuantitiesReturned: [{ item_id: created.items[0].id, quantity_returned: 1 }],
      reason: 'One gateway-paid unit was unused',
      expectedVersion: received.state_version,
      commandKey: `return-${run}`,
      tenantId,
    });
    await reconcileWardIndent({
      indentId: created.id,
      reconciledBy: pharmacist,
      reason: 'Gateway-paid stock returned to the exact batch',
      expectedVersion: returnPending.state_version,
      commandKey: `reconcile-${run}`,
      tenantId,
    });

    const creditNote = (await listBillingCreditNotes({ tenantId, status: 'pending' }))
      .find((note) => Number(note.ward_indent_id) === Number(created.id));
    expect(creditNote).toMatchObject({ invoice_id: invoiceId, amount_minor: 1250 });
    await approveBillingCreditNote(creditNote.id, {
      tenantId,
      approvedBy: billingOwner,
      commandKey: `credit-approve-${run}`,
    });
    const applied = await applyBillingCreditNote(creditNote.id, {
      tenantId,
      appliedBy: billingOwner,
      refundMode: 'UPI',
      commandKey: `credit-apply-${run}`,
    });
    expect(applied).toMatchObject({
      status: 'applied',
      receivable_credit_minor: 0,
      refund_obligation_minor: 1250,
    });
    const refundId = Number(applied.refund_id);
    const taskBeforePayout = (await prisma.$queryRawUnsafe(
      `SELECT task.id, task.status, sla.status AS sla_status, sla.completed_at
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.metadata->>'obligation_kind' = 'credit_note_review'
          AND task.metadata->>'credit_note_id' = $2::text`,
      tenantId,
      String(creditNote.id),
    ))[0];
    expect(taskBeforePayout).toMatchObject({
      status: 'open',
      sla_status: 'active',
      completed_at: null,
    });
    await approveRefund(refundId, { approved_by: admin, tenantId });

    const leg = await gateway.initiateGatewayRefund({
      tenantId,
      billing_refund_id: refundId,
      gateway_order_id: Number(order.orderId),
      initiated_by: billingOwner,
    });
    expect(leg).toMatchObject({
      status: 'pending',
      billing_refund_id: refundId,
      initiated_by: billingOwner,
    });
    const payload = {
      event: 'refund.processed',
      payload: {
        refund: {
          entity: {
            id: leg.provider_refund_id,
            payment_id: providerPaymentId,
            amount: toPaise(12.5),
            currency: 'INR',
            status: 'processed',
            notes: { billing_refund_id: String(refundId) },
          },
        },
      },
    };
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => (
      gateway.handleRefundProcessedEvent({ tenantId, config, payload })
    )));
    expect(concurrent.filter(({ outcome }) => outcome === 'refund_processed')).toHaveLength(1);
    expect(concurrent.filter(({ outcome }) => outcome === 'replay')).toHaveLength(3);
    await expect(gateway.handleRefundProcessedEvent({ tenantId, config, payload }))
      .resolves.toMatchObject({ outcome: 'replay' });

    const authority = (await prisma.$queryRawUnsafe(
      `SELECT approval_status, paid_by::text, payout_rail, gateway_refund_id, reference
         FROM billing_refunds
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      tenantId,
      refundId,
    ))[0];
    expect(authority).toMatchObject({
      approval_status: 'PAID',
      paid_by: null,
      payout_rail: 'gateway',
      gateway_refund_id: Number(leg.id),
      reference: leg.provider_refund_id,
    });
    const execution = (await prisma.$queryRawUnsafe(
      `SELECT status, initiated_by::text, processed_at
         FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      tenantId,
      Number(leg.id),
    ))[0];
    expect(execution).toMatchObject({ status: 'processed', initiated_by: billingOwner });
    expect(execution.processed_at).not.toBeNull();
    const ledgerEntries = await prisma.$queryRawUnsafe(
      `SELECT id, entry_type FROM ledger_entries
        WHERE tenant_id = $1::uuid AND idempotency_key = $2::text`,
      tenantId,
      `refund-paid-${refundId}`,
    );
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0].entry_type).toBe('REFUND_PAID');

    const completed = (await prisma.$queryRawUnsafe(
      `SELECT task.status, sla.status AS sla_status, sla.completed_at,
              sla.metadata AS sla_metadata
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid AND task.id = $2::int`,
      tenantId,
      Number(taskBeforePayout.id),
    ))[0];
    expect(completed).toMatchObject({
      status: 'completed',
      sla_status: 'completed',
      sla_metadata: {
        completed_via: 'domain_evidence',
        completed_by: billingOwner,
        completion_evidence: {
          kind: 'billing_credit_note_refund_paid',
          resource_type: 'billing_refund',
          resource_id: String(refundId),
        },
      },
    });
    expect(completed.completed_at).not.toBeNull();
  });
});
