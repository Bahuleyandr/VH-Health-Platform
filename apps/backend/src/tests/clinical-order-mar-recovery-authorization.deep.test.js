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
const ENCOUNTER_ID = randomUUID();
const CATALOG_NAME = `MAR Authorization Medicine ${randomUUID().slice(0, 8)}`;
const COMPOSITION_KEY = `mar_authorization_${randomUUID().replace(/-/g, '')}`;
const WARD_NAME = `MAR Authorization Ward ${randomUUID().slice(0, 8)}`;
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
    for (const table of ['tasks', 'workflow_sla_instances']) {
      await tx.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
        TENANT_ID,
        PATIENT_UID
      );
    }
    for (const table of [
      'ward_indent_inventory_allocations',
      'ward_indent_events',
      'ward_indent_items'
    ]) {
      await tx.$executeRawUnsafe(
        `DELETE FROM ${table}
          WHERE tenant_id = $1::uuid
            AND ward_indent_id IN (
              SELECT id FROM ward_indents
               WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid
            )`,
        TENANT_ID,
        PATIENT_UID
      );
    }
    await tx.$executeRawUnsafe(
      `DELETE FROM ward_indents
        WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_ID,
      PATIENT_UID
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
      `DELETE FROM beds WHERE tenant_id = $1::uuid AND patient_uid = $2::uuid`,
      TENANT_ID,
      PATIENT_UID
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM wards WHERE tenant_id = $1::uuid AND name = $2`,
      TENANT_ID,
      WARD_NAME
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM pharmacy_catalog WHERE tenant_id = $1::uuid AND name = $2`,
      TENANT_ID,
      CATALOG_NAME,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM drug_compositions WHERE composition_key = $1`,
      COMPOSITION_KEY,
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
  let catalogId;

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
    const wardId = Number(
      (
        await prisma.$queryRawUnsafe(
          `INSERT INTO wards (tenant_id, name, total_beds, created_at, updated_at)
       VALUES ($1::uuid, $2, 1, NOW(), NOW()) RETURNING id`,
          TENANT_ID,
          WARD_NAME
        )
      )[0].id
    );
    const bedId = Number(
      (
        await prisma.$queryRawUnsafe(
          `INSERT INTO beds
         (tenant_id, ward_id, ward_name, bed_number, status, patient_uid,
          created_at, updated_at)
       VALUES ($1::uuid, $2::int, $3, $4, 'occupied', $5::uuid, NOW(), NOW())
       RETURNING id`,
          TENANT_ID,
          wardId,
          WARD_NAME,
          `MAR-AUTH-${String(Date.now()).slice(-8)}`,
          PATIENT_UID
        )
      )[0].id
    );
    const admissions = await prisma.$queryRawUnsafe(
      `INSERT INTO admissions
         (tenant_id, patient_uid, encounter_id, status, allergies, admission_type,
          admitting_doctor, attending_doctor, created_by, bed_id, ward,
          admitted_at, updated_at)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, 'admitted', ARRAY[]::text[], 'elective',
          $4::uuid, $4::uuid, $4::uuid, $5::int, $6, NOW(), NOW())
       RETURNING id`,
      TENANT_ID,
      PATIENT_UID,
      ENCOUNTER_ID,
      DOCTOR_UID,
      bedId,
      WARD_NAME
    );
    admissionId = Number(admissions[0].id);
    const compositions = await prisma.$queryRawUnsafe(
      `INSERT INTO drug_compositions
         (composition_key, display_label, active_ingredients, source)
       VALUES ($1, 'MAR Authorization Medicine', ARRAY['mar authorization medicine']::text[], 'curated')
       RETURNING id`,
      COMPOSITION_KEY,
    );
    const catalogs = await prisma.$queryRawUnsafe(
      `INSERT INTO pharmacy_catalog
         (tenant_id, name, generic_name, is_active, composition_id,
          composition_confidence, composition_source, strength, strength_key,
          strength_components, form, form_key, route, release_key, updated_at)
       VALUES ($1::uuid, $2, 'mar authorization medicine', TRUE, $3::int,
               'high', 'curated', '5mg', '5mg', $4::jsonb,
               'tablet', 'tablet', 'oral', 'ir', NOW())
       RETURNING id`,
      TENANT_ID,
      CATALOG_NAME,
      Number(compositions[0].id),
      JSON.stringify([{ ingredient: 'mar authorization medicine', value: 5, unit: 'mg' }]),
    );
    catalogId = Number(catalogs[0].id);
    const created = await doctorClient().post('/api/v1/emr/orders')
      .set('Idempotency-Key', ORDER_CREATE_KEY)
      .send({
        patient_uid: PATIENT_UID,
        encounter_id: ENCOUNTER_ID,
        order_type: 'medication',
        priority: 'routine',
        details: {
          medication_name: CATALOG_NAME,
          catalog_id: catalogId,
          quantity_requested: 2,
          unit: 'tablet',
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
