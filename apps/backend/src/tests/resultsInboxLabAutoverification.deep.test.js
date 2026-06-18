// Results-inbox safety net — lab_autoverification_delta wiring (deep, real-PG).
//
// Proves forward-roadmap item #4: when decideLabAutoverification() is called
// with decision='accepted', the resultsInboxService.promoteLabAutoverification
// bridge is invoked and (when the tenant module is ENABLED) creates an
// ack-tracked `tasks` row with related_resource_type='lab_autoverification'
// and related_resource_id = the autoverification row id.
//
// Two sub-cases:
//   1. Module ENABLED  → accepted decision creates a tasks row (positive path).
//   2. Module DISABLED → same call creates NO task (enable-gate path).
//
// Uses the default test tenant (TENANT_ID below) and inserts recognisable
// seeded rows that are cleaned up in afterAll.

import { jest } from '@jest/globals';

const prisma = (await import('../lib/prisma.js')).default;
const { decideLabAutoverification } = await import('../services/ai/labAutoverificationService.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const MODULE_KEY = 'lab_autoverification_delta';

// Unique-per-run suffix.
const SUFFIX = String(Date.now() % 100_000).padStart(5, '0');
const PATIENT_UID = `ac000000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const PATIENT_PHONE = `+9197003${SUFFIX}`;

// Resource type produced by promoteLabAutoverification → enqueueCriticalResultTask.
const RESOURCE_TYPE = 'lab_autoverification';

// IDs set during beforeAll seeding.
let enabledRowId = null;   // clinical_ai_lab_autoverifications.id for enabled-module test
let disabledRowId = null;  // clinical_ai_lab_autoverifications.id for disabled-module test

// ── helpers ────────────────────────────────────────────────────────────────

async function taskExistsForResource(autoverificationId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM tasks
      WHERE tenant_id = $1::uuid
        AND related_resource_type = $2
        AND related_resource_id = $3::text
      LIMIT 1`,
    TENANT_ID,
    RESOURCE_TYPE,
    String(autoverificationId),
  );
  return rows.length > 0;
}

async function seedAutoverification() {
  // Insert a pending lab autoverification row. All NOT NULL columns are
  // provided; investigation_id and generation_id are nullable.
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO clinical_ai_lab_autoverifications
       (tenant_id, patient_uid, test_name, result_value, units,
        critical_band, decision, reviewer_decision)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'normal', 'critical', 'pending')
     RETURNING id`,
    TENANT_ID,
    PATIENT_UID,
    'Serum Potassium [LAV deep test]',
    7.1,
    'mmol/L',
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
  for (const rowId of [enabledRowId, disabledRowId]) {
    if (rowId == null) continue;
    // Remove any tasks that reference this autoverification row.
    await prisma.$executeRawUnsafe(
      `DELETE FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = $2
          AND related_resource_id = $3::text`,
      TENANT_ID,
      RESOURCE_TYPE,
      String(rowId),
    ).catch(() => {});
    // Remove SLA instances.
    await prisma.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND rule_code = 'critical_result_ack'
          AND source_table = $2
          AND source_id = $3::text`,
      TENANT_ID,
      RESOURCE_TYPE,
      String(rowId),
    ).catch(() => {});
    // Remove the autoverification row itself.
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_ai_lab_autoverifications
        WHERE id = $1::int AND tenant_id = $2::uuid`,
      rowId,
      TENANT_ID,
    ).catch(() => {});
  }
  // Remove the test patient.
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid = $1::uuid`,
    PATIENT_UID,
  ).catch(() => {});
  // Restore module to disabled (the platform default).
  await setModuleEnabled(false).catch(() => {});
}

// ── suite ───────────────────────────────────────────────────────────────────

d('Results-inbox — lab_autoverification_delta wiring (deep, real-PG)', () => {
  beforeAll(async () => {
    await cleanup();

    // Seed the test patient user.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'LAV Patient [test]', 'PATIENT', true, $3::uuid, NOW())
       ON CONFLICT (uid) DO NOTHING`,
      PATIENT_UID,
      PATIENT_PHONE,
      TENANT_ID,
    );

    // Two autoverification rows — one for each module-enabled state.
    enabledRowId = await seedAutoverification();
    disabledRowId = await seedAutoverification();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  // ── positive path ──────────────────────────────────────────────────────

  it('module ENABLED: accepting the autoverification creates a tasks row (resourceType=lab_autoverification)', async () => {
    await setModuleEnabled(true);

    const result = await decideLabAutoverification({
      tenantId: TENANT_ID,
      reviewId: enabledRowId,
      decision: 'accepted',
      note: 'Critical potassium result confirmed — needs immediate clinical review',
    });

    expect(result.reviewer_decision).toBe('accepted');

    const exists = await taskExistsForResource(enabledRowId);
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
      String(enabledRowId),
    );
    expect(rows.length).toBe(1);
    const task = rows[0];
    expect(String(task.tenant_id)).toBe(TENANT_ID);
    expect(task.related_resource_type).toBe(RESOURCE_TYPE);
    expect(String(task.related_resource_id)).toBe(String(enabledRowId));
    // The autoverification row has decision='critical', so the task priority
    // must be critical (isCritical branch in promoteLabAutoverification).
    expect(task.priority).toBe('critical');
    expect(['open', 'in_progress', 'blocked']).toContain(task.status);
  });

  // ── enable-gate (negative) path ────────────────────────────────────────

  it('module DISABLED: accepting the autoverification creates NO task', async () => {
    await setModuleEnabled(false);

    const result = await decideLabAutoverification({
      tenantId: TENANT_ID,
      reviewId: disabledRowId,
      decision: 'accepted',
      note: 'Gate test — module disabled should suppress task creation',
    });

    expect(result.reviewer_decision).toBe('accepted');

    const exists = await taskExistsForResource(disabledRowId);
    expect(exists).toBe(false);
  });
});

void jest;
