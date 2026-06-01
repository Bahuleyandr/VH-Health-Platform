// Deep integration tests for ward + bed CRUD and admit/discharge.
// Isolated from admissionService (which uses its own `bed_transfers` path) — this
// suite exercises the simpler `bedService` that backs `/api/v1/beds` + `/api/v1/wards`
// and verifies column-accurate RETURNING + real-world DELETE counts.

import { generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const API_KEY = process.env.API_KEY || 'test-api-key';
const CLEANING_REQUESTER_UID = 'a8888888-8888-4888-8888-888888888b01';
const CLEANING_STAFF_UID = 'a8888888-8888-4888-8888-888888888b02';
const CLEANING_INCHARGE_UID = 'a8888888-8888-4888-8888-888888888b03';

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

function clientAs(role, overrides = {}) {
  const token = generateTestToken(role, overrides);
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    delete: (p) => request(app).delete(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

describe('Bed + ward management — deep integration', () => {
  const admin = adminAs();
  const nurse = clientAs('NURSING_STAFF', {
    uid: 'a8888888-8888-4888-8888-888888888a02',
    id: 990801,
  });
  const WARD_NAME = 'BED-DEEP-WARD';
  const EMPTY_WARD_NAME = 'BED-DEEP-EMPTY-WARD';
  let wardId;

  beforeAll(async () => {
    // Clean any fixtures from prior runs (in FK-safe order)
    await prisma.$executeRawUnsafe(
      `DELETE FROM housekeeping_request_recipients
        WHERE staff_uid IN ($1::uuid, $2::uuid, $3::uuid)
           OR request_id IN (
             SELECT id FROM housekeeping_requests
              WHERE description LIKE 'bed-deep-cleaning-assignee-test%'
           )`,
      CLEANING_REQUESTER_UID,
      CLEANING_STAFF_UID,
      CLEANING_INCHARGE_UID,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM housekeeping_requests
        WHERE description LIKE 'bed-deep-cleaning-assignee-test%'
           OR requester_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      CLEANING_REQUESTER_UID,
      CLEANING_STAFF_UID,
      CLEANING_INCHARGE_UID,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number LIKE 'BD-DEEP-%' OR bed_number LIKE 'BD-FLT-%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name IN ($1, $2)`, WARD_NAME, EMPTY_WARD_NAME);
    await prisma.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE action = 'BED_DELETED' AND metadata->>'bed_number' LIKE 'BD-DEEP-%'`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM audit_logs
        WHERE action IN ('BED_CREATED', 'WARD_CREATED', 'WARD_DELETED')
          AND (
            metadata->>'bed_number' LIKE 'BD-DEEP-%'
            OR metadata->>'ward_name' IN ($1, $2)
          )`,
      WARD_NAME,
      EMPTY_WARD_NAME,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      CLEANING_REQUESTER_UID,
      CLEANING_STAFF_UID,
      CLEANING_INCHARGE_UID,
    );
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM housekeeping_request_recipients
        WHERE staff_uid IN ($1::uuid, $2::uuid, $3::uuid)
           OR request_id IN (
             SELECT id FROM housekeeping_requests
              WHERE description LIKE 'bed-deep-cleaning-assignee-test%'
           )`,
      CLEANING_REQUESTER_UID,
      CLEANING_STAFF_UID,
      CLEANING_INCHARGE_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM housekeeping_requests
        WHERE description LIKE 'bed-deep-cleaning-assignee-test%'
           OR requester_uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      CLEANING_REQUESTER_UID,
      CLEANING_STAFF_UID,
      CLEANING_INCHARGE_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number LIKE 'BD-DEEP-%' OR bed_number LIKE 'BD-FLT-%'`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name IN ($1, $2)`, WARD_NAME, EMPTY_WARD_NAME).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE action = 'BED_DELETED' AND metadata->>'bed_number' LIKE 'BD-DEEP-%'`,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM audit_logs
        WHERE action IN ('BED_CREATED', 'WARD_CREATED', 'WARD_DELETED')
          AND (
            metadata->>'bed_number' LIKE 'BD-DEEP-%'
            OR metadata->>'ward_name' IN ($1, $2)
          )`,
      WARD_NAME,
      EMPTY_WARD_NAME,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      CLEANING_REQUESTER_UID,
      CLEANING_STAFF_UID,
      CLEANING_INCHARGE_UID,
    ).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  describe('wards', () => {
    it('forbids nursing staff from creating ward master rows', async () => {
      const res = await nurse.post('/api/v1/wards').send({
        name: `${WARD_NAME}-NURSE`, floor: 2, total_beds: 1,
      });
      expect(res.statusCode).toBe(403);
    });

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

    it('forbids nursing staff from creating bed master rows', async () => {
      const res = await nurse.post('/api/v1/beds').send({
        ward_id: wardId, bed_number: 'BD-DEEP-NURSE',
      });
      expect(res.statusCode).toBe(403);
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

    it('sorts ward beds in natural bed-number order', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO beds (ward_id, bed_number, status)
         VALUES ($1, 'BD-DEEP-2', 'available'),
                ($1, 'BD-DEEP-10', 'available')`,
        wardId,
      );

      const res = await admin.get(`/api/v1/beds/ward/${wardId}`);
      expect(res.statusCode).toBe(200);
      const bedNumbers = res.body.data.beds.map((b) => b.bed_number);
      expect(bedNumbers).toEqual(expect.arrayContaining(['BD-DEEP-001', 'BD-DEEP-2', 'BD-DEEP-10']));
      expect(bedNumbers.indexOf('BD-DEEP-2')).toBeLessThan(bedNumbers.indexOf('BD-DEEP-10'));
    });

    it('shows routed housekeeping staff names for cleaning beds', async () => {
      const requesterRows = await prisma.$queryRawUnsafe(
        `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
         VALUES ($1::uuid, '9000088801', 'Bed Deep Requester', 'NURSING_STAFF', true, NOW())
         RETURNING id, uid`,
        CLEANING_REQUESTER_UID,
      );
      const staffRows = await prisma.$queryRawUnsafe(
        `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
         VALUES
           ($1::uuid, '9000088802', 'Cleaner Asha', 'HOUSEKEEPING_STAFF', true, NOW()),
           ($2::uuid, '9000088803', 'HK Lead Meera', 'HOUSEKEEPING_INCHARGE', true, NOW())
         RETURNING id, uid, role`,
        CLEANING_STAFF_UID,
        CLEANING_INCHARGE_UID,
      );
      const cleaner = staffRows.find((row) => row.role === 'HOUSEKEEPING_STAFF');
      const incharge = staffRows.find((row) => row.role === 'HOUSEKEEPING_INCHARGE');
      const cleaningBedRows = await prisma.$queryRawUnsafe(
        `INSERT INTO beds (ward_id, bed_number, status)
         VALUES ($1, 'BD-DEEP-CLEANING', 'cleaning')
         RETURNING id`,
        wardId,
      );
      const cleaningBedId = cleaningBedRows[0].id;
      const requestRows = await prisma.$queryRawUnsafe(
        `INSERT INTO housekeeping_requests
           (requester_id, requester_uid, location_text, request_type, urgency,
            description, assigned_to, assigned_to_uid, assigned_at, status)
         VALUES
           ($1::int, $2::uuid, $3, 'bed_cleaning', 'high',
            $4, $5::int, $6::uuid, NOW(), 'assigned')
         RETURNING id`,
        requesterRows[0].id,
        requesterRows[0].uid,
        `${WARD_NAME} / BD-DEEP-CLEANING`,
        `bed-deep-cleaning-assignee-test bed_id=${cleaningBedId}.`,
        cleaner.id,
        cleaner.uid,
      );
      await prisma.$executeRawUnsafe(
        `INSERT INTO housekeeping_request_recipients
           (request_id, staff_id, staff_uid, recipient_kind, source, notified_at)
         VALUES
           ($1::int, $2::int, $3::uuid, 'assignee', 'roster', NOW()),
           ($1::int, $4::int, $5::uuid, 'incharge', 'role', NOW())`,
        requestRows[0].id,
        cleaner.id,
        cleaner.uid,
        incharge.id,
        incharge.uid,
      );

      const wardRes = await admin.get(`/api/v1/beds/ward/${wardId}?status=cleaning`);
      expect(wardRes.statusCode).toBe(200);
      const wardBed = wardRes.body.data.beds.find((b) => b.id === cleaningBedId);
      expect(wardBed).toBeDefined();
      expect(wardBed.housekeeping_request_id).toBe(requestRows[0].id);
      expect(wardBed.housekeeping_staff_names).toContain('Cleaner Asha');
      expect(wardBed.housekeeping_assignee_names).toContain('Cleaner Asha');
      expect(wardBed.housekeeping_assignee_names).toContain('HK Lead Meera');

      const listRes = await admin.get(`/api/v1/beds?status=cleaning&ward_id=${wardId}`);
      expect(listRes.statusCode).toBe(200);
      const listBed = listRes.body.data.beds.find((b) => b.id === cleaningBedId);
      expect(listBed.housekeeping_staff_names).toContain('Cleaner Asha');
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
      expect(ours.actual_beds).toBe(4);
      expect(ours.maintenance).toBe(1);
      expect(ours.available).toBe(2);
    });

    it('honors available filters so occupied, cleaning, and stale occupant beds are not selectable', async () => {
      await prisma.$executeRawUnsafe(
        `INSERT INTO beds (ward_id, bed_number, status, patient_name)
         VALUES
           ($1, 'BD-FLT-AVAIL', 'available', NULL),
           ($1, 'BD-FLT-OCC', 'occupied', 'Current Patient'),
           ($1, 'BD-FLT-CLEAN', 'cleaning', NULL),
           ($1, 'BD-FLT-STALE', 'available', 'Previous Patient')`,
        wardId,
      );

      const listRes = await admin.get(`/api/v1/beds?status=available&ward_id=${wardId}`);
      expect(listRes.statusCode).toBe(200);
      const listNumbers = listRes.body.data.beds.map((b) => b.bed_number);
      expect(listNumbers).toContain('BD-FLT-AVAIL');
      expect(listNumbers).not.toContain('BD-FLT-OCC');
      expect(listNumbers).not.toContain('BD-FLT-CLEAN');
      expect(listNumbers).not.toContain('BD-FLT-STALE');

      const wardRes = await admin.get(`/api/v1/beds/ward/${wardId}?available=true`);
      expect(wardRes.statusCode).toBe(200);
      const wardNumbers = wardRes.body.data.beds.map((b) => b.bed_number);
      expect(wardNumbers).toContain('BD-FLT-AVAIL');
      expect(wardNumbers).not.toContain('BD-FLT-OCC');
      expect(wardNumbers).not.toContain('BD-FLT-CLEAN');
      expect(wardNumbers).not.toContain('BD-FLT-STALE');

      const availableRes = await admin.get(`/api/v1/beds/available?ward_id=${wardId}`);
      expect(availableRes.statusCode).toBe(200);
      const availableNumbers = availableRes.body.data.beds.map((b) => b.bed_number);
      expect(availableNumbers).toContain('BD-FLT-AVAIL');
      expect(availableNumbers).not.toContain('BD-FLT-STALE');
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

    it('refuses to start discharge workflow when no active admission is linked', async () => {
      const res = await admin.post(`/api/v1/beds/${admitBedId}/discharge`);
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/No active admission/i);

      await prisma.$executeRawUnsafe(
        `UPDATE beds
            SET status = 'available',
                patient_id = NULL,
                patient_name = NULL,
                patient_uid = NULL,
                admission_id = NULL,
                admitted_at = NULL,
                expected_discharge = NULL,
                updated_at = NOW()
          WHERE id = $1`,
        admitBedId,
      );
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

    it('forbids nursing staff from deleting bed master rows', async () => {
      const res = await nurse.delete(`/api/v1/beds/${toDeleteId}`);
      expect(res.statusCode).toBe(403);
    });

    it('rejects deleting an occupied bed', async () => {
      const rows = await prisma.$queryRawUnsafe(
        `INSERT INTO beds (ward_id, bed_number, status, patient_uid, patient_name)
         VALUES ($1, 'BD-DEEP-OCC-DEL', 'occupied',
                 'a8888888-8888-4888-8888-888888888d01'::uuid,
                 'Occupied Delete Guard')
         RETURNING id`,
        wardId,
      );

      const res = await admin.delete(`/api/v1/beds/${rows[0].id}`);
      expect(res.statusCode).toBe(409);
      expect(res.body.message).toMatch(/clear the patient\/admission link/i);

      const stillThere = await prisma.$queryRawUnsafe(
        `SELECT id FROM beds WHERE id = $1`,
        rows[0].id,
      );
      expect(stillThere).toHaveLength(1);
    });

    it('rejects deleting a ward that still owns beds', async () => {
      const res = await admin.delete(`/api/v1/wards/${wardId}`);
      expect(res.statusCode).toBe(409);
      expect(res.body.message).toMatch(/delete or move its/i);
      expect(Number(res.body.details.bed_count)).toBeGreaterThan(0);
    });

    it('deletes an existing bed and the row is gone', async () => {
      const res = await admin.delete(`/api/v1/beds/${toDeleteId}`);
      expect(res.statusCode).toBe(200);

      const rows = await prisma.$queryRawUnsafe(
        `SELECT id FROM beds WHERE id = $1`, toDeleteId);
      expect(rows.length).toBe(0);

      const auditRows = await prisma.$queryRawUnsafe(
        `SELECT action, resource, resource_id, metadata
           FROM audit_logs
          WHERE action = 'BED_DELETED'
            AND resource = 'bed'
            AND resource_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        String(toDeleteId),
      );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].metadata).toMatchObject({
        bed_id: toDeleteId,
        bed_number: 'BD-DEEP-DELETE',
        ward_id: wardId,
      });
    });

    it('deletes an empty ward and writes an audit trail', async () => {
      const createRes = await admin.post('/api/v1/wards').send({
        name: EMPTY_WARD_NAME, floor: 1, total_beds: 0,
      });
      expect(createRes.statusCode).toBe(201);
      const emptyWardId = createRes.body.data.ward.id;

      const res = await admin.delete(`/api/v1/wards/${emptyWardId}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.ward.name).toBe(EMPTY_WARD_NAME);

      const rows = await prisma.$queryRawUnsafe(
        `SELECT id FROM wards WHERE id = $1`,
        emptyWardId,
      );
      expect(rows).toHaveLength(0);

      const auditRows = await prisma.$queryRawUnsafe(
        `SELECT action, resource, resource_id, metadata
           FROM audit_logs
          WHERE action = 'WARD_DELETED'
            AND resource = 'ward'
            AND resource_id = $1
          ORDER BY created_at DESC
          LIMIT 1`,
        String(emptyWardId),
      );
      expect(auditRows).toHaveLength(1);
      expect(auditRows[0].metadata).toMatchObject({
        ward_id: emptyWardId,
        ward_name: EMPTY_WARD_NAME,
      });
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
