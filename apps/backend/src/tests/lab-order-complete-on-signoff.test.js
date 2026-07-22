// Regression test for the P2 finding:
//   Verified lab orders stay IN_PROGRESS after result.
//
// signOffResults finalises lab_results but never advanced the linked
// investigation (lab order) from IN_PROGRESS → COMPLETED, so the ordering
// screen never reflected that the lab work was done. The order is now
// completed once all of its results are finalised (a partial sign-off of a
// multi-analyte panel leaves it in progress).

import prisma, { setTenantTx } from '../lib/prisma.js';
import * as labResults from '../services/lab/labResultsService.js';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b70701';
const PATHOLOGIST_UID = 'b7b7b7b7-b7b7-4b7b-8b7b-b7b7b7b70709';

const createdInvestigationIds = [];
const createdResultIds = [];
const createdClinicalOrderIds = [];

async function seedInvestigation({ notes = null, testName = 'CBC', priority = 'NORMAL' } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations
       (patient_uid, phone, test_name, status, tenant_id, priority, notes, updated_at)
     VALUES ($1::uuid, '9007070701', $3, 'IN_PROGRESS', $2::uuid, $4, $5, NOW())
     RETURNING id`,
    PATIENT_UID, TENANT, testName, priority, notes,
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

async function seedClinicalOrder() {
  const orderNumber = `D44-LAB-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_orders
       (tenant_id, order_number, patient_uid, order_type, priority, details, status, ordered_by, created_at, updated_at)
     VALUES ($1::uuid, $2, $3::uuid, 'investigation', 'stat', $4::jsonb, 'ordered', $5::uuid, NOW(), NOW())
     RETURNING id`,
    TENANT,
    orderNumber,
    PATIENT_UID,
    JSON.stringify({ test_name: 'Troponin I', source: 'er' }),
    PATHOLOGIST_UID,
  );
  createdClinicalOrderIds.push(rows[0].id);
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

async function clinicalOrderState(id) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT status, completed_at, completed_by FROM clinical_orders WHERE id = $1::int`, id,
  );
  return rows[0];
}

describe('Lab order completes on result sign-off', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO users
         (uid, tenant_id, phone, name, role, status, is_active, is_deleted, updated_at)
       VALUES
         ($1::uuid, $3::uuid, '9007070701', 'Lab Order Patient', 'PATIENT', 'active', true, false, NOW()),
         ($2::uuid, $3::uuid, '9007070709', 'Lab Order Pathologist', 'PATHOLOGIST', 'active', true, false, NOW())
       ON CONFLICT (uid) DO UPDATE
         SET tenant_id = EXCLUDED.tenant_id,
             role = EXCLUDED.role,
             status = EXCLUDED.status,
             is_active = true,
             is_deleted = false,
             deleted_at = NULL`,
      PATIENT_UID, PATHOLOGIST_UID, TENANT);
  });

  afterAll(async () => {
    await setTenantTx(TENANT, async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `DELETE FROM diagnostic_result_actions
          WHERE tenant_id = $1::uuid
            AND generation_id IN (
              SELECT id
                FROM diagnostic_result_generations
               WHERE tenant_id = $1::uuid
                 AND patient_uid = $2::uuid
            )`,
        TENANT,
        PATIENT_UID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM diagnostic_result_generation_items
          WHERE tenant_id = $1::uuid
            AND generation_id IN (
              SELECT id
                FROM diagnostic_result_generations
               WHERE tenant_id = $1::uuid
                 AND patient_uid = $2::uuid
            )`,
        TENANT,
        PATIENT_UID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM diagnostic_result_generations
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid`,
        TENANT,
        PATIENT_UID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_timeline_events
          WHERE tenant_id = $1::uuid
            AND patient_uid = $2::uuid`,
        TENANT,
        PATIENT_UID,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM lab_pathologist_signoffs
          WHERE tenant_id = $1::uuid
            AND result_ids && $2::int[]`,
        TENANT,
        createdResultIds,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM lab_results
          WHERE tenant_id = $1::uuid
            AND id = ANY($2::int[])`,
        TENANT,
        createdResultIds,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM investigations
          WHERE tenant_id = $1::uuid
            AND id = ANY($2::int[])`,
        TENANT,
        createdInvestigationIds,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_orders
          WHERE tenant_id = $1::uuid
            AND id = ANY($2::int[])`,
        TENANT,
        createdClinicalOrderIds,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM users
          WHERE tenant_id = $1::uuid
            AND uid = ANY($2::uuid[])`,
        TENANT,
        [PATIENT_UID, PATHOLOGIST_UID],
      );
    });
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

  it('rejects a non-sign-off decision without completing the order', async () => {
    const invId = await seedInvestigation();
    const resultId = await seedResult(invId);

    await expect(labResults.signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [resultId],
      decision: 'rejected',
      patient_uid: PATIENT_UID,
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_SIGNOFF_DECISION_UNSUPPORTED',
    });

    expect(await investigationStatus(invId)).toBe('IN_PROGRESS');
  });

  it('completes the linked clinical lab order when a verified STAT result closes the investigation', async () => {
    const clinicalOrderId = await seedClinicalOrder();
    const invId = await seedInvestigation({
      testName: 'Troponin I',
      priority: 'STAT',
      notes: `ED chest-pain pathway; clinical_order_id:${clinicalOrderId}`,
    });
    const resultId = await seedResult(invId, {
      testCode: 'TROPI',
      testName: 'Troponin I',
      value: '0.01',
    });

    await labResults.signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [resultId],
      decision: 'verified',
      patient_uid: PATIENT_UID,
    });

    const order = await clinicalOrderState(clinicalOrderId);
    expect(await investigationStatus(invId)).toBe('COMPLETED');
    expect(order.status).toBe('completed');
    expect(order.completed_at).toBeTruthy();
    expect(String(order.completed_by)).toBe(PATHOLOGIST_UID);
  });
});
