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
  requestCounterSaleWitnessApproval, searchSellableItems, ensureWalkInAnchorUid,
} from '../services/pharmacy/counterSaleService.js';
import { authClient } from './testClient.js';

const TENANT = '00000000-0000-4000-8000-0000c05a1e01';
const OTHER = '00000000-0000-4000-8000-0000c05a1e99';
const CASHIER = 'c0511111-1111-4111-8111-111111111111';
const NO_DRAWER_CASHIER = 'c0522222-2222-4222-8222-222222222222';
const WITNESS = 'c0533333-3333-4333-8333-333333333333';
const PATIENT = 'c0544444-4444-4444-8444-444444444444';
// Witness-validation fixtures (PR #875 follow-up: witness.uid must be a real,
// active, appropriately-rolled staff member of the same tenant).
const GHOST_WITNESS = 'c0555555-5555-4555-8555-555555555555'; // no users row
const CLERK_WITNESS = 'c0566666-6666-4666-8666-666666666666'; // RECEPTIONIST
const INACTIVE_WITNESS = 'c0577777-7777-4777-8777-777777777777'; // deactivated
const FOREIGN_WITNESS = 'c0588888-8888-4888-8888-888888888888'; // other tenant

const RX = { doctor_name: 'Dr. Test Prescriber', reference: 'RX-POS-001' };

let otcItem; let otcNear; let otcFar;
let h1Item; let h1Batch;
let xItem; let xBatch;
let expiredItem;
let foreignItem;

async function remaining(batchId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT remaining_quantity, status FROM pharmacy_inventory_batches WHERE id = $1::int`,
    batchId,
  );
  return { qty: Number(rows[0].remaining_quantity), status: rows[0].status };
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

async function cleanup() {
  // Ledger entries this suite posted (append-only → audit_bypass), collected
  // by tenant BEFORE the billing rows they reference are deleted.
  const cleanupTenantIds = [TENANT, OTHER];
  await prisma.$transaction(async (tx) => {
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
  }).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM idempotency_keys WHERE request_key LIKE 'pos-idem-%'`,
  ).catch(() => {});
  for (const tid of [TENANT, OTHER]) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM approvals
        WHERE tenant_id = $1::uuid AND approval_kind = 'controlled_dispense_witness'`, tid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_counter_sale_allocations WHERE tenant_id = $1::uuid`, tid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_counter_sale_lines WHERE tenant_id = $1::uuid`, tid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_counter_sales WHERE tenant_id = $1::uuid`, tid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_schedule_register WHERE tenant_id = $1::uuid`, tid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_stock_movements WHERE tenant_id = $1::uuid
        AND (reference_type LIKE 'pharmacy_counter_sale%' OR reference_type = 'controlled_dispense')`,
      tid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_inventory_batches WHERE tenant_id = $1::uuid AND batch_number LIKE 'POS-%'`, tid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_inventory_items WHERE tenant_id = $1::uuid AND sku_code LIKE 'POS-%'`, tid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM billing_refunds WHERE tenant_id = $1::uuid`, tid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM billing_payments WHERE tenant_id = $1::uuid`, tid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM billing_invoice_items WHERE tenant_id = $1::uuid`, tid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM billing_invoices WHERE tenant_id = $1::uuid`, tid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM cash_drawer_sessions WHERE tenant_id = $1::uuid`, tid,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM billing_service_master WHERE tenant_id = $1::uuid AND code LIKE 'POSGST%'`, tid,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, PATIENT,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE tenant_id = $1::uuid AND (role = 'PHARMACY_WALKIN' OR uid = $2::uuid)`,
    TENANT, PATIENT,
  ).catch(() => {});
  // Witness-roster fixture rows (bound as one uuid[] param — the variable
  // form is the sanctioned array-binding idiom, mirroring cleanupTenantIds).
  const witnessFixtureUids = [WITNESS, CASHIER, CLERK_WITNESS, INACTIVE_WITNESS, FOREIGN_WITNESS];
  await prisma.$executeRawUnsafe(
    `DELETE FROM staff WHERE user_id = ANY($1::uuid[])`,
    witnessFixtureUids,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid = ANY($1::uuid[])`,
    witnessFixtureUids,
  ).catch(() => {});
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
       ($2::uuid, 'Counter Pharmacist', 'PHARMACY_STAFF', $5::uuid, NOW()),
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

  xItem = await insertItem(TENANT, 'POS-X-1', { schedule: 'X', narcotic: true });
  xBatch = await insertBatch(TENANT, xItem, 'POS-X-B1', { expiryDays: 90, qty: 30, mrpMinor: 5000 });

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
});

afterAll(async () => {
  await cleanup();
  if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
}, 30_000);

describe('walk-in counter sale — FEFO + billing + drawer', () => {
  let saleId;

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

  test('same-day void restores the exact batches and pays the refund', async () => {
    const before = [await remaining(otcNear), await remaining(otcFar)];
    expect(before[0].qty).toBe(0);

    const result = await voidCounterSale({
      tenantId: TENANT,
      id: saleId,
      reason: 'Customer returned items',
      voided_by: CASHIER,
      voided_by_name: 'Counter Pharmacist',
    });
    expect(result.sale.status).toBe('VOIDED');
    expect(result.refund.approval_status).toBe('PAID');
    expect(Number(result.refund.amount)).toBe(651);

    // Exact restock, including reviving the fully-depleted near batch.
    expect((await remaining(otcNear)).qty).toBe(50);
    expect((await remaining(otcNear)).status).toBe('in_stock');
    expect((await remaining(otcFar)).qty).toBe(100);

    const detail = await getCounterSale({ tenantId: TENANT, id: saleId });
    expect(detail.status).toBe('VOIDED');
    expect(detail.void_reason).toBe('Customer returned items');
    for (const alloc of detail.lines[0].allocations) {
      expect(alloc.return_movement_id).not.toBeNull();
    }

    const voidAgain = voidCounterSale({
      tenantId: TENANT, id: saleId, reason: 'again', voided_by: CASHIER,
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

describe('schedule-class enforcement', () => {
  test('Schedule H1 requires a prescription reference', async () => {
    await expect(createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: h1Item, quantity: 2 }],
      customer_name: 'No Rx',
      payment_mode: 'UPI',
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
    const voided = await voidCounterSale({
      tenantId: TENANT,
      id: result.sale.id,
      reason: 'Rx withdrawn',
      voided_by: CASHIER,
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
      sold_by: CASHIER,
    })).rejects.toMatchObject({ code: 'COUNTER_SALE_WITNESS_REQUIRED' });

    const saleArgs = {
      tenantId: TENANT,
      lines: [{ inventory_item_id: xItem, quantity: 1 }],
      customer_name: 'X Buyer',
      customer_phone: '9800000042',
      rx: RX,
      payment_mode: 'CARD',
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
    // decrement back, then void the issued invoice as compensation.
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

    // The compensating void hit the issued invoice.
    const invoices = await prisma.$queryRawUnsafe(
      `SELECT status, void_reason FROM billing_invoices
        WHERE tenant_id = $1::uuid AND notes = $2
        ORDER BY id DESC LIMIT 1`,
      TENANT, `Pharmacy counter sale #${failed.id}`,
    );
    expect(invoices).toHaveLength(1);
    expect(invoices[0].status).toBe('VOID');
  });

  test('cross-tenant: foreign items are unsellable and foreign sales unreadable', async () => {
    await expect(createCounterSale({
      tenantId: TENANT,
      lines: [{ inventory_item_id: foreignItem, quantity: 1 }],
      customer_name: 'Cross Tenant',
      payment_mode: 'UPI',
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
  const staff = () => authClient('PHARMACY_STAFF', { uid: CASHIER, tenant_id: TENANT });
  const incharge = () => authClient('PHARMACY_INCHARGE', { uid: CASHIER, tenant_id: TENANT });

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

    const replay = await staff().post(BASE).set('Idempotency-Key', key)
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

  test('void replay returns the original void — refund raised exactly once', async () => {
    const createKey = `pos-idem-${process.pid}-create-void`;
    const created = await staff().post(BASE).set('Idempotency-Key', createKey)
      .send(saleBody('Void Idem Customer', 'upi-idem-4'));
    expect(created.status).toBe(200);
    const saleId = created.body.data.sale.id;
    const invoiceId = Number(created.body.data.invoice.id);

    const voidKey = `pos-idem-${process.pid}-void-1`;
    const voidBody = { reason: 'replay-safety check' };
    const firstVoid = await incharge().post(`${BASE}/${saleId}/void`)
      .set('Idempotency-Key', voidKey).send(voidBody);
    expect(firstVoid.status).toBe(200);
    expect(firstVoid.body.data.sale.status).toBe('VOIDED');
    await waitForIdemComplete(voidKey);

    const replayVoid = await incharge().post(`${BASE}/${saleId}/void`)
      .set('Idempotency-Key', voidKey).send(voidBody);
    expect(replayVoid.status).toBe(200);
    expect(replayVoid.body.data.sale.status).toBe('VOIDED');
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

    const voided = await voidCounterSale({
      tenantId: TENANT,
      id: result.sale.id,
      reason: 'identity return check',
      voided_by: CASHIER,
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
