// Deep integration tests for ward + bed CRUD and canonical admission-backed
// assignment/discharge through `/api/v1/beds` + `/api/v1/wards`, including
// column-accurate RETURNING values and real-world DELETE counts.

import { generateTestToken, ensureTestIdentity } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';
import { withAuditBypass } from './helpers/auditBypass.js';

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

async function purgeBedDeepAuditLogs(wardName, emptyWardName) {
  await withAuditBypass(prisma, async (tx) => {
    await tx.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE action = 'BED_DELETED' AND metadata->>'bed_number' LIKE 'BD-DEEP-%'`,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM audit_logs
        WHERE action IN ('BED_CREATED', 'WARD_CREATED', 'WARD_DELETED')
          AND (
            metadata->>'bed_number' LIKE 'BD-DEEP-%'
            OR metadata->>'ward_name' IN ($1, $2)
          )`,
      wardName,
      emptyWardName,
    );
  });
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

  // Authentication fails closed when a token's subject has no live identity
  // row, so these invented uids 401 before the ward RBAC gate is reached.
  beforeAll(async () => {
    await ensureTestIdentity('a8888888-8888-4888-8888-888888888a01', { role: 'ADMIN' });
    await ensureTestIdentity('a8888888-8888-4888-8888-888888888a02', { role: 'NURSING_STAFF' });
  });

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
    await purgeBedDeepAuditLogs(WARD_NAME, EMPTY_WARD_NAME);
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
    await purgeBedDeepAuditLogs(WARD_NAME, EMPTY_WARD_NAME).catch(() => {});
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

  describe('canonical admission bed assignment + discharge flow', () => {
    let admitBedId;
    let admitAdmissionId;
    const ADMIT_PATIENT_UID = 'a8888888-8888-4888-8888-888888888c01';
    const ADMIT_PATIENT_PHONE = '9000088801';
    let admitPatientId;

    beforeAll(async () => {
      await prisma.$executeRawUnsafe(
        `DELETE FROM bed_transfers WHERE patient_uid = $1::uuid`, ADMIT_PATIENT_UID,
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM admissions WHERE patient_uid = $1::uuid`, ADMIT_PATIENT_UID,
      ).catch(() => {});
      // users.phone is globally unique — clear by uid OR phone so a leftover
      // row under a different uid can't collide on the insert below.
      await prisma.$executeRawUnsafe(
        `DELETE FROM users WHERE uid = $1::uuid OR phone = $2`, ADMIT_PATIENT_UID, ADMIT_PATIENT_PHONE,
      ).catch(() => {});
      const p = await prisma.$queryRawUnsafe(
        `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
         VALUES ($1::uuid, $2, 'Bed Deep Admit Patient', 'PATIENT', true, NOW())
         RETURNING id`,
        ADMIT_PATIENT_UID, ADMIT_PATIENT_PHONE,
      );
      admitPatientId = p[0].id;

      const res = await admin.post('/api/v1/beds').send({
        ward_id: wardId, bed_number: 'BD-DEEP-ADMIT',
      });
      admitBedId = res.body.data.bed.id;
      const admissionRows = await prisma.$queryRawUnsafe(
        `INSERT INTO admissions
           (patient_uid, tenant_id, status, admission_type, admitted_at)
         SELECT uid, tenant_id, 'admitted', 'emergency', NOW()
           FROM users
          WHERE uid = $1::uuid
         RETURNING id`,
        ADMIT_PATIENT_UID,
      );
      admitAdmissionId = admissionRows[0].id;
    });

    afterAll(async () => {
      // The discharge-workflow test leaves the bed occupied (markForDischarge
      // keeps it occupied), so the bed still references patient_id — drop it
      // before the user to avoid a beds_patient_id_fkey violation.
      if (admitBedId) {
        await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE id = $1`, admitBedId).catch(() => {});
      }
      await prisma.$executeRawUnsafe(
        `DELETE FROM bed_transfers WHERE patient_uid = $1::uuid`, ADMIT_PATIENT_UID,
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM discharge_consults WHERE patient_uid = $1::uuid`, ADMIT_PATIENT_UID,
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM admissions WHERE patient_uid = $1::uuid`, ADMIT_PATIENT_UID,
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM users WHERE uid = $1::uuid`, ADMIT_PATIENT_UID,
      ).catch(() => {});
    });

    it('rejects a patient-only quick-admit payload (no parallel admission writer)', async () => {
      const res = await admin.post(`/api/v1/beds/${admitBedId}/admit`).send({
        patient_id: admitPatientId,
        patient_name: 'Bed Deep Admit Patient',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe('ADMISSION_ID_REQUIRED');
      const stillAvailable = await prisma.$queryRawUnsafe(
        `SELECT status, admission_id, patient_uid FROM beds WHERE id = $1`, admitBedId,
      );
      expect(stillAvailable[0].status).toBe('available');
      expect(stillAvailable[0].admission_id).toBeNull();
      expect(stillAvailable[0].patient_uid).toBeNull();
    });

    it('rejects a name-only legacy payload with the stable admission-id error', async () => {
      const res = await admin.post(`/api/v1/beds/${admitBedId}/admit`).send({
        patient_name: 'Validator Reject No-Ref',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe('ADMISSION_ID_REQUIRED');
    });

    it('assigns an existing canonical admission: occupied + bed_transfers (fully linked)', async () => {
      const res = await admin.post(`/api/v1/beds/${admitBedId}/admit`).send({
        admission_id: admitAdmissionId,
      });
      expect(res.statusCode).toBe(200);
      expect(Number(res.body.data.admission.id)).toBe(Number(admitAdmissionId));
      expect(Number(res.body.data.admission.bed_id)).toBe(Number(admitBedId));

      const adm = await prisma.$queryRawUnsafe(
        `SELECT id, status, bed_id FROM admissions
          WHERE patient_uid = $1::uuid AND status = 'admitted'`,
        ADMIT_PATIENT_UID,
      );
      expect(adm).toHaveLength(1);
      expect(Number(adm[0].bed_id)).toBe(Number(admitBedId));

      const bedRows = await prisma.$queryRawUnsafe(
        `SELECT status, patient_uid, admission_id, admitted_at, assigned_at
           FROM beds
          WHERE id = $1`,
        admitBedId,
      );
      expect(bedRows[0].status).toBe('occupied');
      expect(String(bedRows[0].patient_uid)).toBe(ADMIT_PATIENT_UID);
      expect(Number(bedRows[0].admission_id)).toBe(Number(admitAdmissionId));
      expect(bedRows[0].admitted_at).toBeTruthy();
      expect(bedRows[0].assigned_at).toBeTruthy();

      const xfer = await prisma.$queryRawUnsafe(
        `SELECT id, reason, to_bed_id FROM bed_transfers
          WHERE patient_uid = $1::uuid AND admission_id = $2`,
        ADMIT_PATIENT_UID,
        admitAdmissionId,
      );
      expect(xfer).toHaveLength(1);
      expect(Number(xfer[0].to_bed_id)).toBe(Number(admitBedId));
    });

    it('refuses to admit an already-occupied bed', async () => {
      const res = await admin.post(`/api/v1/beds/${admitBedId}/admit`).send({
        admission_id: admitAdmissionId,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('bed-board discharge endpoint now FINDS the admission (workflow opens; pre-fix it 400d "No active admission")', async () => {
      // POST /api/v1/beds/:id/discharge is the discharge-WORKFLOW opener
      // (bedManagementRoutes → markForDischarge): it keeps the bed occupied
      // until the final /emr discharge. Pre-C-2 the legacy admit left
      // admission_id NULL, so getActiveAdmissionForBed 400'd here. Now that
      // admit creates a real admission, the workflow opens successfully and the
      // bed stays occupied (not vacated).
      const res = await admin.post(`/api/v1/beds/${admitBedId}/discharge`);
      expect(res.statusCode).toBe(201);
      const bed = await prisma.$queryRawUnsafe(
        `SELECT status, admission_id FROM beds WHERE id = $1`, admitBedId,
      );
      expect(bed[0].status).toBe('occupied');
      expect(bed[0].admission_id).toBeTruthy();
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
    let icuAdmissionId;
    const ICU_PATIENT_UID = 'a8888888-8888-4888-8888-888888888c02';
    const ICU_PATIENT_PHONE = '9000088802';

    beforeAll(async () => {
      await prisma.$executeRawUnsafe(`DELETE FROM bed_transfers WHERE patient_uid = $1::uuid`, ICU_PATIENT_UID).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, ICU_PATIENT_UID).catch(() => {});
      await prisma.$executeRawUnsafe(
        `DELETE FROM users WHERE uid = $1::uuid OR phone = $2`, ICU_PATIENT_UID, ICU_PATIENT_PHONE,
      ).catch(() => {});
      await prisma.$executeRawUnsafe(
        `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
         VALUES ($1::uuid, $2, 'ICU Test Patient', 'PATIENT', true, NOW())`,
        ICU_PATIENT_UID, ICU_PATIENT_PHONE,
      );
      const created = await prisma.$queryRawUnsafe(
        `INSERT INTO beds (ward_id, bed_number, status, bed_type)
         VALUES ($1, 'BD-DEEP-ICU-001', 'available', 'icu')
         RETURNING id`,
        wardId,
      );
      icuBedId = created[0].id;
      const admissionRows = await prisma.$queryRawUnsafe(
        `INSERT INTO admissions
           (patient_uid, tenant_id, status, admission_type, admitted_at)
         SELECT uid, tenant_id, 'admitted', 'emergency', NOW()
           FROM users
          WHERE uid = $1::uuid
         RETURNING id`,
        ICU_PATIENT_UID,
      );
      icuAdmissionId = admissionRows[0].id;
    });

    afterAll(async () => {
      // Drop the ICU bed first — the ADMIN-allocates test leaves it occupied,
      // so it still holds a beds_patient_id_fkey reference to the patient user.
      if (icuBedId) {
        await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE id = $1`, icuBedId).catch(() => {});
      }
      await prisma.$executeRawUnsafe(`DELETE FROM bed_transfers WHERE patient_uid = $1::uuid`, ICU_PATIENT_UID).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, ICU_PATIENT_UID).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, ICU_PATIENT_UID).catch(() => {});
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

    it('forbids NURSING_STAFF from allocating an ICU bed (tier gate fires before patient resolution)', async () => {
      const nurse = nurseAs();
      const res = await nurse.post(`/api/v1/beds/${icuBedId}/admit`).send({
        admission_id: icuAdmissionId,
      });
      expect(res.statusCode).toBe(403);

      const rows = await prisma.$queryRawUnsafe(
        `SELECT status FROM beds WHERE id = $1`, icuBedId);
      expect(rows[0].status).toBe('available');
    });

    it('allows ADMIN to allocate the same ICU bed (real admission created)', async () => {
      const res = await admin.post(`/api/v1/beds/${icuBedId}/admit`).send({
        admission_id: icuAdmissionId,
      });
      expect(res.statusCode).toBe(200);
      expect(Number(res.body.data.admission.bed_id)).toBe(Number(icuBedId));
    });
  });
});
