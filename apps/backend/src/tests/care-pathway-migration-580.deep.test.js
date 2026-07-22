import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const migrationSql = readFileSync(
  new URL('../migrations/580_care_pathway_execution_spine.sql', import.meta.url),
  'utf8',
).replace(/\r\n/g, '\n');
const reconciliationStart = migrationSql.indexOf('UPDATE tasks AS task');
const reconciliationEnd = migrationSql.indexOf(
  'DO $$\nBEGIN\n  IF NOT EXISTS (\n    SELECT 1 FROM pg_constraint',
  reconciliationStart,
);

if (reconciliationStart < 0 || reconciliationEnd <= reconciliationStart) {
  throw new Error('Migration 580 typed SLA reconciliation block was not found');
}

const reconciliationSql = migrationSql
  .slice(reconciliationStart, reconciliationEnd)
  .trim();

function extractExistsPreflight(message) {
  const marker = migrationSql.indexOf(message);
  const start = migrationSql.lastIndexOf('IF EXISTS (', marker);
  const end = migrationSql.lastIndexOf(') THEN', marker);
  if (marker < 0 || start < 0 || end <= start) {
    throw new Error(`Migration 580 preflight was not found: ${message}`);
  }
  return `SELECT EXISTS (${migrationSql
    .slice(start + 'IF EXISTS ('.length, end)
    .trim()}) AS blocked`;
}

const sourceBindingPreflightSql = extractExistsPreflight(
  'migration 580 blocked: task SLA metadata link source does not match its task resource',
);
const mortuaryResourcePreflightSql = extractExistsPreflight(
  'migration 580 blocked: mortuary domain-evidence task has no valid death_record resource',
);
const taskSlaMetadataPreflightMatch = migrationSql.match(
  /DO \$care_pathway_task_sla_link_preflight\$[\s\S]*?\$care_pathway_task_sla_link_preflight\$;/,
);

if (!taskSlaMetadataPreflightMatch) {
  throw new Error('Migration 580 task SLA metadata preflight block was not found');
}

const taskSlaMetadataPreflightSql = taskSlaMetadataPreflightMatch[0];
const acknowledgementLifecyclePreflightMatch = migrationSql.match(
  /DO \$care_pathway_ack_lifecycle_preflight\$[\s\S]*?\$care_pathway_ack_lifecycle_preflight\$;/,
);

if (!acknowledgementLifecyclePreflightMatch) {
  throw new Error('Migration 580 acknowledgement lifecycle preflight block was not found');
}

const acknowledgementLifecyclePreflightSql = acknowledgementLifecyclePreflightMatch[0];
const postLockAcknowledgementLifecycleMatch = migrationSql.match(
  /DO \$care_pathway_post_lock_ack_lifecycle_check\$[\s\S]*?\$care_pathway_post_lock_ack_lifecycle_check\$;/,
);

if (!postLockAcknowledgementLifecycleMatch) {
  throw new Error('Migration 580 post-lock acknowledgement lifecycle block was not found');
}

const postLockAcknowledgementLifecycleSql = postLockAcknowledgementLifecycleMatch[0];
const legacyCriticalRearmLineageFunctionMatch = migrationSql.match(
  /CREATE OR REPLACE FUNCTION care_pathway_assert_legacy_critical_rearm_lineage\([\s\S]*?\n\$\$;/,
);

if (!legacyCriticalRearmLineageFunctionMatch) {
  throw new Error('Migration 580 legacy critical-result lineage function was not found');
}

const legacyCriticalRearmLineageFunctionSql = legacyCriticalRearmLineageFunctionMatch[0]
  .replace(
    'CREATE OR REPLACE FUNCTION care_pathway_assert_legacy_critical_rearm_lineage',
    'CREATE OR REPLACE FUNCTION public.care_pathway_assert_legacy_critical_rearm_lineage',
  );

const SHADOW_TABLES_SQL = `
  CREATE TEMP TABLE tasks (
    id INTEGER PRIMARY KEY,
    tenant_id UUID NOT NULL,
    status TEXT NOT NULL,
    patient_uid UUID,
    related_resource_type TEXT,
    related_resource_id TEXT,
    due_at TIMESTAMPTZ,
    workflow_step_id INTEGER,
    workflow_sla_instance_id UUID,
    sla_completion_semantics TEXT NOT NULL DEFAULT 'none',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TEMP TABLE workflow_sla_instances (
    id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL,
    rule_code TEXT NOT NULL,
    source_table TEXT,
    source_id TEXT,
    patient_uid UUID,
    status TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    due_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    breached_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TEMP TABLE task_comments (
    id INTEGER PRIMARY KEY,
    tenant_id UUID NOT NULL,
    task_id INTEGER NOT NULL,
    author_uid UUID,
    body TEXT NOT NULL,
    body_kind TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TEMP TABLE death_records (
    id INTEGER PRIMARY KEY,
    tenant_id UUID NOT NULL
  );
  CREATE TEMP TABLE body_custody_events (
    id BIGINT PRIMARY KEY,
    tenant_id UUID NOT NULL,
    death_record_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    event_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  );
  CREATE TEMP TABLE lab_results (
    id INTEGER PRIMARY KEY,
    tenant_id UUID NOT NULL,
    patient_uid UUID NOT NULL
  );
  CREATE TEMP TABLE lab_pathologist_signoffs (
    id INTEGER PRIMARY KEY,
    tenant_id UUID NOT NULL,
    result_ids INTEGER[] NOT NULL,
    decision TEXT NOT NULL,
    signed_at TIMESTAMPTZ NOT NULL
  );
  CREATE TEMP TABLE users (
    uid UUID PRIMARY KEY,
    tenant_id UUID NOT NULL
  );
  CREATE TEMP TABLE patient_access_break_glass (
    id INTEGER PRIMARY KEY,
    tenant_id UUID NOT NULL,
    patient_uid UUID,
    actor_uid UUID,
    reason TEXT
  );
`;

async function seedMortuaryLink(client, {
  dueAt,
  status = 'completed',
  completedAt = new Date('2026-07-19T06:00:00.000Z'),
  taskStatus = 'open',
  taskCompletedAt = null,
}) {
  const tenantId = randomUUID();
  const slaId = randomUUID();
  const deathRecordId = Math.floor(Math.random() * 1_000_000) + 1;
  await client.query(
    `INSERT INTO death_records (id, tenant_id) VALUES ($1::integer, $2::uuid)`,
    [deathRecordId, tenantId],
  );
  await client.query(
    `INSERT INTO workflow_sla_instances
       (id, tenant_id, rule_code, status, due_at, completed_at, metadata)
     VALUES ($1::uuid, $2::uuid, 'mortuary_unclaimed_body', $3::text,
             $4::timestamptz, $5::timestamptz,
             jsonb_build_object(
               'completed_via', 'task_status',
               'completed_by_task', 77,
               'completed_by', 'legacy-actor',
               'completion_evidence', jsonb_build_object('kind', 'task_completion')
             ))`,
    [slaId, tenantId, status, dueAt, completedAt],
  );
  await client.query(
    `INSERT INTO tasks
       (id, tenant_id, status, related_resource_type, related_resource_id, metadata, completed_at)
     VALUES (77, $1::uuid, $2::text, 'death_record', $3::text,
             jsonb_build_object('sla_instance_id', $4::text, 'preserved', true),
             $5::timestamptz)`,
    [tenantId, taskStatus, String(deathRecordId), slaId, taskCompletedAt],
  );
  return { tenantId, slaId, deathRecordId };
}

async function seedLegacyCriticalGeneration(client, {
  tenantId,
  patientUid,
  slaId,
  resultId,
  signoffId,
  decision,
  slaStatus,
  slaCompletedAt = null,
  slaMetadata = {},
  predecessorDueAt,
  successorStatus,
  successorCompletedAt = null,
  successorMetadata = {},
}) {
  await client.query(
    `INSERT INTO lab_results (id, tenant_id, patient_uid)
     VALUES ($1::integer, $2::uuid, $3::uuid)`,
    [resultId, tenantId, patientUid],
  );
  await client.query(
    `INSERT INTO lab_pathologist_signoffs
       (id, tenant_id, result_ids, decision, signed_at)
     VALUES ($1::integer, $2::uuid, ARRAY[$3::integer], $4::text,
             '2026-07-19T09:00:00Z'::timestamptz)`,
    [signoffId, tenantId, resultId, decision],
  );
  await client.query(
    `INSERT INTO workflow_sla_instances
       (id, tenant_id, rule_code, patient_uid, source_table, source_id,
        status, completed_at, due_at, metadata)
     VALUES ($1::uuid, $2::uuid, 'critical_result_ack', $3::uuid,
             'lab_result', $4::text, $5::text, $6::timestamptz,
             '2026-07-19T11:00:00Z'::timestamptz, $7::jsonb)`,
    [
      slaId,
      tenantId,
      patientUid,
      String(resultId),
      slaStatus,
      slaCompletedAt,
      JSON.stringify(slaMetadata),
    ],
  );
  await client.query(
    `INSERT INTO tasks
       (id, tenant_id, patient_uid, status, completed_at, due_at,
        related_resource_type, related_resource_id, metadata, created_at)
     VALUES
       (1, $1::uuid, $2::uuid, 'completed',
        '2026-07-19T08:00:00Z'::timestamptz, $3::timestamptz,
        'lab_result', $4::text, jsonb_build_object('sla_instance_id', $5::text),
        '2026-07-19T07:30:00Z'::timestamptz),
       (2, $1::uuid, $2::uuid, $6::text, $7::timestamptz,
        '2026-07-19T11:00:00Z'::timestamptz,
        'lab_result', $4::text,
        jsonb_build_object('sla_instance_id', $5::text) || $8::jsonb,
        '2026-07-19T10:00:00Z'::timestamptz)`,
    [
      tenantId,
      patientUid,
      predecessorDueAt,
      String(resultId),
      slaId,
      successorStatus,
      successorCompletedAt,
      JSON.stringify(successorMetadata),
    ],
  );
}

describeIfDb('migration 580 typed SLA reconciliation (PostgreSQL)', () => {
  let client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query(SHADOW_TABLES_SQL);
    await client.query('SET LOCAL search_path = pg_temp');
  });

  afterEach(async () => {
    await client.query('ROLLBACK').catch(() => {});
  });

  afterAll(async () => {
    await client.end();
  });

  test('extracts the complete typed-link and mortuary reconciliation statements', () => {
    expect(reconciliationSql).toMatch(/^UPDATE tasks AS task/);
    expect(reconciliationSql).toContain("WHEN task.workflow_step_id IS NOT NULL THEN 'acknowledgement'");
    expect(reconciliationSql).toContain("WHEN sla.rule_code IN ('critical_result_ack', 'cold_chain_excursion_ack')");
    expect(reconciliationSql).toContain("WHEN sla.rule_code = 'mortuary_unclaimed_body'");
    expect(reconciliationSql).toContain("'sla_instance_id', task.workflow_sla_instance_id::text");
    expect(reconciliationSql).toContain("'sla_key', sla.rule_code");
    expect(migrationSql).toContain('CREATE OR REPLACE FUNCTION tasks_sync_workflow_sla_compat()');
    expect(migrationSql).toContain('CREATE TRIGGER trg_tasks_workflow_sla_compat_insert');
    expect(migrationSql).toContain('CREATE TRIGGER trg_tasks_workflow_sla_compat_update');
    expect(postLockAcknowledgementLifecycleSql).toContain(
      'task.workflow_sla_instance_id IS NOT NULL',
    );
    expect(acknowledgementLifecyclePreflightSql).toContain(
      "predecessor.sla_metadata->'reopen_history'",
    );
    expect(acknowledgementLifecyclePreflightSql).toContain('FROM task_comments');
    expect(acknowledgementLifecyclePreflightSql).toContain('receipt.author_uid IS NULL');
    expect(migrationSql).toContain('CREATE CONSTRAINT TRIGGER trg_tasks_sla_source_binding');
    expect(migrationSql).toContain(
      'CREATE CONSTRAINT TRIGGER trg_workflow_sla_instances_task_source_binding',
    );
    expect(migrationSql).toContain(
      'Each non-default tenant requires owner-approved clocks, recipients,',
    );
    expect(migrationSql).not.toContain(
      'care_pathway_provision_default_task_escalation_rules',
    );
  });

  test('reports safe aggregate counts and reconciliation guidance for invalid metadata links', async () => {
    const taskTenantId = randomUUID();
    const otherTenantId = randomUUID();
    const missingSlaId = randomUUID();
    const crossTenantSlaId = randomUUID();
    const validSlaId = randomUUID();

    await client.query(
      `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_code, source_table, source_id, status)
       VALUES
         ($1::uuid, $2::uuid, 'critical_result_ack', 'lab_result', 'cross', 'active'),
         ($3::uuid, $4::uuid, 'critical_result_ack', 'lab_result', 'valid', 'active')`,
      [crossTenantSlaId, otherTenantId, validSlaId, taskTenantId],
    );
    await client.query(
      `INSERT INTO tasks
         (id, tenant_id, status, related_resource_type, related_resource_id, metadata)
       VALUES
         (1, $1::uuid, 'open', 'lab_result', 'malformed',
          jsonb_build_object('sla_instance_id', 'not-a-uuid')),
         (2, $1::uuid, 'open', 'lab_result', 'missing',
          jsonb_build_object('sla_instance_id', $2::text)),
         (3, $1::uuid, 'open', 'lab_result', 'cross',
          jsonb_build_object('sla_instance_id', $3::text)),
         (4, $1::uuid, 'open', 'lab_result', 'valid',
          jsonb_build_object('sla_instance_id', $4::text)),
         (5, $1::uuid, 'open', 'lab_result', 'unlinked-null',
          jsonb_build_object('sla_key', 'critical_result_ack', 'sla_instance_id', NULL)),
         (6, $1::uuid, 'in_progress', 'lab_result', 'unlinked-blank',
          jsonb_build_object('sla_key', 'critical_result_ack', 'sla_instance_id', '  ')),
         (7, $1::uuid, 'overdue', 'lab_result', 'unlinked-missing',
          jsonb_build_object('sla_key', 'critical_result_ack')),
         (8, $1::uuid, 'open', 'lab_result', 'valid',
          jsonb_build_object(
            'sla_instance_id', $4::text,
            'sla_key', 'cold_chain_excursion_ack'
          ))`,
      [taskTenantId, missingSlaId, crossTenantSlaId, validSlaId],
    );

    let error;
    try {
      await client.query(taskSlaMetadataPreflightSql);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeDefined();
    expect(error.code).toBe('23514');
    expect(error.message).toContain(
      '7 task SLA metadata link(s) are invalid (malformed=1, missing=1, cross_tenant=1, rule_mismatch=1, unlinked_claims=3)',
    );
    expect(error.hint).toContain(
      'Do not detach or delete open clinical tasks.',
    );
    expect(error.message).not.toContain(missingSlaId);
    expect(error.message).not.toContain(crossTenantSlaId);
  });

  test('allows terminal SLA history and explicit policy-missing degraded tasks without a link', async () => {
    const tenantId = randomUUID();
    await client.query(
      'INSERT INTO death_records (id, tenant_id) VALUES (51, $1::uuid)',
      [tenantId],
    );
    await client.query(
      `INSERT INTO tasks
         (id, tenant_id, status, related_resource_type, related_resource_id, metadata)
       VALUES
         (1, $1::uuid, 'completed', 'lab_result', 'terminal-null',
          jsonb_build_object('sla_key', 'critical_result_ack', 'sla_instance_id', NULL)),
         (2, $1::uuid, 'cancelled', 'lab_result', 'terminal-missing',
          jsonb_build_object('sla_key', 'critical_result_ack')),
         (3, $1::uuid, 'blocked', 'lab_result', 'policy-missing',
          jsonb_build_object(
            'requested_sla_key', 'critical_result_ack',
            'sla_policy_status', 'missing'
          )),
         (4, $1::uuid, 'open', 'death_record', '51',
          jsonb_build_object(
            'sla_key', 'mortuary_unclaimed_body',
            'requested_sla_key', 'mortuary_unclaimed_body',
            'sla_policy_status', 'missing',
            'sla_instance_id', NULL
          ))`,
      [tenantId],
    );

    await expect(client.query(taskSlaMetadataPreflightSql)).resolves.toMatchObject({
      command: 'DO',
    });
  });

  test('reports acknowledgement lifecycle contradictions without trusting legacy ack metadata', async () => {
    const tenantId = randomUUID();
    const inProgressSlaId = randomUUID();
    const cancelledSlaId = randomUUID();
    const terminalSlaId = randomUUID();
    await client.query(
      `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_code, source_table, source_id, status, completed_at)
       VALUES
         ($1::uuid, $4::uuid, 'critical_result_ack', 'lab_result', 'ack-open',
          'active', NULL),
         ($2::uuid, $4::uuid, 'cold_chain_excursion_ack', 'cold_chain_excursions',
          'cancelled-open', 'breached', NULL),
         ($3::uuid, $4::uuid, 'critical_result_ack', 'lab_result', 'dead-clock',
          'completed', NOW())`,
      [inProgressSlaId, cancelledSlaId, terminalSlaId, tenantId],
    );
    await client.query(
      `INSERT INTO tasks
         (id, tenant_id, status, related_resource_type, related_resource_id, metadata)
       VALUES
         (1, $1::uuid, 'in_progress', 'lab_result', 'ack-open',
          jsonb_build_object(
            'sla_instance_id', $2::text,
            'sla_key', 'critical_result_ack',
            'acknowledged_at', '2026-07-19T08:00:00Z'
          )),
         (2, $1::uuid, 'cancelled', 'cold_chain_excursions', 'cancelled-open',
          jsonb_build_object(
            'sla_instance_id', $3::text,
            'sla_key', 'cold_chain_excursion_ack'
          )),
         (3, $1::uuid, 'open', 'lab_result', 'dead-clock',
          jsonb_build_object(
            'sla_instance_id', $4::text,
            'sla_key', 'critical_result_ack'
          ))`,
      [tenantId, inProgressSlaId, cancelledSlaId, terminalSlaId],
    );

    let error;
    try {
      await client.query(acknowledgementLifecyclePreflightSql);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeDefined();
    expect(error.code).toBe('23514');
    expect(error.message).toContain(
      '3 acknowledgement task/SLA lifecycle pair(s) are inconsistent '
      + '(acknowledged_or_completed_incomplete=1, cancelled_incomplete=1, '
      + 'actionable_terminal=1, reopen_ancestor_missing_deadline=0, '
      + 'invalid_reopen_edge=0)',
    );
    expect(error.hint).toContain(
      'comments and legacy acknowledgement metadata alone are not authorization evidence',
    );
    expect(error.message).not.toContain(inProgressSlaId);
    expect(error.message).not.toContain(cancelledSlaId);
    expect(error.message).not.toContain(terminalSlaId);
  });

  test('accepts lifecycle-consistent critical and cold-chain acknowledgement pairs', async () => {
    const tenantId = randomUUID();
    const fixtures = [
      ['open', 'active', null, 'critical_result_ack'],
      ['blocked', 'breached', null, 'cold_chain_excursion_ack'],
      ['overdue', 'escalated', null, 'critical_result_ack'],
      ['in_progress', 'completed', new Date(), 'cold_chain_excursion_ack'],
      ['completed', 'breached', new Date(), 'critical_result_ack'],
      ['cancelled', 'cancelled', new Date(), 'cold_chain_excursion_ack'],
    ];

    for (const [index, fixture] of fixtures.entries()) {
      const [taskStatus, slaStatus, completedAt, ruleCode] = fixture;
      const slaId = randomUUID();
      const sourceTable = ruleCode === 'cold_chain_excursion_ack'
        ? 'cold_chain_excursions'
        : 'lab_result';
      const sourceId = `resource-${index}`;
      await client.query(
        `INSERT INTO workflow_sla_instances
           (id, tenant_id, rule_code, source_table, source_id, status, completed_at)
         VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text,
                 $6::text, $7::timestamptz)`,
        [slaId, tenantId, ruleCode, sourceTable, sourceId, slaStatus, completedAt],
      );
      await client.query(
        `INSERT INTO tasks
           (id, tenant_id, status, related_resource_type, related_resource_id, metadata)
         VALUES ($1::integer, $2::uuid, $3::text, $4::text, $5::text,
                 jsonb_build_object('sla_instance_id', $6::text, 'sla_key', $7::text))`,
        [index + 1, tenantId, taskStatus, sourceTable, sourceId, slaId, ruleCode],
      );
    }

    await expect(client.query(acknowledgementLifecyclePreflightSql)).resolves.toMatchObject({
      command: 'DO',
    });
  });

  test('accepts a verified multi-generation critical-result reopen chain and preserves deadlines', async () => {
    const tenantId = randomUUID();
    const slaId = randomUUID();
    await client.query(
      `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_code, source_table, source_id, status, due_at, metadata)
       VALUES ($1::uuid, $2::uuid, 'critical_result_ack',
               'lab_result', 'corrected-result', 'active',
               '2026-07-19T10:00:00.333333Z'::timestamptz,
               jsonb_build_object(
                 'reopen_history', jsonb_build_array(
                   jsonb_build_object(
                     'prior_completed_by_task', 1,
                     'prior_due_at', '2026-07-19T08:00:00.111111Z'::timestamptz
                   ),
                   jsonb_build_object(
                     'prior_completed_by_task', 2,
                     'prior_due_at', '2026-07-19T09:00:00.222222Z'::timestamptz
                   )
                 )
               ))`,
      [slaId, tenantId],
    );
    await client.query(
      `INSERT INTO tasks
         (id, tenant_id, status, related_resource_type, related_resource_id,
          due_at, metadata)
       VALUES
         (1, $1::uuid, 'completed', 'lab_result', 'corrected-result',
          NULL,
          jsonb_build_object(
            'sla_instance_id', $2::text,
            'sla_key', 'critical_result_ack'
          )),
         (2, $1::uuid, 'cancelled', 'lab_result', 'corrected-result',
          NULL,
          jsonb_build_object(
            'sla_instance_id', $2::text,
            'sla_key', 'critical_result_ack',
            'reopened_from_task_id', 1
          )),
         (3, $1::uuid, 'open', 'lab_result', 'corrected-result', NULL,
          jsonb_build_object(
            'sla_instance_id', $2::text,
            'sla_key', 'critical_result_ack',
            'reopened_from_task_id', 2
          ))`,
      [tenantId, slaId],
    );

    await expect(client.query(acknowledgementLifecyclePreflightSql)).resolves.toMatchObject({
      command: 'DO',
    });
    await client.query(reconciliationSql);

    const deadlines = await client.query(
      `SELECT id, to_char(due_at, 'US') AS microseconds,
              workflow_sla_instance_id, sla_completion_semantics,
              metadata->>'sla_instance_id' AS legacy_sla_instance_id
         FROM tasks
        ORDER BY id`,
    );
    expect(deadlines.rows).toEqual([
      {
        id: 1,
        microseconds: '111111',
        workflow_sla_instance_id: slaId,
        sla_completion_semantics: 'acknowledgement',
        legacy_sla_instance_id: slaId,
      },
      {
        id: 2,
        microseconds: '222222',
        workflow_sla_instance_id: slaId,
        sla_completion_semantics: 'acknowledgement',
        legacy_sla_instance_id: slaId,
      },
      {
        id: 3,
        microseconds: '333333',
        workflow_sla_instance_id: slaId,
        sla_completion_semantics: 'acknowledgement',
        legacy_sla_instance_id: slaId,
      },
    ]);
  });

  test('blocks a terminal legacy critical-result generation with no proven predecessor edge', async () => {
    const tenantId = randomUUID();
    const patientUid = randomUUID();
    const slaId = randomUUID();
    await client.query(legacyCriticalRearmLineageFunctionSql);
    expect(legacyCriticalRearmLineageFunctionSql).not.toContain(
      'successor.workflow_sla_instance_id',
    );
    await seedLegacyCriticalGeneration(client, {
      tenantId,
      patientUid,
      slaId,
      resultId: 101,
      signoffId: 201,
      decision: 'corrected',
      slaStatus: 'completed',
      slaCompletedAt: '2026-07-19T10:30:00Z',
      slaMetadata: { completed_by_task: 2 },
      predecessorDueAt: '2026-07-19T08:30:00Z',
      successorStatus: 'completed',
      successorCompletedAt: '2026-07-19T10:30:00Z',
    });

    await expect(
      client.query(
        "SELECT public.care_pathway_assert_legacy_critical_rearm_lineage('during test')",
      ),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('unproven_generation=1'),
    });
  });

  test('blocks an ambiguous unlinked predecessor before a linked corrected-result successor', async () => {
    const tenantId = randomUUID();
    const patientUid = randomUUID();
    const slaId = randomUUID();
    await client.query(legacyCriticalRearmLineageFunctionSql);
    await client.query(
      `INSERT INTO lab_results (id, tenant_id, patient_uid)
       VALUES (104, $1::uuid, $2::uuid)`,
      [tenantId, patientUid],
    );
    await client.query(
      `INSERT INTO lab_pathologist_signoffs
         (id, tenant_id, result_ids, decision, signed_at)
       VALUES (204, $1::uuid, ARRAY[104], 'corrected',
               '2026-07-19T09:00:00Z'::timestamptz)`,
      [tenantId],
    );
    await client.query(
      `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_code, patient_uid, source_table, source_id,
          status, due_at)
       VALUES ($1::uuid, $2::uuid, 'critical_result_ack', $3::uuid,
               'lab_result', '104', 'active',
               '2026-07-19T11:00:00Z'::timestamptz)`,
      [slaId, tenantId, patientUid],
    );
    await client.query(
      `INSERT INTO tasks
         (id, tenant_id, status, patient_uid, related_resource_type,
          related_resource_id, metadata, created_at)
       VALUES
         (1, $1::uuid, 'in_progress', $2::uuid, 'lab_result', '104',
          jsonb_build_object('sla_key', 'critical_result_ack'),
          '2026-07-19T08:00:00Z'::timestamptz),
         (2, $1::uuid, 'open', $2::uuid, 'lab_result', '104',
          jsonb_build_object(
            'sla_key', 'critical_result_ack',
            'sla_instance_id', $3::text
          ),
          '2026-07-19T10:00:00Z'::timestamptz)`,
      [tenantId, patientUid, slaId],
    );

    await expect(
      client.query(
        "SELECT public.care_pathway_assert_legacy_critical_rearm_lineage('during test')",
      ),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('terminal_unlinked_predecessor=1'),
    });
  });

  test('accepts a pointer whose exact SLA history supplies a missing task deadline', async () => {
    const tenantId = randomUUID();
    const patientUid = randomUUID();
    const slaId = randomUUID();
    await client.query(legacyCriticalRearmLineageFunctionSql);
    await seedLegacyCriticalGeneration(client, {
      tenantId,
      patientUid,
      slaId,
      resultId: 102,
      signoffId: 202,
      decision: 'amended',
      slaStatus: 'active',
      slaMetadata: {
        reopen_history: [{
          prior_completed_by_task: 1,
          prior_due_at: '2026-07-19T08:30:00Z',
        }],
      },
      predecessorDueAt: null,
      successorStatus: 'open',
      successorMetadata: {
        reopened_from_task_id: 1,
        reopen_reason: 'lab_signoff_amended',
      },
    });

    await expect(
      client.query(
        "SELECT public.care_pathway_assert_legacy_critical_rearm_lineage('during test')",
      ),
    ).resolves.toMatchObject({ command: 'SELECT' });
  });

  test('blocks an active legacy generation whose completion pointer names the wrong predecessor', async () => {
    const tenantId = randomUUID();
    const patientUid = randomUUID();
    const slaId = randomUUID();
    await client.query(legacyCriticalRearmLineageFunctionSql);
    await seedLegacyCriticalGeneration(client, {
      tenantId,
      patientUid,
      slaId,
      resultId: 103,
      signoffId: 203,
      decision: 'corrected',
      slaStatus: 'active',
      slaMetadata: {
        completed_by_task: 999,
        reopen_history: [{
          prior_completed_by_task: 1,
          prior_due_at: '2026-07-19T08:30:00Z',
        }],
      },
      predecessorDueAt: '2026-07-19T08:30:00Z',
      successorStatus: 'open',
      successorMetadata: {
        reopened_from_task_id: 1,
        reopen_reason: 'lab_signoff_corrected',
      },
    });

    await expect(
      client.query(
        "SELECT public.care_pathway_assert_legacy_critical_rearm_lineage('during test')",
      ),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('stale_completed_by_task=1'),
    });
  });

  test('blocks a legacy NULL-author comment reopen whose prior deadline is missing', async () => {
    const tenantId = randomUUID();
    const slaId = randomUUID();
    await client.query(
      `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_code, source_table, source_id, status, due_at)
       VALUES ($1::uuid, $2::uuid, 'critical_result_ack',
               'lab_result', 'missing-history', 'active', NOW() + INTERVAL '1 hour')`,
      [slaId, tenantId],
    );
    await client.query(
      `INSERT INTO tasks
         (id, tenant_id, status, related_resource_type, related_resource_id,
          due_at, metadata)
       VALUES
         (1, $1::uuid, 'completed', 'lab_result', 'missing-history', NULL,
          jsonb_build_object(
            'sla_instance_id', $2::text,
            'sla_key', 'critical_result_ack'
          )),
         (2, $1::uuid, 'open', 'lab_result', 'missing-history', NULL,
          jsonb_build_object(
            'sla_instance_id', $2::text,
            'sla_key', 'critical_result_ack',
            'reopened_from_task_id', 1,
            'reopen_reason', 'corrected_result'
          ))`,
      [tenantId, slaId],
    );
    await client.query(
      `INSERT INTO task_comments
         (id, tenant_id, task_id, author_uid, body, body_kind, metadata)
       VALUES (1, $1::uuid, 1, NULL, 'system receipt', 'system_event',
               jsonb_build_object(
                 'reason', 'corrected_result',
                 'superseded_by_task_id', 2
               ))`,
      [tenantId],
    );

    let error;
    try {
      await client.query(acknowledgementLifecyclePreflightSql);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(error.code).toBe('23514');
    expect(error.message).toContain('invalid_reopen_edge=1');
    expect(error.message).not.toContain(slaId);
  });

  test('blocks a reopen receipt that disagrees with the preserved predecessor deadline', async () => {
    const tenantId = randomUUID();
    const slaId = randomUUID();
    await client.query(
      `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_code, source_table, source_id, status, due_at, metadata)
       VALUES ($1::uuid, $2::uuid, 'critical_result_ack',
               'lab_result', 'deadline-conflict', 'active',
               '2026-07-19T10:00:00.333333Z'::timestamptz,
               jsonb_build_object(
                 'reopen_history', jsonb_build_array(
                   jsonb_build_object(
                     'prior_completed_by_task', 1,
                     'prior_due_at', '2026-07-19T08:00:00.111111Z'::timestamptz
                   )
                 )
               ))`,
      [slaId, tenantId],
    );
    await client.query(
      `INSERT INTO tasks
         (id, tenant_id, status, related_resource_type, related_resource_id,
          due_at, metadata)
       VALUES
         (1, $1::uuid, 'completed', 'lab_result', 'deadline-conflict',
          '2026-07-19T08:00:00.222222Z'::timestamptz,
          jsonb_build_object(
            'sla_instance_id', $2::text,
            'sla_key', 'critical_result_ack'
          )),
         (2, $1::uuid, 'open', 'lab_result', 'deadline-conflict', NULL,
          jsonb_build_object(
            'sla_instance_id', $2::text,
            'sla_key', 'critical_result_ack',
            'reopened_from_task_id', 1
          ))`,
      [tenantId, slaId],
    );

    let error;
    try {
      await client.query(acknowledgementLifecyclePreflightSql);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(error.code).toBe('23514');
    expect(error.message).toContain('reopen_ancestor_missing_deadline=1');
    expect(error.message).not.toContain(slaId);
  });

  test('rejects a reopen pointer backed only by a forged system comment', async () => {
    const tenantId = randomUUID();
    const slaId = randomUUID();
    const commentAuthorUid = randomUUID();
    await client.query(
      `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_code, source_table, source_id, status, due_at)
       VALUES ($1::uuid, $2::uuid, 'critical_result_ack',
               'lab_result', 'comment-only', 'active', NOW() + INTERVAL '1 hour')`,
      [slaId, tenantId],
    );
    await client.query(
      `INSERT INTO tasks
         (id, tenant_id, status, related_resource_type, related_resource_id,
          due_at, metadata)
       VALUES
         (1, $1::uuid, 'completed', 'lab_result', 'comment-only',
          NOW() - INTERVAL '1 hour',
          jsonb_build_object(
            'sla_instance_id', $2::text,
            'sla_key', 'critical_result_ack'
          )),
         (2, $1::uuid, 'open', 'lab_result', 'comment-only', NULL,
          jsonb_build_object(
            'sla_instance_id', $2::text,
            'sla_key', 'critical_result_ack',
            'reopened_from_task_id', 1,
            'reopen_reason', 'corrected_result'
          ))`,
      [tenantId, slaId],
    );
    await client.query(
      `INSERT INTO task_comments
         (id, tenant_id, task_id, author_uid, body, body_kind, metadata)
       VALUES (1, $1::uuid, 1, $2::uuid, 'forged receipt', 'system_event',
               jsonb_build_object(
                 'reason', 'corrected_result',
                 'superseded_by_task_id', 2
               ))`,
      [tenantId, commentAuthorUid],
    );

    let error;
    try {
      await client.query(acknowledgementLifecyclePreflightSql);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(error.code).toBe('23514');
    expect(error.message).toContain('acknowledged_or_completed_incomplete=1');
    expect(error.message).toContain('reopen_ancestor_missing_deadline=0');
  });

  test('blocks a NULL-author reopen comment without an authenticated SLA history receipt', async () => {
    const tenantId = randomUUID();
    const slaId = randomUUID();
    await client.query(
      `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_code, source_table, source_id, status, due_at)
       VALUES ($1::uuid, $2::uuid, 'critical_result_ack',
               'lab_result', 'mixed-version-comment', 'active',
               '2026-07-19T10:00:00.333333Z'::timestamptz)`,
      [slaId, tenantId],
    );
    await client.query(
      `INSERT INTO tasks
         (id, tenant_id, status, related_resource_type, related_resource_id,
          due_at, metadata, created_at)
       VALUES
         (1, $1::uuid, 'completed', 'lab_result', 'mixed-version-comment',
          '2026-07-19T08:00:00.111111Z'::timestamptz,
          jsonb_build_object(
            'sla_instance_id', $2::text,
            'sla_key', 'critical_result_ack'
          ), '2026-07-19T08:00:00Z'::timestamptz),
         (2, $1::uuid, 'open', 'lab_result', 'mixed-version-comment', NULL,
          jsonb_build_object(
            'sla_instance_id', $2::text,
            'sla_key', 'critical_result_ack',
            'reopened_from_task_id', 1,
            'reopen_reason', 'corrected_result'
          ), '2026-07-19T09:00:00Z'::timestamptz)`,
      [tenantId, slaId],
    );
    await client.query(
      `INSERT INTO task_comments
         (id, tenant_id, task_id, author_uid, body, body_kind, metadata, created_at)
       VALUES (1, $1::uuid, 1, NULL, 'system receipt', 'system_event',
               jsonb_build_object(
                 'reason', 'corrected_result',
                 'superseded_by_task_id', 2
               ), '2026-07-19T09:00:00.000001Z'::timestamptz)`,
      [tenantId],
    );

    await expect(
      client.query(acknowledgementLifecyclePreflightSql),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('invalid_reopen_edge=1'),
      hint: expect.stringContaining('comments and legacy acknowledgement metadata alone'),
    });
  });

  test('post-lock lifecycle check catches a contradiction inserted after opening preflight', async () => {
    const tenantId = randomUUID();
    const slaId = randomUUID();

    await expect(client.query(acknowledgementLifecyclePreflightSql)).resolves.toMatchObject({
      command: 'DO',
    });
    await client.query(
      `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_code, source_table, source_id, status, due_at)
       VALUES ($1::uuid, $2::uuid, 'critical_result_ack',
               'lab_result', 'raced-task', 'active', NOW() + INTERVAL '1 hour')`,
      [slaId, tenantId],
    );
    await client.query(
      `INSERT INTO tasks
         (id, tenant_id, status, related_resource_type, related_resource_id,
          due_at, workflow_sla_instance_id, sla_completion_semantics, metadata)
       VALUES (1, $1::uuid, 'completed', 'lab_result', 'raced-task',
               NOW() + INTERVAL '1 hour', $2::uuid, 'acknowledgement',
               jsonb_build_object(
                 'sla_instance_id', $2::text,
                 'sla_key', 'critical_result_ack'
               ))`,
      [tenantId, slaId],
    );

    let error;
    try {
      await client.query(postLockAcknowledgementLifecycleSql);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    expect(error.code).toBe('23514');
    expect(error.message).toContain('migration 580 blocked after task-table lock');
    expect(error.message).toContain('acknowledged_or_completed_incomplete=1');
  });

  test('accepts canonical metadata links resolved inside the task tenant', async () => {
    const tenantId = randomUUID();
    const slaId = randomUUID();
    await client.query(
      `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_code, source_table, source_id, status)
       VALUES ($1::uuid, $2::uuid, 'critical_result_ack', 'lab_result', 'result-1', 'active')`,
      [slaId, tenantId],
    );
    await client.query(
      `INSERT INTO tasks
         (id, tenant_id, status, related_resource_type, related_resource_id, metadata)
       VALUES (1, $1::uuid, 'open', 'lab_result', 'result-1',
               jsonb_build_object('sla_instance_id', UPPER($2::text)))`,
      [tenantId, slaId],
    );

    await expect(client.query(taskSlaMetadataPreflightSql)).resolves.toMatchObject({
      command: 'DO',
    });
  });

  test.each([
    [
      'pathway workflow step',
      'pathway_custom',
      'wrong_source',
      '41',
      'care_pathway_instance',
      'instance-41',
      41,
    ],
    [
      'critical result',
      'critical_result_ack',
      'lab_results',
      'result-b',
      'lab_results',
      'result-a',
      null,
    ],
    [
      'cold-chain excursion',
      'cold_chain_excursion_ack',
      'cold_chain_excursions',
      'excursion-b',
      'cold_chain_excursions',
      'excursion-a',
      null,
    ],
    [
      'mortuary death record',
      'mortuary_unclaimed_body',
      'death_records',
      '52',
      'death_record',
      '51',
      null,
    ],
  ])('preflight rejects a mismatched %s metadata link', async (
    _label,
    ruleCode,
    sourceTable,
    sourceId,
    resourceType,
    resourceId,
    workflowStepId,
  ) => {
    const tenantId = randomUUID();
    const slaId = randomUUID();
    await client.query(
      `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_code, source_table, source_id, status)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::text, 'active')`,
      [slaId, tenantId, ruleCode, sourceTable, sourceId],
    );
    await client.query(
      `INSERT INTO tasks
         (id, tenant_id, status, related_resource_type, related_resource_id,
          workflow_step_id, metadata)
       VALUES (88, $1::uuid, 'open', $2::text, $3::text, $4::integer,
               jsonb_build_object('sla_instance_id', $5::text))`,
      [tenantId, resourceType, resourceId, workflowStepId, slaId],
    );

    const result = await client.query(sourceBindingPreflightSql);
    expect(result.rows[0].blocked).toBe(true);
  });

  test('preflight rejects a mortuary mapping without a real same-tenant death record', async () => {
    const tenantId = randomUUID();
    const slaId = randomUUID();
    await client.query(
      `INSERT INTO workflow_sla_instances
         (id, tenant_id, rule_code, source_table, source_id, status)
       VALUES ($1::uuid, $2::uuid, 'mortuary_unclaimed_body', 'death_records', '51', 'active')`,
      [slaId, tenantId],
    );
    await client.query(
      `INSERT INTO tasks
         (id, tenant_id, status, related_resource_type, related_resource_id, metadata)
       VALUES (88, $1::uuid, 'open', 'death_record', '51',
               jsonb_build_object('sla_instance_id', $2::text))`,
      [tenantId, slaId],
    );

    const result = await client.query(mortuaryResourcePreflightSql);
    expect(result.rows[0].blocked).toBe(true);
  });

  test('re-arms an unsupported task-completed mortuary SLA and preserves an audit receipt', async () => {
    const dueAt = new Date(Date.now() - 60 * 60 * 1000);
    const fixture = await seedMortuaryLink(client, { dueAt });

    await client.query(reconciliationSql);

    const task = await client.query('SELECT * FROM tasks WHERE id = 77');
    expect(task.rows[0]).toMatchObject({
      workflow_sla_instance_id: fixture.slaId,
      sla_completion_semantics: 'domain_evidence',
      status: 'open',
    });
    expect(task.rows[0].due_at.toISOString()).toBe(dueAt.toISOString());
    expect(task.rows[0].metadata).toEqual({
      preserved: true,
      sla_instance_id: fixture.slaId,
      sla_key: 'mortuary_unclaimed_body',
    });

    const sla = await client.query(
      'SELECT * FROM workflow_sla_instances WHERE id = $1::uuid',
      [fixture.slaId],
    );
    expect(sla.rows[0].status).toBe('breached');
    expect(sla.rows[0].completed_at).toBeNull();
    expect(sla.rows[0].breached_at.toISOString()).toBe(dueAt.toISOString());
    expect(sla.rows[0].metadata.completed_via).toBeUndefined();
    expect(sla.rows[0].metadata.completion_evidence).toBeUndefined();
    expect(sla.rows[0].metadata.care_pathway_migration_580_reconciliation).toMatchObject({
      previous_completed_via: 'task_status',
      previous_completed_by_task: 77,
      previous_completed_by: 'legacy-actor',
      previous_completion_evidence: { kind: 'task_completion' },
    });
  });

  test('uses event creation for SLA timing while retaining event occurrence as evidence time', async () => {
    const dueAt = new Date('2026-07-19T08:00:00.000Z');
    const eventAt = new Date('2026-07-19T07:50:00.000Z');
    const createdAt = new Date('2026-07-19T08:10:00.000Z');
    const fixture = await seedMortuaryLink(client, { dueAt });
    const eventId = Math.floor(Math.random() * 1_000_000) + 1;
    await client.query(
      `INSERT INTO body_custody_events
         (id, tenant_id, death_record_id, event_type, event_at, created_at)
       VALUES ($1::bigint, $2::uuid, $3::integer, 'release', $4::timestamptz, $5::timestamptz)`,
      [eventId, fixture.tenantId, fixture.deathRecordId, eventAt, createdAt],
    );

    await client.query(reconciliationSql);

    const sla = await client.query(
      'SELECT * FROM workflow_sla_instances WHERE id = $1::uuid',
      [fixture.slaId],
    );
    expect(sla.rows[0].status).toBe('breached');
    expect(sla.rows[0].completed_at.toISOString()).toBe(createdAt.toISOString());
    expect(sla.rows[0].breached_at.toISOString()).toBe(dueAt.toISOString());
    expect(sla.rows[0].metadata.completed_via).toBe('domain_evidence');
    expect(sla.rows[0].metadata.completion_evidence).toMatchObject({
      kind: 'mortuary_body_release',
      resource_type: 'body_custody_event',
      resource_id: String(eventId),
    });
    expect(new Date(
      sla.rows[0].metadata.completion_evidence.occurred_at,
    ).toISOString()).toBe(eventAt.toISOString());

    const task = await client.query('SELECT * FROM tasks WHERE id = 77');
    expect(task.rows[0].status).toBe('completed');
    expect(task.rows[0].completed_at.toISOString()).toBe(createdAt.toISOString());
    expect(task.rows[0].metadata.care_pathway_migration_580_reconciliation).toMatchObject({
      reason: 'mortuary_release_evidence',
      previous_status: 'open',
      previous_completed_at: null,
      release_event_id: String(eventId),
    });
    expect(new Date(
      task.rows[0].metadata.care_pathway_migration_580_reconciliation.release_event_at,
    ).toISOString()).toBe(eventAt.toISOString());
    expect(new Date(
      task.rows[0].metadata.care_pathway_migration_580_reconciliation.release_recorded_at,
    ).toISOString()).toBe(createdAt.toISOString());
  });

  test('preserves escalation state for an unresolved past-due mortuary SLA', async () => {
    const dueAt = new Date(Date.now() - 60 * 60 * 1000);
    const fixture = await seedMortuaryLink(client, {
      dueAt,
      status: 'escalated',
      completedAt: null,
    });

    await client.query(reconciliationSql);

    const sla = await client.query(
      'SELECT * FROM workflow_sla_instances WHERE id = $1::uuid',
      [fixture.slaId],
    );
    expect(sla.rows[0].status).toBe('escalated');
    expect(sla.rows[0].completed_at).toBeNull();
    expect(sla.rows[0].breached_at.toISOString()).toBe(dueAt.toISOString());
  });

  test('records release completion time without downgrading an escalated mortuary SLA', async () => {
    const dueAt = new Date('2026-07-19T08:00:00.000Z');
    const createdAt = new Date('2026-07-19T08:10:00.000Z');
    const fixture = await seedMortuaryLink(client, {
      dueAt,
      status: 'escalated',
      completedAt: null,
    });
    await client.query(
      `INSERT INTO body_custody_events
         (id, tenant_id, death_record_id, event_type, event_at, created_at)
       VALUES ($1::bigint, $2::uuid, $3::integer, 'release',
               '2026-07-19T07:50:00.000Z'::timestamptz, $4::timestamptz)`,
      [Math.floor(Math.random() * 1_000_000) + 1, fixture.tenantId, fixture.deathRecordId, createdAt],
    );

    await client.query(reconciliationSql);

    const sla = await client.query(
      'SELECT * FROM workflow_sla_instances WHERE id = $1::uuid',
      [fixture.slaId],
    );
    expect(sla.rows[0].status).toBe('escalated');
    expect(sla.rows[0].completed_at.toISOString()).toBe(createdAt.toISOString());
    expect(sla.rows[0].breached_at.toISOString()).toBe(dueAt.toISOString());
  });

  test.each([
    ['completed', new Date('2026-07-19T07:55:00.000Z')],
    ['cancelled', null],
  ])('does not rewrite a terminal %s mortuary task', async (taskStatus, taskCompletedAt) => {
    const dueAt = new Date('2026-07-19T08:00:00.000Z');
    const fixture = await seedMortuaryLink(client, {
      dueAt,
      taskStatus,
      taskCompletedAt,
    });
    await client.query(
      `INSERT INTO body_custody_events
         (id, tenant_id, death_record_id, event_type, event_at, created_at)
       VALUES ($1::bigint, $2::uuid, $3::integer, 'release',
               '2026-07-19T07:50:00.000Z'::timestamptz,
               '2026-07-19T08:10:00.000Z'::timestamptz)`,
      [Math.floor(Math.random() * 1_000_000) + 1, fixture.tenantId, fixture.deathRecordId],
    );

    await client.query(reconciliationSql);

    const task = await client.query('SELECT * FROM tasks WHERE id = 77');
    expect(task.rows[0].status).toBe(taskStatus);
    expect(task.rows[0].completed_at?.toISOString() || null).toBe(
      taskCompletedAt?.toISOString() || null,
    );
    expect(task.rows[0].metadata.care_pathway_migration_580_reconciliation).toBeUndefined();
  });
});
