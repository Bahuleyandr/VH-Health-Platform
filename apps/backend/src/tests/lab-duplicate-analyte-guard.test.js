// Regression test for finding 2026-05-23-lab-walk-in-lab-tech-a5accf7a.
//
// `POST /api/v1/lab/results` accepted a duplicate analyte (same
// investigation_id + test_code) AFTER an existing result for that same
// analyte had been verified/finalised. The duplicate landed in the
// pathologist pending queue as a preliminary row — the verifier then
// risked signing two contradictory HGBs for the same CBC, and the
// patient's phone-report walk-in flow saw two values for one analyte.
//
// Fix: guard at the top of `recordResultManual` rejects with
// LAB_RESULT_DUPLICATE_ANALYTE (409) when a final/corrected/verified
// row already exists for the same investigation_id + test_code,
// forcing the caller into the explicit corrected/re-run workflow.

import { createHash } from 'node:crypto';
import prisma from '../lib/prisma.js';
import { recordResultManual } from '../services/lab/labResultsService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'f4444444-4444-4444-8444-cccccccc5d40';
const LAB_TECH_UID = 'f4444444-4444-4444-8444-cccccccc5d41';

let investigationId;
let commandSequence = 0;

function recordManual(result) {
  commandSequence += 1;
  return recordResultManual({
    tenantId: TENANT,
    performed_by: LAB_TECH_UID,
    result,
    idempotencyKey: `duplicate-analyte-${commandSequence}`,
    requestBodySha256: createHash('sha256')
      .update(JSON.stringify(result))
      .digest('hex'),
  });
}

async function cleanupResults() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id
       FROM lab_results
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid`,
    TENANT,
    PATIENT_UID,
  );
  const resultIds = rows.map((row) => Number(row.id));
  if (resultIds.length === 0) return;
  await prisma.$transaction(async (tx) => {
    // Successful service calls create immutable ingest commands. Remove only
    // this fixture's evidence in the disposable superuser test database while
    // retaining the append-only clinical audit chain.
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
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

async function freshResult({ test_code, status = 'preliminary', value_text }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (investigation_id, patient_uid, test_code, test_name,
        value_text, status, performed_by_lab, tenant_id)
     VALUES ($1::int, $2::uuid, $3, $3, $4, $5, $6::uuid, $7::uuid)
     RETURNING id, status`,
    investigationId, PATIENT_UID, test_code, value_text, status, LAB_TECH_UID, TENANT);
  return rows[0];
}

describe('lab result duplicate-analyte guard (a5accf7a)', () => {
  beforeAll(async () => {
    await cleanupResults();
    await prisma.$executeRawUnsafe(`DELETE FROM investigations WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, LAB_TECH_UID).catch(() => {});

    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000660040', 'Dup Analyte Patient', 'PATIENT', true, NOW())`,
      PATIENT_UID);
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9000660041', 'Dup Analyte Tech', 'LAB_STAFF', true, NOW())`,
      LAB_TECH_UID);

    // `investigations` has both legacy `phone` (NOT NULL) and modern
    // `patient_uid` (nullable). Provide both so the row satisfies the
    // legacy constraint AND our service can look up by patient_uid.
    // `tenant_id` column shape varies across migrations; we omit it
    // and rely on the table default where present.
    const inv = await prisma.$queryRawUnsafe(
      `INSERT INTO investigations
         (phone, patient_uid, test_name, status, updated_at)
       VALUES ('9000660040', $1::uuid, 'CBC', 'IN_PROGRESS', NOW())
       RETURNING id`,
      PATIENT_UID);
    investigationId = inv[0].id;
  });

  afterAll(async () => {
    await cleanupResults();
    await prisma.$executeRawUnsafe(`DELETE FROM investigations WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, LAB_TECH_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('rejects a duplicate HGB submit after the existing row is FINAL (the repro)', async () => {
    await freshResult({ test_code: 'DUPHGB', status: 'final', value_text: '13.2' });
    await expect(
      recordManual({
          investigation_id: investigationId, patient_uid: PATIENT_UID,
          test_code: 'DUPHGB', test_name: 'Hemoglobin', value_text: '12.8',
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAB_RESULT_DUPLICATE_ANALYTE',
      details: expect.objectContaining({
        investigation_id: investigationId,
        test_code: 'DUPHGB',
        existing_status: 'final',
      }),
    });
  });

  it('rejects a duplicate even when caller uses lowercase test_code (case-insensitive match)', async () => {
    await cleanupResults();
    await freshResult({ test_code: 'DUPWBC', status: 'verified', value_text: '7.5' });
    await expect(
      recordManual({
          investigation_id: investigationId, patient_uid: PATIENT_UID,
          test_code: 'dupwbc', test_name: 'White Cell Count', value_text: '7.4',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'LAB_RESULT_DUPLICATE_ANALYTE' });
  });

  it('ALLOWS the FIRST result submission for an analyte (no prior row)', async () => {
    await cleanupResults();
    const out = await recordManual({
        investigation_id: investigationId, patient_uid: PATIENT_UID,
        test_code: 'DUPPLT', test_name: 'Platelet Count', value_text: '275',
    });
    expect(out.result.id).toBeTruthy();
    expect(out.result.status).toBe('preliminary');
  });

  it('ALLOWS another submission for a DIFFERENT analyte even when one analyte is already finalised', async () => {
    await cleanupResults();
    await freshResult({ test_code: 'DUPHGB', status: 'final', value_text: '13.2' });
    const out = await recordManual({
        investigation_id: investigationId, patient_uid: PATIENT_UID,
        test_code: 'DUPRBC', test_name: 'RBC Count', value_text: '4.8',
    });
    expect(out.result.id).toBeTruthy();
    expect(out.result.test_code).toBe('DUPRBC');
  });

  it('ALLOWS a re-submission while the only prior row is still PRELIMINARY (no sign-off yet)', async () => {
    await cleanupResults();
    await freshResult({ test_code: 'DUPHCT', status: 'preliminary', value_text: '40' });
    const out = await recordManual({
        investigation_id: investigationId, patient_uid: PATIENT_UID,
        test_code: 'DUPHCT', test_name: 'Hematocrit', value_text: '41',
    });
    expect(out.result.id).toBeTruthy();
  });
});
