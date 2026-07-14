import request from 'supertest';
import pg from 'pg';
import app from '../app.js';
import prisma from '../lib/prisma.js';
import { API_KEY, generateTestToken } from './testClient.js';
import { importScheduleRows } from '../../scripts/immunisation-schedule-import.mjs';
import { seedScheduleForPatient } from '../services/paediatric/paediatricImmunisationService.js';

const PATIENT_UID = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d401';
const NURSE_UID = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d402';
const TEST_TENANT_ID = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a1';
const IMPORT_PATIENT_1_UID = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a2';
const IMPORT_PATIENT_2_UID = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4a3';
const IMPORT_TEST_CODE = 'NL5P4_TEST';
const PAEDIATRIC_DEEP_TEST_TIMEOUT_MS = 30000;

function twoYearOldDob() {
  return new Date(Date.now() - 760 * 86400000).toISOString().slice(0, 10);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function nurseClient(id = 1) {
  const token = generateTestToken('NURSING_STAFF', { uid: NURSE_UID, id });
  return {
    get: (path) => request(app)
      .get(path)
      .set('x-api-key', API_KEY)
      .set('Authorization', `Bearer ${token}`),
  };
}

describe('Paediatric immunisation schedule reads', () => {
  let patientId;
  let nurseId;
  let nurse;

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE patient_uid=$1::uuid`,
      PATIENT_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid=$1::uuid`,
      PATIENT_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_notes WHERE patient_uid=$1::uuid AND note_type='immunisation_review'`,
      PATIENT_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM patient_immunisations WHERE patient_uid=$1::uuid`,
      PATIENT_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
      PATIENT_UID, NURSE_UID,
    ).catch(() => {});

    const patient = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, birthday, gender, is_active, updated_at)
       VALUES ($1::uuid, '9000094401', 'Paeds Immunisation Child', 'PATIENT', $2::date, 'Male', true, NOW())
       RETURNING id`,
      PATIENT_UID, twoYearOldDob(),
    );
    patientId = patient[0].id;

    const nurseRow = await prisma.$queryRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000094402', 'Paeds Immunisation Nurse', 'NURSING_STAFF', true, NOW())
       RETURNING id`,
      NURSE_UID,
    );
    nurseId = nurseRow[0].id;
    nurse = nurseClient(nurseId);
  }, PAEDIATRIC_DEEP_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE patient_uid=$1::uuid`,
      PATIENT_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE patient_uid=$1::uuid`,
      PATIENT_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_notes WHERE patient_uid=$1::uuid AND note_type='immunisation_review'`,
      PATIENT_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM patient_immunisations WHERE patient_uid=$1::uuid`,
      PATIENT_UID,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE id IN ($1, $2)`,
      patientId, nurseId,
    ).catch(() => {});
  }, PAEDIATRIC_DEEP_TEST_TIMEOUT_MS);

  it('keeps GET read-only and returns an empty schedule before explicit seeding', async () => {
    const catalogue = await nurse.get('/api/v1/paediatric/immunisations/catalogue');
    expect(catalogue.statusCode).toBe(200);
    expect(catalogue.body.data.length).toBeGreaterThan(0);

    const list = await nurse.get(`/api/v1/paediatric/immunisations/patient/${PATIENT_UID}`);
    expect(list.statusCode).toBe(200);
    expect(list.body.data).toEqual([]);

    const dbCount = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM patient_immunisations WHERE patient_uid=$1::uuid`,
      PATIENT_UID,
    );
    expect(Number(dbCount[0].count)).toBe(0);
  }, PAEDIATRIC_DEEP_TEST_TIMEOUT_MS);

  it('returns due/overdue rows after the explicit seed mutation', async () => {
    await seedScheduleForPatient({
      patientUid: PATIENT_UID,
      dob: twoYearOldDob(),
      tenantId: '00000000-0000-4000-8000-000000000001',
      actorUid: NURSE_UID,
      actorRole: 'NURSING_STAFF',
    });
    const due = await nurse.get(`/api/v1/paediatric/immunisations/patient/${PATIENT_UID}/due`);
    expect(due.statusCode).toBe(200);
    expect(due.body.data.length).toBeGreaterThan(0);
    expect(due.body.data.every((row) => row.status === 'scheduled')).toBe(true);
  }, PAEDIATRIC_DEEP_TEST_TIMEOUT_MS);

  it('does not show already-reviewed doses in the due list', async () => {
    const reviewAsOf = todayIso();
    const before = await nurse.get(`/api/v1/paediatric/immunisations/patient/${PATIENT_UID}/due?asOf=${reviewAsOf}`);
    expect(before.statusCode).toBe(200);
    expect(before.body.data.some((row) => row.bucket === 'due_or_overdue')).toBe(true);

    await prisma.$executeRawUnsafe(
      `INSERT INTO clinical_notes
         (patient_uid, author_uid, author_role, note_type, title, content,
          is_signed, signed_at, signed_by, status, tenant_id)
       VALUES ($1::uuid, $2::uuid, 'NURSING_STAFF', 'immunisation_review',
               'Immunisation up to date',
               jsonb_build_object('status', 'up_to_date', 'as_of', $3::text, 'age_group', 'current', 'tenant_id', $4::text),
               true, NOW(), $2::uuid, 'current', $4::uuid)`,
      PATIENT_UID, NURSE_UID, reviewAsOf, '00000000-0000-4000-8000-000000000001',
    );

    const after = await nurse.get(`/api/v1/paediatric/immunisations/patient/${PATIENT_UID}/due?asOf=${reviewAsOf}`);
    expect(after.statusCode).toBe(200);
    expect(after.body.data.some((row) => row.bucket === 'due_or_overdue')).toBe(false);
    expect(after.body.data.every((row) => String(row.due_date).slice(0, 10) > reviewAsOf)).toBe(true);
  }, PAEDIATRIC_DEEP_TEST_TIMEOUT_MS);
});

function addDaysIso(dateIso, days) {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function importedTestRow(ageDays) {
  return {
    schedule_source: 'uip',
    code: IMPORT_TEST_CODE,
    display_name: 'NL-5 P4 synthetic timing dose',
    dose_number: 1,
    recommended_age_days: ageDays,
    window_days: 30,
    description: 'Synthetic row for importer timing regression',
  };
}

async function cleanupImportTestTenant() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_immunisations WHERE tenant_id = $1::uuid`,
    TEST_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM vaccine_catalogue WHERE tenant_id = $1::uuid AND code = $2`,
    TEST_TENANT_ID, IMPORT_TEST_CODE,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM immunisation_schedule_import_batches WHERE tenant_id = $1::uuid`,
    TEST_TENANT_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    IMPORT_PATIENT_1_UID, IMPORT_PATIENT_2_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id = $1::uuid`,
    TEST_TENANT_ID,
  ).catch(() => {});
}

async function dueDateForImportedDose(patientUid) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT pi.due_date::text AS due_date
       FROM patient_immunisations pi
       JOIN vaccine_catalogue vc ON vc.id = pi.vaccine_catalogue_id
      WHERE pi.patient_uid = $1::uuid
        AND pi.tenant_id = $2::uuid
        AND vc.code = $3
        AND vc.dose_number = 1
      LIMIT 1`,
    patientUid, TEST_TENANT_ID, IMPORT_TEST_CODE,
  );
  return rows[0]?.due_date || null;
}

describe('Paediatric immunisation schedule imports', () => {
  let pgClient;
  const dob1 = '2020-01-01';
  const dob2 = '2020-02-01';

  beforeAll(async () => {
    await cleanupImportTestTenant();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, 'nl5-p4-test', 'NL-5 P4 Test Tenant')
       ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, name = EXCLUDED.name`,
      TEST_TENANT_ID,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, birthday, gender, is_active, tenant_id, updated_at)
       VALUES
         ($1::uuid, '90000944a2', 'NL5 P4 Import Child 1', 'PATIENT', $3::date, 'Male', true, $5::uuid, NOW()),
         ($2::uuid, '90000944a3', 'NL5 P4 Import Child 2', 'PATIENT', $4::date, 'Male', true, $5::uuid, NOW())`,
      IMPORT_PATIENT_1_UID, IMPORT_PATIENT_2_UID, dob1, dob2, TEST_TENANT_ID,
    );
    pgClient = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await pgClient.connect();
  }, PAEDIATRIC_DEEP_TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (pgClient) await pgClient.end();
    await cleanupImportTestTenant();
    await prisma.$disconnect().catch(() => {});
  }, PAEDIATRIC_DEEP_TEST_TIMEOUT_MS);

  it('upserts timing going forward, preserves existing patient schedules, and retires removed rows', async () => {
    const firstImport = await importScheduleRows({
      client: pgClient,
      tenantId: TEST_TENANT_ID,
      schedule: 'uip',
      version: 'test-v1',
      rows: [importedTestRow(42)],
    });
    expect(firstImport.upserted).toBe(1);

    await seedScheduleForPatient({
      patientUid: IMPORT_PATIENT_1_UID,
      dob: dob1,
      tenantId: TEST_TENANT_ID,
    });
    expect(await dueDateForImportedDose(IMPORT_PATIENT_1_UID)).toBe(addDaysIso(dob1, 42));

    const secondImport = await importScheduleRows({
      client: pgClient,
      tenantId: TEST_TENANT_ID,
      schedule: 'uip',
      version: 'test-v2',
      rows: [importedTestRow(70)],
    });
    expect(secondImport.upserted).toBe(1);
    await seedScheduleForPatient({
      patientUid: IMPORT_PATIENT_1_UID,
      dob: dob1,
      tenantId: TEST_TENANT_ID,
    });
    expect(await dueDateForImportedDose(IMPORT_PATIENT_1_UID)).toBe(addDaysIso(dob1, 42));

    await seedScheduleForPatient({
      patientUid: IMPORT_PATIENT_2_UID,
      dob: dob2,
      tenantId: TEST_TENANT_ID,
    });
    expect(await dueDateForImportedDose(IMPORT_PATIENT_2_UID)).toBe(addDaysIso(dob2, 70));

    const retireImport = await importScheduleRows({
      client: pgClient,
      tenantId: TEST_TENANT_ID,
      schedule: 'uip',
      version: 'test-v3',
      rows: [],
    });
    expect(retireImport.retired).toBe(1);

    const retired = await prisma.$queryRawUnsafe(
      `SELECT active, retired_at IS NOT NULL AS retired
         FROM vaccine_catalogue
        WHERE tenant_id = $1::uuid AND code = $2 AND dose_number = 1`,
      TEST_TENANT_ID, IMPORT_TEST_CODE,
    );
    expect(retired[0].active).toBe(false);
    expect(retired[0].retired).toBe(true);

    const batches = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM immunisation_schedule_import_batches
        WHERE tenant_id = $1::uuid AND status = 'completed'`,
      TEST_TENANT_ID,
    );
    expect(Number(batches[0].count)).toBe(3);
  }, PAEDIATRIC_DEEP_TEST_TIMEOUT_MS);
});
