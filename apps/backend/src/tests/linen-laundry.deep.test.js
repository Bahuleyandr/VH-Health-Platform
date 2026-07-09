import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const STAMP = `${Date.now()}${Math.floor(Math.random() * 1_000_000)}`;
const ADMIN_UID = '11111111-2222-4333-8444-000000474001';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

function authed(role, uid, id) {
  const token = generateTestToken(role, { uid, id, tenant_id: TENANT_ID });
  return {
    get: path => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: path => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: path => request(app).put(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

describe('linen/laundry par stock and cycle reconciliation', () => {
  let adminId;
  let wardId;
  let itemTypeId;
  let cycleId;

  beforeAll(async () => {
    const users = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, tenant_id, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Linen Admin', 'ADMIN', $3::uuid, true, NOW())
       ON CONFLICT (uid) DO UPDATE
         SET tenant_id = EXCLUDED.tenant_id,
             role = EXCLUDED.role,
             is_active = TRUE,
             updated_at = NOW()
       RETURNING id`,
      ADMIN_UID,
      `97${STAMP.slice(-8)}`,
      TENANT_ID,
    );
    adminId = users[0].id;

    const wards = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, total_beds, created_at, updated_at)
       VALUES ($1, 3, 24, NOW(), NOW())
       RETURNING id`,
      `Linen Ward ${STAMP}`,
    );
    wardId = wards[0].id;
  });

  afterAll(async () => {
    if (cycleId) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM linen_laundry_cycles WHERE id = $1::bigint AND tenant_id = $2::uuid`,
        cycleId,
        TENANT_ID,
      ).catch(() => {});
    }
    if (itemTypeId) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM linen_ward_par_levels WHERE item_type_id = $1::bigint AND tenant_id = $2::uuid`,
        itemTypeId,
        TENANT_ID,
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM linen_item_types WHERE id = $1::bigint AND tenant_id = $2::uuid`,
        itemTypeId,
        TENANT_ID,
      ).catch(() => {});
    }
    if (wardId) {
      await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE id = $1::int`, wardId).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, ADMIN_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('runs collection to laundry to return, flags discrepancy, and updates par math', async () => {
    const admin = authed('ADMIN', ADMIN_UID, adminId);

    const item = await admin.post('/api/v1/linen-laundry/item-types').send({
      item_code: `SHEET-${STAMP.slice(-6)}`,
      display_name: 'Bed Sheet',
      category: 'bed_linen',
      unit: 'piece',
    });
    expect(item.statusCode).toBe(201);
    itemTypeId = item.body.data.id;

    const par = await admin.put('/api/v1/linen-laundry/par-levels').send({
      ward_id: wardId,
      item_type_id: itemTypeId,
      par_quantity: 20,
      actual_quantity: 20,
      reorder_threshold: 4,
    });
    expect(par.statusCode).toBe(200);
    expect(par.body.data).toMatchObject({
      ward_id: wardId,
      item_type_id: itemTypeId,
      par_quantity: 20,
      actual_quantity: 20,
    });

    const created = await admin.post('/api/v1/linen-laundry/cycles').send({
      ward_id: wardId,
      items: [{ item_type_id: itemTypeId, soiled_planned_quantity: 10 }],
      notes: 'Morning ward linen collection',
    });
    expect(created.statusCode).toBe(201);
    cycleId = created.body.data.id;
    expect(created.body.data.status).toBe('collection_requested');

    const collected = await admin.post(`/api/v1/linen-laundry/cycles/${cycleId}/collect`).send({
      items: [{ item_type_id: itemTypeId, soiled_collected_quantity: 10 }],
    });
    expect(collected.statusCode).toBe(200);
    expect(collected.body.data.status).toBe('collected');

    const sent = await admin.post(`/api/v1/linen-laundry/cycles/${cycleId}/laundry`).send({});
    expect(sent.statusCode).toBe(200);
    expect(sent.body.data.status).toBe('in_laundry');

    const returned = await admin.post(`/api/v1/linen-laundry/cycles/${cycleId}/return`).send({
      items: [{
        item_type_id: itemTypeId,
        soiled_collected_quantity: 10,
        clean_returned_quantity: 8,
        damaged_quantity: 1,
      }],
    });
    expect(returned.statusCode).toBe(200);
    expect(returned.body.data).toMatchObject({
      status: 'returned',
      discrepancy_flag: true,
    });
    expect(returned.body.data.items[0]).toMatchObject({
      missing_quantity: 1,
      discrepancy_quantity: -1,
      discrepancy_flag: true,
    });

    const reconciled = await admin.post(`/api/v1/linen-laundry/cycles/${cycleId}/reconcile`).send({});
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.body.data.status).toBe('reconciled');

    const board = await admin.get(`/api/v1/linen-laundry/board?ward_id=${wardId}`);
    expect(board.statusCode).toBe(200);
    const stock = board.body.data.par_levels.find(row => row.item_type_id === itemTypeId);
    expect(stock).toMatchObject({
      par_quantity: 20,
      actual_quantity: 18,
      par_delta: -2,
      below_par: true,
    });
    expect(board.body.data.summary).toMatchObject({
      below_par_count: 1,
      shortage_quantity: 2,
      discrepancy_cycle_count: 1,
    });
  });
});
