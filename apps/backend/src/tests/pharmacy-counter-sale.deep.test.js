// Deep tests for the walk-in pharmacy point-of-sale (migration 684):
// counterSaleService end-to-end against the seeded QA DB — FEFO allocation +
// atomic stock decrement, schedule-class enforcement (H/H1 rx, X witnessed),
// billingV2 PHARMACY invoice + payment + cash-drawer shift linkage, same-day
// void with exact restock + statutory-register returns, expired/quarantined
// batch rejection, and cross-tenant isolation.
import prisma from '../lib/prisma.js';
import {
  approveCounterSaleWitnessApproval,
  createCounterSale, voidCounterSale, getCounterSale, listCounterSales,
  reconcileCounterSaleVoid, reconcileCounterSaleVoidsForTenant,
  resolveRejectedCounterSaleVoid,
  requestCounterSaleWitnessApproval, searchSellableItems, ensureWalkInAnchorUid,
} from '../services/pharmacy/counterSaleService.js';
import {
  approveRefund,
  markGatewayRefundPaid,
  markOfflineElectronicRefundPaid,
  markRefundPaid,
  rejectRefund,
} from '../services/billing/billingV2Service.js';
import {
  approveInventoryDispenseWitnessApproval,
  dispenseControlled,
  requestControlledDispenseWitnessApproval,
} from '../services/pharmacy/inventoryV2Service.js';
import { authClient } from './testClient.js';

const TENANT = '00000000-0000-4000-8000-0000c05a1e01';
const OTHER = '00000000-0000-4000-8000-0000c05a1e99';
const CASHIER = 'c0511111-1111-4111-8111-111111111111';
const NO_DRAWER_CASHIER = 'c0522222-2222-4222-8222-222222222222';
const WITNESS = 'c0533333-3333-4333-8333-333333333333';
const PATIENT = 'c0544444-4444-4444-8444-444444444444';
const VOID_APPROVER = 'c0599999-9999-4999-8999-999999999999';
const VOID_PAYER = 'c05aaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// Witness-validation fixtures (PR #875 follow-up: witness.uid must be a real,
// active, appropriately-rolled staff member of the same tenant).
const GHOST_WITNESS = 'c0555555-5555-4555-8555-555555555555'; // no users row
const CLERK_WITNESS = 'c0566666-6666-4666-8666-666666666666'; // RECEPTIONIST
const INACTIVE_WITNESS = 'c0577777-7777-4777-8777-777777777777'; // deactivated
const FOREIGN_WITNESS = 'c0588888-8888-4888-8888-888888888888'; // other tenant

const RX = { doctor_name: 'Dr. Test Prescriber', reference: 'RX-POS-001' };

let otcItem; let otcNear; let otcFar;
let h1Item; let h1Batch;
let h1ExpiredBatch; let h1QuarantinedBatch;
let xItem; let xBatch; let xOtherBatch;
let expiredItem;
let foreignItem;
let voidPayerDrawerId;
let voidCommandSequence = 0;

async function remaining(batchId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT remaining_quantity, status FROM pharmacy_inventory_batches WHERE id = $1::int`,
    batchId,
  );
  return { qty: Number(rows[0].remaining_quantity), status: rows[0].status };
}

async function allocationReturnCount(saleId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) FILTER (WHERE allocation.return_movement_id IS NOT NULL)::int AS returned
       FROM pharmacy_counter_sale_allocations allocation
       JOIN pharmacy_counter_sale_lines line
         ON line.tenant_id = allocation.tenant_id
        AND line.id = allocation.counter_sale_line_id
      WHERE allocation.tenant_id = $1::uuid
        AND line.counter_sale_id = $2::bigint`,
    TENANT,
    Number(saleId),
  );
  return Number(rows[0].returned);
}

async function insertItem(tenant, sku, { schedule = null, narcotic = false, hsn = null } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_inventory_items
       (tenant_id, sku_code, display_name, unit_label, schedule_class, is_narcotic, hsn_code)
     VALUES ($1::uuid, $2, $3, 'tab', $4, $5, $6)
     RETURNING id`,
    tenant, sku, `POSTEST ${sku}`, schedule, narcotic, hsn,
  );
  return Number(rows[0].id);
}

async function insertBatch(tenant, itemId, batchNumber, {
  expiryDays = 180, qty = 100, mrpMinor = 1000, status = 'in_stock',
} = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO pharmacy_inventory_batches
       (tenant_id, inventory_item_id, batch_number, expiry_date,
        received_quantity, remaining_quantity, mrp_minor, status)
     VALUES ($1::uuid, $2::int, $3, (NOW() + ($4::int || ' days')::interval)::date,
             $5::numeric, $5::numeric, $6::bigint, $7)
     RETURNING id`,
    tenant, itemId, batchNumber, expiryDays, qty, mrpMinor, status,
  );
  return Number(rows[0].id);
}

async function payCounterSaleVoidRefund(initiated) {
  if (String(initiated.refund.mode).toUpperCase() === 'CASH') {
    await markRefundPaid(initiated.refund.id, {
      tenantId: TENANT,
      paid_by: VOID_PAYER,
      reference: `POS-CASH-VOID-${process.pid}-${voidCommandSequence}`,
      cash_drawer_session_id: voidPayerDrawerId,
    });
  } else {
    const payments = await prisma.$queryRawUnsafe(
      `SELECT id, reference
         FROM billing_payments
        WHERE tenant_id = $1::uuid
          AND invoice_id = $2::int
          AND reversed = false
        ORDER BY id`,
      TENANT,
      Number(initiated.refund.invoice_id),
    );
    expect(payments).toHaveLength(1);
    await markOfflineElectronicRefundPaid(initiated.refund.id, {
      tenantId: TENANT,
      paid_by: VOID_PAYER,
      original_payment_reference: payments[0].reference,
      provider_name: 'POS Test Acquirer',
      provider_refund_reference: `POS-ELECTRONIC-VOID-${process.pid}-${voidCommandSequence}`,
      provider_refunded_at: new Date().toISOString(),
    });
  }
}

async function createCounterSaleGatewayExecution({ initiated, source, label }) {
  const payments = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, amount, mode, reference
       FROM billing_payments
      WHERE tenant_id = $1::uuid
        AND invoice_id = $2::int
        AND reversed = FALSE
      ORDER BY id`,
    TENANT,
    Number(source.invoice.id),
  );
  expect(payments).toHaveLength(1);
  const providerRefundId = `rfnd-pos-${label}-${process.pid}`;
  const orders = await prisma.$queryRawUnsafe(
    `INSERT INTO payment_gateway_orders
       (tenant_id, provider, environment, patient_uid, invoice_id, amount,
        receipt, provider_order_id, provider_payment_id, method, status,
        billing_payment_id, captured_at, created_by, webhook_credential_version)
     VALUES ($1::uuid, 'dry_run', 'sandbox', $2::uuid, $3::int, $4::numeric,
             $5, $6, $7, 'upi', 'paid', $8::int, NOW(), $9::uuid, 1)
     RETURNING id`,
    TENANT,
    String(payments[0].patient_uid),
    Number(source.invoice.id),
    Number(source.sale.total_amount),
    `pos-counter-sale-gateway-${label}-${process.pid}`,
    `order-pos-${label}-${process.pid}`,
    String(payments[0].reference),
    Number(payments[0].id),
    VOID_PAYER,
  );
  const executions = await prisma.$queryRawUnsafe(
    `INSERT INTO payment_gateway_refunds
       (tenant_id, provider, environment, gateway_order_id, billing_refund_id,
        provider_payment_id, provider_refund_id, amount, status, reason,
        initiated_by, provider_idempotency_key, webhook_credential_version)
     VALUES ($1::uuid, 'dry_run', 'sandbox', $2::int, $3::int,
             $4, $5, $6::numeric, 'pending', 'counter-sale gateway evidence',
             $7::uuid, $8, 1)
     RETURNING id, status, provider_refund_id`,
    TENANT,
    Number(orders[0].id),
    Number(initiated.refund.id),
    String(payments[0].reference),
    providerRefundId,
    Number(initiated.refund.amount),
    VOID_PAYER,
    `pgr-pos-${label}-${process.pid}`,
  );
  const claimed = await prisma.$executeRawUnsafe(
    `UPDATE billing_refunds AS refund
        SET payout_rail = 'gateway',
            payout_rail_claimed_at = COALESCE(refund.payout_rail_claimed_at, NOW()),
            gateway_refund_id = $1::int,
            updated_at = NOW()
      WHERE refund.tenant_id = $2::uuid
        AND refund.id = $3::int
        AND refund.approval_status = 'APPROVED'
        AND (
          refund.payout_rail IS NULL
          OR (
            refund.payout_rail = 'gateway'
            AND (
              refund.gateway_refund_id IS NULL
              OR refund.gateway_refund_id = $1::int
              OR EXISTS (
                SELECT 1
                  FROM payment_gateway_refunds prior
                 WHERE prior.tenant_id = refund.tenant_id
                   AND prior.id = refund.gateway_refund_id
                   AND prior.status = 'failed'
              )
            )
          )
        )`,
    Number(executions[0].id),
    TENANT,
    Number(initiated.refund.id),
  );
  expect(Number(claimed)).toBe(1);
  return executions[0];
}

async function settleCounterSaleVoid({ saleId, initiated }) {
  await approveRefund(initiated.refund.id, {
    tenantId: TENANT,
    approved_by: VOID_APPROVER,
  });
  const awaitingPayout = await reconcileCounterSaleVoid({
    tenantId: TENANT,
    id: saleId,
  });
  expect(awaitingPayout.workflow_status).toBe('AWAITING_FINANCE_PAYOUT');
  expect(await allocationReturnCount(saleId)).toBe(0);

  await payCounterSaleVoidRefund(initiated);

  const reconciled = await reconcileCounterSaleVoid({
    tenantId: TENANT,
    id: saleId,
    reconciled_by: CASHIER,
    reconciled_by_role: 'PHARMACY_INCHARGE',
  });
  expect(reconciled.outcome).toBe('voided');
  return reconciled;
}

async function initiateCounterSaleVoid({ saleId, reason, disposition = 'NEVER_HANDED_OVER' }) {
  voidCommandSequence += 1;
  return voidCounterSale({
    tenantId: TENANT,
    id: saleId,
    reason,
    disposition,
    voided_by: CASHIER,
    voided_by_name: 'Counter Pharmacist',
    voided_by_role: 'PHARMACY_INCHARGE',
    command_key: `pos-void-direct-${process.pid}-${voidCommandSequence}`,
  });
}

async function completeCounterSaleVoid({ saleId, reason }) {
  const initiated = await initiateCounterSaleVoid({ saleId, reason });
  expect(initiated.outcome).toBe('pending_refund');
  expect(initiated.sale.status).toBe('VOID_PENDING_REFUND');
  expect(initiated.refund.approval_status).toBe('PENDING');
  const reconciled = await settleCounterSaleVoid({ saleId, initiated });
  return { initiated, reconciled };
}

async function cleanup() {
  const cleanupTenantIds = [TENANT, OTHER];
  const witnessFixtureUids = [
    WITNESS, CASHIER, CLERK_WITNESS, INACTIVE_WITNESS, FOREIGN_WITNESS,
    VOID_APPROVER, VOID_PAYER,
  ];
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
    await tx.$executeRawUnsafe("SELECT set_config('app.audit_bypass', 'on', true)");
    const entryRows = await tx.$queryRawUnsafe(
      `SELECT id FROM ledger_entries WHERE tenant_id = ANY($1::uuid[])`,
      cleanupTenantIds,
    );
    const entryIds = entryRows.map((r) => Number(r.id));
    if (entryIds.length) {
      await tx.$executeRawUnsafe(
        `DELETE FROM ledger_postings WHERE entry_id = ANY($1::bigint[])`, entryIds,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM ledger_entries WHERE id = ANY($1::bigint[])`, entryIds,
      );
    }
    await tx.$executeRawUnsafe(
      `DELETE FROM idempotency_keys WHERE request_key LIKE 'pos-idem-%'`,
    );
    for (const tid of cleanupTenantIds) {
      await tx.$executeRawUnsafe(
        `DELETE FROM notifications
          WHERE tenant_id = $1::uuid
            AND type LIKE 'COUNTER_SALE_VOID_%'`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM tasks
          WHERE tenant_id = $1::uuid
            AND (related_resource_type = 'pharmacy_counter_sale_void_requests'
                 OR title LIKE 'MED-03 counter-sale wrapper delegation %')`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM workflow_sla_instances
          WHERE tenant_id = $1::uuid
            AND source_table = 'pharmacy_counter_sale_void_requests'`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM audit_logs
          WHERE tenant_id = $1::uuid
            AND action LIKE 'COUNTER_SALE_VOID_%'`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_counter_sale_void_requests WHERE tenant_id = $1::uuid`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM approvals
          WHERE tenant_id = $1::uuid AND approval_kind = 'controlled_dispense_witness'`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_counter_sale_allocations WHERE tenant_id = $1::uuid`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_counter_sale_lines WHERE tenant_id = $1::uuid`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_counter_sales WHERE tenant_id = $1::uuid`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_schedule_register WHERE tenant_id = $1::uuid`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_stock_movements WHERE tenant_id = $1::uuid
          AND (reference_type LIKE 'pharmacy_counter_sale%' OR reference_type = 'controlled_dispense')`,
        tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_inventory_batches WHERE tenant_id = $1::uuid AND batch_number LIKE 'POS-%'`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_inventory_items WHERE tenant_id = $1::uuid AND sku_code LIKE 'POS-%'`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM payment_gateway_refunds
          WHERE tenant_id = $1::uuid
            AND reason = 'counter-sale gateway evidence'`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM payment_gateway_orders
          WHERE tenant_id = $1::uuid
            AND receipt LIKE 'pos-counter-sale-gateway-%'`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM billing_refund_offline_electronic_evidence WHERE tenant_id = $1::uuid`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM billing_refunds WHERE tenant_id = $1::uuid`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM billing_payments WHERE tenant_id = $1::uuid`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM billing_invoice_items WHERE tenant_id = $1::uuid`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM billing_invoices WHERE tenant_id = $1::uuid`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM cash_drawer_sessions WHERE tenant_id = $1::uuid`, tid,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM billing_service_master WHERE tenant_id = $1::uuid AND code LIKE 'POSGST%'`, tid,
      );
    }
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, PATIENT,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM users WHERE tenant_id = $1::uuid AND (role = 'PHARMACY_WALKIN' OR uid = $2::uuid)`,
      TENANT, PATIENT,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM staff WHERE user_id = ANY($1::uuid[])`,
      witnessFixtureUids,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
      witnessFixtureUids,
    );
  });
}

beforeAll(async () => {
  await cleanup();
  for (const [tid, slug] of [[TENANT, 'pos-test'], [OTHER, 'pos-other']]) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid, $2, 'POS Test', 'IN', 'active', NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      tid, slug,
    );
  }
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, name, phone, role, tenant_id, updated_at)
     VALUES ($1::uuid, 'POS Registered Patient', '9812345670', 'PATIENT', $2::uuid, NOW())
     ON CONFLICT (uid) DO NOTHING`,
    PATIENT, TENANT,
  );
  // Witness roster: the valid witness is a real active pharmacist of the SAME
  // tenant; the invalid ones exercise every rejection branch of
  // assertControlledDispenseWitness (no row / wrong role / inactive / other
  // tenant). The cashier also gets a users row so self-witness is testable.
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, name, role, tenant_id, updated_at)
     VALUES
       ($1::uuid, 'Witness Pharmacist', 'PHARMACY_STAFF', $5::uuid, NOW()),
       ($2::uuid, 'Counter Pharmacist', 'PHARMACY_INCHARGE', $5::uuid, NOW()),
       ($3::uuid, 'Front Desk Clerk', 'RECEPTIONIST', $5::uuid, NOW()),
       ($4::uuid, 'Foreign Pharmacist', 'PHARMACY_STAFF', $6::uuid, NOW())
     ON CONFLICT (uid) DO NOTHING`,
    WITNESS, CASHIER, CLERK_WITNESS, FOREIGN_WITNESS, TENANT, OTHER,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, name, role, tenant_id, is_active, updated_at)
     VALUES ($1::uuid, 'Departed Pharmacist', 'PHARMACY_STAFF', $2::uuid, false, NOW())
     ON CONFLICT (uid) DO NOTHING`,
    INACTIVE_WITNESS, TENANT,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, name, role, tenant_id, updated_at)
     VALUES
       ($1::uuid, 'Void Refund Approver', 'ADMIN', $3::uuid, NOW()),
       ($2::uuid, 'Void Refund Payer', 'FINANCE_INCHARGE', $3::uuid, NOW())`,
    VOID_APPROVER, VOID_PAYER, TENANT,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO staff
       (user_id, employee_id, name, is_active, archived, tenant_id, updated_at)
     VALUES
       ($1::uuid, 'POS-WITNESS', 'Roster Witness Pharmacist', true, false, $6::uuid, NOW()),
       ($2::uuid, 'POS-CASHIER', 'Roster Counter Pharmacist', true, false, $6::uuid, NOW()),
       ($3::uuid, 'POS-CLERK', 'Roster Front Desk Clerk', true, false, $6::uuid, NOW()),
       ($4::uuid, 'POS-INACTIVE', 'Roster Departed Pharmacist', false, false, $6::uuid, NOW()),
       ($5::uuid, 'POS-FOREIGN', 'Roster Foreign Pharmacist', true, false, $7::uuid, NOW())`,
    WITNESS, CASHIER, CLERK_WITNESS, INACTIVE_WITNESS, FOREIGN_WITNESS, TENANT, OTHER,
  );

  otcItem = await insertItem(TENANT, 'POS-OTC-1', { hsn: '3004' });
  otcNear = await insertBatch(TENANT, otcItem, 'POS-OTC-NEAR', { expiryDays: 30, qty: 50, mrpMinor: 1000 });
  otcFar = await insertBatch(TENANT, otcItem, 'POS-OTC-FAR', { expiryDays: 365, qty: 100, mrpMinor: 1200 });
  await insertBatch(TENANT, otcItem, 'POS-OTC-EXPIRED', { expiryDays: -5, qty: 40 });
  await insertBatch(TENANT, otcItem, 'POS-OTC-QUAR', { expiryDays: 200, qty: 40, status: 'quarantined' });

  h1Item = await insertItem(TENANT, 'POS-H1-1', { schedule: 'H1' });
  h1Batch = await insertBatch(TENANT, h1Item, 'POS-H1-B1', { expiryDays: 120, qty: 60, mrpMinor: 2500 });
  h1ExpiredBatch = await insertBatch(TENANT, h1Item, 'POS-H1-EXPIRED', { expiryDays: -1, qty: 20 });
  h1QuarantinedBatch = await insertBatch(TENANT, h1Item, 'POS-H1-QUAR', {
    expiryDays: 120, qty: 20, status: 'quarantined',
  });

  xItem = await insertItem(TENANT, 'POS-X-1', { schedule: 'X', narcotic: true });
  xBatch = await insertBatch(TENANT, xItem, 'POS-X-B1', { expiryDays: 90, qty: 30, mrpMinor: 5000 });
  xOtherBatch = await insertBatch(TENANT, xItem, 'POS-X-B2', { expiryDays: 180, qty: 30, mrpMinor: 5000 });

  expiredItem = await insertItem(TENANT, 'POS-EXP-1');
  await insertBatch(TENANT, expiredItem, 'POS-EXP-B1', { expiryDays: -1, qty: 100 });

  foreignItem = await insertItem(OTHER, 'POS-FOREIGN-1');
  await insertBatch(OTHER, foreignItem, 'POS-FOREIGN-B1', { qty: 100 });

  // GST master-data override for HSN 3004 → 5% (default slab is 12).
  await prisma.$executeRawUnsafe(
    `INSERT INTO billing_service_master (code, description, category, default_price, gst_rate, hsn_sac, tenant_id)
     VALUES ('POSGST3004', 'Medicaments 5pc slab', 'pharmacy', 0, 5, '3004', $1::uuid)`,
    TENANT,
  );

  // Open cash-drawer session for the CASHIER (CASH sales gate).
  await prisma.$executeRawUnsafe(
    `INSERT INTO cash_drawer_sessions (tenant_id, cashier_uid, shift, opening_float)
     VALUES ($1::uuid, $2::uuid, 'MORNING', 500)`,
    TENANT, CASHIER,
  );
  const payoutDrawers = await prisma.$queryRawUnsafe(
    `INSERT INTO cash_drawer_sessions (tenant_id, cashier_uid, shift, opening_float)
     VALUES ($1::uuid, $2::uuid, 'GENERAL', 10000)
     RETURNING id::text`,
    TENANT, VOID_PAYER,
  );
  voidPayerDrawerId = payoutDrawers[0].id;
});

afterAll(async () => {
  await cleanup();
  if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
}, 30_000);

describe('direct controlled-dispense batch safety', () => {
  const h1Dispense = (overrides = {}) => ({
    tenantId: TENANT,
    inventory_item_id: h1Item,
    inventory_batch_id: h1Batch,
    quantity: 1,
    performed_by: CASHIER,
    performed_by_name: 'Counter Pharmacist',
    ...overrides,
  });

  test('requires a concrete batch and ignores caller attempts to disable safety', async () => {
    await expect(dispenseControlled(h1Dispense({
      inventory_batch_id: null,
      require_usable_batch: false,
    }))).rejects.toMatchObject({ code: 'INVENTORY_BATCH_REQUIRED' });
    await expect(dispenseControlled(h1Dispense({
      inventory_batch_id: h1QuarantinedBatch,
      require_usable_batch: false,
    }))).rejects.toMatchObject({ code: 'INVENTORY_BATCH_UNAVAILABLE' });
    await expect(dispenseControlled(h1Dispense({
      inventory_batch_id: h1ExpiredBatch,
      require_usable_batch: false,
    }))).rejects.toMatchObject({ code: 'INVENTORY_BATCH_EXPIRED' });
    await expect(dispenseControlled(h1Dispense({
      quantity: 10_000,
      require_usable_batch: false,
    }))).rejects.toMatchObject({ code: 'INVENTORY_INSUFFICIENT_STOCK' });
  });

  test('binds an inventory witness approval to the canonical concrete batch', async () => {
    const dispense = {
      inventory_item_id: xItem,
      inventory_batch_id: xBatch,
      quantity: 1,
    };
    const approval = await requestControlledDispenseWitnessApproval({
      tenantId: TENANT,
      requested_by: CASHIER,
      ...dispense,
    });
    expect(approval.id).toMatch(/^[1-9][0-9]*$/);
    await approveInventoryDispenseWitnessApproval({
      tenantId: TENANT,
      approvalId: approval.id,
      actorUid: WITNESS,
      dispense,
    });

    await expect(dispenseControlled({
      tenantId: TENANT,
      ...dispense,
      inventory_batch_id: xOtherBatch,
      performed_by: CASHIER,
      performed_by_name: 'Counter Pharmacist',
      witness_approval_id: approval.id,
    })).rejects.toMatchObject({
      code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_MISMATCH',
    });
  });
});

describe('walk-in counter sale — FEFO + billing + drawer', () => {
  let saleId;

  test('round-trips sale, request, line, and allocation ids above 2^53 as decimal strings', async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const bigintItem = await insertItem(TENANT, `POS-BIGINT-${suffix}`);
    await insertBatch(TENANT, bigintItem, `POS-BIGINT-${suffix}`, {
      expiryDays: 60, qty: 10, mrpMinor: 1000,
    });
    const highSaleId = '9007199254740993';
    const highLineId = '9007199254740994';
    const highAllocationId = '9007199254740995';
    const highRequestId = '9007199254740996';
    const sequenceTargets = [
      ['pharmacy_counter_sales_id_seq', highSaleId],
      ['pharmacy_counter_sale_lines_id_seq', highLineId],
      ['pharmacy_counter_sale_allocations_id_seq', highAllocationId],
      ['pharmacy_counter_sale_void_requests_id_seq', highRequestId],
    ];
    const previousSequenceState = [];
    let created;
    let initiated;
    try {
      for (const [sequence, nextValue] of sequenceTargets) {
        const state = await prisma.$queryRawUnsafe(
          `SELECT start_value::text, last_value::text
             FROM pg_sequences
            WHERE schemaname = 'public' AND sequencename = $1`,
          sequence,
        );
        previousSequenceState.push([sequence, state[0]]);
        await prisma.$queryRawUnsafe(
          `SELECT setval($1::regclass, $2::bigint, false)`,
          sequence,
          nextValue,
        );
      }
      created = await createCounterSale({
        tenantId: TENANT,
        lines: [{ inventory_item_id: bigintItem, quantity: 1 }],
        customer_name: 'Signed 64-bit Identifier Proof',
        payment_mode: 'UPI',
        payment_reference: `upi-bigint-${suffix}`,
        sold_by: CASHIER,
      });
      initiated = await initiateCounterSaleVoid({
        saleId: created.sale.id,
        reason: 'Signed 64-bit request proof before handover',
      });
    } finally {
      for (const [sequence, state] of previousSequenceState) {
        await prisma.$queryRawUnsafe(
          `SELECT setval($1::regclass, $2::bigint, $3::boolean)`,
          sequence,
          state.last_value ?? state.start_value,
          state.last_value != null,
        );
      }
    }

    expect(created.sale.id).toBe(highSaleId);
    expect(initiated.void_request.id).toBe(highRequestId);
    const detail = await getCounterSale({ tenantId: TENANT, id: highSaleId });
    expect(detail.id).toBe(highSaleId);
    expect(detail.void_request_id).toBe(highRequestId);
    expect(detail.lines[0].id).toBe(highLineId);
    expect(detail.lines[0].allocations[0].id).toBe(highAllocationId);
    const notifications = await prisma.$queryRawUnsafe(
      `SELECT data
         FROM notifications
        WHERE tenant_id = $1::uuid
          AND type = 'COUNTER_SALE_VOID_REFUND_REQUIRED'
          AND data->>'counter_sale_void_request_id' = $2`,
      TENANT,
      highRequestId,
    );
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.every((row) => (
      row.data.action_label_key === 's4.lib.counter_sale.open_finance_workflow'
      && row.data.deep_link.includes(`void_request_id=${highRequestId}`)
    ))).toBe(true);
  });

  test('anonymous CASH sale spans batches earliest-expiry-first and pays the invoice', async () => {
    const result = await createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: otcItem, quantity: 60 }],
      customer_name: 'Walk-in Customer',
      customer_phone: '9800000001',
      payment_mode: 'CASH',
      sold_by: CASHIER,
      sold_by_name: 'Counter Pharmacist',
    });
    saleId = Number(result.sale.id);

    expect(result.sale.status).toBe('COMPLETED');
    expect(result.sale.cash_shift).toBe('MORNING');
    expect(result.invoice.invoice_type).toBe('PHARMACY');
    expect(result.invoice.status).toBe('PAID');
    expect(result.invoice.invoice_number).toMatch(/^INV-\d{4}-\d{6}$/);

    // FEFO: near batch (30d) fully consumed before far batch (365d).
    const detail = await getCounterSale({ tenantId: TENANT, id: saleId });
    expect(detail.lines).toHaveLength(1);
    const allocs = detail.lines[0].allocations;
    expect(allocs).toHaveLength(2);
    expect(allocs[0].inventory_batch_id).toBe(otcNear);
    expect(Number(allocs[0].quantity)).toBe(50);
    expect(allocs[1].inventory_batch_id).toBe(otcFar);
    expect(Number(allocs[1].quantity)).toBe(10);

    expect((await remaining(otcNear)).qty).toBe(0);
    expect((await remaining(otcNear)).status).toBe('depleted');
    expect((await remaining(otcFar)).qty).toBe(90);

    // Pricing: 50×10.00 + 10×12.00 = 620.00 subtotal; HSN 3004 master row
    // pins GST at 5% → total 651.00.
    expect(Number(result.invoice.total_amount)).toBe(651);
    expect(Number(result.sale.total_amount)).toBe(651);

    // Payment is CASH, stamped with the drawer shift, by the cashier.
    const payments = await prisma.$queryRawUnsafe(
      `SELECT mode, shift, collected_by, amount, reversed FROM billing_payments
        WHERE invoice_id = $1::int AND tenant_id = $2::uuid`,
      Number(result.invoice.id), TENANT,
    );
    expect(payments).toHaveLength(1);
    expect(payments[0].mode).toBe('CASH');
    expect(payments[0].shift).toBe('MORNING');
    expect(String(payments[0].collected_by)).toBe(CASHIER);

    // Movements reference the sale; invoice items reference it as source.
    const movements = await prisma.$queryRawUnsafe(
      `SELECT movement_kind, quantity_delta FROM pharmacy_stock_movements
        WHERE tenant_id = $1::uuid AND reference_type = 'pharmacy_counter_sale' AND reference_id = $2`,
      TENANT, String(saleId),
    );
    expect(movements).toHaveLength(2);
    expect(movements.every((m) => m.movement_kind === 'issue')).toBe(true);
    const invoiceItems = await prisma.$queryRawUnsafe(
      `SELECT source_ref_type, source_ref_id, category FROM billing_invoice_items
        WHERE invoice_id = $1::int`,
      Number(result.invoice.id),
    );
    expect(invoiceItems).toHaveLength(2);
    expect(invoiceItems.every((i) => i.source_ref_type === 'pharmacy_counter_sale')).toBe(true);
    expect(invoiceItems.every((i) => String(i.source_ref_id) === String(saleId))).toBe(true);
    expect(invoiceItems.every((i) => i.category === 'pharmacy')).toBe(true);

    // The anonymous sale anchored its invoice on the per-tenant walk-in user,
    // but the invoice snapshot carries the real captured customer.
    const anchor = await ensureWalkInAnchorUid(TENANT);
    expect(String(result.invoice.patient_uid)).toBe(String(anchor));
    expect(result.invoice.patient_name).toBe('Walk-in Customer');
    expect(result.invoice.patient_phone).toBe('9800000001');
  });

  test('same-day void waits for independent payout, then restores the exact batches', async () => {
    const before = [await remaining(otcNear), await remaining(otcFar)];
    expect(before[0].qty).toBe(0);

    const { initiated, reconciled } = await completeCounterSaleVoid({
      saleId,
      reason: 'Sale cancelled before customer handover',
    });
    expect(reconciled.sale.status).toBe('VOIDED');
    expect(Number(initiated.refund.amount)).toBe(651);

    // Exact restock, including reviving the fully-depleted near batch.
    expect((await remaining(otcNear)).qty).toBe(50);
    expect((await remaining(otcNear)).status).toBe('in_stock');
    expect((await remaining(otcFar)).qty).toBe(100);

    const detail = await getCounterSale({ tenantId: TENANT, id: saleId });
    expect(detail.status).toBe('VOIDED');
    expect(detail.void_reason).toBe('Sale cancelled before customer handover');
    for (const alloc of detail.lines[0].allocations) {
      expect(alloc.return_movement_id).not.toBeNull();
    }

    const voidAgain = voidCounterSale({
      tenantId: TENANT,
      id: saleId,
      reason: 'again',
      disposition: 'NEVER_HANDED_OVER',
      voided_by: CASHIER,
      voided_by_role: 'PHARMACY_INCHARGE',
      command_key: `pos-void-direct-${process.pid}-already-voided`,
    });
    await expect(voidAgain).rejects.toMatchObject({ code: 'COUNTER_SALE_ALREADY_VOIDED' });
  });

  test('CASH sale without an open drawer session is rejected', async () => {
    await expect(createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: otcItem, quantity: 1 }],
      customer_name: 'No Drawer',
      payment_mode: 'CASH',
      sold_by: NO_DRAWER_CASHIER,
    })).rejects.toMatchObject({ code: 'COUNTER_SALE_CASH_DRAWER_REQUIRED' });
  });

  test('expired-only stock can never be allocated', async () => {
    await expect(createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: expiredItem, quantity: 1 }],
      customer_name: 'Expired Wanter',
      payment_mode: 'UPI',
      payment_reference: 'upi-ref-1',
      sold_by: CASHIER,
    })).rejects.toMatchObject({ code: 'COUNTER_SALE_INSUFFICIENT_STOCK' });
  });
});

describe('counter-sale void refund obligation closure', () => {
  test('unrelated runtime task insert commits through the cumulative wrapper delegation chain', async () => {
    const title = `MED-03 counter-sale wrapper delegation ${process.pid}`;
    const inserted = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE vhhealth_app');
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1::text, true)`,
        TENANT,
      );
      return tx.$queryRawUnsafe(
        `INSERT INTO tasks (tenant_id, task_kind, title, status)
         VALUES ($1::uuid, 'general', $2, 'open')
         RETURNING id, title`,
        TENANT,
        title,
      );
    });
    expect(inserted[0].title).toBe(title);
    await prisma.$executeRawUnsafe(
      `DELETE FROM tasks WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      Number(inserted[0].id),
    );
  });

  test('non-cash sale creation rejects a missing original payment reference before mutation', async () => {
    const before = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM pharmacy_counter_sales
        WHERE tenant_id = $1::uuid AND customer_name = 'Missing Reference Customer'`,
      TENANT,
    );
    await expect(createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: otcItem, quantity: 1 }],
      customer_name: 'Missing Reference Customer',
      payment_mode: 'UPI',
      sold_by: CASHIER,
    })).rejects.toMatchObject({ code: 'COUNTER_SALE_PAYMENT_REFERENCE_REQUIRED' });
    const after = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM pharmacy_counter_sales
        WHERE tenant_id = $1::uuid AND customer_name = 'Missing Reference Customer'`,
      TENANT,
    );
    expect(after[0].count).toBe(before[0].count);
  });

  test('direct SQL cannot backdate or delete governed void evidence', async () => {
    const created = await createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: otcItem, quantity: 1 }],
      customer_name: 'Timestamp Guard Customer',
      payment_mode: 'UPI',
      payment_reference: 'upi-timestamp-guard-1',
      sold_by: CASHIER,
    });
    const beforeInsert = Date.now();
    const initiated = await initiateCounterSaleVoid({
      saleId: Number(created.sale.id),
      reason: 'Never handed over timestamp guard proof',
    });
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id::text, requested_at, created_at,
              requested_at = created_at AS timestamps_aligned
         FROM pharmacy_counter_sale_void_requests
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT,
      initiated.void_request.id,
    );
    expect(rows[0].timestamps_aligned).toBe(true);
    expect(new Date(rows[0].requested_at).getTime()).toBeGreaterThanOrEqual(beforeInsert - 1000);
    await expect(prisma.$executeRawUnsafe(
      `UPDATE pharmacy_counter_sale_void_requests
          SET requested_at = '2000-01-01T00:00:00Z'::timestamptz
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT,
      rows[0].id,
    )).rejects.toThrow(/identity is immutable/i);
    await expect(prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_counter_sale_void_requests
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT,
      rows[0].id,
    )).rejects.toThrow(/append-only/i);
    await settleCounterSaleVoid({ saleId: Number(created.sale.id), initiated });
  });

  test('patient-returned disposition fails closed without request, refund, or stock mutation', async () => {
    const created = await createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: otcItem, quantity: 1 }],
      customer_name: 'Patient Return Customer',
      payment_mode: 'UPI',
      payment_reference: 'upi-patient-return-1',
      sold_by: CASHIER,
    });
    const saleId = Number(created.sale.id);
    const stockBefore = (await remaining(otcNear)).qty + (await remaining(otcFar)).qty;
    await expect(initiateCounterSaleVoid({
      saleId,
      reason: 'Medicine came back from patient custody',
      disposition: 'PATIENT_RETURNED',
    })).rejects.toMatchObject({ code: 'COUNTER_SALE_PATIENT_RETURN_QUARANTINE_REQUIRED' });
    expect((await remaining(otcNear)).qty + (await remaining(otcFar)).qty).toBe(stockBefore);
    const state = await prisma.$queryRawUnsafe(
      `SELECT sale.status, sale.void_refund_id,
              COUNT(request.id)::int AS request_count,
              COUNT(refund.id)::int AS refund_count
         FROM pharmacy_counter_sales sale
         LEFT JOIN pharmacy_counter_sale_void_requests request
           ON request.tenant_id = sale.tenant_id
          AND request.counter_sale_id = sale.id
         LEFT JOIN billing_refunds refund
           ON refund.tenant_id = sale.tenant_id
          AND refund.counter_sale_void_request_id = request.id
        WHERE sale.tenant_id = $1::uuid AND sale.id = $2::bigint
        GROUP BY sale.status, sale.void_refund_id`,
      TENANT,
      saleId,
    );
    expect(state[0]).toMatchObject({
      status: 'COMPLETED', void_refund_id: null, request_count: 0, refund_count: 0,
    });
  });

  test('an unrelated partial invoice refund blocks rather than being selected by the void', async () => {
    const created = await createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: otcItem, quantity: 1 }],
      customer_name: 'Unrelated Refund Customer',
      payment_mode: 'UPI',
      payment_reference: 'upi-unrelated-refund-1',
      sold_by: CASHIER,
    });
    const saleId = Number(created.sale.id);
    const unrelated = await prisma.$queryRawUnsafe(
      `INSERT INTO billing_refunds
         (patient_uid, invoice_id, amount, reason, mode, raised_by, tenant_id)
       VALUES ($1::uuid, $2::int, 0.50, 'unrelated partial refund', 'UPI', $3::uuid, $4::uuid)
       RETURNING id`,
      String(created.invoice.patient_uid),
      Number(created.invoice.id),
      VOID_PAYER,
      TENANT,
    );
    await expect(initiateCounterSaleVoid({
      saleId,
      reason: 'Never handed over but invoice has another refund',
    })).rejects.toMatchObject({ code: 'COUNTER_SALE_VOID_REFUND_CONFLICT' });
    const rows = await prisma.$queryRawUnsafe(
      `SELECT sale.status, sale.void_refund_id,
              COUNT(request.id)::int AS request_count
         FROM pharmacy_counter_sales sale
         LEFT JOIN pharmacy_counter_sale_void_requests request
           ON request.tenant_id = sale.tenant_id
          AND request.counter_sale_id = sale.id
        WHERE sale.tenant_id = $1::uuid AND sale.id = $2::bigint
        GROUP BY sale.status, sale.void_refund_id`,
      TENANT,
      saleId,
    );
    expect(rows[0]).toMatchObject({ status: 'COMPLETED', void_refund_id: null, request_count: 0 });
    expect(Number(unrelated[0].id)).toBeGreaterThan(0);
  });

  test('durable command identity converges concurrent duplicates, rejects mismatch, and is tenant-bound', async () => {
    const created = await createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: otcItem, quantity: 1 }],
      customer_name: 'Durable Void Command Customer',
      payment_mode: 'UPI',
      payment_reference: 'upi-durable-command-1',
      sold_by: CASHIER,
    });
    const saleId = Number(created.sale.id);
    const command = {
      tenantId: TENANT,
      id: saleId,
      reason: 'Never handed over durable command',
      disposition: 'NEVER_HANDED_OVER',
      voided_by: CASHIER,
      voided_by_name: 'Counter Pharmacist',
      voided_by_role: 'PHARMACY_INCHARGE',
      command_key: `pos-void-concurrent-${process.pid}`,
    };
    const [first, second] = await Promise.all([
      voidCounterSale(command),
      voidCounterSale(command),
    ]);
    expect(new Set([first.refund.id, second.refund.id]).size).toBe(1);
    expect(new Set([first.void_request.id, second.void_request.id]).size).toBe(1);
    expect([first.outcome, second.outcome].sort()).toEqual(['pending_refund', 'replay']);
    await expect(voidCounterSale({
      ...command,
      reason: 'Changed intent under the same command key',
    })).rejects.toMatchObject({ code: 'COUNTER_SALE_VOID_COMMAND_MISMATCH' });
    await expect(reconcileCounterSaleVoid({
      tenantId: OTHER,
      id: saleId,
    })).rejects.toMatchObject({ statusCode: 404 });
    const counts = await prisma.$queryRawUnsafe(
      `SELECT COUNT(DISTINCT request.id)::int AS request_count,
              COUNT(DISTINCT refund.id)::int AS refund_count
         FROM pharmacy_counter_sale_void_requests request
         JOIN billing_refunds refund
           ON refund.tenant_id = request.tenant_id
          AND refund.counter_sale_void_request_id = request.id
        WHERE request.tenant_id = $1::uuid
          AND request.counter_sale_id = $2::bigint`,
      TENANT,
      saleId,
    );
    expect(counts[0]).toMatchObject({ request_count: 1, refund_count: 1 });
    await settleCounterSaleVoid({ saleId, initiated: first });
  });

  test('linked void task and SLA satisfy the cumulative care-pathway contract and reject a forged source', async () => {
    const created = await createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: otcItem, quantity: 1 }],
      customer_name: 'Task SLA Binding Customer',
      payment_mode: 'UPI',
      payment_reference: 'upi-task-sla-binding-1',
      sold_by: CASHIER,
    });
    const saleId = Number(created.sale.id);
    const initiated = await initiateCounterSaleVoid({
      saleId,
      reason: 'Never handed over task SLA binding proof',
    });
    const bindings = await prisma.$queryRawUnsafe(
      `SELECT request.id::text AS request_id, request.task_id,
              request.workflow_sla_instance_id::text AS sla_id,
              task.metadata->>'task_contract' AS task_contract,
              sla.source_id
         FROM pharmacy_counter_sale_void_requests request
         JOIN tasks task
           ON task.tenant_id = request.tenant_id
          AND task.id = request.task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = request.tenant_id
          AND sla.id = request.workflow_sla_instance_id
        WHERE request.tenant_id = $1::uuid
          AND request.counter_sale_id = $2::bigint`,
      TENANT,
      saleId,
    );
    expect(bindings[0]).toMatchObject({
      request_id: bindings[0].source_id,
      task_contract: 'counter_sale_void_refund_v1',
    });
    await prisma.$queryRawUnsafe(
      `SELECT care_pathway_assert_task_sla_source_binding($1::uuid, $2::int)::text,
              care_pathway_assert_task_sla_completion_receipt($1::uuid, $2::int)::text`,
      TENANT,
      Number(bindings[0].task_id),
    );
    const runtimeTitle = `Reconcile exact counter-sale void refund ${saleId}`;
    const ownTenantMutation = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE vhhealth_app');
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1::text, true)`,
        TENANT,
      );
      return tx.$queryRawUnsafe(
        `UPDATE tasks
            SET title = $1
          WHERE tenant_id = $2::uuid AND id = $3::int
          RETURNING id, title`,
        runtimeTitle,
        TENANT,
        Number(bindings[0].task_id),
      );
    });
    expect(ownTenantMutation[0].title).toBe(runtimeTitle);

    const crossTenantMutation = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE vhhealth_app');
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.current_tenant_id', $1::text, true)`,
        OTHER,
      );
      return tx.$queryRawUnsafe(
        `UPDATE tasks
            SET title = 'FORGED CROSS TENANT COUNTER-SALE TASK'
          WHERE id = $1::int
          RETURNING id`,
        Number(bindings[0].task_id),
      );
    });
    expect(crossTenantMutation).toHaveLength(0);
    const unchanged = await prisma.$queryRawUnsafe(
      `SELECT title FROM tasks WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      Number(bindings[0].task_id),
    );
    expect(unchanged[0].title).toBe(runtimeTitle);

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE workflow_sla_instances
            SET source_id = $1
          WHERE tenant_id = $2::uuid AND id = $3::uuid`,
        `${bindings[0].request_id}-forged`,
        TENANT,
        bindings[0].sla_id,
      );
    })).rejects.toThrow(/counter-sale void task (and linked SLA do not describe|has no exact SLA receipt contract)/i);

    await settleCounterSaleVoid({ saleId, initiated });
  });

  test('pharmacy cannot self-approve or self-pay and offline evidence binds the exact original payment', async () => {
    const originalReference = 'upi-independent-actors-1';
    const created = await createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: otcItem, quantity: 1 }],
      customer_name: 'Independent Actors Customer',
      payment_mode: 'UPI',
      payment_reference: originalReference,
      sold_by: CASHIER,
    });
    const saleId = Number(created.sale.id);
    const initiated = await initiateCounterSaleVoid({
      saleId,
      reason: 'Never handed over independent actors',
    });
    await expect(approveRefund(initiated.refund.id, {
      tenantId: TENANT,
      approved_by: CASHIER,
    })).rejects.toThrow(/independent.*approval|approval.*independent/i);
    await approveRefund(initiated.refund.id, {
      tenantId: TENANT,
      approved_by: VOID_APPROVER,
    });
    await reconcileCounterSaleVoid({ tenantId: TENANT, id: saleId });

    const attemptedEvidence = {
      tenantId: TENANT,
      original_payment_reference: originalReference,
      provider_name: 'POS Test Acquirer',
      provider_refund_reference: `POS-UNAUTHORIZED-${process.pid}`,
      provider_refunded_at: new Date().toISOString(),
    };
    const originalPayments = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM billing_payments
        WHERE tenant_id = $1::uuid
          AND invoice_id = $2::int
          AND reversed = FALSE`,
      TENANT,
      Number(created.invoice.id),
    );
    expect(originalPayments).toHaveLength(1);
    const tamperedReference = `${originalReference}-tampered`;
    await prisma.$executeRawUnsafe(
      `UPDATE billing_payments
          SET reference = $1
        WHERE tenant_id = $2::uuid AND id = $3::int`,
      tamperedReference,
      TENANT,
      Number(originalPayments[0].id),
    );
    await expect(markOfflineElectronicRefundPaid(initiated.refund.id, {
      ...attemptedEvidence,
      paid_by: VOID_PAYER,
      original_payment_reference: tamperedReference,
      provider_refund_reference: `POS-TAMPERED-RECEIPT-${process.pid}`,
    })).rejects.toThrow(/original sale receipt|exact evidence/i);
    const rejectedTamper = await prisma.$queryRawUnsafe(
      `SELECT refund.approval_status,
              COUNT(evidence.id)::int AS evidence_count
         FROM billing_refunds refund
         LEFT JOIN billing_refund_offline_electronic_evidence evidence
           ON evidence.tenant_id = refund.tenant_id
          AND evidence.refund_id = refund.id
        WHERE refund.tenant_id = $1::uuid AND refund.id = $2::int
        GROUP BY refund.approval_status`,
      TENANT,
      Number(initiated.refund.id),
    );
    expect(rejectedTamper[0]).toMatchObject({
      approval_status: 'APPROVED', evidence_count: 0,
    });
    await prisma.$executeRawUnsafe(
      `UPDATE billing_payments
          SET reference = $1
        WHERE tenant_id = $2::uuid AND id = $3::int`,
      originalReference,
      TENANT,
      Number(originalPayments[0].id),
    );
    await expect(markOfflineElectronicRefundPaid(initiated.refund.id, {
      ...attemptedEvidence,
      paid_by: CASHIER,
    })).rejects.toThrow(/independent|exact evidence/i);
    await expect(markOfflineElectronicRefundPaid(initiated.refund.id, {
      ...attemptedEvidence,
      paid_by: WITNESS,
    })).rejects.toThrow(/exact evidence/i);
    await markOfflineElectronicRefundPaid(initiated.refund.id, {
      ...attemptedEvidence,
      paid_by: VOID_PAYER,
      provider_refund_reference: `POS-AUTHORIZED-${process.pid}`,
    });
    const final = await reconcileCounterSaleVoid({
      tenantId: TENANT,
      id: saleId,
      reconciled_by: CASHIER,
      reconciled_by_role: 'PHARMACY_INCHARGE',
    });
    expect(final.workflow_status).toBe('VOIDED');
    const evidence = await prisma.$queryRawUnsafe(
      `SELECT evidence.original_payment_id, evidence.original_advance_id,
              evidence.original_payment_reference, payment.invoice_id
         FROM billing_refund_offline_electronic_evidence evidence
         JOIN billing_payments payment
           ON payment.tenant_id = evidence.tenant_id
          AND payment.id = evidence.original_payment_id
        WHERE evidence.tenant_id = $1::uuid
          AND evidence.refund_id = $2::int`,
      TENANT,
      initiated.refund.id,
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      original_advance_id: null,
      original_payment_reference: originalReference,
      invoice_id: Number(created.invoice.id),
    });
  });

  test('gateway rail rejects an unrelated capture and closes only after exact processed provider evidence', async () => {
    const target = await createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: otcItem, quantity: 1 }],
      customer_name: 'Gateway Evidence Target Customer',
      payment_mode: 'UPI',
      payment_reference: 'pay-gateway-target-1',
      sold_by: CASHIER,
    });
    const unrelated = await createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: otcItem, quantity: 1 }],
      customer_name: 'Gateway Evidence Unrelated Customer',
      payment_mode: 'UPI',
      payment_reference: 'pay-gateway-unrelated-1',
      sold_by: CASHIER,
    });
    const saleId = Number(target.sale.id);
    const initiated = await initiateCounterSaleVoid({
      saleId,
      reason: 'Never handed over exact gateway evidence proof',
    });
    await approveRefund(initiated.refund.id, {
      tenantId: TENANT,
      approved_by: VOID_APPROVER,
    });
    await reconcileCounterSaleVoid({ tenantId: TENANT, id: saleId });

    const forged = await createCounterSaleGatewayExecution({
      initiated,
      source: unrelated,
      label: 'unrelated',
    });
    await expect(markGatewayRefundPaid(initiated.refund.id, {
      tenantId: TENANT,
      gateway_refund_id: Number(forged.id),
      provider_refund_id: forged.provider_refund_id,
    })).rejects.toThrow(/counter-sale void gateway payout lacks execution evidence/i);
    const rolledBack = await prisma.$queryRawUnsafe(
      `SELECT execution.status, execution.processed_at, refund.approval_status
         FROM payment_gateway_refunds execution
         JOIN billing_refunds refund
           ON refund.tenant_id = execution.tenant_id
          AND refund.id = execution.billing_refund_id
        WHERE execution.tenant_id = $1::uuid AND execution.id = $2::int`,
      TENANT,
      Number(forged.id),
    );
    expect(rolledBack[0]).toMatchObject({
      status: 'pending', processed_at: null, approval_status: 'APPROVED',
    });
    await prisma.$executeRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET status = 'failed',
              failed_at = NOW(),
              failure_code = 'TEST_CAPTURE_MISMATCH',
              failure_reason = 'Unrelated capture rejected by exact evidence guard',
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      Number(forged.id),
    );

    const exact = await createCounterSaleGatewayExecution({
      initiated,
      source: target,
      label: 'exact',
    });
    await prisma.$executeRawUnsafe(
      `DELETE FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      Number(forged.id),
    );
    await markGatewayRefundPaid(initiated.refund.id, {
      tenantId: TENANT,
      gateway_refund_id: Number(exact.id),
      provider_refund_id: exact.provider_refund_id,
    });
    const paid = await prisma.$queryRawUnsafe(
      `SELECT execution.status, execution.processed_at,
              refund.approval_status, refund.payout_rail
         FROM payment_gateway_refunds execution
         JOIN billing_refunds refund
           ON refund.tenant_id = execution.tenant_id
          AND refund.id = execution.billing_refund_id
        WHERE execution.tenant_id = $1::uuid AND execution.id = $2::int`,
      TENANT,
      Number(exact.id),
    );
    expect(paid[0]).toMatchObject({
      status: 'processed', approval_status: 'PAID', payout_rail: 'gateway',
    });
    expect(paid[0].processed_at).not.toBeNull();
    const reconciled = await reconcileCounterSaleVoid({
      tenantId: TENANT,
      id: saleId,
      reconciled_by: CASHIER,
      reconciled_by_role: 'PHARMACY_INCHARGE',
    });
    expect(reconciled).toMatchObject({
      outcome: 'voided', sale: { status: 'VOIDED' },
    });
  });

  test('bounded tenant reconciler closes exact paid refunds once with system attribution', async () => {
    const created = await createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: otcItem, quantity: 1 }],
      customer_name: 'Automatic Reconciliation Customer',
      payment_mode: 'UPI',
      payment_reference: 'upi-automatic-reconciliation-1',
      sold_by: CASHIER,
    });
    const saleId = Number(created.sale.id);
    const initiated = await initiateCounterSaleVoid({
      saleId,
      reason: 'Never handed over automatic reconciliation proof',
    });
    await approveRefund(initiated.refund.id, {
      tenantId: TENANT,
      approved_by: VOID_APPROVER,
    });
    await reconcileCounterSaleVoid({ tenantId: TENANT, id: saleId });
    await payCounterSaleVoidRefund(initiated);

    const first = await reconcileCounterSaleVoidsForTenant({ tenantId: TENANT, limit: 10 });
    expect(first.reconciled).toBeGreaterThanOrEqual(1);
    expect(first.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'voided', sale: expect.objectContaining({ id: String(saleId) }) }),
    ]));
    const second = await reconcileCounterSaleVoidsForTenant({ tenantId: TENANT, limit: 10 });
    expect(second.results).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'voided', sale: expect.objectContaining({ id: String(saleId) }) }),
    ]));
    const evidence = await prisma.$queryRawUnsafe(
      `SELECT request.status, request.reconciliation_source, request.reconciled_by,
              task.status AS task_status, sla.metadata->>'completed_by' AS completed_by
         FROM pharmacy_counter_sale_void_requests request
         JOIN tasks task
           ON task.tenant_id = request.tenant_id AND task.id = request.task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = request.tenant_id
          AND sla.id = request.workflow_sla_instance_id
        WHERE request.tenant_id = $1::uuid
          AND request.counter_sale_id = $2::bigint`,
      TENANT,
      saleId,
    );
    expect(evidence[0]).toMatchObject({
      status: 'COMPLETED',
      reconciliation_source: 'system',
      reconciled_by: null,
      task_status: 'completed',
      completed_by: CASHIER,
    });
    expect(await allocationReturnCount(saleId)).toBeGreaterThan(0);
  });

  test('refund rejection opens named review and explicit handover closes without restock', async () => {
    const created = await createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: otcItem, quantity: 1 }],
      customer_name: 'Rejected Refund Customer',
      payment_mode: 'UPI',
      payment_reference: 'upi-rejected-refund-1',
      sold_by: CASHIER,
    });
    const saleId = Number(created.sale.id);
    const initiated = await initiateCounterSaleVoid({
      saleId,
      reason: 'Void awaiting independent review',
    });
    await rejectRefund(initiated.refund.id, {
      tenantId: TENANT,
      rejected_by: VOID_APPROVER,
      rejection_reason: 'Customer already took custody',
    });
    const review = await reconcileCounterSaleVoid({ tenantId: TENANT, id: saleId });
    expect(review).toMatchObject({
      outcome: 'refund_rejected_review',
      workflow_status: 'REFUND_REJECTED_REVIEW',
      sale: { status: 'VOID_PENDING_REFUND' },
      void_request: { task_stage: 'rejected_review' },
    });
    expect(await allocationReturnCount(saleId)).toBe(0);
    const openTask = await prisma.$queryRawUnsafe(
      `SELECT task.status, task.assigned_to_role, sla.status AS sla_status
         FROM pharmacy_counter_sale_void_requests request
         JOIN tasks task
           ON task.tenant_id = request.tenant_id AND task.id = request.task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = request.tenant_id
          AND sla.id = request.workflow_sla_instance_id
        WHERE request.tenant_id = $1::uuid AND request.counter_sale_id = $2::bigint`,
      TENANT,
      saleId,
    );
    expect(openTask[0].status).toMatch(/open|in_progress|blocked|overdue/);
    expect(openTask[0].assigned_to_role).toBe('ADMIN');
    expect(['active', 'breached', 'escalated']).toContain(openTask[0].sla_status);

    const closed = await resolveRejectedCounterSaleVoid({
      tenantId: TENANT,
      id: saleId,
      resolution: 'CUSTOMER_HANDOVER_CONFIRMED',
      reason: 'Pharmacist confirmed customer custody against the receipt',
      resolved_by: CASHIER,
      resolved_by_role: 'PHARMACY_INCHARGE',
    });
    expect(closed).toMatchObject({
      outcome: 'handover_confirmed',
      workflow_status: 'CANCELLED_HANDOVER_CONFIRMED',
      sale: { status: 'COMPLETED', void_refund_id: null },
      void_request: { status: 'CANCELLED_HANDOVER_CONFIRMED', task_stage: 'cancelled' },
    });
    expect(await allocationReturnCount(saleId)).toBe(0);
    const terminal = await prisma.$queryRawUnsafe(
      `SELECT task.status, sla.completed_at, request.rejection_resolution
         FROM pharmacy_counter_sale_void_requests request
         JOIN tasks task
           ON task.tenant_id = request.tenant_id AND task.id = request.task_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = request.tenant_id
          AND sla.id = request.workflow_sla_instance_id
        WHERE request.tenant_id = $1::uuid AND request.counter_sale_id = $2::bigint`,
      TENANT,
      saleId,
    );
    expect(terminal[0]).toMatchObject({
      status: 'completed', rejection_resolution: 'CUSTOMER_HANDOVER_CONFIRMED',
    });
    expect(terminal[0].completed_at).not.toBeNull();
  });

  test('a mid-restock failure rolls back every return and a retry closes exactly once', async () => {
    const created = await createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: otcItem, quantity: 60 }],
      customer_name: 'Crash Retry Customer',
      payment_mode: 'UPI',
      payment_reference: 'upi-crash-retry-1',
      sold_by: CASHIER,
    });
    const saleId = Number(created.sale.id);
    const allocations = await prisma.$queryRawUnsafe(
      `SELECT allocation.id::text, allocation.inventory_batch_id
         FROM pharmacy_counter_sale_allocations allocation
         JOIN pharmacy_counter_sale_lines line
           ON line.tenant_id = allocation.tenant_id
          AND line.id = allocation.counter_sale_line_id
        WHERE allocation.tenant_id = $1::uuid AND line.counter_sale_id = $2::bigint
        ORDER BY allocation.id`,
      TENANT,
      saleId,
    );
    expect(allocations).toHaveLength(2);
    const dispensedState = [await remaining(otcNear), await remaining(otcFar)];
    const initiated = await initiateCounterSaleVoid({
      saleId,
      reason: 'Crash-safe return before handover',
    });
    await approveRefund(initiated.refund.id, {
      tenantId: TENANT,
      approved_by: VOID_APPROVER,
    });
    await reconcileCounterSaleVoid({ tenantId: TENANT, id: saleId });
    await payCounterSaleVoidRefund(initiated);

    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION codex_fail_counter_sale_far_return_746()
       RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
       BEGIN
         IF OLD.return_movement_id IS NULL
            AND NEW.return_movement_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM pharmacy_inventory_batches batch
               WHERE batch.id = NEW.inventory_batch_id
                 AND batch.batch_number = 'POS-OTC-FAR'
            ) THEN
           RAISE EXCEPTION 'forced mid-restock crash';
         END IF;
         RETURN NEW;
       END
       $fn$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER codex_fail_counter_sale_far_return_746
       BEFORE UPDATE OF return_movement_id ON pharmacy_counter_sale_allocations
       FOR EACH ROW EXECUTE FUNCTION codex_fail_counter_sale_far_return_746()`,
    );
    try {
      await expect(reconcileCounterSaleVoid({
        tenantId: TENANT,
        id: saleId,
        reconciled_by: CASHIER,
        reconciled_by_role: 'PHARMACY_INCHARGE',
      })).rejects.toThrow(/forced mid-restock crash/i);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER codex_fail_counter_sale_far_return_746
           ON pharmacy_counter_sale_allocations`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION codex_fail_counter_sale_far_return_746()`,
      );
    }
    expect(await allocationReturnCount(saleId)).toBe(0);
    expect(await remaining(otcNear)).toEqual(dispensedState[0]);
    expect(await remaining(otcFar)).toEqual(dispensedState[1]);
    const failedReturns = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM pharmacy_stock_movements
        WHERE tenant_id = $1::uuid
          AND reference_type = 'pharmacy_counter_sale_void'
          AND reference_id = $2`,
      TENANT,
      String(saleId),
    );
    expect(failedReturns[0].count).toBe(0);

    const retried = await reconcileCounterSaleVoid({
      tenantId: TENANT,
      id: saleId,
      reconciled_by: CASHIER,
      reconciled_by_role: 'PHARMACY_INCHARGE',
    });
    expect(retried.workflow_status).toBe('VOIDED');
    expect(await allocationReturnCount(saleId)).toBe(2);
    const replay = await reconcileCounterSaleVoid({ tenantId: TENANT, id: saleId });
    expect(replay).toMatchObject({ outcome: 'replay', workflow_status: 'VOIDED' });
  });
});

describe('schedule-class enforcement', () => {
  test('witness approval request rejects a caller-preselected approval id', async () => {
    await expect(requestCounterSaleWitnessApproval({
      tenantId: TENANT,
      lines: [{ inventory_item_id: xItem, quantity: 1 }],
      customer_name: 'Preselected approval',
      customer_phone: '9800000042',
      rx: RX,
      payment_mode: 'CARD',
      payment_reference: 'card-preselected-1',
      requested_by: CASHIER,
      witness_approval_id: '71',
    })).rejects.toMatchObject({
      code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_PRESELECTED',
    });
  });

  test('Schedule H1 requires a prescription reference', async () => {
    await expect(createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: h1Item, quantity: 2 }],
      customer_name: 'No Rx',
      payment_mode: 'UPI',
      payment_reference: 'upi-no-rx-1',
      sold_by: CASHIER,
    })).rejects.toMatchObject({ code: 'COUNTER_SALE_RX_REQUIRED' });
  });

  test('Schedule H1 with rx dispenses through the statutory register', async () => {
    const result = await createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: h1Item, quantity: 2 }],
      patient_uid: PATIENT,
      rx: RX,
      payment_mode: 'UPI',
      payment_reference: 'upi-h1-1',
      sold_by: CASHIER,
      sold_by_name: 'Counter Pharmacist',
    });
    expect(result.sale.status).toBe('COMPLETED');
    expect((await remaining(h1Batch)).qty).toBe(58);

    const register = await prisma.$queryRawUnsafe(
      `SELECT schedule_class, movement_kind, quantity, prescription_number, prescriber_name,
              patient_uid, patient_name, patient_phone
         FROM pharmacy_schedule_register
        WHERE tenant_id = $1::uuid AND inventory_item_id = $2::int AND movement_kind = 'dispense'`,
      TENANT, h1Item,
    );
    expect(register).toHaveLength(1);
    expect(register[0].schedule_class).toBe('H1');
    expect(Number(register[0].quantity)).toBe(2);
    expect(register[0].prescription_number).toBe('RX-POS-001');
    expect(register[0].prescriber_name).toBe('Dr. Test Prescriber');
    expect(String(register[0].patient_uid)).toBe(PATIENT);
    // Statutory identity snapshot: registered patient's name/phone.
    expect(register[0].patient_name).toBe('POS Registered Patient');
    expect(register[0].patient_phone).toBe('9812345670');

    // Registered-patient sale writes the canonical timeline + audit pair.
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
        WHERE patient_uid = $1::uuid AND source_table = 'pharmacy_counter_sales'`,
      PATIENT,
    );
    expect(timeline.map((t) => t.event_type)).toContain('pharmacy.counter_sale.dispensed');
    const audit = await prisma.$queryRawUnsafe(
      `SELECT action FROM clinical_audit_events
        WHERE patient_uid = $1::uuid AND resource_table = 'pharmacy_counter_sales'`,
      PATIENT,
    );
    expect(audit.map((a) => a.action)).toContain('pharmacy.counter_sale.dispensed');

    // Voiding the controlled sale restocks THROUGH the register.
    const { reconciled: voided } = await completeCounterSaleVoid({
      saleId: result.sale.id,
      reason: 'Rx withdrawn before handover',
    });
    expect(voided.sale.status).toBe('VOIDED');
    expect((await remaining(h1Batch)).qty).toBe(60);
    const returns = await prisma.$queryRawUnsafe(
      `SELECT movement_kind, quantity FROM pharmacy_schedule_register
        WHERE tenant_id = $1::uuid AND inventory_item_id = $2::int AND movement_kind = 'return'`,
      TENANT, h1Item,
    );
    expect(returns).toHaveLength(1);
    expect(Number(returns[0].quantity)).toBe(2);
  });

  test('Schedule X requires a witness; witnessed dispense lands in the register', async () => {
    await expect(createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: xItem, quantity: 1 }],
      customer_name: 'X Buyer',
      rx: RX,
      payment_mode: 'CARD',
      payment_reference: 'card-x-witness-required-1',
      sold_by: CASHIER,
    })).rejects.toMatchObject({ code: 'COUNTER_SALE_WITNESS_REQUIRED' });

    const saleArgs = {
      tenantId: TENANT,
      lines: [{ inventory_item_id: xItem, quantity: 1 }],
      customer_name: 'X Buyer',
      customer_phone: '9800000042',
      rx: RX,
      payment_mode: 'CARD',
      payment_reference: 'card-x-complete-1',
      sold_by: CASHIER,
      sold_by_name: 'Counter Pharmacist',
    };
    const approval = await requestCounterSaleWitnessApproval({
      ...saleArgs,
      requested_by: CASHIER,
    });
    await approveCounterSaleWitnessApproval({
      approvalId: approval.id,
      actorUid: WITNESS,
      sale: saleArgs,
    });
    const result = await createCounterSale({
      ...saleArgs,
      witness_approval_id: approval.id,
      witness: { uid: CASHIER, name: 'Caller-selected fake witness' },
    });
    expect(result.sale.status).toBe('COMPLETED');
    expect((await remaining(xBatch)).qty).toBe(29);

    const register = await prisma.$queryRawUnsafe(
      `SELECT schedule_class, witness_name, witness_uid, patient_uid, patient_name, patient_phone
         FROM pharmacy_schedule_register
        WHERE tenant_id = $1::uuid AND inventory_item_id = $2::int AND movement_kind = 'dispense'`,
      TENANT, xItem,
    );
    expect(register).toHaveLength(1);
    expect(register[0].schedule_class).toBe('X');
    expect(register[0].witness_name).toBe('Roster Witness Pharmacist');
    expect(String(register[0].witness_uid)).toBe(WITNESS);
    // Anonymous walk-in: the captured identity lands on the statutory row.
    expect(register[0].patient_uid).toBeNull();
    expect(register[0].patient_name).toBe('X Buyer');
    expect(register[0].patient_phone).toBe('9800000042');

    const approvalRows = await prisma.$queryRawUnsafe(
      `SELECT status, decided_by, metadata
         FROM approvals
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT, approval.id,
    );
    expect(approvalRows[0].status).toBe('approved');
    expect(String(approvalRows[0].decided_by)).toBe(WITNESS);
    expect(approvalRows[0].metadata).toMatchObject({
      consumed_by: CASHIER,
      canonical_witness_name: 'Roster Witness Pharmacist',
    });

    await expect(createCounterSale({
      ...saleArgs,
      witness_approval_id: approval.id,
    })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_CONSUMED' });
  });

  describe('independent witness identity validation', () => {
    const xSale = async (actorUid) => {
      const sale = {
        tenantId: TENANT,
        lines: [{ inventory_item_id: xItem, quantity: 1 }],
        customer_name: 'X Buyer',
        customer_phone: '9800000042',
        rx: RX,
        payment_mode: 'CARD',
        payment_reference: 'card-x-witness-validation-1',
        sold_by: CASHIER,
        sold_by_name: 'Counter Pharmacist',
      };
      const approval = await requestCounterSaleWitnessApproval({
        ...sale,
        requested_by: CASHIER,
      });
      return approveCounterSaleWitnessApproval({
        approvalId: approval.id,
        actorUid,
        sale,
      });
    };

    async function expectNoSideEffects(before) {
      // Phase-0 rejection: no stock moved and no sale header was written
      // (the only 'X Buyer' sale is the COMPLETED witnessed one above).
      expect((await remaining(xBatch)).qty).toBe(before);
      const sales = await prisma.$queryRawUnsafe(
        `SELECT status FROM pharmacy_counter_sales
          WHERE tenant_id = $1::uuid AND customer_name = 'X Buyer' AND status <> 'COMPLETED'`,
        TENANT,
      );
      expect(sales).toHaveLength(0);
    }

    test('rejects a witness uid with no staff row (ghost uid)', async () => {
      const before = (await remaining(xBatch)).qty;
      await expect(xSale(GHOST_WITNESS))
        .rejects.toMatchObject({ statusCode: 400, code: 'CONTROLLED_DISPENSE_WITNESS_NOT_FOUND' });
      await expectNoSideEffects(before);
    });

    test('rejects a non-uuid witness uid without 500ing on the cast', async () => {
      await expect(xSale('not-a-uuid'))
        .rejects.toMatchObject({ statusCode: 400, code: 'CONTROLLED_DISPENSE_WITNESS_INVALID' });
    });

    test('rejects a witness whose role cannot witness a controlled dispense', async () => {
      await expect(xSale(CLERK_WITNESS))
        .rejects.toMatchObject({ statusCode: 400, code: 'CONTROLLED_DISPENSE_WITNESS_ROLE_INELIGIBLE' });
    });

    test('rejects a deactivated staff member as witness', async () => {
      await expect(xSale(INACTIVE_WITNESS))
        .rejects.toMatchObject({ statusCode: 400, code: 'CONTROLLED_DISPENSE_WITNESS_NOT_FOUND' });
    });

    test('rejects a witness from another tenant (tenant isolation)', async () => {
      await expect(xSale(FOREIGN_WITNESS))
        .rejects.toMatchObject({ statusCode: 400, code: 'CONTROLLED_DISPENSE_WITNESS_NOT_FOUND' });
    });

    test('rejects the seller witnessing their own dispense', async () => {
      await expect(xSale(CASHIER))
        .rejects.toMatchObject({ statusCode: 400, code: 'CONTROLLED_DISPENSE_WITNESS_SELF' });
    });
  });
});

describe('atomicity + isolation', () => {
  test('an over-planned sale rolls back every decrement and voids the invoice', async () => {
    // Two lines of the same item: plans are computed against the same
    // unlocked snapshot, so together they over-allocate the near batch. The
    // finalize tx must fail on the second line and roll the first line's
    // decrement back. Invoice issuance is in that same finalize transaction,
    // so compensation must only ever void the rolled-back DRAFT invoice.
    const nearBefore = (await remaining(otcNear)).qty;
    const farBefore = (await remaining(otcFar)).qty;

    // Line 1's decrement depletes the near batch inside the tx, so line 2's
    // replanned take on the same batch fails the usable-batch guard
    // (depleted ⇒ INVENTORY_BATCH_UNAVAILABLE; a partial drain would surface
    // INVENTORY_INSUFFICIENT_STOCK instead — both are the atomic rejection).
    await expect(createCounterSale({
      tenantId: TENANT,
      lines: [
        { inventory_item_id: otcItem, quantity: nearBefore },       // consumes all of near
        { inventory_item_id: otcItem, quantity: nearBefore + 10 },  // plans near again
      ],
      customer_name: 'Race Customer',
      payment_mode: 'UPI',
      payment_reference: 'upi-race-1',
      sold_by: CASHIER,
    })).rejects.toMatchObject({
      code: expect.stringMatching(/^INVENTORY_(BATCH_UNAVAILABLE|INSUFFICIENT_STOCK)$/),
    });

    expect((await remaining(otcNear)).qty).toBe(nearBefore);
    expect((await remaining(otcFar)).qty).toBe(farBefore);

    const sales = await listCounterSales({ tenantId: TENANT, status: 'FAILED' });
    expect(sales.length).toBeGreaterThanOrEqual(1);
    const failed = sales[0];
    expect(failed.status).toBe('FAILED');

    // The failed finalize never issued a statutory invoice number; the
    // compensating void therefore stayed within billing's DRAFT-only guard.
    const invoices = await prisma.$queryRawUnsafe(
      `SELECT id, status, invoice_number, issued_at, void_reason
         FROM billing_invoices
        WHERE tenant_id = $1::uuid AND notes = $2
        ORDER BY id DESC LIMIT 1`,
      TENANT, `Pharmacy counter sale #${failed.id}`,
    );
    expect(invoices).toHaveLength(1);
    expect(invoices[0].status).toBe('VOID');
    expect(invoices[0].invoice_number).toBeNull();
    expect(invoices[0].issued_at).toBeNull();
    const payments = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM billing_payments
        WHERE tenant_id = $1::uuid AND invoice_id = $2::int`,
      TENANT, invoices[0].id,
    );
    expect(payments[0].count).toBe(0);
  });

  test('cross-tenant: foreign items are unsellable and foreign sales unreadable', async () => {
    await expect(createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: foreignItem, quantity: 1 }],
      customer_name: 'Cross Tenant',
      payment_mode: 'UPI',
      payment_reference: 'upi-cross-tenant-1',
      sold_by: CASHIER,
    })).rejects.toMatchObject({ statusCode: 404 });

    const mySales = await listCounterSales({ tenantId: TENANT });
    expect(mySales.length).toBeGreaterThanOrEqual(1);
    await expect(getCounterSale({ tenantId: OTHER, id: mySales[0].id }))
      .rejects.toMatchObject({ statusCode: 404 });
    const otherSales = await listCounterSales({ tenantId: OTHER });
    expect(otherSales).toHaveLength(0);
  });

  test('sellable-item search reports usable stock and the FEFO head batch', async () => {
    const items = await searchSellableItems({ tenantId: TENANT, search: 'POS-OTC-1' });
    expect(items).toHaveLength(1);
    const item = items[0];
    // Expired + quarantined batches are excluded from both the total and the head.
    expect(Number(item.in_stock_quantity)).toBe(
      (await remaining(otcNear)).qty + (await remaining(otcFar)).qty,
    );
    expect(item.fefo_batch_id).toBe(otcNear);
    expect(Number(item.fefo_unit_price)).toBe(10);
    // Foreign tenant sees nothing.
    const foreign = await searchSellableItems({ tenantId: OTHER, search: 'POS-OTC-1' });
    expect(foreign).toHaveLength(0);
  });
});

// ── Idempotent POS mutations (route-level) ────────────────────────────
//
// The shared Flutter transport auto-mints an Idempotency-Key and replays the
// identical body up to 3x on timeout/socket-drop/5xx. The POS create/void
// routes must honour it: a replay returns the cached original response and
// never dispenses/charges (or refunds/restocks) a second time.
describe('idempotent counter-sale mutations (route-level)', () => {
  const BASE = '/api/v1/pharmacy-orders/counter-sales';
  const ALIAS = '/api/v1/pharmacy/counter-sales';
  const staff = () => authClient('PHARMACY_STAFF', { uid: CASHIER, tenant_id: TENANT });
  const incharge = () => authClient('PHARMACY_INCHARGE', { uid: CASHIER, tenant_id: TENANT });
  const witness = () => authClient('PHARMACY_STAFF', { uid: WITNESS, tenant_id: TENANT });

  const saleBody = (name, ref) => ({
    lines: [{ inventory_item_id: otcItem, quantity: 1 }],
    customer_name: name,
    customer_phone: '9800000077',
    payment_mode: 'UPI',
    payment_reference: ref,
  });

  // finaliseIdempotencyKey persists the cached response asynchronously after
  // res.json; wait for it so a sequential replay deterministically hits the
  // 'replay' branch instead of racing 'in_flight'.
  async function waitForIdemComplete(key) {
    for (let i = 0; i < 60; i += 1) {
      const rows = await prisma.$queryRawUnsafe(
        `SELECT status FROM idempotency_keys WHERE request_key = $1`, key,
      );
      if (rows.length && rows[0].status !== 'in_flight') return rows[0].status;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    throw new Error(`idempotency claim for ${key} never finalised`);
  }

  test('create without an Idempotency-Key is rejected 400', async () => {
    const res = await staff().post(BASE).send(saleBody('No Key Customer', 'upi-idem-0'));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Idempotency-Key/);
  });

  test('lost-response retries reuse one durable witness request and approval decision', async () => {
    const sale = {
      lines: [{ inventory_item_id: xItem, quantity: 1 }],
      customer_name: 'Witness Retry Customer',
      customer_phone: '9800000088',
      rx: RX,
      payment_mode: 'CARD',
      payment_reference: 'card-witness-retry-1',
    };
    const requestKey = `pos-idem-${process.pid}-witness-request`;
    const firstRequest = await staff().post(`${BASE}/witness-approvals`)
      .set('Idempotency-Key', requestKey).send(sale);
    expect(firstRequest.status).toBe(200);
    const approvalId = firstRequest.body.data.id;
    expect(approvalId).toMatch(/^[1-9][0-9]*$/);
    await waitForIdemComplete(requestKey);

    const replayedRequest = await staff().post(`${ALIAS}/witness-approvals`)
      .set('Idempotency-Key', requestKey).send(sale);
    expect(replayedRequest.status).toBe(200);
    expect(replayedRequest.body.data.id).toBe(approvalId);

    const approvalBody = { sale };
    const approvalKey = `pos-idem-${process.pid}-witness-approval`;
    const firstApproval = await witness()
      .post(`${BASE}/witness-approvals/${approvalId}/approve`)
      .set('Idempotency-Key', approvalKey).send(approvalBody);
    expect(firstApproval.status).toBe(200);
    expect(firstApproval.body.data.status).toBe('approved');
    await waitForIdemComplete(approvalKey);

    const replayedApproval = await witness()
      .post(`${ALIAS}/witness-approvals/${approvalId}/approve`)
      .set('Idempotency-Key', approvalKey).send(approvalBody);
    expect(replayedApproval.status).toBe(200);
    expect(replayedApproval.body.data).toEqual(firstApproval.body.data);

    const approvals = await prisma.$queryRawUnsafe(
      `SELECT id, status, decided_by FROM approvals
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      TENANT, approvalId,
    );
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe('approved');
    expect(String(approvals[0].decided_by)).toBe(WITNESS);
  });

  test('replayed create returns the original sale — single decrement, invoice, payment', async () => {
    const key = `pos-idem-${process.pid}-create-1`;
    const before = (await remaining(otcNear)).qty + (await remaining(otcFar)).qty;

    const first = await staff().post(BASE).set('Idempotency-Key', key)
      .send(saleBody('Replay Customer', 'upi-idem-1'));
    expect(first.status).toBe(200);
    expect(first.body.data.sale.status).toBe('COMPLETED');
    const saleId = first.body.data.sale.id;
    const invoiceId = Number(first.body.data.invoice.id);
    await waitForIdemComplete(key);

    const replay = await staff().post(ALIAS).set('Idempotency-Key', key)
      .send(saleBody('Replay Customer', 'upi-idem-1'));
    expect(replay.status).toBe(200);
    expect(replay.body.data.sale.id).toBe(saleId);
    expect(Number(replay.body.data.invoice.id)).toBe(invoiceId);

    const sales = await prisma.$queryRawUnsafe(
      `SELECT id FROM pharmacy_counter_sales
        WHERE tenant_id = $1::uuid AND customer_name = 'Replay Customer'`,
      TENANT,
    );
    expect(sales).toHaveLength(1);
    const payments = await prisma.$queryRawUnsafe(
      `SELECT id FROM billing_payments WHERE invoice_id = $1::int AND tenant_id = $2::uuid`,
      invoiceId, TENANT,
    );
    expect(payments).toHaveLength(1);
    const after = (await remaining(otcNear)).qty + (await remaining(otcFar)).qty;
    expect(after).toBe(before - 1);
  });

  test('same key with a different body is a 422 idempotency violation', async () => {
    const key = `pos-idem-${process.pid}-create-1`; // finalised by the previous test
    const res = await staff().post(BASE).set('Idempotency-Key', key)
      .send(saleBody('Different Customer', 'upi-idem-2'));
    expect(res.status).toBe(422);
  });

  test('two concurrent creates with one key produce exactly one sale', async () => {
    const key = `pos-idem-${process.pid}-race-1`;
    const body = saleBody('Race Idem Customer', 'upi-idem-3');
    const [a, b] = await Promise.all([
      staff().post(BASE).set('Idempotency-Key', key).send(body),
      staff().post(BASE).set('Idempotency-Key', key).send(body),
    ]);
    // The winner completes the sale. The loser is either the in-flight 409
    // (claim still executing) or, if the winner already finalised, a replay
    // of the identical 200 — never a second sale, never a 500.
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1]);
    const winner = a.status === 200 ? a : b;
    const other = winner === a ? b : a;
    if (other.status === 200) {
      expect(other.body.data.sale.id).toBe(winner.body.data.sale.id);
    }

    const sales = await prisma.$queryRawUnsafe(
      `SELECT id, invoice_id FROM pharmacy_counter_sales
        WHERE tenant_id = $1::uuid AND customer_name = 'Race Idem Customer'`,
      TENANT,
    );
    expect(sales).toHaveLength(1);
    const payments = await prisma.$queryRawUnsafe(
      `SELECT id FROM billing_payments WHERE invoice_id = $1::int AND tenant_id = $2::uuid`,
      Number(sales[0].invoice_id), TENANT,
    );
    expect(payments).toHaveLength(1);
  });

  test('cross-alias void replay returns one pending obligation and one exact refund', async () => {
    const createKey = `pos-idem-${process.pid}-create-void`;
    const created = await staff().post(BASE).set('Idempotency-Key', createKey)
      .send(saleBody('Void Idem Customer', 'upi-idem-4'));
    expect(created.status).toBe(200);
    const saleId = created.body.data.sale.id;
    const invoiceId = Number(created.body.data.invoice.id);

    const voidKey = `pos-idem-${process.pid}-void-1`;
    const voidBody = {
      reason: 'replay-safety check before handover',
      disposition: 'NEVER_HANDED_OVER',
    };
    const firstVoid = await incharge().post(`${BASE}/${saleId}/void`)
      .set('Idempotency-Key', voidKey).send(voidBody);
    expect(firstVoid.status).toBe(202);
    expect(firstVoid.body.data.sale.status).toBe('VOID_PENDING_REFUND');
    expect(firstVoid.body.data.workflow_status).toBe('AWAITING_FINANCE_APPROVAL');
    expect(firstVoid.body.data.refund.approval_status).toBe('PENDING');
    await waitForIdemComplete(voidKey);

    const replayVoid = await incharge().post(`${ALIAS}/${saleId}/void`)
      .set('Idempotency-Key', voidKey).send(voidBody);
    expect(replayVoid.status).toBe(202);
    expect(replayVoid.body.data.sale.status).toBe('VOID_PENDING_REFUND');
    expect(replayVoid.body.data.refund.id).toBe(firstVoid.body.data.refund.id);

    const refunds = await prisma.$queryRawUnsafe(
      `SELECT id FROM billing_refunds WHERE invoice_id = $1::int AND tenant_id = $2::uuid`,
      invoiceId, TENANT,
    );
    expect(refunds).toHaveLength(1);

    // Void without a key is refused outright.
    const noKey = await incharge().post(`${BASE}/${saleId}/void`).send(voidBody);
    expect(noKey.status).toBe(400);
  });
});

// ── Ledger postings ───────────────────────────────────────────────────
//
// collectPayment skips its own ledger wiring when handed a caller tx, so the
// counter-sale finalize must post the PAYMENT leg itself (issue leg debits
// PATIENT_AR; without the payment credit every walk-in sale corrupts the
// tenant's AR opening state).
describe('counter-sale ledger postings', () => {
  async function paymentEntryPostings(paymentId) {
    const entries = await prisma.$queryRawUnsafe(
      `SELECT id, entry_type FROM ledger_entries
        WHERE tenant_id = $1::uuid AND idempotency_key = $2`,
      TENANT, `payment-${paymentId}`,
    );
    if (!entries.length) return null;
    const postings = await prisma.$queryRawUnsafe(
      `SELECT a.code, p.amount_paise, p.invoice_id
         FROM ledger_postings p JOIN ledger_accounts a ON a.id = p.account_id
        WHERE p.entry_id = $1::bigint
        ORDER BY a.code`,
      Number(entries[0].id),
    );
    return { entry: entries[0], postings };
  }

  async function patientArNet(invoiceId) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(SUM(p.amount_paise), 0)::bigint AS net
         FROM ledger_postings p JOIN ledger_accounts a ON a.id = p.account_id
        WHERE a.code = 'PATIENT_AR' AND p.invoice_id = $1::int`,
      invoiceId,
    );
    return Number(rows[0].net);
  }

  test('shadow mode (default): PAYMENT leg posts post-commit and PATIENT_AR nets to zero', async () => {
    const result = await createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: otcItem, quantity: 2 }],
      customer_name: 'Ledger Shadow Customer',
      payment_mode: 'UPI',
      payment_reference: 'upi-ledger-1',
      sold_by: CASHIER,
    });
    expect(result.sale.status).toBe('COMPLETED');
    const invoiceId = Number(result.invoice.id);
    const totalPaise = Math.round(Number(result.invoice.total_amount) * 100);

    const paymentLeg = await paymentEntryPostings(result.payment.id);
    expect(paymentLeg).not.toBeNull();
    expect(paymentLeg.entry.entry_type).toBe('PAYMENT');
    const bank = paymentLeg.postings.find((p) => p.code === 'BANK');
    const ar = paymentLeg.postings.find((p) => p.code === 'PATIENT_AR');
    expect(Number(bank.amount_paise)).toBe(totalPaise);
    expect(Number(ar.amount_paise)).toBe(-totalPaise);
    expect(Number(ar.invoice_id)).toBe(invoiceId);

    // INVOICE_ISSUE debited PATIENT_AR by the total; the payment credit
    // brings the invoice's AR to zero — the trial-balance invariant the
    // drift oracle relies on before any tenant flips enforce mode.
    expect(await patientArNet(invoiceId)).toBe(0);
  });

  test('enforce mode: PAYMENT leg posts inside the finalize tx and AR still nets to zero', async () => {
    const prev = process.env.LEDGER_AUTHORITATIVE_MODE;
    process.env.LEDGER_AUTHORITATIVE_MODE = 'enforce';
    try {
      const result = await createCounterSale({
        tenantId: TENANT,
        lines: [{ inventory_item_id: otcItem, quantity: 1 }],
        customer_name: 'Ledger Enforce Customer',
        payment_mode: 'CASH',
        sold_by: CASHIER,
      });
      expect(result.sale.status).toBe('COMPLETED');
      expect(result.invoice.status).toBe('PAID');
      const paymentLeg = await paymentEntryPostings(result.payment.id);
      expect(paymentLeg).not.toBeNull();
      expect(paymentLeg.entry.entry_type).toBe('PAYMENT');
      const cash = paymentLeg.postings.find((p) => p.code === 'CASH');
      expect(Number(cash.amount_paise))
        .toBe(Math.round(Number(result.invoice.total_amount) * 100));
      expect(await patientArNet(Number(result.invoice.id))).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.LEDGER_AUTHORITATIVE_MODE;
      else process.env.LEDGER_AUTHORITATIVE_MODE = prev;
    }
  });
});

// ── Scheduled-drug walk-in identity (statutory register) ──────────────
//
// The H1 register and Schedule X account must name the patient. Anonymous
// H1/X/narcotic sales require captured name+phone (a registered patient
// linkage suffices by itself); OTC and plain Schedule H stay untouched.
describe('scheduled-drug walk-in identity', () => {
  test('anonymous H1 sale without a phone is rejected', async () => {
    await expect(createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: h1Item, quantity: 1 }],
      customer_name: 'Anon H1 Buyer',
      rx: RX,
      payment_mode: 'UPI',
      payment_reference: 'upi-anon-h1-0',
      sold_by: CASHIER,
    })).rejects.toMatchObject({ code: 'COUNTER_SALE_SCHEDULED_IDENTITY_REQUIRED' });
  });

  test('anonymous OTC sale without a phone still completes', async () => {
    const result = await createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: otcItem, quantity: 1 }],
      customer_name: 'Anon OTC Buyer',
      payment_mode: 'UPI',
      payment_reference: 'upi-anon-otc-1',
      sold_by: CASHIER,
    });
    expect(result.sale.status).toBe('COMPLETED');
  });

  test('anonymous H1 sale with name+phone writes the identity into the register, both directions', async () => {
    const result = await createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: h1Item, quantity: 3 }],
      customer_name: 'Anon H1 Buyer',
      customer_phone: '9800000088',
      rx: RX,
      payment_mode: 'UPI',
      payment_reference: 'upi-anon-h1-1',
      sold_by: CASHIER,
    });
    expect(result.sale.status).toBe('COMPLETED');
    const dispense = await prisma.$queryRawUnsafe(
      `SELECT patient_uid, patient_name, patient_phone FROM pharmacy_schedule_register
        WHERE tenant_id = $1::uuid AND inventory_item_id = $2::int
          AND movement_kind = 'dispense' AND patient_uid IS NULL`,
      TENANT, h1Item,
    );
    expect(dispense).toHaveLength(1);
    expect(dispense[0].patient_name).toBe('Anon H1 Buyer');
    expect(dispense[0].patient_phone).toBe('9800000088');

    const { reconciled: voided } = await completeCounterSaleVoid({
      saleId: result.sale.id,
      reason: 'identity return check before handover',
    });
    expect(voided.sale.status).toBe('VOIDED');
    const returned = await prisma.$queryRawUnsafe(
      `SELECT patient_name, patient_phone FROM pharmacy_schedule_register
        WHERE tenant_id = $1::uuid AND inventory_item_id = $2::int
          AND movement_kind = 'return' AND patient_uid IS NULL`,
      TENANT, h1Item,
    );
    expect(returned).toHaveLength(1);
    expect(returned[0].patient_name).toBe('Anon H1 Buyer');
    expect(returned[0].patient_phone).toBe('9800000088');
  });
});
