// Atomicity half of the lab canonical-audit invariant (see
// lab-canonical-audit.test.js): the canonical timeline/audit pair is written
// INSIDE the same transaction as the lab detail row, so a canonical-layer
// failure must roll back the whole write — no lab_results row without its
// audit trail, no signoff without its canonical event.
//
// Fault injection: canonicalClinicalPlatformService is module-mocked so
// recordCanonicalClinicalEvent rejects; prisma stays REAL (QA Postgres), so
// the assertion "no row persisted" proves the transaction boundary. The mock
// factory exports every name the loaded import graph pulls from the module
// (ESM mock-graph law — canonicalOperationalBridgeService needs
// completeWorkflowSla/isSchemaMissing/startWorkflowSla, resultsInboxService
// dynamically imports startWorkflowSla).

import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';

jest.unstable_mockModule('../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: jest.fn().mockRejectedValue(new Error('canonical write failed (injected)')),
  recordTimelineEvent: jest.fn().mockResolvedValue(null),
  recordClinicalAuditEvent: jest.fn().mockResolvedValue(null),
  startWorkflowSla: jest.fn().mockResolvedValue(null),
  completeWorkflowSla: jest.fn().mockResolvedValue(null),
  isSchemaMissing: jest.fn(() => false),
}));

const { default: prisma } = await import('../lib/prisma.js');
const labResults = await import('../services/lab/labResultsService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d00901';
const TECH_UID = 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d00902';
const PATHOLOGIST_UID = 'd0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d00903';

const createdInvestigationIds = [];
const createdResultIds = [];

async function seedInvestigation({ status = 'REQUESTED' } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations
       (patient_uid, phone, test_name, status, tenant_id, updated_at)
     VALUES ($1::uuid, '9009090901', 'Potassium', $2, $3::uuid, NOW())
     RETURNING id`,
    PATIENT_UID, status, TENANT,
  );
  createdInvestigationIds.push(rows[0].id);
  return rows[0].id;
}

describe('Lab canonical emission is transactional (rollback on canonical failure)', () => {
  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, tenant_id, phone, name, role, is_active, updated_at)
       VALUES
         ($1::uuid, $4::uuid, '9009090901', 'Lab Atomicity Patient', 'PATIENT', true, NOW()),
         ($2::uuid, $4::uuid, '9009090902', 'Lab Atomicity Technician', 'LAB_STAFF', true, NOW()),
         ($3::uuid, $4::uuid, '9009090903', 'Lab Atomicity Pathologist', 'PATHOLOGIST', true, NOW())
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
    for (const id of createdResultIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE id = $1::int`, id).catch(() => {});
    }
    for (const id of createdInvestigationIds) {
      await prisma.$executeRawUnsafe(`DELETE FROM lab_results WHERE investigation_id = $1::int`, id).catch(() => {});
      await prisma.$executeRawUnsafe(`DELETE FROM investigations WHERE id = $1::int`, id).catch(() => {});
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid)`,
      PATIENT_UID,
      TECH_UID,
      PATHOLOGIST_UID,
    ).catch(() => {});
    await prisma.$disconnect().catch(() => {});
  });

  it('rolls back the lab_results INSERT and the investigation advance when the canonical write fails', async () => {
    const invId = await seedInvestigation({ status: 'REQUESTED' });
    const manualResult = {
      investigation_id: invId,
      patient_uid: PATIENT_UID,
      test_code: 'ATMK',
      test_name: 'Potassium',
      value_text: '4.1',
    };

    await expect(labResults.recordResultManual({
      tenantId: TENANT,
      performed_by: TECH_UID,
      performed_by_role: 'LAB_TECHNICIAN',
      result: manualResult,
      idempotencyKey: 'lab-canonical-atomicity-manual-v1',
      requestBodySha256: createHash('sha256')
        .update(JSON.stringify(manualResult))
        .digest('hex'),
    })).rejects.toThrow('canonical write failed (injected)');

    const results = await prisma.$queryRawUnsafe(
      `SELECT id FROM lab_results WHERE investigation_id = $1::int AND tenant_id = $2::uuid`,
      invId, TENANT,
    );
    expect(results).toHaveLength(0);

    const inv = await prisma.$queryRawUnsafe(
      `SELECT status FROM investigations WHERE id = $1::int`, invId,
    );
    expect(inv[0].status).toBe('REQUESTED');
  });

  it('rolls back the signoff INSERT and the result stamp when the canonical write fails', async () => {
    const invId = await seedInvestigation({ status: 'IN_PROGRESS' });
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_results
         (tenant_id, patient_uid, investigation_id, test_code, test_name, value_text, status)
       VALUES ($1::uuid, $2::uuid, $3::int, 'K', 'Potassium', '4.1', 'preliminary')
       RETURNING id`,
      TENANT, PATIENT_UID, invId,
    );
    const resultId = rows[0].id;
    createdResultIds.push(resultId);

    await expect(labResults.signOffResults({
      tenantId: TENANT,
      signed_off_by: PATHOLOGIST_UID,
      signed_off_by_role: 'PATHOLOGIST',
      result_ids: [resultId],
      decision: 'verified',
      patient_uid: PATIENT_UID,
    })).rejects.toThrow('canonical write failed (injected)');

    const signoffs = await prisma.$queryRawUnsafe(
      `SELECT id FROM lab_pathologist_signoffs WHERE $1 = ANY(result_ids) AND tenant_id = $2::uuid`,
      resultId, TENANT,
    );
    expect(signoffs).toHaveLength(0);

    const result = await prisma.$queryRawUnsafe(
      `SELECT signed_off_at, signed_off_by, status FROM lab_results WHERE id = $1::int`,
      resultId,
    );
    expect(result[0].signed_off_at).toBeNull();
    expect(result[0].signed_off_by).toBeNull();
    expect(result[0].status).toBe('preliminary');
  });
});
