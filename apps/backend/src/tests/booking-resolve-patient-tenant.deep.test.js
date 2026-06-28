// Investigation booking patient-resolution tenant scope (CAN-032).
//
// resolveBookingPatient looked patients up by id/phone with no tenant filter, so
// a staff caller could attach a booking to a patient in another tenant. The
// lookups (and the new-patient create + the booking insert) are now tenant
// scoped. RLS is OFF in the test env, so this explicit predicate is what scopes:
// a tenant-A clinician booking by a tenant-B patient_id gets 404, while booking
// for a tenant-A patient resolves.
import { generateTestToken, API_KEY } from './testClient.js';
import prisma from '../lib/prisma.js';
import request from 'supertest';
import app from '../app.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const PATIENT_A = 'c0de0032-00a0-4000-8000-0000000000a1';
const PATIENT_B = 'c0de0032-00b0-4000-8000-0000000000b1';

function doctor(tenantId) {
  const t = generateTestToken('DOCTOR', { uid: 'c0de0032-00d0-4000-8000-00000000d001', tenant_id: tenantId });
  return {
    post: (p, body) => request(app).post(p)
      .set('x-api-key', API_KEY).set('Authorization', `Bearer ${t}`).send(body),
  };
}

let patientAId; let patientBId;

async function seedPatient(uid, tenantId, phone) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid,$2::uuid,$3,'Booking Tenant Patient','PATIENT',true,NOW())
     RETURNING id`, uid, tenantId, phone);
  return Number(rows[0].id);
}

async function clean() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM investigation_booking_history WHERE booking_id IN (
       SELECT id FROM investigation_bookings WHERE patient_id IN (
         SELECT id FROM users WHERE uid IN ($1::uuid,$2::uuid)))`, PATIENT_A, PATIENT_B).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM investigation_bookings WHERE patient_id IN (
       SELECT id FROM users WHERE uid IN ($1::uuid,$2::uuid))`, PATIENT_A, PATIENT_B).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid,$2::uuid)`, PATIENT_A, PATIENT_B).catch(() => {});
}

d('Booking patient-resolution tenant scope (CAN-032)', () => {
  beforeAll(async () => {
    await clean();
    patientAId = await seedPatient(PATIENT_A, TENANT_A, '+919000032701');
    patientBId = await seedPatient(PATIENT_B, TENANT_B, '+919000032702');
  }, 30000);
  afterAll(async () => { await clean(); await prisma.$disconnect().catch(() => {}); }, 30000);

  it('a tenant-A clinician cannot book for a tenant-B patient_id (404)', async () => {
    const res = await doctor(TENANT_A).post('/api/v1/investigations/bookings/create',
      { patient_id: patientBId, custom_test_names: 'CBC' });
    expect(res.statusCode).toBe(404);
  });

  it('a tenant-A clinician can book for a tenant-A patient (resolves)', async () => {
    const res = await doctor(TENANT_A).post('/api/v1/investigations/bookings/create',
      { patient_id: patientAId, custom_test_names: 'CBC' });
    expect(res.statusCode).not.toBe(404);
  });
});
