// Deep regression tests for H1 (HIGH — PHI bleed): list endpoints must scope
// to the requested patient/admission instead of silently returning every
// patient's rows.
//
// Findings:
//   2026-05-21-inpatient-admission-doctor-58437f67
//     GET /api/v1/investigations/list?patient_uid=<uuid> ignored the filter
//     and returned other patients' investigations.
//   2026-05-22-inpatient-admission-pharmacy-3e9d3302
//     GET /api/v1/pharmacy-orders/ward-indents?admission_id / ?patient_uid
//     ignored both filters and mixed IPD pharmacy requests across patients.
//
// Strategy: seed TWO patients, give each their own rows, then assert a
// filtered list returns ONLY the requested patient's/admission's rows and
// never the other patient's — the exact privacy + clinical-safety guarantee
// the findings demand.

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';
import { deleteWithAuditBypass } from './helpers/auditBypass.js';

// Distinct, test-only uids/phones so cleanup is surgical.
const PATIENT_A_UID = 'b1111111-1111-4111-8111-1111111111a1';
const PATIENT_B_UID = 'b2222222-2222-4222-8222-2222222222b2';
const DOCTOR_UID = 'b3333333-3333-4333-8333-3333333333d3';
const STAFF_UID = 'b4444444-4444-4444-8444-4444444444f4';
const TENANT = '00000000-0000-4000-8000-000000000001';
const RUN = String(Date.now() % 100000).padStart(5, '0');
const PHONE_A = `+9198880${RUN}`;
const PHONE_B = `+9198881${RUN}`;
const DOCTOR_PHONE = `+9198882${RUN}`;
const STAFF_PHONE = `+9198883${RUN}`;
const WARD_NAME = `H1-Filter-Ward-${RUN}`;

let patientAId;
let patientBId;
let wardId;
let admissionA;
let admissionB;
const indentIds = [];

function doctorClient() {
  const token = generateTestToken('DOCTOR', { uid: DOCTOR_UID, id: 991201 });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

function staffClient() {
  const token = generateTestToken('PHARMACY_STAFF', { uid: STAFF_UID, id: 991202 });
  return {
    get: (p) => request(app).get(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (p) => request(app).post(p).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

async function cleanup() {
  if (indentIds.length) {
    await deleteWithAuditBypass(
      prisma,
      `DELETE FROM ward_indent_events WHERE ward_indent_id = ANY($1::int[])`, indentIds,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM ward_indents WHERE id = ANY($1::int[])`, indentIds,
    ).catch(() => {});
  }
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM ward_indent_events e
      USING ward_indents wi
      WHERE e.ward_indent_id = wi.id
        AND wi.patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_A_UID, PATIENT_B_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM ward_indents WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_A_UID, PATIENT_B_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM admissions WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_A_UID, PATIENT_B_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM investigations WHERE phone IN ($1, $2)`, PHONE_A, PHONE_B,
  ).catch(() => {});
  if (wardId) {
    await prisma.$executeRawUnsafe(`DELETE FROM wards WHERE id = $1::int`, wardId).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
    PATIENT_A_UID, PATIENT_B_UID, DOCTOR_UID, STAFF_UID,
  ).catch(() => {});
}

describe('H1 — list endpoints scope to requested patient/admission (no PHI bleed)', () => {
  const doctor = doctorClient();
  const staff = staffClient();

  beforeAll(async () => {
    await cleanup();

    const a = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'H1 Patient A', 'PATIENT', true, 'active', NOW()) RETURNING id`,
      PATIENT_A_UID, TENANT, PHONE_A);
    patientAId = a[0].id;
    const b = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'H1 Patient B', 'PATIENT', true, 'active', NOW()) RETURNING id`,
      PATIENT_B_UID, TENANT, PHONE_B);
    patientBId = b[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'H1 Doctor', 'DOCTOR', true, 'active', NOW())`,
      DOCTOR_UID, TENANT, DOCTOR_PHONE);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, status, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'H1 Pharmacy Staff', 'PHARMACY_STAFF', true, 'active', NOW())`,
      STAFF_UID, TENANT, STAFF_PHONE);

    // Two investigations for A, one for B.
    await prisma.$executeRawUnsafe(
      `INSERT INTO investigations (uid, phone, patient_id, test_name, test_type, status, requested_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'CBC (A1)', 'LAB', 'REQUESTED', NOW(), NOW()),
              (gen_random_uuid(), $1, $2, 'LFT (A2)', 'LAB', 'REQUESTED', NOW(), NOW())`,
      PHONE_A, patientAId);
    await prisma.$executeRawUnsafe(
      `INSERT INTO investigations (uid, phone, patient_id, test_name, test_type, status, requested_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'X-Ray Chest (B1)', 'RADIOLOGY', 'REQUESTED', NOW(), NOW())`,
      PHONE_B, patientBId);

    // A ward so the indents have a real FK target.
    const w = await prisma.$queryRawUnsafe(
      `INSERT INTO wards (tenant_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $2, 10, NOW(), NOW()) RETURNING id`, TENANT, WARD_NAME);
    wardId = w[0].id;

    const admissions = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, status, admitted_at, ward, updated_at)
       VALUES
         ($1::uuid, $2::uuid, 'admitted', NOW(), $4, NOW()),
         ($1::uuid, $3::uuid, 'admitted', NOW(), $4, NOW())
       RETURNING id, patient_uid, encounter_id`,
      TENANT,
      PATIENT_A_UID,
      PATIENT_B_UID,
      WARD_NAME,
    );
    const admissionARow = admissions.find((row) => row.patient_uid === PATIENT_A_UID);
    const admissionBRow = admissions.find((row) => row.patient_uid === PATIENT_B_UID);
    admissionA = Number(admissionARow.id);
    admissionB = Number(admissionBRow.id);

    const facilities = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM facilities
        WHERE tenant_id = $1::uuid
          AND facility_code = 'SEED-MAIN'
          AND status = 'active'
        LIMIT 1`,
      TENANT,
    );
    if (!facilities[0]?.id) {
      throw new Error('H1 pharmacy list fixture requires the active SEED-MAIN facility');
    }
    const facilityId = Number(facilities[0].id);

    // Two ward indents for admission/patient A, one for admission/patient B.
    const wi = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO ward_indents
           (tenant_id, indent_number, ward_id, status, requested_by, requested_at,
            admission_id, encounter_id, patient_uid, facility_id, updated_at)
         VALUES ($1::uuid, $2, $5, 'requested', $6::uuid, NOW(), $7, $11::uuid, $3::uuid, $13::int, NOW()),
                ($1::uuid, $8, $5, 'requested', $6::uuid, NOW(), $7, $11::uuid, $3::uuid, $13::int, NOW()),
                ($1::uuid, $9, $5, 'requested', $6::uuid, NOW(), $10, $12::uuid, $4::uuid, $13::int, NOW())
         RETURNING id, state_version, status, owner_role_codes`,
        TENANT,
        `WI-H1-A1-${RUN}`,
        PATIENT_A_UID,
        PATIENT_B_UID,
        wardId,
        STAFF_UID,
        admissionA,
        `WI-H1-A2-${RUN}`,
        `WI-H1-B1-${RUN}`,
        admissionB,
        admissionARow.encounter_id,
        admissionBRow.encounter_id,
        facilityId,
      );
      for (const row of rows) {
        await tx.$executeRawUnsafe(
          `INSERT INTO ward_indent_events
             (tenant_id, ward_indent_id, state_version, action, to_status,
              actor_uid, owner_role_codes, details)
           VALUES ($1::uuid, $2::int, $3::int, 'list_filter_fixture', $4,
                   $5::uuid, $6::text[], '{"test_fixture":true}'::jsonb)`,
          TENANT,
          Number(row.id),
          Number(row.state_version),
          row.status,
          STAFF_UID,
          row.owner_role_codes,
        );
      }
      return rows;
    });
    wi.forEach((r) => indentIds.push(r.id));
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  describe('GET /api/v1/investigations/list', () => {
    it('returns ONLY patient A rows when filtered by patient_uid (no bleed)', async () => {
      const res = await doctor.get(
        `/api/v1/investigations/list?patient_uid=${PATIENT_A_UID}&limit=50`);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      const rows = res.body.data.investigations;
      expect(rows.length).toBe(2);
      // Every returned row belongs to patient A...
      rows.forEach((r) => expect(r.patient_id).toBe(patientAId));
      // ...and patient B's row is absent.
      expect(rows.some((r) => r.patient_id === patientBId)).toBe(false);
      expect(res.body.data.pagination.total).toBe(2);
    });

    it('returns ONLY patient B rows when filtered by patient B uid', async () => {
      const res = await doctor.get(
        `/api/v1/investigations/list?patient_uid=${PATIENT_B_UID}&limit=50`);
      expect(res.statusCode).toBe(200);
      const rows = res.body.data.investigations;
      expect(rows.length).toBe(1);
      expect(rows[0].patient_id).toBe(patientBId);
      expect(rows.some((r) => r.patient_id === patientAId)).toBe(false);
    });

    it('fails closed (zero rows) for an unknown patient_uid — never returns all', async () => {
      const res = await doctor.get(
        `/api/v1/investigations/list?patient_uid=b9999999-9999-4999-8999-999999999999&limit=50`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.investigations.length).toBe(0);
    });

    it('rejects a malformed patient_uid with 400, not a 500 (service boundary)', async () => {
      const res = await doctor.get(
        `/api/v1/investigations/list?patient_uid=NOT-A-UUID&limit=50`);
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/pharmacy-orders/ward-indents', () => {
    it('returns ONLY admission A indents when filtered by admission_id (no bleed)', async () => {
      const res = await staff.get(
        `/api/v1/pharmacy-orders/ward-indents?admission_id=${admissionA}&limit=50`);
      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      const rows = res.body.data;
      expect(rows.length).toBe(2);
      rows.forEach((r) => expect(r.admission_id).toBe(admissionA));
      expect(rows.some((r) => r.admission_id === admissionB)).toBe(false);
    });

    it('returns ONLY patient A indents when filtered by patient_uid (no bleed)', async () => {
      const res = await staff.get(
        `/api/v1/pharmacy-orders/ward-indents?patient_uid=${PATIENT_A_UID}&limit=50`);
      expect(res.statusCode).toBe(200);
      const rows = res.body.data;
      expect(rows.length).toBe(2);
      rows.forEach((r) => expect(r.patient_uid).toBe(PATIENT_A_UID));
      expect(rows.some((r) => r.patient_uid === PATIENT_B_UID)).toBe(false);
    });

    it('returns ONLY admission B indent when filtered by admission B', async () => {
      const res = await staff.get(
        `/api/v1/pharmacy-orders/ward-indents?admission_id=${admissionB}&limit=50`);
      expect(res.statusCode).toBe(200);
      const rows = res.body.data;
      expect(rows.length).toBe(1);
      expect(rows[0].admission_id).toBe(admissionB);
      expect(rows.some((r) => r.admission_id === admissionA)).toBe(false);
    });

    it('rejects a malformed patient_uid with 400 (service boundary)', async () => {
      const res = await staff.get(
        `/api/v1/pharmacy-orders/ward-indents?patient_uid=NOT-A-UUID&limit=50`);
      expect(res.statusCode).toBe(400);
    });
  });
});
