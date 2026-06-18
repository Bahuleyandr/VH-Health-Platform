// Results-inbox safety net — abnormal_result_triage wiring (deep, real-PG).
//
// Proves forward-roadmap item #4: when a clinical_ai_reviews row for
// module_key='abnormal_result_triage' is accepted via updateReview(), the
// resultsInboxService.promoteAbnormalTriageResult bridge is invoked and
// (when the tenant module is ENABLED) creates an ack-tracked `tasks` row
// with related_resource_type='abnormal_triage' and related_resource_id=
// the generation id.
//
// Two sub-cases:
//   1. Module ENABLED  → accepted review creates a tasks row (positive path).
//   2. Module DISABLED → same call creates NO task (enable-gate path).
//
// Uses the default test tenant (TENANT_ID below) and inserts recognisable
// seeded rows that are cleaned up in afterAll.

import { jest } from '@jest/globals';

const prisma = (await import('../lib/prisma.js')).default;
const { updateReview } = await import('../services/ai/clinicalAiWorkflowService.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const MODULE_KEY = 'abnormal_result_triage';

// Unique-per-run suffix keeps rows isolated even if a previous run's cleanup
// was skipped (e.g. an aborted test run).
const SUFFIX = String(Date.now() % 100_000).padStart(5, '0');
// A stable test patient UID recognisable in the DB.
const PATIENT_UID = `ab000000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
// A reviewer actor (ADMIN used so allowReviewRoleOverride works).
const REVIEWER_UID = `ab010000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const REVIEWER_PHONE = `+9197001${SUFFIX}`;
const PATIENT_PHONE = `+9197002${SUFFIX}`;

// Resource type produced by promoteAbnormalTriageResult → enqueueCriticalResultTask.
const RESOURCE_TYPE = 'abnormal_triage';

// IDs set during beforeAll seeding — referenced across tests.
let enabledGenId = null;   // generation_id for the enabled-module test
let enabledRevId = null;   // review id for the enabled-module test
let disabledGenId = null;  // generation_id for the disabled-module test
let disabledRevId = null;  // review id for the disabled-module test

// ── helpers ────────────────────────────────────────────────────────────────

async function taskExistsForResource(resourceId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM tasks
      WHERE tenant_id = $1::uuid
        AND related_resource_type = $2
        AND related_resource_id = $3::text
      LIMIT 1`,
    TENANT_ID,
    RESOURCE_TYPE,
    String(resourceId),
  );
  return rows.length > 0;
}

async function seedGeneration() {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_generations
       (tenant_id, task_type, module_key, provider, prompt_version, status)
     VALUES ($1::uuid, $2, $3, 'template', 'clinical-doc-v1', 'draft')
     RETURNING id`,
    TENANT_ID,
    MODULE_KEY,
    MODULE_KEY,
  );
  return rows[0].id;
}

async function seedReview(generationId) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_reviews
       (tenant_id, generation_id, module_key, patient_uid, decision, metadata)
     VALUES ($1::uuid, $2::int, $3, $4::uuid, 'pending', '{}'::jsonb)
     RETURNING id`,
    TENANT_ID,
    generationId,
    MODULE_KEY,
    PATIENT_UID,
  );
  return rows[0].id;
}

async function setModuleEnabled(enabled) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO clinical_ai_tenant_modules (tenant_id, module_key, enabled)
     VALUES ($1::uuid, $2, $3)
     ON CONFLICT (tenant_id, module_key)
     DO UPDATE SET enabled = $3, updated_at = NOW()`,
    TENANT_ID,
    MODULE_KEY,
    enabled,
  );
}

async function cleanup() {
  // Remove tasks created for our resource ids.
  for (const genId of [enabledGenId, disabledGenId]) {
    if (genId == null) continue;
    await prisma.$executeRawUnsafe(
      `DELETE FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = $2
          AND related_resource_id = $3::text`,
      TENANT_ID,
      RESOURCE_TYPE,
      String(genId),
    ).catch(() => {});
    // SLA instances referencing these resources.
    await prisma.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND rule_code = 'critical_result_ack'
          AND source_table = $2
          AND source_id = $3::text`,
      TENANT_ID,
      RESOURCE_TYPE,
      String(genId),
    ).catch(() => {});
  }
  // Remove seeded reviews + generations.
  for (const revId of [enabledRevId, disabledRevId]) {
    if (revId == null) continue;
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_ai_reviews WHERE id = $1::int AND tenant_id = $2::uuid`,
      revId,
      TENANT_ID,
    ).catch(() => {});
  }
  for (const genId of [enabledGenId, disabledGenId]) {
    if (genId == null) continue;
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_ai_generations WHERE id = $1::int AND tenant_id = $2::uuid`,
      genId,
      TENANT_ID,
    ).catch(() => {});
  }
  // Remove test users.
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`,
    PATIENT_UID,
    REVIEWER_UID,
  ).catch(() => {});
  // Restore module to disabled (the platform default).
  await setModuleEnabled(false).catch(() => {});
}

// ── suite ───────────────────────────────────────────────────────────────────

d('Results-inbox — abnormal_result_triage wiring (deep, real-PG)', () => {
  beforeAll(async () => {
    await cleanup();

    // Seed the two test users.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'ART Patient [test]', 'PATIENT', true, $3::uuid, NOW()),
              ($4::uuid, $5, 'ART Reviewer [test]', 'ADMIN', true, $3::uuid, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      PATIENT_UID,
      PATIENT_PHONE,
      TENANT_ID,
      REVIEWER_UID,
      REVIEWER_PHONE,
    );

    // Seed two generations + two reviews (one per module-enabled state).
    enabledGenId = await seedGeneration();
    enabledRevId = await seedReview(enabledGenId);

    disabledGenId = await seedGeneration();
    disabledRevId = await seedReview(disabledGenId);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  // ── positive path ──────────────────────────────────────────────────────

  it('module ENABLED: accepting the review creates a tasks row (resourceType=abnormal_triage)', async () => {
    // Enable the module before calling accept.
    await setModuleEnabled(true);

    const review = await updateReview(
      enabledRevId,
      {
        decision: 'accepted',
        reviewer_note: 'Confirmed abnormal potassium result requires immediate review',
      },
      REVIEWER_UID,
      'ADMIN',
      { tenantId: TENANT_ID, allowReviewRoleOverride: true },
    );

    // The call must not throw and must return the updated review.
    expect(review.decision).toBe('accepted');

    // The inbox task must now exist.
    const exists = await taskExistsForResource(enabledGenId);
    expect(exists).toBe(true);
  });

  it('module ENABLED: the task carries the correct tenant_id and resource columns', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, related_resource_type, related_resource_id, status, priority
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = $2
          AND related_resource_id = $3::text
        LIMIT 1`,
      TENANT_ID,
      RESOURCE_TYPE,
      String(enabledGenId),
    );
    expect(rows.length).toBe(1);
    const task = rows[0];
    expect(String(task.tenant_id)).toBe(TENANT_ID);
    expect(task.related_resource_type).toBe(RESOURCE_TYPE);
    expect(String(task.related_resource_id)).toBe(String(enabledGenId));
    // The producer must not have left the task in a terminal state.
    expect(['open', 'in_progress', 'blocked']).toContain(task.status);
  });

  // ── enable-gate (negative) path ────────────────────────────────────────

  it('module DISABLED: accepting an abnormal_result_triage review creates NO task', async () => {
    // Ensure module is OFF for this sub-test.
    await setModuleEnabled(false);

    const review = await updateReview(
      disabledRevId,
      {
        decision: 'accepted',
        reviewer_note: 'Gate test — module disabled should suppress task creation',
      },
      REVIEWER_UID,
      'ADMIN',
      { tenantId: TENANT_ID, allowReviewRoleOverride: true },
    );

    expect(review.decision).toBe('accepted');

    // No task should have been created.
    const exists = await taskExistsForResource(disabledGenId);
    expect(exists).toBe(false);
  });
});

void jest;
