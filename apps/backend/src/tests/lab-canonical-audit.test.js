// Canonical clinical timeline invariant for general lab results
// (docs/CANONICAL_CLINICAL_TIMELINE.md): manual result entry and pathologist
// sign-off were the one clinical write path with NO clinical_timeline_events /
// clinical_audit_events emission — pathology, radiology, and generic
// investigations all emit canonical events, general lab did not.
//
// These tests assert that recordResultManual and signOffResults persist the
// lab detail row PLUS one timeline row and one audit row, with tenant /
// patient / actor attribution. The rollback (atomicity) half lives in
// lab-canonical-atomicity.test.js.
//
// Cleanup note: clinical_timeline_events rows are removed in afterAll, but
// clinical_audit_events is append-only (migration 324 guard) — those rows
// deliberately accrete in the QA DB like every other canonical writer's tests.

import { createHash } from 'node:crypto';
import prisma from '../lib/prisma.js';
import * as labResults from '../services/lab/labResultsService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'c9c9c9c9-c9c9-4c9c-8c9c-c9c9c9c90801';
const TECH_UID = 'c9c9c9c9-c9c9-4c9c-8c9c-c9c9c9c90802';
const PATHOLOGIST_UID = 'c9c9c9c9-c9c9-4c9c-8c9c-c9c9c9c90803';

const createdInvestigationIds = [];
const createdResultIds = [];

async function cleanupFixture() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM lab_results
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid`,
    TENANT,
    PATIENT_UID,
  );
  const resultIds = rows.map((row) => Number(row.id));
  if (resultIds.length > 0) {
    await prisma.$transaction(async (tx) => {
      // Manual result entry now creates immutable ingest evidence. Teardown is
      // confined to this fixture in the disposable superuser test database;
      // the append-only clinical audit chain deliberately remains untouched.
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `DELETE FROM lab_pathologist_signoffs
          WHERE tenant_id = $1::uuid
            AND result_ids && $2::int[]`,
        TENANT,
        resultIds,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_timeline_events
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid`,
        TENANT,
        PATIENT_UID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM lab_results
          WHERE tenant_id = $1::uuid
            AND id = ANY($2::int[])`,
        TENANT,
        resultIds,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM lab_result_ingest_commands
          WHERE tenant_id = $1::uuid
            AND result_ids && $2::int[]`,
        TENANT,
        resultIds,
      );
    });
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM investigations
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid`,
    TENANT,
    PATIENT_UID,
  );
}

async function seedInvestigation({ status = 'REQUESTED', testName = 'Haemoglobin' } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations
       (patient_uid, phone, test_name, status, tenant_id, updated_at)
     VALUES ($1::uuid, '9008080801', $2, $3, $4::uuid, NOW())
     RETURNING id`,
    PATIENT_UID, testName, status, TENANT,
  );
  createdInvestigationIds.push(rows[0].id);
  return rows[0].id;
}

async function seedResult(investigationId, { testCode = 'HB', testName = 'Haemoglobin', value = '12.5' } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, investigation_id, test_code, test_name, value_text, status)
     VALUES ($1::uuid, $2::uuid, $3::int, $4, $5, $6, 'preliminary')
     RETURNING id`,
    TENANT, PATIENT_UID, investigationId, testCode, testName, value,
  );
  createdResultIds.push(rows[0].id);
  return rows[0].id;
}

async function timelineEventsFor(sourceTable, sourceId, eventType) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM clinical_timeline_events
      WHERE tenant_id = $1::uuid
        AND source_table = $2
        AND source_id = $3
        AND event_type = $4`,
    TENANT, sourceTable, String(sourceId), eventType,
  );
}

async function auditEventsFor(resourceTable, resourceId, action) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM clinical_audit_events
      WHERE tenant_id = $1::uuid
        AND resource_table = $2
        AND resource_id = $3
        AND action = $4`,
    TENANT, resourceTable, String(resourceId), action,
  );
}

describe('Lab results emit canonical timeline + audit events', () => {
  beforeAll(async () => {
    await cleanupFixture();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $4::uuid, '9008080801', 'Lab Canonical Patient', 'PATIENT', true, NOW()),
         ($2::uuid, $4::uuid, '9008080802', 'Lab Canonical Technician', 'LAB_STAFF', true, NOW()),
         ($3::uuid, $4::uuid, '9008080803', 'Lab Canonical Pathologist', 'PATHOLOGIST', true, NOW())
       ON CONFLICT (uid) DO UPDATE
         SET tenant_id = EXCLUDED.tenant_id,
             name = EXCLUDED.name,
             role = EXCLUDED.role,
             is_active = true`,
      PATIENT_UID,
      TECH_UID,
      PATHOLOGIST_UID,
      TENANT,
    );
  });

  afterAll(async () => {
    await cleanupFixture();
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID,
      TECH_UID,
      PATHOLOGIST_UID,
    );
    await prisma.$disconnect();
  });

  it('recordResultManual writes the result + timeline + audit pair with actor attribution', async () => {
    const invId = await seedInvestigation({ status: 'REQUESTED' });
    const manualResult = {
      investigation_id: invId,
      patient_uid: PATIENT_UID,
      test_code: 'HB',
      test_name: 'Haemoglobin',
      value_text: '11.9',
      unit: 'g/dL',
    };

    const { result } = await labResults.recordResultManual({
      tenantId: TENANT,
      performed_by: TECH_UID,
      performed_by_role: 'LAB_TECHNICIAN',
      result: manualResult,
      idempotencyKey: 'lab-canonical-audit-manual-v1',
      requestBodySha256: createHash('sha256')
        .update(JSON.stringify(manualResult))
        .digest('hex'),
    });
    createdResultIds.push(result.id);

    // Timeline leg.
    const timeline = await timelineEventsFor('lab_results', result.id, 'lab.result_recorded');
    expect(timeline).toHaveLength(1);
    expect(timeline[0].patient_uid).toBe(PATIENT_UID);
    expect(timeline[0].actor_uid).toBe(TECH_UID);
    expect(timeline[0].actor_role).toBe('LAB_TECHNICIAN');
    expect(timeline[0].event_status).toBe('preliminary');
    expect(timeline[0].visible_to_patient).toBe(false);
    expect(timeline[0].payload.test_code).toBe('HB');
    expect(timeline[0].payload.investigation_id).toBe(invId);

    // Audit leg.
    const audit = await auditEventsFor('lab_results', result.id, 'lab.result_recorded');
    expect(audit).toHaveLength(1);
    expect(audit[0].patient_uid).toBe(PATIENT_UID);
    expect(audit[0].actor_uid).toBe(TECH_UID);
    expect(audit[0].actor_role).toBe('LAB_TECHNICIAN');
    expect(audit[0].after_state?.status).toBe('preliminary');

    // The investigation advance stays part of the same write.
    const inv = await prisma.$queryRawUnsafe(
      `SELECT status FROM investigations WHERE id = $1::int`, invId,
    );
    expect(inv[0].status).toBe('IN_PROGRESS');
  });

  it('signOffResults writes the signoff + timeline + audit pair covering all result ids', async () => {
    const invId = await seedInvestigation({ status: 'IN_PROGRESS' });
    const first = await seedResult(invId, { testCode: 'WBC', testName: 'White cell count', value: '7.1' });
    const second = await seedResult(invId, { testCode: 'PLT', testName: 'Platelets', value: '250' });

    const signoff = await labResults.signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      signed_off_by_name: 'Dr Canonical Pathologist',
      result_ids: [first, second],
      decision: 'verified',
      patient_uid: PATIENT_UID,
    });

    const timeline = await timelineEventsFor('lab_pathologist_signoffs', signoff.id, 'lab.result_signed_off');
    expect(timeline).toHaveLength(1);
    expect(timeline[0].patient_uid).toBe(PATIENT_UID);
    expect(timeline[0].actor_uid).toBe(PATHOLOGIST_UID);
    expect(timeline[0].actor_role).toBe('PATHOLOGIST');
    expect(timeline[0].event_status).toBe('verified');
    expect(timeline[0].payload.result_ids).toEqual(expect.arrayContaining([first, second]));

    const audit = await auditEventsFor('lab_pathologist_signoffs', signoff.id, 'lab.result_signed_off');
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_uid).toBe(PATHOLOGIST_UID);
    expect(audit[0].actor_role).toBe('PATHOLOGIST');
    expect(audit[0].metadata?.result_ids).toEqual(expect.arrayContaining([first, second]));
  });

  it('a rejected sign-off carries the rejected decision on the canonical event', async () => {
    const invId = await seedInvestigation({ status: 'IN_PROGRESS' });
    const resultId = await seedResult(invId, { testCode: 'NA', testName: 'Sodium', value: '141' });

    const signoff = await labResults.signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [resultId],
      decision: 'rejected',
      patient_uid: PATIENT_UID,
    });

    const timeline = await timelineEventsFor('lab_pathologist_signoffs', signoff.id, 'lab.result_signed_off');
    expect(timeline).toHaveLength(1);
    expect(timeline[0].event_status).toBe('rejected');
  });
});
