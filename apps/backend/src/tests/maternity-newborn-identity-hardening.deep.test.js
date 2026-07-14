// D7 / M-D subject remediation — repro-first evidence, FLIPPED.
//
// PHASE 1 (commit 2c448f9e2, this lane): the same scenarios PASSED against
// the unmodified mother-fallback — an identity-less newborn's immunisation
// schedule/dose canonical events were attributed to the MOTHER's patient
// record by the CASE fallback in
// services/maternity/immunisationService.js.
//
// PHASE 2 (this revision): the fallback is REMOVED per the signed D7
// Shape-3 policy. The clinical subject is maternity_newborns.
// newborn_patient_uid, valid only under the signed E-3 predicate
// (role='PATIENT', active, not soft-deleted, not merged-away, not the
// delivery mother), re-checked in-transaction under row locks (E-c1) with
// migration 577's A-1 unique index as the structural backstop. Absent
// link, failed predicate, or ambiguity => the mutation is REJECTED
// (409 NEWBORN_IDENTITY_REQUIRED / NEWBORN_IDENTITY_INVALID) with ZERO
// writes. No proxy attribution, no fallback.
//
// Decision record: D:\Dev\_codex\artifacts\scratch\2026-07-14\
// obgyn-d7-decision-record.md (SHA-256 E82EEC9A054CA3708A31F48568818BB2
// 7F9986D8F5A02C37AF9407F4D5DB9562).

import { randomUUID } from 'crypto';

import pg from 'pg';

import prisma from '../lib/prisma.js';
import {
  recordDose,
  seedScheduleForNewborn,
} from '../services/maternity/immunisationService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;
const CONNECTION_STRING = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
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

// Pregnancy → delivery → newborn with a controllable identity link.
async function seedNewbornWithLink({ tenantId = TENANT_A, linkedPatientUid = null } = {}) {
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
     VALUES ($1::int, '2026-07-08T04:00:00Z', 'live', $2, $3::uuid, $4::uuid)
     RETURNING id`,
    Number(deliveryRows[0].id), linkedPatientUid, ACTOR_UID, tenantId,
  );
  return {
    motherUid,
    pregnancyId: Number(pregnancyRows[0].id),
    deliveryId: Number(deliveryRows[0].id),
    newbornId: Number(newbornRows[0].id),
  };
}

// Direct SQL dose row — used where the seeding path itself now rejects.
async function insertDoseRow(newbornId, { tenantId = TENANT_A } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO newborn_immunisations
       (newborn_id, vaccine_catalogue_id, due_date, status, tenant_id)
     VALUES ($1::int, $2::int, '2026-07-08'::date, 'scheduled', $3::uuid)
     RETURNING id`,
    newbornId, vaccineId, tenantId,
  );
  return Number(rows[0].id);
}

async function canonicalCounts(patientUid) {
  const timeline = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS total
       FROM clinical_timeline_events
      WHERE patient_uid = $1::uuid
        AND event_type IN ('immunisation.schedule_seeded', 'immunisation.dose_recorded')`,
    patientUid,
  );
  const audit = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS total
       FROM clinical_audit_events
      WHERE patient_uid = $1::uuid
        AND action IN ('immunisation.schedule_seeded', 'immunisation.dose_recorded')`,
    patientUid,
  );
  return { timeline: Number(timeline[0].total), audit: Number(audit[0].total) };
}

async function doseRowsFor(newbornId) {
  return prisma.$queryRawUnsafe(
    `SELECT id, status, given_at FROM newborn_immunisations WHERE newborn_id = $1::int`,
    newbornId,
  );
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
  for (const tenantId of [TENANT_A, TENANT_B]) {
    for (const sql of [
      `DELETE FROM newborn_immunisations WHERE tenant_id = $1::uuid`,
      `DELETE FROM maternity_newborns WHERE tenant_id = $1::uuid`,
      `DELETE FROM maternity_deliveries WHERE tenant_id = $1::uuid`,
      `DELETE FROM maternity_pregnancies WHERE tenant_id = $1::uuid`,
      `DELETE FROM patient_merge_requests WHERE tenant_id = $1::uuid`,
      `DELETE FROM vaccine_catalogue WHERE tenant_id = $1::uuid`,
      `DELETE FROM users WHERE tenant_id = $1::uuid`,
    ]) {
      await prisma.$executeRawUnsafe(sql, tenantId).catch(() => {});
    }
    await prisma
      .$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, tenantId)
      .catch(() => {});
  }
}

d('D7 M-D remediation — newborn identity is the only valid immunisation subject', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2, 'NB-ID Hardening Tenant A'),
              ($3::uuid, $4, 'NB-ID Hardening Tenant B')`,
      TENANT_A, `nbid-a-${TENANT_A.slice(0, 8)}`,
      TENANT_B, `nbid-b-${TENANT_B.slice(0, 8)}`,
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

  test('FLIPPED: schedule seeding for an identity-less newborn is REJECTED — no mother attribution, zero writes', async () => {
    const { motherUid, newbornId } = await seedNewbornWithLink({ linkedPatientUid: null });

    await expect(seedScheduleForNewborn({
      tenantId: TENANT_A,
      newborn_id: newbornId,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'NEWBORN_IDENTITY_REQUIRED',
    });

    // Zero detail writes, zero canonical writes — on the mother OR anyone.
    expect(await doseRowsFor(newbornId)).toHaveLength(0);
    expect(await canonicalCounts(motherUid)).toEqual({ timeline: 0, audit: 0 });
  });

  test('FLIPPED: dose recording for an identity-less newborn is REJECTED — dose untouched, zero canonical writes', async () => {
    const { motherUid, newbornId } = await seedNewbornWithLink({ linkedPatientUid: null });
    const doseId = await insertDoseRow(newbornId);

    await expect(recordDose({
      tenantId: TENANT_A,
      immunisation_id: doseId,
      status: 'given',
      given_by: ACTOR_UID,
      given_by_name: 'NB-ID Nurse',
      batch_number: 'NBID-BATCH-1',
      actor_role: 'NURSING_STAFF',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'NEWBORN_IDENTITY_REQUIRED',
    });

    const doses = await doseRowsFor(newbornId);
    expect(doses).toHaveLength(1);
    expect(doses[0]).toMatchObject({ status: 'scheduled', given_at: null });
    expect(await canonicalCounts(motherUid)).toEqual({ timeline: 0, audit: 0 });
  });

  test('a valid Shape-3 infant seeds and records with the INFANT as canonical subject (staff-only, #589 keys intact)', async () => {
    const infantUid = await seedUser({ name: 'B/O Valid Mother' });
    const { motherUid, newbornId } = await seedNewbornWithLink({ linkedPatientUid: infantUid });

    const seeded = await seedScheduleForNewborn({
      tenantId: TENANT_A,
      newborn_id: newbornId,
      actor_uid: ACTOR_UID,
      actor_role: 'NURSING_STAFF',
    });
    expect(seeded.scheduled).toBe(1);

    const doses = await doseRowsFor(newbornId);
    const recorded = await recordDose({
      tenantId: TENANT_A,
      immunisation_id: doses[0].id,
      status: 'given',
      given_by: ACTOR_UID,
      given_by_name: 'NB-ID Nurse',
      batch_number: 'NBID-VALID-1',
      actor_role: 'NURSING_STAFF',
    });
    expect(recorded.status).toBe('given');

    // Subject = infant; mother has NOTHING.
    expect(await canonicalCounts(motherUid)).toEqual({ timeline: 0, audit: 0 });
    const infantTimeline = await prisma.$queryRawUnsafe(
      `SELECT event_type, visible_to_patient, idempotency_key
         FROM clinical_timeline_events
        WHERE patient_uid = $1::uuid
        ORDER BY created_at`,
      infantUid,
    );
    expect(infantTimeline).toHaveLength(2);
    expect(infantTimeline.every((row) => row.visible_to_patient === false)).toBe(true);
    expect(infantTimeline[0].idempotency_key).toBe(
      `newborn_immunisations:${doses[0].id}:scheduled`,
    );
    // The #589 revision-key regime is preserved on genuine dose mutations.
    expect(infantTimeline[1].idempotency_key).toMatch(
      new RegExp(`^newborn_immunisations:${doses[0].id}:recorded:[0-9a-f]{64}:tx:\\d+$`),
    );
  });

  test('E-3 rejections: soft-deleted, merged-away, mother-linked and cross-tenant identities fail closed on BOTH paths', async () => {
    // soft-deleted infant (valid at seed time, invalidated later).
    const deletedInfant = await seedUser({ name: 'Deleted Infant' });
    const deletedCase = await seedNewbornWithLink({ linkedPatientUid: deletedInfant });
    const deletedDose = await insertDoseRow(deletedCase.newbornId);
    await prisma.$executeRawUnsafe(
      `UPDATE users SET is_deleted = true, deleted_at = NOW() WHERE uid = $1::uuid`,
      deletedInfant,
    );

    // merged-away infant (executed patient_merge_requests row).
    const mergedInfant = await seedUser({ name: 'Merged Infant' });
    const mergeTarget = await seedUser({ name: 'Merge Target' });
    const mergedCase = await seedNewbornWithLink({ linkedPatientUid: mergedInfant });
    const mergedDose = await insertDoseRow(mergedCase.newbornId);
    await prisma.$executeRawUnsafe(
      `INSERT INTO patient_merge_requests
         (tenant_id, primary_uid, secondary_uid, status, executed_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'executed', NOW())`,
      TENANT_A, mergeTarget, mergedInfant,
    );

    // mother-as-link (the mother-exclusion arm of E-3).
    const motherLinkCase = await seedNewbornWithLink({ linkedPatientUid: null });
    await prisma.$executeRawUnsafe(
      `UPDATE maternity_newborns SET newborn_patient_uid = $1::uuid WHERE id = $2::int`,
      motherLinkCase.motherUid, motherLinkCase.newbornId,
    );
    const motherLinkDose = await insertDoseRow(motherLinkCase.newbornId);

    // cross-tenant uid: the linked identity exists only in tenant B.
    const foreignInfant = await seedUser({ tenantId: TENANT_B, name: 'Foreign Infant' });
    const foreignCase = await seedNewbornWithLink({ linkedPatientUid: foreignInfant });
    const foreignDose = await insertDoseRow(foreignCase.newbornId);

    const rejectionCases = [
      { label: 'soft-deleted', newbornId: deletedCase.newbornId, doseId: deletedDose, reason: 'deleted', subject: deletedInfant, mother: deletedCase.motherUid },
      { label: 'merged-away', newbornId: mergedCase.newbornId, doseId: mergedDose, reason: 'merged_away', subject: mergedInfant, mother: mergedCase.motherUid },
      { label: 'mother-linked', newbornId: motherLinkCase.newbornId, doseId: motherLinkDose, reason: 'mother_identity', subject: motherLinkCase.motherUid, mother: motherLinkCase.motherUid },
      { label: 'cross-tenant', newbornId: foreignCase.newbornId, doseId: foreignDose, reason: 'not_found', subject: foreignInfant, mother: foreignCase.motherUid },
    ];

    for (const testCase of rejectionCases) {
      await expect(seedScheduleForNewborn({
        tenantId: TENANT_A,
        newborn_id: testCase.newbornId,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'NEWBORN_IDENTITY_INVALID',
        details: { reason: testCase.reason },
      });

      await expect(recordDose({
        tenantId: TENANT_A,
        immunisation_id: testCase.doseId,
        status: 'given',
        given_by: ACTOR_UID,
        given_by_name: 'NB-ID Nurse',
        actor_role: 'NURSING_STAFF',
      })).rejects.toMatchObject({
        statusCode: 409,
        code: 'NEWBORN_IDENTITY_INVALID',
        details: { reason: testCase.reason },
      });

      // Zero writes on both paths: the pre-inserted dose row is untouched
      // and no canonical rows exist for subject or mother.
      const doses = await doseRowsFor(testCase.newbornId);
      expect(doses).toHaveLength(1);
      expect(doses[0]).toMatchObject({ status: 'scheduled', given_at: null });
      expect(await canonicalCounts(testCase.subject)).toEqual({ timeline: 0, audit: 0 });
      expect(await canonicalCounts(testCase.mother)).toEqual({ timeline: 0, audit: 0 });
    }
  }, 60_000);

  test('E-c1: an identity invalidated AFTER preflight is caught by the in-transaction re-check under the users row lock', async () => {
    // Interleaving: a competitor transaction holds the infant users row
    // with an uncommitted soft-delete. seedScheduleForNewborn's preflight
    // (plain MVCC read) sees the still-committed VALID state and proceeds;
    // its in-transaction FOR UPDATE re-check then blocks on the
    // competitor's row lock, the competitor commits, and the re-read MUST
    // see the deletion and reject — the exact race window E-c1 closes.
    const infantUid = await seedUser({ name: 'Race Infant' });
    const { motherUid, newbornId } = await seedNewbornWithLink({ linkedPatientUid: infantUid });

    const client = new pg.Client({ connectionString: CONNECTION_STRING });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users SET is_deleted = true, deleted_at = NOW() WHERE uid = $1`,
        [infantUid],
      );

      const attempt = seedScheduleForNewborn({
        tenantId: TENANT_A,
        newborn_id: newbornId,
        actor_uid: ACTOR_UID,
        actor_role: 'NURSING_STAFF',
      });
      const commitSoon = (async () => {
        await new Promise((resolve) => { setTimeout(resolve, 400); });
        await client.query('COMMIT');
      })();

      await expect(attempt).rejects.toMatchObject({
        statusCode: 409,
        code: 'NEWBORN_IDENTITY_INVALID',
        details: { reason: 'deleted' },
      });
      await commitSoon;

      expect(await doseRowsFor(newbornId)).toHaveLength(0);
      expect(await canonicalCounts(infantUid)).toEqual({ timeline: 0, audit: 0 });
      expect(await canonicalCounts(motherUid)).toEqual({ timeline: 0, audit: 0 });
    } finally {
      await client.end().catch(() => {});
    }
  }, 30_000);

  test('tenant isolation: tenant B cannot seed or record against tenant A rows', async () => {
    const infantUid = await seedUser({ name: 'Isolated Infant' });
    const { newbornId } = await seedNewbornWithLink({ linkedPatientUid: infantUid });
    const doseId = await insertDoseRow(newbornId);

    await expect(seedScheduleForNewborn({
      tenantId: TENANT_B,
      newborn_id: newbornId,
    })).rejects.toMatchObject({ statusCode: 404 });
    await expect(recordDose({
      tenantId: TENANT_B,
      immunisation_id: doseId,
      status: 'given',
      given_by: ACTOR_UID,
      given_by_name: 'NB-ID Nurse',
    })).rejects.toMatchObject({ statusCode: 404 });

    const doses = await doseRowsFor(newbornId);
    expect(doses[0]).toMatchObject({ status: 'scheduled', given_at: null });
  });
});
