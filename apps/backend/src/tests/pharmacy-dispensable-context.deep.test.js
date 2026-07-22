// Deep tests for the pharmacist dispense-substitution READ endpoints:
//   GET /pharmacy-orders/orders/:id/dispensable          (patient + prescribed catalog lines)
//   GET /pharmacy-orders/catalog/:id/dispensable-batches (in-stock FEFO batches for a brand)
// Controller-level against the seeded QA DB (postgres superuser; explicit tenant filters).
import prisma from '../lib/prisma.js';
import {
  getOrderDispensableContext, getCatalogDispensableBatches,
} from '../controllers/pharmacy/pharmacyOrderController.js';

const TENANT = '00000000-0000-4000-8000-0000d15e0002';
const OTHER = '00000000-0000-4000-8000-0000d15e0999';
const PATIENT = 'b1111111-1111-4111-8111-111111111d15';
const COMP_KEY = 'dctxtest+amoxicillin+clavulanic_acid';

function mockRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
async function call(fn, tenantId, params) {
  const req = { tenantId, params, user: { uid: 'x', role: 'PHARMACY_INCHARGE' } };
  const res = mockRes();
  await fn(req, res);
  return res;
}

describe('pharmacist dispense-substitution read endpoints', () => {
  let compId; let catalogId; let orderId; let itemId; let batchNear; let batchFar;

  async function cleanup() {
    await prisma.$executeRawUnsafe(`DELETE FROM e_prescriptions WHERE tenant_id=$1::uuid AND patient_uid=$2::uuid`, TENANT, PATIENT).catch(() => {});
    for (const sql of [
      `DELETE FROM pharmacy_inventory_batches WHERE tenant_id=$1::uuid AND batch_number LIKE 'DCTX-%'`,
      `DELETE FROM pharmacy_inventory_items WHERE tenant_id=$1::uuid AND sku_code LIKE 'DCTX-%'`,
      `DELETE FROM pharmacy_orders WHERE tenant_id=$1::uuid AND order_note='dctx-test'`,
    ]) await prisma.$executeRawUnsafe(sql, TENANT).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_catalog WHERE name LIKE 'DCTXTEST %'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM drug_compositions WHERE composition_key=$1`, COMP_KEY).catch(() => {});
  }

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(`INSERT INTO tenants (id,slug,name,region,status,created_at,updated_at) VALUES ($1::uuid,'dctx-test','DCTX','IN','active',NOW(),NOW()) ON CONFLICT (id) DO NOTHING`, TENANT);
    compId = Number((await prisma.$queryRawUnsafe(`INSERT INTO drug_compositions (composition_key,display_label,active_ingredients,source) VALUES ($1,'Amox+Clav',ARRAY['amoxicillin','clavulanic_acid'],'curated') RETURNING id`, COMP_KEY))[0].id);
    catalogId = Number((await prisma.$queryRawUnsafe(`INSERT INTO pharmacy_catalog (name,generic_name,manufacturer,is_active,tenant_id,composition_id,strength,strength_key,form,form_key,composition_confidence,updated_at) VALUES ('DCTXTEST Clavam 625','Amoxicillin + Clavulanic acid','Alkem',TRUE,$1::uuid,$2,'625 mg','625mg','tablet','tablet','high',NOW()) RETURNING id`, TENANT, compId))[0].id);
    orderId = Number((await prisma.$queryRawUnsafe(`INSERT INTO pharmacy_orders (phone,order_note,status,tenant_id,updated_at) VALUES ('9999999999','dctx-test','CONFIRMED',$1::uuid,NOW()) RETURNING id`, TENANT))[0].id);
    await prisma.$executeRawUnsafe(
      `INSERT INTO e_prescriptions (pharmacy_order_id,patient_uid,medications,status,tenant_id,created_at,updated_at) VALUES ($1::int,$2::uuid,$3::jsonb,'active',$4::uuid,NOW(),NOW())`,
      orderId, PATIENT, JSON.stringify([{ catalog_id: catalogId, name: 'Clavam 625', quantity: 10 }]), TENANT,
    );
    itemId = Number((await prisma.$queryRawUnsafe(`INSERT INTO pharmacy_inventory_items (tenant_id,sku_code,display_name,catalog_id,composition_id) VALUES ($1::uuid,'DCTX-SKU-1','Clavam 625',$2,$3) RETURNING id`, TENANT, catalogId, compId))[0].id);
    batchNear = Number((await prisma.$queryRawUnsafe(`INSERT INTO pharmacy_inventory_batches (tenant_id,inventory_item_id,batch_number,expiry_date,received_quantity,remaining_quantity,status) VALUES ($1::uuid,$2,'DCTX-NEAR',(NOW()+INTERVAL '30 days')::date,50,50,'in_stock') RETURNING id`, TENANT, itemId))[0].id);
    batchFar = Number((await prisma.$queryRawUnsafe(`INSERT INTO pharmacy_inventory_batches (tenant_id,inventory_item_id,batch_number,expiry_date,received_quantity,remaining_quantity,status) VALUES ($1::uuid,$2,'DCTX-FAR',(NOW()+INTERVAL '365 days')::date,100,100,'in_stock') RETURNING id`, TENANT, itemId))[0].id);
    // excluded: expired (past date) + depleted (remaining 0)
    await prisma.$executeRawUnsafe(`INSERT INTO pharmacy_inventory_batches (tenant_id,inventory_item_id,batch_number,expiry_date,received_quantity,remaining_quantity,status) VALUES ($1::uuid,$2,'DCTX-EXPIRED',(NOW()-INTERVAL '1 day')::date,20,20,'in_stock')`, TENANT, itemId);
    await prisma.$executeRawUnsafe(`INSERT INTO pharmacy_inventory_batches (tenant_id,inventory_item_id,batch_number,expiry_date,received_quantity,remaining_quantity,status) VALUES ($1::uuid,$2,'DCTX-DEPLETED',(NOW()+INTERVAL '90 days')::date,10,0,'in_stock')`, TENANT, itemId);
  });

  afterAll(async () => {
    await cleanup();
    if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
  });

  test('orders/:id/dispensable → patient_uid + prescribed catalog lines', async () => {
    const res = await call(getOrderDispensableContext, TENANT, { id: String(orderId) });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.patient_uid).toBe(PATIENT);
    expect(res.body.data.lines).toHaveLength(1);
    expect(res.body.data.lines[0].catalog_id).toBe(catalogId);
    expect(res.body.data.lines[0].quantity).toBe(10);
  });

  test('catalog/:id/dispensable-batches → in-stock, non-expired, non-empty batches, FEFO', async () => {
    const res = await call(getCatalogDispensableBatches, TENANT, { id: String(catalogId) });
    expect(res.statusCode).toBe(200);
    const { batches } = res.body.data;
    expect(batches).toHaveLength(2);                          // expired + depleted excluded
    expect(batches[0].inventory_batch_id).toBe(batchNear);   // FEFO: nearest expiry first
    expect(batches[1].inventory_batch_id).toBe(batchFar);
    expect(batches[0].inventory_item_id).toBe(itemId);
    expect(batches.every((b) => !['DCTX-EXPIRED', 'DCTX-DEPLETED'].includes(b.batch_number))).toBe(true);
  });

  test('a foreign tenant sees no context and no batches', async () => {
    const ctx = await call(getOrderDispensableContext, OTHER, { id: String(orderId) });
    expect(ctx.body.data.lines).toHaveLength(0);
    const bat = await call(getCatalogDispensableBatches, OTHER, { id: String(catalogId) });
    expect(bat.body.data.batches).toHaveLength(0);
  });
});
