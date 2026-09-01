// Deep integration tests for the canonical ORDER_STATUS lifecycle config and
// for the retirement of the two legacy pharmacy-order surfaces.
//
// WHAT MOVED. This train retired the legacy phone-based orderService HTTP
// surface entirely:
//   • POST /api/v1/pharmacy-orders/orders (legacy create, resolved its target
//     purely from body.phone) — replaced by POST /orders/place, which is
//     patient-scoped and runs the facility-bound Inventory V2 lifecycle.
//   • PUT  /api/v1/pharmacy-orders/orders/:orderId/status (generic status
//     mutation, any target the transition table allowed) — replaced by the
//     action-specific transition endpoints POST /orders/:id/{confirm,verify,
//     preparing,dispatch,dispense,unavailable,cancel} plus the exact-mount
//     delivery-custody surfaces (POST /orders/:id/delivered and the
//     delivery-return pair).
// Both bypassed the verified, facility-bound lifecycle, which is the whole
// point of retiring them — so the replacement transition endpoints are
// exercised end-to-end in pharmacy-lifecycle-deep.test.js, and what this suite
// pins is that the bypasses are GONE and cannot mutate a real order row.

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { ORDER_STATUS, ORDER_STATUS_TRANSITIONS } from '../config/pharmacyConfig.js';

const PATIENT_UID = 'a4444444-4444-4444-8444-444444444a01';
const PATIENT_PHONE = '+919000040001'; // normalizePhone() adds +91 prefix
const PHARMACIST_UID = 'a4444444-4444-4444-8444-444444444a02';
const FIXTURE_FACILITY_CODE = 'PHARM-DEEP-RETIRED-SURFACE';
const API_KEY = process.env.API_KEY || 'test-api-key';

function pharmacistAs(uid = PHARMACIST_UID) {
  const token = generateTestToken('PHARMACY_STAFF', { uid, id: 990401 });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

function adminAs() {
  // Use the default test-harness uid from testClient.js (seeded by
  // migration 082) — never override it to
  // `00000000-0000-4000-8000-000000000001`, which is the DEFAULT_TENANT_ID
  // rather than a real users row.
  const token = generateTestToken('ADMIN');
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

describe('Pharmacy order lifecycle — deep integration', () => {
  const pharm = pharmacistAs();
  const admin = adminAs();
  let patientIntId;
  let fixtureTenantId;
  let fixtureFacilityId;

  async function countFixtureOrders() {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM pharmacy_orders WHERE phone = $1`, PATIENT_PHONE);
    return rows[0].n;
  }

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
       RETURNING id, tenant_id`,
      PATIENT_UID, PATIENT_PHONE);
    patientIntId = p[0].id;
    // Read the tenant back off the row rather than assuming the platform
    // default: every fixture row below must land in the SAME tenant, because
    // migration 753 bound pharmacy_orders to its patient AND its facility with
    // COMPOSITE (tenant_id, id) foreign keys.
    fixtureTenantId = p[0].tenant_id;

    // A facility for the PENDING fixture order to point at. Migration 753's
    // chk_pharmacy_orders_facility_progression_753 is
    //   facility_id IS NOT NULL
    //   OR status IN ('CANCELLED','DELIVERED','DISPENSED','UNAVAILABLE')
    // so a non-terminal order with a NULL facility_id is not a row production
    // can hold — a PENDING fixture must name a real facility. Non-default
    // (`is_default=FALSE`) so it never collides with `uq_facility_default`,
    // which is a partial UNIQUE on (tenant_id) WHERE is_default = true.
    const f = await prisma.$queryRawUnsafe(
      `INSERT INTO facilities (tenant_id, facility_code, display_name, status, is_default)
       VALUES ($1::uuid, $2, 'Pharmacy Deep Retired-Surface Facility', 'active', FALSE)
       ON CONFLICT (tenant_id, facility_code)
         DO UPDATE SET status = 'active', updated_at = NOW()
       RETURNING id`,
      fixtureTenantId, FIXTURE_FACILITY_CODE);
    fixtureFacilityId = Number(f[0].id);

    await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000040002', 'Pharmacy Test Pharmacist', 'PHARMACY_STAFF', true, NOW())
       RETURNING id`,
      PHARMACIST_UID);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM pharmacy_order_history WHERE order_id IN (SELECT id FROM pharmacy_orders WHERE phone = $1)`,
      PATIENT_PHONE).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM pharmacy_orders WHERE phone = $1`, PATIENT_PHONE).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, PHARMACIST_UID).catch(() => {});
    // After the orders, never before: fk_pharmacy_orders_facility_tenant_753
    // is ON DELETE RESTRICT. Keyed on this suite's own facility_code so a
    // pre-existing tenant facility is never touched.
    if (fixtureTenantId) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM facilities WHERE tenant_id = $1::uuid AND facility_code = $2`,
        fixtureTenantId, FIXTURE_FACILITY_CODE).catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
  });

  describe('canonical status lifecycle config', () => {
    it('exposes the canonical UPPERCASE statuses', () => {
      expect(Object.values(ORDER_STATUS).sort()).toEqual([
        'CANCELLED', 'CONFIRMED', 'DELIVERED', 'DISPATCHED', 'DISPENSED',
        'PARTIALLY_DISPENSED', 'PENDING', 'PREPARING', 'READY', 'UNAVAILABLE',
      ]);
    });

    it('keys every status to itself (no lowercase drift)', () => {
      for (const [key, value] of Object.entries(ORDER_STATUS)) {
        expect(value).toBe(key);
      }
    });

    it('pins the transition table exactly', () => {
      expect(ORDER_STATUS_TRANSITIONS).toEqual({
        PENDING: ['CONFIRMED', 'PARTIALLY_DISPENSED', 'DISPENSED', 'UNAVAILABLE', 'CANCELLED'],
        CONFIRMED: ['PREPARING', 'DISPATCHED', 'PARTIALLY_DISPENSED', 'DISPENSED', 'UNAVAILABLE', 'CANCELLED'],
        PREPARING: ['READY', 'DISPATCHED', 'UNAVAILABLE', 'CANCELLED'],
        READY: ['DISPATCHED', 'UNAVAILABLE', 'CANCELLED'],
        DISPATCHED: ['DELIVERED', 'UNAVAILABLE', 'CANCELLED'],
        PARTIALLY_DISPENSED: ['DISPENSED', 'UNAVAILABLE', 'CANCELLED'],
        DISPENSED: [],
        DELIVERED: [],
        UNAVAILABLE: [],
        CANCELLED: [],
      });
    });

    it('gives every status a transition entry whose targets are all known statuses', () => {
      const statuses = Object.values(ORDER_STATUS);
      expect(Object.keys(ORDER_STATUS_TRANSITIONS).sort()).toEqual([...statuses].sort());
      for (const targets of Object.values(ORDER_STATUS_TRANSITIONS)) {
        for (const target of targets) {
          expect(statuses).toContain(target);
        }
      }
    });

    it('defines the four terminal states', () => {
      const terminal = Object.entries(ORDER_STATUS_TRANSITIONS)
        .filter(([, targets]) => targets.length === 0)
        .map(([status]) => status)
        .sort();
      expect(terminal).toEqual(['CANCELLED', 'DELIVERED', 'DISPENSED', 'UNAVAILABLE']);
    });

    it('reaches DELIVERED only from DISPATCHED', () => {
      const sources = Object.entries(ORDER_STATUS_TRANSITIONS)
        .filter(([, targets]) => targets.includes(ORDER_STATUS.DELIVERED))
        .map(([status]) => status);
      expect(sources).toEqual([ORDER_STATUS.DISPATCHED]);
    });
  });

  describe('retired legacy surfaces', () => {
    let orderId;

    beforeAll(async () => {
      // Seed a PENDING order directly: the legacy HTTP create that used to
      // build this fixture is one of the surfaces under test here.
      //
      // facility_id is mandatory for a non-terminal status under migration
      // 753's chk_pharmacy_orders_facility_progression_753, and PENDING is
      // exactly the state these cases need to observe as UNCHANGED after the
      // retired PUT /status is refused — so the fixture carries the suite's
      // own facility rather than weakening the case to a terminal status.
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO pharmacy_orders (
           tenant_id, phone, patient_id, patient_name, patient_phone, order_note,
           status, facility_id, prescribed_by, ordered_at, updated_at
         ) VALUES ($4::uuid, $1, $2::int, 'Pharmacy Test Patient', $1, 'Retired-surface fixture order',
           'PENDING', $5::int, $3::uuid, NOW(), NOW())
         RETURNING id, facility_id, status`,
        PATIENT_PHONE, patientIntId, PATIENT_UID, fixtureTenantId, fixtureFacilityId);
      orderId = rows[0].id;
      // The fixture must actually be the row the cases claim to guard.
      expect(rows[0].status).toBe(ORDER_STATUS.PENDING);
      expect(Number(rows[0].facility_id)).toBe(fixtureFacilityId);
    });

    it('POST /api/v1/pharmacy-orders/orders is gone and creates nothing', async () => {
      const before = await countFixtureOrders();
      const res = await admin.post('/api/v1/pharmacy-orders/orders').send({
        phone: PATIENT_PHONE,
        order_note: 'Please prepare amoxicillin 500mg, 10 tabs',
      });
      expect(res.statusCode).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
      expect(await countFixtureOrders()).toBe(before);
    });

    it('PUT /api/v1/pharmacy-orders/orders/:id/status is gone and mutates nothing', async () => {
      const res = await admin.put(`/api/v1/pharmacy-orders/orders/${orderId}/status`).send({
        status: ORDER_STATUS.CONFIRMED,
        notes: 'In-stock, ready to prep',
      });
      expect(res.statusCode).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');

      const row = await prisma.$queryRawUnsafe(
        `SELECT status FROM pharmacy_orders WHERE id = $1`, orderId);
      expect(row[0].status).toBe(ORDER_STATUS.PENDING);
    });

    it('the retired status mutation cannot jump an order straight to DELIVERED', async () => {
      const res = await admin.put(`/api/v1/pharmacy-orders/orders/${orderId}/status`).send({
        status: ORDER_STATUS.DELIVERED,
      });
      expect(res.statusCode).toBe(404);

      const row = await prisma.$queryRawUnsafe(
        `SELECT status FROM pharmacy_orders WHERE id = $1`, orderId);
      expect(row[0].status).toBe(ORDER_STATUS.PENDING);

      // No history row was written either — the surface never ran.
      const hist = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM pharmacy_order_history WHERE order_id = $1`, orderId);
      expect(hist[0].n).toBe(0);
    });

    it('is retired for pharmacy staff too — the removal is route-level, not role-shaped', async () => {
      const res = await pharm.put(`/api/v1/pharmacy-orders/orders/${orderId}/status`).send({
        status: ORDER_STATUS.CONFIRMED,
      });
      expect(res.statusCode).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('is retired on the /api/v1/pharmacy alias mount as well', async () => {
      const created = await admin.post('/api/v1/pharmacy/orders').send({
        phone: PATIENT_PHONE,
        order_note: 'Alias-mount legacy create',
      });
      expect(created.statusCode).toBe(404);

      const mutated = await admin.put(`/api/v1/pharmacy/orders/${orderId}/status`).send({
        status: ORDER_STATUS.CONFIRMED,
      });
      expect(mutated.statusCode).toBe(404);
    });
  });

  // getOrdersByPhone (GET /orders/:phone) was removed — phone-in-URL PHI, no
  // live caller. Patient order lookup is GET /orders/my + GET /orders/uid/:uid.
});
