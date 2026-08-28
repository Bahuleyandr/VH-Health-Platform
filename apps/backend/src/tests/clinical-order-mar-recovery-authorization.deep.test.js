import { randomUUID } from 'node:crypto';

import request from 'supertest';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import { generateTestToken } from './testClient.js';

const DB_CONFIGURED = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const API_KEY = process.env.API_KEY || 'test-api-key';
const TENANT_ID = DEFAULT_TENANT_ID;
const PATIENT_UID = randomUUID();
const DOCTOR_UID = randomUUID();
const ORDER_CREATE_KEY = `mar-auth-create-${randomUUID()}`;
const IDEMPOTENCY_KEY = `mar-auth-${randomUUID()}`;

function doctorClient() {
  const token = generateTestToken('DOCTOR', {
    uid: DOCTOR_UID,
    id: 991301,
    tenant_id: TENANT_ID,
    deviceType: 'desktop',
  });
  return {
    post: (path) => request(app)
      .post(path)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`),
  };
}

async function cleanup() {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
    await tx.$executeRawUnsafe(
      `DELETE FROM idempotency_keys WHERE user_uid = $1::uuid`,
      DOCTOR_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM medication_administrations WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_orders WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM care_team_members
        WHERE care_team_id IN (
          SELECT id FROM care_teams WHERE patient_uid = $1::uuid
        )`,
      PATIENT_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM care_teams WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM admissions WHERE patient_uid = $1::uuid`,
      PATIENT_UID,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID,
      DOCTOR_UID,
    );
  });
}

d('MED-03 MAR recovery replay authorization', () => {
  let admissionId;
  let orderId;

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES
         ($1::uuid, $2, 'MAR Authorization Patient', 'PATIENT', true, $3::uuid, NOW()),
         ($4::uuid, $5, 'MAR Authorization Doctor', 'DOCTOR', true, $3::uuid, NOW())`,
      PATIENT_UID,
      `+9193${String(Date.now()).slice(-8)}`,
      TENANT_ID,
      DOCTOR_UID,
      `+9194${String(Date.now()).slice(-8)}`,
    );
    const admissions = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, status, allergies, admission_type,
          admitting_doctor, attending_doctor, created_by, admitted_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, 'admitted', ARRAY[]::text[], 'elective',
          $3::uuid, $3::uuid, $3::uuid, NOW(), NOW())
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      DOCTOR_UID,
    );
    admissionId = Number(admissions[0].id);
    const created = await doctorClient().post('/api/v1/emr/orders')
      .set('Idempotency-Key', ORDER_CREATE_KEY)
      .send({
        patient_uid: PATIENT_UID,
        order_type: 'medication',
        priority: 'routine',
        details: {
          medication_name: 'MAR Authorization Medicine',
          dose: '5 mg',
          route: 'oral',
          frequency: 'BD',
          duration_days: 1,
          supply_quantity_per_dose: 1,
        },
      });
    expect(created.statusCode).toBe(201);
    orderId = Number(created.body.data.order?.id ?? created.body.data.id);
    expect(Number.isSafeInteger(orderId)).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('an exact cached retry is denied after the admission relationship is revoked', async () => {
    const doctor = doctorClient();
    const path = `/api/v1/emr/orders/${orderId}/retry-mar-scheduling`;
    const authorshipTeams = await prisma.$queryRawUnsafe(
      `SELECT ct.id
         FROM care_teams ct
         JOIN care_team_members ctm ON ctm.care_team_id = ct.id
        WHERE ct.tenant_id = $1::uuid
          AND ct.patient_uid = $2::uuid
          AND ctm.staff_uid = $3::uuid
          AND ct.admission_id IS NULL
          AND ct.status = 'active'
          AND ctm.status = 'active'`,
      TENANT_ID,
      PATIENT_UID,
      DOCTOR_UID,
    );
    expect(authorshipTeams.length).toBeGreaterThan(0);

    const first = await doctor.post(path)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({});

    expect(first.statusCode).toBe(200);
    expect(first.body).toMatchObject({
      success: true,
      data: {
        order_id: orderId,
        patient_uid: PATIENT_UID,
        status: 'scheduled',
      },
    });

    await prisma.admissions.update({
      where: { id: admissionId },
      data: { status: 'discharged' },
    });

    const replayAfterRevocation = await doctor.post(path)
      .set('Idempotency-Key', IDEMPOTENCY_KEY)
      .send({});

    expect(replayAfterRevocation.statusCode).toBe(403);
    expect(replayAfterRevocation.body.success).toBe(false);

    const newCommandAfterRevocation = await doctor.post(path)
      .set('Idempotency-Key', `${IDEMPOTENCY_KEY}-new`)
      .send({});
    expect(newCommandAfterRevocation.statusCode).toBe(403);
    expect(newCommandAfterRevocation.body.success).toBe(false);
  }, 30_000);
});
