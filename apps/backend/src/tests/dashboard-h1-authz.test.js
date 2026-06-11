// Regression tests for audit finding H1 (2026-06-10).
// The patient dashboard previously sat in front of the JWT gate, keyed every
// query on a caller-supplied ?phone=, and had no tenant scoping — letting
// anyone with the static API key enumerate PHI (name, appointment dates,
// doctor name, loyalty tier) for any phone number.
//
// These tests prove:
//   1. No JWT → 401 (API key alone is no longer sufficient).
//   2. Non-PATIENT roles → 403 (role gate).
//   3. PATIENT token → 200 with the caller's OWN data only.
//   4. ?phone= of another patient → 403 (enumeration blocked).
//   5. ?phone= equal to the caller's own → 200 (legacy clients keep working).
//   6. Appointments in another tenant for the same phone are NOT counted
//      (tenant scoping).

import request from 'supertest';
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import app from '../app.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_TENANT_ID = 'd1111111-1111-4111-8111-111111111101';

const PATIENT_UID = 'd1111111-1111-4111-8111-111111111d01';
const OTHER_PATIENT_UID = 'd1111111-1111-4111-8111-111111111d02';
const PATIENT_PHONE = '+919000080001';
const OTHER_PHONE = '+919000080002';

function authedGet(path, token) {
  return request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`);
}

function futureDateISO(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

describe('GET /api/v1/dashboard — H1 authz + scoping', () => {
  let patientToken, otherPatientToken;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, 'h1-other-tenant', 'H1 Other Tenant', 'IN', 'DPDP', 'active')
       ON CONFLICT (id) DO NOTHING`,
      OTHER_TENANT_ID
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE phone IN ($1, $2)`,
      PATIENT_PHONE, OTHER_PHONE
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID, OTHER_PATIENT_UID
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'H1 Dashboard Patient', 'PATIENT', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, DEFAULT_TENANT_ID
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'H1 Other Patient', 'PATIENT', true, $3::uuid, NOW())`,
      OTHER_PATIENT_UID, OTHER_PHONE, DEFAULT_TENANT_ID
    );

    // Two upcoming appointments in the caller's tenant…
    await prisma.$executeRawUnsafe(
      `INSERT INTO appointments (phone, doctor_name, appointment_date, appointment_time, status, tenant_id, updated_at)
       VALUES ($1, 'Dr H1 Own', $2::date, '10:00', 'SCHEDULED', $3::uuid, NOW()),
              ($1, 'Dr H1 Own', $4::date, '11:00', 'SCHEDULED', $3::uuid, NOW())`,
      PATIENT_PHONE, futureDateISO(30), DEFAULT_TENANT_ID, futureDateISO(60)
    );
    // …and one for the SAME phone in another tenant, which must never be visible.
    await prisma.$executeRawUnsafe(
      `INSERT INTO appointments (phone, doctor_name, appointment_date, appointment_time, status, tenant_id, updated_at)
       VALUES ($1, 'Dr H1 Foreign', $2::date, '12:00', 'SCHEDULED', $3::uuid, NOW())`,
      PATIENT_PHONE, futureDateISO(45), OTHER_TENANT_ID
    );

    patientToken = generateTestToken('PATIENT', {
      uid: PATIENT_UID, id: null, phone: PATIENT_PHONE, tenant_id: DEFAULT_TENANT_ID,
    });
    otherPatientToken = generateTestToken('PATIENT', {
      uid: OTHER_PATIENT_UID, id: null, phone: OTHER_PHONE, tenant_id: DEFAULT_TENANT_ID,
    });
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE phone IN ($1, $2)`, PATIENT_PHONE, OTHER_PHONE);
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, OTHER_PATIENT_UID);
  });

  test('no JWT → 401 even with a valid API key', async () => {
    const res = await request(app)
      .get(`/api/v1/dashboard?phone=${encodeURIComponent(PATIENT_PHONE)}`)
      .set('x-api-key', API_KEY);
    expect(res.statusCode).toBe(401);
  });

  test('non-PATIENT role (DOCTOR) → 403', async () => {
    const doctorToken = generateTestToken('DOCTOR', {
      uid: PATIENT_UID, phone: PATIENT_PHONE, tenant_id: DEFAULT_TENANT_ID,
    });
    const res = await authedGet('/api/v1/dashboard', doctorToken);
    expect(res.statusCode).toBe(403);
  });

  test('PATIENT token, no phone param → 200 with own data', async () => {
    const res = await authedGet('/api/v1/dashboard', patientToken);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.name).toBe('H1 Dashboard Patient');
    expect(res.body.data.upcomingCount).toBe(2); // not 3 — foreign-tenant row excluded
  });

  test('PATIENT token + own phone param → 200 (legacy client path)', async () => {
    const res = await authedGet(
      `/api/v1/dashboard?phone=${encodeURIComponent(PATIENT_PHONE)}`, patientToken);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.name).toBe('H1 Dashboard Patient');
  });

  test("PATIENT token + ANOTHER patient's phone → 403, no data leaked", async () => {
    const res = await authedGet(
      `/api/v1/dashboard?phone=${encodeURIComponent(PATIENT_PHONE)}`, otherPatientToken);
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain('H1 Dashboard Patient');
  });

  test('tenant scoping: foreign-tenant appointment for same phone is invisible', async () => {
    const res = await authedGet('/api/v1/dashboard', patientToken);
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('Dr H1 Foreign');
  });
});
