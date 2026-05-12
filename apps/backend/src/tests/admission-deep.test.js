// Deep integration tests for the ADT (Admission/Discharge/Transfer) flow.
// Unlike emr.test.js (which accepts [200,500] and masks real failures), these tests
// seed the DB, assert exact status codes, and verify row-level side effects.

import { authClient, generateTestToken } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

// Unique v4-shaped UUIDs so the suite is rerunnable and isolated from other tests.
const DOCTOR_UID = 'a1111111-1111-4111-8111-111111111a01';
const PATIENT_UID = 'a1111111-1111-4111-8111-111111111a02';
const ADMIN_UID = 'a1111111-1111-4111-8111-111111111a03';
// A second patient that exists in users but has NO patient_consents row,
// so the admit consent check is the firing condition rather than the
// upstream "patient not found" check (which returned 404 before the
// patient was seeded).
const NO_CONSENT_PATIENT_UID = 'a1111111-1111-4111-8111-111111111a04';
const PATIENT_PHONE = '9000010001';

const API_KEY = process.env.API_KEY || 'test-api-key';

// Admin with uid matching inserted users row (so ::uuid cast + audit FK is valid)
function adminAs(uid = ADMIN_UID) {
  const token = generateTestToken('ADMIN', { uid, id: 990001 });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (p) => request(app).put(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

describe('EMR admission/discharge/transfer — deep integration', () => {
  const admin = adminAs();
  const general = authClient('GENERAL');
  let wardId;
  let bed1Id;
  let bed2Id;
  let patientIntId;

  beforeAll(async () => {
    // Clean any leftovers from prior runs (in reverse FK order)
    await prisma.$executeRawUnsafe(`DELETE FROM bed_transfers WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE resource = 'admission' AND metadata->>'patient_uid' = $1`, PATIENT_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM patient_consents WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number IN ('DEEP-BED-A','DEEP-BED-B')`);
    await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE name = 'DEEP-TEST-WARD'`);
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      PATIENT_UID, DOCTOR_UID, ADMIN_UID, NO_CONSENT_PATIENT_UID);

    // Seed patient (users row)
    const patientRows = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, $2, 'Deep Test Patient', 'PATIENT', true, NOW())
       RETURNING id`,
      PATIENT_UID, PATIENT_PHONE);
    patientIntId = patientRows[0].id;

    // Second patient — exists but deliberately has no patient_consents row
    // so the consent gate is the firing condition for the "no active
    // consent" test below.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000010004', 'Deep Test No-Consent Patient', 'PATIENT', true, NOW())`,
      NO_CONSENT_PATIENT_UID);

    // Admin user (for audit FK — not strictly required since uid FK is soft, but keeps data clean)
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000010003', 'Deep Test Admin', 'ADMIN', true, NOW())`,
      ADMIN_UID);

    // Doctor user (if admissions.admitting_doctor had a FK it'd need staff, but it doesn't)
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000010002', 'Deep Test Doctor', 'DOCTOR', true, NOW())`,
      DOCTOR_UID);

    // Active treatment consent (required by admitPatient)
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_consents (patient_uid, consent_type, granted, status)
       VALUES ($1::uuid, 'treatment', true, 'active')`,
      PATIENT_UID);

    // Ward + two beds
    const wardRows = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (name, floor, total_beds) VALUES ('DEEP-TEST-WARD', 2, 2) RETURNING id`
    );
    wardId = wardRows[0].id;

    const bedA = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, bed_number, status) VALUES ($1, 'DEEP-BED-A', 'available') RETURNING id`,
      wardId);
    bed1Id = bedA[0].id;
    const bedB = await prisma.$queryRawUnsafe(
      `INSERT INTO beds (ward_id, bed_number, status) VALUES ($1, 'DEEP-BED-B', 'available') RETURNING id`,
      wardId);
    bed2Id = bedB[0].id;
  });

  afterAll(async () => {
    // Best-effort teardown — mirror beforeAll in FK-safe order
    await prisma.$executeRawUnsafe(`DELETE FROM bed_transfers WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM admissions WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM audit_logs WHERE resource = 'admission' AND metadata->>'patient_uid' = $1`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM patient_consents WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM beds WHERE bed_number IN ('DEEP-BED-A','DEEP-BED-B')`).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE id = $1`, wardId).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      PATIENT_UID, DOCTOR_UID, ADMIN_UID, NO_CONSENT_PATIENT_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  let admissionId;

  describe('authorization', () => {
    it('forbids GENERAL role from admitting patients', async () => {
      const res = await general.post('/api/v1/emr/admit').send({ patient_uid: PATIENT_UID });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('admitPatient', () => {
    it('rejects admission without required fields', async () => {
      const res = await admin.post('/api/v1/emr/admit').send({});
      expect(res.statusCode).toBe(400);
    });

    it('rejects admission without active consent', async () => {
      const res = await admin.post('/api/v1/emr/admit').send({
        patient_uid: NO_CONSENT_PATIENT_UID,
        admitting_doctor: DOCTOR_UID,
        chief_complaint: 'chest pain',
        // Use the bedless-emergency exception (migration 171) so we get
        // past the admit-bed gate and the consent check is the firing
        // condition. Otherwise the missing bed_id returns 400 before
        // consent is ever evaluated.
        admission_type: 'emergency',
        priority: 'emergent',
      });
      expect(res.statusCode).toBe(403);
      expect(String(res.body.code || res.body.message || '')).toMatch(/CONSENT|consent/i);
    });

    it('creates admission and occupies the bed', async () => {
      const res = await admin.post('/api/v1/emr/admit').send({
        patient_uid: PATIENT_UID,
        admitting_doctor: DOCTOR_UID,
        attending_doctor: DOCTOR_UID,
        department: 'Cardiology',
        ward: 'DEEP-TEST-WARD',
        bed_id: bed1Id,
        chief_complaint: 'chest pain',
        admitting_diagnosis: 'ACS rule-out',
        admission_type: 'emergency',
        priority: 'urgent',
        code_status: 'full_code',
      });
      expect(res.statusCode).toBe(201);
      expect(res.body.data?.admission?.id).toBeDefined();
      admissionId = res.body.data.admission.id;

      // Side-effect: bed now occupied + assigned to this patient
      const beds = await prisma.$queryRawUnsafe(
        `SELECT status, patient_id FROM beds WHERE id = $1`, bed1Id);
      expect(beds[0].status).toBe('occupied');
      expect(beds[0].patient_id).toBe(patientIntId);

      // Side-effect: bed_transfers row with admission_id link + reason='Admission'
      const transfers = await prisma.$queryRawUnsafe(
        `SELECT reason, from_bed_id, to_bed_id, admission_id
         FROM bed_transfers WHERE patient_uid = $1::uuid`, PATIENT_UID);
      expect(transfers.length).toBe(1);
      expect(transfers[0].reason).toBe('Admission');
      expect(transfers[0].from_bed_id).toBeNull();
      expect(transfers[0].to_bed_id).toBe(bed1Id);
      expect(transfers[0].admission_id).toBe(admissionId);

      // Side-effect: audit_log written with correct canonical columns
      const audits = await prisma.$queryRawUnsafe(
        `SELECT uid, action, resource, resource_id, metadata FROM audit_logs
         WHERE resource = 'admission' AND resource_id = $1 AND action = 'ADMIT_PATIENT'`,
        String(admissionId));
      expect(audits.length).toBe(1);
      expect(audits[0].action).toBe('ADMIT_PATIENT');
      expect(audits[0].metadata).toMatchObject({ patient_uid: PATIENT_UID, admission_type: 'emergency' });
    });

    it('rejects a second active admission for the same patient', async () => {
      const res = await admin.post('/api/v1/emr/admit').send({
        patient_uid: PATIENT_UID,
        admitting_doctor: DOCTOR_UID,
        chief_complaint: 'duplicate',
        // Bedless-emergency exception (migration 171) so the admit-bed
        // gate passes and the duplicate-active-admission check is the
        // firing condition.
        admission_type: 'emergency',
        priority: 'emergent',
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe('transferPatient', () => {
    it('rejects transfer without to_bed_id', async () => {
      const res = await admin.post(`/api/v1/emr/${admissionId}/transfer`).send({ reason: 'ICU' });
      expect(res.statusCode).toBe(400);
    });

    it('moves the patient to a new bed and records a transfer', async () => {
      const res = await admin.post(`/api/v1/emr/${admissionId}/transfer`).send({
        to_bed_id: bed2Id,
        reason: 'Stepdown',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data?.admission?.status).toBe('transferred');

      const bedA = await prisma.$queryRawUnsafe(`SELECT status, patient_id FROM beds WHERE id = $1`, bed1Id);
      const bedB = await prisma.$queryRawUnsafe(`SELECT status, patient_id FROM beds WHERE id = $1`, bed2Id);
      expect(bedA[0].status).toBe('available');
      expect(bedA[0].patient_id).toBeNull();
      expect(bedB[0].status).toBe('occupied');
      expect(bedB[0].patient_id).toBe(patientIntId);

      const transfers = await prisma.$queryRawUnsafe(
        `SELECT reason, from_bed_id, to_bed_id FROM bed_transfers
         WHERE patient_uid = $1::uuid AND reason = 'Stepdown'`, PATIENT_UID);
      expect(transfers.length).toBe(1);
      expect(transfers[0].from_bed_id).toBe(bed1Id);
      expect(transfers[0].to_bed_id).toBe(bed2Id);
    });
  });

  describe('updateCodeStatus', () => {
    it('rejects invalid code_status', async () => {
      const res = await admin.put(`/api/v1/emr/${admissionId}/code-status`).send({
        code_status: 'BOGUS',
      });
      expect(res.statusCode).toBe(400);
    });

    it('updates code status to DNR and writes audit log', async () => {
      const res = await admin.put(`/api/v1/emr/${admissionId}/code-status`).send({
        code_status: 'dnr',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data?.admission?.code_status).toBe('dnr');

      const audits = await prisma.$queryRawUnsafe(
        `SELECT action, metadata FROM audit_logs
         WHERE resource_id = $1 AND action = 'UPDATE_CODE_STATUS'`,
        String(admissionId));
      expect(audits.length).toBeGreaterThan(0);
      expect(audits[audits.length - 1].metadata).toMatchObject({ new: 'dnr' });
    });
  });

  describe('dischargePatient', () => {
    it('rejects discharge without discharge_type', async () => {
      const res = await admin.post(`/api/v1/emr/${admissionId}/discharge`).send({});
      expect(res.statusCode).toBe(400);
    });

    it('rejects discharge with invalid discharge_type', async () => {
      const res = await admin.post(`/api/v1/emr/${admissionId}/discharge`).send({
        discharge_type: 'BOGUS',
      });
      expect(res.statusCode).toBe(400);
    });

    it('discharges, releases the bed, and records audit', async () => {
      await prisma.$executeRawUnsafe(
        `UPDATE admissions
            SET discharge_initiated_at = NOW(),
                summary_signed_at = NOW(),
                discharge_drugs_dispensed_at = NOW()
          WHERE id = $1`,
        admissionId,
      );

      const res = await admin.post(`/api/v1/emr/${admissionId}/discharge`).send({
        discharge_type: 'home',
        discharge_summary: { notes: 'Follow up in 2 weeks' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.data?.admission?.status).toBe('discharged');
      expect(res.body.data?.admission?.los_days).toBeGreaterThanOrEqual(1);

      // Bed released
      const bedB = await prisma.$queryRawUnsafe(`SELECT status, patient_id FROM beds WHERE id = $1`, bed2Id);
      expect(bedB[0].status).toBe('cleaning');
      expect(bedB[0].patient_id).toBeNull();

      const housekeeping = await prisma.$queryRawUnsafe(
        `SELECT status, request_type, urgency
           FROM housekeeping_requests
          WHERE description LIKE $1`,
        `%admission #${admissionId}%`,
      );
      expect(housekeeping.length).toBe(1);
      expect(housekeeping[0]).toMatchObject({
        status: 'open',
        request_type: 'cleaning',
        urgency: 'high',
      });

      // Admission row shows discharged state
      const adm = await prisma.$queryRawUnsafe(
        `SELECT status, discharge_type, discharged_at FROM admissions WHERE id = $1`, admissionId);
      expect(adm[0].status).toBe('discharged');
      expect(adm[0].discharge_type).toBe('home');
      expect(adm[0].discharged_at).not.toBeNull();

      const audits = await prisma.$queryRawUnsafe(
        `SELECT action FROM audit_logs WHERE resource_id = $1 AND action = 'DISCHARGE_PATIENT'`,
        String(admissionId));
      expect(audits.length).toBe(1);
    });

    it('blocks a second discharge attempt (terminal state)', async () => {
      const res = await admin.post(`/api/v1/emr/${admissionId}/discharge`).send({
        discharge_type: 'home',
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('history + stats', () => {
    it('returns the patient\'s admission history with los_days', async () => {
      const res = await admin.get(`/api/v1/emr/admissions/patient/${PATIENT_UID}`);
      expect(res.statusCode).toBe(200);
      const admissions = res.body.data?.admissions || [];
      expect(admissions.length).toBeGreaterThanOrEqual(1);
      const ours = admissions.find((a) => a.id === admissionId);
      expect(ours).toBeDefined();
      expect(ours.status).toBe('discharged');
      expect(ours.los_days).toBeGreaterThanOrEqual(1);
    });

    it('returns admission statistics including bed occupancy', async () => {
      const res = await admin.get('/api/v1/emr/admissions/stats');
      expect(res.statusCode).toBe(200);
      expect(res.body.data).toMatchObject({
        total_beds: expect.any(Number),
        occupied_beds: expect.any(Number),
        occupancy_rate: expect.any(Number),
      });
    });
  });
});
