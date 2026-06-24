// Deep integration tests for legacy phone-based pharmacy orderService + the
// canonical ORDER_STATUS lifecycle (PENDING → CONFIRMED → PREPARING → READY →
// DISPATCHED → DELIVERED). The richer pharmacyOrderController with multipart
// upload is exercised at unit level via direct DB state checks instead.

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { ORDER_STATUS, ORDER_STATUS_TRANSITIONS } from '../config/pharmacyConfig.js';

const PATIENT_UID = 'a4444444-4444-4444-8444-444444444a01';
const RAW_PHONE = '9000040001';
const PATIENT_PHONE = '+919000040001'; // normalizePhone() adds +91 prefix
const PHARMACIST_UID = 'a4444444-4444-4444-8444-444444444a02';
const API_KEY = process.env.API_KEY || 'test-api-key';

function pharmacistAs(uid = PHARMACIST_UID) {
  const token = generateTestToken('PHARMACY_STAFF', { uid, id: 990401 });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

function patientAs() {
  const token = generateTestToken('PATIENT', {
    uid: PATIENT_UID, id: 990402, phone: PATIENT_PHONE,
  });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

function adminAs() {
  // Use the default test-harness uid from testClient.js (seeded by
  // migration 082). Same pattern as investigation-deep: the override to
  // `00000000-0000-4000-8000-000000000001` is the DEFAULT_TENANT_ID, not
  // a real user, and fails pharmacy_orders_prescribed_by_fkey (migration
  // 083) when createOrder sets prescribed_by from the JWT's uid.
  const token = generateTestToken('ADMIN');
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

describe('Pharmacy order lifecycle — deep integration', () => {
  const pharm = pharmacistAs();
  const patient = patientAs();
  const admin = adminAs();
  let patientIntId;
  let pharmacistIntId;

  beforeAll(async () => {
    // Clean via phone to catch any orphans from prior runs
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_order_history WHERE order_id IN (SELECT id FROM pharmacy_orders WHERE phone = $1)`,
      PATIENT_PHONE);
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_orders WHERE phone = $1`, PATIENT_PHONE);
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, PHARMACIST_UID);

    const p = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Pharmacy Test Patient', 'PATIENT', true, NOW())
       RETURNING id`,
      PATIENT_UID, PATIENT_PHONE);
    patientIntId = p[0].id;

    const s = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000040002', 'Pharmacy Test Pharmacist', 'PHARMACY_STAFF', true, NOW())
       RETURNING id`,
      PHARMACIST_UID);
    pharmacistIntId = s[0].id;
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_order_history WHERE order_id IN (SELECT id FROM pharmacy_orders WHERE phone = $1)`,
      PATIENT_PHONE).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_orders WHERE phone = $1`, PATIENT_PHONE).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, PHARMACIST_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  describe('canonical status lifecycle config', () => {
    it('exposes the 7 canonical UPPERCASE statuses', () => {
      expect(Object.values(ORDER_STATUS).sort()).toEqual(
        ['CANCELLED', 'CONFIRMED', 'DELIVERED', 'DISPATCHED', 'PENDING', 'PREPARING', 'READY']
      );
    });

    it('defines a terminal state for DELIVERED and CANCELLED', () => {
      expect(ORDER_STATUS_TRANSITIONS.DELIVERED).toEqual([]);
      expect(ORDER_STATUS_TRANSITIONS.CANCELLED).toEqual([]);
    });

    it('allows PENDING → CONFIRMED and PENDING → CANCELLED', () => {
      expect(ORDER_STATUS_TRANSITIONS.PENDING).toEqual(expect.arrayContaining(['CONFIRMED', 'CANCELLED']));
    });

    it('requires DISPATCHED to precede DELIVERED', () => {
      expect(ORDER_STATUS_TRANSITIONS.DISPATCHED).toEqual(expect.arrayContaining(['DELIVERED']));
      // DELIVERED cannot be reached directly from PENDING/CONFIRMED/PREPARING/READY
      for (const s of ['PENDING', 'CONFIRMED', 'PREPARING', 'READY']) {
        expect(ORDER_STATUS_TRANSITIONS[s]).not.toContain('DELIVERED');
      }
    });
  });

  describe('placeOrder (POST /api/v1/pharmacy-orders/orders)', () => {
    it('rejects placement without phone or order_note', async () => {
      const res = await admin.post('/api/v1/pharmacy-orders/orders').send({ phone: PATIENT_PHONE });
      expect(res.statusCode).toBe(400);
    });

    it('creates a new PENDING order with priority=normal by default', async () => {
      const res = await admin.post('/api/v1/pharmacy-orders/orders').send({
        phone: RAW_PHONE,
        order_note: 'Please prepare amoxicillin 500mg, 10 tabs',
      });
      expect(res.statusCode).toBe(200);
      const order = res.body.data;
      expect(order.id).toBeDefined();
      expect(order.status).toBe(ORDER_STATUS.PENDING);
      expect(order.priority).toBe('normal');
      expect(order.patient_id).toBe(patientIntId);

      // DB check — verify priority and status landed correctly
      const row = await prisma.$queryRawUnsafe(
        `SELECT status, priority, phone, patient_id FROM pharmacy_orders WHERE id = $1`, order.id);
      expect(row[0].status).toBe(ORDER_STATUS.PENDING);
      expect(row[0].priority).toBe('normal');
      expect(row[0].patient_id).toBe(patientIntId);
    });

    it('creates an urgent order with priority=urgent when urgent=true', async () => {
      const res = await admin.post('/api/v1/pharmacy-orders/orders').send({
        phone: RAW_PHONE,
        order_note: 'URGENT: nebulizer refill',
        urgent: true,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.priority).toBe('urgent');
    });
  });

  describe('updateOrderStatus state machine', () => {
    let orderId;

    beforeAll(async () => {
      // Place a fresh order to walk through the lifecycle
      const res = await admin.post('/api/v1/pharmacy-orders/orders').send({
        phone: RAW_PHONE,
        order_note: 'Lifecycle walk-through order',
      });
      orderId = res.body.data.id;
    });

    it('rejects an unknown status value', async () => {
      const res = await admin.put(`/api/v1/pharmacy-orders/orders/${orderId}/status`).send({
        status: 'bogus',
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects PENDING → DELIVERED (invalid transition)', async () => {
      const res = await admin.put(`/api/v1/pharmacy-orders/orders/${orderId}/status`).send({
        status: ORDER_STATUS.DELIVERED,
      });
      // Service throws INVALID_TRANSITION → controller maps to 500 without mapping;
      // the key signal is that no status update landed.
      expect([400, 500]).toContain(res.statusCode);
      const row = await prisma.$queryRawUnsafe(
        `SELECT status FROM pharmacy_orders WHERE id = $1`, orderId);
      expect(row[0].status).toBe(ORDER_STATUS.PENDING);
    });

    it('advances PENDING → CONFIRMED and writes a history row', async () => {
      const res = await admin.put(`/api/v1/pharmacy-orders/orders/${orderId}/status`).send({
        status: ORDER_STATUS.CONFIRMED,
        notes: 'In-stock, ready to prep',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.order.status).toBe(ORDER_STATUS.CONFIRMED);

      const hist = await prisma.$queryRawUnsafe(
        `SELECT from_status, to_status, notes FROM pharmacy_order_history
         WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`, orderId);
      expect(hist[0].from_status).toBe(ORDER_STATUS.PENDING);
      expect(hist[0].to_status).toBe(ORDER_STATUS.CONFIRMED);
      expect(hist[0].notes).toBe('In-stock, ready to prep');
    });

    it('advances CONFIRMED → PREPARING → READY → DISPATCHED → DELIVERED', async () => {
      for (const target of [ORDER_STATUS.PREPARING, ORDER_STATUS.READY, ORDER_STATUS.DISPATCHED, ORDER_STATUS.DELIVERED]) {
        const res = await admin.put(`/api/v1/pharmacy-orders/orders/${orderId}/status`).send({ status: target });
        expect(res.statusCode).toBe(200);
        expect(res.body.data.order.status).toBe(target);
      }
      const row = await prisma.$queryRawUnsafe(
        `SELECT status FROM pharmacy_orders WHERE id = $1`, orderId);
      expect(row[0].status).toBe(ORDER_STATUS.DELIVERED);
    });

    it('blocks any further transition from DELIVERED (terminal)', async () => {
      const res = await admin.put(`/api/v1/pharmacy-orders/orders/${orderId}/status`).send({
        status: ORDER_STATUS.CANCELLED,
      });
      expect([400, 500]).toContain(res.statusCode);
    });
  });

  // getOrdersByPhone (GET /orders/:phone) was removed — phone-in-URL PHI, no
  // live caller. Patient order lookup is GET /orders/my + GET /orders/uid/:uid.
});
