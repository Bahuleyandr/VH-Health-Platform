import request from 'supertest';

import app from '../app.js';
import prisma from '../lib/prisma.js';
import appointmentService from '../services/appointment/appointmentService.js';
import {
  TELECONSULT_OPS_TELEMETRY_FIELDS,
  assertTeleconsultOpsTelemetryAllowlist,
} from '../services/dashboards/teleconsultOpsService.js';
import { createTeleconsultPostConsultPaymentLink } from '../services/billing/paymentLinkService.js';
import { API_KEY, generateTestToken } from './testClient.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = '37200000-0000-4000-8000-0000000000a1';
const TENANT_B = '37200000-0000-4000-8000-0000000000b1';
const PATIENT_A = '37200000-0000-4000-8000-00000000aa01';
const PATIENT_B = '37200000-0000-4000-8000-00000000bb01';
const DOCTOR_A = '37200000-0000-4000-8000-00000000ad01';
const DOCTOR_B = '37200000-0000-4000-8000-00000000bd01';
const ADMIN_A = '37200000-0000-4000-8000-00000000a999';

const TENANTS = [TENANT_A, TENANT_B];
const USER_UIDS = [PATIENT_A, PATIENT_B, DOCTOR_A, DOCTOR_B, ADMIN_A];
const APPT_DATE = '2032-07-06';
const SLOT = '09:40';

let patientAId;
let patientBId;
let doctorAId;
let doctorBId;

function authGet(path, role = 'ADMIN', tenantId = TENANT_A) {
  const token = generateTestToken(role, {
    uid: role === 'ADMIN' ? ADMIN_A : DOCTOR_A,
    tenant_id: tenantId,
  });
  return request(app)
    .get(path)
    .set('x-api-key', API_KEY)
    .set('Authorization', `Bearer ${token}`);
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM billing_payment_links WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A, TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM billing_invoice_items WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A, TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM billing_invoices WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A, TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM video_sessions WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A, TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM teleconsultations WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A, TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM care_team_members WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A, TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM care_teams WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A, TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM appointments WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A, TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM appointment_queues WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_A, TENANT_B,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)`,
    ...USER_UIDS,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`,
    TENANT_A, TENANT_B,
  ).catch(() => {});
}

async function seedTenant(id, slug, settings = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO tenants (id, slug, name, settings)
     VALUES ($1::uuid, $2, $3, $4::jsonb)
     ON CONFLICT (id) DO UPDATE
       SET slug = EXCLUDED.slug,
           name = EXCLUDED.name,
           settings = EXCLUDED.settings,
           status = 'active',
           updated_at = NOW()`,
    id,
    slug,
    `NL3 P4 ${slug}`,
    JSON.stringify(settings),
  );
}

async function seedUser({ uid, tenantId, phone, name, role }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, registered_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, true, NOW(), NOW())
     RETURNING id, uid::text AS uid`,
    uid,
    tenantId,
    phone,
    name,
    role,
  );
  return rows[0];
}

async function seedAppointment({ tenantId = TENANT_A, patientId = patientAId, doctorId = doctorAId, date = APPT_DATE, slot = '11:20' } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO appointments
       (phone, patient_id, patient_name, doctor_id, doctor_name,
        appointment_date, appointment_time, status, visit_type, tenant_id, created_at, updated_at)
     VALUES ($1, $2::int, 'NL3 P4 Patient', $3::int, 'Dr NL3 P4',
             $4::date, $5, 'SCHEDULED', 'TELE', $6::uuid, NOW(), NOW())
     RETURNING id`,
    '+919099990001',
    patientId,
    doctorId,
    date,
    slot,
    tenantId,
  );
  return rows[0].id;
}

async function seedTeleconsultation({ tenantId, appointmentId, patientUid, doctorUid, status = 'completed', consultType = 'video' }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO teleconsultations
       (tenant_id, appointment_id, patient_uid, doctor_uid, status, consult_type,
        scheduled_start, actual_end, remote_consent_id, remote_consent_signed_at, metadata)
     VALUES ($1::uuid, $2::int, $3::uuid, $4::uuid, $5::text, $6::text,
             NOW(), CASE WHEN $5::text = 'completed' THEN NOW() ELSE NULL END,
             'consent-nl3-p4', NOW(), '{"final_modality":"video"}'::jsonb)
     RETURNING id`,
    tenantId,
    appointmentId,
    patientUid,
    doctorUid,
    status,
    consultType,
  );
  return rows[0].id;
}

async function seedVideoSession({ tenantId, teleconsultationId, status = 'active', turnUsed = true } = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO video_sessions
       (tenant_id, teleconsultation_id, provider, patient_join_url, doctor_join_url,
        status, metadata, created_at, updated_at)
     VALUES ($1::uuid, $2::int, 'other',
             'https://patient-token.example.invalid/secret',
             'https://doctor-token.example.invalid/secret',
             $3, $4::jsonb, NOW(), NOW())`,
    tenantId,
    teleconsultationId,
    status,
    JSON.stringify(turnUsed ? { turn_used: true, ice_transport: 'relay' } : { ice_transport: 'udp' }),
  );
}

async function seedLinkedInvoice({ tenantId, patientUid, patientPhone, appointmentId, sourceRefType = 'appointment' }) {
  const invoiceRows = await prisma.$queryRawUnsafe(
    `INSERT INTO billing_invoices
       (patient_uid, patient_phone, patient_name, invoice_type, total_amount,
        amount_due, status, tenant_id, created_at, updated_at)
     VALUES ($1::uuid, $2, 'NL3 P4 Patient', 'OP', 750.00, 750.00,
             'ISSUED', $3::uuid, NOW(), NOW())
     RETURNING id`,
    patientUid,
    patientPhone,
    tenantId,
  );
  const invoiceId = invoiceRows[0].id;
  await prisma.$executeRawUnsafe(
    `INSERT INTO billing_invoice_items
       (invoice_id, description, quantity, unit_price, line_subtotal, line_total,
        source_ref_type, source_ref_id, tenant_id)
     VALUES ($1::int, 'Teleconsult professional fee', 1, 750.00, 750.00,
             750.00, $2, $3::int, $4::uuid)`,
    invoiceId,
    sourceRefType,
    appointmentId,
    tenantId,
  );
  return invoiceId;
}

d('NL-3 P4 teleconsult operational wrap-up deep coverage', () => {
  const originalEnv = {};

  beforeAll(async () => {
    originalEnv.HOSPITAL_UPI_VPA = process.env.HOSPITAL_UPI_VPA;
    originalEnv.HOSPITAL_UPI_PAYEE_NAME = process.env.HOSPITAL_UPI_PAYEE_NAME;
    originalEnv.HOSPITAL_PAY_BASE_URL = process.env.HOSPITAL_PAY_BASE_URL;
    originalEnv.WHATSAPP_PROVIDER = process.env.WHATSAPP_PROVIDER;

    process.env.HOSPITAL_UPI_VPA = 'vh-test@upi';
    process.env.HOSPITAL_UPI_PAYEE_NAME = 'VH Test Hospital';
    process.env.HOSPITAL_PAY_BASE_URL = 'https://pay.vhhealth.test/pay';
    process.env.WHATSAPP_PROVIDER = 'logger';

    await cleanup();
    await seedTenant(TENANT_A, 'nl3-p4-a', {
      teleconsultPayments: { enabled: true, channels: ['sms'], expiresInHours: 24 },
    });
    await seedTenant(TENANT_B, 'nl3-p4-b', {});

    patientAId = (await seedUser({
      uid: PATIENT_A,
      tenantId: TENANT_A,
      phone: '+919099990001',
      name: 'NL3 P4 Patient A',
      role: 'PATIENT',
    })).id;
    patientBId = (await seedUser({
      uid: PATIENT_B,
      tenantId: TENANT_B,
      phone: '+919099990002',
      name: 'NL3 P4 Patient B',
      role: 'PATIENT',
    })).id;
    doctorAId = (await seedUser({
      uid: DOCTOR_A,
      tenantId: TENANT_A,
      phone: '+919099990101',
      name: 'Dr NL3 P4 A',
      role: 'DOCTOR',
    })).id;
    doctorBId = (await seedUser({
      uid: DOCTOR_B,
      tenantId: TENANT_B,
      phone: '+919099990102',
      name: 'Dr NL3 P4 B',
      role: 'DOCTOR',
    })).id;
    await seedUser({
      uid: ADMIN_A,
      tenantId: TENANT_A,
      phone: '+919099990999',
      name: 'NL3 P4 Admin',
      role: 'ADMIN',
    });
  }, 30000);

  afterAll(async () => {
    await cleanup();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await prisma.$disconnect().catch(() => {});
  }, 30000);

  afterEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM billing_payment_links WHERE tenant_id IN ($1::uuid, $2::uuid)`, TENANT_A, TENANT_B).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM billing_invoice_items WHERE tenant_id IN ($1::uuid, $2::uuid)`, TENANT_A, TENANT_B).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM billing_invoices WHERE tenant_id IN ($1::uuid, $2::uuid)`, TENANT_A, TENANT_B).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM video_sessions WHERE tenant_id IN ($1::uuid, $2::uuid)`, TENANT_A, TENANT_B).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM teleconsultations WHERE tenant_id IN ($1::uuid, $2::uuid)`, TENANT_A, TENANT_B).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM care_team_members WHERE tenant_id IN ($1::uuid, $2::uuid)`, TENANT_A, TENANT_B).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM care_teams WHERE tenant_id IN ($1::uuid, $2::uuid)`, TENANT_A, TENANT_B).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM appointments WHERE tenant_id IN ($1::uuid, $2::uuid)`, TENANT_A, TENANT_B).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM appointment_queues WHERE tenant_id IN ($1::uuid, $2::uuid)`, TENANT_A, TENANT_B).catch(() => {});
  }, 30000);

  test('booking a TELE appointment uses the normal slot guard', async () => {
    const first = await appointmentService.createAppointment({
      patient_id: patientAId,
      doctor_id: doctorAId,
      appointment_date: APPT_DATE,
      appointment_time: SLOT,
      reason: 'Synthetic NL3 P4 teleconsult',
      visit_type: 'TELE',
      tenant_id: TENANT_A,
      created_by: ADMIN_A,
    });

    expect(first.visit_type).toBe('TELE');
    expect(first.appointment_queue?.queue_kind).not.toBe('teleconsult');

    await expect(appointmentService.createAppointment({
      patient_id: patientAId,
      doctor_id: doctorAId,
      appointment_date: APPT_DATE,
      appointment_time: SLOT,
      reason: 'Synthetic duplicate NL3 P4 teleconsult',
      visit_type: 'TELE',
      tenant_id: TENANT_A,
      created_by: ADMIN_A,
    })).rejects.toMatchObject({ isConflict: true });
  });

  test('teleconsult ops dashboard endpoint is role-gated, tenant-scoped, and PHI-minimized', async () => {
    const apptA = await seedAppointment({ tenantId: TENANT_A, patientId: patientAId, doctorId: doctorAId, slot: '12:10' });
    const apptB = await seedAppointment({ tenantId: TENANT_B, patientId: patientBId, doctorId: doctorBId, slot: '12:10' });
    const consultA = await seedTeleconsultation({
      tenantId: TENANT_A,
      appointmentId: apptA,
      patientUid: PATIENT_A,
      doctorUid: DOCTOR_A,
      status: 'waiting',
    });
    const consultB = await seedTeleconsultation({
      tenantId: TENANT_B,
      appointmentId: apptB,
      patientUid: PATIENT_B,
      doctorUid: DOCTOR_B,
      status: 'failed',
    });
    await seedVideoSession({ tenantId: TENANT_A, teleconsultationId: consultA, status: 'active', turnUsed: true });
    await seedVideoSession({ tenantId: TENANT_B, teleconsultationId: consultB, status: 'failed', turnUsed: false });

    const forbidden = await authGet('/api/v1/dashboards/snapshot/teleconsult-ops', 'DOCTOR', TENANT_A);
    expect(forbidden.statusCode).toBe(403);

    const res = await authGet('/api/v1/dashboards/snapshot/teleconsult-ops?window_hours=24', 'ADMIN', TENANT_A);
    expect(res.statusCode).toBe(200);
    const payload = res.body.data;
    expect(Object.keys(payload).sort()).toEqual([...TELECONSULT_OPS_TELEMETRY_FIELDS].sort());
    expect(() => assertTeleconsultOpsTelemetryAllowlist(payload)).not.toThrow();
    expect(payload.teleconsult_count).toBe(1);
    expect(payload.waiting_count).toBe(1);
    expect(payload.join_failure_count).toBe(0);
    expect(payload.turn_session_count).toBe(1);
    expect(payload.queue_model).toBe('doctor_department_badge');
    expect(payload.recording_enabled).toBe(false);

    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(PATIENT_A);
    expect(serialized).not.toContain(DOCTOR_A);
    expect(serialized).not.toContain('patient-token.example.invalid');
    expect(serialized).not.toContain('doctor-token.example.invalid');
    expect(serialized).not.toMatch(/patient_uid|doctor_uid|patient_phone|patient_name|doctor_name|token|url|complaint/i);
  });

  test('post-consult payment hook only fires for configured tenants and linked invoices', async () => {
    const apptA = await seedAppointment({ tenantId: TENANT_A, patientId: patientAId, doctorId: doctorAId, slot: '13:10' });
    const consultA = await seedTeleconsultation({
      tenantId: TENANT_A,
      appointmentId: apptA,
      patientUid: PATIENT_A,
      doctorUid: DOCTOR_A,
      status: 'completed',
    });
    const invoiceA = await seedLinkedInvoice({
      tenantId: TENANT_A,
      patientUid: PATIENT_A,
      patientPhone: '+919099990001',
      appointmentId: apptA,
    });

    const created = await createTeleconsultPostConsultPaymentLink({
      tenantId: TENANT_A,
      teleconsultation_id: consultA,
      channels: ['sms'],
      created_by: ADMIN_A,
    });
    expect(created.status).toBe('created');
    expect(created.invoice_id).toBe(invoiceA);
    expect(created.link.invoice_id).toBe(invoiceA);
    expect(created.link.status).toBe('sent');
    expect(created.link.sent_via_sms_at).toBeTruthy();

    const reused = await createTeleconsultPostConsultPaymentLink({
      tenantId: TENANT_A,
      teleconsultation_id: consultA,
      channels: ['sms'],
      created_by: ADMIN_A,
    });
    expect(reused.status).toBe('reused');
    const linkCount = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM billing_payment_links
        WHERE tenant_id = $1::uuid AND invoice_id = $2::int`,
      TENANT_A,
      invoiceA,
    );
    expect(linkCount[0].n).toBe(1);

    const apptB = await seedAppointment({ tenantId: TENANT_B, patientId: patientBId, doctorId: doctorBId, slot: '13:20' });
    const consultB = await seedTeleconsultation({
      tenantId: TENANT_B,
      appointmentId: apptB,
      patientUid: PATIENT_B,
      doctorUid: DOCTOR_B,
      status: 'completed',
    });
    const invoiceB = await seedLinkedInvoice({
      tenantId: TENANT_B,
      patientUid: PATIENT_B,
      patientPhone: '+919099990002',
      appointmentId: apptB,
    });
    const notConfigured = await createTeleconsultPostConsultPaymentLink({
      tenantId: TENANT_B,
      teleconsultation_id: consultB,
      channels: ['sms'],
    });
    expect(notConfigured).toMatchObject({ status: 'skipped', reason: 'tenant_not_configured' });
    const tenantBLinks = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM billing_payment_links
        WHERE tenant_id = $1::uuid AND invoice_id = $2::int`,
      TENANT_B,
      invoiceB,
    );
    expect(tenantBLinks[0].n).toBe(0);

    const unlinkedAppt = await seedAppointment({ tenantId: TENANT_A, patientId: patientAId, doctorId: doctorAId, slot: '13:30' });
    const unlinkedConsult = await seedTeleconsultation({
      tenantId: TENANT_A,
      appointmentId: unlinkedAppt,
      patientUid: PATIENT_A,
      doctorUid: DOCTOR_A,
      status: 'completed',
    });
    await seedLinkedInvoice({
      tenantId: TENANT_A,
      patientUid: PATIENT_A,
      patientPhone: '+919099990001',
      appointmentId: unlinkedAppt,
      sourceRefType: 'manual',
    });
    await expect(createTeleconsultPostConsultPaymentLink({
      tenantId: TENANT_A,
      teleconsultation_id: unlinkedConsult,
      channels: ['sms'],
    })).resolves.toMatchObject({ status: 'skipped', reason: 'invoice_not_linked' });
  });
});
