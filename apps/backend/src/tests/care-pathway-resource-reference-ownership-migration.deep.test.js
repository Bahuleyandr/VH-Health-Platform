import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const DEFINITION_CHECKSUM = '5'.repeat(64);

function token() {
  return randomUUID().replaceAll('-', '');
}

async function seedUser(client, tenantId, role) {
  const uid = randomUUID();
  await client.query(
    `INSERT INTO users
       (uid, tenant_id, name, role, is_active, status, is_deleted, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::text, $4::text, TRUE, 'active', FALSE, NOW())`,
    [uid, tenantId, `S4 ${role} ${token()}`, role],
  );
  return uid;
}

async function seedFixture(client) {
  const tenantId = randomUUID();
  const pathwayKey = `s4_resource_ownership_${token()}`;
  await client.query(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2::text, 'S4 resource ownership test')`,
    [tenantId, `s4-resource-${token()}`],
  );
  const patientUid = await seedUser(client, tenantId, 'PATIENT');
  const ownerUid = await seedUser(client, tenantId, 'DOCTOR');
  const senderUid = await seedUser(client, tenantId, 'DOCTOR');
  const approverUid = await seedUser(client, tenantId, 'ADMIN');

  const definition = await client.query(
    `INSERT INTO workflow_definitions
       (tenant_id, workflow_key, version, display_name, steps, triggers, defaults)
     VALUES ($1::uuid, $2::text, 1, 'S4 resource ownership',
             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
     RETURNING id`,
    [tenantId, pathwayKey],
  );
  const definitionId = Number(definition.rows[0].id);
  const decidedAt = '2026-07-23T08:00:00.000Z';
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
      String(definitionId),
      JSON.stringify([{ uid: approverUid, at: decidedAt }]),
      approverUid,
      decidedAt,
      DEFINITION_CHECKSUM,
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
             '2026-07-23T08:01:00.000Z'::timestamptz,
             'staff_after_signoff', $6::text)
     RETURNING id`,
    [
      tenantId,
      definitionId,
      ownerUid,
      Number(approval.rows[0].id),
      approverUid,
      DEFINITION_CHECKSUM,
    ],
  );
  await client.query(
    `UPDATE workflow_definitions
        SET is_active = TRUE, updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::integer`,
    [tenantId, definitionId],
  );
  const run = await client.query(
    `INSERT INTO workflow_runs
       (tenant_id, workflow_definition_id, workflow_key, workflow_version,
        trigger_kind, pathway_governance_id, pathway_definition_checksum)
     VALUES ($1::uuid, $2::integer, $3::text, 1, 'manual', $4::uuid, $5::char(64))
     RETURNING id`,
    [
      tenantId,
      definitionId,
      pathwayKey,
      governance.rows[0].id,
      DEFINITION_CHECKSUM,
    ],
  );
  const runId = Number(run.rows[0].id);
  await client.query(
    `INSERT INTO workflow_steps
       (tenant_id, workflow_run_id, step_key, display_name, step_kind, ordering)
     VALUES ($1::uuid, $2::integer, 'review', 'Review', 'task', 1)`,
    [tenantId, runId],
  );
  const pathway = await client.query(
    `INSERT INTO care_pathway_instances
       (tenant_id, workflow_run_id, patient_uid, pathway_key, pathway_version,
        workflow_definition_id, definition_governance_id, definition_checksum,
        source_episode_type, source_episode_id, owning_clinician_uid,
        accountable_role, idempotency_key)
     VALUES ($1::uuid, $2::integer, $3::uuid, $4::text, 1,
             $5::integer, $6::uuid, $7::char(64),
             'appointment', '42', $8::uuid, 'DOCTOR', $9::text)
     RETURNING id`,
    [
      tenantId,
      runId,
      patientUid,
      pathwayKey,
      definitionId,
      governance.rows[0].id,
      DEFINITION_CHECKSUM,
      ownerUid,
      `s4-pathway-${token()}`,
    ],
  );
  return {
    tenantId,
    patientUid,
    ownerUid,
    senderUid,
    runId,
    pathwayId: pathway.rows[0].id,
  };
}

async function insertTask(
  client,
  fixture,
  resourceId,
  status = 'in_progress',
  { withCompletedAt = status === 'completed' } = {},
) {
  const task = await client.query(
    `INSERT INTO tasks
       (tenant_id, workflow_run_id, task_kind, title, patient_uid,
        related_resource_type, related_resource_id, status,
        assigned_to_uid, assigned_to_role, completed_at)
     VALUES ($1::uuid, $2::integer, 'review', 'Accept child work',
             $3::uuid, 'appointment', $4::text, $6::text,
             $5::uuid, NULL,
             CASE WHEN $7::boolean THEN NOW() ELSE NULL END)
     RETURNING id`,
    [
      fixture.tenantId,
      fixture.runId,
      fixture.patientUid,
      resourceId,
      fixture.ownerUid,
      status,
      withCompletedAt,
    ],
  );
  return Number(task.rows[0].id);
}

async function insertHandoff(client, fixture, resourceId) {
  const handoff = await client.query(
    `INSERT INTO care_handoff_instances
       (tenant_id, patient_uid, sending_pathway_instance_id,
        sending_workflow_run_id, sending_step_key, handoff_type,
        source_resource_type, source_resource_id, urgency_code,
        sender_uid, recipient_kind, intended_recipient_uid, status,
        requested_at, accepted_at, accepted_by_uid, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::integer, 'review',
             'child_resource_ownership', 'appointment', $5::text,
             'not_applicable', $6::uuid, 'user', $7::uuid, 'accepted',
             NOW() - INTERVAL '1 minute', NOW(), $7::uuid, $8::text)
     RETURNING id`,
    [
      fixture.tenantId,
      fixture.patientUid,
      fixture.pathwayId,
      fixture.runId,
      resourceId,
      fixture.senderUid,
      fixture.ownerUid,
      `s4-handoff-${token()}`,
    ],
  );
  return handoff.rows[0].id;
}

async function insertReference(client, fixture, {
  resourceId = '42',
  taskId = null,
  handoffId = null,
} = {}) {
  return client.query(
    `INSERT INTO care_pathway_resource_references
       (tenant_id, pathway_instance_id, patient_uid, resource_type,
        relationship_kind, evidence_state, resource_id, accepted_owner_uid,
        task_id, handoff_id, actor_system_key, occurred_at, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'appointment', 'child_action',
             'ownership_accepted', $4::text, $5::uuid, $6::integer, $7::uuid,
             's4.ownership.deep_test', NOW(), $8::text)
     RETURNING id`,
    [
      fixture.tenantId,
      fixture.pathwayId,
      fixture.patientUid,
      resourceId,
      fixture.ownerUid,
      taskId,
      handoffId,
      `s4-reference-${token()}`,
    ],
  );
}

async function expectReferenceFailure(client, fixture, input) {
  await client.query('SAVEPOINT expected_reference_failure');
  let failure;
  try {
    await insertReference(client, fixture, input);
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_reference_failure');
  expect(failure).toMatchObject({ code: '23514' });
  return failure;
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

describeIfDb('migration 595 accepted-ownership reference integrity', () => {
  let client;
  let fixture;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    fixture = await seedFixture(client);
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  afterAll(async () => {
    await client.end();
  });

  test('rejects a same-tenant task bound to another resource', async () => {
    const taskId = await insertTask(client, fixture, '99');
    const failure = await expectReferenceFailure(client, fixture, { taskId });
    expect(failure.message).toContain(
      'ownership evidence task must match pathway, patient, resource, assignee, and accepted status',
    );
  });

  test('accepts an exact same-pathway task ownership receipt', async () => {
    const taskId = await insertTask(client, fixture, '42', 'completed');
    const inserted = await insertReference(client, fixture, { taskId });
    expect(inserted.rows).toHaveLength(1);
  });

  test.each(['in_progress', 'blocked', 'overdue'])(
    'rejects exact ownership task evidence while task status is %s',
    async (status) => {
      const taskId = await insertTask(client, fixture, '42', status);
      const failure = await expectReferenceFailure(client, fixture, { taskId });
      expect(failure.message).toContain(
        'ownership evidence task must match pathway, patient, resource, assignee, and accepted status',
      );
    },
  );

  test('rejects completed ownership task evidence without completion time', async () => {
    const taskId = await insertTask(
      client,
      fixture,
      '42',
      'completed',
      { withCompletedAt: false },
    );
    const failure = await expectReferenceFailure(client, fixture, { taskId });
    expect(failure.message).toContain(
      'ownership evidence task must match pathway, patient, resource, assignee, and accepted status',
    );
  });

  test('rejects a same-tenant accepted handoff bound to another resource', async () => {
    const handoffId = await insertHandoff(client, fixture, '99');
    const failure = await expectReferenceFailure(client, fixture, { handoffId });
    expect(failure.message).toContain(
      'ownership evidence handoff must match pathway, patient, resource, recipient, and accepted status',
    );
  });

  test('accepts an exact same-pathway accepted handoff ownership receipt', async () => {
    const handoffId = await insertHandoff(client, fixture, '42');
    const inserted = await insertReference(client, fixture, { handoffId });
    expect(inserted.rows).toHaveLength(1);
  });

  test('rejects mutation and deletion of accepted ownership evidence', async () => {
    const taskId = await insertTask(client, fixture, '42', 'completed');
    const inserted = await insertReference(client, fixture, { taskId });
    const referenceId = inserted.rows[0].id;
    await expectStatementFailure(
      client,
      `UPDATE care_pathway_resource_references
          SET metadata = '{"forged":true}'::jsonb
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid`,
      [fixture.tenantId, referenceId],
      'P0001',
      'care_pathway_resource_references is append-only',
    );
    await expectStatementFailure(
      client,
      `DELETE FROM care_pathway_resource_references
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid`,
      [fixture.tenantId, referenceId],
      'P0001',
      'care_pathway_resource_references is append-only',
    );
    await expectStatementFailure(
      client,
      `DELETE FROM tasks
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      [fixture.tenantId, taskId],
      '23503',
      'fk_care_pathway_resource_references_task',
    );
  });
});
