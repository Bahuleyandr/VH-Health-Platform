import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const ADMIN_UID = 'a7777777-7777-4777-8777-777777777d57';
const PATIENT_UID = 'a7777777-7777-4777-8777-777777777d58';
const PATIENT_PHONE = '+919000075757';
const MED_NAME = 'D57 Route Contract Paracetamol';

function authed(token) {
  return {
    get: (path) => request(app)
      .get(path)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`),
    post: (path) => request(app)
      .post(path)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`),
  };
}

describe('D57 pharmacy route contract aliases', () => {
  let admin;
  let adminIntId;
  let patientIntId;
  let tenantId;
  let catalogId;
  let inventoryItemId;
  let inventoryBatchId;

  async function seedCounterOrder(note = 'D57 counter route contract') {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_orders (
         phone, patient_id, patient_name, patient_phone, order_note,
         delivery_type, status, prescribed_by, items_list, total_amount,
         ordered_at, updated_at
       ) VALUES (
         $1, $2, 'D57 Route Patient', $1, $3,
         'counter', 'PENDING', $4::uuid, $5::jsonb, 0,
         NOW(), NOW()
       )
       RETURNING id`,
      PATIENT_PHONE,
      patientIntId,
      note,
      PATIENT_UID,
      JSON.stringify([{
        catalog_id: catalogId,
        inventory_item_id: inventoryItemId,
        name: MED_NAME,
        qty: 1,
      }]),
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_stock_movements
        WHERE inventory_item_id IN (
          SELECT id FROM pharmacy_inventory_items WHERE sku_code='D57-ROUTE-SKU'
        )`,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_inventory_batches
        WHERE inventory_item_id IN (
          SELECT id FROM pharmacy_inventory_items WHERE sku_code='D57-ROUTE-SKU'
        )`,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_inventory_items WHERE sku_code='D57-ROUTE-SKU'`,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_catalog WHERE name=$1`,
      MED_NAME,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_order_history WHERE order_id IN (
         SELECT id FROM pharmacy_orders WHERE phone = $1
       )`,
      PATIENT_PHONE,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_orders WHERE phone = $1`, PATIENT_PHONE);
    await prisma.medications.deleteMany({ where: { name: MED_NAME } });
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
      ADMIN_UID,
      PATIENT_UID,
    );

    const adminRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000075757', 'D57 Route Admin', 'ADMIN', true, NOW())
       RETURNING id, tenant_id`,
      ADMIN_UID,
    );
    adminIntId = adminRows[0].id;
    tenantId = adminRows[0].tenant_id;

    const patientRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'D57 Route Patient', 'PATIENT', true, NOW())
       RETURNING id`,
      PATIENT_UID,
      PATIENT_PHONE,
    );
    patientIntId = patientRows[0].id;

    await prisma.medications.create({
      data: {
        name: MED_NAME,
        generic_name: 'Paracetamol',
        brand: 'D57',
        category: 'analgesic',
        dosage: '500mg',
        form: 'tablet',
        price: 0,
        stock_quantity: 25,
        is_active: true,
        created_by: ADMIN_UID,
      },
    });

    const catalogRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, generic_name, manufacturer, category, unit_price,
          stock_quantity, is_active, in_stock, updated_at)
       VALUES ($1::uuid, $2, 'Paracetamol', 'D57', 'analgesic', 0,
          25, TRUE, TRUE, NOW())
       RETURNING id`,
      tenantId,
      MED_NAME,
    );
    catalogId = Number(catalogRows[0].id);
    const itemRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_items
         (tenant_id, sku_code, display_name, catalog_id)
       VALUES ($1::uuid, 'D57-ROUTE-SKU', $2, $3::int)
       RETURNING id`,
      tenantId,
      MED_NAME,
      catalogId,
    );
    inventoryItemId = Number(itemRows[0].id);
    const batchRows = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_inventory_batches
         (tenant_id, inventory_item_id, batch_number, expiry_date,
          received_quantity, remaining_quantity, status)
       VALUES ($1::uuid, $2::int, 'D57-ROUTE-B1', (NOW()+INTERVAL '1 year')::date,
          25, 25, 'in_stock')
       RETURNING id`,
      tenantId,
      inventoryItemId,
    );
    inventoryBatchId = Number(batchRows[0].id);

    const token = generateTestToken('ADMIN', {
      uid: ADMIN_UID,
      id: adminIntId,
      phone: '9000075757',
    });
    admin = authed(token);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_order_history WHERE order_id IN (
         SELECT id FROM pharmacy_orders WHERE phone = $1
       )`,
      PATIENT_PHONE,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_orders WHERE phone = $1`, PATIENT_PHONE).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_stock_movements WHERE inventory_item_id=$1::int`,
      inventoryItemId,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_inventory_batches WHERE inventory_item_id=$1::int`,
      inventoryItemId,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_inventory_items WHERE id=$1::int`,
      inventoryItemId,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_catalog WHERE id=$1::int`,
      catalogId,
    ).catch(() => {});
    await prisma.medications.deleteMany({ where: { name: MED_NAME } }).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
      ADMIN_UID,
      PATIENT_UID,
    ).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('mounts the documented pharmacy order list aliases', async () => {
    await seedCounterOrder('D57 list route contract');

    const canonical = await admin.get('/api/v1/pharmacy-orders/orders?limit=5');
    expect(canonical.statusCode).toBe(200);
    expect(Array.isArray(canonical.body.data)).toBe(true);

    const alias = await admin.get('/api/v1/pharmacy/orders?limit=5');
    expect(alias.statusCode).toBe(200);
    expect(Array.isArray(alias.body.data)).toBe(true);
  });

  it('dispenses through POST /pharmacy/dispense with body order_id', async () => {
    const orderId = await seedCounterOrder('D57 top-level dispense route');
    const commandKey = `d57-body-dispense-${orderId}`;
    const clinicalIntent = {
      dispensed_items: [{
        catalog_id: catalogId,
        inventory_item_id: inventoryItemId,
        name: MED_NAME,
        qty: 1,
      }],
      payment_mode: 'none',
    };

    // B1: pharmacist clinical verification gates dispensing.
    const verified = await admin
      .post(`/api/v1/pharmacy-orders/orders/${orderId}/verify`)
      .send({ decision: 'verified' });
    expect(verified.statusCode).toBe(200);

    const res = await admin
      .post('/api/v1/pharmacy/dispense')
      .set('Idempotency-Key', commandKey)
      .send({
        order_id: orderId,
        ...clinicalIntent,
      });
    const replay = await admin
      .post(`/api/v1/pharmacy-orders/orders/${orderId}/dispense`)
      .set('Idempotency-Key', commandKey)
      .send(clinicalIntent);
    const mismatch = await admin
      .post(`/api/v1/pharmacy-orders/orders/${orderId}/dispense-counter`)
      .set('Idempotency-Key', commandKey)
      .send({
        ...clinicalIntent,
        dispensed_items: [{ ...clinicalIntent.dispensed_items[0], qty: 2 }],
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.id).toBe(orderId);
    expect(res.body.data.status).toBe('DISPENSED');
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toEqual(res.body);
    expect(mismatch.statusCode).toBe(422);
    const batch = await prisma.$queryRawUnsafe(
      `SELECT remaining_quantity FROM pharmacy_inventory_batches WHERE id=$1::int`,
      inventoryBatchId,
    );
    expect(Number(batch[0].remaining_quantity)).toBe(24);
  });

  it('dispenses through POST /pharmacy-orders/orders/:id/dispense', async () => {
    const orderId = await seedCounterOrder('D57 order-scoped dispense route');

    // B1: pharmacist clinical verification gates dispensing.
    const verified = await admin
      .post(`/api/v1/pharmacy-orders/orders/${orderId}/verify`)
      .send({ decision: 'verified' });
    expect(verified.statusCode).toBe(200);

    const res = await admin
      .post(`/api/v1/pharmacy-orders/orders/${orderId}/dispense`)
      .set('Idempotency-Key', `d57-order-dispense-${orderId}`)
      .send({
        dispensed_items: [{
          catalog_id: catalogId,
          inventory_item_id: inventoryItemId,
          name: MED_NAME,
          qty: 1,
        }],
        payment_mode: 'none',
      });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.id).toBe(orderId);
    expect(res.body.data.status).toBe('DISPENSED');
  });

  it('keeps medication lookup static routes ahead of :id', async () => {
    const canonical = await admin.get('/api/v1/pharmacy-orders/medications/search?q=D57%20Route');
    expect(canonical.statusCode).toBe(200);
    expect(canonical.body.data.medications.map((m) => m.name)).toContain(MED_NAME);

    const alias = await admin.get('/api/v1/pharmacy/medications/search?q=D57%20Route');
    expect(alias.statusCode).toBe(200);
    expect(alias.body.data.medications.map((m) => m.name)).toContain(MED_NAME);
  });
});
