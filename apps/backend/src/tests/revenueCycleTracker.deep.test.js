// src/tests/revenueCycleTracker.deep.test.js
//
// Deep real-PG integration test for the revenue_cycle_runs tracker.
// Requires QA Postgres at 127.0.0.1:55432.
// DATABASE_URL must point there; if not set the describe block is skipped.

import prisma from '../lib/prisma.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';

const {
  runRevenueCycleSweep,
  listRevenueCycleRuns,
  getRevenueCycleRun,
} = await import('../services/billing/revenueCycleTrackerService.js');

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const TENANT = DEFAULT_TENANT_ID; // '00000000-0000-4000-8000-000000000001'

// Seed helpers — insert the minimal required rows and return their ids.
async function seedPriorAuth(overrides = {}) {
  const [row] = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_prior_auth_requests
       (tenant_id, patient_uid, procedure_code, payer_name, medical_necessity, packet_draft, status, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, '{}'::jsonb, $6, NOW(), NOW())
     RETURNING id`,
    TENANT,
    overrides.patient_uid ?? '11111111-1111-4000-8000-000000000001',
    overrides.procedure_code ?? 'CPT-99213',
    overrides.payer_name ?? 'TestPayer',
    overrides.medical_necessity ?? 'Test medical necessity for deep test fixture',
    overrides.status ?? 'denied',
  );
  return Number(row.id);
}

async function seedAppeal(priorAuthId, overrides = {}) {
  // clinical_ai_appeal_letters has several NOT NULL columns without defaults.
  // chk_appeal_single_source: exactly one of claim_id / prior_auth_id must be non-NULL.
  const [row] = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_appeal_letters
       (tenant_id, patient_uid, prior_auth_id,
        denial_classification, appeal_type,
        letter_draft, clinical_evidence, source_citations, safety_flags,
        appeal_status, reviewer_decision,
        metadata, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3,
             $4, $5,
             '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
             $6, 'pending',
             '{}'::jsonb, NOW(), NOW())
     RETURNING id`,
    TENANT,
    overrides.patient_uid ?? '11111111-1111-4000-8000-000000000001',
    priorAuthId,
    overrides.denial_classification ?? 'medical_necessity',
    overrides.appeal_type ?? 'clinical',
    overrides.appeal_status ?? 'submitted',
  );
  return Number(row.id);
}

async function cleanupRun(caseKey) {
  await prisma.$executeRawUnsafe(
    `DELETE FROM revenue_cycle_runs WHERE tenant_id = $1::uuid AND case_key = $2`,
    TENANT, caseKey,
  );
}

d('revenueCycleTracker (deep)', () => {
  let paId;
  let appealId;

  beforeAll(async () => {
    paId = await seedPriorAuth({ status: 'denied' });
    appealId = await seedAppeal(paId, { appeal_status: 'submitted' });
  });

  afterAll(async () => {
    // Clean up in dependency order.
    if (appealId) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM clinical_ai_appeal_letters WHERE id = $1`, appealId,
      ).catch(() => {});
    }
    if (paId) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM clinical_ai_prior_auth_requests WHERE id = $1`, paId,
      ).catch(() => {});
    }
    if (paId) {
      await cleanupRun(`prior_auth:${paId}`).catch(() => {});
    }
    await prisma.$disconnect();
  });

  it('creates a revenue_cycle_runs row with stage=appeal after denied PA + submitted appeal', async () => {
    await runRevenueCycleSweep({ tenantId: TENANT });

    const { runs } = await listRevenueCycleRuns({ tenantId: TENANT, limit: 200 });
    const run = runs.find((r) => r.case_key === `prior_auth:${paId}`);

    expect(run).toBeTruthy();
    expect(run.current_stage).toBe('appeal');
    expect(run.status).toBe('open');
    expect(Number(run.prior_auth_id)).toBe(paId);
    expect(Number(run.appeal_id)).toBe(appealId);
  });

  it('advances stage to resolved + records stage_history when appeal is approved', async () => {
    // Flip appeal to approved.
    await prisma.$executeRawUnsafe(
      `UPDATE clinical_ai_appeal_letters SET appeal_status = 'approved', updated_at = NOW() WHERE id = $1`,
      appealId,
    );

    await runRevenueCycleSweep({ tenantId: TENANT });

    const run = await getRevenueCycleRun({ tenantId: TENANT, caseKey: `prior_auth:${paId}` });

    expect(run).toBeTruthy();
    expect(run.current_stage).toBe('resolved');
    expect(run.status).toBe('resolved');
    expect(run.resolved_at).not.toBeNull();

    const history = Array.isArray(run.stage_history) ? run.stage_history : JSON.parse(run.stage_history ?? '[]');
    const resolvedEntry = history.find((h) => h.stage === 'resolved');
    expect(resolvedEntry).toBeTruthy();
  });

  it('listRevenueCycleRuns returns the run (no duplicates after two sweeps)', async () => {
    const { runs } = await listRevenueCycleRuns({ tenantId: TENANT, limit: 200 });
    const matching = runs.filter((r) => r.case_key === `prior_auth:${paId}`);
    // UPSERT guarantee: exactly one row, not two.
    expect(matching).toHaveLength(1);
  });
});
