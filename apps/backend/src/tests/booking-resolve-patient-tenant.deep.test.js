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

let patientAId; let patientBId; let tenantABookingId;

async function seedPatient(uid, tenantId, phone) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
     VALUES ($1::uuid,$2::uuid,$3,'Booking Tenant Patient','PATIENT',true,NOW())
     RETURNING id`, uid, tenantId, phone);
  return Number(rows[0].id);
}

async function clean() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid IN ($1::uuid,$2::uuid)`,
    PATIENT_A, PATIENT_B).catch(() => {});
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
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name) VALUES ($1::uuid, 'can032-tenant-b', 'CAN-032 Tenant B') ON CONFLICT (id) DO NOTHING`,
      TENANT_B);
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
    expect(res.statusCode).toBe(200);
    const bookingId = res.body?.data?.id;
    tenantABookingId = bookingId;
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
          AND event_type = 'investigation.booking_created'
          AND source_table = 'investigation_bookings' AND source_id = $3`,
      TENANT_A, PATIENT_A, String(bookingId),
    );
    const audit = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_audit_events
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
          AND action = 'investigation.booking_created'
          AND resource_table = 'investigation_bookings' AND resource_id = $3`,
      TENANT_A, PATIENT_A, String(bookingId),
    );
    expect(timeline).toHaveLength(1);
    expect(audit).toHaveLength(1);
  });

  it('records each staff booking transition in the canonical timeline and audit', async () => {
    const confirm = await doctor(TENANT_A).post(
      `/api/v1/investigations/bookings/${tenantABookingId}/confirm`,
      { actual_tests: [], final_cost: 500, confirmation_notes: 'Confirmed by lab' },
    );
    expect(confirm.statusCode).toBe(200);

    const dispatch = await doctor(TENANT_A).post(
      `/api/v1/investigations/bookings/${tenantABookingId}/dispatch`,
      { assigned_collector: 1, notes: 'Collector dispatched' },
    );
    expect(dispatch.statusCode).toBe(200);

    const collected = await doctor(TENANT_A).post(
      `/api/v1/investigations/bookings/${tenantABookingId}/collected`,
      { collection_notes: 'Sample received intact' },
    );
    expect(collected.statusCode).toBe(200);

    const processing = await doctor(TENANT_A).post(
      `/api/v1/investigations/bookings/${tenantABookingId}/processing`,
      {},
    );
    expect(processing.statusCode).toBe(200);

    const expectedEvents = [
      'investigation.booking_created',
      'investigation.booking_confirmed',
      'investigation.collector_dispatched',
      'investigation.sample_collected',
      'investigation.processing_started',
    ];
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT event_type FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
          AND source_table = 'investigation_bookings' AND source_id = $3
        ORDER BY occurred_at`,
      TENANT_A, PATIENT_A, String(tenantABookingId),
    );
    const audit = await prisma.$queryRawUnsafe(
      `SELECT action FROM clinical_audit_events
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
          AND resource_table = 'investigation_bookings' AND resource_id = $3
        ORDER BY occurred_at`,
      TENANT_A, PATIENT_A, String(tenantABookingId),
    );
    expect(timeline.map((row) => row.event_type)).toEqual(expectedEvents);
    expect(audit.map((row) => row.action)).toEqual(expectedEvents);
  });
});
