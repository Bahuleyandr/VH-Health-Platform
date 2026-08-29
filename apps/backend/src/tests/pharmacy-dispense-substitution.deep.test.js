// Deep integration test for the pharmacist dispense-substitution controller
// (POST /pharmacy-orders/dispense-substitution).
//
// Proves the transactional contract directly at the controller boundary:
//   - an EQUIVALENT substitute (same composition + strength_key + form + release +
//     route + per-ingredient split) is dispensed: the chosen batch is decremented and
//     a 'dispense_substitution' stock movement is written, atomically with the canonical
//     clinical timeline + audit pair (a 200 + decrement proves the hard-fail pair
//     committed — otherwise the tx rolls back);
//   - a NON-equivalent substitute (different strength) is rejected 400 and stock is
//     untouched (the server-side equivalence gate, not client-trusted);
//   - insufficient stock is rejected 400 (FOR UPDATE + balance check), stock untouched.
//
// Controlled-substitution coverage (STAFF F1 fix): a Schedule X / narcotic
// substitute can never decrement stock without the statutory
// pharmacy_schedule_register row and an independently approved, consumed
// witness (SUBSTITUTION_WITNESS_REQUIRED fails closed); H1 routes through the
// register without a witness; the plain (non-controlled) path is unchanged.
//
// Tests seed/connect as the postgres superuser (jest.setup default DATABASE_URL), which
// bypasses RLS; the controller's own tenant scoping + explicit tenant filters still apply.
import prisma from '../lib/prisma.js';
import {
  dispenseSubstitution,
  markCounterDispensed,
  markDelivered,
  requestSubstitutionWitnessApproval,
  approveSubstitutionWitnessApproval,
} from '../controllers/pharmacy/pharmacyOrderController.js';

const TENANT = '00000000-0000-4000-8000-0000d15e0001';
const PATIENT = 'a1111111-1111-4111-8111-111111111d15';
const ACTOR = 'a2222222-2222-4222-8222-222222222d15';
const WITNESS = 'a3333333-3333-4333-8333-333333333d15';
const CLERK = 'a4444444-4444-4444-8444-444444444d15';
const COMP_KEY = 'dsubtest+amoxicillin+clavulanic_acid';
const combo = JSON.stringify([
  { ingredient: 'amoxicillin', amount: 500, unit: 'mg' },
  { ingredient: 'clavulanic_acid', amount: 125, unit: 'mg' },
]);

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
function bodyCode(res) {
  return res.body?.code ?? res.body?.details?.code ?? null;
}
async function callDelivery(orderId, body = {}) {
  const req = {
    tenantId: TENANT,
    user: { uid: ACTOR, role: 'PHARMACY_INCHARGE' },
    id: 'req-dsub-delivery',
    params: { id: String(orderId) },
    idempotencyClaim: { requestKey: `dsub-delivery-${orderId}` },
    body,
  };
  const res = mockRes();
  await markDelivered(req, res);
  return res;
}
async function callCounter(orderId, body = {}) {
  const req = {
    tenantId: TENANT,
    user: { id: null, uid: ACTOR, role: 'PHARMACY_INCHARGE' },
    id: 'req-dsub-counter',
    params: { id: String(orderId) },
    idempotencyClaim: { requestKey: `dsub-counter-${orderId}` },
    body,
  };
  const res = mockRes();
  await markCounterDispensed(req, res);
  return res;
}
let commandSequence = 0;
let currentOrderId;
let currentPrescriptionId;
async function callController(body, { idempotencyKey = `dsub-command-${++commandSequence}` } = {}) {
  const req = {
    tenantId: TENANT,
    user: { uid: ACTOR, role: 'PHARMACY_INCHARGE' },
    id: 'req-dsub',
    idempotencyClaim: { requestKey: idempotencyKey },
    body: {
      order_id: currentOrderId,
      prescription_id: currentPrescriptionId,
      ...body,
    },
  };
  const res = mockRes();
  await dispenseSubstitution(req, res);
  return res;
}

describe('dispenseSubstitution — atomic decrement + canonical events + equivalence gate', () => {
  let compId; let origId; let subId; let diffId; let itemId; let batchId;
  let xItemId; let xBatchId; let h1ItemId; let h1BatchId;
  let orderId; let prescriptionId;

  async function cleanup() {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_schedule_register WHERE tenant_id=$1::uuid`, TENANT,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pharmacy_stock_movements WHERE tenant_id=$1::uuid AND reference_type IN ('dispense_substitution', 'controlled_dispense')`,
        TENANT,
      );
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
    });
    for (const sql of [
      `DELETE FROM approvals WHERE tenant_id=$1::uuid AND approval_kind='controlled_dispense_witness'`,
      `DELETE FROM e_prescriptions WHERE tenant_id=$1::uuid`,
      `DELETE FROM pharmacy_orders WHERE tenant_id=$1::uuid AND order_note='dsub-origin'`,
      `DELETE FROM pharmacy_inventory_batches WHERE tenant_id=$1::uuid AND batch_number LIKE 'DSUB-%'`,
      `DELETE FROM pharmacy_inventory_items WHERE tenant_id=$1::uuid AND sku_code LIKE 'DSUB-%'`,
      `DELETE FROM clinical_timeline_events WHERE tenant_id=$1::uuid`,
      `DELETE FROM clinical_audit_events WHERE tenant_id=$1::uuid`,
    ]) await prisma.$executeRawUnsafe(sql, TENANT).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'DSUBTEST %'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM drug_compositions WHERE composition_key=$1`, COMP_KEY).catch(() => {});
    // Deliberate single array binds for ANY($1::uuid[]) — hoisted per house style.
    const staffFixtureUids = [ACTOR, WITNESS, CLERK];
    const userFixtureUids = [ACTOR, WITNESS, CLERK, PATIENT];
    await prisma.$executeRawUnsafe(
      `DELETE FROM staff WHERE user_id = ANY($1::uuid[])`, staffFixtureUids,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`, userFixtureUids,
    ).catch(() => {});
  }

  async function seedCatalog(name, {
    strengthKey, strengthComponents, manufacturer, unitPrice,
  }) {
    const r = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, manufacturer, is_active, tenant_id, composition_id, strength,
          strength_key, strength_components, form, form_key, release_key, route,
          composition_confidence, unit_price, updated_at)
       VALUES ($1,'Amoxicillin + Clavulanic acid',$2,TRUE,$3::uuid,$4,$5,$5,$6::jsonb,
               'tablet','tablet',NULL,NULL,'high',$7,NOW())
       RETURNING id`,
      name, manufacturer, TENANT, compId, strengthKey, strengthComponents, unitPrice,
    );
    return Number(r[0].id);
  }

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, status, created_at, updated_at)
       VALUES ($1::uuid,'dsub-test','DSUB','IN','active',NOW(),NOW()) ON CONFLICT (id) DO NOTHING`,
      TENANT,
    );
    const cr = await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions (composition_key, display_label, active_ingredients, source)
       VALUES ($1,'Amox+Clav',ARRAY['amoxicillin','clavulanic_acid'],'curated') RETURNING id`,
      COMP_KEY,
    );
    compId = Number(cr[0].id);
    origId = await seedCatalog('DSUBTEST Augmentin 625', {
      strengthKey: '625mg', strengthComponents: combo, manufacturer: 'GSK', unitPrice: 10,
    });
    subId = await seedCatalog('DSUBTEST Clavam 625', {
      strengthKey: '625mg', strengthComponents: combo, manufacturer: 'Alkem', unitPrice: 12,
    });
    diffId = await seedCatalog('DSUBTEST Clavam 375', {
      strengthKey: '375mg',
      strengthComponents: JSON.stringify([
        { ingredient: 'amoxicillin', amount: 250, unit: 'mg' },
        { ingredient: 'clavulanic_acid', amount: 125, unit: 'mg' },
      ]),
      manufacturer: 'Alkem',
      unitPrice: 8,
    });
    const it = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items (tenant_id, sku_code, display_name, catalog_id, composition_id)
       VALUES ($1::uuid,'DSUB-SKU-1','Clavam 625',$2,$3) RETURNING id`,
      TENANT, subId, compId,
    );
    itemId = Number(it[0].id);
    const b = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, expiry_date, received_quantity, remaining_quantity, status)
       VALUES ($1::uuid,$2,'DSUB-B1',(NOW() + INTERVAL '365 days')::date,100,100,'in_stock') RETURNING id`,
      TENANT, itemId,
    );
    batchId = Number(b[0].id);

    // Controlled fixtures: a Schedule X narcotic brand and a Schedule H1 brand
    // of the SAME composition (so the equivalence gate passes and the schedule
    // gate is the only variable under test).
    const xi = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, composition_id, schedule_class, is_narcotic)
       VALUES ($1::uuid,'DSUB-SKU-X','Clavam 625 CX',$2,$3,'X',true) RETURNING id`,
      TENANT, subId, compId,
    );
    xItemId = Number(xi[0].id);
    const xb = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, expiry_date, received_quantity, remaining_quantity, status)
       VALUES ($1::uuid,$2,'DSUB-BX',(NOW() + INTERVAL '365 days')::date,40,40,'in_stock') RETURNING id`,
      TENANT, xItemId,
    );
    xBatchId = Number(xb[0].id);
    const h1i = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id, composition_id, schedule_class, is_narcotic)
       VALUES ($1::uuid,'DSUB-SKU-H1','Clavam 625 CH1',$2,$3,'H1',false) RETURNING id`,
      TENANT, subId, compId,
    );
    h1ItemId = Number(h1i[0].id);
    const h1b = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, expiry_date, received_quantity, remaining_quantity, status)
       VALUES ($1::uuid,$2,'DSUB-BH1',(NOW() + INTERVAL '365 days')::date,40,40,'in_stock') RETURNING id`,
      TENANT, h1ItemId,
    );
    h1BatchId = Number(h1b[0].id);

    // Roster: the dispenser + patient + an eligible independent witness + an
    // ineligible clerk (role gate probe).
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, name, phone, role, tenant_id, updated_at)
       VALUES
         ($1::uuid, 'Substitution Patient', '9812345699', 'PATIENT', $5::uuid, NOW()),
         ($2::uuid, 'Substitution Pharmacist', NULL, 'PHARMACY_INCHARGE', $5::uuid, NOW()),
         ($3::uuid, 'Substitution Witness', NULL, 'PHARMACY_STAFF', $5::uuid, NOW()),
         ($4::uuid, 'Substitution Clerk', NULL, 'RECEPTIONIST', $5::uuid, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      PATIENT, ACTOR, WITNESS, CLERK, TENANT,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO staff (user_id, employee_id, name, is_active, archived, tenant_id, updated_at)
       VALUES
         ($1::uuid, 'DSUB-ACTOR', 'Roster Substitution Pharmacist', true, false, $4::uuid, NOW()),
         ($2::uuid, 'DSUB-WITNESS', 'Roster Substitution Witness', true, false, $4::uuid, NOW()),
         ($3::uuid, 'DSUB-CLERK', 'Roster Substitution Clerk', true, false, $4::uuid, NOW())`,
      ACTOR, WITNESS, CLERK, TENANT,
    );
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM e_prescriptions WHERE tenant_id=$1::uuid AND patient_uid=$2::uuid`,
      TENANT,
      PATIENT,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_orders WHERE tenant_id=$1::uuid AND order_note='dsub-origin'`,
      TENANT,
    );
    const orderRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders
         (tenant_id, phone, patient_name, patient_phone, order_note, delivery_type,
          status, items_list, total_amount, clinical_verification_status, updated_at)
        VALUES ($1::uuid, '9812345699', 'Substitution Patient', '9812345699',
          'dsub-origin', 'delivery', 'CONFIRMED', $2::jsonb, 2000000, 'verified', NOW())
       RETURNING id`,
      TENANT,
      JSON.stringify([{
        catalog_id: origId,
        name: 'DSUBTEST Augmentin 625',
        quantity: 200000,
        qty: 200000,
        price: 10,
        line_total: 2000000,
      }]),
    );
    orderId = Number(orderRows[0].id);
    const prescriptionRows = await prisma.$queryRawUnsafe(
      `INSERT INTO e_prescriptions
         (tenant_id, pharmacy_order_id, patient_uid, medications, status,
          prescription_number, created_at, updated_at)
       VALUES ($1::uuid, $2::int, $3::uuid, $4::jsonb, 'pharmacy_linked',
          $5, NOW(), NOW())
       RETURNING id`,
      TENANT,
      orderId,
      PATIENT,
      JSON.stringify([{
        catalog_id: origId,
        name: 'DSUBTEST Augmentin 625',
        quantity: 200000,
      }]),
      `DSUB-RX-${orderId}`,
    );
    prescriptionId = Number(prescriptionRows[0].id);
    currentOrderId = orderId;
    currentPrescriptionId = prescriptionId;
  });

  afterAll(async () => {
    await cleanup();
    if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
  });

  test('dispenses an equivalent substitute: decrements batch + movement + canonical pair', async () => {
    const res = await callController({
      patient_uid: PATIENT, inventory_item_id: itemId, inventory_batch_id: batchId,
      quantity: 10, original_catalog_id: origId, final_catalog_id: subId,
      reason: 'prescribed brand out of stock',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body?.success).toBe(true);

    const bat = await prisma.$queryRawUnsafe(`SELECT remaining_quantity, status FROM pharmacy_inventory_batches WHERE id=$1`, batchId);
    expect(Number(bat[0].remaining_quantity)).toBe(90);           // 100 - 10, atomic
    expect(bat[0].status).toBe('in_stock');

    const mv = await prisma.$queryRawUnsafe(
      `SELECT * FROM pharmacy_stock_movements WHERE tenant_id=$1::uuid AND inventory_batch_id=$2 AND reference_type='dispense_substitution'`,
      TENANT, batchId,
    );
    expect(mv.length).toBe(1);
    expect(Number(mv[0].quantity_delta)).toBe(-10);
    expect(mv[0].metadata).toEqual(expect.objectContaining({
      order_id: orderId,
      prescription_id: prescriptionId,
      fulfilment_status: 'partial',
      remaining_quantity: 199990,
      billable_subtotal: 120,
    }));
    expect(res.body.data).toEqual(expect.objectContaining({
      order_id: orderId,
      prescription_id: prescriptionId,
      remaining_quantity: 199990,
      fulfilment_status: 'partial',
      billable_subtotal: 120,
      batch_evidence: expect.objectContaining({ inventory_batch_id: batchId }),
    }));
    const projection = await prisma.$queryRawUnsafe(
      `SELECT po.partial_dispense, po.total_amount, po.items_list,
              ep.status AS prescription_status, ep.medications
         FROM pharmacy_orders po
         JOIN e_prescriptions ep ON ep.pharmacy_order_id=po.id AND ep.tenant_id=po.tenant_id
        WHERE po.id=$1::int AND ep.id=$2::int`,
      orderId,
      prescriptionId,
    );
    expect(projection[0].partial_dispense).toBe(true);
    expect(Number(projection[0].total_amount)).toBe(120);
    expect(projection[0].prescription_status).toBe('pharmacy_linked');
    expect(projection[0].medications[0]).toEqual(expect.objectContaining({
      dispensed_quantity: 10,
      remaining_quantity: 199990,
      fulfilment_status: 'partial',
    }));
    expect(projection[0].items_list[0]).toEqual(expect.objectContaining({
      catalog_id: subId,
      inventory_item_id: itemId,
      price: 12,
      inventory_billable_total: 120,
      line_total: 120,
      dispensed_qty: 10,
      inventory_dispensed_quantity: 10,
    }));

    // canonical pair committed in the same tx (a 200 + decrement already implies it, but assert explicitly)
    const tl = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM clinical_timeline_events WHERE tenant_id=$1::uuid`, TENANT);
    const au = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM clinical_audit_events WHERE tenant_id=$1::uuid`, TENANT);
    expect(tl[0].n).toBeGreaterThanOrEqual(1);
    expect(au[0].n).toBeGreaterThanOrEqual(1);
  });

  test('rejects a non-equivalent substitute (different strength) and leaves stock untouched', async () => {
    const before = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, batchId);
    const res = await callController({
      patient_uid: PATIENT, inventory_item_id: itemId, inventory_batch_id: batchId,
      quantity: 5, original_catalog_id: origId, final_catalog_id: diffId, reason: 'x',
    });
    expect(res.statusCode).toBe(400);
    const after = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, batchId);
    expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity));
  });

  test('rejects insufficient stock atomically', async () => {
    const before = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, batchId);
    const res = await callController({
      patient_uid: PATIENT, inventory_item_id: itemId, inventory_batch_id: batchId,
      quantity: 100000, original_catalog_id: origId, final_catalog_id: subId,
    });
    expect(res.statusCode).toBe(400);
    const after = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, batchId);
    expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity));
  });

  test('delivery rejects caller line quantities and unmatched catalog lines', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_orders SET status='DISPATCHED'
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      orderId,
      TENANT,
    );
    const before = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    const quantityMutation = await callDelivery(orderId, {
      dispensed_items: [{
        catalog_id: origId,
        inventory_item_id: itemId,
        quantity: 1,
        inventory_allocations: [{ inventory_batch_id: batchId, quantity: 1 }],
      }],
    });
    expect(quantityMutation.statusCode).toBe(400);
    expect(bodyCode(quantityMutation)).toBe('PHARMACY_ORDER_DELIVERY_LINE_MUTATION_FORBIDDEN');

    const unmatched = await callDelivery(orderId, {
      dispensed_items: [{
        catalog_id: diffId,
        inventory_item_id: itemId,
        inventory_allocations: [{ inventory_batch_id: batchId, quantity: 1 }],
      }],
    });
    expect(unmatched.statusCode).toBe(409);
    expect(bodyCode(unmatched)).toBe('PHARMACY_ORDER_DELIVERY_LINE_UNRESOLVED');
    const after = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity));
    const orderRows = await prisma.$queryRawUnsafe(
      `SELECT status FROM pharmacy_orders WHERE id=$1::int AND tenant_id=$2::uuid`,
      orderId,
      TENANT,
    );
    expect(orderRows[0].status).toBe('DISPATCHED');
  });

  test('counter rejects unmatched and caller-priced lines before billing or stock movement', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_orders SET delivery_type='counter'
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      orderId,
      TENANT,
    );
    const before = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    const priced = await callCounter(orderId, {
      dispensed_items: [{ catalog_id: origId, quantity: 1, price: 0 }],
      payment_mode: 'none',
    });
    expect(priced.statusCode).toBe(400);
    expect(bodyCode(priced)).toBe('PHARMACY_ORDER_PRICE_MUTATION_FORBIDDEN');
    const unmatched = await callCounter(orderId, {
      dispensed_items: [{ catalog_id: diffId, quantity: 1 }],
      payment_mode: 'none',
    });
    expect(unmatched.statusCode).toBe(409);
    expect(bodyCode(unmatched)).toBe('PHARMACY_ORDER_DISPENSE_LINE_UNRESOLVED');
    const after = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity));
  });

  test('partial substitution then delivery allocates only the remainder and closes billing + eRx evidence', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE e_prescriptions SET medications=$3::jsonb
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      prescriptionId,
      TENANT,
      JSON.stringify([{ catalog_id: origId, name: 'DSUBTEST Augmentin 625', quantity: 5 }]),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_orders SET items_list=$3::jsonb, total_amount=50
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      orderId,
      TENANT,
      JSON.stringify([{
        catalog_id: origId,
        name: 'DSUBTEST Augmentin 625',
        quantity: 5,
        qty: 5,
        price: 10,
        line_total: 50,
      }]),
    );
    const before = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    const partial = await callController({
      patient_uid: PATIENT,
      inventory_item_id: itemId,
      inventory_batch_id: batchId,
      quantity: 2,
      original_catalog_id: origId,
      final_catalog_id: subId,
    });
    expect(partial.statusCode).toBe(200);
    expect(partial.body?.data).toEqual(expect.objectContaining({
      fulfilment_status: 'partial',
      remaining_quantity: 3,
    }));
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_orders SET status='DISPATCHED'
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      orderId,
      TENANT,
    );

    const delivered = await callDelivery(orderId);

    expect(delivered.statusCode).toBe(200);
    const after = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity) - 5);
    const projection = await prisma.$queryRawUnsafe(
      `SELECT po.status, po.total_amount, po.items_list,
              ep.status AS prescription_status, ep.medications
         FROM pharmacy_orders po
         JOIN e_prescriptions ep ON ep.pharmacy_order_id=po.id AND ep.tenant_id=po.tenant_id
        WHERE po.id=$1::int AND ep.id=$2::int`,
      orderId,
      prescriptionId,
    );
    expect(projection[0].status).toBe('DELIVERED');
    expect(Number(projection[0].total_amount)).toBe(60);
    expect(projection[0].items_list[0]).toEqual(expect.objectContaining({
      catalog_id: subId,
      ordered_qty: 5,
      dispensed_qty: 5,
      remaining_qty: 0,
      inventory_dispensed_quantity: 5,
      inventory_remaining_quantity: 0,
      price: 12,
      line_total: 60,
    }));
    expect(projection[0].prescription_status).toBe('fulfilled');
    expect(projection[0].medications[0]).toEqual(expect.objectContaining({
      ordered_quantity: 5,
      dispensed_quantity: 5,
      remaining_quantity: 0,
      fulfilment_status: 'fulfilled',
    }));
  });

  test('repeated partial substitutions preserve each movement price without repricing history', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE e_prescriptions SET medications=$3::jsonb
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      prescriptionId,
      TENANT,
      JSON.stringify([{ catalog_id: origId, name: 'DSUBTEST Augmentin 625', quantity: 5 }]),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_orders SET items_list=$3::jsonb, total_amount=50
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      orderId,
      TENANT,
      JSON.stringify([{
        catalog_id: origId,
        name: 'DSUBTEST Augmentin 625',
        quantity: 5,
        qty: 5,
        price: 10,
        line_total: 50,
      }]),
    );
    const first = await callController({
      patient_uid: PATIENT,
      inventory_item_id: itemId,
      inventory_batch_id: batchId,
      quantity: 2,
      original_catalog_id: origId,
      final_catalog_id: subId,
    });
    expect(first.statusCode).toBe(200);

    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_catalog SET unit_price=15, updated_at=NOW() WHERE id=$1::int`,
      subId,
    );
    try {
      const second = await callController({
        patient_uid: PATIENT,
        inventory_item_id: itemId,
        inventory_batch_id: batchId,
        quantity: 1,
        original_catalog_id: origId,
        final_catalog_id: subId,
      });
      expect(second.statusCode).toBe(200);
      const rows = await prisma.$queryRawUnsafe(
        `SELECT total_amount, items_list FROM pharmacy_orders
          WHERE id=$1::int AND tenant_id=$2::uuid`,
        orderId,
        TENANT,
      );
      expect(Number(rows[0].total_amount)).toBe(39);
      expect(rows[0].items_list[0]).toEqual(expect.objectContaining({
        dispensed_qty: 3,
        inventory_dispensed_quantity: 3,
        inventory_billable_total: 39,
        line_total: 39,
      }));
      expect(rows[0].items_list[0].substitution_history).toEqual([
        expect.objectContaining({ quantity: 2, unit_price: 12, line_total: 24 }),
        expect.objectContaining({ quantity: 1, unit_price: 15, line_total: 15 }),
      ]);
    } finally {
      await prisma.$executeRawUnsafe(
        `UPDATE pharmacy_catalog SET unit_price=12, updated_at=NOW() WHERE id=$1::int`,
        subId,
      );
    }
  });

  test('partial substitution then counter finalization preserves substituted price and allocates the remainder', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE e_prescriptions SET medications=$3::jsonb
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      prescriptionId,
      TENANT,
      JSON.stringify([{ catalog_id: origId, name: 'DSUBTEST Augmentin 625', quantity: 4 }]),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_orders
          SET delivery_type='counter', items_list=$3::jsonb, total_amount=40
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      orderId,
      TENANT,
      JSON.stringify([{
        catalog_id: origId,
        name: 'DSUBTEST Augmentin 625',
        quantity: 4,
        qty: 4,
        price: 10,
        line_total: 40,
      }]),
    );
    const before = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    const partial = await callController({
      patient_uid: PATIENT,
      inventory_item_id: itemId,
      inventory_batch_id: batchId,
      quantity: 1,
      original_catalog_id: origId,
      final_catalog_id: subId,
    });
    expect(partial.statusCode).toBe(200);

    const counter = await callCounter(orderId, {
      payment_mode: 'cash',
      amount_collected: 48,
    });

    expect(counter.statusCode).toBe(200);
    const after = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity) - 4);
    const projection = await prisma.$queryRawUnsafe(
      `SELECT po.status, po.total_amount, po.items_list,
              ep.status AS prescription_status, ep.medications
         FROM pharmacy_orders po
         JOIN e_prescriptions ep ON ep.pharmacy_order_id=po.id AND ep.tenant_id=po.tenant_id
        WHERE po.id=$1::int AND ep.id=$2::int`,
      orderId,
      prescriptionId,
    );
    expect(projection[0].status).toBe('DISPENSED');
    expect(Number(projection[0].total_amount)).toBe(48);
    expect(projection[0].items_list[0]).toEqual(expect.objectContaining({
      catalog_id: subId,
      ordered_qty: 4,
      dispensed_qty: 4,
      inventory_dispensed_quantity: 4,
      inventory_remaining_quantity: 0,
      price: 12,
      line_total: 48,
    }));
    expect(projection[0].prescription_status).toBe('fulfilled');
    expect(projection[0].medications[0]).toEqual(expect.objectContaining({
      dispensed_quantity: 4,
      remaining_quantity: 0,
      fulfilment_status: 'fulfilled',
    }));
  });

  test('cancelled prescription is rejected before stock or order mutation', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE e_prescriptions SET status='cancelled'
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      prescriptionId,
      TENANT,
    );
    const before = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );

    const response = await callController({
      patient_uid: PATIENT,
      inventory_item_id: itemId,
      inventory_batch_id: batchId,
      quantity: 1,
      original_catalog_id: origId,
      final_catalog_id: subId,
    });

    expect(response.statusCode).toBe(409);
    expect(response.body?.code ?? response.body?.details?.code)
      .toBe('SUBSTITUTION_PRESCRIPTION_STATUS_INVALID');
    const after = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity));
  });

  test('pending pharmacy verification blocks substitution before stock mutation', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_orders SET clinical_verification_status='pending'
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      orderId,
      TENANT,
    );
    const before = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );

    const response = await callController({
      patient_uid: PATIENT,
      inventory_item_id: itemId,
      inventory_batch_id: batchId,
      quantity: 1,
      original_catalog_id: origId,
      final_catalog_id: subId,
    });

    expect(response.statusCode).toBe(409);
    expect(response.body?.code ?? response.body?.details?.code)
      .toBe('PHARMACY_VERIFICATION_REQUIRED');
    const after = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity));
  });

  test('same command key replays once and conflicts when the linked body changes', async () => {
    const before = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    const commandKey = `dsub-replay-${orderId}`;
    const body = {
      patient_uid: PATIENT,
      inventory_item_id: itemId,
      inventory_batch_id: batchId,
      quantity: 1,
      original_catalog_id: origId,
      final_catalog_id: subId,
    };
    const first = await callController(body, { idempotencyKey: commandKey });
    const replay = await callController(body, { idempotencyKey: commandKey });
    const mismatch = await callController(
      { ...body, quantity: 2 },
      { idempotencyKey: commandKey },
    );

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.body?.data?.idempotent_replay).toBe(true);
    expect(mismatch.statusCode).toBe(422);
    const after = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
      batchId,
    );
    expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity) - 1);
  });

  test('a fully fulfilled prescription still replays from durable movement evidence', async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE e_prescriptions SET medications=$3::jsonb
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      prescriptionId,
      TENANT,
      JSON.stringify([{ catalog_id: origId, name: 'DSUBTEST Augmentin 625', quantity: 1 }]),
    );
    await prisma.$executeRawUnsafe(
      `UPDATE pharmacy_orders SET items_list=$3::jsonb, total_amount=10
        WHERE id=$1::int AND tenant_id=$2::uuid`,
      orderId,
      TENANT,
      JSON.stringify([{
        catalog_id: origId,
        name: 'DSUBTEST Augmentin 625',
        quantity: 1,
        qty: 1,
        price: 10,
        line_total: 10,
      }]),
    );
    const commandKey = `dsub-fulfilled-replay-${orderId}`;
    const body = {
      patient_uid: PATIENT,
      inventory_item_id: itemId,
      inventory_batch_id: batchId,
      quantity: 1,
      original_catalog_id: origId,
      final_catalog_id: subId,
    };
    const first = await callController(body, { idempotencyKey: commandKey });
    const replay = await callController(body, { idempotencyKey: commandKey });

    expect(first.statusCode).toBe(200);
    expect(first.body?.data?.fulfilment_status).toBe('fulfilled');
    expect(first.body?.data?.remaining_quantity).toBe(0);
    expect(replay.statusCode).toBe(200);
    expect(replay.body?.data?.idempotent_replay).toBe(true);
  });

  describe('controlled substitutes route through the statutory register (STAFF F1)', () => {
    const xBody = (overrides = {}) => ({
      order_id: orderId,
      prescription_id: prescriptionId,
      patient_uid: PATIENT,
      inventory_item_id: xItemId,
      inventory_batch_id: xBatchId,
      quantity: 4,
      original_catalog_id: origId,
      final_catalog_id: subId,
      reason: 'x substitute',
      ...overrides,
    });

    test('Schedule X substitute WITHOUT a witness approval fails closed: no decrement, no movement, no register row', async () => {
      const before = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, xBatchId);
      const res = await callController(xBody());
      expect(res.statusCode).toBe(400);
      expect(bodyCode(res)).toBe('SUBSTITUTION_WITNESS_REQUIRED');
      const after = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, xBatchId);
      expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity));
      const mv = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM pharmacy_stock_movements WHERE tenant_id=$1::uuid AND inventory_item_id=$2::int`,
        TENANT, xItemId,
      );
      expect(mv[0].n).toBe(0);
      const reg = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM pharmacy_schedule_register WHERE tenant_id=$1::uuid AND inventory_item_id=$2::int`,
        TENANT, xItemId,
      );
      expect(reg[0].n).toBe(0);
    });

    test('a bogus witness_approval_id also fails closed with stock untouched', async () => {
      const before = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, xBatchId);
      const res = await callController(xBody({ witness_approval_id: '999999999' }));
      expect(res.statusCode).toBe(404);
      const after = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, xBatchId);
      expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity));
    });

    test('witness request endpoint: only X/narcotic items, and a preselected approval id is rejected', async () => {
      await expect(requestSubstitutionWitnessApproval({
        tenantId: TENANT,
        requested_by: ACTOR,
        ...xBody({ inventory_item_id: h1ItemId, inventory_batch_id: h1BatchId }),
      })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_NOT_REQUIRED' });

      await expect(requestSubstitutionWitnessApproval({
        tenantId: TENANT,
        requested_by: ACTOR,
        ...xBody({ witness_approval_id: '17' }),
      })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_APPROVAL_PRESELECTED' });
    });

    test('ineligible-role and self witnesses are rejected at approval time', async () => {
      const approval = await requestSubstitutionWitnessApproval({
        tenantId: TENANT, requested_by: ACTOR, ...xBody(),
      });
      await expect(approveSubstitutionWitnessApproval({
        approvalId: approval.id,
        actorUid: CLERK,
        substitution: { tenantId: TENANT, ...xBody() },
      })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_ROLE_INELIGIBLE' });
      await expect(approveSubstitutionWitnessApproval({
        approvalId: approval.id,
        actorUid: ACTOR,
        substitution: { tenantId: TENANT, ...xBody() },
      })).rejects.toMatchObject({ code: 'CONTROLLED_DISPENSE_WITNESS_SELF' });
    });

    test('witnessed Schedule X substitute: decrement + movement + register row + consumed approval + canonical pair in ONE tx', async () => {
      const body = xBody();
      const approval = await requestSubstitutionWitnessApproval({
        tenantId: TENANT, requested_by: ACTOR, ...body,
      });
      await approveSubstitutionWitnessApproval({
        approvalId: approval.id,
        actorUid: WITNESS,
        substitution: { tenantId: TENANT, ...body },
      });

      const commandKey = `dsub-x-${orderId}`;
      const forged = await callController(
        { ...body, witness_approval_id: approval.id, performed_by_name: 'Forged Performer' },
        { idempotencyKey: commandKey },
      );
      expect(forged.statusCode).toBe(400);
      expect(bodyCode(forged)).toBe('SUBSTITUTION_PERFORMER_NAME_FORBIDDEN');
      const beforeValid = await prisma.$queryRawUnsafe(
        `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
        xBatchId,
      );
      expect(Number(beforeValid[0].remaining_quantity)).toBe(40);

      const res = await callController(
        { ...body, witness_approval_id: approval.id },
        { idempotencyKey: commandKey },
      );
      expect(res.statusCode).toBe(200);
      expect(res.body?.success).toBe(true);
      expect(res.body?.data?.schedule_class).toBe('X');
      expect(res.body?.data?.register_entry_id).toEqual(expect.any(Number));

      const bat = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, xBatchId);
      expect(Number(bat[0].remaining_quantity)).toBe(36); // 40 - 4, atomic

      const mv = await prisma.$queryRawUnsafe(
        `SELECT movement_kind, quantity_delta, reference_type, reference_id
           FROM pharmacy_stock_movements
          WHERE tenant_id=$1::uuid AND inventory_item_id=$2::int`,
        TENANT, xItemId,
      );
      expect(mv).toHaveLength(1);
      expect(mv[0].movement_kind).toBe('issue');
      expect(Number(mv[0].quantity_delta)).toBe(-4);
      expect(mv[0].reference_type).toBe('controlled_dispense');
      expect(mv[0].reference_id).toMatch(/^dispense-substitution:/);

      // The statutory register row: schedule, quantities, patient identity
      // snapshot, dispenser + CANONICAL roster witness — same contract as the
      // controlled-dispense and counter-sale paths.
      const reg = await prisma.$queryRawUnsafe(
        `SELECT schedule_class, movement_kind, quantity, running_balance,
                patient_uid, patient_name, performed_by, performed_by_name,
                witness_uid, witness_name
           FROM pharmacy_schedule_register
          WHERE tenant_id=$1::uuid AND inventory_item_id=$2::int`,
        TENANT, xItemId,
      );
      expect(reg).toHaveLength(1);
      expect(reg[0].schedule_class).toBe('X');
      expect(reg[0].movement_kind).toBe('dispense');
      expect(Number(reg[0].quantity)).toBe(4);
      expect(Number(reg[0].running_balance)).toBe(36);
      expect(String(reg[0].patient_uid)).toBe(PATIENT);
      expect(reg[0].patient_name).toBe('Substitution Patient');
      expect(String(reg[0].performed_by)).toBe(ACTOR);
      expect(reg[0].performed_by_name).toBe('Roster Substitution Pharmacist');
      expect(String(reg[0].witness_uid)).toBe(WITNESS);
      expect(reg[0].witness_name).toBe('Roster Substitution Witness');

      // The exact durable command replays without consuming the witness or
      // decrementing the batch a second time.
      const replay = await callController(
        { ...body, witness_approval_id: approval.id },
        { idempotencyKey: commandKey },
      );
      expect(replay.statusCode).toBe(200);
      expect(replay.body?.data?.idempotent_replay).toBe(true);
      const batAfterReplay = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, xBatchId);
      expect(Number(batAfterReplay[0].remaining_quantity)).toBe(36);

      // Canonical pair for the substitution movement committed in the tx.
      const tl = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM clinical_timeline_events
          WHERE tenant_id=$1::uuid AND event_type='pharmacy.dispense_substitution'`,
        TENANT,
      );
      expect(tl[0].n).toBeGreaterThanOrEqual(1);
    });

    test('Schedule H1 substitute needs no witness but still lands on the register', async () => {
      const body = xBody({
        inventory_item_id: h1ItemId, inventory_batch_id: h1BatchId, quantity: 3,
      });
      const res = await callController(body);
      expect(res.statusCode).toBe(200);
      expect(res.body?.data?.schedule_class).toBe('H1');

      const bat = await prisma.$queryRawUnsafe(`SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`, h1BatchId);
      expect(Number(bat[0].remaining_quantity)).toBe(37); // 40 - 3

      const reg = await prisma.$queryRawUnsafe(
        `SELECT schedule_class, witness_uid, witness_name, patient_name
           FROM pharmacy_schedule_register
          WHERE tenant_id=$1::uuid AND inventory_item_id=$2::int`,
        TENANT, h1ItemId,
      );
      expect(reg).toHaveLength(1);
      expect(reg[0].schedule_class).toBe('H1');
      expect(reg[0].witness_uid).toBeNull();
      expect(reg[0].patient_name).toBe('Substitution Patient');
    });

    test('controlled substitution rejects an inactive dispenser roster before decrement', async () => {
      const before = await prisma.$queryRawUnsafe(
        `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
        h1BatchId,
      );
      await prisma.$executeRawUnsafe(
        `UPDATE staff SET is_active=false WHERE tenant_id=$1::uuid AND user_id=$2::uuid`,
        TENANT,
        ACTOR,
      );
      try {
        const res = await callController(xBody({
          inventory_item_id: h1ItemId,
          inventory_batch_id: h1BatchId,
          quantity: 1,
        }));
        expect(res.statusCode).toBe(403);
        expect(bodyCode(res)).toBe('SUBSTITUTION_PERFORMER_IDENTITY_REQUIRED');
        const after = await prisma.$queryRawUnsafe(
          `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1`,
          h1BatchId,
        );
        expect(Number(after[0].remaining_quantity)).toBe(Number(before[0].remaining_quantity));
      } finally {
        await prisma.$executeRawUnsafe(
          `UPDATE staff SET is_active=true WHERE tenant_id=$1::uuid AND user_id=$2::uuid`,
          TENANT,
          ACTOR,
        );
      }
    });
  });
});
