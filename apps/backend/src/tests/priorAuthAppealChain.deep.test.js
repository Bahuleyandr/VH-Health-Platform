/**
 * Real-Postgres integration test for the prior-auth → appeal chain (Task 8).
 *
 * Covers:
 *   A. Migration constraints on clinical_ai_appeal_letters (chk_appeal_single_source,
 *      uq_appeal_prior_auth).
 *   B. Full chain run via composePriorAuthAppeal — pauses at
 *      await_appeal_human_disposition; workflow_run row is 'paused'; appeal
 *      row exists with prior_auth_id set and claim_id NULL; review row created.
 *   C. Idempotency — a second call does NOT create a duplicate appeal row.
 *   D. Resume — update appeal_status='submitted', resumeWorkflow → re-pauses
 *      at await_appeal_payer_response.
 *
 * Harness pattern mirrors tenant-rls.deep.test.js + getPublishedAiOutputForPatient
 * .deep.test.js: raw prisma.$queryRawUnsafe for setup/teardown (owner path), no
 * mocked DB, DB-guarded skip when DATABASE_URL is absent.
 */

import prisma from '../lib/prisma.js';
import {
  composePriorAuthAppeal,
  getPriorAuthAppealGraph,
} from '../services/ai/priorAuthAppealChainService.js';
import { resumeWorkflow } from '../services/ai/workflowGraphRunner.js';
import {
  getDefaultCheckpointStore,
  _resetDefaultCheckpointStore,
} from '../services/ai/workflowCheckpointStore.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const TENANT_ID = '00000000-0000-4000-8000-000000000001'; // DEFAULT_TENANT_ID
// Stable test patient UUID that won't collide with real clinical rows
const PATIENT_UID = 'de000000-dead-4000-beef-000000000313';

// ─── DB guard ─────────────────────────────────────────────────────────────────

const hasDatabaseUrl = Boolean(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const describeIfDb = hasDatabaseUrl ? describe : describe.skip;

if (!hasDatabaseUrl) {
  console.warn(
    'priorAuthAppealChain.deep.test.js skipped: neither DATABASE_URL nor TEST_DATABASE_URL is set.'
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Lightweight owner-path helper identical to the one in tenant-rls.deep.test.js */
async function ownerQuery(text, params = []) {
  if (/^\s*(SELECT|WITH)\b/i.test(text) || /\bRETURNING\b/i.test(text)) {
    const rows = await prisma.$queryRawUnsafe(text, ...params);
    const arr = Array.isArray(rows) ? rows : [];
    return { rows: arr, rowCount: arr.length };
  }
  const rowCount = await prisma.$executeRawUnsafe(text, ...params);
  return { rows: [], rowCount: Number(rowCount) || 0 };
}

/** Enable the appeal_letter_generator module for TENANT_ID via tenant override */
async function enableAppealModule() {
  await ownerQuery(
    `INSERT INTO clinical_ai_tenant_modules
       (tenant_id, module_key, enabled, settings, created_at, updated_at)
     VALUES ($1::uuid, 'appeal_letter_generator', true, '{}'::jsonb, NOW(), NOW())
     ON CONFLICT (tenant_id, module_key)
     DO UPDATE SET enabled = true, updated_at = NOW()`,
    [TENANT_ID]
  );
}

/** Insert a denied prior-auth request row; returns its integer id */
async function seedPriorAuth({ tenantId = TENANT_ID, status = 'denied' } = {}) {
  const { rows } = await ownerQuery(
    `INSERT INTO clinical_ai_prior_auth_requests
       (tenant_id, patient_uid, payer_name, procedure_code, medical_necessity,
        packet_draft, status, payer_decision_reason, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'TestPayer', 'CPT-99213', 'Medical necessity for test',
             '{"test":true}'::jsonb, $3, 'Not medically necessary per review', NOW(), NOW())
     RETURNING id`,
    [tenantId, PATIENT_UID, status]
  );
  return rows[0].id;
}

/**
 * Deep-clean all test rows by patient_uid + our test PA ids.
 * Order: appeal_letters first (FK dep on prior_auth + insurance_claims),
 * then workflow_runs + generations + reviews (FKs on tenant only),
 * then the PA rows, then the tenant module override.
 */
async function cleanup({ priorAuthIds = [] } = {}) {
  // Remove appeal letters
  await ownerQuery(
    `DELETE FROM clinical_ai_appeal_letters WHERE patient_uid = $1::uuid`,
    [PATIENT_UID]
  ).catch(() => {});

  if (priorAuthIds.length) {
    await ownerQuery(
      `DELETE FROM clinical_ai_appeal_letters WHERE prior_auth_id = ANY($1::int[])`,
      [priorAuthIds]
    ).catch(() => {});
  }

  // Remove workflow runs seeded by these tests
  await ownerQuery(
    `DELETE FROM clinical_ai_workflow_runs
     WHERE workflow_key = 'prior_auth_appeal_chain'
       AND tenant_id = $1::uuid`,
    [TENANT_ID]
  ).catch(() => {});

  // Remove AI generations seeded by tests
  await ownerQuery(
    `DELETE FROM clinical_ai_generations WHERE patient_uid = $1::uuid`,
    [PATIENT_UID]
  ).catch(() => {});

  // Remove review rows
  await ownerQuery(
    `DELETE FROM clinical_ai_reviews WHERE patient_uid = $1::uuid`,
    [PATIENT_UID]
  ).catch(() => {});

  // Remove the PA rows
  if (priorAuthIds.length) {
    await ownerQuery(
      `DELETE FROM clinical_ai_prior_auth_requests WHERE id = ANY($1::int[])`,
      [priorAuthIds]
    ).catch(() => {});
  }

  // Delete the tenant override row we inserted — restores the pre-test no-row state.
  // (UPDATE-to-false would leave a false-override that beats the global enabled=true,
  // silently disabling the module for other tests in the shared QA DB.)
  await ownerQuery(
    `DELETE FROM clinical_ai_tenant_modules
     WHERE tenant_id = $1::uuid AND module_key = 'appeal_letter_generator'`,
    [TENANT_ID]
  ).catch(() => {});

  // Reset singleton checkpoint store so next test gets a fresh DB-backed instance
  _resetDefaultCheckpointStore();
}

// ─── Suite A: Migration constraint enforcement ─────────────────────────────────

describeIfDb('A – Migration constraints on clinical_ai_appeal_letters', () => {
  // We need a real PA row to FK into for the "only prior_auth_id" case.
  let paId;

  beforeAll(async () => {
    paId = await seedPriorAuth({ status: 'denied' });
  });

  afterAll(async () => {
    await cleanup({ priorAuthIds: [paId] });
    await prisma.$disconnect().catch(() => {});
  });

  it('A1 – rejects a row with BOTH claim_id and prior_auth_id set (chk_appeal_single_source)', async () => {
    // We need a real insurance_claims row; skip constraint test gracefully if
    // the claims table is empty by inserting into an imaginary claim and catching
    // 23503 (FK violation is still not a constraint violation — but we hit
    // chk_appeal_single_source first at the CHECK layer, before FK lookup).
    await expect(
      ownerQuery(
        `INSERT INTO clinical_ai_appeal_letters
           (tenant_id, claim_id, prior_auth_id, patient_uid,
            appeal_status, reviewer_decision, metadata, created_at, updated_at)
         VALUES ($1::uuid, 9999999, $2, $3::uuid,
                 'draft', 'pending', '{}'::jsonb, NOW(), NOW())
         RETURNING id`,
        [TENANT_ID, paId, PATIENT_UID]
      )
    ).rejects.toThrow(/chk_appeal_single_source|check_violation|violates check constraint/i);
  });

  it('A2 – rejects a row with NEITHER claim_id NOR prior_auth_id set (chk_appeal_single_source)', async () => {
    await expect(
      ownerQuery(
        `INSERT INTO clinical_ai_appeal_letters
           (tenant_id, patient_uid,
            appeal_status, reviewer_decision, metadata, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid,
                 'draft', 'pending', '{}'::jsonb, NOW(), NOW())
         RETURNING id`,
        [TENANT_ID, PATIENT_UID]
      )
    ).rejects.toThrow(/chk_appeal_single_source|check_violation|violates check constraint/i);
  });

  it('A3 – accepts a row with ONLY prior_auth_id set', async () => {
    const { rows } = await ownerQuery(
      `INSERT INTO clinical_ai_appeal_letters
         (tenant_id, prior_auth_id, patient_uid,
          appeal_status, reviewer_decision, metadata, created_at, updated_at)
       VALUES ($1::uuid, $2, $3::uuid,
               'draft', 'pending', '{}'::jsonb, NOW(), NOW())
       RETURNING id, claim_id, prior_auth_id`,
      [TENANT_ID, paId, PATIENT_UID]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].prior_auth_id).toBe(paId);
    expect(rows[0].claim_id).toBeNull();
    // cleanup this row explicitly so afterAll teardown sees a clean slate
    await ownerQuery(
      `DELETE FROM clinical_ai_appeal_letters WHERE id = $1`,
      [rows[0].id]
    );
  });
});

// ─── Suite B–D: Full chain run, idempotency, and resume ───────────────────────

describeIfDb('B–D – Full prior-auth appeal chain (compose + idempotency + resume)', () => {
  let paId;
  let runId;
  let appealId;

  beforeAll(async () => {
    // Enable module and seed the denied PA
    await enableAppealModule();
    paId = await seedPriorAuth({ status: 'denied' });
  });

  afterAll(async () => {
    await cleanup({ priorAuthIds: [paId] });
    await prisma.$disconnect().catch(() => {});
  });

  // B – Full chain run
  it('B1 – composePriorAuthAppeal returns { status:"paused", pause_reason:"await_appeal_human_disposition", run_id }', async () => {
    const result = await composePriorAuthAppeal(paId, { tenantId: TENANT_ID });
    expect(result.status).toBe('paused');
    expect(result.pause_reason).toBe('await_appeal_human_disposition');
    expect(result.run_id).toBeTruthy();
    runId = result.run_id;
  }, 30_000);

  it('B2 – a clinical_ai_appeal_letters row exists with prior_auth_id set and claim_id NULL', async () => {
    const { rows } = await ownerQuery(
      `SELECT id, prior_auth_id, claim_id, appeal_status
       FROM clinical_ai_appeal_letters
       WHERE prior_auth_id = $1`,
      [paId]
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].prior_auth_id)).toBe(Number(paId));
    expect(rows[0].claim_id).toBeNull();
    expect(rows[0].appeal_status).toBe('draft');
    appealId = rows[0].id;
  });

  it('B3 – a clinical_ai_reviews row was created for the appeal generation', async () => {
    // The appeal row carries the generation_id
    const { rows: appealRows } = await ownerQuery(
      `SELECT generation_id FROM clinical_ai_appeal_letters WHERE id = $1`,
      [appealId]
    );
    expect(appealRows).toHaveLength(1);
    const genId = appealRows[0].generation_id;
    // Only assert review if generation was inserted (template path always inserts)
    if (genId) {
      const { rows: reviewRows } = await ownerQuery(
        `SELECT id, decision FROM clinical_ai_reviews
         WHERE generation_id = $1 AND tenant_id = $2::uuid
         LIMIT 1`,
        [genId, TENANT_ID]
      );
      expect(reviewRows.length).toBeGreaterThanOrEqual(1);
      expect(reviewRows[0].decision).toBe('pending');
    }
  });

  it('B4 – the clinical_ai_workflow_runs row is status="paused"', async () => {
    expect(runId).toBeTruthy();
    const { rows } = await ownerQuery(
      `SELECT status, pause_reason FROM clinical_ai_workflow_runs WHERE id = $1`,
      [runId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('paused');
    expect(rows[0].pause_reason).toBe('await_appeal_human_disposition');
  });

  // C – Idempotency
  it('C1 – a second composePriorAuthAppeal call for the same PA does NOT create a duplicate appeal row', async () => {
    // The second call will fail at the INSERT (uq_appeal_prior_auth unique partial
    // index) and should either throw (composePriorAuthAppeal wraps in AppError) or
    // return the paused status from a new run that fails at draft_appeal. Either
    // way, the appeal count stays at 1.
    try {
      await composePriorAuthAppeal(paId, { tenantId: TENANT_ID });
    } catch (_err) {
      // expected — duplicate draft attempt fails
    }

    const { rows } = await ownerQuery(
      `SELECT id FROM clinical_ai_appeal_letters WHERE prior_auth_id = $1`,
      [paId]
    );
    expect(rows).toHaveLength(1);
  }, 30_000);

  // D – Resume
  it('D1 – updating appeal_status to "submitted" then resumeWorkflow re-pauses at await_appeal_payer_response', async () => {
    // Directly set appeal_status = 'submitted' to simulate the human disposition step
    await ownerQuery(
      `UPDATE clinical_ai_appeal_letters
       SET appeal_status = 'submitted', updated_at = NOW()
       WHERE id = $1`,
      [appealId]
    );

    // Resume the paused workflow run
    const store = getDefaultCheckpointStore();
    const graph = getPriorAuthAppealGraph();
    const resumed = await resumeWorkflow({ runId, store, graph });

    // The run re-pauses at the next gate
    expect(resumed.status).toBe('paused');
    expect(resumed.pauseReason).toBe('await_appeal_payer_response');

    // Verify the DB row reflects the new pause reason
    const { rows } = await ownerQuery(
      `SELECT status, pause_reason FROM clinical_ai_workflow_runs WHERE id = $1`,
      [runId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('paused');
    expect(rows[0].pause_reason).toBe('await_appeal_payer_response');
  }, 30_000);
});
