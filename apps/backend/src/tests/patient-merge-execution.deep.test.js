// 2026-08-07 Phase-3 deep review — patient merge execution rework.
//
// Proves, against a real migrated schema:
//   1. The catalog-discovered FK sweep re-points the whole chart, not a
//      hand-picked subset: admissions AND the composite-FK-linked
//      investigations row (both patient_uid and the patient_id int column
//      readers actually query) and appointments move to the survivor in one
//      transaction, with the migration-634 deferrable composite FKs checked
//      at COMMIT.
//   2. The merged-away patient record is deactivated in the same
//      transaction (is_active=false, status='merged', merged_into_uid) —
//      it can no longer mint logins and un-merge provenance is durable.
//   3. Old identifiers stay resolvable: the secondary's MRN keeps its
//      original patient_uid (provenance) but lookupByIdentifier resolves it
//      to the survivor.
//   4. Canonical clinical timeline invariant: exactly one
//      clinical_timeline_events row + one clinical_audit_events row for the
//      merge, in the same transaction, on insert-once idempotency keys.
//   5. Transactionality: a data conflict (per-patient unique row on both
//      records, e.g. abha_profiles) aborts as a 409 and rolls back
//      EVERYTHING — no half-merged chart, secondary stays live.
//   6. Migration-634 pin: no composite patient_uid FK may be
//      non-deferrable, or the multi-table sweep becomes impossible again.
//
// Requires a reachable Postgres (DATABASE_URL). Skipped if none configured.

import { randomUUID } from 'crypto';
import prisma from '../lib/prisma.js';
import {
  requestMerge,
  approveMerge,
  executeMerge,
} from '../services/patient/patientMergeService.js';
import { lookupByIdentifier } from '../services/patient/patientIdentifierService.js';

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const MARK = `PMERGE-${process.pid}-${Date.now()}`;

const REQUESTER = randomUUID();
const APPROVER = randomUUID();
const EXECUTOR = randomUUID();

const seeded = {
  userUids: [],
  admissionIds: [],
  investigationIds: [],
  appointmentIds: [],
};

let phoneSeq = 0;
async function seedPatient(label) {
  const phone = `+9198${String(700000 + ++phoneSeq)}${String(Date.now() % 1000).padStart(3, '0')}`;
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (tenant_id, phone, name, role, registered_at, updated_at)
     VALUES ($1::uuid, $2, $3, 'PATIENT', NOW(), NOW())
     RETURNING id, uid::text AS uid`,
    TENANT, phone, `${MARK}-${label}`,
  );
  seeded.userUids.push(rows[0].uid);
  return { id: rows[0].id, uid: rows[0].uid, phone };
}

async function seedChart(patient) {
  const admissionRows = await prisma.$queryRawUnsafe(
    `INSERT INTO admissions (tenant_id, patient_uid, status, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'ACTIVE', NOW(), NOW())
     RETURNING id`,
    TENANT, patient.uid,
  );
  const admissionId = admissionRows[0].id;
  seeded.admissionIds.push(admissionId);

  // Composite fk_investigations_admission (tenant_id, admission_id,
  // patient_uid) — the sweep must move parent + child consistently.
  const investigationRows = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations
       (tenant_id, phone, test_name, patient_id, patient_uid, admission_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, NOW())
     RETURNING id`,
    TENANT, patient.phone, `${MARK}-test`, patient.id, patient.uid, admissionId,
  );
  seeded.investigationIds.push(investigationRows[0].id);

  const appointmentRows = await prisma.$queryRawUnsafe(
    `INSERT INTO appointments
       (tenant_id, phone, appointment_date, appointment_time, patient_id, updated_at)
     VALUES ($1::uuid, $2, CURRENT_DATE, '10:00', $3, NOW())
     RETURNING id`,
    TENANT, patient.phone, patient.id,
  );
  seeded.appointmentIds.push(appointmentRows[0].id);
  return { admissionId, investigationId: investigationRows[0].id, appointmentId: appointmentRows[0].id };
}

async function seedIdentifier(patientUid, value) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO patient_identifiers
       (tenant_id, patient_uid, identifier_type, identifier_value, status, is_primary)
     VALUES ($1::uuid, $2::uuid, 'mrn', $3, 'active', true)`,
    TENANT, patientUid, value,
  );
}

async function approvedMergeRequest(primary, secondary) {
  const request = await requestMerge({
    tenantId: TENANT,
    primaryUid: primary.uid,
    secondaryUid: secondary.uid,
    requestedBy: REQUESTER,
    requesterNote: MARK,
  });
  await approveMerge({ tenantId: TENANT, id: request.id, approverUid: APPROVER });
  return request;
}

async function cleanup() {
  if (!DB) return;
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE source_table = 'patient_merge_requests' AND clinical_summary LIKE '%merged%' AND patient_uid = ANY($1::uuid[])`,
    seeded.userUids,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE action = 'patient.merge.executed' AND patient_uid = ANY($1::uuid[])`,
    seeded.userUids,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_merge_requests WHERE tenant_id = $1::uuid AND requester_note = $2`,
    TENANT, MARK,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM patient_identifiers WHERE tenant_id = $1::uuid AND identifier_value LIKE $2`,
    TENANT, `${MARK}%`,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM abha_profiles WHERE tenant_id = $1::uuid AND abha_id LIKE $2`,
    TENANT, `${MARK}%`,
  );
  if (seeded.investigationIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM investigations WHERE id = ANY($1::int[])`, seeded.investigationIds,
    );
  }
  if (seeded.appointmentIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM appointments WHERE id = ANY($1::int[])`, seeded.appointmentIds,
    );
  }
  if (seeded.admissionIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM admissions WHERE id = ANY($1::int[])`, seeded.admissionIds,
    );
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM invalidated_tokens WHERE jti = ANY($1::text[])`,
    seeded.userUids.map((uid) => `user:${uid}`),
  );
  if (seeded.userUids.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid = ANY($1::uuid[])`, seeded.userUids,
    );
  }
}

d('patient merge execution (deep)', () => {
  afterAll(async () => {
    await cleanup();
  });

  test('migration 634 pin: composite patient_uid FKs are all deferrable', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT pc.conname
       FROM pg_constraint pc
       WHERE pc.contype = 'f'
         AND NOT pc.condeferrable
         AND array_length(pc.conkey, 1) > 1
         AND EXISTS (
           SELECT 1 FROM unnest(pc.conkey) AS k
           JOIN pg_attribute a ON a.attrelid = pc.conrelid AND a.attnum = k
           WHERE a.attname = 'patient_uid'
         )`,
    );
    // A non-deferrable composite patient_uid FK makes the merge sweep
    // impossible (parent/child cannot re-point in separate statements).
    // New migrations must declare such FKs DEFERRABLE INITIALLY IMMEDIATE.
    expect(rows.map((row) => row.conname)).toEqual([]);
  });

  test('executed merge moves the whole chart, deactivates the secondary, keeps identifiers resolvable, and emits the canonical pair', async () => {
    const primary = await seedPatient('primary');
    const secondary = await seedPatient('secondary');
    const chart = await seedChart(secondary);
    await seedIdentifier(primary.uid, `${MARK}-P-MRN`);
    await seedIdentifier(secondary.uid, `${MARK}-S-MRN`);

    const request = await approvedMergeRequest(primary, secondary);
    const executed = await executeMerge({ tenantId: TENANT, id: request.id, executorUid: EXECUTOR });
    expect(executed.status).toBe('executed');

    // 1. Chart moved — admission, composite-FK investigation (uuid + int
    // reader columns), appointment.
    const admission = await prisma.$queryRawUnsafe(
      `SELECT patient_uid::text FROM admissions WHERE id = $1`, chart.admissionId,
    );
    expect(admission[0].patient_uid).toBe(primary.uid);
    const investigation = await prisma.$queryRawUnsafe(
      `SELECT patient_uid::text, patient_id, admission_id FROM investigations WHERE id = $1`,
      chart.investigationId,
    );
    expect(investigation[0].patient_uid).toBe(primary.uid);
    expect(investigation[0].patient_id).toBe(primary.id);
    expect(investigation[0].admission_id).toBe(chart.admissionId);
    const appointment = await prisma.$queryRawUnsafe(
      `SELECT patient_id FROM appointments WHERE id = $1`, chart.appointmentId,
    );
    expect(appointment[0].patient_id).toBe(primary.id);

    // 2. Secondary deactivated with durable survivor pointer.
    const merged = await prisma.$queryRawUnsafe(
      `SELECT is_active, status, merged_into_uid::text, merged_at FROM users WHERE uid = $1::uuid`,
      secondary.uid,
    );
    expect(merged[0].is_active).toBe(false);
    expect(merged[0].status).toBe('merged');
    expect(merged[0].merged_into_uid).toBe(primary.uid);
    expect(merged[0].merged_at).not.toBeNull();

    // 3. Old MRN resolves to the survivor; provenance intact on the row.
    const lookup = await lookupByIdentifier({
      tenantId: TENANT, identifierType: 'mrn', identifierValue: `${MARK}-S-MRN`,
    });
    expect(lookup.count).toBe(1);
    expect(lookup.identifiers[0].patient_uid).toBe(primary.uid);
    expect(lookup.identifiers[0].original_patient_uid).toBe(secondary.uid);
    expect(lookup.identifiers[0].status).toBe('merged_into');
    const identifierRow = await prisma.$queryRawUnsafe(
      `SELECT patient_uid::text, status, merged_into_uid::text, metadata
       FROM patient_identifiers WHERE tenant_id = $1::uuid AND identifier_value = $2`,
      TENANT, `${MARK}-S-MRN`,
    );
    expect(identifierRow[0].patient_uid).toBe(secondary.uid);
    expect(identifierRow[0].merged_into_uid).toBe(primary.uid);
    expect(identifierRow[0].metadata.merge_request_id).toBe(request.id);
    // The survivor's own MRN is untouched.
    const primaryMrn = await lookupByIdentifier({
      tenantId: TENANT, identifierType: 'mrn', identifierValue: `${MARK}-P-MRN`,
    });
    expect(primaryMrn.identifiers[0].patient_uid).toBe(primary.uid);
    expect(primaryMrn.identifiers[0].status).toBe('active');

    // 4. Canonical pair, insert-once keys, same transaction as the merge.
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT patient_uid::text, event_type FROM clinical_timeline_events WHERE idempotency_key = $1`,
      `patient_merge_requests:${request.id}:executed`,
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0].patient_uid).toBe(primary.uid);
    expect(timeline[0].event_type).toBe('patient.merge.executed');
    const audit = await prisma.$queryRawUnsafe(
      `SELECT patient_uid::text, action FROM clinical_audit_events WHERE idempotency_key = $1`,
      `patient_merge_requests:${request.id}:executed`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('patient.merge.executed');

    // Execution summary records the sweep for admin audit.
    const summary = executed.execution_summary;
    expect(summary.identifiers_retargeted).toBe(1);
    expect(summary.secondary_deactivated).toBe(true);
    expect(summary.table_summary.admissions.rows_moved).toBe(1);
    expect(summary.table_summary.investigations.rows_moved).toBe(2);
    expect(summary.table_summary.appointments.rows_moved).toBe(1);
    expect(summary.append_only_skipped).toEqual(
      expect.arrayContaining(['clinical_timeline_events.patient_uid']),
    );

    // The merged-away record can no longer be merge-targeted again.
    await expect(requestMerge({
      tenantId: TENANT,
      primaryUid: primary.uid,
      secondaryUid: secondary.uid,
      requestedBy: REQUESTER,
      requesterNote: MARK,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  test('a data conflict rolls back the entire merge — nothing moves, secondary stays live', async () => {
    const primary = await seedPatient('primary2');
    const secondary = await seedPatient('secondary2');
    const chart = await seedChart(secondary);
    await seedIdentifier(secondary.uid, `${MARK}-S2-MRN`);
    // abha_profiles is UNIQUE (tenant_id, patient_uid): a row on BOTH
    // records makes the sweep collide at the unique index.
    await prisma.$executeRawUnsafe(
      `INSERT INTO abha_profiles (tenant_id, patient_uid, abha_id)
       VALUES ($1::uuid, $2::uuid, $3), ($1::uuid, $4::uuid, $5)`,
      TENANT, primary.uid, `${MARK}-ABHA-P`, secondary.uid, `${MARK}-ABHA-S`,
    );

    const request = await approvedMergeRequest(primary, secondary);
    await expect(executeMerge({ tenantId: TENANT, id: request.id, executorUid: EXECUTOR }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PATIENT_MERGE_DATA_CONFLICT' });

    // Everything rolled back: chart untouched, identifiers active,
    // secondary live, merge still 'approved' (retryable after cleanup),
    // no canonical rows.
    const admission = await prisma.$queryRawUnsafe(
      `SELECT patient_uid::text FROM admissions WHERE id = $1`, chart.admissionId,
    );
    expect(admission[0].patient_uid).toBe(secondary.uid);
    const identifier = await prisma.$queryRawUnsafe(
      `SELECT status, patient_uid::text FROM patient_identifiers WHERE tenant_id = $1::uuid AND identifier_value = $2`,
      TENANT, `${MARK}-S2-MRN`,
    );
    expect(identifier[0].status).toBe('active');
    expect(identifier[0].patient_uid).toBe(secondary.uid);
    const user = await prisma.$queryRawUnsafe(
      `SELECT is_active, status, merged_into_uid::text FROM users WHERE uid = $1::uuid`,
      secondary.uid,
    );
    expect(user[0].is_active).toBe(true);
    expect(user[0].status).not.toBe('merged');
    expect(user[0].merged_into_uid).toBeNull();
    const requestRow = await prisma.$queryRawUnsafe(
      `SELECT status FROM patient_merge_requests WHERE id = $1`, request.id,
    );
    expect(requestRow[0].status).toBe('approved');
    const timeline = await prisma.$queryRawUnsafe(
      `SELECT id FROM clinical_timeline_events WHERE idempotency_key = $1`,
      `patient_merge_requests:${request.id}:executed`,
    );
    expect(timeline).toHaveLength(0);
  });
});
