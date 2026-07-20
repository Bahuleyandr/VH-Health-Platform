import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

import {
  CLINICAL_STAFF_ROUTE_ROLES,
  COLD_CHAIN_ROUTE_ROLES,
} from '../config/routeRolePolicy.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const SPINE_TABLES = [
  'care_pathway_instances',
  'care_pathway_transition_events',
  'care_handoff_instances',
  'care_pathway_definition_governance',
];

const MIGRATION_580_FOREIGN_KEYS = [
  'fk_workflow_runs_definition_identity',
  'fk_workflow_runs_current_step',
  'fk_tasks_workflow_step_same_run',
  'fk_tasks_parent_same_run',
  'fk_approvals_task_same_run',
  'fk_tasks_workflow_sla_tenant',
  'fk_approvals_workflow_step_tenant',
  'fk_approvals_workflow_step_same_run',
  'fk_approvals_created_by_tenant',
  'fk_approvals_decided_by_tenant',
  'fk_care_pathway_instances_tenant',
  'fk_care_pathway_instances_run_identity',
  'fk_care_pathway_instances_patient_tenant',
  'fk_care_pathway_instances_encounter_patient',
  'fk_care_pathway_instances_created_by_tenant',
  'fk_care_pathway_instances_updated_by_tenant',
  'fk_care_pathway_instances_parent_patient',
  'fk_care_pathway_instances_owner_tenant',
  'fk_care_pathway_instances_team_patient',
  'fk_care_pathway_governance_tenant',
  'fk_care_pathway_governance_definition',
  'fk_care_pathway_governance_approval',
  'fk_care_pathway_governance_clinical_owner',
  'fk_care_pathway_governance_operational_owner',
  'fk_care_pathway_governance_approved_by',
  'fk_care_handoff_tenant',
  'fk_care_handoff_sending_instance',
  'fk_care_handoff_sending_step',
  'fk_care_handoff_receiving_instance',
  'fk_care_handoff_receiving_step',
  'fk_care_handoff_task_tenant',
  'fk_care_handoff_sender_tenant',
  'fk_care_handoff_recipient_tenant',
  'fk_care_handoff_team_patient',
  'fk_care_pathway_transition_tenant',
  'fk_care_pathway_transition_instance',
  'fk_care_pathway_transition_step',
  'fk_care_pathway_transition_sla',
  'fk_care_pathway_transition_timeline',
  'fk_care_pathway_transition_audit',
  'fk_care_pathway_transition_actor',
];

const APPROVAL_KIND = 'care_pathway_definition_governance';
const APPROVAL_SUBJECT_TYPE = 'care_pathway_definition';
const CHECKSUM = 'a'.repeat(64);

function token() {
  return randomUUID().replaceAll('-', '');
}

function uuidV7() {
  const entropy = token();
  return `${entropy.slice(0, 8)}-${entropy.slice(8, 12)}-7${entropy.slice(13, 16)}`
    + `-8${entropy.slice(17, 20)}-${entropy.slice(20, 32)}`;
}

async function expectStatementFailure(client, statement, params, expectedCode, message) {
  await client.query('SAVEPOINT expected_failure');
  let failure;
  try {
    await client.query(statement, params);
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_failure');
  expect(failure).toMatchObject({ code: expectedCode });
  if (message) expect(failure.message).toContain(message);
}

async function expectDeferredTaskSlaFailure(client, statement, params, message) {
  await client.query('SAVEPOINT expected_deferred_failure');
  await client.query(statement, params);
  let failure;
  try {
    await client.query('SET CONSTRAINTS trg_tasks_sla_source_binding IMMEDIATE');
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_deferred_failure');
  expect(failure).toMatchObject({ code: '23514' });
  expect(failure.message).toContain(message);
}

async function expectDeferredCompletionReceiptFailure(client, statement, params, message) {
  await client.query('SAVEPOINT expected_completion_receipt_failure');
  await client.query(statement, params);
  let failure;
  try {
    await client.query('SET CONSTRAINTS trg_tasks_sla_completion_receipt IMMEDIATE');
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_completion_receipt_failure');
  expect(failure).toMatchObject({ code: '23514' });
  expect(failure.message).toContain(message);
}

async function expectDeferredConstraintFailure(
  client,
  { statement, params = [], constraint, code = '23514', message },
) {
  await client.query('SAVEPOINT expected_deferred_constraint_failure');
  await client.query(statement, params);
  let failure;
  try {
    await client.query(`SET CONSTRAINTS ${constraint} IMMEDIATE`);
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_deferred_constraint_failure');
  expect(failure).toMatchObject({ code });
  if (message) expect(failure.message).toContain(message);
}

async function waitForBackendLock(observer, processId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await observer.query(
      `SELECT wait_event_type
         FROM pg_stat_activity
        WHERE pid = $1::integer`,
      [processId],
    );
    if (result.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`PostgreSQL backend ${processId} did not reach a lock wait`);
}

async function beginConcurrent(connection) {
  await connection.query('BEGIN');
  await connection.query("SET LOCAL app.current_tenant_id = 'bypass'");
  await connection.query("SET LOCAL lock_timeout = '5s'");
  await connection.query("SET LOCAL statement_timeout = '10s'");
}

async function captureFailure(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

function expectOppositeFenceContention(outcomes) {
  const failures = outcomes.filter((outcome) => outcome !== null);
  // The first aborted transaction may release its xact fence before the peer
  // reaches PostgreSQL, so one peer may legitimately become the winner.
  expect(failures.length).toBeGreaterThanOrEqual(1);
  for (const failure of failures) {
    expect(failure).toMatchObject({ code: '40001' });
    expect(failure.code).not.toBe('40P01');
    expect(failure.message).toContain('serialization fence is busy');
  }
}

async function seedTenant(client) {
  const tenantId = randomUUID();
  await client.query(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2::text, $3::text)`,
    [tenantId, `pathway-${token()}`, 'Care Pathway Test Tenant'],
  );
  return tenantId;
}

async function seedUser(client, tenantId, role = 'DOCTOR', uid = randomUUID()) {
  await client.query(
    `INSERT INTO users (uid, tenant_id, name, role, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::text, $4::text, NOW())`,
    [uid, tenantId, `Pathway ${role}`, role],
  );
  return uid;
}

async function seedDefinition(client, tenantId) {
  const workflowKey = `pathway_${token()}`;
  const result = await client.query(
    `INSERT INTO workflow_definitions
       (tenant_id, workflow_key, version, display_name, steps, triggers, defaults)
     VALUES ($1::uuid, $2::text, 1, 'Pathway definition', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
     RETURNING id, workflow_key, version`,
    [tenantId, workflowKey],
  );
  return result.rows[0];
}

async function seedRun(client, tenantId, definition, {
  governanceId = null,
  definitionChecksum = null,
} = {}) {
  const result = await client.query(
    `INSERT INTO workflow_runs
       (tenant_id, workflow_definition_id, workflow_key, workflow_version, trigger_kind,
        pathway_governance_id, pathway_definition_checksum)
     VALUES ($1::uuid, $2::integer, $3::text, $4::integer, 'manual',
             $5::uuid, $6::char(64))
     RETURNING id`,
    [
      tenantId,
      definition.id,
      definition.workflow_key,
      definition.version,
      governanceId,
      definitionChecksum,
    ],
  );
  return result.rows[0].id;
}

async function seedCanonicalEvidence(client, tenantId, patientUid) {
  const timeline = await client.query(
    `INSERT INTO clinical_timeline_events
       (tenant_id, patient_uid, event_type, occurred_at, idempotency_key)
     VALUES ($1::uuid, $2::uuid, 'care_pathway_test', NOW(), $3::text)
     RETURNING id`,
    [tenantId, patientUid, `timeline-${token()}`],
  );
  const audit = await client.query(
    `INSERT INTO clinical_audit_events
       (tenant_id, patient_uid, action, action_status, occurred_at, metadata)
     VALUES ($1::uuid, $2::uuid, 'care_pathway_test', 'success', NOW(), '{}'::jsonb)
     RETURNING id`,
    [tenantId, patientUid],
  );
  return {
    timelineId: timeline.rows[0].id,
    auditId: audit.rows[0].id,
  };
}

async function seedDeathRecord(client, tenantId, patientUid) {
  const result = await client.query(
    `INSERT INTO death_records
       (tenant_id, patient_uid, date_of_death, time_of_death, cause_part_1a)
     VALUES ($1::uuid, $2::uuid, CURRENT_DATE, LOCALTIME, 'Test fixture')
     RETURNING id`,
    [tenantId, patientUid],
  );
  return result.rows[0].id;
}

async function seedValidApproval(client, {
  tenantId,
  definitionId,
  approverUid,
}) {
  const decidedAt = new Date('2026-07-19T08:00:00.000Z');
  const result = await client.query(
    `INSERT INTO approvals
       (tenant_id, approval_kind, subject_resource_type, subject_resource_id,
         required_approvers, status, approved_by, decided_by, decided_at, metadata)
      VALUES ($1::uuid, $2::text, $3::text, $4::text,
              1, 'approved', $5::jsonb, $6::uuid, $7::timestamptz,
              jsonb_build_object(
                'care_pathway_definition_governance',
                jsonb_build_object('definition_checksum', $8::text)
              ))
     RETURNING id`,
    [
      tenantId,
      APPROVAL_KIND,
      APPROVAL_SUBJECT_TYPE,
      String(definitionId),
      JSON.stringify([{ uid: approverUid, at: decidedAt.toISOString() }]),
      approverUid,
      decidedAt,
      CHECKSUM,
    ],
  );
  return { id: result.rows[0].id, decidedAt };
}

async function insertGovernance(client, {
  tenantId,
  definitionId,
  ownerUid,
  approverUid,
  approvalId,
  approvedAt = new Date('2026-07-19T08:01:00.000Z'),
  status = 'approved',
}) {
  const result = await client.query(
    `INSERT INTO care_pathway_definition_governance
       (tenant_id, workflow_definition_id, clinical_owner_uid, operational_owner_uid,
        governance_status, approval_id, approved_by, approved_at,
        patient_visibility_policy_ref, definition_checksum)
     VALUES ($1::uuid, $2::integer, $3::uuid, $3::uuid,
             $4::text, $5::integer, $6::uuid, $7::timestamptz,
             'staff_after_signoff', $8::text)
     RETURNING id`,
    [tenantId, definitionId, ownerUid, status, approvalId, approverUid, approvedAt, CHECKSUM],
  );
  return result.rows[0].id;
}

async function seedValidGovernance(client) {
  const tenantId = await seedTenant(client);
  const ownerUid = await seedUser(client, tenantId);
  const approverUid = await seedUser(client, tenantId, 'ADMIN');
  const definition = await seedDefinition(client, tenantId);
  const approval = await seedValidApproval(client, {
    tenantId,
    definitionId: definition.id,
    approverUid,
  });
  const governanceId = await insertGovernance(client, {
    tenantId,
    definitionId: definition.id,
    ownerUid,
    approverUid,
    approvalId: approval.id,
  });
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  return {
    tenantId,
    ownerUid,
    approverUid,
    definition,
    approval,
    governanceId,
  };
}

async function seedPublicationFixture(client) {
  const tenantId = await seedTenant(client);
  const ownerUid = await seedUser(client, tenantId);
  const approverUid = await seedUser(client, tenantId, 'ADMIN');
  const voterUid = await seedUser(client, tenantId, 'DOCTOR');
  const definition = await seedDefinition(client, tenantId);
  const decidedAt = new Date('2026-07-19T08:00:00.000Z');
  const approval = await client.query(
    `INSERT INTO approvals
       (tenant_id, approval_kind, subject_resource_type, subject_resource_id,
        required_approvers, status, approved_by, decided_by, decided_at, metadata)
     VALUES ($1::uuid, $2::text, $3::text, $4::text,
             2, 'approved', $5::jsonb, $6::uuid, $7::timestamptz,
             jsonb_build_object(
               'care_pathway_definition_governance',
               jsonb_build_object('definition_checksum', $8::text)
             ))
     RETURNING id`,
    [
      tenantId,
      APPROVAL_KIND,
      APPROVAL_SUBJECT_TYPE,
      String(definition.id),
      JSON.stringify([
        { uid: approverUid, at: decidedAt.toISOString() },
        { uid: voterUid, at: decidedAt.toISOString() },
      ]),
      approverUid,
      decidedAt,
      CHECKSUM,
    ],
  );
  return {
    tenantId,
    ownerUid,
    approverUid,
    voterUid,
    definition,
    approval: { id: approval.rows[0].id, decidedAt },
  };
}

async function publishFixtureGovernance(client, fixture) {
  return insertGovernance(client, {
    tenantId: fixture.tenantId,
    definitionId: fixture.definition.id,
    ownerUid: fixture.ownerUid,
    approverUid: fixture.approverUid,
    approvalId: fixture.approval.id,
  });
}

async function retireFixtureGovernance(client, fixture, retirementActorUid) {
  const retiredAt = new Date('2026-07-19T09:00:00.000Z');
  await client.query(
    `UPDATE care_pathway_definition_governance
        SET governance_status = 'retired',
            retired_by = $1::uuid,
            retired_at = $2::timestamptz,
            retirement_reason = 'concurrent retirement test',
            effective_until = $2::timestamptz,
            updated_at = NOW()
      WHERE tenant_id = $3::uuid AND id = $4::uuid`,
    [retirementActorUid, retiredAt, fixture.tenantId, fixture.governanceId],
  );
}

async function seedPinnedPathwayRuntime(client, fixture, {
  patientUid = null,
  encounterId = null,
  activateDefinition = true,
} = {}) {
  const patient = patientUid || await seedUser(client, fixture.tenantId, 'PATIENT');
  if (activateDefinition) {
    await client.query(
      `UPDATE workflow_definitions
          SET is_active = TRUE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.definition.id],
    );
  }
  const idempotencyKey = `pathway-start-${token()}`;
  const sourceEpisodeId = `episode-${token()}`;
  const runId = await seedRun(client, fixture.tenantId, fixture.definition, {
    governanceId: fixture.governanceId,
    definitionChecksum: CHECKSUM,
  });
  const instance = await client.query(
    `INSERT INTO care_pathway_instances
       (tenant_id, workflow_run_id, patient_uid, encounter_id,
        pathway_key, pathway_version, workflow_definition_id,
        definition_governance_id, definition_checksum,
        source_episode_type, source_episode_id, accountable_role, idempotency_key)
     VALUES ($1::uuid, $2::integer, $3::uuid, $4::uuid,
             $5::text, $6::integer, $7::integer,
             $8::uuid, $9::char(64),
             'test_episode', $10::text, 'DOCTOR', $11::text)
     RETURNING id`,
    [
      fixture.tenantId,
      runId,
      patient,
      encounterId,
      fixture.definition.workflow_key,
      fixture.definition.version,
      fixture.definition.id,
      fixture.governanceId,
      CHECKSUM,
      sourceEpisodeId,
      idempotencyKey,
    ],
  );

  const instanceId = instance.rows[0].id;
  const eventId = randomUUID();
  const timelineId = randomUUID();
  const auditId = randomUUID();
  const occurredAt = new Date('2026-07-19T08:02:00.000Z');
  const commandFingerprint = 'b'.repeat(64);
  const eventPayload = {
    event_id: eventId,
    tenant_id: fixture.tenantId,
    pathway_instance_id: instanceId,
    patient_uid: patient,
    encounter_id: encounterId,
    workflow_run_id: runId,
    workflow_step_id: null,
    sequence_number: 1,
    transition_scope: 'pathway',
    transition_key: 'pathway_instance_created',
    stage_key: null,
    source_resource_type: 'test_episode',
    source_resource_id: sourceEpisodeId,
    workflow_sla_instance_id: null,
    actor_uid: null,
    system_actor_key: 'test_harness.v1',
    actor_role: null,
    occurred_at: occurredAt.toISOString(),
    idempotency_key: idempotencyKey,
    command_fingerprint: commandFingerprint,
    effect_ordinal: 0,
    workflow_definition_id: fixture.definition.id,
    governance_id: fixture.governanceId,
    definition_checksum: CHECKSUM,
  };
  const metadata = {
    pathway_runtime: { definition_checksum: CHECKSUM },
    command_fingerprint: commandFingerprint,
    effect_ordinal: 0,
    provenance: { kind: 'system', system_key: 'test_harness.v1' },
  };
  const previousState = {};
  const newState = { clinical_status: 'planned', run_status: 'started' };
  await client.query(
    `INSERT INTO clinical_timeline_events
       (id, tenant_id, patient_uid, encounter_id, event_type, event_status,
        source_table, source_id, source_uid, resource_type, resource_id,
        occurred_at, visible_to_patient, clinical_summary, payload, tags,
        idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
             'care_pathway.transition', 'pathway',
             'care_pathway_transition_events', $5::text, $5::uuid,
             'care_pathway_transition_event', $5::text,
             $6::timestamptz, FALSE, 'Care pathway transition recorded',
             $7::jsonb, ARRAY['care_pathway', $8::text, 'pathway']::text[],
             $9::text)`,
    [
      timelineId,
      fixture.tenantId,
      patient,
      encounterId,
      eventId,
      occurredAt,
      JSON.stringify(eventPayload),
      fixture.definition.workflow_key,
      `care_pathway_transition_events:${eventId}:timeline`,
    ],
  );
  await client.query(
    `INSERT INTO clinical_audit_events
       (id, tenant_id, patient_uid, encounter_id, action, action_status,
        resource_type, resource_table, resource_id, before_state, after_state,
        metadata, idempotency_key, occurred_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
             'care_pathway.transition', 'success',
             'care_pathway_transition_event', 'care_pathway_transition_events', $5::text,
             $6::jsonb, $7::jsonb, $8::jsonb, $9::text, $10::timestamptz)`,
    [
      auditId,
      fixture.tenantId,
      patient,
      encounterId,
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
             $6::jsonb, $7::jsonb, 'test_episode', $8::text,
             'test_harness.v1', $9::timestamptz, $10::text,
             $11::char(64), 0, $12::uuid, $13::uuid,
             $14::jsonb, $15::jsonb)`,
    [
      eventId,
      fixture.tenantId,
      instanceId,
      patient,
      runId,
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
    patientUid: patient,
    runId,
    instanceId,
    eventId,
    timelineId,
    auditId,
    idempotencyKey,
  };
}

async function seedPendingCanonicalCreationParents(client, fixture, {
  eventId = randomUUID(),
} = {}) {
  const patientUid = await seedUser(client, fixture.tenantId, 'PATIENT');
  const runSequence = await client.query(
    `SELECT nextval(pg_get_serial_sequence('workflow_runs', 'id'))::integer AS id`,
  );
  const runId = runSequence.rows[0].id;
  const instanceId = randomUUID();
  const timelineId = randomUUID();
  const auditId = randomUUID();
  const idempotencyKey = `pathway-start-${token()}`;
  const sourceEpisodeId = `episode-${token()}`;
  const occurredAt = new Date('2026-07-19T08:02:00.000Z');
  const commandFingerprint = 'b'.repeat(64);
  const previousState = {};
  const newState = { clinical_status: 'planned', run_status: 'started' };
  const eventPayload = {
    event_id: eventId,
    tenant_id: fixture.tenantId,
    pathway_instance_id: instanceId,
    patient_uid: patientUid,
    encounter_id: null,
    workflow_run_id: runId,
    workflow_step_id: null,
    sequence_number: 1,
    transition_scope: 'pathway',
    transition_key: 'pathway_instance_created',
    stage_key: null,
    source_resource_type: 'test_episode',
    source_resource_id: sourceEpisodeId,
    workflow_sla_instance_id: null,
    actor_uid: null,
    system_actor_key: 'test_harness.v1',
    actor_role: null,
    occurred_at: occurredAt.toISOString(),
    idempotency_key: idempotencyKey,
    command_fingerprint: commandFingerprint,
    effect_ordinal: 0,
    workflow_definition_id: fixture.definition.id,
    governance_id: fixture.governanceId,
    definition_checksum: CHECKSUM,
  };
  const metadata = {
    pathway_runtime: { definition_checksum: CHECKSUM },
    command_fingerprint: commandFingerprint,
    effect_ordinal: 0,
    provenance: { kind: 'system', system_key: 'test_harness.v1' },
  };
  await client.query(
    `INSERT INTO clinical_timeline_events
       (id, tenant_id, patient_uid, event_type, event_status,
        source_table, source_id, source_uid, resource_type, resource_id,
        occurred_at, visible_to_patient, clinical_summary, payload, tags,
        idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'care_pathway.transition', 'pathway',
             'care_pathway_transition_events', $4::text, $4::uuid,
             'care_pathway_transition_event', $4::text,
             $5::timestamptz, FALSE, 'Care pathway transition recorded',
             $6::jsonb, ARRAY['care_pathway', $7::text, 'pathway']::text[],
             $8::text)`,
    [
      timelineId,
      fixture.tenantId,
      patientUid,
      eventId,
      occurredAt,
      JSON.stringify(eventPayload),
      fixture.definition.workflow_key,
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
      fixture.tenantId,
      patientUid,
      eventId,
      JSON.stringify(previousState),
      JSON.stringify(newState),
      JSON.stringify(metadata),
      `care_pathway_transition_events:${eventId}:audit`,
      occurredAt,
    ],
  );
  return {
    patientUid,
    runId,
    instanceId,
    eventId,
    timelineId,
    auditId,
    idempotencyKey,
    sourceEpisodeId,
    occurredAt,
    commandFingerprint,
    previousState,
    newState,
    eventPayload,
    metadata,
  };
}

async function insertPendingPinnedRuntime(client, fixture, pending) {
  await client.query(
    `INSERT INTO workflow_runs
       (id, tenant_id, workflow_definition_id, workflow_key, workflow_version,
        trigger_kind, pathway_governance_id, pathway_definition_checksum)
     VALUES ($1::integer, $2::uuid, $3::integer, $4::text, $5::integer,
             'manual', $6::uuid, $7::char(64))`,
    [
      pending.runId,
      fixture.tenantId,
      fixture.definition.id,
      fixture.definition.workflow_key,
      fixture.definition.version,
      fixture.governanceId,
      CHECKSUM,
    ],
  );
  await client.query(
    `INSERT INTO care_pathway_instances
       (id, tenant_id, workflow_run_id, patient_uid,
        pathway_key, pathway_version, workflow_definition_id,
        definition_governance_id, definition_checksum,
        source_episode_type, source_episode_id, accountable_role, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::integer, $4::uuid,
             $5::text, $6::integer, $7::integer,
             $8::uuid, $9::char(64),
             'test_episode', $10::text, 'DOCTOR', $11::text)`,
    [
      pending.instanceId,
      fixture.tenantId,
      pending.runId,
      pending.patientUid,
      fixture.definition.workflow_key,
      fixture.definition.version,
      fixture.definition.id,
      fixture.governanceId,
      CHECKSUM,
      pending.sourceEpisodeId,
      pending.idempotencyKey,
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
             $6::jsonb, $7::jsonb, 'test_episode', $8::text,
             'test_harness.v1', $9::timestamptz, $10::text,
             $11::char(64), 0, $12::uuid, $13::uuid,
             $14::jsonb, $15::jsonb)`,
    [
      pending.eventId,
      fixture.tenantId,
      pending.instanceId,
      pending.patientUid,
      pending.runId,
      JSON.stringify(pending.previousState),
      JSON.stringify(pending.newState),
      pending.sourceEpisodeId,
      pending.occurredAt,
      pending.idempotencyKey,
      pending.commandFingerprint,
      pending.timelineId,
      pending.auditId,
      JSON.stringify(pending.eventPayload),
      JSON.stringify(pending.metadata),
    ],
  );
}

describeIfDb('care pathway execution-spine schema conformance (PostgreSQL)', () => {
  let client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query("SET LOCAL app.current_tenant_id = 'bypass'");
  });

  afterEach(async () => {
    await client.query('ROLLBACK').catch(() => {});
  });

  afterAll(async () => {
    await client.end();
  });

  test('creates all four spine tables with forced tenant RLS', async () => {
    const result = await client.query(
      `SELECT table_class.relname AS table_name,
              table_class.relrowsecurity,
              table_class.relforcerowsecurity,
              COUNT(policy.policyname)::integer AS policy_count
         FROM pg_class AS table_class
         JOIN pg_namespace AS namespace ON namespace.oid = table_class.relnamespace
         LEFT JOIN pg_policies AS policy
           ON policy.schemaname = namespace.nspname
          AND policy.tablename = table_class.relname
          AND policy.policyname = 'tenant_isolation'
        WHERE namespace.nspname = 'public'
          AND table_class.relname = ANY($1::text[])
        GROUP BY table_class.relname, table_class.relrowsecurity, table_class.relforcerowsecurity
        ORDER BY table_class.relname`,
      [SPINE_TABLES],
    );

    expect(result.rows).toHaveLength(SPINE_TABLES.length);
    expect(result.rows.every((row) => (
      row.relrowsecurity === true
      && row.relforcerowsecurity === true
      && row.policy_count === 1
    ))).toBe(true);
  });

  test('keeps database task-owner roles identical to the servicing route policies', async () => {
    const result = await client.query(
      `SELECT care_pathway_route_actionable_roles('critical_result_ack') AS clinical,
              care_pathway_route_actionable_roles('cold_chain_excursion_ack') AS cold_chain`,
    );

    expect(result.rows[0].clinical).toEqual(CLINICAL_STAFF_ROUTE_ROLES);
    expect(result.rows[0].cold_chain).toEqual(COLD_CHAIN_ROUTE_ROLES);
  });

  test('provides a tenant-leading child index for every migration 580 foreign key', async () => {
    const foreignKeys = await client.query(
      `SELECT constraint_row.conname,
              child.relname AS child_table,
              ARRAY_AGG(attribute.attname::text ORDER BY key_column.ordinality) AS child_columns
         FROM pg_constraint AS constraint_row
         JOIN pg_class AS child ON child.oid = constraint_row.conrelid
         CROSS JOIN LATERAL UNNEST(constraint_row.conkey)
           WITH ORDINALITY AS key_column(attnum, ordinality)
         JOIN pg_attribute AS attribute
           ON attribute.attrelid = constraint_row.conrelid
          AND attribute.attnum = key_column.attnum
        WHERE constraint_row.contype = 'f'
          AND constraint_row.conname = ANY($1::text[])
        GROUP BY constraint_row.conname, child.relname, constraint_row.conrelid
        ORDER BY constraint_row.conname`,
      [MIGRATION_580_FOREIGN_KEYS],
    );
    expect(foreignKeys.rows).toHaveLength(MIGRATION_580_FOREIGN_KEYS.length);

    const childTables = [...new Set(foreignKeys.rows.map((row) => row.child_table))];
    const indexes = await client.query(
      `SELECT child.relname AS child_table,
              index_class.relname AS index_name,
              ARRAY(
                SELECT attribute.attname::text
                  FROM UNNEST(index_row.indkey::smallint[])
                    WITH ORDINALITY AS index_column(attnum, ordinality)
                  JOIN pg_attribute AS attribute
                    ON attribute.attrelid = index_row.indrelid
                   AND attribute.attnum = index_column.attnum
                 WHERE index_column.attnum > 0
                   AND index_column.ordinality <= index_row.indnkeyatts
                 ORDER BY index_column.ordinality
              ) AS index_columns
         FROM pg_index AS index_row
         JOIN pg_class AS child ON child.oid = index_row.indrelid
         JOIN pg_class AS index_class ON index_class.oid = index_row.indexrelid
        WHERE child.relname = ANY($1::text[])
          AND index_row.indisvalid`,
      [childTables],
    );

    for (const foreignKey of foreignKeys.rows) {
      expect(foreignKey.child_columns[0]).toBe('tenant_id');
      const coveringIndex = indexes.rows.find((index) => (
        index.child_table === foreignKey.child_table
        && foreignKey.child_columns.every(
          (column, position) => index.index_columns[position] === column,
        )
      ));
      expect({
        constraint: foreignKey.conname,
        childColumns: foreignKey.child_columns,
        coveringIndex: coveringIndex?.index_name,
      }).toEqual(expect.objectContaining({ coveringIndex: expect.any(String) }));
    }
  });

  test('keeps the typed task/SLA foreign key on delete restrict', async () => {
    const result = await client.query(
      `SELECT constraint_row.confdeltype,
              pg_get_constraintdef(constraint_row.oid) AS definition
         FROM pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = 'tasks'::regclass
          AND constraint_row.conname = 'fk_tasks_workflow_sla_tenant'`,
    );

    expect(result.rows).toEqual([
      expect.objectContaining({
        confdeltype: 'r',
        definition: expect.stringContaining('ON DELETE RESTRICT'),
      }),
    ]);
  });

  test('keeps the users tenant default GUC-aware in the forward migration', async () => {
    const result = await client.query(
      `SELECT pg_get_expr(attribute_default.adbin, attribute_default.adrelid) AS default_sql
         FROM pg_attrdef AS attribute_default
         JOIN pg_class AS table_class
           ON table_class.oid = attribute_default.adrelid
         JOIN pg_attribute AS attribute
           ON attribute.attrelid = table_class.oid
          AND attribute.attnum = attribute_default.adnum
        WHERE table_class.relname = 'users'
          AND attribute.attname = 'tenant_id'`,
    );

    expect(result.rows).toEqual([
      expect.objectContaining({
        default_sql: expect.stringContaining("current_setting('app.current_tenant_id'"),
      }),
    ]);
  });

  test('closes nullable same-run bypasses while retaining generic task parent chains', async () => {
    const tenantId = await seedTenant(client);
    const definition = await seedDefinition(client, tenantId);
    const runId = await seedRun(client, tenantId, definition);
    const step = await client.query(
      `INSERT INTO workflow_steps
         (tenant_id, workflow_run_id, step_key, step_kind, ordering)
       VALUES ($1::uuid, $2::integer, 'review', 'task', 1)
       RETURNING id`,
      [tenantId, runId],
    );
    const secondStep = await client.query(
      `INSERT INTO workflow_steps
         (tenant_id, workflow_run_id, step_key, step_kind, ordering)
       VALUES ($1::uuid, $2::integer, 'escalate', 'task', 2)
       RETURNING id`,
      [tenantId, runId],
    );
    await client.query(
      `UPDATE workflow_steps SET status = 'in_progress'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, step.rows[0].id],
    );
    await expectStatementFailure(
      client,
      `UPDATE workflow_steps SET status = 'blocked'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, secondStep.rows[0].id],
      '23505',
      'ux_workflow_steps_one_current',
    );
    const task = await client.query(
      `INSERT INTO tasks (tenant_id, workflow_run_id, task_kind, title)
       VALUES ($1::uuid, $2::integer, 'pathway_stage', 'Parent task')
       RETURNING id`,
      [tenantId, runId],
    );

    await expectStatementFailure(
      client,
      `INSERT INTO tasks (tenant_id, workflow_step_id, task_kind, title)
       VALUES ($1::uuid, $2::integer, 'pathway_stage', 'Missing run')`,
      [tenantId, step.rows[0].id],
      '23514',
    );
    await expectStatementFailure(
      client,
      `INSERT INTO approvals
         (tenant_id, workflow_step_id, approval_kind)
       VALUES ($1::uuid, $2::integer, 'pathway_gate')`,
      [tenantId, step.rows[0].id],
      '23514',
    );
    await expectStatementFailure(
      client,
      `INSERT INTO approvals (tenant_id, task_id, approval_kind)
       VALUES ($1::uuid, $2::integer, 'pathway_gate')`,
      [tenantId, task.rows[0].id],
      '23514',
    );
    await expectStatementFailure(
      client,
      `INSERT INTO tasks (tenant_id, parent_task_id, task_kind, title)
       VALUES ($1::uuid, $2::integer, 'generic', 'Mismatched child')`,
      [tenantId, task.rows[0].id],
      '23503',
      'parent and child task workflow runs must match',
    );

    const genericParent = await client.query(
      `INSERT INTO tasks (tenant_id, task_kind, title)
       VALUES ($1::uuid, 'generic', 'Generic parent')
       RETURNING id`,
      [tenantId],
    );
    const genericChild = await client.query(
      `INSERT INTO tasks (tenant_id, parent_task_id, task_kind, title)
       VALUES ($1::uuid, $2::integer, 'generic', 'Generic child')
       RETURNING id`,
      [tenantId, genericParent.rows[0].id],
    );
    expect(genericChild.rows[0].id).toEqual(expect.any(Number));
  });

  test.each([
    ['pathway workflow step', 'pathway'],
    ['critical result', 'critical'],
    ['cold-chain excursion', 'cold_chain'],
    ['mortuary death record', 'mortuary'],
  ])('rejects a direct task/SLA source mismatch for %s', async (_label, kind) => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    let workflowRunId = null;
    let workflowStepId = null;
    let ruleCode;
    let sourceTable;
    let sourceId;
    let resourceType;
    let resourceId;
    let semantics = 'acknowledgement';

    if (kind === 'pathway') {
      const definition = await seedDefinition(client, tenantId);
      workflowRunId = await seedRun(client, tenantId, definition);
      const step = await client.query(
        `INSERT INTO workflow_steps
           (tenant_id, workflow_run_id, step_key, step_kind, ordering)
         VALUES ($1::uuid, $2::integer, 'review', 'task', 1)
         RETURNING id`,
        [tenantId, workflowRunId],
      );
      workflowStepId = step.rows[0].id;
      ruleCode = 'pathway_custom_rule';
      sourceTable = 'workflow_steps';
      sourceId = String(workflowStepId + 10_000);
      resourceType = 'care_pathway_instance';
      resourceId = randomUUID();
    } else if (kind === 'critical') {
      ruleCode = 'critical_result_ack';
      sourceTable = 'lab_results';
      sourceId = 'result-b';
      resourceType = 'lab_results';
      resourceId = 'result-a';
    } else if (kind === 'cold_chain') {
      ruleCode = 'cold_chain_excursion_ack';
      sourceTable = 'cold_chain_excursions';
      sourceId = 'excursion-b';
      resourceType = 'cold_chain_excursions';
      resourceId = 'excursion-a';
    } else {
      const deathRecordId = await seedDeathRecord(client, tenantId, patientUid);
      ruleCode = 'mortuary_unclaimed_body';
      sourceTable = 'death_records';
      sourceId = String(deathRecordId + 10_000);
      resourceType = 'death_record';
      resourceId = String(deathRecordId);
      semantics = 'domain_evidence';
    }

    const sla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id, status, due_at, metadata)
       VALUES ($1::uuid, $2::text, $3::uuid, $4::text, $5::text,
               'active', NOW() + INTERVAL '1 hour',
               '{"task_materialization_contract":"application_atomic_v1"}'::jsonb)
       RETURNING id, due_at`,
      [tenantId, ruleCode, patientUid, sourceTable, sourceId],
    );
    await expectStatementFailure(
      client,
      `INSERT INTO tasks
         (tenant_id, workflow_run_id, workflow_step_id, task_kind, title,
          patient_uid, related_resource_type, related_resource_id,
          workflow_sla_instance_id, sla_completion_semantics, due_at)
       VALUES ($1::uuid, $2::integer, $3::integer, 'pathway_stage', 'Bound task',
               $4::uuid, $5::text, $6::text, $7::uuid, $8::text,
               (SELECT due_at FROM workflow_sla_instances WHERE id = $7::uuid))`,
      [
        tenantId,
        workflowRunId,
        workflowStepId,
        patientUid,
        resourceType,
        resourceId,
        sla.rows[0].id,
        semantics,
      ],
      '23514',
      'same obligation',
    );
  });

  test('revalidates task resource fields and SLA source mutations in both directions', async () => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const sla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id, status, due_at, metadata)
       VALUES ($1::uuid, 'critical_result_ack', $2::uuid,
               'lab_results', 'result-a', 'active', NOW() + INTERVAL '1 hour',
               '{"task_materialization_contract":"application_atomic_v1"}'::jsonb)
       RETURNING id, due_at`,
      [tenantId, patientUid],
    );
    const task = await client.query(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id,
          workflow_sla_instance_id, sla_completion_semantics, due_at,
          assigned_to_role)
       VALUES ($1::uuid, 'review', 'Critical result', $2::uuid,
               'lab_results', 'result-a', $3::uuid, 'acknowledgement',
               (SELECT due_at FROM workflow_sla_instances WHERE id = $3::uuid),
               'DUTY_DOCTOR')
       RETURNING id`,
      [tenantId, patientUid, sla.rows[0].id],
    );
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');

    await expectStatementFailure(
      client,
      `UPDATE tasks SET related_resource_id = 'result-b'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, task.rows[0].id],
      '23514',
      'same obligation',
    );
    await expectStatementFailure(
      client,
      `UPDATE workflow_sla_instances SET source_id = 'result-b'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, sla.rows[0].id],
      '23514',
      'human-action SLA',
    );
    await expectStatementFailure(
      client,
      `UPDATE workflow_sla_instances SET rule_code = 'unregistered_non_pathway_rule'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, sla.rows[0].id],
      '23514',
      'typed task SLA legacy aliases must equal the linked instance and rule',
    );
    await expectStatementFailure(
      client,
      `UPDATE tasks SET due_at = due_at + INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, task.rows[0].id],
      '23514',
      'incomplete human-action SLA requires exactly one owned actionable task',
    );
    await expectStatementFailure(
      client,
      `UPDATE workflow_sla_instances SET due_at = NULL
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, sla.rows[0].id],
      '23514',
      'workflow_sla_instances_due_or_targets_pending_chk',
    );
    await expectStatementFailure(
      client,
      `UPDATE workflow_sla_instances SET due_at = due_at + INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, sla.rows[0].id],
      '23514',
      'incomplete human-action SLA requires exactly one owned actionable task',
    );
  });

  test('keeps every incomplete named-owner obligation reachable as users change', async () => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const ownerUid = await seedUser(client, tenantId, 'DOCTOR');
    const sla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id,
          status, due_at, metadata)
       VALUES ($1::uuid, 'critical_result_ack', $2::uuid,
               'lab_results', 'named-owner-result', 'active',
               NOW() + INTERVAL '1 hour',
               '{"task_materialization_contract":"application_atomic_v1"}'::jsonb)
       RETURNING id, due_at`,
      [tenantId, patientUid],
    );
    const task = await client.query(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id,
          workflow_sla_instance_id, sla_completion_semantics, due_at,
          assigned_to_uid)
       SELECT $1::uuid, 'review', 'Named owner', $2::uuid,
              'lab_results', 'named-owner-result', sla.id,
              'acknowledgement', sla.due_at, $4::uuid
         FROM workflow_sla_instances AS sla
        WHERE sla.tenant_id = $1::uuid
          AND sla.id = $3::uuid
       RETURNING id`,
      [tenantId, patientUid, sla.rows[0].id, ownerUid],
    );
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');

    for (const [statement, params] of [
      [
        `UPDATE users SET is_active = FALSE, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
        [tenantId, ownerUid],
      ],
      [
        `UPDATE users SET role = 'PATIENT', updated_at = NOW()
          WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
        [tenantId, ownerUid],
      ],
      [
        'DELETE FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid',
        [tenantId, ownerUid],
      ],
    ]) {
      await expectStatementFailure(
        client,
        statement,
        params,
        '23514',
        'incomplete human-action SLA requires exactly one owned actionable task',
      );
    }

    await expectStatementFailure(
      client,
      `UPDATE tasks
          SET assigned_to_uid = NULL,
              assigned_to_role = NULL
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, task.rows[0].id],
      '23514',
      'incomplete human-action SLA requires exactly one owned actionable task',
    );

    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(
      `UPDATE tasks
          SET assigned_to_uid = NULL,
              assigned_to_role = 'DUTY_DOCTOR'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, task.rows[0].id],
    );
    await client.query(
      `UPDATE users SET is_active = FALSE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      [tenantId, ownerUid],
    );
    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
      command: 'SET',
    });
  });

  test('avoids the former task-to-SLA versus SLA-to-task deferred-trigger deadlock', async () => {
    const setup = new Client({ connectionString: databaseUrl });
    const slaWriter = new Client({ connectionString: databaseUrl });
    const pairDeleter = new Client({ connectionString: databaseUrl });
    const tenantId = randomUUID();
    const patientUid = randomUUID();
    const actorUid = randomUUID();
    const pairIds = [];

    await Promise.all([setup.connect(), slaWriter.connect(), pairDeleter.connect()]);

    async function begin(connection) {
      await connection.query('BEGIN');
      await connection.query("SET LOCAL app.current_tenant_id = 'bypass'");
      await connection.query("SET LOCAL lock_timeout = '5s'");
      await connection.query("SET LOCAL statement_timeout = '10s'");
    }

    async function createPair(sourceId) {
      await begin(setup);
      const sla = await setup.query(
        `INSERT INTO workflow_sla_instances
           (tenant_id, rule_code, patient_uid, source_table, source_id,
            status, due_at, metadata)
         VALUES ($1::uuid, 'critical_result_ack', $2::uuid,
                 'lab_results', $3::text, 'active', NOW() + INTERVAL '1 hour',
                 '{"task_materialization_contract":"application_atomic_v1"}'::jsonb)
         RETURNING id`,
        [tenantId, patientUid, sourceId],
      );
      const task = await setup.query(
        `INSERT INTO tasks
           (tenant_id, task_kind, title, patient_uid,
            related_resource_type, related_resource_id,
            workflow_sla_instance_id, sla_completion_semantics, due_at,
            assigned_to_role)
         SELECT $1::uuid, 'review', 'Concurrent obligation', $2::uuid,
                'lab_results', $3::text, sla.id, 'acknowledgement', sla.due_at,
                'DUTY_DOCTOR'
           FROM workflow_sla_instances AS sla
          WHERE sla.tenant_id = $1::uuid AND sla.id = $4::uuid
         RETURNING id`,
        [tenantId, patientUid, sourceId, sla.rows[0].id],
      );
      await setup.query('SET CONSTRAINTS ALL IMMEDIATE');
      await setup.query('COMMIT');
      const pair = { slaId: sla.rows[0].id, taskId: task.rows[0].id };
      pairIds.push(pair);
      return pair;
    }

    try {
      await begin(setup);
      await setup.query(
        `INSERT INTO tenants (id, slug, name)
         VALUES ($1::uuid, $2::text, 'Concurrent pathway tenant')`,
        [tenantId, `pathway-concurrency-${token()}`],
      );
      await setup.query(
        `INSERT INTO users (uid, tenant_id, name, role, updated_at)
         VALUES
           ($1::uuid, $3::uuid, 'Concurrent patient', 'PATIENT', NOW()),
           ($2::uuid, $3::uuid, 'Concurrent doctor', 'DOCTOR', NOW())`,
        [patientUid, actorUid, tenantId],
      );
      await setup.query('COMMIT');

      const pair = await createPair('deadlock-control');
      await begin(slaWriter);
      await slaWriter.query(
        `UPDATE workflow_sla_instances SET updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [tenantId, pair.slaId],
      );
      await begin(pairDeleter);
      await pairDeleter.query(
        'DELETE FROM tasks WHERE tenant_id = $1::uuid AND id = $2::integer',
        [tenantId, pair.taskId],
      );
      const blockedSlaDelete = pairDeleter.query(
        `DELETE FROM workflow_sla_instances
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [tenantId, pair.slaId],
      );
      await waitForBackendLock(client, pairDeleter.processID);

      await expect(slaWriter.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
        command: 'SET',
      });
      await slaWriter.query('COMMIT');
      await expect(blockedSlaDelete).resolves.toMatchObject({ rowCount: 1 });
      await pairDeleter.query('SET CONSTRAINTS ALL IMMEDIATE');
      await pairDeleter.query('COMMIT');

      const taskOnly = await createPair('task-only-delete');
      await begin(pairDeleter);
      await pairDeleter.query(
        'DELETE FROM tasks WHERE tenant_id = $1::uuid AND id = $2::integer',
        [tenantId, taskOnly.taskId],
      );
      await expect(
        pairDeleter.query('SET CONSTRAINTS trg_tasks_sla_completion_receipt IMMEDIATE'),
      ).rejects.toMatchObject({
        code: '23514',
        message: expect.stringContaining('cannot be deleted while its SLA obligation survives'),
      });
      await pairDeleter.query('ROLLBACK');

      const acknowledged = await createPair('ordinary-ack-control');
      await begin(setup);
      await setup.query(
        `WITH acknowledged_task AS (
           UPDATE tasks
              SET status = 'in_progress',
                  metadata = metadata || jsonb_build_object(
                    'acknowledged_at', to_char(
                      NOW() AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                    ),
                    'acknowledged_by', $3::text,
                    'acknowledged_via', 'role'
                  ),
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid AND id = $2::integer
          RETURNING workflow_sla_instance_id, id, metadata
         )
         UPDATE workflow_sla_instances AS sla
            SET status = 'completed',
                completed_at = GREATEST(
                  (task.metadata->>'acknowledged_at')::timestamptz,
                  sla.started_at
                ),
                metadata = sla.metadata || jsonb_build_object(
                  'completed_via', 'task_ack',
                  'completed_by_task', task.id,
                  'completed_by', $3::text
                )
           FROM acknowledged_task AS task
          WHERE sla.tenant_id = $1::uuid
            AND sla.id = task.workflow_sla_instance_id`,
        [tenantId, acknowledged.taskId, actorUid],
      );
      await setup.query('SET CONSTRAINTS ALL IMMEDIATE');
      await setup.query('COMMIT');
    } finally {
      await Promise.all([
        slaWriter.query('ROLLBACK').catch(() => {}),
        pairDeleter.query('ROLLBACK').catch(() => {}),
        setup.query('ROLLBACK').catch(() => {}),
      ]);
      await begin(setup).catch(() => {});
      await setup.query(
        `DELETE FROM tasks
          WHERE tenant_id = $1::uuid
            AND workflow_sla_instance_id = ANY($2::uuid[])`,
        [tenantId, pairIds.map((pair) => pair.slaId)],
      ).catch(() => {});
      await setup.query(
        `DELETE FROM workflow_sla_instances
          WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])`,
        [tenantId, pairIds.map((pair) => pair.slaId)],
      ).catch(() => {});
      await setup.query(
        'DELETE FROM users WHERE tenant_id = $1::uuid',
        [tenantId],
      ).catch(() => {});
      await setup.query(
        'DELETE FROM tenants WHERE id = $1::uuid',
        [tenantId],
      ).catch(() => {});
      await setup.query('COMMIT').catch(() => {});
      await Promise.all([setup.end(), slaWriter.end(), pairDeleter.end()]);
    }
  }, 30_000);

  test.each([
    ['critical result', 'critical_result_ack', 'lab_result', 'legacy-result', 'acknowledgement'],
    [
      'cold chain',
      'cold_chain_excursion_ack',
      'cold_chain_excursions',
      'legacy-excursion',
      'acknowledgement',
    ],
    ['mortuary', 'mortuary_unclaimed_body', 'death_record', null, 'domain_evidence'],
  ])(
    'promotes a legacy %s writer to an exact typed SLA link while retaining aliases',
    async (_label, ruleCode, resourceType, requestedResourceId, expectedSemantics) => {
      const tenantId = await seedTenant(client);
      const patientUid = await seedUser(client, tenantId, 'PATIENT');
      const resourceId = requestedResourceId
        || String(await seedDeathRecord(client, tenantId, patientUid));
      const sourceTable = ruleCode === 'mortuary_unclaimed_body'
        ? 'death_records'
        : resourceType;
      const sla = await client.query(
        `INSERT INTO workflow_sla_instances
           (tenant_id, rule_code, patient_uid, source_table, source_id,
            status, due_at)
         VALUES ($1::uuid, $2::text, $3::uuid, $4::text, $5::text,
                 'active', '2026-07-19T12:00:00.123456Z'::timestamptz)
         RETURNING id`,
        [tenantId, ruleCode, patientUid, sourceTable, resourceId],
      );
      const task = await client.query(
        `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
            related_resource_type, related_resource_id, due_at, assigned_to_role,
            metadata)
         VALUES ($1::uuid, 'review', 'Legacy mixed-version task', $2::uuid,
                 $3::text, $4::text, '2026-07-19T12:00:00.123Z'::timestamptz,
                 'DUTY_DOCTOR',
                 jsonb_build_object(
                   'sla_instance_id', UPPER($5::text),
                   'sla_key', $6::text,
                   'writer_version', 'legacy'
                 ))
         RETURNING id, workflow_sla_instance_id, sla_completion_semantics,
                   metadata`,
        [tenantId, patientUid, resourceType, resourceId, sla.rows[0].id, ruleCode],
      );
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');

      const deadlines = await client.query(
        `SELECT task.due_at = sla.due_at AS exact_deadline,
                to_char(task.due_at, 'US') AS task_microseconds
           FROM tasks AS task
           JOIN workflow_sla_instances AS sla
             ON sla.tenant_id = task.tenant_id
            AND sla.id = task.workflow_sla_instance_id
          WHERE task.tenant_id = $1::uuid
            AND task.id = $2::integer`,
        [tenantId, task.rows[0].id],
      );
      expect(task.rows[0]).toMatchObject({
        workflow_sla_instance_id: sla.rows[0].id,
        sla_completion_semantics: expectedSemantics,
      });
      expect(task.rows[0].metadata).toMatchObject({
        sla_instance_id: sla.rows[0].id,
        sla_key: ruleCode,
        writer_version: 'legacy',
      });
      expect(deadlines.rows[0]).toEqual({
        exact_deadline: true,
        task_microseconds: '123456',
      });
    },
  );

  test('supports both mixed-version acknowledgement directions', async () => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const actorUid = await seedUser(client, tenantId, 'DOCTOR');
    const oldWriterSla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id, status, due_at)
       VALUES ($1::uuid, 'critical_result_ack', $2::uuid,
               'lab_result', 'old-writer', 'active', NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [tenantId, patientUid],
    );
    const oldWriterTask = await client.query(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id, assigned_to_role, metadata)
       VALUES ($1::uuid, 'review', 'Old writer', $2::uuid,
               'lab_result', 'old-writer', 'DUTY_DOCTOR',
               jsonb_build_object(
                 'sla_instance_id', $3::text,
                 'sla_key', 'critical_result_ack'
               ))
       RETURNING id, workflow_sla_instance_id`,
      [tenantId, patientUid, oldWriterSla.rows[0].id],
    );
    const newReaderAck = await client.query(
      `WITH acknowledged_task AS (
         UPDATE tasks
            SET status = 'in_progress',
                metadata = metadata || jsonb_build_object(
                  'acknowledged_at', to_char(
                    NOW() AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                  ),
                  'acknowledged_by', $3::text,
                  'acknowledged_via', 'assignee'
                ),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::integer
        RETURNING tenant_id, workflow_sla_instance_id, id, metadata
       )
       UPDATE workflow_sla_instances AS sla
          SET status = 'completed',
              completed_at = GREATEST(
                (task.metadata->>'acknowledged_at')::timestamptz,
                sla.started_at
              ),
              metadata = sla.metadata || jsonb_build_object(
                'completed_via', 'task_ack',
                'completed_by_task', task.id,
                'completed_by', $3::text
              )
         FROM acknowledged_task AS task
        WHERE sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        RETURNING sla.id`,
      [tenantId, oldWriterTask.rows[0].id, actorUid],
    );
    expect(newReaderAck.rows[0].id).toBe(oldWriterSla.rows[0].id);

    const newWriterSla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id, status, due_at)
       VALUES ($1::uuid, 'critical_result_ack', $2::uuid,
               'lab_result', 'new-writer', 'active', NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [tenantId, patientUid],
    );
    const newWriterTask = await client.query(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id,
          workflow_sla_instance_id, sla_completion_semantics, due_at,
          assigned_to_role, metadata)
       SELECT $1::uuid, 'review', 'New writer', $2::uuid,
              'lab_result', 'new-writer', sla.id, 'acknowledgement', sla.due_at,
              'DUTY_DOCTOR',
              jsonb_build_object('writer_version', 'typed')
         FROM workflow_sla_instances AS sla
        WHERE sla.tenant_id = $1::uuid
          AND sla.id = $3::uuid
       RETURNING id, metadata`,
      [tenantId, patientUid, newWriterSla.rows[0].id],
    );
    const oldReaderAck = await client.query(
      `WITH acknowledged_task AS (
         UPDATE tasks
            SET status = 'in_progress',
                metadata = metadata || jsonb_build_object(
                  'acknowledged_at', to_char(
                    NOW() AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                  ),
                  'acknowledged_by', $3::text,
                  'acknowledged_via', 'assignee'
                ),
                updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND id = $2::integer
        RETURNING tenant_id, id, metadata
       )
       UPDATE workflow_sla_instances AS sla
          SET status = 'completed',
              completed_at = GREATEST(
                (task.metadata->>'acknowledged_at')::timestamptz,
                sla.started_at
              ),
              metadata = sla.metadata || jsonb_build_object(
                'completed_via', 'task_ack',
                'completed_by_task', task.id,
                'completed_by', $3::text
              )
         FROM acknowledged_task AS task
        WHERE sla.tenant_id = task.tenant_id
          AND sla.id = (task.metadata->>'sla_instance_id')::uuid
        RETURNING sla.id`,
      [tenantId, newWriterTask.rows[0].id, actorUid],
    );
    expect(newWriterTask.rows[0].metadata).toMatchObject({
      sla_instance_id: newWriterSla.rows[0].id,
      sla_key: 'critical_result_ack',
      writer_version: 'typed',
    });
    expect(oldReaderAck.rows[0].id).toBe(newWriterSla.rows[0].id);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  });

  test('keeps acknowledgement actors and break-glass grants as durable receipt evidence', async () => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const actorUid = await seedUser(client, tenantId, 'DOCTOR');

    async function createAcknowledgedObligation({
      sourceId,
      acknowledgementMetadata,
      completedBy,
    }) {
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      const sla = await client.query(
        `INSERT INTO workflow_sla_instances
           (tenant_id, rule_code, patient_uid, source_table, source_id,
            status, due_at, metadata)
         VALUES ($1::uuid, 'critical_result_ack', $2::uuid,
                 'lab_results', $3::text, 'active', NOW() + INTERVAL '1 hour',
                 '{"task_materialization_contract":"application_atomic_v1"}'::jsonb)
         RETURNING id`,
        [tenantId, patientUid, sourceId],
      );
      const task = await client.query(
        `INSERT INTO tasks
           (tenant_id, task_kind, title, patient_uid,
            related_resource_type, related_resource_id,
            workflow_sla_instance_id, sla_completion_semantics, due_at,
            assigned_to_role)
         SELECT $1::uuid, 'review', 'Durable receipt', $2::uuid,
                'lab_results', $3::text, sla.id, 'acknowledgement', sla.due_at,
                'DUTY_DOCTOR'
           FROM workflow_sla_instances AS sla
          WHERE sla.tenant_id = $1::uuid AND sla.id = $4::uuid
         RETURNING id`,
        [tenantId, patientUid, sourceId, sla.rows[0].id],
      );
      await client.query(
        `WITH acknowledged_task AS (
           UPDATE tasks
              SET status = 'in_progress',
                  metadata = metadata || $4::jsonb || jsonb_build_object(
                    'acknowledged_at', to_char(
                      NOW() AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                    ),
                    'acknowledged_by', $3::text
                  ),
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid AND id = $2::integer
          RETURNING workflow_sla_instance_id, id, metadata
         )
         UPDATE workflow_sla_instances AS sla
            SET status = 'completed',
                completed_at = GREATEST(
                  (task.metadata->>'acknowledged_at')::timestamptz,
                  sla.started_at
                ),
                metadata = sla.metadata || jsonb_build_object(
                  'completed_via', 'task_ack',
                  'completed_by_task', task.id,
                  'completed_by', $3::text
                )
           FROM acknowledged_task AS task
          WHERE sla.tenant_id = $1::uuid
            AND sla.id = task.workflow_sla_instance_id`,
        [tenantId, task.rows[0].id, completedBy, JSON.stringify(acknowledgementMetadata)],
      );
      return { slaId: sla.rows[0].id, taskId: task.rows[0].id };
    }

    await createAcknowledgedObligation({
      sourceId: 'actor-dependent-result',
      completedBy: actorUid,
      acknowledgementMetadata: { acknowledged_via: 'role' },
    });
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await expectStatementFailure(
      client,
      'DELETE FROM users WHERE tenant_id = $1::uuid AND uid = $2::uuid',
      [tenantId, actorUid],
      '23514',
      'authenticated clock-stopping receipt',
    );

    const overrideActorUid = await seedUser(client, tenantId, 'CMO');
    const overrideReason = 'Urgent clinical continuity override';
    const override = await client.query(
      `INSERT INTO patient_access_break_glass
         (tenant_id, patient_uid, actor_uid, actor_role, reason, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'CMO', $4::text, 'active')
       RETURNING id`,
      [tenantId, patientUid, overrideActorUid, overrideReason],
    );
    await createAcknowledgedObligation({
      sourceId: 'grant-dependent-result',
      completedBy: overrideActorUid,
      acknowledgementMetadata: {
        acknowledged_via: 'override',
        acknowledge_override_source: 'patient_access_break_glass',
        acknowledge_override_id: String(override.rows[0].id),
        acknowledge_override_reason: overrideReason,
      },
    });
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');

    await expectStatementFailure(
      client,
      `UPDATE patient_access_break_glass
          SET reason = 'Changed reason invalidates evidence', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, override.rows[0].id],
      '23514',
      'authenticated clock-stopping receipt',
    );
    await expectStatementFailure(
      client,
      'DELETE FROM patient_access_break_glass WHERE tenant_id = $1::uuid AND id = $2::integer',
      [tenantId, override.rows[0].id],
      '23514',
      'authenticated clock-stopping receipt',
    );
  });

  test('accepts a typed workflow-step task completed by domain evidence', async () => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const definition = await seedDefinition(client, tenantId);
    const workflowRunId = await seedRun(client, tenantId, definition);
    const step = await client.query(
      `INSERT INTO workflow_steps
       (tenant_id, workflow_run_id, step_key, step_kind, ordering)
       VALUES ($1::uuid, $2::integer, 'domain-proof', 'wait', 1)
       RETURNING id`,
      [tenantId, workflowRunId],
    );
    const sla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id, status, due_at)
       VALUES ($1::uuid, 'pathway_domain_proof', $2::uuid,
               'workflow_steps', $3::text, 'active', NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [tenantId, patientUid, String(step.rows[0].id)],
    );
    const task = await client.query(
      `INSERT INTO tasks
         (tenant_id, workflow_run_id, workflow_step_id, task_kind, title,
          patient_uid, workflow_sla_instance_id, sla_completion_semantics, due_at)
       SELECT $1::uuid, $2::integer, $3::integer, 'pathway_stage',
              'Wait for domain evidence', $4::uuid, sla.id, 'domain_evidence', sla.due_at
         FROM workflow_sla_instances AS sla
        WHERE sla.tenant_id = $1::uuid
          AND sla.id = $5::uuid
       RETURNING workflow_sla_instance_id, sla_completion_semantics, metadata`,
      [tenantId, workflowRunId, step.rows[0].id, patientUid, sla.rows[0].id],
    );
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    expect(task.rows[0]).toMatchObject({
      workflow_sla_instance_id: sla.rows[0].id,
      sla_completion_semantics: 'domain_evidence',
    });
    expect(task.rows[0].metadata).toMatchObject({
      sla_instance_id: sla.rows[0].id,
      sla_key: 'pathway_domain_proof',
    });
  });

  test('enforces acknowledgement task and clock lifecycle atomically at commit', async () => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const actorUid = await seedUser(client, tenantId, 'DOCTOR');
    const sla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id, status, due_at)
       VALUES ($1::uuid, 'critical_result_ack', $2::uuid,
               'lab_result', 'lifecycle-guard', 'active', NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [tenantId, patientUid],
    );
    const task = await client.query(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id,
          workflow_sla_instance_id, sla_completion_semantics, due_at,
          assigned_to_role)
       SELECT $1::uuid, 'review', 'Lifecycle guard', $2::uuid,
              'lab_result', 'lifecycle-guard', sla.id, 'acknowledgement', sla.due_at,
              'DUTY_DOCTOR'
         FROM workflow_sla_instances AS sla
        WHERE sla.tenant_id = $1::uuid
          AND sla.id = $3::uuid
       RETURNING id`,
      [tenantId, patientUid, sla.rows[0].id],
    );

    await expectDeferredTaskSlaFailure(
      client,
      `UPDATE tasks
          SET status = 'in_progress'
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      [tenantId, task.rows[0].id],
      'acknowledged task must have a completed linked SLA clock',
    );

    await client.query(
      `WITH acknowledged_task AS (
         UPDATE tasks
            SET status = 'in_progress',
                metadata = metadata || jsonb_build_object(
                  'acknowledged_at', to_char(
                    NOW() AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                  ),
                  'acknowledged_by', $3::text,
                  'acknowledged_via', 'assignee'
                )
          WHERE tenant_id = $1::uuid
            AND id = $2::integer
        RETURNING tenant_id, workflow_sla_instance_id, id, metadata
       )
       UPDATE workflow_sla_instances AS sla
          SET status = 'completed',
              completed_at = GREATEST(
                (task.metadata->>'acknowledged_at')::timestamptz,
                sla.started_at
              ),
              metadata = sla.metadata || jsonb_build_object(
                'completed_via', 'task_ack',
                'completed_by_task', task.id,
                'completed_by', $3::text
              )
         FROM acknowledged_task AS task
        WHERE sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id`,
      [tenantId, task.rows[0].id, actorUid],
    );
    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
      command: 'SET',
    });
  });

  test.each([
    ['critical result', 'critical_result_ack', 'lab_result', 'degraded-result', false],
    [
      'cold chain',
      'cold_chain_excursion_ack',
      'cold_chain_excursions',
      'degraded-excursion',
      false,
    ],
    ['mortuary', 'mortuary_unclaimed_body', 'death_record', null, true],
  ])(
    'normalizes a recognized old %s no-policy write without fabricating a clock',
    async (_label, slaKey, resourceType, requestedResourceId, retainsLegacyKey) => {
      const tenantId = await seedTenant(client);
      const patientUid = await seedUser(client, tenantId, 'PATIENT');
      const resourceId = requestedResourceId
        || String(await seedDeathRecord(client, tenantId, patientUid));
      const task = await client.query(
        `INSERT INTO tasks
           (tenant_id, task_kind, title, patient_uid,
            related_resource_type, related_resource_id, metadata)
         VALUES ($1::uuid, 'review', 'Policy unavailable', $2::uuid,
                 $3::text, $4::text,
                 jsonb_build_object('sla_key', $5::text, 'sla_instance_id', NULL))
         RETURNING workflow_sla_instance_id, sla_completion_semantics,
                   due_at, metadata`,
        [tenantId, patientUid, resourceType, resourceId, slaKey],
      );
      expect(task.rows[0]).toMatchObject({
        workflow_sla_instance_id: null,
        sla_completion_semantics: 'none',
        due_at: null,
      });
      expect(task.rows[0].metadata).toMatchObject({
        requested_sla_key: slaKey,
        sla_policy_status: 'missing',
      });
      expect(task.rows[0].metadata).not.toHaveProperty('sla_instance_id');
      if (retainsLegacyKey) {
        expect(task.rows[0].metadata.sla_key).toBe(slaKey);
      } else {
        expect(task.rows[0].metadata).not.toHaveProperty('sla_key');
      }
    },
  );

  test('keeps a typed rolling alias synchronized and prevents link detachment or tampering', async () => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const sla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id, status, due_at)
       VALUES ($1::uuid, 'critical_result_ack', $2::uuid,
               'lab_result', 'immutable-alias', 'active', NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [tenantId, patientUid],
    );
    const task = await client.query(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id,
          workflow_sla_instance_id, sla_completion_semantics, due_at,
          assigned_to_role)
       SELECT $1::uuid, 'review', 'Immutable alias', $2::uuid,
              'lab_result', 'immutable-alias', sla.id, 'acknowledgement', sla.due_at,
              'DUTY_DOCTOR'
         FROM workflow_sla_instances AS sla
        WHERE sla.tenant_id = $1::uuid
          AND sla.id = $3::uuid
       RETURNING id`,
      [tenantId, patientUid, sla.rows[0].id],
    );

    const resynchronized = await client.query(
      `UPDATE tasks
          SET metadata = metadata - 'sla_instance_id'
        WHERE tenant_id = $1::uuid
          AND id = $2::integer
      RETURNING metadata`,
      [tenantId, task.rows[0].id],
    );
    expect(resynchronized.rows[0].metadata).toMatchObject({
      sla_instance_id: sla.rows[0].id,
      sla_key: 'critical_result_ack',
    });

    await expectStatementFailure(
      client,
      `UPDATE tasks
          SET metadata = jsonb_set(metadata, '{sla_instance_id}', to_jsonb($3::text))
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      [tenantId, task.rows[0].id, randomUUID()],
      '23514',
      'must identify the same instance',
    );
    await expectStatementFailure(
      client,
      `UPDATE tasks
          SET workflow_sla_instance_id = NULL,
              sla_completion_semantics = 'none',
              metadata = metadata - 'sla_instance_id' - 'sla_key'
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      [tenantId, task.rows[0].id],
      '23514',
      'cannot be detached',
    );
  });

  test('retains the mortuary degraded alias so an old release flow can complete the task', async () => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const deathRecordId = await seedDeathRecord(client, tenantId, patientUid);
    const task = await client.query(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id, metadata)
       VALUES ($1::uuid, 'review', 'Degraded mortuary task', $2::uuid,
               'death_record', $3::text,
               jsonb_build_object(
                 'sla_key', 'mortuary_unclaimed_body',
                 'sla_instance_id', NULL
               ))
       RETURNING id, metadata`,
      [tenantId, patientUid, String(deathRecordId)],
    );
    const release = await client.query(
      `INSERT INTO body_custody_events
         (tenant_id, death_record_id, event_type, event_at, release_method)
       VALUES ($1::uuid, $2::integer, 'release', NOW(), 'family')
       RETURNING created_at`,
      [tenantId, deathRecordId],
    );
    const completed = await client.query(
      `UPDATE tasks
          SET status = 'completed',
              completed_at = $4::timestamptz,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::integer
          AND related_resource_id = $3::text
          AND metadata->>'sla_key' = 'mortuary_unclaimed_body'
      RETURNING status, workflow_sla_instance_id, sla_completion_semantics,
                due_at, metadata`,
      [tenantId, task.rows[0].id, String(deathRecordId), release.rows[0].created_at],
    );
    expect(completed.rows[0]).toMatchObject({
      status: 'completed',
      workflow_sla_instance_id: null,
      sla_completion_semantics: 'none',
      due_at: null,
    });
    expect(completed.rows[0].metadata).toMatchObject({
      sla_key: 'mortuary_unclaimed_body',
      requested_sla_key: 'mortuary_unclaimed_body',
      sla_policy_status: 'missing',
    });
  });

  test('rejects mismatched and unknown mixed-version SLA claims', async () => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const firstSla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id, status, due_at)
       VALUES ($1::uuid, 'critical_result_ack', $2::uuid,
               'lab_result', 'first', 'active', NOW() + INTERVAL '1 hour')
       RETURNING id, due_at`,
      [tenantId, patientUid],
    );
    const secondSla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id, status, due_at)
       VALUES ($1::uuid, 'critical_result_ack', $2::uuid,
               'lab_result', 'second', 'active', NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [tenantId, patientUid],
    );

    await expectStatementFailure(
      client,
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id,
          workflow_sla_instance_id, sla_completion_semantics, due_at, metadata)
       VALUES ($1::uuid, 'review', 'Mismatched IDs', $2::uuid,
               'lab_result', 'first', $3::uuid, 'acknowledgement', $4::timestamptz,
               jsonb_build_object('sla_instance_id', $5::text,
                                  'sla_key', 'critical_result_ack'))`,
      [tenantId, patientUid, firstSla.rows[0].id, firstSla.rows[0].due_at, secondSla.rows[0].id],
      '23514',
      'must identify the same instance',
    );
    await expectStatementFailure(
      client,
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id, metadata)
       VALUES ($1::uuid, 'review', 'Mismatched key', $2::uuid,
               'lab_result', 'first',
               jsonb_build_object('sla_instance_id', $3::text,
                                  'sla_key', 'cold_chain_excursion_ack'))`,
      [tenantId, patientUid, firstSla.rows[0].id],
      '23514',
      'legacy key must equal',
    );
    await expectStatementFailure(
      client,
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id, metadata)
       VALUES ($1::uuid, 'review', 'Unknown degraded key', $2::uuid,
               'lab_result', 'unknown',
               jsonb_build_object('sla_key', 'unknown_sla_contract'))`,
      [tenantId, patientUid],
      '23514',
      'not a recognized compatibility contract',
    );
    await expectStatementFailure(
      client,
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id, metadata)
       VALUES ($1::uuid, 'review', 'Inconsistent degraded marker', $2::uuid,
               'death_record', '1',
               jsonb_build_object(
                 'sla_key', 'mortuary_unclaimed_body',
                 'requested_sla_key', 'cold_chain_excursion_ack',
                 'sla_policy_status', 'missing'
               ))`,
      [tenantId, patientUid],
      '23514',
      'unknown or inconsistent',
    );
  });

  test.each([
    ['missing', 'NULL::timestamptz'],
    ["different", "sla.due_at + INTERVAL '1 second'"],
  ])('rejects a direct typed task with a %s deadline', async (_label, taskDueExpression) => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const sla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id, status, due_at, metadata)
       VALUES ($1::uuid, 'critical_result_ack', $2::uuid,
               'lab_results', 'deadline-result', 'active', NOW() + INTERVAL '1 hour',
               '{"task_materialization_contract":"application_atomic_v1"}'::jsonb)
       RETURNING id`,
      [tenantId, patientUid],
    );

    await expectDeferredTaskSlaFailure(
      client,
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id,
          workflow_sla_instance_id, sla_completion_semantics, due_at,
          assigned_to_role)
       SELECT $1::uuid, 'critical_result_ack', 'Critical result', $2::uuid,
              'lab_results', 'deadline-result', sla.id, 'acknowledgement',
              ${taskDueExpression}, 'DUTY_DOCTOR'
         FROM workflow_sla_instances AS sla
        WHERE sla.id = $3::uuid`,
      [tenantId, patientUid, sla.rows[0].id],
      _label === 'missing'
        ? 'linked task deadline must be present'
        : 'deadlines must both be present and exactly equal',
    );
  });

  test('atomically materializes an exact successor for the raw PR 587 rearm update', async () => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const orderingClinicianUid = await seedUser(client, tenantId, 'DOCTOR');
    const pathologistUid = await seedUser(client, tenantId, 'DOCTOR');
    const investigation = await client.query(
      `INSERT INTO investigations
         (tenant_id, phone, patient_uid, test_name, status, requested_by, updated_at)
       VALUES ($1::uuid, '9800000000', $2::uuid, 'Critical potassium',
               'COMPLETED', $3::uuid, NOW())
       RETURNING id`,
      [tenantId, patientUid, orderingClinicianUid],
    );
    const result = await client.query(
      `INSERT INTO lab_results
         (tenant_id, patient_uid, test_code, test_name, status, is_critical,
          investigation_id)
       VALUES ($1::uuid, $2::uuid, 'K', 'Potassium', 'final', TRUE, $3::integer)
       RETURNING id`,
      [tenantId, patientUid, investigation.rows[0].id],
    );
    const sla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id,
          status, started_at, due_at, completed_at, metadata)
       VALUES ($1::uuid, 'critical_result_ack', $2::uuid,
               'lab_result', $3::text, 'completed',
               '2026-07-19T07:00:00.123456Z'::timestamptz,
               '2026-07-19T08:00:00.123456Z'::timestamptz,
               '2026-07-19T07:55:00.123456Z'::timestamptz,
               jsonb_build_object(
                 'task_materialization_contract', 'application_atomic_v1'
               ))
       RETURNING id, due_at`,
      [tenantId, patientUid, String(result.rows[0].id)],
    );
    const predecessor = await client.query(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid, status, completed_at,
          assigned_to_uid,
          related_resource_type, related_resource_id,
          workflow_sla_instance_id, sla_completion_semantics, due_at, metadata)
        SELECT $1::uuid, 'review', 'Prior critical result task', $2::uuid,
              'completed', '2026-07-19T07:55:00.123456Z'::timestamptz,
              $3::uuid, 'lab_result', $4::text,
              sla.id, 'acknowledgement', sla.due_at,
              '{}'::jsonb
         FROM workflow_sla_instances AS sla
        WHERE sla.id = $5::uuid
       RETURNING id`,
      [
        tenantId,
        patientUid,
        orderingClinicianUid,
        String(result.rows[0].id),
        sla.rows[0].id,
      ],
    );
    await client.query(
      `UPDATE workflow_sla_instances
              SET metadata = jsonb_build_object(
                'completed_via', 'task_completion',
                'completed_by_task', $3::integer,
                'completed_by', $4::text
              )
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid`,
      [tenantId, sla.rows[0].id, predecessor.rows[0].id, pathologistUid],
    );
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    await client.query(
      `INSERT INTO lab_pathologist_signoffs
       (tenant_id, patient_uid, result_ids, signed_off_by, decision, signed_at)
       VALUES ($1::uuid, $2::uuid, ARRAY[$3::integer], $4::uuid, 'corrected',
               NOW() - INTERVAL '1 minute')`,
      [tenantId, patientUid, result.rows[0].id, pathologistUid],
    );
    await client.query(
      `UPDATE workflow_sla_instances
          SET status = 'active',
              started_at = NOW(),
              due_at = NOW() + INTERVAL '1 hour' + INTERVAL '0.000321 seconds',
              completed_at = NULL,
              breached_at = NULL,
              escalated_at = NULL,
              metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'reopened_from_result_update', TRUE,
                'reopened_at', NOW()
              )
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid`,
      [tenantId, sla.rows[0].id],
    );
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');

    const generations = await client.query(
      `SELECT task.id, task.title, task.status, task.assigned_to_uid,
              task.assigned_to_role, to_char(task.due_at, 'US') AS microseconds,
              task.due_at = sla.due_at AS current_deadline_exact,
              task.metadata
         FROM tasks AS task
         JOIN workflow_sla_instances AS sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid
          AND task.workflow_sla_instance_id = $2::uuid
        ORDER BY task.id`,
      [tenantId, sla.rows[0].id],
    );
    expect(generations.rows).toHaveLength(2);
    expect(generations.rows[0]).toMatchObject({
      id: predecessor.rows[0].id,
      status: 'completed',
      microseconds: '123456',
      current_deadline_exact: false,
    });
    expect(generations.rows[1]).toMatchObject({
      title: 'Updated result: re-acknowledgement required',
      status: 'open',
      assigned_to_uid: orderingClinicianUid,
      assigned_to_role: null,
      current_deadline_exact: true,
      metadata: expect.objectContaining({
        reopened_from_task_id: predecessor.rows[0].id,
        reopen_reason: 'lab_signoff_corrected',
        reopen_link_source: 'migration_580_rolling_compat',
      }),
    });

    const history = await client.query(
      `SELECT metadata->'reopen_history'->0 AS receipt,
              jsonb_array_length(metadata->'reopen_history') AS history_count,
              COUNT(*) FILTER (
                WHERE receipt->>'compatibility_state' = 'pending_successor'
              ) OVER () AS pending_count
         FROM workflow_sla_instances AS sla
         CROSS JOIN LATERAL jsonb_array_elements(sla.metadata->'reopen_history')
           AS item(receipt)
        WHERE sla.tenant_id = $1::uuid
          AND sla.id = $2::uuid`,
      [tenantId, sla.rows[0].id],
    );
    expect(history.rows[0]).toMatchObject({
      history_count: 1,
      pending_count: '0',
      receipt: expect.objectContaining({
        prior_completed_by_task: predecessor.rows[0].id,
        successor_task_id: generations.rows[1].id,
        compatibility_state: 'linked',
        database_authored_by: 'migration_580_rolling_compat',
      }),
    });

    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const duplicate = await client.query(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id,
          workflow_sla_instance_id, sla_completion_semantics, due_at,
          assigned_to_role)
       SELECT $1::uuid, 'review', 'Legacy retry', $2::uuid,
              'lab_result', $3::text, $4::uuid, 'acknowledgement', sla.due_at,
              'DUTY_DOCTOR'
         FROM workflow_sla_instances AS sla
        WHERE sla.tenant_id = $1::uuid
          AND sla.id = $4::uuid
       ON CONFLICT (tenant_id, related_resource_type, related_resource_id)
         WHERE status IN ('open', 'in_progress', 'blocked', 'overdue')
           AND related_resource_type IS NOT NULL
           AND related_resource_id IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [tenantId, patientUid, String(result.rows[0].id), sla.rows[0].id],
    );
    expect(duplicate.rows).toHaveLength(0);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    await expectDeferredCompletionReceiptFailure(
      client,
      `UPDATE tasks
          SET metadata = metadata - 'reopened_from_task_id' - 'reopen_reason'
        WHERE tenant_id = $1::uuid
          AND id = $2::integer`,
      [tenantId, generations.rows[1].id],
      'acknowledgement task and SLA completion receipt are inconsistent',
    );
  });

  test('prevents removal of a death record while a mortuary task/SLA link depends on it', async () => {
    const tenantId = await seedTenant(client);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const deathRecordId = await seedDeathRecord(client, tenantId, patientUid);
    const sla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, source_table, source_id, status, due_at, metadata)
       VALUES ($1::uuid, 'mortuary_unclaimed_body', $2::uuid,
               'death_records', $3::text, 'active', NOW() + INTERVAL '1 hour',
               '{"task_materialization_contract":"application_atomic_v1"}'::jsonb)
       RETURNING id, due_at`,
      [tenantId, patientUid, String(deathRecordId)],
    );
    await client.query(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id,
          workflow_sla_instance_id, sla_completion_semantics, due_at,
          assigned_to_role)
       VALUES ($1::uuid, 'review', 'Release body', $2::uuid,
               'death_record', $3::text, $4::uuid, 'domain_evidence',
               (SELECT due_at FROM workflow_sla_instances WHERE id = $4::uuid),
               'MEDICAL_RECORDS')`,
      [tenantId, patientUid, String(deathRecordId), sla.rows[0].id],
    );
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');

    await expectStatementFailure(
      client,
      'DELETE FROM death_records WHERE tenant_id = $1::uuid AND id = $2::integer',
      [tenantId, deathRecordId],
      '23514',
      'same obligation',
    );
  });

  test.each([
    ['clinical owner', 'clinical_owner_uid'],
    ['operational owner', 'operational_owner_uid'],
    ['approver', 'approved_by'],
  ])('rejects a cross-tenant governance %s', async (_label, targetColumn) => {
    const tenantId = await seedTenant(client);
    const otherTenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId);
    const otherUid = await seedUser(client, otherTenantId);
    const definition = await seedDefinition(client, tenantId);
    const values = {
      clinical_owner_uid: ownerUid,
      operational_owner_uid: ownerUid,
      approved_by: null,
    };
    values[targetColumn] = otherUid;

    await expectStatementFailure(
      client,
      `INSERT INTO care_pathway_definition_governance
         (tenant_id, workflow_definition_id, clinical_owner_uid, operational_owner_uid,
          governance_status, approved_by)
       VALUES ($1::uuid, $2::integer, $3::uuid, $4::uuid, 'draft', $5::uuid)`,
      [
        tenantId,
        definition.id,
        values.clinical_owner_uid,
        values.operational_owner_uid,
        values.approved_by,
      ],
      '23503',
    );
  });

  test.each([
    ['clinical owner', 'clinical_owner_uid'],
    ['operational owner', 'operational_owner_uid'],
  ])('rejects a PATIENT governance %s', async (_label, targetColumn) => {
    const tenantId = await seedTenant(client);
    const staffUid = await seedUser(client, tenantId);
    const patientUid = await seedUser(client, tenantId, 'PATIENT');
    const definition = await seedDefinition(client, tenantId);
    const values = {
      clinical_owner_uid: staffUid,
      operational_owner_uid: staffUid,
      approved_by: null,
    };
    values[targetColumn] = patientUid;
    await client.query(
      `INSERT INTO care_pathway_definition_governance
         (tenant_id, workflow_definition_id, clinical_owner_uid, operational_owner_uid,
          governance_status, approved_by)
       VALUES ($1::uuid, $2::integer, $3::uuid, $4::uuid, 'draft', $5::uuid)`,
      [
        tenantId,
        definition.id,
        values.clinical_owner_uid,
        values.operational_owner_uid,
        values.approved_by,
      ],
    );

    await expectStatementFailure(
      client,
      'SET CONSTRAINTS ALL IMMEDIATE',
      [],
      '23514',
      'must be non-patient tenant users',
    );
  });

  test('permits an inactive draft owner but rejects publication until both owners are active', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId);
    const approverUid = await seedUser(client, tenantId, 'ADMIN');
    const definition = await seedDefinition(client, tenantId);
    const approval = await seedValidApproval(client, {
      tenantId,
      definitionId: definition.id,
      approverUid,
    });
    await client.query(
      `UPDATE users SET is_active = FALSE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      [tenantId, ownerUid],
    );
    const governanceId = await insertGovernance(client, {
      tenantId,
      definitionId: definition.id,
      ownerUid,
      approverUid,
      approvalId: approval.id,
      status: 'draft',
    });
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    await expectDeferredConstraintFailure(client, {
      statement: `UPDATE care_pathway_definition_governance
                     SET governance_status = 'approved', updated_at = NOW()
                   WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      params: [tenantId, governanceId],
      constraint: 'trg_care_pathway_governance_non_patient_actors',
      message: 'approved pathway governance owners must be active',
    });
  });

  test.each([
    ['status', "status = 'pending'"],
    ['approval kind', "approval_kind = 'other_kind'"],
    ['subject type', "subject_resource_type = 'other_subject'"],
    ['missing subject type', 'subject_resource_type = NULL'],
    ['definition subject id', "subject_resource_id = '999999999'"],
    ['missing definition subject id', 'subject_resource_id = NULL'],
    ['decision actor', 'decided_by = NULL'],
    ['decision time', 'decided_at = NULL'],
    ['decision actor membership', "approved_by = '[]'::jsonb"],
    ['approval quorum', 'required_approvers = 2'],
    ['non-positive approval quorum', 'required_approvers = 0'],
  ])('rejects approved governance with invalid approval %s', async (_label, mutation) => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId);
    const approverUid = await seedUser(client, tenantId, 'ADMIN');
    const definition = await seedDefinition(client, tenantId);
    const approval = await seedValidApproval(client, {
      tenantId,
      definitionId: definition.id,
      approverUid,
    });
    await client.query(`UPDATE approvals SET ${mutation} WHERE id = $1`, [approval.id]);
    await insertGovernance(client, {
      tenantId,
      definitionId: definition.id,
      ownerUid,
      approverUid,
      approvalId: approval.id,
    });

    await expectStatementFailure(
      client,
      'SET CONSTRAINTS ALL IMMEDIATE',
      [],
      '23514',
      'invalid approval evidence',
    );
  });

  test.each([
    ['unknown user', 'fake', 'must be active non-patient tenant users at publication'],
    ['cross-tenant user', 'cross_tenant', 'must be active non-patient tenant users at publication'],
    ['patient user', 'patient', 'must be active non-patient tenant users at publication'],
    ['inactive user', 'inactive', 'must be active non-patient tenant users at publication'],
    ['malformed timestamp', 'malformed_timestamp', 'invalid approval evidence'],
    ['post-decision timestamp', 'future_timestamp', 'invalid approval evidence'],
  ])('rejects a forged approval quorum containing an %s vote', async (_label, kind, expectedMessage) => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId);
    const approverUid = await seedUser(client, tenantId, 'ADMIN');
    const definition = await seedDefinition(client, tenantId);
    const decidedAt = new Date('2026-07-19T08:00:00.000Z');
    let secondUid;
    let secondAt = decidedAt.toISOString();

    if (kind === 'fake') {
      secondUid = randomUUID();
    } else if (kind === 'cross_tenant') {
      const otherTenantId = await seedTenant(client);
      secondUid = await seedUser(client, otherTenantId, 'ADMIN');
    } else if (kind === 'patient') {
      secondUid = await seedUser(client, tenantId, 'PATIENT');
    } else if (kind === 'inactive') {
      secondUid = await seedUser(client, tenantId, 'ADMIN');
      await client.query(
        `UPDATE users SET is_active = FALSE
          WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
        [tenantId, secondUid],
      );
    } else {
      secondUid = await seedUser(client, tenantId, 'ADMIN');
      secondAt = kind === 'malformed_timestamp'
        ? 'not-a-timestamp'
        : '2026-07-19T08:01:00.000Z';
    }

    const approval = await client.query(
      `INSERT INTO approvals
         (tenant_id, approval_kind, subject_resource_type, subject_resource_id,
           required_approvers, status, approved_by, decided_by, decided_at, metadata)
        VALUES ($1::uuid, $2::text, $3::text, $4::text,
                2, 'approved', $5::jsonb, $6::uuid, $7::timestamptz,
                jsonb_build_object(
                  'care_pathway_definition_governance',
                  jsonb_build_object('definition_checksum', $8::text)
                ))
       RETURNING id`,
      [
        tenantId,
        APPROVAL_KIND,
        APPROVAL_SUBJECT_TYPE,
        String(definition.id),
        JSON.stringify([
          { uid: approverUid, at: decidedAt.toISOString() },
          { uid: secondUid, at: secondAt },
        ]),
        approverUid,
        decidedAt,
        CHECKSUM,
      ],
    );
    await insertGovernance(client, {
      tenantId,
      definitionId: definition.id,
      ownerUid,
      approverUid,
      approvalId: approval.rows[0].id,
    });

    await expectStatementFailure(
      client,
      'SET CONSTRAINTS ALL IMMEDIATE',
      [],
      '23514',
      expectedMessage,
    );
  });

  test('rejects duplicate vote entries even when the nominal quorum is one', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId);
    const approverUid = await seedUser(client, tenantId, 'ADMIN');
    const definition = await seedDefinition(client, tenantId);
    const decidedAt = new Date('2026-07-19T08:00:00.000Z');
    const vote = { uid: approverUid, at: decidedAt.toISOString() };
    const approval = await client.query(
      `INSERT INTO approvals
         (tenant_id, approval_kind, subject_resource_type, subject_resource_id,
           required_approvers, status, approved_by, decided_by, decided_at, metadata)
        VALUES ($1::uuid, $2::text, $3::text, $4::text,
                1, 'approved', $5::jsonb, $6::uuid, $7::timestamptz,
                jsonb_build_object(
                  'care_pathway_definition_governance',
                  jsonb_build_object('definition_checksum', $8::text)
                ))
       RETURNING id`,
      [
        tenantId,
        APPROVAL_KIND,
        APPROVAL_SUBJECT_TYPE,
        String(definition.id),
        JSON.stringify([vote, vote]),
        approverUid,
        decidedAt,
        CHECKSUM,
      ],
    );
    await insertGovernance(client, {
      tenantId,
      definitionId: definition.id,
      ownerUid,
      approverUid,
      approvalId: approval.rows[0].id,
    });

    await expectStatementFailure(
      client,
      'SET CONSTRAINTS ALL IMMEDIATE',
      [],
      '23514',
      'invalid approval evidence',
    );
  });

  test('accepts canonical UUIDv7 owners and voters at publication', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(
      client,
      tenantId,
      'DOCTOR',
      '019f7000-0000-7000-8000-000000000001',
    );
    const approverUid = await seedUser(client, tenantId, 'ADMIN');
    const voterUid = await seedUser(
      client,
      tenantId,
      'DOCTOR',
      '019f7000-0000-7000-8000-000000000002',
    );
    const definition = await seedDefinition(client, tenantId);
    const decidedAt = new Date('2026-07-19T08:00:00.000Z');
    const approval = await client.query(
      `INSERT INTO approvals
         (tenant_id, approval_kind, subject_resource_type, subject_resource_id,
          required_approvers, status, approved_by, decided_by, decided_at, metadata)
       VALUES ($1::uuid, $2::text, $3::text, $4::text,
               2, 'approved', $5::jsonb, $6::uuid, $7::timestamptz,
               jsonb_build_object(
                 'care_pathway_definition_governance',
                 jsonb_build_object('definition_checksum', $8::text)
               ))
       RETURNING id`,
      [
        tenantId,
        APPROVAL_KIND,
        APPROVAL_SUBJECT_TYPE,
        String(definition.id),
        JSON.stringify([
          { uid: approverUid, at: decidedAt.toISOString() },
          { uid: voterUid, at: decidedAt.toISOString() },
        ]),
        approverUid,
        decidedAt,
        CHECKSUM,
      ],
    );
    await insertGovernance(client, {
      tenantId,
      definitionId: definition.id,
      ownerUid,
      approverUid,
      approvalId: approval.rows[0].id,
    });

    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
      command: 'SET',
    });
  });

  test('preserves immutable quorum evidence and permits retirement when a voter becomes inactive', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId);
    const approverUid = await seedUser(client, tenantId, 'ADMIN');
    const voterUid = await seedUser(client, tenantId, 'DOCTOR');
    const definition = await seedDefinition(client, tenantId);
    const decidedAt = new Date('2026-07-19T08:00:00.000Z');
    const approval = await client.query(
      `INSERT INTO approvals
         (tenant_id, approval_kind, subject_resource_type, subject_resource_id,
           required_approvers, status, approved_by, decided_by, decided_at, metadata)
        VALUES ($1::uuid, $2::text, $3::text, $4::text,
                2, 'approved', $5::jsonb, $6::uuid, $7::timestamptz,
                jsonb_build_object(
                  'care_pathway_definition_governance',
                  jsonb_build_object('definition_checksum', $8::text)
                ))
       RETURNING id`,
      [
        tenantId,
        APPROVAL_KIND,
        APPROVAL_SUBJECT_TYPE,
        String(definition.id),
        JSON.stringify([
          { uid: approverUid, at: decidedAt.toISOString() },
          { uid: voterUid, at: decidedAt.toISOString() },
        ]),
        approverUid,
        decidedAt,
        CHECKSUM,
      ],
    );
    const governanceId = await insertGovernance(client, {
      tenantId,
      definitionId: definition.id,
      ownerUid,
      approverUid,
      approvalId: approval.rows[0].id,
    });
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const evidenceBefore = await client.query(
      `SELECT approval.approved_by, approval.decided_by, approval.decided_at,
              governance.approved_by AS governance_approved_by,
              governance.approved_at
         FROM approvals AS approval
         JOIN care_pathway_definition_governance AS governance
           ON governance.tenant_id = approval.tenant_id
          AND governance.approval_id = approval.id
        WHERE approval.tenant_id = $1::uuid AND approval.id = $2::integer`,
      [tenantId, approval.rows[0].id],
    );
    await client.query(
      `UPDATE users SET is_active = FALSE
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      [tenantId, voterUid],
    );
    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
      command: 'SET',
    });
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const retirementActorUid = await seedUser(client, tenantId, 'DOCTOR');
    await client.query(
      `UPDATE workflow_definitions
          SET is_active = FALSE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, definition.id],
    );
    await client.query(
      `UPDATE care_pathway_definition_governance
          SET governance_status = 'retired',
              retired_by = $1::uuid,
              retired_at = '2026-07-19T09:00:00.000Z'::timestamptz,
              retirement_reason = 'superseded after historical vote',
              effective_until = '2026-07-19T09:00:00.000Z'::timestamptz,
              updated_at = NOW()
        WHERE tenant_id = $2::uuid AND id = $3::uuid`,
      [retirementActorUid, tenantId, governanceId],
    );
    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
      command: 'SET',
    });
    const evidenceAfter = await client.query(
      `SELECT approval.approved_by, approval.decided_by, approval.decided_at,
              governance.approved_by AS governance_approved_by,
              governance.approved_at
         FROM approvals AS approval
         JOIN care_pathway_definition_governance AS governance
           ON governance.tenant_id = approval.tenant_id
          AND governance.approval_id = approval.id
        WHERE approval.tenant_id = $1::uuid AND approval.id = $2::integer`,
      [tenantId, approval.rows[0].id],
    );
    expect(evidenceAfter.rows[0]).toEqual(evidenceBefore.rows[0]);
    const governance = await client.query(
      `SELECT governance_status
         FROM care_pathway_definition_governance
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, governanceId],
    );
    expect(governance.rows[0].governance_status).toBe('retired');
  });

  test('rejects publication when the deciding approver is a patient', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId);
    const patientApproverUid = await seedUser(client, tenantId, 'PATIENT');
    const definition = await seedDefinition(client, tenantId);
    const approval = await seedValidApproval(client, {
      tenantId,
      definitionId: definition.id,
      approverUid: patientApproverUid,
    });
    await insertGovernance(client, {
      tenantId,
      definitionId: definition.id,
      ownerUid,
      approverUid: patientApproverUid,
      approvalId: approval.id,
    });

    await expectStatementFailure(
      client,
      'SET CONSTRAINTS ALL IMMEDIATE',
      [],
      '23514',
      'must be active non-patient tenant users at publication',
    );
  });

  test('allows a deciding approver role change and later retirement without rewriting evidence', async () => {
    const fixture = await seedValidGovernance(client);
    const retirementActorUid = await seedUser(client, fixture.tenantId, 'DOCTOR');
    const evidenceBefore = await client.query(
      `SELECT approved_by, decided_by, decided_at, metadata
         FROM approvals
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.approval.id],
    );
    await client.query(
      `UPDATE users SET role = 'PATIENT'
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      [fixture.tenantId, fixture.approverUid],
    );
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(
      `UPDATE workflow_definitions
          SET is_active = FALSE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.definition.id],
    );
    await client.query(
      `UPDATE care_pathway_definition_governance
          SET governance_status = 'retired',
              retired_by = $1::uuid,
              retired_at = '2026-07-19T09:00:00.000Z'::timestamptz,
              retirement_reason = 'superseded after approval',
              effective_until = '2026-07-19T09:00:00.000Z'::timestamptz,
              updated_at = NOW()
        WHERE tenant_id = $2::uuid AND id = $3::uuid`,
      [retirementActorUid, fixture.tenantId, fixture.governanceId],
    );
    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
      command: 'SET',
    });

    const evidenceAfter = await client.query(
      `SELECT approved_by, decided_by, decided_at, metadata
         FROM approvals
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.approval.id],
    );
    const governance = await client.query(
      `SELECT governance_status, approved_by, retired_by
         FROM care_pathway_definition_governance
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [fixture.tenantId, fixture.governanceId],
    );
    expect(evidenceAfter.rows[0]).toEqual(evidenceBefore.rows[0]);
    expect(governance.rows[0]).toMatchObject({
      governance_status: 'retired',
      approved_by: fixture.approverUid,
      retired_by: retirementActorUid,
    });
  });

  test('rejects governance whose approver or approval time disagrees with the decision', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId);
    const approverUid = await seedUser(client, tenantId, 'ADMIN');
    const otherApproverUid = await seedUser(client, tenantId, 'ADMIN');
    const definition = await seedDefinition(client, tenantId);
    const approval = await seedValidApproval(client, {
      tenantId,
      definitionId: definition.id,
      approverUid,
    });
    await insertGovernance(client, {
      tenantId,
      definitionId: definition.id,
      ownerUid,
      approverUid: otherApproverUid,
      approvalId: approval.id,
      approvedAt: new Date('2026-07-19T07:59:00.000Z'),
    });

    await expectStatementFailure(
      client,
      'SET CONSTRAINTS ALL IMMEDIATE',
      [],
      '23514',
      'invalid approval evidence',
    );
  });

  test('prevents a later approval mutation from invalidating published governance', async () => {
    const fixture = await seedValidGovernance(client);
    await expectStatementFailure(
      client,
      `UPDATE approvals
          SET status = 'rejected', decided_by = NULL, decided_at = NULL
        WHERE id = $1::integer`,
      [fixture.approval.id],
      'P0001',
      'approval evidence is immutable',
    );
  });

  test('prevents a later role mutation from turning a governance actor into a patient', async () => {
    const fixture = await seedValidGovernance(client);
    await client.query(
      `UPDATE users SET role = 'PATIENT'
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      [fixture.tenantId, fixture.ownerUid],
    );

    await expectStatementFailure(
      client,
      'SET CONSTRAINTS ALL IMMEDIATE',
      [],
      '23514',
      'must be non-patient tenant users',
    );
  });

  test('prevents deactivation of a current approved governance owner', async () => {
    const fixture = await seedValidGovernance(client);
    await expectDeferredConstraintFailure(client, {
      statement: `UPDATE users SET is_active = FALSE, updated_at = NOW()
                    WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      params: [fixture.tenantId, fixture.ownerUid],
      constraint: 'trg_users_pathway_governance_non_patient_actors',
      message: 'approved pathway governance owners must be active',
    });
  });

  test('retires with a separate active actor while making former owners historical', async () => {
    const fixture = await seedValidGovernance(client);
    const retirementActorUid = await seedUser(client, fixture.tenantId, 'ADMIN');
    const retiredAt = new Date('2026-07-19T09:00:00.000Z');
    await client.query(
      `UPDATE workflow_definitions
          SET is_active = FALSE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.definition.id],
    );
    await client.query(
      `UPDATE care_pathway_definition_governance
          SET governance_status = 'retired',
              retired_by = $1::uuid,
              retired_at = $2::timestamptz,
              retirement_reason = 'owner duty ended at retirement',
              effective_until = $2::timestamptz,
              updated_at = NOW()
        WHERE tenant_id = $3::uuid AND id = $4::uuid`,
      [retirementActorUid, retiredAt, fixture.tenantId, fixture.governanceId],
    );
    await client.query(
      `UPDATE users SET is_active = FALSE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      [fixture.tenantId, fixture.ownerUid],
    );
    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
      command: 'SET',
    });
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(
      `UPDATE users SET role = 'PATIENT', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      [fixture.tenantId, fixture.ownerUid],
    );
    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
      command: 'SET',
    });

    const governance = await client.query(
      `SELECT governance_status, clinical_owner_uid, operational_owner_uid, retired_by
         FROM care_pathway_definition_governance
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [fixture.tenantId, fixture.governanceId],
    );
    expect(governance.rows[0]).toMatchObject({
      governance_status: 'retired',
      clinical_owner_uid: fixture.ownerUid,
      operational_owner_uid: fixture.ownerUid,
      retired_by: retirementActorUid,
    });
  });

  test('keeps approved definition content immutable but permits activation bookkeeping', async () => {
    const fixture = await seedValidGovernance(client);

    await expectStatementFailure(
      client,
      `UPDATE workflow_definitions SET description = 'mutated'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.definition.id],
      'P0001',
      'approved or retired pathway definitions are immutable',
    );
    await expectStatementFailure(
      client,
      `DELETE FROM workflow_definitions
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.definition.id],
      'P0001',
      'approved or retired pathway definitions are immutable',
    );

    const updated = await client.query(
      `UPDATE workflow_definitions
          SET is_active = TRUE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer
        RETURNING is_active`,
      [fixture.tenantId, fixture.definition.id],
    );
    expect(updated.rows[0].is_active).toBe(true);
  });

  test('requires exactly one pathway companion for a governed run at commit', async () => {
    const fixture = await seedValidGovernance(client);
    await client.query(
      `UPDATE workflow_definitions
          SET is_active = TRUE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.definition.id],
    );
    await seedRun(client, fixture.tenantId, fixture.definition, {
      governanceId: fixture.governanceId,
      definitionChecksum: CHECKSUM,
    });

    await expectStatementFailure(
      client,
      'SET CONSTRAINTS ALL IMMEDIATE',
      [],
      '23514',
      'requires one exact published pinned pathway companion',
    );
  });

  test('accepts a governed run and its pathway companion in the same transaction', async () => {
    const fixture = await seedValidGovernance(client);
    await seedPinnedPathwayRuntime(client, fixture);

    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
      command: 'SET',
    });
  });

  test('rejects an unpinned run for every governed definition before materialization', async () => {
    const fixture = await seedValidGovernance(client);
    await client.query(
      `UPDATE workflow_definitions
          SET is_active = TRUE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.definition.id],
    );
    await expectStatementFailure(
      client,
      `INSERT INTO workflow_runs
         (tenant_id, workflow_definition_id, workflow_key, workflow_version, trigger_kind)
       VALUES ($1::uuid, $2::integer, $3::text, $4::integer, 'manual')`,
      [
        fixture.tenantId,
        fixture.definition.id,
        fixture.definition.workflow_key,
        fixture.definition.version,
      ],
      '23514',
      'require an active approved effective definition checksum pin',
    );
  });

  test('rejects pathway pins on an ungoverned workflow run', async () => {
    const tenantId = await seedTenant(client);
    const definition = await seedDefinition(client, tenantId);
    await expectStatementFailure(
      client,
      `INSERT INTO workflow_runs
         (tenant_id, workflow_definition_id, workflow_key, workflow_version, trigger_kind,
          pathway_governance_id, pathway_definition_checksum)
       VALUES ($1::uuid, $2::integer, $3::text, $4::integer, 'manual',
               $5::uuid, $6::char(64))`,
      [tenantId, definition.id, definition.workflow_key, definition.version, randomUUID(), CHECKSUM],
      '23514',
      'ungoverned workflow runs cannot carry',
    );
  });

  test('rejects every fresh workflow run without an explicit definition id', async () => {
    const tenantId = await seedTenant(client);
    await expectStatementFailure(
      client,
      `INSERT INTO workflow_runs
         (tenant_id, workflow_definition_id, workflow_key, workflow_version, trigger_kind)
       VALUES ($1::uuid, NULL, $2::text, 1, 'manual')`,
      [tenantId, `legacy_${token()}`],
      '23514',
      'require an explicit workflow definition identity',
    );
  });

  test('rejects manual definition detachment while preserving FK-driven historical nulling', async () => {
    const tenantId = await seedTenant(client);
    const definition = await seedDefinition(client, tenantId);
    const runId = await seedRun(client, tenantId, definition);
    await expectStatementFailure(
      client,
      `UPDATE workflow_runs SET workflow_definition_id = NULL
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, runId],
      'P0001',
      'cannot be detached while its definition exists',
    );

    await client.query(
      `DELETE FROM workflow_definitions
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, definition.id],
    );
    const historical = await client.query(
      `SELECT workflow_definition_id, workflow_key, workflow_version,
              pathway_governance_id, pathway_definition_checksum
         FROM workflow_runs
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, runId],
    );
    expect(historical.rows[0]).toMatchObject({
      workflow_definition_id: null,
      workflow_key: definition.workflow_key,
      workflow_version: definition.version,
      pathway_governance_id: null,
      pathway_definition_checksum: null,
    });

    await expectStatementFailure(
      client,
      `UPDATE workflow_runs SET workflow_key = $1::text
        WHERE tenant_id = $2::uuid AND id = $3::integer`,
      [`mutated_${token()}`, tenantId, runId],
      'P0001',
      'historical null-definition workflow run identity is immutable',
    );

    const replacement = await client.query(
      `INSERT INTO workflow_definitions
         (tenant_id, workflow_key, version, display_name, steps, triggers, defaults)
       VALUES ($1::uuid, $2::text, $3::integer,
               'Replacement definition', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
       RETURNING id`,
      [tenantId, definition.workflow_key, definition.version],
    );
    await expectStatementFailure(
      client,
      `UPDATE workflow_runs SET workflow_definition_id = $1::integer
        WHERE tenant_id = $2::uuid AND id = $3::integer`,
      [replacement.rows[0].id, tenantId, runId],
      'P0001',
      'historical null-definition workflow run identity is immutable',
    );
  });

  test('blocks governance publication over a recreated definition that matches a hidden null-id run', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId);
    const approverUid = await seedUser(client, tenantId, 'ADMIN');
    const original = await seedDefinition(client, tenantId);
    const runId = await seedRun(client, tenantId, original);
    await client.query(
      `DELETE FROM workflow_definitions
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, original.id],
    );
    const recreated = await client.query(
      `INSERT INTO workflow_definitions
         (tenant_id, workflow_key, version, display_name, steps, triggers, defaults)
       VALUES ($1::uuid, $2::text, $3::integer,
               'Recreated definition', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
       RETURNING id, workflow_key, version`,
      [tenantId, original.workflow_key, original.version],
    );
    const definition = recreated.rows[0];
    const approval = await seedValidApproval(client, {
      tenantId,
      definitionId: definition.id,
      approverUid,
    });
    await insertGovernance(client, {
      tenantId,
      definitionId: definition.id,
      ownerUid,
      approverUid,
      approvalId: approval.id,
    });

    await expectStatementFailure(
      client,
      'SET CONSTRAINTS ALL IMMEDIATE',
      [],
      '23514',
      'requires one exact published pinned pathway companion',
    );
    const historical = await client.query(
      `SELECT workflow_definition_id, workflow_key, workflow_version
         FROM workflow_runs
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [tenantId, runId],
    );
    expect(historical.rows[0]).toMatchObject({
      workflow_definition_id: null,
      workflow_key: original.workflow_key,
      workflow_version: original.version,
    });
  });

  test('rejects publishing governance over an existing generic unpinned run', async () => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId);
    const approverUid = await seedUser(client, tenantId, 'ADMIN');
    const definition = await seedDefinition(client, tenantId);
    await seedRun(client, tenantId, definition);
    const approval = await seedValidApproval(client, {
      tenantId,
      definitionId: definition.id,
      approverUid,
    });
    await insertGovernance(client, {
      tenantId,
      definitionId: definition.id,
      ownerUid,
      approverUid,
      approvalId: approval.id,
    });

    await expectStatementFailure(
      client,
      'SET CONSTRAINTS ALL IMMEDIATE',
      [],
      '23514',
      'requires one exact published pinned pathway companion',
    );
  });

  test('rejects a later second pathway creation event through the event-side constraint trigger', async () => {
    const fixture = await seedValidGovernance(client);
    const runtime = await seedPinnedPathwayRuntime(client, fixture);
    const evidence = await seedCanonicalEvidence(client, fixture.tenantId, runtime.patientUid);
    await client.query(
      `INSERT INTO care_pathway_transition_events
         (tenant_id, pathway_instance_id, patient_uid, workflow_run_id,
          sequence_number, transition_scope, transition_key,
          system_actor_key, occurred_at, idempotency_key,
          command_fingerprint, effect_ordinal,
          canonical_timeline_event_id, canonical_audit_event_id,
          event_payload, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::integer,
               2, 'pathway', 'pathway_instance_created',
               'test_harness.v1', NOW(), $5::text,
               $6::char(64), 0, $7::uuid, $8::uuid,
               '{}'::jsonb, '{}'::jsonb)`,
      [
        fixture.tenantId,
        runtime.instanceId,
        runtime.patientUid,
        runtime.runId,
        `duplicate-start-${token()}`,
        'c'.repeat(64),
        evidence.timelineId,
        evidence.auditId,
      ],
    );

    await expectStatementFailure(
      client,
      'SET CONSTRAINTS trg_care_pathway_creation_event_run_companion IMMEDIATE',
      [],
      '23514',
      'lacks one exact immutable pathway creation pin',
    );
  });

  test('allows a pinned in-flight run to update after retirement and allows later actor deactivation', async () => {
    const fixture = await seedValidGovernance(client);
    const runtime = await seedPinnedPathwayRuntime(client, fixture);
    const retirementActorUid = await seedUser(client, fixture.tenantId, 'DOCTOR');
    const retiredAt = new Date('2026-07-19T09:00:00.000Z');
    await client.query(
      `UPDATE workflow_definitions
          SET is_active = FALSE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.definition.id],
    );
    await client.query(
      `UPDATE care_pathway_definition_governance
          SET governance_status = 'retired',
              retired_by = $1::uuid,
              retired_at = $2::timestamptz,
              retirement_reason = 'superseded by a governed version',
              effective_until = $2::timestamptz,
              updated_at = NOW()
        WHERE tenant_id = $3::uuid AND id = $4::uuid`,
      [retirementActorUid, retiredAt, fixture.tenantId, fixture.governanceId],
    );
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    const updatedRun = await client.query(
      `UPDATE workflow_runs
          SET status = 'running',
              workflow_definition_id = workflow_definition_id,
              workflow_key = workflow_key,
              workflow_version = workflow_version,
              pathway_governance_id = pathway_governance_id,
              pathway_definition_checksum = pathway_definition_checksum,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer
        RETURNING status`,
      [fixture.tenantId, runtime.runId],
    );
    expect(updatedRun.rows[0].status).toBe('running');

    await client.query(
      `UPDATE users SET is_active = FALSE
        WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
      [fixture.tenantId, retirementActorUid],
    );
    await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).resolves.toMatchObject({
      command: 'SET',
    });

    await expectStatementFailure(
      client,
      `UPDATE workflow_definitions
          SET is_active = TRUE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.definition.id],
      'P0001',
      'cannot be re-enabled',
    );
    await expectStatementFailure(
      client,
      `UPDATE care_pathway_definition_governance
          SET retirement_reason = 'rewritten terminal evidence', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [fixture.tenantId, fixture.governanceId],
      'P0001',
      'terminal and immutable',
    );
    await expectStatementFailure(
      client,
      `INSERT INTO workflow_runs
         (tenant_id, workflow_definition_id, workflow_key, workflow_version, trigger_kind,
          pathway_governance_id, pathway_definition_checksum)
       VALUES ($1::uuid, $2::integer, $3::text, $4::integer, 'manual',
               $5::uuid, $6::char(64))`,
      [
        fixture.tenantId,
        fixture.definition.id,
        fixture.definition.workflow_key,
        fixture.definition.version,
        fixture.governanceId,
        CHECKSUM,
      ],
      '23514',
      'require an active approved effective definition checksum pin',
    );
  });

  test.each([
    ['patient', 'patient'],
    ['inactive staff', 'inactive'],
  ])('rejects a %s retirement actor at retirement time', async (_label, actorKind) => {
    const fixture = await seedValidGovernance(client);
    const actorUid = await seedUser(
      client,
      fixture.tenantId,
      actorKind === 'patient' ? 'PATIENT' : 'DOCTOR',
    );
    if (actorKind === 'inactive') {
      await client.query(
        `UPDATE users SET is_active = FALSE
          WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
        [fixture.tenantId, actorUid],
      );
    }
    await client.query(
      `UPDATE workflow_definitions
          SET is_active = FALSE, updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.definition.id],
    );
    await client.query(
      `UPDATE care_pathway_definition_governance
          SET governance_status = 'retired',
              retired_by = $1::uuid,
              retired_at = '2026-07-19T09:00:00.000Z'::timestamptz,
              retirement_reason = 'invalid actor test',
              effective_until = '2026-07-19T09:00:00.000Z'::timestamptz,
              updated_at = NOW()
        WHERE tenant_id = $2::uuid AND id = $3::uuid`,
      [actorUid, fixture.tenantId, fixture.governanceId],
    );

    await expectStatementFailure(
      client,
      'SET CONSTRAINTS trg_care_pathway_governance_retirement_actor IMMEDIATE',
      [],
      '23514',
      'active non-patient tenant user',
    );
  });

  test.each([
    [
      'retired_at before approved_at',
      '2026-07-19T07:59:00.000Z',
      '2026-07-19T07:59:00.000Z',
    ],
    [
      'effective_until after retired_at',
      '2026-07-19T09:00:00.000Z',
      '2026-07-19T09:01:00.000Z',
    ],
  ])('rejects contradictory retirement chronology: %s', async (_label, retiredAt, effectiveUntil) => {
    const fixture = await seedValidGovernance(client);
    const actorUid = await seedUser(client, fixture.tenantId, 'DOCTOR');
    await expectStatementFailure(
      client,
      `UPDATE care_pathway_definition_governance
          SET governance_status = 'retired',
              retired_by = $1::uuid,
              retired_at = $2::timestamptz,
              retirement_reason = 'chronology test',
              effective_until = $3::timestamptz,
              updated_at = NOW()
        WHERE tenant_id = $4::uuid AND id = $5::uuid`,
      [actorUid, retiredAt, effectiveUntil, fixture.tenantId, fixture.governanceId],
      'P0001',
      'may only retire with terminal evidence',
    );
  });

  test('installs the tenant-leading retirement actor index', async () => {
    const result = await client.query(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_care_pathway_governance_retired_by'`,
    );
    expect(result.rows[0].indexdef).toContain('(tenant_id, retired_by)');
    expect(result.rows[0].indexdef).toContain('WHERE (retired_by IS NOT NULL)');
  });

  test('installs the exact unique pathway companion definition pin for Prisma introspection', async () => {
    const result = await client.query(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'ux_care_pathway_instances_run_definition_pin'`,
    );
    expect(result.rows[0].indexdef).toContain('UNIQUE INDEX');
    expect(result.rows[0].indexdef).toContain(
      '(tenant_id, workflow_run_id, workflow_definition_id, definition_governance_id, definition_checksum)',
    );
  });

  test.each([
    ['non-string', 42],
    ['whitespace-modified', ` ${CHECKSUM}`],
  ])('rejects a %s approval checksum receipt', async (_label, receipt) => {
    const tenantId = await seedTenant(client);
    const ownerUid = await seedUser(client, tenantId);
    const approverUid = await seedUser(client, tenantId, 'ADMIN');
    const definition = await seedDefinition(client, tenantId);
    const approval = await seedValidApproval(client, {
      tenantId,
      definitionId: definition.id,
      approverUid,
    });
    await client.query(
      `UPDATE approvals
          SET metadata = jsonb_build_object(
            'care_pathway_definition_governance',
            jsonb_build_object('definition_checksum', $1::jsonb)
          )
        WHERE tenant_id = $2::uuid AND id = $3::integer`,
      [JSON.stringify(receipt), tenantId, approval.id],
    );
    await insertGovernance(client, {
      tenantId,
      definitionId: definition.id,
      ownerUid,
      approverUid,
      approvalId: approval.id,
    });

    await expectStatementFailure(
      client,
      'SET CONSTRAINTS trg_care_pathway_governance_checksum_receipt IMMEDIATE',
      [],
      '23514',
      'approval checksum receipt is invalid',
    );
  });

  test.each([
    [
      'timeline patient',
      'trg_clinical_timeline_pathway_creation_companion',
      async (fixture, runtime) => {
        const otherPatientUid = await seedUser(client, fixture.tenantId, 'PATIENT');
        return {
          statement: `UPDATE clinical_timeline_events SET patient_uid = $1::uuid
                       WHERE tenant_id = $2::uuid AND id = $3::uuid`,
          params: [otherPatientUid, fixture.tenantId, runtime.timelineId],
        };
      },
    ],
    [
      'timeline transition resource',
      'trg_clinical_timeline_pathway_creation_companion',
      async (fixture, runtime) => ({
        statement: `UPDATE clinical_timeline_events SET resource_id = $1::text
                     WHERE tenant_id = $2::uuid AND id = $3::uuid`,
        params: [randomUUID(), fixture.tenantId, runtime.timelineId],
      }),
    ],
    [
      'audit action',
      'trg_clinical_audit_pathway_creation_companion',
      async (fixture, runtime) => {
        await client.query("SET LOCAL app.audit_bypass = 'on'");
        return {
          statement: `UPDATE clinical_audit_events SET action = 'care_pathway.wrong'
                       WHERE tenant_id = $1::uuid AND id = $2::uuid`,
          params: [fixture.tenantId, runtime.auditId],
        };
      },
    ],
  ])('rejects a canonical creation parent with the wrong %s', async (
    _label,
    constraint,
    mutation,
  ) => {
    const fixture = await seedValidGovernance(client);
    const runtime = await seedPinnedPathwayRuntime(client, fixture);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    const { statement, params } = await mutation(fixture, runtime);

    await expectDeferredConstraintFailure(client, {
      statement,
      params,
      constraint,
      message: 'lacks one exact immutable pathway creation pin',
    });
  });

  test.each([
    [
      'timeline',
      'trg_care_pathway_creation_event_run_companion',
      (fixture, runtime) => ({
        statement: `DELETE FROM clinical_timeline_events
                      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        params: [fixture.tenantId, runtime.timelineId],
      }),
    ],
    [
      'audit',
      'trg_care_pathway_creation_event_run_companion',
      (fixture, runtime) => ({
        statement: `DELETE FROM clinical_audit_events
                      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        params: [fixture.tenantId, runtime.auditId],
      }),
    ],
  ])('rejects deletion of a canonical %s creation parent', async (
    label,
    constraint,
    mutation,
  ) => {
    const fixture = await seedValidGovernance(client);
    const runtime = await seedPinnedPathwayRuntime(client, fixture);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    if (label === 'audit') await client.query("SET LOCAL app.audit_bypass = 'on'");
    const { statement, params } = mutation(fixture, runtime);

    await expectDeferredConstraintFailure(client, {
      statement,
      params,
      constraint,
      message: 'lacks one exact immutable pathway creation pin',
    });
  });

  test('keeps deferred companion validation free of row-lock clauses', async () => {
    const result = await client.query(
      `SELECT pg_get_functiondef(
         'care_pathway_assert_run_companion(integer)'::regprocedure
       ) AS definition`,
    );
    expect(result.rows[0].definition).not.toMatch(/FOR\s+(KEY\s+)?SHARE/i);
    expect(result.rows[0].definition).not.toMatch(/FOR\s+UPDATE/i);
  });

  test('blocks direct transition-link nulling but permits FK SET NULL after parent deletion', async () => {
    const fixture = await seedValidGovernance(client);
    const runtime = await seedPinnedPathwayRuntime(client, fixture);
    const { tenantId } = fixture;
    const { patientUid, runId, instanceId } = runtime;
    const step = await client.query(
      `INSERT INTO workflow_steps
         (tenant_id, workflow_run_id, step_key, step_kind, ordering)
       VALUES ($1::uuid, $2::integer, 'review', 'task', 1)
       RETURNING id`,
      [tenantId, runId],
    );
    const evidence = await seedCanonicalEvidence(client, tenantId, patientUid);

    await expectStatementFailure(
      client,
      `INSERT INTO care_pathway_transition_events
         (tenant_id, pathway_instance_id, patient_uid, workflow_run_id,
          sequence_number, transition_scope, transition_key,
          system_actor_key, occurred_at, idempotency_key,
          command_fingerprint, effect_ordinal)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::integer,
                2, 'pathway', 'created', 'test_harness', NOW(), $5::text,
               $6::text, 0)`,
      [
        tenantId,
        instanceId,
        patientUid,
        runId,
        token(),
        'b'.repeat(64),
      ],
      '23514',
      'requires canonical timeline and audit evidence',
    );

    await expectStatementFailure(
      client,
      `INSERT INTO care_pathway_transition_events
         (tenant_id, pathway_instance_id, patient_uid, workflow_run_id,
          sequence_number, transition_scope, transition_key, stage_key, workflow_step_id,
          system_actor_key, occurred_at, idempotency_key,
          command_fingerprint, effect_ordinal,
          canonical_timeline_event_id, canonical_audit_event_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::integer,
                2, 'step', 'started', 'wrong-stage', $5::integer,
               'test_harness', NOW(), $6::text, $7::text, 0,
               $8::uuid, $9::uuid)`,
      [
        tenantId,
        instanceId,
        patientUid,
        runId,
        step.rows[0].id,
        token(),
        'b'.repeat(64),
        evidence.timelineId,
        evidence.auditId,
      ],
      '23503',
      'fk_care_pathway_transition_step',
    );
    const sla = await client.query(
      `INSERT INTO workflow_sla_instances
         (tenant_id, rule_code, patient_uid, status, due_at)
       VALUES ($1::uuid, 'pathway_test', $2::uuid, 'active', NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [tenantId, patientUid],
    );
    const transition = await client.query(
      `INSERT INTO care_pathway_transition_events
         (tenant_id, pathway_instance_id, patient_uid, workflow_run_id,
          sequence_number, transition_scope, transition_key,
          workflow_sla_instance_id, system_actor_key, occurred_at,
          idempotency_key, command_fingerprint, effect_ordinal,
          canonical_timeline_event_id, canonical_audit_event_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::integer,
                2, 'pathway', 'created', $5::uuid, 'test_harness', NOW(),
               $6::text, $7::text, 0, $8::uuid, $9::uuid)
       RETURNING id`,
      [
        tenantId,
        instanceId,
        patientUid,
        runId,
        sla.rows[0].id,
        token(),
        'b'.repeat(64),
        evidence.timelineId,
        evidence.auditId,
      ],
    );

    await expectStatementFailure(
      client,
      `UPDATE care_pathway_transition_events
          SET workflow_sla_instance_id = NULL
        WHERE id = $1::uuid`,
      [transition.rows[0].id],
      'P0001',
      'append-only',
    );

    await client.query(
      'DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid AND id = $2::uuid',
      [tenantId, sla.rows[0].id],
    );
    await client.query(
      'DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid AND id = $2::uuid',
      [tenantId, evidence.timelineId],
    );
    await client.query(
      'DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid AND id = $2::uuid',
      [tenantId, evidence.auditId],
    );
    const result = await client.query(
      `SELECT workflow_sla_instance_id,
              canonical_timeline_event_id,
              canonical_audit_event_id
         FROM care_pathway_transition_events
        WHERE id = $1::uuid`,
      [transition.rows[0].id],
    );
    expect(result.rows[0].workflow_sla_instance_id).toBeNull();
    expect(result.rows[0].canonical_timeline_event_id).toBeNull();
    expect(result.rows[0].canonical_audit_event_id).toBeNull();
  });

  test('fails fast when workflow runs acquire definition fences in opposite order', async () => {
    const setup = new Client({ connectionString: databaseUrl });
    const leftWriter = new Client({ connectionString: databaseUrl });
    const rightWriter = new Client({ connectionString: databaseUrl });
    await Promise.all([setup.connect(), leftWriter.connect(), rightWriter.connect()]);
    try {
      await beginConcurrent(setup);
      const tenantId = await seedTenant(setup);
      const leftDefinition = await seedDefinition(setup, tenantId);
      const rightDefinition = await seedDefinition(setup, tenantId);
      await setup.query('SET CONSTRAINTS ALL IMMEDIATE');
      await setup.query('COMMIT');

      await Promise.all([beginConcurrent(leftWriter), beginConcurrent(rightWriter)]);
      await seedRun(leftWriter, tenantId, leftDefinition);
      await seedRun(rightWriter, tenantId, rightDefinition);

      const failures = await Promise.all([
        captureFailure(seedRun(leftWriter, tenantId, rightDefinition)),
        captureFailure(seedRun(rightWriter, tenantId, leftDefinition)),
      ]);
      expectOppositeFenceContention(failures);
    } finally {
      await Promise.all([
        setup.query('ROLLBACK').catch(() => {}),
        leftWriter.query('ROLLBACK').catch(() => {}),
        rightWriter.query('ROLLBACK').catch(() => {}),
      ]);
      await Promise.all([setup.end(), leftWriter.end(), rightWriter.end()]);
    }
  }, 30_000);

  test('fails fast when governance publications acquire definition fences in opposite order', async () => {
    const setup = new Client({ connectionString: databaseUrl });
    const leftPublisher = new Client({ connectionString: databaseUrl });
    const rightPublisher = new Client({ connectionString: databaseUrl });
    await Promise.all([setup.connect(), leftPublisher.connect(), rightPublisher.connect()]);
    try {
      await beginConcurrent(setup);
      const tenantId = await seedTenant(setup);
      const ownerUid = await seedUser(setup, tenantId);
      const approverUid = await seedUser(setup, tenantId, 'ADMIN');
      const leftDefinition = await seedDefinition(setup, tenantId);
      const rightDefinition = await seedDefinition(setup, tenantId);
      const leftApproval = await seedValidApproval(setup, {
        tenantId,
        definitionId: leftDefinition.id,
        approverUid,
      });
      const rightApproval = await seedValidApproval(setup, {
        tenantId,
        definitionId: rightDefinition.id,
        approverUid,
      });
      const leftFixture = {
        tenantId,
        ownerUid,
        approverUid,
        definition: leftDefinition,
        approval: leftApproval,
      };
      const rightFixture = {
        tenantId,
        ownerUid,
        approverUid,
        definition: rightDefinition,
        approval: rightApproval,
      };
      await setup.query('SET CONSTRAINTS ALL IMMEDIATE');
      await setup.query('COMMIT');

      await Promise.all([beginConcurrent(leftPublisher), beginConcurrent(rightPublisher)]);
      await publishFixtureGovernance(leftPublisher, leftFixture);
      await publishFixtureGovernance(rightPublisher, rightFixture);

      const failures = await Promise.all([
        captureFailure(publishFixtureGovernance(leftPublisher, rightFixture)),
        captureFailure(publishFixtureGovernance(rightPublisher, leftFixture)),
      ]);
      expectOppositeFenceContention(failures);
    } finally {
      await Promise.all([
        setup.query('ROLLBACK').catch(() => {}),
        leftPublisher.query('ROLLBACK').catch(() => {}),
        rightPublisher.query('ROLLBACK').catch(() => {}),
      ]);
      await Promise.all([setup.end(), leftPublisher.end(), rightPublisher.end()]);
    }
  }, 30_000);

  test.each(['run_first', 'publication_first'])(
    'serializes a first generic run and first governance publication: %s',
    async (ordering) => {
      const setup = new Client({ connectionString: databaseUrl });
      const runWriter = new Client({ connectionString: databaseUrl });
      const publisher = new Client({ connectionString: databaseUrl });
      await Promise.all([setup.connect(), runWriter.connect(), publisher.connect()]);
      try {
        await beginConcurrent(setup);
        const fixture = await seedPublicationFixture(setup);
        await setup.query('SET CONSTRAINTS ALL IMMEDIATE');
        await setup.query('COMMIT');

        if (ordering === 'run_first') {
          await beginConcurrent(runWriter);
          const runId = await seedRun(runWriter, fixture.tenantId, fixture.definition);
          await beginConcurrent(publisher);
          const serializationFailure = await captureFailure(
            publishFixtureGovernance(publisher, fixture),
          );
          expect(serializationFailure).toMatchObject({ code: '40001' });
          expect(serializationFailure.code).not.toBe('40P01');
          await publisher.query('ROLLBACK');
          await runWriter.query('SET CONSTRAINTS ALL IMMEDIATE');
          await runWriter.query('COMMIT');

          await beginConcurrent(publisher);
          await publishFixtureGovernance(publisher, fixture);
          const failure = await captureFailure(
            publisher.query('SET CONSTRAINTS ALL IMMEDIATE'),
          );
          expect(failure).toMatchObject({ code: '23514' });
          expect(failure.code).not.toBe('40P01');
          expect(failure.message).toContain('requires one exact published pinned pathway companion');
          await publisher.query('ROLLBACK');

          const final = await setup.query(
            `SELECT
               EXISTS (SELECT 1 FROM workflow_runs WHERE id = $1::integer) AS run_exists,
               EXISTS (
                 SELECT 1 FROM care_pathway_definition_governance
                  WHERE tenant_id = $2::uuid AND workflow_definition_id = $3::integer
               ) AS governance_exists`,
            [runId, fixture.tenantId, fixture.definition.id],
          );
          expect(final.rows[0]).toEqual({ run_exists: true, governance_exists: false });
        } else {
          await beginConcurrent(publisher);
          await publishFixtureGovernance(publisher, fixture);
          await publisher.query('SET CONSTRAINTS ALL IMMEDIATE');
          await beginConcurrent(runWriter);
          const serializationFailure = await captureFailure(
            seedRun(runWriter, fixture.tenantId, fixture.definition),
          );
          expect(serializationFailure).toMatchObject({ code: '40001' });
          expect(serializationFailure.code).not.toBe('40P01');
          await runWriter.query('ROLLBACK');
          await publisher.query('COMMIT');

          await beginConcurrent(runWriter);
          const failure = await captureFailure(
            seedRun(runWriter, fixture.tenantId, fixture.definition),
          );
          expect(failure).toMatchObject({ code: '23514' });
          expect(failure.code).not.toBe('40P01');
          expect(failure.message).toContain('require an active approved effective definition checksum pin');
          await runWriter.query('ROLLBACK');
        }
      } finally {
        await Promise.all([
          setup.query('ROLLBACK').catch(() => {}),
          runWriter.query('ROLLBACK').catch(() => {}),
          publisher.query('ROLLBACK').catch(() => {}),
        ]);
        await Promise.all([setup.end(), runWriter.end(), publisher.end()]);
      }
    },
    30_000,
  );

  test.each([
    ['owner', 'publication_first'],
    ['owner', 'actor_change_first'],
    ['voter', 'publication_first'],
    ['voter', 'actor_change_first'],
  ])('serializes %s eligibility with publication: %s', async (actorKind, ordering) => {
    const setup = new Client({ connectionString: databaseUrl });
    const actorWriter = new Client({ connectionString: databaseUrl });
    const publisher = new Client({ connectionString: databaseUrl });
    await Promise.all([setup.connect(), actorWriter.connect(), publisher.connect()]);
    try {
      await beginConcurrent(setup);
      const fixture = await seedPublicationFixture(setup);
      await setup.query('SET CONSTRAINTS ALL IMMEDIATE');
      await setup.query('COMMIT');
      const targetUid = actorKind === 'owner' ? fixture.ownerUid : fixture.voterUid;
      const actorChange = () => actorWriter.query(
        `UPDATE users SET is_active = FALSE, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
        [fixture.tenantId, targetUid],
      );

      if (ordering === 'publication_first') {
        await beginConcurrent(publisher);
        await publishFixtureGovernance(publisher, fixture);
        await publisher.query('SET CONSTRAINTS ALL IMMEDIATE');
        await beginConcurrent(actorWriter);
        const changed = actorChange();
        await waitForBackendLock(client, actorWriter.processID);
        await publisher.query('COMMIT');
        await expect(changed).resolves.toMatchObject({ rowCount: 1 });
        const actorConstraint = await captureFailure(
          actorWriter.query('SET CONSTRAINTS ALL IMMEDIATE'),
        );
        if (actorKind === 'owner') {
          expect(actorConstraint).toMatchObject({ code: '23514' });
          expect(actorConstraint.code).not.toBe('40P01');
          expect(actorConstraint.message).toContain('owners must be active');
          await actorWriter.query('ROLLBACK');
        } else {
          expect(actorConstraint).toBeNull();
          await actorWriter.query('COMMIT');
        }
      } else {
        await beginConcurrent(actorWriter);
        await actorChange();
        await beginConcurrent(publisher);
        const serializationFailure = await captureFailure(
          publishFixtureGovernance(publisher, fixture),
        );
        expect(serializationFailure).toMatchObject({ code: '40001' });
        expect(serializationFailure.code).not.toBe('40P01');
        await publisher.query('ROLLBACK');
        await actorWriter.query('COMMIT');

        await beginConcurrent(publisher);
        await publishFixtureGovernance(publisher, fixture);
        const failure = await captureFailure(
          publisher.query('SET CONSTRAINTS ALL IMMEDIATE'),
        );
        expect(failure).toMatchObject({ code: '23514' });
        expect(failure.code).not.toBe('40P01');
        expect(failure.message).toContain(
          actorKind === 'owner'
            ? 'owners must be active'
            : 'voters must be active non-patient tenant users at publication',
        );
        await publisher.query('ROLLBACK');
      }
    } finally {
      await Promise.all([
        setup.query('ROLLBACK').catch(() => {}),
        actorWriter.query('ROLLBACK').catch(() => {}),
        publisher.query('ROLLBACK').catch(() => {}),
      ]);
      await Promise.all([setup.end(), actorWriter.end(), publisher.end()]);
    }
  }, 30_000);

  test.each([
    ['approval receipt', 'publication_first'],
    ['approval receipt', 'evidence_change_first'],
    ['definition content', 'publication_first'],
    ['definition content', 'evidence_change_first'],
  ])('serializes %s mutation with publication: %s', async (surface, ordering) => {
    const setup = new Client({ connectionString: databaseUrl });
    const evidenceWriter = new Client({ connectionString: databaseUrl });
    const publisher = new Client({ connectionString: databaseUrl });
    await Promise.all([setup.connect(), evidenceWriter.connect(), publisher.connect()]);
    try {
      await beginConcurrent(setup);
      const fixture = await seedPublicationFixture(setup);
      await setup.query('SET CONSTRAINTS ALL IMMEDIATE');
      await setup.query('COMMIT');
      const mutateEvidence = () => (
        surface === 'approval receipt'
          ? evidenceWriter.query(
            `UPDATE approvals SET status = 'pending'
              WHERE tenant_id = $1::uuid AND id = $2::integer`,
            [fixture.tenantId, fixture.approval.id],
          )
          : evidenceWriter.query(
            `UPDATE workflow_definitions SET description = 'concurrent mutation'
              WHERE tenant_id = $1::uuid AND id = $2::integer`,
            [fixture.tenantId, fixture.definition.id],
          )
      );

      if (ordering === 'publication_first') {
        await beginConcurrent(publisher);
        await publishFixtureGovernance(publisher, fixture);
        await publisher.query('SET CONSTRAINTS ALL IMMEDIATE');
        await beginConcurrent(evidenceWriter);
        const failure = await captureFailure(mutateEvidence());
        expect(failure).toMatchObject({ code: '40001' });
        expect(failure.code).not.toBe('40P01');
        expect(failure.message).toContain('serialization fence is busy');
        await evidenceWriter.query('ROLLBACK');
        await publisher.query('COMMIT');

        await beginConcurrent(evidenceWriter);
        const retryFailure = await captureFailure(mutateEvidence());
        expect(retryFailure).toMatchObject({ code: 'P0001' });
        expect(retryFailure.code).not.toBe('40P01');
        expect(retryFailure.message).toContain(
          surface === 'approval receipt'
            ? 'approval evidence is immutable'
            : 'pathway definitions are immutable',
        );
        await evidenceWriter.query('ROLLBACK');
      } else {
        await beginConcurrent(evidenceWriter);
        await mutateEvidence();
        await beginConcurrent(publisher);
        const serializationFailure = await captureFailure(
          publishFixtureGovernance(publisher, fixture),
        );
        expect(serializationFailure).toMatchObject({ code: '40001' });
        expect(serializationFailure.code).not.toBe('40P01');
        await publisher.query('ROLLBACK');
        await evidenceWriter.query('COMMIT');
        await beginConcurrent(publisher);
        await publishFixtureGovernance(publisher, fixture);
        const publicationFailure = await captureFailure(
          publisher.query('SET CONSTRAINTS ALL IMMEDIATE'),
        );
        if (surface === 'approval receipt') {
          expect(publicationFailure).toMatchObject({ code: '23514' });
          expect(publicationFailure.code).not.toBe('40P01');
          await publisher.query('ROLLBACK');
        } else {
          expect(publicationFailure).toBeNull();
          await publisher.query('COMMIT');
          const definition = await setup.query(
            `SELECT description FROM workflow_definitions
              WHERE tenant_id = $1::uuid AND id = $2::integer`,
            [fixture.tenantId, fixture.definition.id],
          );
          expect(definition.rows[0].description).toBe('concurrent mutation');
        }
      }
    } finally {
      await Promise.all([
        setup.query('ROLLBACK').catch(() => {}),
        evidenceWriter.query('ROLLBACK').catch(() => {}),
        publisher.query('ROLLBACK').catch(() => {}),
      ]);
      await Promise.all([setup.end(), evidenceWriter.end(), publisher.end()]);
    }
  }, 30_000);

  test.each(['start_first', 'retirement_first'])(
    'serializes fresh pathway start with definition retirement: %s',
    async (ordering) => {
      const setup = new Client({ connectionString: databaseUrl });
      const starter = new Client({ connectionString: databaseUrl });
      const retiree = new Client({ connectionString: databaseUrl });
      await Promise.all([setup.connect(), starter.connect(), retiree.connect()]);
      try {
        await beginConcurrent(setup);
        const fixture = await seedValidGovernance(setup);
        const retirementActorUid = await seedUser(setup, fixture.tenantId, 'ADMIN');
        await setup.query(
          `UPDATE workflow_definitions SET is_active = TRUE, updated_at = NOW()
            WHERE tenant_id = $1::uuid AND id = $2::integer`,
          [fixture.tenantId, fixture.definition.id],
        );
        await setup.query('SET CONSTRAINTS ALL IMMEDIATE');
        await setup.query('COMMIT');

        if (ordering === 'start_first') {
          await beginConcurrent(starter);
          await starter.query(
            `SELECT care_pathway_acquire_serialization_fences(ARRAY[
               care_pathway_definition_fence_key($1::uuid, $2::integer)
             ])`,
            [fixture.tenantId, fixture.definition.id],
          );
          const runtime = await seedPinnedPathwayRuntime(starter, fixture, {
            activateDefinition: false,
          });
          await starter.query('SET CONSTRAINTS ALL IMMEDIATE');

          await beginConcurrent(retiree);
          const firstRetirement = await captureFailure(retiree.query(
            `UPDATE workflow_definitions SET is_active = FALSE, updated_at = NOW()
              WHERE tenant_id = $1::uuid AND id = $2::integer`,
            [fixture.tenantId, fixture.definition.id],
          ));
          expect(firstRetirement).toMatchObject({ code: '40001' });
          expect(firstRetirement.code).not.toBe('40P01');
          await retiree.query('ROLLBACK');
          await starter.query('COMMIT');

          await beginConcurrent(retiree);
          await retiree.query(
            `UPDATE workflow_definitions SET is_active = FALSE, updated_at = NOW()
              WHERE tenant_id = $1::uuid AND id = $2::integer`,
            [fixture.tenantId, fixture.definition.id],
          );
          await retireFixtureGovernance(retiree, fixture, retirementActorUid);
          await retiree.query('SET CONSTRAINTS ALL IMMEDIATE');
          await retiree.query('COMMIT');
          const final = await setup.query(
            `SELECT governance.governance_status, definition.is_active,
                    EXISTS (SELECT 1 FROM workflow_runs WHERE id = $3::integer) AS run_exists
               FROM care_pathway_definition_governance AS governance
               JOIN workflow_definitions AS definition
                 ON definition.tenant_id = governance.tenant_id
                AND definition.id = governance.workflow_definition_id
              WHERE governance.tenant_id = $1::uuid AND governance.id = $2::uuid`,
            [fixture.tenantId, fixture.governanceId, runtime.runId],
          );
          expect(final.rows[0]).toEqual({
            governance_status: 'retired',
            is_active: false,
            run_exists: true,
          });
        } else {
          await beginConcurrent(retiree);
          await retiree.query(
            `UPDATE workflow_definitions SET is_active = FALSE, updated_at = NOW()
              WHERE tenant_id = $1::uuid AND id = $2::integer`,
            [fixture.tenantId, fixture.definition.id],
          );
          await retireFixtureGovernance(retiree, fixture, retirementActorUid);
          await retiree.query('SET CONSTRAINTS ALL IMMEDIATE');
          await beginConcurrent(starter);
          const serializationFailure = await captureFailure(
            seedPinnedPathwayRuntime(starter, fixture, {
              activateDefinition: false,
            }),
          );
          expect(serializationFailure).toMatchObject({ code: '40001' });
          expect(serializationFailure.code).not.toBe('40P01');
          await starter.query('ROLLBACK');
          await retiree.query('COMMIT');

          await beginConcurrent(starter);
          const failure = await captureFailure(
            seedPinnedPathwayRuntime(starter, fixture, {
              activateDefinition: false,
            }),
          );
          expect(failure).toMatchObject({ code: '23514' });
          expect(failure.code).not.toBe('40P01');
          expect(failure.message).toContain('active approved effective definition checksum pin');
          await starter.query('ROLLBACK');
        }
      } finally {
        await Promise.all([
          setup.query('ROLLBACK').catch(() => {}),
          starter.query('ROLLBACK').catch(() => {}),
          retiree.query('ROLLBACK').catch(() => {}),
        ]);
        await Promise.all([setup.end(), starter.end(), retiree.end()]);
      }
    },
    30_000,
  );

  test.each(['retirement_first', 'activation_first'])(
    'serializes retirement with definition activation from approved inactive: %s',
    async (ordering) => {
      const setup = new Client({ connectionString: databaseUrl });
      const retiree = new Client({ connectionString: databaseUrl });
      const activator = new Client({ connectionString: databaseUrl });
      await Promise.all([setup.connect(), retiree.connect(), activator.connect()]);
      try {
        await beginConcurrent(setup);
        const fixture = await seedValidGovernance(setup);
        const retirementActorUid = await seedUser(setup, fixture.tenantId, 'ADMIN');
        await setup.query(
          `UPDATE workflow_definitions SET is_active = FALSE, updated_at = NOW()
            WHERE tenant_id = $1::uuid AND id = $2::integer`,
          [fixture.tenantId, fixture.definition.id],
        );
        await setup.query('SET CONSTRAINTS ALL IMMEDIATE');
        await setup.query('COMMIT');

        if (ordering === 'retirement_first') {
          await beginConcurrent(retiree);
          await retireFixtureGovernance(retiree, fixture, retirementActorUid);
          await retiree.query('SET CONSTRAINTS ALL IMMEDIATE');
          await beginConcurrent(activator);
          const activationFailure = await captureFailure(activator.query(
            `UPDATE workflow_definitions SET is_active = TRUE, updated_at = NOW()
              WHERE tenant_id = $1::uuid AND id = $2::integer`,
            [fixture.tenantId, fixture.definition.id],
          ));
          expect(activationFailure).toMatchObject({ code: '40001' });
          expect(activationFailure.code).not.toBe('40P01');
          await activator.query('ROLLBACK');
          await retiree.query('COMMIT');
        } else {
          await beginConcurrent(activator);
          await activator.query(
            `UPDATE workflow_definitions SET is_active = TRUE, updated_at = NOW()
              WHERE tenant_id = $1::uuid AND id = $2::integer`,
            [fixture.tenantId, fixture.definition.id],
          );
          await activator.query('SET CONSTRAINTS ALL IMMEDIATE');
          await beginConcurrent(retiree);
          const retirementFailure = await captureFailure(
            retireFixtureGovernance(retiree, fixture, retirementActorUid),
          );
          expect(retirementFailure).toMatchObject({ code: '40001' });
          expect(retirementFailure.code).not.toBe('40P01');
          await retiree.query('ROLLBACK');
          await activator.query('COMMIT');
        }

        const final = await setup.query(
          `SELECT governance.governance_status, definition.is_active
             FROM care_pathway_definition_governance AS governance
             JOIN workflow_definitions AS definition
               ON definition.tenant_id = governance.tenant_id
              AND definition.id = governance.workflow_definition_id
            WHERE governance.tenant_id = $1::uuid AND governance.id = $2::uuid`,
          [fixture.tenantId, fixture.governanceId],
        );
        expect(final.rows[0]).toEqual(
          ordering === 'retirement_first'
            ? { governance_status: 'retired', is_active: false }
            : { governance_status: 'approved', is_active: true },
        );
      } finally {
        await Promise.all([
          setup.query('ROLLBACK').catch(() => {}),
          retiree.query('ROLLBACK').catch(() => {}),
          activator.query('ROLLBACK').catch(() => {}),
        ]);
        await Promise.all([setup.end(), retiree.end(), activator.end()]);
      }
    },
    30_000,
  );

  test.each(['approval', 'owner', 'retirement_actor'])(
    'avoids %s-to-definition inversion when one transaction also writes governance',
    async (surface) => {
      const setup = new Client({ connectionString: databaseUrl });
      const atomicWriter = new Client({ connectionString: databaseUrl });
      const contender = new Client({ connectionString: databaseUrl });
      await Promise.all([setup.connect(), atomicWriter.connect(), contender.connect()]);
      try {
        await beginConcurrent(setup);
        let fixture;
        let retirementActorUid = null;
        if (surface === 'retirement_actor') {
          fixture = await seedValidGovernance(setup);
          retirementActorUid = await seedUser(setup, fixture.tenantId, 'ADMIN');
          await setup.query(
            `UPDATE workflow_definitions SET is_active = FALSE, updated_at = NOW()
              WHERE tenant_id = $1::uuid AND id = $2::integer`,
            [fixture.tenantId, fixture.definition.id],
          );
        } else {
          fixture = await seedPublicationFixture(setup);
        }
        await setup.query('SET CONSTRAINTS ALL IMMEDIATE');
        await setup.query('COMMIT');

        await beginConcurrent(atomicWriter);
        if (surface === 'approval') {
          await atomicWriter.query(
            `UPDATE approvals SET metadata = metadata || '{"atomic_writer":true}'::jsonb
              WHERE tenant_id = $1::uuid AND id = $2::integer`,
            [fixture.tenantId, fixture.approval.id],
          );
        } else {
          const actorUid = surface === 'owner' ? fixture.ownerUid : retirementActorUid;
          await atomicWriter.query(
            `UPDATE users SET name = name, updated_at = NOW()
              WHERE tenant_id = $1::uuid AND uid = $2::uuid`,
            [fixture.tenantId, actorUid],
          );
        }

        await beginConcurrent(contender);
        const contentionFailure = await captureFailure(
          surface === 'retirement_actor'
            ? retireFixtureGovernance(contender, fixture, retirementActorUid)
            : publishFixtureGovernance(contender, fixture),
        );
        expect(contentionFailure).toMatchObject({ code: '40001' });
        expect(contentionFailure.code).not.toBe('40P01');
        await contender.query('ROLLBACK');

        if (surface === 'retirement_actor') {
          await retireFixtureGovernance(atomicWriter, fixture, retirementActorUid);
        } else {
          await publishFixtureGovernance(atomicWriter, fixture);
        }
        await atomicWriter.query('SET CONSTRAINTS ALL IMMEDIATE');
        await atomicWriter.query('COMMIT');
      } finally {
        await Promise.all([
          setup.query('ROLLBACK').catch(() => {}),
          atomicWriter.query('ROLLBACK').catch(() => {}),
          contender.query('ROLLBACK').catch(() => {}),
        ]);
        await Promise.all([setup.end(), atomicWriter.end(), contender.end()]);
      }
    },
    30_000,
  );

  test.each(['admission_first', 'audit_then_timeline_first'])(
    'serializes UUIDv7 creation admission with inverse canonical-parent mutation: %s',
    async (ordering) => {
      const setup = new Client({ connectionString: databaseUrl });
      const admission = new Client({ connectionString: databaseUrl });
      const parentWriter = new Client({ connectionString: databaseUrl });
      await Promise.all([setup.connect(), admission.connect(), parentWriter.connect()]);
      try {
        await beginConcurrent(setup);
        const fixture = await seedValidGovernance(setup);
        await setup.query(
          `UPDATE workflow_definitions SET is_active = TRUE, updated_at = NOW()
            WHERE tenant_id = $1::uuid AND id = $2::integer`,
          [fixture.tenantId, fixture.definition.id],
        );
        const pending = await seedPendingCanonicalCreationParents(setup, fixture, {
          eventId: uuidV7(),
        });
        await setup.query('SET CONSTRAINTS ALL IMMEDIATE');
        await setup.query('COMMIT');

        const mutateAuditThenTimeline = async () => {
          await parentWriter.query("SET LOCAL app.audit_bypass = 'on'");
          await parentWriter.query(
            `UPDATE clinical_audit_events SET metadata = '{"wrong":true}'::jsonb
              WHERE tenant_id = $1::uuid AND id = $2::uuid`,
            [fixture.tenantId, pending.auditId],
          );
          await parentWriter.query(
            `UPDATE clinical_timeline_events SET payload = '{"wrong":true}'::jsonb
              WHERE tenant_id = $1::uuid AND id = $2::uuid`,
            [fixture.tenantId, pending.timelineId],
          );
        };

        if (ordering === 'admission_first') {
          await beginConcurrent(admission);
          await insertPendingPinnedRuntime(admission, fixture, pending);
          await admission.query('SET CONSTRAINTS ALL IMMEDIATE');
          await beginConcurrent(parentWriter);
          await mutateAuditThenTimeline();
          const parentFailure = await captureFailure(
            parentWriter.query('SET CONSTRAINTS ALL IMMEDIATE'),
          );
          expect(parentFailure).toMatchObject({ code: '40001' });
          expect(parentFailure.code).not.toBe('40P01');
          await parentWriter.query('ROLLBACK');
          await admission.query('COMMIT');
        } else {
          await beginConcurrent(parentWriter);
          await mutateAuditThenTimeline();
          await parentWriter.query('SET CONSTRAINTS ALL IMMEDIATE');
          await beginConcurrent(admission);
          await insertPendingPinnedRuntime(admission, fixture, pending);
          const validation = admission.query('SET CONSTRAINTS ALL IMMEDIATE');
          await waitForBackendLock(client, admission.processID);
          await parentWriter.query('COMMIT');
          const admissionFailure = await captureFailure(validation);
          expect(admissionFailure).toMatchObject({ code: '23514' });
          expect(admissionFailure.code).not.toBe('40P01');
          expect(admissionFailure.message).toContain(
            'lacks one exact immutable pathway creation pin',
          );
          await admission.query('ROLLBACK');
        }
      } finally {
        await Promise.all([
          setup.query('ROLLBACK').catch(() => {}),
          admission.query('ROLLBACK').catch(() => {}),
          parentWriter.query('ROLLBACK').catch(() => {}),
        ]);
        await Promise.all([setup.end(), admission.end(), parentWriter.end()]);
      }
    },
    30_000,
  );
});
