// src/tests/appointment-record-owner-access.deep.test.js
//
// The POSITIVE half of the appointment / patient-record IDOR contract.
//
// `src/tests/authorization.test.js` proves the DENIAL half: a stranger's token
// must never get 200. It could not prove the ALLOW half — its three owner
// happy-path cases were empty `it.skip` stubs marked "requires test DB". The
// database was never the blocker (that file's negative cases already query a
// real Postgres and assert exact 404s); the blocker was fixture OWNERSHIP: the
// shared authorization harness seeds no appointment and no patient record that
// belongs to its test patient, so there was nothing for an owner to be allowed
// through to.
//
// This suite seeds that ownership in its own tenant and asserts BOTH halves
// against the SAME rows. That is strictly stronger than the id-999999 negatives
// next door: a 403 here is provably "not yours", not "does not exist".
//
// Needs Postgres — `jest.setup.cjs` defaults DATABASE_URL to the QA cluster.
// Self-skips when unconfigured, matching the deep-suite convention.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { waitForAuditLogDrain } from '../middleware/auditLog.js';
import { deleteWithAuditBypass } from './helpers/auditBypass.js';
import { generateTestToken, API_KEY } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// Own tenant + own uids so this suite never collides with the shared corpus.
const TENANT_ID = 'a11d0000-0000-4000-8000-00000000a11d';
const OWNER_UID = 'a11d0000-0000-4000-8000-000000000a01';
const STRANGER_UID = 'a11d0000-0000-4000-8000-000000000b01';
const DOCTOR_UID = 'a11d0000-0000-4000-8000-00000000d001';
const OWNER_PHONE = '+919888100101';
const STRANGER_PHONE = '+919888100102';
const DOCTOR_PHONE = '+919888100103';

// Fixed future date keeps the appointment out of the past-date validator
// without depending on when the suite runs.
const APPT_DATE = '2032-04-12';

let ownerId = null;
let strangerId = null;
let doctorId = null;
const appt = {};
const records = {};

function client(uid, id, phone, role = 'PATIENT') {
  const token = generateTestToken(role, { uid, id, phone, tenant_id: TENANT_ID });
  const h = (r) => r.set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`);
  return {
    get: (p) => h(request(app).get(p)),
    put: (p) => h(request(app).put(p)),
    delete: (p) => h(request(app).delete(p)),
  };
}

const asOwner = () => client(OWNER_UID, ownerId, OWNER_PHONE);
const asStranger = () => client(STRANGER_UID, strangerId, STRANGER_PHONE);

async function insertAppointment(time) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO appointments
       (phone, patient_id, doctor_id, doctor_name, appointment_date, appointment_time,
        status, reason, tenant_id, created_at, updated_at)
     VALUES ($1, $2::int, $3::int, 'Dr Owner Access', $4::date, $5,
             'SCHEDULED', 'Initial reason', $6::uuid, NOW(), NOW())
     RETURNING id`,
    OWNER_PHONE, ownerId, doctorId, APPT_DATE, time, TENANT_ID,
  );
  return Number(rows[0].id);
}

async function insertRecord(fileKey) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO patient_records
       (patient_id, document_type, title, file_key, file_name, tenant_id, created_at, updated_at)
     VALUES ($1::int, 'REPORT', 'Owner access fixture', $2, 'fixture.pdf', $3::uuid, NOW(), NOW())
     RETURNING id`,
    ownerId, fileKey, TENANT_ID,
  );
  return Number(rows[0].id);
}

async function statusOf(appointmentId) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT status FROM appointments WHERE id = $1::int AND tenant_id = $2::uuid',
    appointmentId, TENANT_ID,
  );
  return rows[0]?.status ?? null;
}

async function recordExists(recordId) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT 1 AS present FROM patient_records WHERE id = $1::bigint AND tenant_id = $2::uuid',
    recordId, TENANT_ID,
  );
  return rows.length > 0;
}

// Teardown order matters. Exercising these routes writes PHI-access evidence
// rows that carry a tenant FK; deleting the tenant first fails 23503 and — with
// the corpus's usual `.catch(() => {})` — would leak the whole fixture silently.
// The list below was derived by scanning every `tenant_id`-bearing table for
// rows left after a full green run, not guessed:
//   DO $$ ... information_schema.columns WHERE column_name='tenant_id' ... $$
// If a future route adds another tenant-scoped sink, re-run that scan.
const TENANT_SCOPED_FIXTURE_TABLES = [
  'hipaa_access_log',
  'patient_access_audit_log',
  'patient_records',
  'appointments',
  'users',
];

async function cleanup() {
  await waitForAuditLogDrain();
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM audit_log WHERE tenant_id = $1::uuid`,
    TENANT_ID,
  ).catch(() => {});
  for (const table of TENANT_SCOPED_FIXTURE_TABLES) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM ${table} WHERE tenant_id = $1::uuid`, TENANT_ID,
    ).catch(() => {});
  }
  // Belt and braces: uid and phone are globally unique, so a fixture user
  // stranded in some other tenant by an interrupted run would break the
  // beforeAll INSERT rather than being cleaned by the tenant-scoped sweep.
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid) OR phone IN ($4, $5, $6)`,
    OWNER_UID, STRANGER_UID, DOCTOR_UID, OWNER_PHONE, STRANGER_PHONE, DOCTOR_PHONE,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    'DELETE FROM tenants WHERE id = $1::uuid', TENANT_ID,
  );
}

d('Appointment + patient-record owner access (IDOR positive path)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'idor-owner-access', 'IDOR Owner Access')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_ID,
    );
    const seeded = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at) VALUES
         ($1::uuid, $2, 'Owner Patient',    'PATIENT', true, $7::uuid, NOW()),
         ($3::uuid, $4, 'Stranger Patient', 'PATIENT', true, $7::uuid, NOW()),
         ($5::uuid, $6, 'Access Doctor',    'DOCTOR',  true, $7::uuid, NOW())
       RETURNING id, uid`,
      OWNER_UID, OWNER_PHONE,
      STRANGER_UID, STRANGER_PHONE,
      DOCTOR_UID, DOCTOR_PHONE,
      TENANT_ID,
    );
    const byUid = new Map(seeded.map((r) => [String(r.uid), Number(r.id)]));
    ownerId = byUid.get(OWNER_UID);
    strangerId = byUid.get(STRANGER_UID);
    doctorId = byUid.get(DOCTOR_UID);

    appt.ownerUpdate = await insertAppointment('09:00');
    appt.strangerUpdate = await insertAppointment('09:30');
    appt.ownerCancel = await insertAppointment('10:00');
    appt.strangerCancel = await insertAppointment('10:30');
    records.ownerDelete = await insertRecord('idor-owner-access/owner-delete.pdf');
    records.strangerDelete = await insertRecord('idor-owner-access/stranger-delete.pdf');
  }, 120000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 120000);

  describe('GET /api/v1/appointments/:id', () => {
    it('hydrates an owning patient appointment by stable ID', async () => {
      const res = await asOwner().get(`/api/v1/appointments/${appt.ownerUpdate}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.data.appointment).toEqual(expect.objectContaining({
        id: appt.ownerUpdate,
        patient_id: ownerId,
      }));
    });

    it('denies a non-owning patient on an appointment that exists', async () => {
      const res = await asStranger().get(`/api/v1/appointments/${appt.strangerUpdate}`);

      expect(res.statusCode).toBe(403);
      expect(res.body.data?.appointment).toBeUndefined();
    });
  });

  describe('PUT /api/v1/appointments/:id', () => {
    it('allows the owning patient to update their own appointment', async () => {
      const res = await asOwner()
        .put(`/api/v1/appointments/${appt.ownerUpdate}`)
        .send({ reason: 'Owner updated reason' });

      expect(res.statusCode).toBe(200);

      const rows = await prisma.$queryRawUnsafe(
        'SELECT reason FROM appointments WHERE id = $1::int AND tenant_id = $2::uuid',
        appt.ownerUpdate, TENANT_ID,
      );
      expect(rows[0].reason).toBe('Owner updated reason');
    });

    it('denies a non-owning patient on an appointment that really exists', async () => {
      const res = await asStranger()
        .put(`/api/v1/appointments/${appt.strangerUpdate}`)
        .send({ reason: 'Stranger updated reason' });

      expect(res.statusCode).not.toBe(200);

      const rows = await prisma.$queryRawUnsafe(
        'SELECT reason FROM appointments WHERE id = $1::int AND tenant_id = $2::uuid',
        appt.strangerUpdate, TENANT_ID,
      );
      expect(rows[0].reason).toBe('Initial reason');
    });
  });

  describe('DELETE /api/v1/appointments/:id', () => {
    it('allows the owning patient to cancel their own appointment', async () => {
      const res = await asOwner().delete(`/api/v1/appointments/${appt.ownerCancel}`);

      expect(res.statusCode).toBe(200);
      expect(await statusOf(appt.ownerCancel)).toBe('CANCELLED');
    });

    it('denies a non-owning patient cancelling an appointment that really exists', async () => {
      const res = await asStranger().delete(`/api/v1/appointments/${appt.strangerCancel}`);

      expect(res.statusCode).not.toBe(200);
      expect(await statusOf(appt.strangerCancel)).toBe('SCHEDULED');
    });
  });

  describe('DELETE /api/v1/appointments/patient/records/:id', () => {
    it('allows the owning patient to delete their own record', async () => {
      const res = await asOwner()
        .delete(`/api/v1/appointments/patient/records/${records.ownerDelete}`);

      expect(res.statusCode).toBe(200);
      expect(await recordExists(records.ownerDelete)).toBe(false);
    });

    it('denies a non-owning patient deleting a record that really exists', async () => {
      const res = await asStranger()
        .delete(`/api/v1/appointments/patient/records/${records.strangerDelete}`);

      expect(res.statusCode).not.toBe(200);
      expect(await recordExists(records.strangerDelete)).toBe(true);
    });
  });
});
