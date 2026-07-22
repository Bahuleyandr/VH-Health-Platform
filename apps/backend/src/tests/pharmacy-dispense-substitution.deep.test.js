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
// Tests seed/connect as the postgres superuser (jest.setup default DATABASE_URL), which
// bypasses RLS; the controller's own tenant scoping + explicit tenant filters still apply.
import prisma from '../lib/prisma.js';
import { dispenseSubstitution } from '../controllers/pharmacy/pharmacyOrderController.js';

const TENANT = '00000000-0000-4000-8000-0000d15e0001';
const PATIENT = 'a1111111-1111-4111-8111-111111111d15';
const ACTOR = 'a2222222-2222-4222-8222-222222222d15';
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
async function callController(body) {
  const req = { tenantId: TENANT, user: { uid: ACTOR, role: 'PHARMACY_INCHARGE' }, id: 'req-dsub', body };
  const res = mockRes();
  await dispenseSubstitution(req, res);
  return res;
}

describe('dispenseSubstitution — atomic decrement + canonical events + equivalence gate', () => {
  let compId; let origId; let subId; let diffId; let itemId; let batchId;

  async function cleanup() {
    for (const sql of [
      `DELETE FROM pharmacy_stock_movements WHERE tenant_id=$1::uuid AND reference_type='dispense_substitution'`,
      `DELETE FROM pharmacy_inventory_batches WHERE tenant_id=$1::uuid AND batch_number LIKE 'DSUB-%'`,
      `DELETE FROM pharmacy_inventory_items WHERE tenant_id=$1::uuid AND sku_code LIKE 'DSUB-%'`,
      `DELETE FROM clinical_timeline_events WHERE tenant_id=$1::uuid`,
      `DELETE FROM clinical_audit_events WHERE tenant_id=$1::uuid`,
    ]) await prisma.$executeRawUnsafe(sql, TENANT).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'DSUBTEST %'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM drug_compositions WHERE composition_key=$1`, COMP_KEY).catch(() => {});
  }

  async function seedCatalog(name, { strengthKey, strengthComponents, manufacturer }) {
    const r = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (name, generic_name, manufacturer, is_active, tenant_id, composition_id, strength,
          strength_key, strength_components, form, form_key, release_key, route,
          composition_confidence, updated_at)
       VALUES ($1,'Amoxicillin + Clavulanic acid',$2,TRUE,$3::uuid,$4,$5,$5,$6::jsonb,
               'tablet','tablet',NULL,NULL,'high',NOW())
       RETURNING id`,
      name, manufacturer, TENANT, compId, strengthKey, strengthComponents,
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
    origId = await seedCatalog('DSUBTEST Augmentin 625', { strengthKey: '625mg', strengthComponents: combo, manufacturer: 'GSK' });
    subId = await seedCatalog('DSUBTEST Clavam 625', { strengthKey: '625mg', strengthComponents: combo, manufacturer: 'Alkem' });
    diffId = await seedCatalog('DSUBTEST Clavam 375', {
      strengthKey: '375mg',
      strengthComponents: JSON.stringify([
        { ingredient: 'amoxicillin', amount: 250, unit: 'mg' },
        { ingredient: 'clavulanic_acid', amount: 125, unit: 'mg' },
      ]),
      manufacturer: 'Alkem',
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
});
