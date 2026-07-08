import request from 'supertest';

import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = '00000000-0000-4000-8000-000000000001';
const TENANT_B = '00000000-0000-4000-8000-0000000a0431';
const PATIENT_A_UID = '00000000-0000-4000-8000-0000000b0431';
const PATIENT_B_UID = '00000000-0000-4000-8000-0000000c0431';
const STAFF_UID = '00000000-0000-4000-8000-0000000d0431';
const ADMIN_UID = '00000000-0000-4000-8000-0000000e0431';
const PATIENT_A_PHONE = '+919000431001';
const PATIENT_B_PHONE = '+919000431002';
const DEPARTMENT = 'NL8 P1 OPD';
const DEPARTMENT_KEY = 'nl8_p1_opd';
const TEST_MARKER = 'nl8-p1-kiosk';

function client(role, { uid, id = 431001, tenantId = TENANT_A, phone = '+919000431999' } = {}) {
  const token = generateTestToken(role, {
    uid,
    id,
    phone,
    tenant_id: tenantId,
  });
  return {
    get: (path) => request(app).get(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    post: (path) => request(app).post(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
    put: (path) => request(app).put(path).set('x-api-key', API_KEY).set('Authorization', `Bearer ${token}`),
  };
}

function futureDate(days = 21) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_flow_checkins
      WHERE patient_uid IN ($1::uuid, $2::uuid)`,
    PATIENT_A_UID,
    PATIENT_B_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM appointments
      WHERE phone IN ($1, $2)
         OR patient_id IN (
           SELECT id FROM users WHERE uid IN ($3::uuid, $4::uuid)
         )`,
    PATIENT_A_PHONE,
    PATIENT_B_PHONE,
    PATIENT_A_UID,
    PATIENT_B_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM appointment_queue_status_history
      WHERE metadata->>'source' IN ('kiosk_self', 'kiosk_supervised')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM appointment_queues
      WHERE metadata->>'source' IN ('kiosk_self', 'kiosk_supervised')`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_flow_kiosk_sessions
      WHERE tenant_id IN ($1::uuid, $2::uuid)
        AND (metadata->>'test' = $3 OR department_key = $4)`,
    TENANT_A,
    TENANT_B,
    TEST_MARKER,
    DEPARTMENT_KEY,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_flow_kiosk_settings
      WHERE tenant_id IN ($1::uuid, $2::uuid)
        AND department_key = $3`,
    TENANT_A,
    TENANT_B,
    DEPARTMENT_KEY,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users
      WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
    PATIENT_A_UID,
    PATIENT_B_UID,
    STAFF_UID,
    ADMIN_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    TENANT_B,
  ).catch(() => {});
}

async function seedUser({ uid, tenantId, phone, name, role }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (tenant_id, uid, phone, name, role, birthday, is_active, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, '1990-04-30'::date, true, NOW())
     RETURNING id`,
    tenantId,
    uid,
    phone,
    name,
    role,
  );
  return rows[0].id;
}

async function seedAppointment({
  tenantId = TENANT_A,
  patientId,
  phone,
  dayOffset,
  status = 'CONFIRMED',
  tokenNumber,
}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO appointments (
       tenant_id, phone, patient_id, patient_name, doctor_name,
       appointment_date, appointment_time, status, reason, token_number,
       department, visit_type, created_at, updated_at
     )
     VALUES (
       $1::uuid, $2, $3::int, 'NL8 P1 Patient', 'Dr NL8 P1',
       $4::date, '09:30', $5, 'NL8 P1 kiosk check-in', $6,
       $7, 'NEW', NOW(), NOW()
     )
     RETURNING id, status`,
    tenantId,
    phone,
    patientId,
    futureDate(dayOffset),
    status,
    tokenNumber,
    DEPARTMENT,
  );
  return rows[0];
}

d('NL8 P1 kiosk self-check-in', () => {
  let patientAId;
  let patientBId;
  let staff;
  let admin;
  let patientA;

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'nl8-p1-tenant-b', 'NL8 P1 Tenant B')
       ON CONFLICT (id) DO NOTHING`,
      TENANT_B,
    );
    patientAId = await seedUser({
      uid: PATIENT_A_UID,
      tenantId: TENANT_A,
      phone: PATIENT_A_PHONE,
      name: 'NL8 P1 Patient A',
      role: 'PATIENT',
    });
    patientBId = await seedUser({
      uid: PATIENT_B_UID,
      tenantId: TENANT_B,
      phone: PATIENT_B_PHONE,
      name: 'NL8 P1 Patient B',
      role: 'PATIENT',
    });
    const staffId = await seedUser({
      uid: STAFF_UID,
      tenantId: TENANT_A,
      phone: '+919000431003',
      name: 'NL8 P1 Receptionist',
      role: 'RECEPTIONIST',
    });
    const adminId = await seedUser({
      uid: ADMIN_UID,
      tenantId: TENANT_A,
      phone: '+919000431004',
      name: 'NL8 P1 Admin',
      role: 'ADMIN',
    });

    staff = client('RECEPTIONIST', { uid: STAFF_UID, id: staffId, tenantId: TENANT_A, phone: '+919000431003' });
    admin = client('ADMIN', { uid: ADMIN_UID, id: adminId, tenantId: TENANT_A, phone: '+919000431004' });
    patientA = client('PATIENT', { uid: PATIENT_A_UID, id: patientAId, tenantId: TENANT_A, phone: PATIENT_A_PHONE });

    const setting = await admin.put(`/api/v1/patient-flow/kiosk/settings/${DEPARTMENT_KEY}`).send({
      self_service_enabled: true,
      supervised_mode_enabled: true,
      qr_otp_required: true,
      safe_profile_fields: ['address', 'email', 'preferred_language', 'emergency_contact'],
      metadata: { test: TEST_MARKER },
    });
    expect(setting.statusCode).toBe(200);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  test('records staff-supervised arrival without changing appointment workflow status', async () => {
    const appointment = await seedAppointment({
      patientId: patientAId,
      phone: PATIENT_A_PHONE,
      dayOffset: 21,
      tokenNumber: '431-A',
    });

    const res = await staff.post('/api/v1/patient-flow/checkins/supervised').send({
      appointmentId: appointment.id,
      acknowledgements: ['front_office_arrival_confirmed'],
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.checkin).toMatchObject({
      status: 'checked_in',
      channel: 'kiosk_supervised',
      identity_method: 'staff_supervised',
      front_desk_required: false,
    });
    expect(res.body.data.queue.queue_id).toBeDefined();

    const rows = await prisma.$queryRawUnsafe(
      `SELECT status, queue_id FROM appointments WHERE id = $1::int`,
      appointment.id,
    );
    expect(rows[0].status).toBe('CONFIRMED');
    expect(rows[0].queue_id).toBeTruthy();
  });

  test('accepts patient JWT plus signed kiosk session, not raw phone or DOB proof', async () => {
    const rawProof = await patientA.post('/api/v1/patient-flow/checkins/patient').send({
      phone: PATIENT_A_PHONE,
      dateOfBirth: '1990-04-30',
    });
    expect(rawProof.statusCode).toBe(400);
    expect(rawProof.body.message).toMatch(/raw phone or DOB cannot check in/i);

    const appointment = await seedAppointment({
      patientId: patientAId,
      phone: PATIENT_A_PHONE,
      dayOffset: 22,
      tokenNumber: '431-B',
    });
    const session = await staff.post('/api/v1/patient-flow/kiosk/sessions').send({
      department: DEPARTMENT,
      channel: 'kiosk_self',
      device_label: 'NL8 P1 test kiosk',
      ttl_minutes: 10,
      metadata: { test: TEST_MARKER },
    });
    expect(session.statusCode).toBe(201);

    const res = await patientA.post('/api/v1/patient-flow/checkins/patient').send({
      appointmentId: appointment.id,
      kioskSessionToken: session.body.data.token,
      profileDelta: {
        address: 'Updated kiosk-safe address',
        preferred_language: 'en',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.checkin).toMatchObject({
      status: 'checked_in',
      channel: 'kiosk_self',
      identity_method: 'qr_plus_otp',
      front_desk_required: false,
    });
    const users = await prisma.$queryRawUnsafe(
      `SELECT address, preferred_language FROM users WHERE uid = $1::uuid`,
      PATIENT_A_UID,
    );
    expect(users[0]).toMatchObject({
      address: 'Updated kiosk-safe address',
      preferred_language: 'en',
    });
  });

  test('routes blocked profile fields to front desk instead of overwriting identity data', async () => {
    const appointment = await seedAppointment({
      patientId: patientAId,
      phone: PATIENT_A_PHONE,
      dayOffset: 23,
      tokenNumber: '431-C',
    });
    const session = await staff.post('/api/v1/patient-flow/kiosk/sessions').send({
      department: DEPARTMENT,
      channel: 'kiosk_self',
      metadata: { test: TEST_MARKER },
    });

    const res = await patientA.post('/api/v1/patient-flow/checkins/patient').send({
      appointmentId: appointment.id,
      kioskSessionToken: session.body.data.token,
      profileDelta: {
        name: 'Not allowed from kiosk',
      },
    });

    expect(res.statusCode).toBe(202);
    expect(res.body.data.checkin).toMatchObject({
      status: 'front_desk_required',
      front_desk_required: true,
    });
    expect(res.body.data.checkin.profile_delta_summary.blocked_fields).toContain('name');
  });

  test('role gates supervised mode and rejects cross-tenant appointment lookup', async () => {
    const appointmentA = await seedAppointment({
      patientId: patientAId,
      phone: PATIENT_A_PHONE,
      dayOffset: 24,
      tokenNumber: '431-D',
    });
    const patientForbidden = await patientA.post('/api/v1/patient-flow/checkins/supervised').send({
      appointmentId: appointmentA.id,
    });
    expect(patientForbidden.statusCode).toBe(403);

    const appointmentB = await seedAppointment({
      tenantId: TENANT_B,
      patientId: patientBId,
      phone: PATIENT_B_PHONE,
      dayOffset: 24,
      tokenNumber: '431-X',
    });
    const crossTenant = await patientA.post('/api/v1/patient-flow/checkins/patient').send({
      appointmentId: appointmentB.id,
    });
    expect(crossTenant.statusCode).toBe(404);
  });
});
