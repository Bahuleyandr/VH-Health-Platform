// Deep integration tests for ward + bed CRUD and admit/discharge.
// Isolated from admissionService (which uses its own `bed_transfers` path) — this
// suite exercises the simpler `bedService` that backs `/api/v1/beds` + `/api/v1/wards`
// and verifies column-accurate RETURNING + real-world DELETE counts.

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const API_KEY = process.env.API_KEY || 'test-api-key';

function adminAs() {
  const token = generateTestToken('ADMIN', {
    uid: 'a8888888-8888-4888-8888-888888888a01',
    id: 990800,
  });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    delete: (p) => request(app).delete(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

describe('Bed + ward management — deep integration', () => {
  const admin = adminAs();
  const WARD_NAME = 'BED-DEEP-WARD';
  let wardId;

  beforeAll(async () => {
    // Clean any fixtures from prior runs (in FK-safe order)
    await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number LIKE 'BD-DEEP-%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name = $1`, WARD_NAME);
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number LIKE 'BD-DEEP-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name = $1`, WARD_NAME).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  describe('wards', () => {
    it('creates a ward and returns real ward columns', async () => {
      const res = await admin.post('/api/v1/wards').send({
        name: WARD_NAME, floor: 2, total_beds: 4,
      });
      expect(res.statusCode).toBe(201);
      const w = res.body.data.ward;
      expect(w.id).toBeDefined();
      expect(w.name).toBe(WARD_NAME);
      expect(w.floor).toBe(2);
      expect(w.total_beds).toBe(4);
      wardId = w.id;
    });

    it('lists wards and includes bed counts', async () => {
      const res = await admin.get('/api/v1/wards');
      expect(res.statusCode).toBe(200);
      const ours = res.body.data.wards.find((w) => w.id === wardId);
      expect(ours).toBeDefined();
      // Aggregates are numeric; allow bigint-as-string OR int
      expect(Number(ours.bed_count)).toBe(0);
      expect(Number(ours.occupied_count)).toBe(0);
    });

    it('updates a ward and persists the new fields', async () => {
      const res = await admin.put(`/api/v1/wards/${wardId}`).send({
        floor: 3, total_beds: 6,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.ward.floor).toBe(3);
      expect(res.body.data.ward.total_beds).toBe(6);
    });

    it('returns 404 for updating a nonexistent ward', async () => {
      const res = await admin.put('/api/v1/wards/99999999').send({ name: 'Ghost' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('beds', () => {
    let bedId;

    it('rejects bed creation without ward_id', async () => {
      const res = await admin.post('/api/v1/beds').send({ bed_number: 'BD-DEEP-X' });
      expect(res.statusCode).toBe(400);
    });

    it('creates a bed with real bed columns returned', async () => {
      const res = await admin.post('/api/v1/beds').send({
        ward_id: wardId, bed_number: 'BD-DEEP-001',
      });
      expect(res.statusCode).toBe(201);
      const b = res.body.data.bed;
      expect(b.id).toBeDefined();
      expect(b.bed_number).toBe('BD-DEEP-001');
      expect(b.ward_id).toBe(wardId);
      expect(b.status).toBe('available'); // default
      expect(b.patient_id).toBeNull();
      bedId = b.id;
    });

    it('lists beds including ours with ward_name joined', async () => {
      const res = await admin.get('/api/v1/beds');
      expect(res.statusCode).toBe(200);
      const ours = res.body.data.beds.find((b) => b.id === bedId);
      expect(ours).toBeDefined();
      expect(ours.ward_name).toBe(WARD_NAME);
    });

    it('returns beds for the ward via /beds/ward/:wardId', async () => {
      const res = await admin.get(`/api/v1/beds/ward/${wardId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.beds.length).toBeGreaterThanOrEqual(1);
      for (const b of res.body.data.beds) {
        expect(b.ward_id).toBe(wardId);
      }
    });

    it('updates a bed and flips status to maintenance', async () => {
      const res = await admin.put(`/api/v1/beds/${bedId}`).send({
        status: 'maintenance', notes: 'Under repair',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.bed.status).toBe('maintenance');
      expect(res.body.data.bed.notes).toBe('Under repair');
    });

    it('returns a bed summary keyed by ward', async () => {
      const res = await admin.get('/api/v1/beds/summary');
      expect(res.statusCode).toBe(200);
      const ours = res.body.data.summary.find((s) => s.ward_id === wardId);
      expect(ours).toBeDefined();
      expect(ours.ward_name).toBe(WARD_NAME);
      expect(ours.actual_beds).toBe(1);
      expect(ours.maintenance).toBe(1);
      expect(ours.available).toBe(0);
    });
  });

  describe('admit + discharge flow (simple bedService path)', () => {
    let admitBedId;

    beforeAll(async () => {
      const res = await admin.post('/api/v1/beds').send({
        ward_id: wardId, bed_number: 'BD-DEEP-ADMIT',
      });
      admitBedId = res.body.data.bed.id;
    });

    it('rejects admission without patient_name', async () => {
      const res = await admin.post(`/api/v1/beds/${admitBedId}/admit`).send({});
      expect(res.statusCode).toBe(400);
    });

    it('admits a patient, flips status to occupied with admitted_at stamped', async () => {
      const res = await admin.post(`/api/v1/beds/${admitBedId}/admit`).send({
        patient_name: 'John Doe', notes: 'Fever',
      });
      expect(res.statusCode).toBe(200);
      const b = res.body.data.bed;
      expect(b.status).toBe('occupied');
      expect(b.patient_name).toBe('John Doe');
      expect(b.admitted_at).toBeTruthy();
      expect(b.assigned_at).toBeTruthy();
    });

    it('refuses to admit an already-occupied bed', async () => {
      const res = await admin.post(`/api/v1/beds/${admitBedId}/admit`).send({
        patient_name: 'Jane Doe',
      });
      expect(res.statusCode).toBe(400);
    });

    it('discharges the patient and sets bed to cleaning', async () => {
      const res = await admin.post(`/api/v1/beds/${admitBedId}/discharge`);
      expect(res.statusCode).toBe(200);
      const b = res.body.data.bed;
      // bedManagementRoutes now handles discharge: status goes to 'cleaning'
      // (not directly to 'available') so housekeeping can complete the cycle.
      expect(b.status).toBe('cleaning');
      expect(b.patient_uid).toBeNull();
    });

    it('refuses to discharge a non-occupied bed', async () => {
      const res = await admin.post(`/api/v1/beds/${admitBedId}/discharge`);
      expect(res.statusCode).toBe(400);
    });
  });

  describe('cleanup / delete counts', () => {
    let toDeleteId;

    beforeAll(async () => {
      const res = await admin.post('/api/v1/beds').send({
        ward_id: wardId, bed_number: 'BD-DEEP-DELETE',
      });
      toDeleteId = res.body.data.bed.id;
    });

    it('returns 404 when deleting a nonexistent bed', async () => {
      const res = await admin.delete('/api/v1/beds/99999999');
      expect(res.statusCode).toBe(404);
    });

    it('deletes an existing bed and the row is gone', async () => {
      const res = await admin.delete(`/api/v1/beds/${toDeleteId}`);
      expect(res.statusCode).toBe(200);

      const rows = await prisma.$queryRawUnsafe(
        `SELECT id FROM beds WHERE id = $1`, toDeleteId);
      expect(rows.length).toBe(0);
    });
  });

  describe('auth', () => {
    it('rejects unauthenticated GET /beds', async () => {
      const res = await request(app).get('/api/v1/beds');
      expect([401, 403]).toContain(res.statusCode);
    });

    it('rejects unauthenticated GET /wards', async () => {
      const res = await request(app).get('/api/v1/wards');
      expect([401, 403]).toContain(res.statusCode);
    });
  });

  // Stage-4-C — ICU/CCU tier gate.
  // Finding: 2026-05-09-emergency-walk-in-admission-no-icu-rbac-tier
  describe('ICU tier gate', () => {
    let icuBedId;

    beforeAll(async () => {
      const created = await prisma.$queryRawUnsafe(
        `INSERT INTO beds (ward_id, bed_number, status, bed_type)
         VALUES ($1, 'BD-DEEP-ICU-001', 'available', 'icu')
         RETURNING id`,
        wardId,
      );
      icuBedId = created[0].id;
    });

    function nurseAs() {
      const token = generateTestToken('NURSING_STAFF', {
        uid: 'a8888888-8888-4888-8888-888888888a02',
        id: 990801,
      });
      return {
        post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
      };
    }

    it('forbids NURSING_STAFF from allocating an ICU bed', async () => {
      const nurse = nurseAs();
      const res = await nurse.post(`/api/v1/beds/${icuBedId}/admit`).send({
        patient_name: 'ICU Test',
      });
      expect(res.statusCode).toBe(403);

      const rows = await prisma.$queryRawUnsafe(
        `SELECT status FROM beds WHERE id = $1`, icuBedId);
      expect(rows[0].status).toBe('available');
    });

    it('allows ADMIN to allocate the same ICU bed', async () => {
      const res = await admin.post(`/api/v1/beds/${icuBedId}/admit`).send({
        patient_name: 'ICU Test Admin',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data.bed.status).toBe('occupied');
    });
  });
});
