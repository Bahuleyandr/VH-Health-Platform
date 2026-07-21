import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const migrationUrl = new URL(
  '../migrations/586_care_pathway_owner_acceptance.sql',
  import.meta.url,
);
const migrationSql = readFileSync(migrationUrl, 'utf8');
const prismaSchema = readFileSync(
  new URL('../../prisma/schema.prisma', import.meta.url),
  'utf8',
);

const FROZEN_MIGRATIONS = {
  '580_care_pathway_execution_spine.sql': {
    bytes: 253110,
    sha256: '08a4c5999194f9a11d5be46a450aa5a935258bde347944d1a40454e49f991534',
  },
  '581_lab_critical_alert_generations.sql': {
    bytes: 113292,
    sha256: 'f85eda5b76dfd05699fdbdc9a8f6a5f8b12a39e1e0929d001944ecb5cbca6da3',
  },
  '582_lab_oru_replay_idempotency.sql': {
    bytes: 66045,
    sha256: 'c70070ad84e5673eb3036bb5a73bbca6070486de0af487e8ee87aa4a1fd0514e',
  },
  '583_lab_astm_atomic_replay.sql': {
    bytes: 181391,
    sha256: '347ae413947d1a2b2a1924f43512197a7cff8b5bc78adf84f163e97fd4336261',
  },
  '584_care_pathway_governance_pinning.sql': {
    bytes: 75505,
    sha256: '597b523c408761db20bc6cc286007c7bf3e3dd2d5ac3bbbd78f679b3c1019363',
  },
  '585_care_pathway_exclusive_owner_integrity.sql': {
    bytes: 41422,
    sha256: 'db6fd812dd40b168468b4d7b33eaa49fba7216ba01c57f8e2c3117d8ac839cae',
  },
};

function token() {
  return randomUUID().replaceAll('-', '');
}

async function seedTenant(client, label = 'owner-acceptance') {
  const tenantId = randomUUID();
  await client.query(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2::text, 'Owner acceptance test tenant')`,
    [tenantId, `${label}-${token()}`],
  );
  return tenantId;
}

async function seedUser(client, tenantId, role = 'DOCTOR') {
  const uid = randomUUID();
  await client.query(
    `INSERT INTO users
       (uid, tenant_id, name, role, is_active, status, is_deleted, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::text, $4::text,
             TRUE, 'active', FALSE, NOW())`,
    [uid, tenantId, `Acceptance ${role} ${token()}`, role],
  );
  return uid;
}

async function seedPathway(client, tenantId, ownerUid) {
  const patientUid = await seedUser(client, tenantId, 'PATIENT');
  const governanceOwnerUid = await seedUser(client, tenantId, 'DOCTOR');
  const approverUid = await seedUser(client, tenantId, 'ADMIN');
  const pathwayKey = `owner_acceptance_${token()}`;
  const definition = await client.query(
    `INSERT INTO workflow_definitions
       (tenant_id, workflow_key, version, display_name, steps, triggers, defaults)
     VALUES ($1::uuid, $2::text, 1, 'Owner acceptance pathway',
             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
     RETURNING id`,
    [tenantId, pathwayKey],
  );
  const checksum = 'b'.repeat(64);
  const decidedAt = new Date('2026-07-21T08:00:00.000Z');
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
             '2026-07-21T08:01:00.000Z'::timestamptz,
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
  await client.query(
    `UPDATE workflow_definitions
        SET is_active = TRUE, updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::integer`,
    [tenantId, definition.rows[0].id],
  );
  const run = await client.query(
    `INSERT INTO workflow_runs
       (tenant_id, workflow_definition_id, workflow_key, workflow_version,
        trigger_kind, pathway_governance_id, pathway_definition_checksum)
     VALUES ($1::uuid, $2::integer, $3::text, 1, 'manual', $4::uuid, $5::char(64))
     RETURNING id`,
    [
      tenantId,
      definition.rows[0].id,
      pathwayKey,
      governance.rows[0].id,
      checksum,
    ],
  );
  const step = await client.query(
    `INSERT INTO workflow_steps
       (tenant_id, workflow_run_id, step_key, display_name, step_kind,
        ordering, assigned_role)
     VALUES ($1::uuid, $2::integer, 'review', 'Review', 'task', 1, 'DOCTOR')
     RETURNING id`,
    [tenantId, run.rows[0].id],
  );
  const sourceEpisodeId = `episode-${token()}`;
  const idempotencyKey = `start-${token()}`;
  const pathway = await client.query(
    `INSERT INTO care_pathway_instances
       (tenant_id, workflow_run_id, patient_uid, pathway_key, pathway_version,
        workflow_definition_id, definition_governance_id, definition_checksum,
        source_episode_type, source_episode_id, owning_clinician_uid,
        accountable_role, idempotency_key)
     VALUES ($1::uuid, $2::integer, $3::uuid, $4::text, 1,
             $5::integer, $6::uuid, $7::char(64),
             'owner_acceptance_test', $8::text, $9::uuid,
             'DOCTOR', $10::text)
     RETURNING id`,
    [
      tenantId,
      run.rows[0].id,
      patientUid,
      pathwayKey,
      definition.rows[0].id,
      governance.rows[0].id,
      checksum,
      sourceEpisodeId,
      ownerUid,
      idempotencyKey,
    ],
  );
  const pathwayId = pathway.rows[0].id;
  const eventId = randomUUID();
  const timelineId = randomUUID();
  const auditId = randomUUID();
  const occurredAt = new Date('2026-07-21T08:02:00.000Z');
  const commandFingerprint = 'c'.repeat(64);
  const previousState = {};
  const newState = { clinical_status: 'planned', run_status: 'started' };
  const eventPayload = {
    event_id: eventId,
    tenant_id: tenantId,
    pathway_instance_id: pathwayId,
    patient_uid: patientUid,
    encounter_id: null,
    workflow_run_id: run.rows[0].id,
    workflow_step_id: null,
    sequence_number: 1,
    transition_scope: 'pathway',
    transition_key: 'pathway_instance_created',
    stage_key: null,
    source_resource_type: 'owner_acceptance_test',
    source_resource_id: sourceEpisodeId,
    workflow_sla_instance_id: null,
    actor_uid: null,
    system_actor_key: 'owner_acceptance_test.v1',
    actor_role: null,
    occurred_at: occurredAt.toISOString(),
    idempotency_key: idempotencyKey,
    command_fingerprint: commandFingerprint,
    effect_ordinal: 0,
    workflow_definition_id: definition.rows[0].id,
    governance_id: governance.rows[0].id,
    definition_checksum: checksum,
  };
  const metadata = {
    pathway_runtime: { definition_checksum: checksum },
    command_fingerprint: commandFingerprint,
    effect_ordinal: 0,
    provenance: { kind: 'system', system_key: 'owner_acceptance_test.v1' },
  };
  await client.query(
    `INSERT INTO clinical_timeline_events
       (id, tenant_id, patient_uid, event_type, event_status,
        source_table, source_id, source_uid, resource_type, resource_id,
        occurred_at, visible_to_patient, clinical_summary, payload, tags,
        idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'care_pathway.transition', 'pathway',
             'care_pathway_transition_events', $4::text, $4::uuid,
             'care_pathway_transition_event', $4::text,
             $5::timestamptz, FALSE, 'Care pathway transition recorded',
             $6::jsonb, ARRAY['care_pathway', $7::text, 'pathway']::text[],
             $8::text)`,
    [
      timelineId,
      tenantId,
      patientUid,
      eventId,
      occurredAt,
      JSON.stringify(eventPayload),
      pathwayKey,
      `care_pathway_transition_events:${eventId}:timeline`,
    ],
  );
  await client.query(
    `INSERT INTO clinical_audit_events
       (id, tenant_id, patient_uid, action, action_status,
        resource_type, resource_table, resource_id, before_state, after_state,
        metadata, idempotency_key, occurred_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'care_pathway.transition', 'success',
             'care_pathway_transition_event', 'care_pathway_transition_events', $4::text,
             $5::jsonb, $6::jsonb, $7::jsonb, $8::text, $9::timestamptz)`,
    [
      auditId,
      tenantId,
      patientUid,
      eventId,
      JSON.stringify(previousState),
      JSON.stringify(newState),
      JSON.stringify(metadata),
      `care_pathway_transition_events:${eventId}:audit`,
      occurredAt,
    ],
  );
  await client.query(
    `INSERT INTO care_pathway_transition_events
       (id, tenant_id, pathway_instance_id, patient_uid, workflow_run_id,
        sequence_number, transition_scope, transition_key,
        previous_state, new_state, source_resource_type, source_resource_id,
        system_actor_key, occurred_at, idempotency_key,
        command_fingerprint, effect_ordinal,
        canonical_timeline_event_id, canonical_audit_event_id,
        event_payload, metadata)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer,
             1, 'pathway', 'pathway_instance_created',
             $6::jsonb, $7::jsonb, 'owner_acceptance_test', $8::text,
             'owner_acceptance_test.v1', $9::timestamptz, $10::text,
             $11::char(64), 0, $12::uuid, $13::uuid,
             $14::jsonb, $15::jsonb)`,
    [
      eventId,
      tenantId,
      pathwayId,
      patientUid,
      run.rows[0].id,
      JSON.stringify(previousState),
      JSON.stringify(newState),
      sourceEpisodeId,
      occurredAt,
      idempotencyKey,
      commandFingerprint,
      timelineId,
      auditId,
      JSON.stringify(eventPayload),
      JSON.stringify(metadata),
    ],
  );
  return {
    tenantId,
    patientUid,
    ownerUid,
    runId: run.rows[0].id,
    stepId: step.rows[0].id,
    stepKey: 'review',
    pathwayId,
  };
}

async function insertCoveringRequest(client, fixture, recipientUid, overrides = {}) {
  const handoffId = overrides.handoffId || randomUUID();
  const requestFingerprint = Object.hasOwn(overrides, 'requestFingerprint')
    ? overrides.requestFingerprint
    : createHash('sha256').update(`covering:${handoffId}`).digest('hex');
  const task = await client.query(
    `INSERT INTO tasks
       (tenant_id, task_kind, title, patient_uid, related_resource_type,
        related_resource_id, status, assigned_to_uid)
     VALUES ($1::uuid, 'pathway_owner_transfer_review',
             'Review covering-clinician transfer', $2::uuid,
             'care_handoff_instance', $3::text, 'open', $4::uuid)
     RETURNING id`,
    [fixture.tenantId, fixture.patientUid, handoffId, recipientUid],
  );
  const result = await client.query(
    `INSERT INTO care_handoff_instances
       (id, tenant_id, patient_uid,
        sending_pathway_instance_id, sending_workflow_run_id, sending_step_key,
        receiving_pathway_instance_id, receiving_workflow_run_id, receiving_step_key,
        handoff_type, source_resource_type, source_resource_id,
        urgency_code, policy_due_at, sender_uid, recipient_kind,
        intended_recipient_uid, status, accepted_at, accepted_by_uid,
        task_id, idempotency_key, metadata, request_reason, request_fingerprint)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             $4::uuid, $5::integer, $6::text,
             $7::uuid, $8::integer, $9::text,
             'covering_clinician_reassignment', 'care_pathway_instance', $10::text,
             'not_applicable', NULL, $11::uuid, 'user',
             $12::uuid, $13::text, $14::timestamptz, $15::uuid,
             $16::integer, $17::text, $18::jsonb, $19::text, $20::char(64))
     RETURNING id, task_id, status, accepted_at, accepted_by_uid`,
    [
      handoffId,
      fixture.tenantId,
      fixture.patientUid,
      overrides.sendingPathwayId || fixture.pathwayId,
      fixture.runId,
      fixture.stepKey,
      overrides.receivingPathwayId || fixture.pathwayId,
      fixture.runId,
      overrides.receivingStepKey || fixture.stepKey,
      overrides.sourceResourceId || fixture.pathwayId,
      fixture.ownerUid,
      recipientUid,
      overrides.status || 'requested',
      overrides.acceptedAt || null,
      overrides.acceptedByUid || null,
      task.rows[0].id,
      overrides.idempotencyKey || `cover-${token()}`,
      JSON.stringify({ request_reason: overrides.requestReason ?? 'Planned covering duty' }),
      overrides.requestReason ?? 'Planned covering duty',
      requestFingerprint,
    ],
  );
  return result.rows[0];
}

async function insertPathwayTaskWithSla(
  client,
  fixture,
  ownerUid,
  { status = 'active' } = {},
) {
  const completed = status === 'completed';
  const startedAt = new Date('2026-07-21T08:00:00.000Z');
  const dueAt = new Date('2026-07-21T09:00:00.000Z');
  const completedAt = completed
    ? new Date('2026-07-21T08:05:00.000Z')
    : null;
  const taskSequence = await client.query(
    "SELECT nextval(pg_get_serial_sequence('tasks', 'id'))::integer AS id",
  );
  const taskId = taskSequence.rows[0].id;
  const slaMetadata = {
    task_materialization_contract: 'application_atomic_v1',
    care_pathway_instance_id: fixture.pathwayId,
    ...(completed
      ? {
          completed_via: 'task_ack',
          completed_by_task: taskId,
          completed_by: ownerUid,
          acknowledged_at: completedAt.toISOString(),
          acknowledged_by: ownerUid,
          acknowledged_via: 'assignee',
        }
      : {}),
  };
  const sla = await client.query(
    `INSERT INTO workflow_sla_instances
       (tenant_id, rule_code, patient_uid, source_table, source_id,
        status, started_at, due_at, completed_at, breached_at, escalated_at,
        assigned_user_uid, assigned_role_codes,
        metadata)
     VALUES ($1::uuid, 'pathway_owner_acceptance_review', $2::uuid,
             'workflow_steps', $3::text,
             $4::text, $5::timestamptz, $6::timestamptz, $7::timestamptz,
             CASE WHEN $4::text IN ('breached', 'escalated')
               THEN $6::timestamptz ELSE NULL END,
             CASE WHEN $4::text = 'escalated'
               THEN $6::timestamptz ELSE NULL END,
             $8::uuid, ARRAY[]::text[], $9::jsonb)
     RETURNING id, due_at, completed_at`,
    [
      fixture.tenantId,
      fixture.patientUid,
      String(fixture.stepId),
      status,
      startedAt,
      dueAt,
      completedAt,
      ownerUid,
      JSON.stringify(slaMetadata),
    ],
  );
  const taskMetadata = {
    sla_instance_id: sla.rows[0].id,
    sla_key: 'pathway_owner_acceptance_review',
    ...(completed
      ? {
          acknowledged_at: completedAt.toISOString(),
          acknowledged_by: ownerUid,
          acknowledged_via: 'assignee',
        }
      : {}),
  };
  await client.query(
    `INSERT INTO tasks
       (id, tenant_id, workflow_run_id, workflow_step_id,
        task_kind, title, patient_uid, related_resource_type,
        related_resource_id, status, assigned_to_uid,
        workflow_sla_instance_id, sla_completion_semantics, due_at, metadata)
     VALUES ($1::integer, $2::uuid, $3::integer, $4::integer,
             'review', 'Pathway owner acceptance task', $5::uuid,
             'care_pathway_instance', $6::text, $7::text, $8::uuid,
             $9::uuid, 'acknowledgement', $10::timestamptz,
             $11::jsonb)`,
    [
      taskId,
      fixture.tenantId,
      fixture.runId,
      fixture.stepId,
      fixture.patientUid,
      fixture.pathwayId,
      completed ? 'in_progress' : 'open',
      ownerUid,
      sla.rows[0].id,
      sla.rows[0].due_at,
      JSON.stringify(taskMetadata),
    ],
  );
  return { taskId, slaId: sla.rows[0].id };
}

async function expectStatementFailure(client, statement, params, code, message) {
  await client.query('SAVEPOINT expected_owner_acceptance_failure');
  let failure;
  try {
    await client.query(statement, params);
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_owner_acceptance_failure');
  expect(failure).toMatchObject({ code });
  if (message) expect(failure.message).toContain(message);
}

async function expectDeferredFailure(client, statement, params, code, message) {
  await client.query('SAVEPOINT expected_owner_acceptance_deferred_failure');
  let failure;
  try {
    await client.query(statement, params);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_owner_acceptance_deferred_failure');
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  expect(failure).toMatchObject({ code });
  if (message) expect(failure.message).toContain(message);
}

describe('migration 586 static owner-acceptance contract', () => {
  test('keeps migrations 580 through 585 byte-for-byte frozen', () => {
    for (const [name, expected] of Object.entries(FROZEN_MIGRATIONS)) {
      const contents = readFileSync(new URL(`../migrations/${name}`, import.meta.url));
      expect(contents.byteLength).toBe(expected.bytes);
      expect(createHash('sha256').update(contents).digest('hex')).toBe(expected.sha256);
    }
  });

  test('reserves one migration 586 and remains additive and fail-closed', () => {
    const migrationNames = readdirSync(new URL('../migrations/', import.meta.url))
      .filter((name) => name.startsWith('586_'));
    expect(migrationNames).toEqual(['586_care_pathway_owner_acceptance.sql']);
    expect(migrationSql).toContain("SET LOCAL lock_timeout = '10s'");
    expect(migrationSql).toContain("SET LOCAL statement_timeout = '60s'");
    expect(migrationSql).toContain('migration 586 blocked: care handoff columns are noncanonical');
    expect(migrationSql).toContain('migration 586 blocked: covering-clinician transfer rows predate immutable request evidence');
    expect(migrationSql).toContain('migration 586 blocked: task kinds fall outside the canonical runtime contract');
    expect(migrationSql).toContain('ADD COLUMN request_reason TEXT');
    expect(migrationSql).toContain('ADD COLUMN request_fingerprint CHAR(64)');
    expect(migrationSql).toContain('ADD COLUMN accepted_by_uid UUID');
    expect(migrationSql).toContain('AND request_fingerprint IS NOT NULL');
    expect(migrationSql).toContain("'care_pathway_transfer_recipient'");
    expect(migrationSql).toContain("'care_pathway_transfer_decline_recipient'");
    expect(migrationSql).toContain("'care_pathway_role_queue_claimant'");
    expect(migrationSql).toContain('DROP CONSTRAINT IF EXISTS tasks_task_kind_check');
    expect(migrationSql).not.toMatch(/\bUPDATE\s+care_handoff_instances\b/i);
    expect(migrationSql).not.toMatch(/\bUPDATE\s+care_pathway_instances\b/i);
    expect(migrationSql).not.toMatch(/\bUPDATE\s+tenants\b/i);
  });

  test('pins exact acceptance, uniqueness, and recipient lookup contracts', () => {
    expect(migrationSql).toContain('CONSTRAINT fk_care_handoff_accepted_by_tenant');
    expect(migrationSql).toContain('CONSTRAINT care_handoff_covering_transfer_check');
    expect(migrationSql).toContain('accepted_by_uid = intended_recipient_uid');
    expect(migrationSql).toContain("request_fingerprint ~ '^[0-9a-f]{64}$'");
    expect(migrationSql).toContain('task_id IS NOT NULL');
    expect(migrationSql).toContain('CREATE UNIQUE INDEX ux_care_handoff_one_live_covering_transfer');
    expect(migrationSql).toContain("THEN 'requested'");
    expect(migrationSql).toContain('ELSE id::TEXT');
    expect(migrationSql).toContain('CREATE INDEX idx_care_handoff_covering_recipient');
    expect(migrationSql).toContain('CREATE INDEX idx_care_handoff_accepted_by');
    expect(migrationSql).toContain('CREATE OR REPLACE FUNCTION care_pathway_assert_covering_transfer(');
    expect(migrationSql).toContain('CREATE TRIGGER trg_care_handoff_covering_transfer_immutable');
    expect(migrationSql).toContain('CREATE CONSTRAINT TRIGGER trg_care_handoff_covering_transfer_invariant');
    expect(migrationSql).toContain('CREATE CONSTRAINT TRIGGER trg_care_pathway_instances_covering_transfer_dependency');
    expect(migrationSql).toContain('CREATE CONSTRAINT TRIGGER trg_tasks_covering_transfer_dependency');
    expect(migrationSql).toMatch(
      /IF is_pathway_task\s+AND obligation\.sla_completed_at IS NULL\s+AND obligation\.sla_status IN \('active', 'breached', 'escalated'\)/,
    );
  });

  test('keeps Prisma parity for the receipt relation and every new query path', () => {
    expect(prismaSchema).toMatch(/request_reason\s+String\?/);
    expect(prismaSchema).toMatch(/request_fingerprint\s+String\?\s+@db\.Char\(64\)/);
    expect(prismaSchema).toMatch(/accepted_by_uid\s+String\?\s+@db\.Uuid/);
    expect(prismaSchema).toContain('@relation("care_handoff_accepted_by", fields: [tenant_id, accepted_by_uid], references: [tenant_id, uid], onDelete: NoAction, onUpdate: NoAction, map: "fk_care_handoff_accepted_by_tenant")');
    expect(prismaSchema).toContain('care_handoff_accepted_by');
    expect(prismaSchema).toContain('This model contains an expression index');
    expect(prismaSchema).not.toContain('map: "ux_care_handoff_one_live_covering_transfer"');
    expect(prismaSchema).toContain('map: "idx_care_handoff_covering_recipient"');
    expect(prismaSchema).toContain('map: "idx_care_handoff_accepted_by"');
  });
});

describeIfDb('migration 586 PostgreSQL owner-acceptance conformance', () => {
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

  test('installs the nullable same-tenant acceptance FK and exact indexes', async () => {
    const columns = await client.query(
      `SELECT attribute.attname,
              pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS type,
              attribute.attnotnull
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'care_handoff_instances'::regclass
          AND attribute.attname = ANY($1::text[])
          AND attribute.attnum > 0
          AND attribute.attisdropped IS FALSE
        ORDER BY attribute.attname`,
      [['accepted_by_uid', 'request_fingerprint', 'request_reason']],
    );
    expect(columns.rows).toEqual([
      { attname: 'accepted_by_uid', type: 'uuid', attnotnull: false },
      { attname: 'request_fingerprint', type: 'character(64)', attnotnull: false },
      { attname: 'request_reason', type: 'text', attnotnull: false },
    ]);

    const foreignKey = await client.query(
      `SELECT constraint_row.contype,
              constraint_row.convalidated,
              pg_catalog.pg_get_constraintdef(constraint_row.oid) AS definition
         FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = 'care_handoff_instances'::regclass
          AND constraint_row.conname = 'fk_care_handoff_accepted_by_tenant'`,
    );
    expect(foreignKey.rows[0]).toMatchObject({ contype: 'f', convalidated: true });
    expect(foreignKey.rows[0].definition).toContain('FOREIGN KEY (tenant_id, accepted_by_uid)');
    expect(foreignKey.rows[0].definition).toContain('REFERENCES users(tenant_id, uid)');

    const indexes = await client.query(
      `SELECT index_rel.relname AS index_name,
              pg_catalog.pg_get_indexdef(index_rel.oid) AS definition
         FROM pg_catalog.pg_class AS index_rel
         JOIN pg_catalog.pg_index AS index_row
           ON index_row.indexrelid = index_rel.oid
        WHERE index_row.indrelid = 'care_handoff_instances'::regclass
          AND index_rel.relname = ANY($1::text[])
        ORDER BY index_rel.relname`,
      [[
        'idx_care_handoff_accepted_by',
        'idx_care_handoff_covering_recipient',
        'ux_care_handoff_one_live_covering_transfer',
      ]],
    );
    expect(indexes.rows.map((row) => row.index_name)).toEqual([
      'idx_care_handoff_accepted_by',
      'idx_care_handoff_covering_recipient',
      'ux_care_handoff_one_live_covering_transfer',
    ]);
    expect(indexes.rows.find((row) => row.index_name.startsWith('ux_')).definition)
      .toContain('UNIQUE INDEX');
    expect(indexes.rows.find((row) => row.index_name.startsWith('ux_')).definition)
      .toContain('CASE');

    const constraintTriggers = await client.query(
      `SELECT trigger_row.tgname,
              constraint_row.condeferrable,
              constraint_row.condeferred
         FROM pg_catalog.pg_trigger AS trigger_row
         JOIN pg_catalog.pg_constraint AS constraint_row
           ON constraint_row.oid = trigger_row.tgconstraint
        WHERE trigger_row.tgname = ANY($1::text[])
          AND trigger_row.tgisinternal IS FALSE
        ORDER BY trigger_row.tgname`,
      [[
        'trg_care_handoff_covering_transfer_invariant',
        'trg_care_pathway_instances_covering_transfer_dependency',
        'trg_tasks_covering_transfer_dependency',
      ]],
    );
    expect(constraintTriggers.rows).toEqual([
      {
        tgname: 'trg_care_handoff_covering_transfer_invariant',
        condeferrable: true,
        condeferred: true,
      },
      {
        tgname: 'trg_care_pathway_instances_covering_transfer_dependency',
        condeferrable: true,
        condeferred: true,
      },
      {
        tgname: 'trg_tasks_covering_transfer_dependency',
        condeferrable: true,
        condeferred: true,
      },
    ]);
  });

  test('moves an actionable task while preserving its completed SLA owner receipt', async () => {
    const tenantId = await seedTenant(client);
    const priorOwnerUid = await seedUser(client, tenantId, 'DOCTOR');
    const nextOwnerUid = await seedUser(client, tenantId, 'CONSULTANT');
    const fixture = await seedPathway(client, tenantId, priorOwnerUid);
    const linked = await insertPathwayTaskWithSla(client, fixture, priorOwnerUid, {
      status: 'completed',
    });
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    await client.query(
      `UPDATE care_pathway_instances
          SET owning_clinician_uid = $3::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, fixture.pathwayId, nextOwnerUid],
    );
    await client.query(
      `UPDATE tasks
          SET assigned_to_uid = $3::uuid, assigned_to_role = NULL, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, linked.taskId, nextOwnerUid],
    );
    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
      command: 'SET',
    });

    const receipt = await client.query(
      `SELECT task.assigned_to_uid AS task_owner_uid,
              sla.assigned_user_uid AS sla_owner_uid,
              sla.status AS sla_status,
              sla.completed_at
         FROM tasks AS task
         JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid AND task.id = $2::integer`,
      [tenantId, linked.taskId],
    );
    expect(receipt.rows[0]).toMatchObject({
      task_owner_uid: nextOwnerUid,
      sla_owner_uid: priorOwnerUid,
      sla_status: 'completed',
    });
    expect(receipt.rows[0].completed_at).toBeInstanceOf(Date);
  });

  test.each(['active', 'breached', 'escalated'])(
    'still rejects an actionable task whose incomplete %s SLA keeps the prior owner',
    async (slaStatus) => {
      const tenantId = await seedTenant(client);
      const priorOwnerUid = await seedUser(client, tenantId, 'DOCTOR');
      const nextOwnerUid = await seedUser(client, tenantId, 'CONSULTANT');
      const fixture = await seedPathway(client, tenantId, priorOwnerUid);
      const linked = await insertPathwayTaskWithSla(client, fixture, priorOwnerUid, {
        status: slaStatus,
      });
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query('SAVEPOINT expected_live_sla_owner_failure');
      await client.query(
        `UPDATE care_pathway_instances
            SET owning_clinician_uid = $3::uuid, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [tenantId, fixture.pathwayId, nextOwnerUid],
      );
      await client.query(
        `UPDATE tasks
            SET assigned_to_uid = $3::uuid, assigned_to_role = NULL, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        [tenantId, linked.taskId, nextOwnerUid],
      );
      let failure;
      try {
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      } catch (error) {
        failure = error;
      }
      await client.query('ROLLBACK TO SAVEPOINT expected_live_sla_owner_failure');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      expect(failure).toMatchObject({ code: '23514' });
      expect(failure.message).toContain(
        'actionable pathway SLA requires the same single exclusive owner as its task',
      );
    },
  );

  test('keeps request ownership unchanged and records only exact-recipient acceptance', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId, 'DOCTOR');
    const recipientUid = await seedUser(client, tenantId, 'CONSULTANT');
    const fixture = await seedPathway(client, tenantId, ownerUid);
    const request = await insertCoveringRequest(client, fixture, recipientUid);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    const beforeAcceptance = await client.query(
      `SELECT pathway.owning_clinician_uid, handoff.status,
              handoff.accepted_at, handoff.accepted_by_uid
         FROM care_pathway_instances AS pathway
         JOIN care_handoff_instances AS handoff
           ON handoff.tenant_id = pathway.tenant_id
          AND handoff.sending_pathway_instance_id = pathway.id
        WHERE pathway.tenant_id = $1::uuid
          AND handoff.id = $2::uuid`,
      [tenantId, request.id],
    );
    expect(beforeAcceptance.rows[0]).toMatchObject({
      owning_clinician_uid: ownerUid,
      status: 'requested',
      accepted_at: null,
      accepted_by_uid: null,
    });

    await client.query(
      `UPDATE care_pathway_instances
          SET owning_clinician_uid = $3::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, fixture.pathwayId, recipientUid],
    );
    await client.query(
      `UPDATE tasks
          SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, request.task_id],
    );
    const accepted = await client.query(
      `UPDATE care_handoff_instances
          SET status = 'accepted',
              accepted_at = NOW(),
              accepted_by_uid = $3::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid
      RETURNING status, accepted_at, accepted_by_uid`,
      [tenantId, request.id, recipientUid],
    );
    expect(accepted.rows[0].status).toBe('accepted');
    expect(accepted.rows[0].accepted_at).toBeInstanceOf(Date);
    expect(accepted.rows[0].accepted_by_uid).toBe(recipientUid);
    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
      command: 'SET',
    });
  });

  test('rejects every material deviation from the exact transfer review task binding', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId, 'DOCTOR');
    const recipientUid = await seedUser(client, tenantId, 'CONSULTANT');
    const otherPatientUid = await seedUser(client, tenantId, 'PATIENT');
    const fixture = await seedPathway(client, tenantId, ownerUid);
    const request = await insertCoveringRequest(client, fixture, recipientUid);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    const bindingMutations = [
      ["task_kind = 'review'", []],
      ['patient_uid = $3::uuid', [otherPatientUid]],
      ['workflow_run_id = $3::integer', [fixture.runId]],
      ["related_resource_id = '00000000-0000-4000-8000-000000000099'", []],
      ["assigned_to_role = 'DOCTOR'", []],
      ["due_at = NOW() + INTERVAL '1 hour'", []],
      ['sla_definition_id = 1', []],
    ];
    for (const [assignment, extraParams] of bindingMutations) {
      await expectDeferredFailure(
        client,
        `UPDATE tasks SET ${assignment}, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        [tenantId, request.task_id, ...extraParams],
        '23514',
        'covering-clinician transfer review task binding is noncanonical',
      );
    }

    await expectDeferredFailure(
      client,
      `UPDATE tasks SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, request.task_id],
      '23514',
      'recipient review task to remain actionable',
    );
    await expectDeferredFailure(
      client,
      `UPDATE care_handoff_instances SET acknowledged_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, request.id],
      '23514',
      'unsupported handoff lifecycle',
    );
  });

  test.each([
    ['missing', null],
    ['uppercase', 'A'.repeat(64)],
    ['short', 'a'.repeat(63)],
  ])('rejects a %s immutable request fingerprint at insertion', async (_label, fingerprint) => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId, 'DOCTOR');
    const recipientUid = await seedUser(client, tenantId, 'CONSULTANT');
    const fixture = await seedPathway(client, tenantId, ownerUid);
    await client.query('SAVEPOINT expected_invalid_request_fingerprint');
    let failure;
    try {
      await insertCoveringRequest(client, fixture, recipientUid, {
        requestFingerprint: fingerprint,
      });
    } catch (error) {
      failure = error;
    }
    await client.query('ROLLBACK TO SAVEPOINT expected_invalid_request_fingerprint');
    expect(failure).toMatchObject({ code: '23514' });
    expect(failure.message).toContain('care_handoff_covering_transfer_check');
  });

  test('rejects acceptance unless pathway owner and bound review task move atomically', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId, 'DOCTOR');
    const recipientUid = await seedUser(client, tenantId, 'CONSULTANT');
    const fixture = await seedPathway(client, tenantId, ownerUid);
    const request = await insertCoveringRequest(client, fixture, recipientUid);
    await client.query('SAVEPOINT expected_partial_acceptance_failure');
    await client.query(
      `UPDATE care_handoff_instances
          SET status = 'accepted', accepted_at = NOW(), accepted_by_uid = $3::uuid
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, request.id, recipientUid],
    );
    let failure;
    try {
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    } catch (error) {
      failure = error;
    }
    await client.query('ROLLBACK TO SAVEPOINT expected_partial_acceptance_failure');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    expect(failure).toMatchObject({ code: '23514' });
    expect(failure.message).toContain(
      'accepted covering-clinician transfer requires the intended recipient owner and completed review task',
    );
  });

  test.each([
    ['declined', 'Recipient declined covering duty'],
    ['cancelled', 'Current owner cancelled covering request'],
  ])('closes a %s request only with the sender owner and exactly reasoned cancelled task', async (
    decision,
    reason,
  ) => {
    const tenantId = await seedTenant(client, decision);
    const ownerUid = await seedUser(client, tenantId, 'DOCTOR');
    const recipientUid = await seedUser(client, tenantId, 'CONSULTANT');
    const fixture = await seedPathway(client, tenantId, ownerUid);
    const request = await insertCoveringRequest(client, fixture, recipientUid);
    await client.query(
      `UPDATE tasks
          SET status = 'cancelled', cancelled_at = NOW(),
              cancellation_reason = $3::text, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, request.task_id, reason],
    );
    if (decision === 'declined') {
      await client.query(
        `UPDATE care_handoff_instances
            SET status = 'declined', declined_at = NOW(), decline_reason = $3::text
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [tenantId, request.id, reason],
      );
    } else {
      await client.query(
        `UPDATE care_handoff_instances
            SET status = 'cancelled', cancelled_at = NOW(),
                cancellation_reason = $3::text
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [tenantId, request.id, reason],
      );
    }
    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
      command: 'SET',
    });

    const state = await client.query(
      `SELECT pathway.owning_clinician_uid, handoff.status, task.status AS task_status
         FROM care_handoff_instances AS handoff
         JOIN care_pathway_instances AS pathway
           ON pathway.tenant_id = handoff.tenant_id
          AND pathway.id = handoff.sending_pathway_instance_id
         JOIN tasks AS task
           ON task.tenant_id = handoff.tenant_id AND task.id = handoff.task_id
        WHERE handoff.tenant_id = $1::uuid AND handoff.id = $2::uuid`,
      [tenantId, request.id],
    );
    expect(state.rows[0]).toEqual({
      owning_clinician_uid: ownerUid,
      status: decision,
      task_status: 'cancelled',
    });
  });

  test('rejects wrong acceptors, missing reasons, and mismatched pathway context', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId, 'DOCTOR');
    const recipientUid = await seedUser(client, tenantId, 'CONSULTANT');
    const otherUid = await seedUser(client, tenantId, 'DOCTOR');
    const fixture = await seedPathway(client, tenantId, ownerUid);
    const request = await insertCoveringRequest(client, fixture, recipientUid);

    await expectStatementFailure(
      client,
      `UPDATE care_handoff_instances
          SET status = 'accepted', accepted_at = NOW(), accepted_by_uid = $3::uuid
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, request.id, otherUid],
      '23514',
      'care_handoff_covering_transfer_check',
    );
    await expectStatementFailure(
      client,
      `UPDATE care_handoff_instances
          SET request_reason = '   '
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, request.id],
      '23514',
      'covering-clinician transfer request evidence is immutable',
    );
    await expectStatementFailure(
      client,
      `UPDATE care_handoff_instances
          SET receiving_step_key = 'other'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, request.id],
      '23514',
      'covering-clinician transfer request evidence is immutable',
    );
  });

  test('permits only one live covering request and releases the slot after acceptance', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId, 'DOCTOR');
    const firstRecipientUid = await seedUser(client, tenantId, 'CONSULTANT');
    const secondRecipientUid = await seedUser(client, tenantId, 'DOCTOR');
    const fixture = await seedPathway(client, tenantId, ownerUid);
    const first = await insertCoveringRequest(client, fixture, firstRecipientUid);

    await expectStatementFailure(
      client,
      `INSERT INTO care_handoff_instances
         (tenant_id, patient_uid,
          sending_pathway_instance_id, sending_workflow_run_id, sending_step_key,
          receiving_pathway_instance_id, receiving_workflow_run_id, receiving_step_key,
          handoff_type, source_resource_type, source_resource_id,
          urgency_code, sender_uid, recipient_kind, intended_recipient_uid,
          task_id, idempotency_key, metadata, request_reason, request_fingerprint)
       SELECT tenant_id, patient_uid,
              sending_pathway_instance_id, sending_workflow_run_id, sending_step_key,
              receiving_pathway_instance_id, receiving_workflow_run_id, receiving_step_key,
              handoff_type, source_resource_type, source_resource_id,
              urgency_code, sender_uid, recipient_kind, $3::uuid,
              task_id, $4::text, metadata, request_reason, request_fingerprint
         FROM care_handoff_instances
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, first.id, secondRecipientUid, `cover-${token()}`],
      '23505',
      'ux_care_handoff_one_live_covering_transfer',
    );

    await client.query(
      `UPDATE care_pathway_instances
          SET owning_clinician_uid = $3::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, fixture.pathwayId, firstRecipientUid],
    );
    await client.query(
      `UPDATE tasks
          SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, first.task_id],
    );
    await client.query(
      `UPDATE care_handoff_instances
          SET status = 'accepted', accepted_at = NOW(), accepted_by_uid = $3::uuid
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, first.id, firstRecipientUid],
    );
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const second = await insertCoveringRequest(
      client,
      { ...fixture, ownerUid: firstRecipientUid },
      secondRecipientUid,
    );
    expect(second).toMatchObject({ status: 'requested' });
    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
      command: 'SET',
    });
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(
      `UPDATE care_pathway_instances
          SET owning_clinician_uid = $3::uuid, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, fixture.pathwayId, secondRecipientUid],
    );
    await client.query(
      `UPDATE tasks
          SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, second.task_id],
    );
    await client.query(
      `UPDATE care_handoff_instances
          SET status = 'accepted', accepted_at = NOW(), accepted_by_uid = $3::uuid
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, second.id, secondRecipientUid],
    );
    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
      command: 'SET',
    });

    const sequentialState = await client.query(
      `SELECT pathway.owning_clinician_uid,
              ARRAY_AGG(handoff.status ORDER BY handoff.requested_at, handoff.id) AS statuses
         FROM care_pathway_instances AS pathway
         JOIN care_handoff_instances AS handoff
           ON handoff.tenant_id = pathway.tenant_id
          AND handoff.sending_pathway_instance_id = pathway.id
        WHERE pathway.tenant_id = $1::uuid AND pathway.id = $2::uuid
        GROUP BY pathway.owning_clinician_uid`,
      [tenantId, fixture.pathwayId],
    );
    expect(sequentialState.rows[0]).toEqual({
      owning_clinician_uid: secondRecipientUid,
      statuses: ['accepted', 'accepted'],
    });
  });

  test('admits the exact transfer-recipient PHI audit source without dropping older values', async () => {
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
      'care_pathway_transfer_recipient',
      'care_pathway_transfer_decline_recipient',
      'care_pathway_role_queue_claimant',
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
    expect(inserted.rows.map((row) => row.access_source).sort())
      .toEqual([...allowedSources].sort());

    await expectStatementFailure(
      client,
      `INSERT INTO patient_access_audit_log
         (tenant_id, patient_uid, actor_uid, actor_role,
          access_decision, access_source)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'DOCTOR', 'allow',
               'care_pathway_transfer_recipient ')`,
      [tenantId, patientUid, actorUid],
      '23514',
      'patient_access_audit_log_access_source_check',
    );
  });
});
