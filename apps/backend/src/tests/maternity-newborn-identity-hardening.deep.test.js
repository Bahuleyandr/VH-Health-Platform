// D7 / M-D subject remediation — repro-first evidence.
//
// PHASE 1 (this revision): demonstrates the PRE-remediation behavior on
// unmodified code — when a maternity newborn has no patient identity
// (newborn_patient_uid IS NULL), the mother-fallback CASE in
// services/maternity/immunisationService.js attributes the infant's
// immunisation schedule/dose canonical events to the MOTHER's patient
// record. These tests PASS against the current fallback and will be
// FLIPPED to assert fail-closed rejection (NEWBORN_IDENTITY_REQUIRED)
// once the signed D7 Shape-3 remediation lands in this lane.
//
// Decision record: D:\Dev\_codex\artifacts\scratch\2026-07-14\
// obgyn-d7-decision-record.md (SHA-256 E82EEC9A054CA3708A31F48568818BB2
// 7F9986D8F5A02C37AF9407F4D5DB9562).

import { randomUUID } from 'crypto';

import prisma from '../lib/prisma.js';
import {
  recordDose,
  seedScheduleForNewborn,
} from '../services/maternity/immunisationService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_A = randomUUID();
const ACTOR_UID = randomUUID();
const createdPatientUids = [];
let phoneSequence = 0;
let vaccineId;

function nextPhone() {
  phoneSequence += 1;
  return `+9187${String(Date.now()).slice(-7)}${phoneSequence}`;
}

async function seedUser({ tenantId = TENANT_A, role = 'PATIENT', name = null } = {}) {
  const uid = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, $5::uuid, NOW())`,
    uid,
    nextPhone(),
    name || `NB-ID ${role} ${uid.slice(0, 8)}`,
    role,
    tenantId,
  );
  createdPatientUids.push(uid);
  return uid;
}

// Pregnancy → delivery → newborn WITHOUT a patient identity
// (newborn_patient_uid = NULL): the exact state the pre-D7 fallback
// silently resolved to the mother.
async function seedIdentitylessNewborn({ tenantId = TENANT_A } = {}) {
  const motherUid = await seedUser({ tenantId });
  const pregnancyRows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_pregnancies
       (patient_uid, pregnancy_number, lmp_date, edd_date, status, created_by, tenant_id)
     VALUES ($1::uuid, 1, '2025-10-01', '2026-07-08', 'delivered', $2::uuid, $3::uuid)
     RETURNING id`,
    motherUid, ACTOR_UID, tenantId,
  );
  const deliveryRows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_deliveries
       (pregnancy_id, delivery_datetime, delivery_mode, delivered_by, tenant_id)
     VALUES ($1::int, '2026-07-08T04:00:00Z', 'nvd', $2::uuid, $3::uuid)
     RETURNING id`,
    Number(pregnancyRows[0].id), ACTOR_UID, tenantId,
  );
  const newbornRows = await prisma.$queryRawUnsafe(
    `INSERT INTO maternity_newborns
       (delivery_id, birth_datetime, outcome, newborn_patient_uid, recorded_by, tenant_id)
     VALUES ($1::int, '2026-07-08T04:00:00Z', 'live', NULL, $2::uuid, $3::uuid)
     RETURNING id`,
    Number(deliveryRows[0].id), ACTOR_UID, tenantId,
  );
  return {
    motherUid,
    pregnancyId: Number(pregnancyRows[0].id),
    deliveryId: Number(deliveryRows[0].id),
    newbornId: Number(newbornRows[0].id),
  };
}

async function canonicalRows(patientUid, eventType) {
  const timeline = await prisma.$queryRawUnsafe(
    `SELECT patient_uid, event_type, source_table, source_id, payload
       FROM clinical_timeline_events
      WHERE patient_uid = $1::uuid AND event_type = $2
      ORDER BY created_at`,
    patientUid, eventType,
  );
  const audit = await prisma.$queryRawUnsafe(
    `SELECT patient_uid, action, resource_table, resource_id
       FROM clinical_audit_events
      WHERE patient_uid = $1::uuid AND action = $2
      ORDER BY created_at`,
    patientUid, eventType,
  );
  return { timeline, audit };
}

async function cleanup() {
  if (createdPatientUids.length) {
    for (const sql of [
      `DELETE FROM clinical_audit_events WHERE patient_uid = ANY($1::uuid[])`,
      `DELETE FROM clinical_timeline_events WHERE patient_uid = ANY($1::uuid[])`,
    ]) {
      await prisma.$executeRawUnsafe(sql, createdPatientUids).catch(() => {});
    }
  }
  for (const sql of [
    `DELETE FROM newborn_immunisations WHERE tenant_id = $1::uuid`,
    `DELETE FROM maternity_newborns WHERE tenant_id = $1::uuid`,
    `DELETE FROM maternity_deliveries WHERE tenant_id = $1::uuid`,
    `DELETE FROM maternity_pregnancies WHERE tenant_id = $1::uuid`,
    `DELETE FROM vaccine_catalogue WHERE tenant_id = $1::uuid`,
    `DELETE FROM users WHERE tenant_id = $1::uuid`,
  ]) {
    await prisma.$executeRawUnsafe(sql, TENANT_A).catch(() => {});
  }
  await prisma
    .$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, TENANT_A)
    .catch(() => {});
}

d('M-D mother-fallback repro (identity-less newborn subject attribution)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'NB-ID Hardening Tenant')`,
      TENANT_A, `nbid-${TENANT_A.slice(0, 8)}`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'NB-ID Nurse', 'NURSING_STAFF', true, $3::uuid, NOW())`,
      ACTOR_UID, nextPhone(), TENANT_A,
    );
    const catalogueRows = await prisma.$queryRawUnsafe(
      `INSERT INTO vaccine_catalogue
         (code, display_name, dose_number, recommended_age_days, window_days, active, tenant_id)
       VALUES ('NBID-TEST', 'NB-ID hardening test vaccine', 1, 0, 28, true, $1::uuid)
       RETURNING id`,
      TENANT_A,
    );
    vaccineId = Number(catalogueRows[0].id);
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  }, 30_000);

  test('REPRO: schedule seeding for an identity-less newborn attributes canonical events to the MOTHER', async () => {
    const { motherUid, newbornId } = await seedIdentitylessNewborn();

    const result = await seedScheduleForNewborn({
      tenantId: TENANT_A,
      newborn_id: newbornId,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });
    expect(result.scheduled).toBe(1);

    // The infant's schedule event lands on the MOTHER's clinical record —
    // this is the unapproved proxy attribution D7 remediates.
    const motherEvents = await canonicalRows(motherUid, 'immunisation.schedule_seeded');
    expect(motherEvents.timeline).toHaveLength(1);
    expect(motherEvents.audit).toHaveLength(1);
    expect(motherEvents.timeline[0]).toMatchObject({
      patient_uid: motherUid,
      source_table: 'newborn_immunisations',
      payload: expect.objectContaining({
        newborn_id: newbornId,
        vaccine_catalogue_id: vaccineId,
      }),
    });
  });

  test('REPRO: dose recording for an identity-less newborn attributes canonical events to the MOTHER', async () => {
    const { motherUid, newbornId } = await seedIdentitylessNewborn();
    await seedScheduleForNewborn({
      tenantId: TENANT_A,
      newborn_id: newbornId,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });
    const doses = await prisma.$queryRawUnsafe(
      `SELECT id FROM newborn_immunisations WHERE newborn_id = $1::int`,
      newbornId,
    );
    expect(doses).toHaveLength(1);

    const dose = await recordDose({
      tenantId: TENANT_A,
      immunisation_id: doses[0].id,
      status: 'given',
      given_by: ACTOR_UID,
      given_by_name: 'NB-ID Nurse',
      batch_number: 'NBID-BATCH-1',
      actor_role: 'NURSING_STAFF',
    });
    expect(dose.status).toBe('given');

    const motherEvents = await canonicalRows(motherUid, 'immunisation.dose_recorded');
    expect(motherEvents.timeline).toHaveLength(1);
    expect(motherEvents.audit).toHaveLength(1);
    expect(motherEvents.timeline[0].patient_uid).toBe(motherUid);
  });
});
