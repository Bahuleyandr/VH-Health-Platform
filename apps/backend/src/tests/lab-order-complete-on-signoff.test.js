// Regression test for the P2 finding:
//   Verified lab orders stay IN_PROGRESS after result.
//
// signOffResults finalises lab_results but never advanced the linked
// investigation (lab order) from IN_PROGRESS → COMPLETED, so the ordering
// screen never reflected that the lab work was done. The order is now
// completed once all of its results are finalised (a partial sign-off of a
// multi-analyte panel leaves it in progress).

import prisma from '../lib/prisma.js';
import * as labResults from '../services/lab/labResultsService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b70701';
const PATHOLOGIST_UID = 'b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b70709';

const createdInvestigationIds = [];
const createdResultIds = [];

async function seedInvestigation() {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations
       (patient_uid, phone, test_name, status, tenant_id, updated_at)
     VALUES ($1::uuid, '9007070701', 'CBC', 'IN_PROGRESS', $2::uuid, NOW())
     RETURNING id`,
    PATIENT_UID, TENANT,
  );
  createdInvestigationIds.push(rows[0].id);
  return rows[0].id;
}

async function seedResult(investigationId) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, investigation_id, test_code, test_name, value_text, status)
     VALUES ($1::uuid, $2::uuid, $3::int, 'HB', 'Haemoglobin', '12.5', 'preliminary')
     RETURNING id`,
    TENANT, PATIENT_UID, investigationId,
  );
  createdResultIds.push(rows[0].id);
  return rows[0].id;
}

async function investigationStatus(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT status FROM investigations WHERE id = $1::int`, id,
  );
  return rows[0]?.status;
}

async function investigationState(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT status, completed_at FROM investigations WHERE id = $1::int`, id,
  );
  return rows[0];
}

describe('Lab order completes on result sign-off', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, updated_at)
       VALUES ($1::uuid, '9007070701', 'Lab Order Patient', 'PATIENT', true, NOW())
       ON CONFLICT (uid) DO NOTHING`, PATIENT_UID);
  });

  afterAll(async () => {
    for (const id of createdResultIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM lab_pathologist_signoffs WHERE $1 = ANY(result_ids)`, id).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE id = $1::int`, id).catch(() => {});
    }
    for (const id of createdInvestigationIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM investigations WHERE id = $1::int`, id).catch(() => {});
    }
    await prisma.$executeRawUnsafe(`DELETE FROM users WHERE uid = $1::uuid`, PATIENT_UID).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('moves a single-result order to COMPLETED on verified sign-off', async () => {
    const invId = await seedInvestigation();
    const resultId = await seedResult(invId);

    expect(await investigationStatus(invId)).toBe('IN_PROGRESS');

    await labResults.signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [resultId],
      decision: 'verified',
      patient_uid: PATIENT_UID,
    });

    const state = await investigationState(invId);
    expect(state.status).toBe('COMPLETED');
    expect(state.completed_at).toBeTruthy();
  });

  it('leaves a multi-result order IN_PROGRESS until every result is final', async () => {
    const invId = await seedInvestigation();
    const first = await seedResult(invId);
    const second = await seedResult(invId);

    // Sign off only the first analyte — the second is still preliminary.
    await labResults.signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [first],
      decision: 'verified',
      patient_uid: PATIENT_UID,
    });
    expect(await investigationStatus(invId)).toBe('IN_PROGRESS');

    // Sign off the second — now all results are final → order completes.
    await labResults.signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [second],
      decision: 'verified',
      patient_uid: PATIENT_UID,
    });
    expect(await investigationStatus(invId)).toBe('COMPLETED');
  });

  it('does not complete the order on a non-verifying decision', async () => {
    const invId = await seedInvestigation();
    const resultId = await seedResult(invId);

    await labResults.signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [resultId],
      decision: 'rejected',
      patient_uid: PATIENT_UID,
    });

    expect(await investigationStatus(invId)).toBe('IN_PROGRESS');
  });
});
