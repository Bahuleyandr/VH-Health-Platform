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

import prisma from '../lib/prisma.js';
import { recordResultManual } from '../services/lab/labResultsService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'f4444444-4444-4444-8444-cccccccc5d40';
const LAB_TECH_UID = 'f4444444-4444-4444-8444-cccccccc5d41';

let investigationId;

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
    await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
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
    await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM investigations WHERE patient_uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, LAB_TECH_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('rejects a duplicate HGB submit after the existing row is FINAL (the repro)', async () => {
    await freshResult({ test_code: 'HGB', status: 'final', value_text: '13.2' });
    await expect(
      recordResultManual({
        tenantId: TENANT, performed_by: LAB_TECH_UID,
        result: {
          investigation_id: investigationId, patient_uid: PATIENT_UID,
          test_code: 'HGB', test_name: 'Hemoglobin', value_text: '12.8',
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAB_RESULT_DUPLICATE_ANALYTE',
      details: expect.objectContaining({
        investigation_id: investigationId,
        test_code: 'HGB',
        existing_status: 'final',
      }),
    });
  });

  it('rejects a duplicate even when caller uses lowercase test_code (case-insensitive match)', async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await freshResult({ test_code: 'WBC', status: 'verified', value_text: '7.5' });
    await expect(
      recordResultManual({
        tenantId: TENANT, performed_by: LAB_TECH_UID,
        result: {
          investigation_id: investigationId, patient_uid: PATIENT_UID,
          test_code: 'wbc', test_name: 'White Cell Count', value_text: '7.4',
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'LAB_RESULT_DUPLICATE_ANALYTE' });
  });

  it('ALLOWS the FIRST result submission for an analyte (no prior row)', async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE patient_uid = $1::uuid`, PATIENT_UID);
    const out = await recordResultManual({
      tenantId: TENANT, performed_by: LAB_TECH_UID,
      result: {
        investigation_id: investigationId, patient_uid: PATIENT_UID,
        test_code: 'PLT', test_name: 'Platelet Count', value_text: '275',
      },
    });
    expect(out.result.id).toBeTruthy();
    expect(out.result.status).toBe('preliminary');
  });

  it('ALLOWS another submission for a DIFFERENT analyte even when one analyte is already finalised', async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await freshResult({ test_code: 'HGB', status: 'final', value_text: '13.2' });
    const out = await recordResultManual({
      tenantId: TENANT, performed_by: LAB_TECH_UID,
      result: {
        investigation_id: investigationId, patient_uid: PATIENT_UID,
        test_code: 'RBC', test_name: 'RBC Count', value_text: '4.8',
      },
    });
    expect(out.result.id).toBeTruthy();
    expect(out.result.test_code).toBe('RBC');
  });

  it('ALLOWS a re-submission while the only prior row is still PRELIMINARY (no sign-off yet)', async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE patient_uid = $1::uuid`, PATIENT_UID);
    await freshResult({ test_code: 'HCT', status: 'preliminary', value_text: '40' });
    const out = await recordResultManual({
      tenantId: TENANT, performed_by: LAB_TECH_UID,
      result: {
        investigation_id: investigationId, patient_uid: PATIENT_UID,
        test_code: 'HCT', test_name: 'Hematocrit', value_text: '41',
      },
    });
    expect(out.result.id).toBeTruthy();
  });
});
