// Deep integration tests for the rich pharmacy lifecycle (pharmacyOrderController).
// Exercises: placeOrder (JSON, no file) → confirmOrder → markPreparing → dispatchOrder →
// markDelivered (+ cancelOrder branch + SLA dashboard + order queue + detail with history).
// Verifies: pharmacy_orders column writes, `*_at` timestamps, items_list jsonb round-trip,
// pharmacy_order_history trail, SLA target computation.

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const PATIENT_UID = 'a6666666-6666-4666-8666-666666666a01';
const PATIENT_PHONE = '+919000060001';
const PHARMACIST_UID = 'a6666666-6666-4666-8666-666666666a02';
const API_KEY = process.env.API_KEY || 'test-api-key';

// ADMIN bypasses identityValidator (validateUID/Phone), which is convenient for
// state-machine tests that don't want to re-litigate RBAC.
// Admin client bound to a real users row (needed because pharmacy_orders.confirmed_by,
// dispatched_by, pharmacy_order_history.changed_by are all int FKs to users(id)).
function adminAs(adminIntId, adminUid) {
  const token = generateTestToken('ADMIN', { uid: adminUid, id: adminIntId });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

const ADMIN_UID = 'a6666666-6666-4666-8666-666666666a03';

// Patient client used for IDOR + getMyOrders verification
function patientAs(patientDbId) {
  const token = generateTestToken('PATIENT', {
    uid: PATIENT_UID, id: patientDbId, phone: PATIENT_PHONE,
  });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

describe('Rich pharmacy lifecycle — deep integration', () => {
  let admin;
  let patientIntId;
  let pharmacistIntId;
  let adminIntId;
  let patient;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_order_history WHERE order_id IN (SELECT id FROM pharmacy_orders WHERE phone = $1)`,
      PATIENT_PHONE);
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_orders WHERE phone = $1`, PATIENT_PHONE);
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, PHARMACIST_UID, ADMIN_UID);

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Lifecycle Test Patient', 'PATIENT', true, NOW())
       RETURNING id`,
      PATIENT_UID, PATIENT_PHONE);
    patientIntId = p[0].id;

    const s = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000060002', 'Lifecycle Test Pharmacist', 'PHARMACY_STAFF', true, NOW())
       RETURNING id`,
      PHARMACIST_UID);
    pharmacistIntId = s[0].id;

    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000060003', 'Lifecycle Test Admin', 'ADMIN', true, NOW())
       RETURNING id`,
      ADMIN_UID);
    adminIntId = a[0].id;

    admin = adminAs(adminIntId, ADMIN_UID);
    patient = patientAs(patientIntId);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_order_history WHERE order_id IN (SELECT id FROM pharmacy_orders WHERE phone = $1)`,
      PATIENT_PHONE).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_orders WHERE phone = $1`, PATIENT_PHONE).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID, PHARMACIST_UID, ADMIN_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  describe('placeOrder (no file upload)', () => {
    it('rejects placement with neither file nor order_note', async () => {
      // Use admin token (bypasses validateUID) so we isolate the controller's own check
      const res = await admin.post('/api/v1/pharmacy-orders/orders/place').send({});
      expect(res.statusCode).toBe(400);
    });

    it('rejects unsupported prescription attachment as a client error', async () => {
      const res = await admin.post('/api/v1/pharmacy-orders/orders/place')
        .field('order_note', 'Attach wrong file type')
        .attach('prescription', Buffer.from('not a prescription image'), {
          filename: 'prescription.txt',
          contentType: 'text/plain',
        });

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual(expect.objectContaining({
        success: false,
        code: 'INVALID_PRESCRIPTION_ATTACHMENT',
      }));
      expect(res.body.message).toMatch(/Only images and PDFs are allowed/i);
    });
  });

  // For the full walk, we seed an order directly via DB (avoids multipart) and then
  // drive it through the lifecycle via HTTP. This is what the controller actually does
  // after placeOrder — the drift fixes we care about are in the status-transition handlers.
  describe('full lifecycle: PENDING → CONFIRMED → PREPARING → DISPATCHED → DELIVERED', () => {
    let orderId;
    let orderNumber;

    beforeAll(async () => {
      // Seed a PENDING order with the richer schema populated (delivery fields, etc.)
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO pharmacy_orders (
           phone, patient_id, patient_name, patient_phone, order_note,
           delivery_type, delivery_address, delivery_lat, delivery_lng, delivery_phone,
           status, prescribed_by, ordered_at, updated_at, sla_confirm_target
         ) VALUES ($1, $2, 'Lifecycle Test Patient', $1, 'Deliver paracetamol + cough syrup',
           'delivery', '42 Test Lane, Kottarakkara', 9.003, 76.781, $1,
           'PENDING', $3::uuid, NOW(), NOW(), NOW() + INTERVAL '30 minutes')
         RETURNING id, order_number`,
        PATIENT_PHONE, patientIntId, PATIENT_UID);
      orderId = rows[0].id;
      orderNumber = rows[0].order_number;

      // Matching PENDING history row (as placeOrder would have written)
      await prisma.$executeRawUnsafe(
        `INSERT INTO pharmacy_order_history (order_id, to_status, changed_by, changed_by_role, notes)
         VALUES ($1, 'PENDING', $2, 'patient', 'Order placed')`,
        orderId, patientIntId);
    });

    it('confirmOrder advances PENDING → CONFIRMED with items_list + total_amount', async () => {
      const items = [
        { sku: 'PARA500', name: 'Paracetamol 500mg', qty: 20, price: 2.5 },
        { sku: 'COUGH-SYRUP', name: 'Benadryl cough syrup', qty: 1, price: 120 },
      ];
      const res = await admin.post(`/api/v1/pharmacy-orders/orders/${orderId}/confirm`).send({
        confirmation_notes: 'All items in stock',
        items_list: items,
        total_amount: 170,
      });
      if (res.statusCode !== 200) process.stderr.write(`DBG confirm: ${res.statusCode} ${JSON.stringify(res.body)}\n`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('CONFIRMED');
      expect(Number(res.body.data.total_amount)).toBe(170);

      // DB-side verification: items_list stored as jsonb, confirmed_at populated,
      // sla_dispatch_target scheduled 30 min ahead.
      const row = await prisma.$queryRawUnsafe(
        `SELECT status, items_list, confirmation_notes, confirmed_at,
          sla_dispatch_target > NOW() AS sla_future
         FROM pharmacy_orders WHERE id = $1`, orderId);
      expect(row[0].status).toBe('CONFIRMED');
      expect(row[0].confirmation_notes).toBe('All items in stock');
      expect(row[0].confirmed_at).toBeTruthy();
      expect(row[0].sla_future).toBe(true);
      expect(Array.isArray(row[0].items_list)).toBe(true);
      expect(row[0].items_list.length).toBe(2);
      expect(row[0].items_list[0].sku).toBe('PARA500');
    });

    it('confirmOrder rejects items_list that is not an array', async () => {
      const res = await admin.post(`/api/v1/pharmacy-orders/orders/${orderId}/confirm`).send({
        items_list: 'not-an-array',
      });
      expect(res.statusCode).toBe(400);
    });

    it('confirmOrder blocks a second confirm (status no longer PENDING)', async () => {
      const res = await admin.post(`/api/v1/pharmacy-orders/orders/${orderId}/confirm`).send({
        items_list: [], total_amount: 99,
      });
      expect(res.statusCode).toBe(400);
    });

    it('markPreparing advances CONFIRMED → PREPARING and stamps preparing_at', async () => {
      const res = await admin.post(`/api/v1/pharmacy-orders/orders/${orderId}/preparing`).send({});
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('PREPARING');

      const row = await prisma.$queryRawUnsafe(
        `SELECT status, preparing_at FROM pharmacy_orders WHERE id = $1`, orderId);
      expect(row[0].status).toBe('PREPARING');
      expect(row[0].preparing_at).toBeTruthy();
    });

    it('markPreparing refuses to run from a non-CONFIRMED state', async () => {
      // Order is already PREPARING, so this should 400
      const res = await admin.post(`/api/v1/pharmacy-orders/orders/${orderId}/preparing`).send({});
      expect(res.statusCode).toBe(400);
    });

    it('dispatchOrder advances PREPARING → DISPATCHED with delivery contact + SLA', async () => {
      const res = await admin.post(`/api/v1/pharmacy-orders/orders/${orderId}/dispatch`).send({
        delivery_person: 'Ramesh Kumar',
        delivery_person_phone: '+919000060099',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('DISPATCHED');
      expect(res.body.data.delivery_person).toBe('Ramesh Kumar');

      const row = await prisma.$queryRawUnsafe(
        `SELECT status, dispatched_at, delivery_person, delivery_person_phone,
                delivery_tracking_active, sla_delivery_target > NOW() AS sla_future
         FROM pharmacy_orders WHERE id = $1`, orderId);
      expect(row[0].status).toBe('DISPATCHED');
      expect(row[0].dispatched_at).toBeTruthy();
      expect(row[0].delivery_person).toBe('Ramesh Kumar');
      expect(row[0].delivery_person_phone).toBe('+919000060099');
      expect(row[0].delivery_tracking_active).toBe(true);
      expect(row[0].sla_future).toBe(true);
    });

    it('markDelivered advances DISPATCHED → DELIVERED and clears tracking', async () => {
      const res = await admin.post(`/api/v1/pharmacy-orders/orders/${orderId}/delivered`).send({});
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('DELIVERED');

      const row = await prisma.$queryRawUnsafe(
        `SELECT status, delivered_at, delivery_tracking_active
         FROM pharmacy_orders WHERE id = $1`, orderId);
      expect(row[0].status).toBe('DELIVERED');
      expect(row[0].delivered_at).toBeTruthy();
      expect(row[0].delivery_tracking_active).toBe(false);
    });

    it('cancelOrder blocks cancellation after DELIVERED', async () => {
      const res = await admin.post(`/api/v1/pharmacy-orders/orders/${orderId}/cancel`).send({
        cancellation_reason: 'too late',
      });
      expect(res.statusCode).toBe(400);
    });

    it('getOrderDetail returns the full history trail in order', async () => {
      const res = await admin.get(`/api/v1/pharmacy-orders/orders/${orderId}/detail`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.order.id).toBe(orderId);
      expect(res.body.data.order.status).toBe('DELIVERED');
      expect(res.body.data.order.order_number).toBe(orderNumber);

      const history = res.body.data.history;
      expect(history.length).toBeGreaterThanOrEqual(4);
      // Expected transitions: placed(PENDING) → CONFIRMED → PREPARING → DISPATCHED → DELIVERED
      const transitions = history.map((h) => `${h.from_status || 'NEW'}->${h.to_status}`);
      expect(transitions).toEqual(expect.arrayContaining([
        'NEW->PENDING',
        'PENDING->CONFIRMED',
        'CONFIRMED->PREPARING',
        'PREPARING->DISPATCHED',
        'DISPATCHED->DELIVERED',
      ]));
    });
  });

  describe('cancelOrder branch', () => {
    let orderId;

    beforeAll(async () => {
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO pharmacy_orders (
           phone, patient_id, patient_name, patient_phone, order_note,
           delivery_type, status, prescribed_by, ordered_at, updated_at
         ) VALUES ($1, $2, 'Lifecycle Test Patient', $1, 'Cancel flow test',
           'delivery', 'PENDING', $3::uuid, NOW(), NOW())
         RETURNING id`,
        PATIENT_PHONE, patientIntId, PATIENT_UID);
      orderId = rows[0].id;
    });

    it('cancels a PENDING order and records the reason', async () => {
      const res = await admin.post(`/api/v1/pharmacy-orders/orders/${orderId}/cancel`).send({
        cancellation_reason: 'Patient requested cancellation',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.status).toBe('CANCELLED');
      expect(res.body.data.cancellation_reason).toBe('Patient requested cancellation');

      const hist = await prisma.$queryRawUnsafe(
        `SELECT from_status, to_status, notes FROM pharmacy_order_history
         WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, orderId);
      expect(hist[0].from_status).toBe('PENDING');
      expect(hist[0].to_status).toBe('CANCELLED');
      expect(hist[0].notes).toBe('Patient requested cancellation');
    });

    it('blocks further cancel attempts from terminal CANCELLED state', async () => {
      const res = await admin.post(`/api/v1/pharmacy-orders/orders/${orderId}/cancel`).send({});
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 for an unknown order id', async () => {
      const res = await admin.post(`/api/v1/pharmacy-orders/orders/99999999/cancel`).send({});
      expect(res.statusCode).toBe(404);
    });
  });

  describe('getOrderQueue + SLA dashboard', () => {
    it('returns the orders ordered by status rank then creation time', async () => {
      const res = await admin.get('/api/v1/pharmacy-orders/orders/queue');
      expect(res.statusCode).toBe(200);
      const arr = res.body.data;
      expect(Array.isArray(arr)).toBe(true);
      // Our fixtures show up somewhere in the queue. Filter for them.
      const ours = arr.filter((o) => o.patient_id === patientIntId);
      expect(ours.length).toBeGreaterThanOrEqual(2);
      // Each entry has the enriched fields the controller computes.
      for (const o of ours) {
        expect(typeof o.mins_since_placed === 'number' || typeof o.mins_since_placed === 'string').toBe(true);
        expect(['boolean']).toContain(typeof o.sla_breached);
      }
    });

    it('filters the queue by status', async () => {
      const res = await admin.get('/api/v1/pharmacy-orders/orders/queue?status=DELIVERED');
      expect(res.statusCode).toBe(200);
      for (const o of res.body.data) {
        expect(o.status).toBe('DELIVERED');
      }
    });

    it('SLA dashboard returns aggregate counts + revenue + avg-times blocks', async () => {
      // Use Postgres's `current_date` so the date matches what the rows were
      // stamped with (NOW() in server timezone). JS UTC drifts at midnight IST.
      const dateRows = await prisma.$queryRawUnsafe(`SELECT current_date::text AS today`);
      const today = dateRows[0].today;
      const res = await admin.get(`/api/v1/pharmacy-orders/orders/sla?from_date=${today}&to_date=${today}`);
      expect(res.statusCode).toBe(200);
      const d = res.body.data;
      expect(d.summary).toBeDefined();
      expect(d.summary.total).toBeGreaterThanOrEqual(2);
      expect(d.summary.delivered).toBeGreaterThanOrEqual(1);
      expect(d.summary.cancelled).toBeGreaterThanOrEqual(1);
      expect(d.avg_times).toBeDefined();
      expect(typeof d.sla_breaches).toBe('number');
      expect(d.date_range).toEqual({ from: today, to: today });
    });
  });
});
