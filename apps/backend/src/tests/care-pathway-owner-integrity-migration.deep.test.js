import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Client } from 'pg';

import { getClinicalAccountabilityRoleCodes } from '../config/rolePolicyGraph.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const migrationSql = readFileSync(
  new URL('../migrations/585_care_pathway_exclusive_owner_integrity.sql', import.meta.url),
  'utf8',
);

const OWNER_TRIGGER_NAMES = [
  'trg_tasks_exclusive_live_owner',
  'trg_workflow_sla_exclusive_live_owner',
  'trg_workflow_steps_exclusive_live_owner_update',
  'trg_workflow_steps_exclusive_live_owner_delete',
  'trg_care_pathway_instances_exclusive_live_owner',
  'trg_users_exclusive_live_owner_delete',
  'trg_users_exclusive_live_owner_viability',
];

function token() {
  return randomUUID().replaceAll('-', '');
}

async function seedTenant(client) {
  const tenantId = randomUUID();
  await client.query(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2::text, 'Owner integrity test tenant')`,
    [tenantId, `owner-${token()}`],
  );
  return tenantId;
}

async function seedUser(client, tenantId, role = 'DOCTOR', overrides = {}) {
  const uid = overrides.uid || randomUUID();
  await client.query(
    `INSERT INTO users
       (uid, tenant_id, name, role, is_active, status, is_deleted, deleted_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::text, $4::text, $5::boolean,
             $6::text, $7::boolean, $8::timestamptz, NOW())`,
    [
      uid,
      tenantId,
      `Owner ${role} ${token()}`,
      role,
      overrides.isActive ?? true,
      overrides.status || 'active',
      overrides.isDeleted ?? false,
      overrides.deletedAt || null,
    ],
  );
  return uid;
}

async function seedDeathRecord(client, tenantId, patientUid) {
  const result = await client.query(
    `INSERT INTO death_records
       (tenant_id, patient_uid, date_of_death, time_of_death, cause_part_1a)
     VALUES ($1::uuid, $2::uuid, CURRENT_DATE, LOCALTIME, 'Owner integrity fixture')
     RETURNING id`,
    [tenantId, patientUid],
  );
  return result.rows[0].id;
}

async function seedPathway(client, {
  tenantId,
  ownerUid = null,
  accountableRole = 'DOCTOR',
  stepRole = null,
}) {
  const patientUid = await seedUser(client, tenantId, 'PATIENT');
  const pathwayKey = `owner_pathway_${token()}`;
  const definition = await client.query(
    `INSERT INTO workflow_definitions
       (tenant_id, workflow_key, version, display_name, steps, triggers, defaults)
     VALUES ($1::uuid, $2::text, 1, 'Owner integrity pathway',
             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
     RETURNING id`,
    [tenantId, pathwayKey],
  );
  const checksum = 'a'.repeat(64);
  const governanceOwnerUid = await seedUser(client, tenantId, 'DOCTOR');
  const approverUid = await seedUser(client, tenantId, 'ADMIN');
  const decidedAt = new Date('2026-07-19T08:00:00.000Z');
  const approval = await client.query(
    `INSERT INTO approvals
       (tenant_id, approval_kind, subject_resource_type, subject_resource_id,
        required_approvers, status, approved_by, decided_by, decided_at, metadata)
     VALUES ($1::uuid, 'care_pathway_definition_governance',
             'care_pathway_definition', $2::text, 1, 'approved',
             $3::jsonb, $4::uuid, $5::timestamptz,
             jsonb_build_object(
               'care_pathway_definition_governance',
               jsonb_build_object('definition_checksum', $6::text)
             ))
     RETURNING id`,
    [
      tenantId,
      String(definition.rows[0].id),
      JSON.stringify([{ uid: approverUid, at: decidedAt.toISOString() }]),
      approverUid,
      decidedAt,
      checksum,
    ],
  );
  const governance = await client.query(
    `INSERT INTO care_pathway_definition_governance
       (tenant_id, workflow_definition_id, clinical_owner_uid,
        operational_owner_uid, governance_status, approval_id,
        approved_by, approved_at, patient_visibility_policy_ref,
        definition_checksum)
     VALUES ($1::uuid, $2::integer, $3::uuid, $3::uuid,
             'approved', $4::integer, $5::uuid,
             '2026-07-19T08:01:00.000Z'::timestamptz,
             'staff_after_signoff', $6::text)
     RETURNING id`,
    [
      tenantId,
      definition.rows[0].id,
      governanceOwnerUid,
      approval.rows[0].id,
      approverUid,
      checksum,
    ],
  );
  const governanceId = governance.rows[0].id;
  await client.query(
    `UPDATE workflow_definitions SET is_active = TRUE, updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::integer`,
    [tenantId, definition.rows[0].id],
  );
  const run = await client.query(
    `INSERT INTO workflow_runs
       (tenant_id, workflow_definition_id, workflow_key, workflow_version,
        trigger_kind, pathway_governance_id, pathway_definition_checksum)
     VALUES ($1::uuid, $2::integer, $3::text, 1, 'manual', $4::uuid, $5::char(64))
     RETURNING id`,
    [tenantId, definition.rows[0].id, pathwayKey, governanceId, checksum],
  );
  const step = await client.query(
    `INSERT INTO workflow_steps
       (tenant_id, workflow_run_id, step_key, display_name, step_kind,
        ordering, assigned_role)
     VALUES ($1::uuid, $2::integer, 'review', 'Review', 'task', 1, $3::text)
     RETURNING id`,
    [tenantId, run.rows[0].id, stepRole],
  );
  const instance = await client.query(
    `INSERT INTO care_pathway_instances
       (tenant_id, workflow_run_id, patient_uid, pathway_key, pathway_version,
        workflow_definition_id, definition_governance_id, definition_checksum,
        source_episode_type, source_episode_id, owning_clinician_uid,
        accountable_role, idempotency_key)
     VALUES ($1::uuid, $2::integer, $3::uuid, $4::text, 1,
             $5::integer, $6::uuid, $7::char(64),
             'owner_integrity_test', $8::text, $9::uuid, $10::text, $11::text)
     RETURNING id`,
    [
      tenantId,
      run.rows[0].id,
      patientUid,
      pathwayKey,
      definition.rows[0].id,
      governanceId,
      checksum,
      `episode-${token()}`,
      ownerUid,
      accountableRole,
      `start-${token()}`,
    ],
  );
  return {
    tenantId,
    patientUid,
    ownerUid,
    runId: run.rows[0].id,
    stepId: step.rows[0].id,
    instanceId: instance.rows[0].id,
  };
}

async function insertPathwayTask(client, fixture, {
  ownerUid = null,
  ownerRole = null,
  slaId = null,
  dueAt = null,
  status = 'open',
} = {}) {
  const result = await client.query(
    `INSERT INTO tasks
       (tenant_id, workflow_run_id, workflow_step_id, task_kind, title,
        patient_uid, related_resource_type, related_resource_id, status,
        assigned_to_uid, assigned_to_role, workflow_sla_instance_id,
        sla_completion_semantics, due_at)
     VALUES ($1::uuid, $2::integer, $3::integer, 'review',
             'Pathway owner integrity task', $4::uuid,
             'care_pathway_instance', $5::text, $6::text,
             $7::uuid, $8::text, $9::uuid,
             CASE WHEN $9::uuid IS NULL THEN 'none' ELSE 'acknowledgement' END,
             $10::timestamptz)
     RETURNING id, metadata`,
    [
      fixture.tenantId,
      fixture.runId,
      fixture.stepId,
      fixture.patientUid,
      fixture.instanceId,
      status,
      ownerUid,
      ownerRole,
      slaId,
      dueAt,
    ],
  );
  return result.rows[0];
}

async function insertPathwaySla(client, fixture, {
  ownerUid = null,
  ownerRoles = [],
  ruleCode = 'pathway_owner_integrity_review',
} = {}) {
  const result = await client.query(
    `INSERT INTO workflow_sla_instances
       (tenant_id, rule_code, patient_uid, source_table, source_id,
        status, due_at, assigned_user_uid, assigned_role_codes, metadata)
     VALUES ($1::uuid, $2::text, $3::uuid, 'workflow_steps', $4::text,
              'active', DATE_TRUNC('milliseconds', NOW()) + INTERVAL '1 hour',
              $5::uuid, $6::text[],
             jsonb_build_object(
               'task_materialization_contract', 'application_atomic_v1',
               'care_pathway_instance_id', $7::text
             ))
     RETURNING id, due_at`,
    [
      fixture.tenantId,
      ruleCode,
      fixture.patientUid,
      String(fixture.stepId),
      ownerUid,
      ownerRoles,
      fixture.instanceId,
    ],
  );
  return result.rows[0];
}

async function flushConstraints(client, names) {
  await client.query(`SET CONSTRAINTS ${names.join(', ')} IMMEDIATE`);
  await client.query(`SET CONSTRAINTS ${names.join(', ')} DEFERRED`);
}

async function expectDeferredFailure(client, {
  statement,
  params = [],
  constraint,
  code = '23514',
  message,
}) {
  await client.query('SAVEPOINT expected_owner_failure');
  await client.query(statement, params);
  let failure;
  try {
    await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`);
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_owner_failure');
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  expect(failure).toMatchObject({ code });
  if (message) expect(failure.message).toContain(message);
}

async function expectStatementFailure(client, statement, params, code, message) {
  await client.query('SAVEPOINT expected_statement_failure');
  let failure;
  try {
    await client.query(statement, params);
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_statement_failure');
  expect(failure).toMatchObject({ code });
  if (message) expect(failure.message).toContain(message);
}

describe('migration 585 static owner-integrity contract', () => {
  test('uses bounded locks and installs scoped enforcement without rewriting owners', () => {
    expect(migrationSql).toContain("SET LOCAL lock_timeout = '10s'");
    expect(migrationSql).toContain("SET LOCAL statement_timeout = '60s'");
    expect(migrationSql).toMatch(/LOCK TABLE users,[\s\S]*workflow_steps,[\s\S]*tasks/);
    expect(migrationSql).toContain('public.patient_access_audit_log');
    expect(migrationSql).toContain('patient_access_audit_log_access_source_check');
    expect(migrationSql).toContain('care_pathway_access_source_constraint_probe_legacy');
    expect(migrationSql).toContain('normalized_legacy_expression');
    expect(migrationSql).toContain("'::(character varying|text)(\\[\\])?'");
    expect(migrationSql).toContain("'care_pathway_owner'");
    expect(migrationSql).toContain('patient access audit relation ownership or kind is noncanonical');
    expect(migrationSql).toContain("'critical_result_ack'");
    expect(migrationSql).toContain("'cold_chain_excursion_ack'");
    expect(migrationSql).toContain("'mortuary_unclaimed_body'");
    expect(migrationSql).not.toMatch(
      /ALTER TABLE tasks\s+ADD CONSTRAINT[^;]*(assigned_to_uid|assigned_to_role)/i,
    );
    expect(migrationSql).not.toMatch(
      /UPDATE\s+tasks\s+SET\s+(assigned_to_uid|assigned_to_role)/i,
    );
  });
});

describeIfDb('migration 585 PostgreSQL owner-integrity conformance', () => {
  let client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query("SET LOCAL app.current_tenant_id = 'bypass'");
    await client.query('SET CONSTRAINTS ALL DEFERRED');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  test('keeps the database named-clinician roles in parity with role policy', async () => {
    const result = await client.query(
      'SELECT care_pathway_clinical_accountability_roles() AS roles',
    );
    expect([...result.rows[0].roles].sort()).toEqual(
      [...getClinicalAccountabilityRoleCodes()].sort(),
    );
  });

  test('commits a named RADIOLOGIST pathway task and SLA through legacy deferred checks', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId, 'RADIOLOGIST');
    const fixture = await seedPathway(client, { tenantId, ownerUid });
    const sla = await insertPathwaySla(client, fixture, { ownerUid });
    await insertPathwayTask(client, fixture, {
      ownerUid,
      slaId: sla.id,
      dueAt: sla.due_at,
    });

    await expect(flushConstraints(client, [
      'trg_care_pathway_instances_exclusive_live_owner',
      'trg_tasks_exclusive_live_owner',
      'trg_workflow_sla_exclusive_live_owner',
      'trg_tasks_sla_completion_receipt',
      'trg_workflow_sla_completion_receipt',
    ])).resolves.toBeUndefined();
  });

  test('installs all owner dependencies as deferred constraints and prevents delete nulling', async () => {
    const triggers = await client.query(
      `SELECT conname, condeferrable, condeferred
         FROM pg_constraint
        WHERE contype = 't'
          AND conname = ANY($1::text[])
        ORDER BY conname`,
      [OWNER_TRIGGER_NAMES],
    );
    expect(triggers.rows.map((row) => row.conname)).toEqual(
      [...OWNER_TRIGGER_NAMES].sort(),
    );
    expect(triggers.rows.every((row) => row.condeferrable && row.condeferred)).toBe(true);

    const ownerForeignKey = await client.query(
      `SELECT confdeltype, condeferrable, condeferred, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'care_pathway_instances'::regclass
          AND conname = 'fk_care_pathway_instances_owner_tenant'`,
    );
    expect(ownerForeignKey.rows[0]).toMatchObject({
      confdeltype: 'a',
      condeferrable: true,
      condeferred: true,
    });
    expect(ownerForeignKey.rows[0].definition).toContain('FOREIGN KEY');
  });

  test('adds the owner-aware audit source without dropping existing source values', async () => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const actorUid = await seedUser(client, tenantId, 'DOCTOR');
    const allowedSources = [
      'role',
      'care_team',
      'clinical_authorship',
      'appointment',
      'admission',
      'guardian',
      'break_glass',
      'system',
      'unknown',
      'care_pathway_owner',
    ];
    const inserted = await client.query(
      `INSERT INTO patient_access_audit_log
         (tenant_id, patient_uid, actor_uid, actor_role,
          access_decision, access_source)
       SELECT $1::uuid, $2::uuid, $3::uuid, 'DOCTOR', 'allow', source_code
         FROM UNNEST($4::text[]) AS source_code
       RETURNING access_source`,
      [tenantId, patientUid, actorUid, allowedSources],
    );
    expect(inserted.rows.map((row) => row.access_source).sort()).toEqual(
      [...allowedSources].sort(),
    );

    await expectStatementFailure(
      client,
      `INSERT INTO patient_access_audit_log
         (tenant_id, patient_uid, actor_uid, actor_role,
          access_decision, access_source)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'DOCTOR', 'allow',
               'care_pathway_owner ')`,
      [tenantId, patientUid, actorUid],
      '23514',
      'patient_access_audit_log_access_source_check',
    );
  });

  test('preserves generic unassigned and dual-assigned tasks outside the guarded scope', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId);
    await client.query(
      `INSERT INTO tasks (tenant_id, task_kind, title)
       VALUES ($1::uuid, 'general', 'Generic unassigned')`,
      [tenantId],
    );
    await client.query(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, assigned_to_uid, assigned_to_role)
       VALUES ($1::uuid, 'general', 'Historical generic dual route',
               $2::uuid, 'DUTY_DOCTOR')`,
      [tenantId, ownerUid],
    );

    await expect(
      flushConstraints(client, ['trg_tasks_exclusive_live_owner']),
    ).resolves.toBeUndefined();
  });

  test('preserves a valid terminal dual-assigned typed receipt', async () => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const actorUid = await seedUser(client, tenantId, 'DOCTOR');
    const taskSequence = await client.query(
      "SELECT nextval(pg_get_serial_sequence('tasks', 'id'))::integer AS id",
    );
    const taskId = taskSequence.rows[0].id;
    const resourceId = `terminal-${token()}`;
    const sla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id,
          status, due_at, completed_at, assigned_role_codes, metadata)
       VALUES ($1::uuid, 'critical_result_ack', $2::uuid,
               'lab_results', $3::text, 'completed',
               NOW() + INTERVAL '1 hour', NOW(), ARRAY[]::text[],
               jsonb_build_object(
                 'task_materialization_contract', 'application_atomic_v1',
                 'completed_via', 'task_completion',
                 'completed_by_task', $4::integer,
                 'completed_by', $5::text
               ))
       RETURNING id, due_at, completed_at`,
      [tenantId, patientUid, resourceId, taskId, actorUid],
    );
    await client.query(
      `INSERT INTO tasks
         (id, tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id, status,
          assigned_to_uid, assigned_to_role, due_at, completed_at,
          workflow_sla_instance_id, sla_completion_semantics, metadata)
       SELECT $1::integer, $2::uuid, 'review', 'Terminal typed receipt', $3::uuid,
              'lab_results', $4::text, 'completed',
              $5::uuid, 'DUTY_DOCTOR', sla.due_at, sla.completed_at,
              sla.id, 'acknowledgement',
              jsonb_build_object(
                'sla_instance_id', sla.id::text,
                'sla_key', 'critical_result_ack'
              )
         FROM workflow_sla_instances AS sla
        WHERE sla.tenant_id = $2::uuid AND sla.id = $6::uuid`,
      [
        taskId,
        tenantId,
        patientUid,
        resourceId,
        actorUid,
        sla.rows[0].id,
      ],
    );
    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
      command: 'SET',
    });
  });

  test('enforces a named owner on a no-SLA pathway task', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId);
    const fixture = await seedPathway(client, { tenantId, ownerUid });
    const task = await insertPathwayTask(client, fixture, { ownerUid });
    await flushConstraints(client, [
      'trg_care_pathway_instances_exclusive_live_owner',
      'trg_tasks_exclusive_live_owner',
    ]);

    await expectDeferredFailure(client, {
      statement: `UPDATE tasks SET assigned_to_role = 'DUTY_DOCTOR'
                   WHERE tenant_id = $1::uuid AND id = $2::integer`,
      params: [tenantId, task.id],
      constraint: 'trg_tasks_exclusive_live_owner',
      message: 'exactly one live route-capable owner',
    });
    await expectDeferredFailure(client, {
      statement: `UPDATE tasks
                     SET assigned_to_uid = NULL, assigned_to_role = 'DOCTOR'
                   WHERE tenant_id = $1::uuid AND id = $2::integer`,
      params: [tenantId, task.id],
      constraint: 'trg_tasks_exclusive_live_owner',
      message: 'follow its named pathway owner',
    });
  });

  test('binds role queues to the step override and revalidates raw step changes', async () => {
    const tenantId = await seedTenant(client);
    const fixture = await seedPathway(client, {
      tenantId,
      accountableRole: 'DOCTOR',
      stepRole: 'DUTY_DOCTOR',
    });
    const task = await insertPathwayTask(client, fixture, { ownerRole: 'DUTY_DOCTOR' });
    await flushConstraints(client, [
      'trg_care_pathway_instances_exclusive_live_owner',
      'trg_tasks_exclusive_live_owner',
    ]);

    await expectDeferredFailure(client, {
      statement: `UPDATE tasks SET assigned_to_role = 'DOCTOR'
                   WHERE tenant_id = $1::uuid AND id = $2::integer`,
      params: [tenantId, task.id],
      constraint: 'trg_tasks_exclusive_live_owner',
      message: 'role-owned pathway instance',
    });
    await expectDeferredFailure(client, {
      statement: `UPDATE workflow_steps SET assigned_role = 'DOCTOR'
                   WHERE tenant_id = $1::uuid AND id = $2::integer`,
      params: [tenantId, fixture.stepId],
      constraint: 'trg_workflow_steps_exclusive_live_owner_update',
      message: 'role-owned pathway instance',
    });
    await expectDeferredFailure(client, {
      statement: `DELETE FROM workflow_steps
                    WHERE tenant_id = $1::uuid AND id = $2::integer`,
      params: [tenantId, fixture.stepId],
      constraint: 'trg_workflow_steps_exclusive_live_owner_delete',
      message: 'role-owned pathway instance',
    });

    await client.query(
      `UPDATE workflow_steps SET assigned_role = NULL
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, fixture.stepId],
    );
    await client.query(
      `UPDATE tasks SET assigned_to_role = 'DOCTOR'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, task.id],
    );
    await expect(flushConstraints(client, [
      'trg_workflow_steps_exclusive_live_owner_update',
      'trg_tasks_exclusive_live_owner',
    ])).resolves.toBeUndefined();
  });

  test('rejects non-clinical, inactive, deleted, and cross-tenant named owners', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId);
    const adminUid = await seedUser(client, tenantId, 'ADMIN');
    const fixture = await seedPathway(client, { tenantId, ownerUid });
    const task = await insertPathwayTask(client, fixture, { ownerUid });
    await flushConstraints(client, [
      'trg_care_pathway_instances_exclusive_live_owner',
      'trg_tasks_exclusive_live_owner',
    ]);

    await expectDeferredFailure(client, {
      statement: `UPDATE care_pathway_instances SET owning_clinician_uid = $3::uuid
                   WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      params: [tenantId, fixture.instanceId, adminUid],
      constraint: 'trg_care_pathway_instances_exclusive_live_owner',
      message: 'clinically eligible named owner',
    });
    for (const statement of [
      `UPDATE users SET is_active = FALSE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      `UPDATE users SET status = 'suspended', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      `UPDATE users SET is_deleted = TRUE, deleted_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      `UPDATE users SET role = 'ADMIN', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
    ]) {
      await expectDeferredFailure(client, {
        statement,
        params: [tenantId, ownerUid],
        constraint: 'trg_users_exclusive_live_owner_viability',
        message: 'clinically eligible named owner',
      });
    }

    const otherTenantId = await seedTenant(client);
    const crossTenantUid = await seedUser(client, otherTenantId);
    await expectDeferredFailure(client, {
      statement: `UPDATE tasks
                     SET assigned_to_uid = $3::uuid, assigned_to_role = NULL
                   WHERE tenant_id = $1::uuid AND id = $2::integer`,
      params: [tenantId, task.id, crossTenantUid],
      constraint: 'trg_tasks_exclusive_live_owner',
      message: 'exactly one live route-capable owner',
    });
  });

  test('permits explicit same-transaction reassignment before deactivation', async () => {
    const tenantId = await seedTenant(client);
    const firstOwnerUid = await seedUser(client, tenantId);
    const nextOwnerUid = await seedUser(client, tenantId, 'CONSULTANT');
    const fixture = await seedPathway(client, { tenantId, ownerUid: firstOwnerUid });
    const task = await insertPathwayTask(client, fixture, { ownerUid: firstOwnerUid });
    await flushConstraints(client, [
      'trg_care_pathway_instances_exclusive_live_owner',
      'trg_tasks_exclusive_live_owner',
    ]);

    await client.query(
      `UPDATE care_pathway_instances SET owning_clinician_uid = $3::uuid
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, fixture.instanceId, nextOwnerUid],
    );
    await client.query(
      `UPDATE tasks SET assigned_to_uid = $3::uuid
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, task.id, nextOwnerUid],
    );
    await client.query(
      `UPDATE users
          SET is_active = FALSE, status = 'inactive', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      [tenantId, firstOwnerUid],
    );
    await expect(flushConstraints(client, [
      'fk_care_pathway_instances_owner_tenant',
      'trg_care_pathway_instances_exclusive_live_owner',
      'trg_tasks_exclusive_live_owner',
      'trg_users_exclusive_live_owner_viability',
    ])).resolves.toBeUndefined();
  });

  test('rejects owner deletion without silently converting the pathway to a role queue', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId);
    const fixture = await seedPathway(client, { tenantId, ownerUid });
    await flushConstraints(client, [
      'trg_care_pathway_instances_exclusive_live_owner',
    ]);

    await client.query('SAVEPOINT expected_owner_delete_failure');
    await client.query(
      'DELETE FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid',
      [tenantId, ownerUid],
    );
    const stillNamed = await client.query(
      `SELECT owning_clinician_uid
         FROM care_pathway_instances
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, fixture.instanceId],
    );
    expect(stillNamed.rows[0].owning_clinician_uid).toBe(ownerUid);
    let failure;
    try {
      await client.query('SET CONSTRAINTS fk_care_pathway_instances_owner_tenant IMMEDIATE');
    } catch (error) {
      failure = error;
    }
    await client.query('ROLLBACK TO SAVEPOINT expected_owner_delete_failure');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    expect(failure).toMatchObject({ code: '23503' });
  });

  test('preserves legacy plural and empty critical-result SLA role declarations', async () => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const sla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id,
          status, due_at, assigned_role_codes, metadata)
       VALUES ($1::uuid, 'critical_result_ack', $2::uuid,
               'lab_results', $3::text, 'active', NOW() + INTERVAL '1 hour',
               ARRAY['DUTY_DOCTOR', 'DOCTOR']::text[],
               '{"task_materialization_contract":"application_atomic_v1"}'::jsonb)
       RETURNING id, due_at`,
      [tenantId, patientUid, `legacy-${token()}`],
    );
    const task = await client.query(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id, assigned_to_role,
          workflow_sla_instance_id, sla_completion_semantics, due_at)
       SELECT $1::uuid, 'review', 'Legacy plural SLA owner', $2::uuid,
              sla.source_table, sla.source_id, 'DUTY_DOCTOR',
              sla.id, 'acknowledgement', sla.due_at
         FROM workflow_sla_instances AS sla
        WHERE sla.tenant_id = $1::uuid AND sla.id = $3::uuid
       RETURNING id`,
      [tenantId, patientUid, sla.rows[0].id],
    );
    await flushConstraints(client, [
      'trg_tasks_exclusive_live_owner',
      'trg_workflow_sla_exclusive_live_owner',
    ]);

    await client.query(
      `UPDATE workflow_sla_instances SET assigned_role_codes = ARRAY[]::text[]
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, sla.rows[0].id],
    );
    await expect(flushConstraints(client, [
      'trg_workflow_sla_exclusive_live_owner',
    ])).resolves.toBeUndefined();

    const inactiveUid = await seedUser(client, tenantId, 'DOCTOR', {
      isActive: false,
      status: 'inactive',
    });
    await expectDeferredFailure(client, {
      statement: `UPDATE tasks
                     SET assigned_to_uid = $3::uuid,
                         assigned_to_role = 'DUTY_DOCTOR'
                   WHERE tenant_id = $1::uuid AND id = $2::integer`,
      params: [tenantId, task.rows[0].id, inactiveUid],
      constraint: 'trg_tasks_exclusive_live_owner',
      message: 'exactly one live route-capable owner',
    });
  });

  test('rejects empty cold-chain SLA routing after accepting a valid alert role', async () => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const sla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id,
          status, due_at, assigned_role_codes, metadata)
       VALUES ($1::uuid, 'cold_chain_excursion_ack', $2::uuid,
               'cold_chain_excursions', $3::text, 'active',
               NOW() + INTERVAL '1 hour', ARRAY['DUTY_DOCTOR']::text[],
               '{"task_materialization_contract":"application_atomic_v1"}'::jsonb)
       RETURNING id, due_at`,
      [tenantId, patientUid, `cold-chain-${token()}`],
    );
    await client.query(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id, assigned_to_role,
          workflow_sla_instance_id, sla_completion_semantics, due_at)
       SELECT $1::uuid, 'review', 'Cold-chain alert acknowledgement', $2::uuid,
              sla.source_table, sla.source_id, 'DUTY_DOCTOR',
              sla.id, 'acknowledgement', sla.due_at
         FROM workflow_sla_instances AS sla
        WHERE sla.tenant_id = $1::uuid AND sla.id = $3::uuid`,
      [tenantId, patientUid, sla.rows[0].id],
    );
    await flushConstraints(client, [
      'trg_tasks_exclusive_live_owner',
      'trg_workflow_sla_exclusive_live_owner',
    ]);

    await expectDeferredFailure(client, {
      statement: `UPDATE workflow_sla_instances
                     SET assigned_role_codes = ARRAY[]::text[]
                   WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      params: [tenantId, sla.rows[0].id],
      constraint: 'trg_workflow_sla_exclusive_live_owner',
      message: 'owner assignments must agree',
    });
  });

  test('preserves verified empty mortuary SLA routing compatibility', async () => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const deathRecordId = await seedDeathRecord(client, tenantId, patientUid);
    const sla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id,
          status, due_at, assigned_role_codes, metadata)
       VALUES ($1::uuid, 'mortuary_unclaimed_body', $2::uuid,
               'death_records', $3::text, 'active', NOW() + INTERVAL '1 hour',
               ARRAY[]::text[],
               '{"task_materialization_contract":"application_atomic_v1"}'::jsonb)
       RETURNING id, due_at`,
      [tenantId, patientUid, String(deathRecordId)],
    );
    await client.query(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id, assigned_to_role,
          workflow_sla_instance_id, sla_completion_semantics, due_at)
       SELECT $1::uuid, 'review', 'Mortuary custody follow-up', $2::uuid,
              'death_record', sla.source_id, 'MEDICAL_RECORDS',
              sla.id, 'domain_evidence', sla.due_at
         FROM workflow_sla_instances AS sla
        WHERE sla.tenant_id = $1::uuid AND sla.id = $3::uuid`,
      [tenantId, patientUid, sla.rows[0].id],
    );

    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
      command: 'SET',
    });
  });

  test('requires exact singleton SLA ownership for role and named pathways', async () => {
    const tenantId = await seedTenant(client);
    const roleFixture = await seedPathway(client, {
      tenantId,
      accountableRole: 'DOCTOR',
      stepRole: 'DUTY_DOCTOR',
    });
    const roleSla = await insertPathwaySla(client, roleFixture, {
      ownerRoles: ['DUTY_DOCTOR'],
    });
    await insertPathwayTask(client, roleFixture, {
      ownerRole: 'DUTY_DOCTOR',
      slaId: roleSla.id,
      dueAt: roleSla.due_at,
    });
    await flushConstraints(client, [
      'trg_care_pathway_instances_exclusive_live_owner',
      'trg_tasks_exclusive_live_owner',
      'trg_workflow_sla_exclusive_live_owner',
    ]);
    await expectDeferredFailure(client, {
      statement: `UPDATE workflow_sla_instances
                     SET assigned_role_codes = ARRAY['DUTY_DOCTOR', 'DOCTOR']::text[]
                   WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      params: [tenantId, roleSla.id],
      constraint: 'trg_workflow_sla_exclusive_live_owner',
      message: 'same single exclusive owner',
    });

    const namedOwnerUid = await seedUser(client, tenantId, 'CONSULTANT');
    const namedFixture = await seedPathway(client, {
      tenantId,
      ownerUid: namedOwnerUid,
    });
    const namedSla = await insertPathwaySla(client, namedFixture, {
      ownerUid: namedOwnerUid,
    });
    await insertPathwayTask(client, namedFixture, {
      ownerUid: namedOwnerUid,
      slaId: namedSla.id,
      dueAt: namedSla.due_at,
    });
    await flushConstraints(client, [
      'trg_care_pathway_instances_exclusive_live_owner',
      'trg_tasks_exclusive_live_owner',
      'trg_workflow_sla_exclusive_live_owner',
    ]);
    await expectDeferredFailure(client, {
      statement: `UPDATE workflow_sla_instances
                     SET assigned_role_codes = ARRAY['CONSULTANT']::text[]
                   WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      params: [tenantId, namedSla.id],
      constraint: 'trg_workflow_sla_exclusive_live_owner',
      message: 'same single exclusive owner',
    });
  });
});
