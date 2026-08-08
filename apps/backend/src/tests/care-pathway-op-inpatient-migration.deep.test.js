import { createHash, randomUUID } from 'node:crypto';

import { Client } from 'pg';

import {
  linkPendingResultOwnerActionsForGenerationTx,
  settlePendingResultOwnerActionsForDiagnosticActionTx,
} from '../services/emr/inpatientPathwayDomainService.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const DEFINITION_CHECKSUM = '6'.repeat(64);
const OP_TRANSFER_CONSTRAINT =
  'trg_care_handoff_op_to_ip_invariant';

function token() {
  return randomUUID().replaceAll('-', '');
}

function pgTransactionClient(client) {
  return {
    async $queryRawUnsafe(statement, ...params) {
      return (await client.query(statement, params)).rows;
    },
    async $executeRawUnsafe(statement, ...params) {
      return (await client.query(statement, params)).rowCount;
    },
  };
}

async function seedUser(client, tenantId, role) {
  const uid = randomUUID();
  const inserted = await client.query(
    `INSERT INTO users
       (uid, tenant_id, name, role, is_active, status, is_deleted, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::text, $4::text,
             TRUE, 'active', FALSE, NOW())
     RETURNING id, uid`,
    [uid, tenantId, `S4 OP ${role} ${token()}`, role],
  );
  return inserted.rows[0];
}

async function seedOpPathway(client) {
  const tenantId = randomUUID();
  await client.query(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2::text, 'S4 OP transfer test')`,
    [tenantId, `s4-op-transfer-${token()}`],
  );
  const patient = await seedUser(client, tenantId, 'PATIENT');
  const owner = await seedUser(client, tenantId, 'DOCTOR');
  const recipient = await seedUser(client, tenantId, 'CONSULTANT');
  const otherClinician = await seedUser(client, tenantId, 'DOCTOR');
  const approver = await seedUser(client, tenantId, 'ADMIN');
  const appointment = await client.query(
    `INSERT INTO appointments
       (tenant_id, phone, patient_id, doctor_id, doctor_name, patient_name,
        appointment_date, appointment_time, status, updated_at)
     VALUES ($1::uuid, '9999999999', $2::integer, $3::integer,
             'S4 OP owner', 'S4 OP patient', CURRENT_DATE, $4::text,
             'IN_PROGRESS', NOW())
     RETURNING id`,
    [tenantId, patient.id, owner.id, `W${token().slice(0, 8)}`],
  );
  const appointmentId = Number(appointment.rows[0].id);
  const definition = await client.query(
    `INSERT INTO workflow_definitions
       (tenant_id, workflow_key, version, display_name, steps, triggers, defaults)
     VALUES ($1::uuid, 'op_contact_to_recovery', 1, 'S4 OP transfer',
             '[]'::jsonb, '[]'::jsonb, '{}'::jsonb)
     RETURNING id`,
    [tenantId],
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
      JSON.stringify([{ uid: approver.uid, at: decidedAt }]),
      approver.uid,
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
      owner.uid,
      Number(approval.rows[0].id),
      approver.uid,
      DEFINITION_CHECKSUM,
    ],
  );
  await client.query(
    `UPDATE workflow_definitions
        SET is_active = TRUE, updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::integer`,
    [tenantId, definitionId],
  );
  const run = await client.query(
    `INSERT INTO workflow_runs
       (tenant_id, workflow_definition_id, workflow_key, workflow_version,
        trigger_kind, pathway_governance_id, pathway_definition_checksum)
     VALUES ($1::uuid, $2::integer, 'op_contact_to_recovery', 1,
             'manual', $3::uuid, $4::char(64))
     RETURNING id`,
    [
      tenantId,
      definitionId,
      governance.rows[0].id,
      DEFINITION_CHECKSUM,
    ],
  );
  const runId = Number(run.rows[0].id);
  await client.query(
    `INSERT INTO workflow_steps
       (tenant_id, workflow_run_id, step_key, display_name, step_kind,
        status, ordering)
     VALUES ($1::uuid, $2::integer, 'consultation', 'Consultation', 'task',
             'in_progress', 1)`,
    [tenantId, runId],
  );
  await client.query(
    `UPDATE workflow_runs
        SET current_step_key = 'consultation', updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::integer`,
    [tenantId, runId],
  );
  const pathway = await client.query(
    `INSERT INTO care_pathway_instances
       (tenant_id, workflow_run_id, patient_uid, pathway_key, pathway_version,
        workflow_definition_id, definition_governance_id, definition_checksum,
        source_episode_type, source_episode_id, owning_clinician_uid,
        accountable_role, idempotency_key, clinical_status)
     VALUES ($1::uuid, $2::integer, $3::uuid, 'op_contact_to_recovery', 1,
             $4::integer, $5::uuid, $6::char(64),
             'appointment', $7::text, $8::uuid,
             'DOCTOR', $9::text, 'active')
     RETURNING id`,
    [
      tenantId,
      runId,
      patient.uid,
      definitionId,
      governance.rows[0].id,
      DEFINITION_CHECKSUM,
      String(appointmentId),
      owner.uid,
      `s4-op-pathway-${token()}`,
    ],
  );
  return {
    tenantId,
    patientUid: patient.uid,
    ownerUid: owner.uid,
    recipientUid: recipient.uid,
    otherClinicianUid: otherClinician.uid,
    appointmentId,
    pathwayId: pathway.rows[0].id,
    runId,
    stepKey: 'consultation',
  };
}

async function seedPendingResultFixture(client) {
  const tenantId = randomUUID();
  await client.query(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2::text, 'S4 pending-result test')`,
    [tenantId, `s4-pending-result-${token()}`],
  );
  const patient = await seedUser(client, tenantId, 'PATIENT');
  const physician = await seedUser(client, tenantId, 'DOCTOR');
  const transferredPhysician = await seedUser(client, tenantId, 'DOCTOR');
  const approver = await seedUser(client, tenantId, 'ADMIN');
  const admission = await client.query(
    `INSERT INTO admissions
       (tenant_id, patient_uid, status, allergies, attending_doctor,
        admitting_doctor, admitted_at, created_by, updated_at)
     VALUES ($1::uuid, $2::uuid, 'admitted', ARRAY[]::text[], $3::uuid,
             $3::uuid, NOW(), $3::uuid, NOW())
     RETURNING id`,
    [tenantId, patient.uid, physician.uid],
  );
  const otherAdmission = await client.query(
    `INSERT INTO admissions
       (tenant_id, patient_uid, status, allergies, attending_doctor,
        admitting_doctor, admitted_at, created_by, updated_at)
     VALUES ($1::uuid, $2::uuid, 'admitted', ARRAY[]::text[], $3::uuid,
             $3::uuid, NOW(), $3::uuid, NOW())
     RETURNING id`,
    [tenantId, patient.uid, physician.uid],
  );
  const admissionId = Number(admission.rows[0].id);
  const otherAdmissionId = Number(otherAdmission.rows[0].id);
  const definition = await client.query(
    `INSERT INTO workflow_definitions
       (tenant_id, workflow_key, version, display_name, steps, triggers, defaults)
     VALUES ($1::uuid, 'inpatient_admission_to_recovery', 1,
             'S4 inpatient pending result', '[]'::jsonb,
             '[]'::jsonb, '{}'::jsonb)
     RETURNING id`,
    [tenantId],
  );
  const definitionId = Number(definition.rows[0].id);
  const decidedAt = '2026-07-23T09:00:00.000Z';
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
      JSON.stringify([{ uid: approver.uid, at: decidedAt }]),
      approver.uid,
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
             '2026-07-23T09:01:00.000Z'::timestamptz,
             'staff_after_signoff', $6::text)
     RETURNING id`,
    [
      tenantId,
      definitionId,
      physician.uid,
      Number(approval.rows[0].id),
      approver.uid,
      DEFINITION_CHECKSUM,
    ],
  );
  await client.query(
    `UPDATE workflow_definitions
        SET is_active = TRUE, updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::integer`,
    [tenantId, definitionId],
  );
  const run = await client.query(
    `INSERT INTO workflow_runs
       (tenant_id, workflow_definition_id, workflow_key, workflow_version,
        trigger_kind, pathway_governance_id, pathway_definition_checksum)
     VALUES ($1::uuid, $2::integer, 'inpatient_admission_to_recovery', 1,
             'manual', $3::uuid, $4::char(64))
     RETURNING id`,
    [
      tenantId,
      definitionId,
      governance.rows[0].id,
      DEFINITION_CHECKSUM,
    ],
  );
  const runId = Number(run.rows[0].id);
  const stepKey = 'pending_result_review';
  await client.query(
    `INSERT INTO workflow_steps
       (tenant_id, workflow_run_id, step_key, display_name, step_kind,
        status, ordering)
     VALUES ($1::uuid, $2::integer, $3::text,
             'Pending result review', 'task', 'in_progress', 1)`,
    [tenantId, runId, stepKey],
  );
  const pathway = await client.query(
    `INSERT INTO care_pathway_instances
       (tenant_id, workflow_run_id, patient_uid, pathway_key, pathway_version,
        workflow_definition_id, definition_governance_id, definition_checksum,
        source_episode_type, source_episode_id, owning_clinician_uid,
        accountable_role, idempotency_key, clinical_status)
     VALUES ($1::uuid, $2::integer, $3::uuid,
             'inpatient_admission_to_recovery', 1,
             $4::integer, $5::uuid, $6::char(64),
             'admission', $7::text, $8::uuid,
             'DOCTOR', $9::text, 'active')
     RETURNING id`,
    [
      tenantId,
      runId,
      patient.uid,
      definitionId,
      governance.rows[0].id,
      DEFINITION_CHECKSUM,
      String(admissionId),
      physician.uid,
      `s4-inpatient-pathway-${token()}`,
    ],
  );
  async function insertInvestigation(targetAdmissionId, label) {
    const inserted = await client.query(
      `INSERT INTO investigations
         (tenant_id, phone, test_name, status, priority, requested_by,
          requested_at, updated_at, patient_uid, admission_id, result_version)
       VALUES ($1::uuid, '9999999999', $2::text, 'COMPLETED', 'NORMAL',
               $3::uuid, NOW(), NOW(), $4::uuid, $5::integer, 1)
       RETURNING id`,
      [
        tenantId,
        `S4 ${label} ${token()}`,
        physician.uid,
        patient.uid,
        targetAdmissionId,
      ],
    );
    return Number(inserted.rows[0].id);
  }
  const investigationId = await insertInvestigation(
    admissionId,
    'pending source',
  );
  const otherInvestigationId = await insertInvestigation(
    admissionId,
    'other same-admission source',
  );
  const otherAdmissionInvestigationId = await insertInvestigation(
    otherAdmissionId,
    'other-admission source',
  );
  const reference = await client.query(
    `INSERT INTO care_pathway_resource_references
       (tenant_id, pathway_instance_id, patient_uid, resource_type,
        relationship_kind, evidence_state, resource_id, actor_system_key,
        occurred_at, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'investigation',
             'child_action', 'open', $4::text,
             's4.pending_result.deep_test', NOW(), $5::text)
     RETURNING id`,
    [
      tenantId,
      pathway.rows[0].id,
      patient.uid,
      String(investigationId),
      `s4-pending-reference-${token()}`,
    ],
  );
  const assignmentId = randomUUID();
  const timelineId = randomUUID();
  const auditId = randomUUID();
  await client.query(
    `INSERT INTO clinical_timeline_events
       (id, tenant_id, patient_uid, event_type, event_status,
        source_table, source_id, resource_type, resource_id,
        occurred_at, visible_to_patient, clinical_summary, payload, tags,
        idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'admission.primary_physician.assigned', 'assigned',
             'inpatient_primary_physician_assignments', $4::text,
             'inpatient_primary_physician_assignments', $4::text,
             NOW(), FALSE, 'Primary physician assigned',
             '{}'::jsonb, ARRAY['inpatient', 'primary_physician']::text[],
             $5::text)`,
    [
      timelineId,
      tenantId,
      patient.uid,
      assignmentId,
      `s4-assignment-timeline-${token()}`,
    ],
  );
  await client.query(
    `INSERT INTO clinical_audit_events
       (id, tenant_id, patient_uid, action, action_status,
        resource_type, resource_table, resource_id,
        before_state, after_state, metadata, idempotency_key, occurred_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'admission.primary_physician.assigned', 'success',
             'inpatient_primary_physician_assignments',
             'inpatient_primary_physician_assignments', $4::text,
             '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5::text, NOW())`,
    [
      auditId,
      tenantId,
      patient.uid,
      assignmentId,
      `s4-assignment-audit-${token()}`,
    ],
  );
  await client.query(
    `INSERT INTO inpatient_primary_physician_assignments
       (id, tenant_id, admission_id, patient_uid, assignment_version,
        physician_uid, assignment_source, assigned_by_uid, assigned_at,
        canonical_timeline_event_id, canonical_audit_event_id,
        idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::integer, $4::uuid, 1,
             $5::uuid, 'attending_physician', $5::uuid, NOW(),
             $6::uuid, $7::uuid, $8::text)`,
    [
      assignmentId,
      tenantId,
      admissionId,
      patient.uid,
      physician.uid,
      timelineId,
      auditId,
      `s4-primary-assignment-${token()}`,
    ],
  );
  const pendingId = randomUUID();
  const task = await client.query(
    `INSERT INTO tasks
       (tenant_id, task_kind, title, patient_uid, related_resource_type,
         related_resource_id, status, assigned_to_uid, assigned_to_role,
         metadata)
     VALUES ($1::uuid, 'follow_up', 'Review pending result', $2::uuid,
              'discharge_pending_result_handoff', $3::text, 'open',
              $4::uuid, NULL,
              jsonb_build_object(
                'admission_id', $5::integer,
                'source_type', 'investigation',
                'source_id', $6::text,
                'task_contract', 'discharge_pending_result_tracking_v1',
                'correlation_contract', 'pending_result_tracking_v1',
                'predecessor_tracking_task_id', NULL,
                'rearm_reason', NULL
              ))
      RETURNING id`,
    [
      tenantId,
      patient.uid,
      pendingId,
      physician.uid,
      admissionId,
      String(investigationId),
    ],
  );
  await client.query(
    `INSERT INTO discharge_pending_result_handoffs
       (id, tenant_id, admission_id, patient_uid, resource_reference_id,
        source_type, source_id, patient_safe_label, result_status,
        primary_physician_assignment_id, named_physician_uid, task_id,
        handoff_state, created_by_uid, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::integer, $4::uuid, $5::uuid,
             'investigation', $6::text, 'Pending diagnostic result',
             'pending', $7::uuid, $8::uuid, $9::integer,
             'pending', $8::uuid, $10::text)`,
    [
      pendingId,
      tenantId,
      admissionId,
      patient.uid,
      reference.rows[0].id,
      String(investigationId),
      assignmentId,
      physician.uid,
      Number(task.rows[0].id),
      `s4-pending-handoff-${token()}`,
    ],
  );
  return {
    tenantId,
    patientUid: patient.uid,
    physicianUid: physician.uid,
    transferredPhysicianUid: transferredPhysician.uid,
    admissionId,
    otherAdmissionId,
    investigationId,
    otherInvestigationId,
    otherAdmissionInvestigationId,
    pendingId,
    taskId: Number(task.rows[0].id),
    assignmentId,
    pathwayId: pathway.rows[0].id,
    runId,
    stepKey,
  };
}

async function insertDiagnosticGeneration(
  client,
  fixture,
  {
    admissionId = fixture.admissionId,
    investigationId = fixture.investigationId,
    sourceVersion = 1,
    predecessorGenerationId = null,
    sourceEpisodeKey =
      `s4-pending-generation:${admissionId}:${investigationId}`,
  } = {},
) {
  const generationId = randomUUID();
  const timelineId = randomUUID();
  const auditId = randomUUID();
  const itemHash = createHash('sha256')
    .update(`s4-pending-item:${generationId}`, 'utf8')
    .digest('hex');
  const aggregateHash = createHash('sha256')
    .update(itemHash, 'utf8')
    .digest('hex');
  await client.query(
    `INSERT INTO clinical_timeline_events
       (id, tenant_id, patient_uid, event_type, event_status,
        source_table, source_id, occurred_at, visible_to_patient,
        clinical_summary, payload, tags, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'diagnostic_result.generation_signed', 'signed',
             'diagnostic_result_generations', $4::text,
             NOW(), FALSE, 'Diagnostic result generation signed',
             '{}'::jsonb, ARRAY['diagnostic_result']::text[], $5::text)`,
    [
      timelineId,
      fixture.tenantId,
      fixture.patientUid,
      generationId,
      `s4-generation-timeline-${generationId}`,
    ],
  );
  await client.query(
    `INSERT INTO clinical_audit_events
       (id, tenant_id, patient_uid, action, action_status,
        resource_type, resource_table, resource_id,
        before_state, after_state, metadata, idempotency_key, occurred_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'diagnostic_result.generation_signed', 'success',
             'diagnostic_result_generation',
             'diagnostic_result_generations', $4::text,
             '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5::text, NOW())`,
    [
      auditId,
      fixture.tenantId,
      fixture.patientUid,
      generationId,
      `s4-generation-audit-${generationId}`,
    ],
  );
  await client.query(
    `INSERT INTO diagnostic_result_generations
       (id, tenant_id, patient_uid, admission_id,
        source_kind, source_table, source_episode_type, source_episode_key,
        source_version, investigation_id, ordering_owner_uid, owner_source,
        signer_uid, signer_role, signed_at, classification,
        classification_basis, snapshot_sha256, item_count,
        predecessor_generation_id, canonical_timeline_event_id,
        canonical_audit_event_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::integer,
             'shared_investigation', 'investigations',
             's4_pending_result_test', $5::text, $6::bigint,
             $7::integer, $8::uuid, 'named_orderer',
             $8::uuid, 'DOCTOR', NOW(), 'normal',
             '{}'::jsonb, $9::char(64), 1, $10::uuid,
             $11::uuid, $12::uuid)`,
    [
      generationId,
      fixture.tenantId,
      fixture.patientUid,
      admissionId,
      sourceEpisodeKey,
      sourceVersion,
      investigationId,
      fixture.physicianUid,
      aggregateHash,
      predecessorGenerationId,
      timelineId,
      auditId,
    ],
  );
  await client.query(
    `INSERT INTO diagnostic_result_generation_items
       (tenant_id, patient_uid, generation_id, source_table,
        source_row_id, source_version, source_ordinal, item_code,
        item_name, value_snapshot, normalized_flag, source_critical,
        classification, item_snapshot_sha256)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'investigations',
             $4::text, $5::text, 1, 'S4-PENDING',
             'S4 pending-result probe', '{"value":"available"}'::jsonb,
             'normal', FALSE, 'normal', $6::char(64))`,
    [
      fixture.tenantId,
      fixture.patientUid,
      generationId,
      String(investigationId),
      String(sourceVersion),
      itemHash,
    ],
  );
  const diagnosticConstraints = [
    'fk_diagnostic_generation_investigation',
    'fk_diagnostic_generation_timeline',
    'fk_diagnostic_generation_audit',
    'fk_diagnostic_generation_item_generation',
    'trg_validate_diagnostic_generation_predecessor',
    'trg_validate_diagnostic_generation_complete',
    'trg_validate_diagnostic_generation_items_complete',
  ].join(', ');
  await client.query(`SET CONSTRAINTS ${diagnosticConstraints} IMMEDIATE`);
  await client.query(`SET CONSTRAINTS ${diagnosticConstraints} DEFERRED`);
  return generationId;
}

async function insertNormalDiagnosticResolutionAction(
  client,
  fixture,
  generationId,
) {
  const actionId = randomUUID();
  const timelineId = randomUUID();
  const auditId = randomUUID();
  const generation = await client.query(
    `SELECT snapshot_sha256
       FROM diagnostic_result_generations
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [fixture.tenantId, generationId],
  );
  const snapshotSha256 = generation.rows[0].snapshot_sha256;
  const requestSha256 = createHash('sha256')
    .update(`s4-normal-resolution:${actionId}`, 'utf8')
    .digest('hex');
  await client.query(
    `INSERT INTO clinical_timeline_events
       (id, tenant_id, patient_uid, event_type, event_status,
        source_table, source_id, resource_type, resource_id,
        occurred_at, visible_to_patient, clinical_summary, payload, tags,
        idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'diagnostic.result.normal_auto_closed', 'closed',
             'diagnostic_result_actions', $4::text,
             'diagnostic_result_action', $4::text,
             NOW(), FALSE, 'Normal diagnostic result auto-closed',
             jsonb_build_object(
               'action_id', $4::text,
               'generation_id', $5::text
             ),
             ARRAY['diagnostic_result']::text[], $6::text)`,
    [
      timelineId,
      fixture.tenantId,
      fixture.patientUid,
      actionId,
      generationId,
      `s4-normal-action-timeline-${actionId}`,
    ],
  );
  await client.query(
    `INSERT INTO clinical_audit_events
       (id, tenant_id, patient_uid, action, action_status,
        resource_type, resource_table, resource_id,
        before_state, after_state, metadata, idempotency_key, occurred_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'diagnostic.result.normal_auto_closed', 'success',
             'diagnostic_result_action', 'diagnostic_result_actions',
             $4::text, NULL,
             jsonb_build_object(
               'generation_snapshot_sha256', $5::text,
               'request_sha256', $6::text
             ),
             '{}'::jsonb, $7::text, NOW())`,
    [
      auditId,
      fixture.tenantId,
      fixture.patientUid,
      actionId,
      snapshotSha256,
      requestSha256,
      `s4-normal-action-audit-${actionId}`,
    ],
  );
  await client.query(
    `INSERT INTO diagnostic_result_actions
       (id, tenant_id, patient_uid, generation_id, action_kind,
        generation_snapshot_sha256, idempotency_key, request_sha256,
        release_decision, canonical_timeline_event_id,
        canonical_audit_event_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
             'normal_auto_closed', $5::text, $6::text, $7::text,
             '{"outcome":"visible"}'::jsonb, $8::uuid, $9::uuid)`,
    [
      actionId,
      fixture.tenantId,
      fixture.patientUid,
      generationId,
      snapshotSha256,
      `s4-normal-resolution-action-${actionId}`,
      requestSha256,
      timelineId,
      auditId,
    ],
  );
  await client.query(
    'SET CONSTRAINTS trg_validate_diagnostic_result_action IMMEDIATE',
  );
  await client.query(
    'SET CONSTRAINTS trg_validate_diagnostic_result_action DEFERRED',
  );
  return {
    actionId,
    timelineId,
    auditId,
    snapshotSha256,
  };
}

async function insertSameOwnerDiagnosticDispositionAction(
  client,
  fixture,
  generationId,
) {
  const actionId = randomUUID();
  const timelineId = randomUUID();
  const auditId = randomUUID();
  const signatureId = randomUUID();
  const generation = await client.query(
    `SELECT snapshot_sha256
       FROM diagnostic_result_generations
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [fixture.tenantId, generationId],
  );
  const snapshotSha256 = generation.rows[0].snapshot_sha256;
  const requestSha256 = createHash('sha256')
    .update(`s4-doctor-disposition:${actionId}`, 'utf8')
    .digest('hex');
  await client.query(
    `INSERT INTO clinical_timeline_events
       (id, tenant_id, patient_uid, event_type, event_status,
        source_table, source_id, resource_type, resource_id,
        actor_uid, actor_role, occurred_at, visible_to_patient,
        clinical_summary, payload, tags, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'diagnostic.result.action_recorded', 'no_action',
             'diagnostic_result_actions', $4::text,
             'diagnostic_result_action', $4::text,
             $5::uuid, 'DOCTOR', NOW(), FALSE,
             'Doctor recorded diagnostic result action',
             jsonb_build_object(
               'action_id', $4::text,
               'generation_id', $6::text,
               'disposition', 'no_action',
               'signature_id', $7::text
             ),
             ARRAY['diagnostics', 'doctor_action', 'signature']::text[],
             $8::text)`,
    [
      timelineId,
      fixture.tenantId,
      fixture.patientUid,
      actionId,
      fixture.physicianUid,
      generationId,
      signatureId,
      `diagnostic_result_actions:${actionId}:action_recorded`,
    ],
  );
  await client.query(
    `INSERT INTO clinical_audit_events
       (id, tenant_id, patient_uid, actor_uid, actor_role,
        action, action_status, resource_type, resource_table, resource_id,
        before_state, after_state, metadata, idempotency_key, occurred_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'DOCTOR',
             'diagnostic.result.action_recorded', 'success',
             'diagnostic_result_action', 'diagnostic_result_actions',
             $5::text, NULL,
             jsonb_build_object(
               'disposition', 'no_action',
               'generation_snapshot_sha256', $6::text,
               'request_sha256', $7::text
             ),
             '{}'::jsonb, $8::text, NOW())`,
    [
      auditId,
      fixture.tenantId,
      fixture.patientUid,
      fixture.physicianUid,
      actionId,
      snapshotSha256,
      requestSha256,
      `diagnostic_result_actions:${actionId}:audit:action_recorded`,
    ],
  );
  await client.query(
    `INSERT INTO clinical_document_signatures
       (id, tenant_id, patient_uid, document_type, document_table,
        document_id, content_hash, signer_uid, signer_role,
        signature_statement, audit_event_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'diagnostic_result_action', 'diagnostic_result_actions',
             $4::text, $5::char(64), $6::uuid, 'DOCTOR',
             'I attest this diagnostic disposition.', $7::uuid)`,
    [
      signatureId,
      fixture.tenantId,
      fixture.patientUid,
      actionId,
      createHash('sha256')
        .update(`s4-doctor-signature:${actionId}`, 'utf8')
        .digest('hex'),
      fixture.physicianUid,
      auditId,
    ],
  );
  await client.query(
    `INSERT INTO diagnostic_result_actions
       (id, tenant_id, patient_uid, generation_id, action_kind,
        disposition, clinical_note, reason, generation_snapshot_sha256,
        actor_uid, actor_role, idempotency_key, request_sha256,
        signature_id, canonical_timeline_event_id, canonical_audit_event_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
             'doctor_disposition', 'no_action',
             'Reviewed the signed generation for discharge follow-up.',
             'No further intervention is indicated.', $5::text,
             $6::uuid, 'DOCTOR', $7::text, $8::text,
             $9::uuid, $10::uuid, $11::uuid)`,
    [
      actionId,
      fixture.tenantId,
      fixture.patientUid,
      generationId,
      snapshotSha256,
      fixture.physicianUid,
      `s4-doctor-resolution-action-${actionId}`,
      requestSha256,
      signatureId,
      timelineId,
      auditId,
    ],
  );
  await client.query(
    'SET CONSTRAINTS trg_validate_diagnostic_result_action IMMEDIATE',
  );
  await client.query(
    'SET CONSTRAINTS trg_validate_diagnostic_result_action DEFERRED',
  );
  return {
    actionId,
    timelineId,
    auditId,
    signatureId,
    snapshotSha256,
  };
}

async function insertPendingResultSettlementReceipts(
  client,
  fixture,
  ownerAction,
  generationId,
  resolution,
  {
    includeTimeline = true,
    includeAudit = true,
    includeOutbox = true,
    eventStatus = 'normal_auto_closed',
    actorUid = null,
    actorRole = null,
  } = {},
) {
  const timelineId = randomUUID();
  const auditId = randomUUID();
  if (includeTimeline) {
    await client.query(
      `INSERT INTO clinical_timeline_events
         (id, tenant_id, patient_uid, event_type, event_status,
          source_table, source_id, resource_type, resource_id,
          actor_uid, actor_role, occurred_at, visible_to_patient,
          clinical_summary, payload, tags, idempotency_key)
       VALUES ($1::uuid, $2::uuid, $3::uuid,
               'discharge.pending_result_resolved', $4::text,
               'diagnostic_result_actions', $5::text,
               'discharge_pending_result_handoff', $6::text,
               $7::uuid, $8::text, NOW(), FALSE,
               'Pending result resolved',
               jsonb_build_object(
                 'admission_id', $9::integer,
                 'handoff_id', $6::text,
                 'generation_id', $10::text,
                 'owner_action_id', $11::text,
                 'action_task_id', $12::integer,
                 'tracking_task_id', $13::integer,
                 'resolution_action_id', $5::text
               ),
               ARRAY['inpatient', 'discharge', 'pending_result']::text[],
               $14::text)`,
      [
        timelineId,
        fixture.tenantId,
        fixture.patientUid,
        eventStatus,
        resolution.actionId,
        fixture.pendingId,
        actorUid,
        actorRole,
        fixture.admissionId,
        generationId,
        ownerAction.actionId,
        ownerAction.taskId,
        ownerAction.trackingTaskId,
        `pending-result-resolved:${fixture.tenantId}:${fixture.pendingId}:${resolution.actionId}:timeline`,
      ],
    );
  }
  if (includeAudit) {
    await client.query(
      `INSERT INTO clinical_audit_events
         (id, tenant_id, patient_uid, actor_uid, actor_role,
          action, action_status, resource_type, resource_table, resource_id,
          before_state, after_state, metadata, idempotency_key, occurred_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text,
               'discharge.pending_result_resolved', 'success',
               'discharge_pending_result_handoff',
               'discharge_pending_result_handoffs', $6::text, NULL,
               jsonb_build_object(
                 'handoff_state', 'resolved',
                 'resolution_action_id', $7::text,
                 'generation_snapshot_sha256', $8::text
               ),
               '{}'::jsonb, $9::text, NOW())`,
      [
        auditId,
        fixture.tenantId,
        fixture.patientUid,
        actorUid,
        actorRole,
        fixture.pendingId,
        resolution.actionId,
        resolution.snapshotSha256,
        `pending-result-resolved:${fixture.tenantId}:${fixture.pendingId}:${resolution.actionId}:audit`,
      ],
    );
  }
  if (includeOutbox) {
    await client.query(
      `INSERT INTO event_outbox
         (tenant_id, event_type, aggregate_type, aggregate_id,
          patient_uid, payload)
       VALUES ($1::uuid, 'discharge.pending_result_resolved',
               'discharge_pending_result_handoff', $2::text, $3::uuid,
               jsonb_build_object(
                 'admission_id', $4::integer,
                 'handoff_id', $2::text,
                 'generation_id', $5::text,
                 'owner_action_id', $6::text,
                 'action_task_id', $7::integer,
                 'tracking_task_id', $8::integer,
                 'resolution_action_id', $9::text,
                 'canonical_timeline_event_id', $10::text,
                 'canonical_audit_event_id', $11::text,
                 'admission_lineage_version', 1
               ))`,
      [
        fixture.tenantId,
        fixture.pendingId,
        fixture.patientUid,
        fixture.admissionId,
        generationId,
        ownerAction.actionId,
        ownerAction.taskId,
        ownerAction.trackingTaskId,
        resolution.actionId,
        timelineId,
        auditId,
      ],
    );
  }
  return { timelineId, auditId };
}

async function insertPendingResultOwnerAction(
  client,
  fixture,
  generationId,
  {
    predecessorGenerationId = null,
    predecessorOwnerActionId = null,
    predecessorResolutionActionId = null,
    rearmSourceActionId = null,
    idempotencyKey = `s4-pending-owner-action-${token()}`,
    beforeOwnerActionInsert,
  } = {},
) {
  if (
    predecessorOwnerActionId === null
    && (predecessorGenerationId !== null || rearmSourceActionId !== null)
  ) {
    const predecessor = await client.query(
      `SELECT action.id
         FROM discharge_pending_result_owner_actions AS action
        WHERE action.tenant_id = $1::uuid
          AND action.handoff_id = $2::uuid
          AND NOT EXISTS (
            SELECT 1
              FROM discharge_pending_result_owner_actions AS successor
             WHERE successor.tenant_id = action.tenant_id
               AND successor.handoff_id = action.handoff_id
               AND successor.predecessor_owner_action_id = action.id
          )
        ORDER BY action.recorded_at DESC, action.id DESC
        LIMIT 1`,
      [fixture.tenantId, fixture.pendingId],
    );
    predecessorOwnerActionId = predecessor.rows[0]?.id ?? null;
  }
  const currentHandoff = await client.query(
    `SELECT task_id
       FROM discharge_pending_result_handoffs
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [fixture.tenantId, fixture.pendingId],
  );
  const trackingTaskId = Number(currentHandoff.rows[0].task_id);
  const taskResourceId = rearmSourceActionId
    ? `${fixture.pendingId}:${generationId}:${predecessorOwnerActionId}`
    : `${fixture.pendingId}:${generationId}`;
  const task = await client.query(
    `INSERT INTO tasks
       (tenant_id, parent_task_id, task_kind, title, patient_uid,
         related_resource_type, related_resource_id, status,
         assigned_to_uid, assigned_to_role, created_by, metadata)
     VALUES ($1::uuid, $2::integer, 'review',
              'Review corrected pending result', $3::uuid,
              'discharge_pending_result_action', $4::text, 'open',
              $5::uuid, NULL, $5::uuid,
              jsonb_build_object(
                'task_contract', 'discharge_pending_result_action_v1',
                'handoff_id', $6::text,
                'generation_id', $7::text,
                'predecessor_generation_id', $8::text,
                'predecessor_owner_action_id', $9::text,
                'predecessor_resolution_action_id', $10::text,
                'rearm_source_action_id', $11::text
              ))
      RETURNING id`,
    [
      fixture.tenantId,
      trackingTaskId,
      fixture.patientUid,
      taskResourceId,
      fixture.physicianUid,
      fixture.pendingId,
      generationId,
      predecessorGenerationId,
      predecessorOwnerActionId,
      predecessorResolutionActionId,
      rearmSourceActionId,
    ],
  );
  const taskId = Number(task.rows[0].id);
  const timelineId = randomUUID();
  const auditId = randomUUID();
  await client.query(
    `INSERT INTO clinical_timeline_events
       (id, tenant_id, patient_uid, event_type, event_status,
        source_table, source_id, resource_type, resource_id,
        occurred_at, visible_to_patient, clinical_summary, payload, tags,
        idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'discharge.pending_result_available', $6::text,
             'discharge_pending_result_handoffs', $4::text,
             'diagnostic_result_generation', $5::text,
              NOW(), FALSE, 'Pending result available',
              jsonb_build_object(
                'admission_id', $7::integer,
                 'handoff_id', $4::text,
                 'generation_id', $5::text,
                 'predecessor_generation_id', $8::text,
                 'predecessor_owner_action_id', $9::text,
                 'predecessor_resolution_action_id', $10::text,
                 'rearm_source_action_id', $11::text,
                 'action_task_id', $12::integer,
                 'tracking_task_id', $13::integer
               ),
               ARRAY['pending_result']::text[], $14::text)`,
    [
      timelineId,
      fixture.tenantId,
      fixture.patientUid,
      fixture.pendingId,
      generationId,
      predecessorGenerationId ? 'result_rearmed' : 'result_available',
      fixture.admissionId,
      predecessorGenerationId,
      predecessorOwnerActionId,
      predecessorResolutionActionId,
      rearmSourceActionId,
      taskId,
      trackingTaskId,
      `s4-pending-action-timeline-${timelineId}`,
    ],
  );
  await client.query(
    `INSERT INTO clinical_audit_events
       (id, tenant_id, patient_uid, action, action_status,
        resource_type, resource_table, resource_id,
        before_state, after_state, metadata, idempotency_key, occurred_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'discharge.pending_result_available', 'success',
             'diagnostic_result_generation',
             'discharge_pending_result_handoffs', $4::text,
             '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5::text, NOW())`,
    [
      auditId,
      fixture.tenantId,
      fixture.patientUid,
      generationId,
      `s4-pending-action-audit-${auditId}`,
    ],
  );
  const outbox = await client.query(
    `INSERT INTO event_outbox
       (tenant_id, event_type, aggregate_type, aggregate_id,
        patient_uid, payload)
     VALUES ($1::uuid, 'discharge.pending_result_available',
             'discharge_pending_result_handoff', $2::text, $3::uuid,
             jsonb_build_object(
               'admission_id', $4::integer,
                'handoff_id', $2::text,
                'generation_id', $5::text,
                'predecessor_generation_id', $6::text,
                'predecessor_owner_action_id', $7::text,
                'predecessor_resolution_action_id', $8::text,
                'rearm_source_action_id', $9::text,
                'action_task_id', $10::integer,
                'tracking_task_id', $11::integer,
                'canonical_timeline_event_id', $12::text,
                'canonical_audit_event_id', $13::text
              ))
     RETURNING id`,
    [
      fixture.tenantId,
      fixture.pendingId,
      fixture.patientUid,
      fixture.admissionId,
      generationId,
      predecessorGenerationId,
      predecessorOwnerActionId,
      predecessorResolutionActionId,
      rearmSourceActionId,
      taskId,
      trackingTaskId,
      timelineId,
      auditId,
    ],
  );
  const actionId = randomUUID();
  if (beforeOwnerActionInsert) {
    await beforeOwnerActionInsert({
      taskId,
      timelineId,
      auditId,
      outboxId: outbox.rows[0].id,
    });
  }
  await client.query(
    `INSERT INTO discharge_pending_result_owner_actions
       (id, tenant_id, handoff_id, admission_id, patient_uid,
         generation_id, predecessor_generation_id,
         predecessor_owner_action_id, predecessor_resolution_action_id,
         rearm_source_action_id, task_id, owner_uid,
         source_outbox_event_id, canonical_timeline_event_id,
         canonical_audit_event_id, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::integer, $5::uuid,
              $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::uuid,
              $11::integer, $12::uuid, $13::bigint, $14::uuid,
              $15::uuid, $16::text)`,
    [
      actionId,
      fixture.tenantId,
      fixture.pendingId,
      fixture.admissionId,
      fixture.patientUid,
      generationId,
      predecessorGenerationId,
      predecessorOwnerActionId,
      predecessorResolutionActionId,
      rearmSourceActionId,
      taskId,
      fixture.physicianUid,
      outbox.rows[0].id,
      timelineId,
      auditId,
      idempotencyKey,
    ],
  );
  return {
    actionId,
    taskId,
    timelineId,
    auditId,
    outboxId: outbox.rows[0].id,
    predecessorOwnerActionId,
    predecessorResolutionActionId,
    rearmSourceActionId,
    trackingTaskId,
  };
}

async function insertAcceptedPrimaryTransfer(
  client,
  fixture,
  action,
  {
    updateTrackingTask = true,
    updateChildTask = true,
    updateHandoff = true,
    updateAdmissionAttending = true,
  } = {},
) {
  const handoffId = randomUUID();
  const assignmentId = randomUUID();
  const timelineId = randomUUID();
  const auditId = randomUUID();
  const requestReason = 'Planned covering duty';
  const requestFingerprint = createHash('sha256')
    .update(`covering:${handoffId}`)
    .digest('hex');
  const acceptanceTask = await client.query(
    `INSERT INTO tasks
       (tenant_id, task_kind, title, patient_uid, related_resource_type,
        related_resource_id, status, assigned_to_uid, assigned_to_role,
        created_by)
     VALUES ($1::uuid, 'pathway_owner_transfer_review',
             'Review covering-clinician transfer', $2::uuid,
             'care_handoff_instance', $3::text, 'open',
             $4::uuid, NULL, $4::uuid)
     RETURNING id`,
    [
      fixture.tenantId,
      fixture.patientUid,
      handoffId,
      fixture.transferredPhysicianUid,
    ],
  );
  await client.query(
    `INSERT INTO care_handoff_instances
       (id, tenant_id, patient_uid,
        sending_pathway_instance_id, sending_workflow_run_id, sending_step_key,
        receiving_pathway_instance_id, receiving_workflow_run_id,
        receiving_step_key, handoff_type, source_resource_type,
        source_resource_id, urgency_code, sender_uid, recipient_kind,
        intended_recipient_uid, status, requested_at, accepted_at,
        accepted_by_uid, task_id, idempotency_key, metadata,
        request_reason, request_fingerprint)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             $4::uuid, $5::integer, $6::text,
             $4::uuid, $5::integer, $6::text,
             'covering_clinician_reassignment',
             'care_pathway_instance', $4::text, 'not_applicable',
             $7::uuid, 'user', $8::uuid, 'requested',
             NOW() - INTERVAL '1 minute', NULL, NULL,
             $9::integer, $10::text,
             jsonb_build_object('request_reason', $11::text),
             $11::text, $12::char(64))`,
    [
      handoffId,
      fixture.tenantId,
      fixture.patientUid,
      fixture.pathwayId,
      fixture.runId,
      fixture.stepKey,
      fixture.physicianUid,
      fixture.transferredPhysicianUid,
      Number(acceptanceTask.rows[0].id),
      `s4-covering-transfer-${token()}`,
      requestReason,
      requestFingerprint,
    ],
  );
  await client.query(
    `UPDATE tasks
        SET status = 'completed',
            completed_at = NOW(),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::integer`,
    [fixture.tenantId, Number(acceptanceTask.rows[0].id)],
  );
  await client.query(
    `UPDATE care_handoff_instances
        SET status = 'accepted',
            accepted_at = NOW(),
            accepted_by_uid = $3::uuid,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [
      fixture.tenantId,
      handoffId,
      fixture.transferredPhysicianUid,
    ],
  );
  await client.query(
    `UPDATE care_pathway_instances
        SET owning_clinician_uid = $3::uuid,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::uuid`,
    [
      fixture.tenantId,
      fixture.pathwayId,
      fixture.transferredPhysicianUid,
    ],
  );
  if (updateAdmissionAttending) {
    await client.query(
      `UPDATE admissions
          SET attending_doctor = $3::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [
        fixture.tenantId,
        fixture.admissionId,
        fixture.transferredPhysicianUid,
      ],
    );
  }
  await client.query(
    `INSERT INTO clinical_timeline_events
       (id, tenant_id, patient_uid, event_type, event_status,
        source_table, source_id, resource_type, resource_id,
        occurred_at, visible_to_patient, clinical_summary, payload, tags,
        idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'admission.primary_physician.reassigned', 'accepted',
             'inpatient_primary_physician_assignments', $4::text,
             'inpatient_primary_physician_assignments', $4::text,
             NOW(), FALSE, 'Primary physician coverage accepted',
             jsonb_build_object(
               'admission_id', $5::integer,
               'physician_uid', $6::text,
               'assignment_version', 2,
               'accepted_handoff_id', $7::text,
               'supersedes_assignment_id', $8::text
             ),
             ARRAY['inpatient', 'primary_physician']::text[], $9::text)`,
    [
      timelineId,
      fixture.tenantId,
      fixture.patientUid,
      assignmentId,
      fixture.admissionId,
      fixture.transferredPhysicianUid,
      handoffId,
      fixture.assignmentId,
      `s4-reassignment-timeline-${token()}`,
    ],
  );
  await client.query(
    `INSERT INTO clinical_audit_events
       (id, tenant_id, patient_uid, action, action_status,
        resource_type, resource_table, resource_id,
        before_state, after_state, metadata, idempotency_key, occurred_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'admission.primary_physician.reassigned', 'success',
             'inpatient_primary_physician_assignments',
             'inpatient_primary_physician_assignments', $4::text,
             '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5::text, NOW())`,
    [
      auditId,
      fixture.tenantId,
      fixture.patientUid,
      assignmentId,
      `s4-reassignment-audit-${token()}`,
    ],
  );
  await client.query(
    `INSERT INTO inpatient_primary_physician_assignments
       (id, tenant_id, admission_id, patient_uid, assignment_version,
        physician_uid, assignment_source, accepted_handoff_id,
        supersedes_assignment_id, assigned_by_uid, assigned_at,
        canonical_timeline_event_id, canonical_audit_event_id,
        idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::integer, $4::uuid, 2,
             $5::uuid, 'accepted_covering_handoff', $6::uuid,
             $7::uuid, $5::uuid, NOW(), $8::uuid, $9::uuid, $10::text)`,
    [
      assignmentId,
      fixture.tenantId,
      fixture.admissionId,
      fixture.patientUid,
      fixture.transferredPhysicianUid,
      handoffId,
      fixture.assignmentId,
      timelineId,
      auditId,
      `covering:${handoffId}`,
    ],
  );
  const taskIds = [
    ...(updateTrackingTask ? [fixture.taskId] : []),
    ...(updateChildTask ? [action.taskId] : []),
  ];
  if (taskIds.length) {
    await client.query(
      `UPDATE tasks
          SET assigned_to_uid = $3::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = ANY($2::integer[])`,
      [
        fixture.tenantId,
        taskIds,
        fixture.transferredPhysicianUid,
      ],
    );
  }
  if (updateHandoff) {
    await client.query(
      `UPDATE discharge_pending_result_handoffs
          SET primary_physician_assignment_id = $3::uuid,
              named_physician_uid = $4::uuid,
              updated_at = GREATEST(
                clock_timestamp(),
                updated_at + INTERVAL '1 microsecond'
              )
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [
        fixture.tenantId,
        fixture.pendingId,
        assignmentId,
        fixture.transferredPhysicianUid,
      ],
    );
  }
  return {
    assignmentId,
    handoffId,
    acceptanceTaskId: Number(acceptanceTask.rows[0].id),
    timelineId,
    auditId,
  };
}

async function insertOpClosureWithFollowUp(client, fixture, {
  planOriginId = String(fixture.appointmentId),
} = {}) {
  const closureId = randomUUID();
  const timelineId = randomUUID();
  const auditId = randomUUID();
  const plan = await client.query(
    `INSERT INTO follow_up_plans
       (tenant_id, patient_uid, origin_kind, origin_resource_type,
        origin_resource_id, doctor_uid, appointment_status,
        reminder_offsets_minutes, status, created_by)
     VALUES ($1::uuid, $2::uuid, 'consultation', 'appointment',
             $3::text, $4::uuid, 'pending', ARRAY[]::integer[],
             'open', $4::uuid)
     RETURNING id`,
    [
      fixture.tenantId,
      fixture.patientUid,
      planOriginId,
      fixture.ownerUid,
    ],
  );
  const statusHistory = await client.query(
    `INSERT INTO appointment_status_history
       (tenant_id, appointment_id, from_status, to_status, reason)
     VALUES ($1::uuid, $2::integer, 'IN_PROGRESS', 'COMPLETED',
             'S4 OP closure test')
     RETURNING id`,
    [fixture.tenantId, fixture.appointmentId],
  );
  await client.query(
    `INSERT INTO clinical_timeline_events
       (id, tenant_id, patient_uid, event_type, event_status,
        source_table, source_id, occurred_at, visible_to_patient,
        clinical_summary, payload, tags, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'appointment.closure_evidence_recorded', 'completed',
             'op_visit_closure_evidence', $4::text,
             NOW(), FALSE, 'OP closure evidence recorded',
             '{}'::jsonb, ARRAY['op_closure']::text[], $5::text)`,
    [
      timelineId,
      fixture.tenantId,
      fixture.patientUid,
      closureId,
      `s4-op-closure-timeline-${closureId}`,
    ],
  );
  await client.query(
    `INSERT INTO clinical_audit_events
       (id, tenant_id, patient_uid, action, action_status,
        resource_type, resource_table, resource_id,
        before_state, after_state, metadata, idempotency_key, occurred_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid,
             'appointment.closure_evidence_recorded', 'success',
             'op_visit_closure_evidence', 'op_visit_closure_evidence',
             $4::text, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
             $5::text, NOW())`,
    [
      auditId,
      fixture.tenantId,
      fixture.patientUid,
      closureId,
      `s4-op-closure-audit-${closureId}`,
    ],
  );
  const closure = await client.query(
    `INSERT INTO op_visit_closure_evidence
       (id, tenant_id, appointment_id, patient_uid, evidence_revision,
        clinician_uid, follow_up_required, follow_up_plan_id,
        patient_safe_next_steps, closure_basis, source_status_history_id,
        canonical_timeline_event_id, canonical_audit_event_id,
        occurred_at, idempotency_key)
     VALUES ($1::uuid, $2::uuid, $3::integer, $4::uuid, 1,
             $5::uuid, TRUE, $6::integer,
             '[{"kind":"follow_up","label":"Attend follow-up"}]'::jsonb,
             'all_required_work_completed', $7::bigint,
             $8::uuid, $9::uuid, NOW(), $10::text)
     RETURNING id`,
    [
      closureId,
      fixture.tenantId,
      fixture.appointmentId,
      fixture.patientUid,
      fixture.ownerUid,
      Number(plan.rows[0].id),
      statusHistory.rows[0].id,
      timelineId,
      auditId,
      `s4-op-closure-${closureId}`,
    ],
  );
  return {
    closureId: closure.rows[0].id,
    planId: Number(plan.rows[0].id),
  };
}

function opTransferFingerprint(fixture, reason) {
  return createHash('sha256')
    .update(
      [
        'op_to_inpatient_transfer_request_v1',
        `tenant_id=${fixture.tenantId.toLowerCase()}`,
        `appointment_id=${fixture.appointmentId}`,
        `pathway_instance_id=${fixture.pathwayId.toLowerCase()}`,
        `sender_uid=${fixture.ownerUid.toLowerCase()}`,
        `recipient_uid=${fixture.recipientUid.toLowerCase()}`,
        `reason=${reason.trim()}`,
      ].join(String.fromCharCode(30)),
      'utf8',
    )
    .digest('hex');
}

async function insertOpTransferRequest(client, fixture, overrides = {}) {
  const handoffId = overrides.handoffId || randomUUID();
  const reason = overrides.reason ?? 'Needs monitored inpatient treatment';
  const fingerprint =
    overrides.fingerprint ?? opTransferFingerprint(fixture, reason);
  const metadata = {
    task_contract: 'op_to_inpatient_transfer_review_v1',
    care_pathway_instance_id: fixture.pathwayId,
    source_appointment_id: String(fixture.appointmentId),
    request_fingerprint: fingerprint,
    ...(overrides.taskMetadata || {}),
  };
  const task = await client.query(
    `INSERT INTO tasks
       (tenant_id, task_kind, title, patient_uid, related_resource_type,
        related_resource_id, status, assigned_to_uid, assigned_to_role,
        metadata)
     VALUES ($1::uuid, $2::text, 'Review OP-to-inpatient transfer',
             $3::uuid, 'care_handoff_instance', $4::text, 'open',
             $5::uuid, NULL, $6::jsonb)
     RETURNING id`,
    [
      fixture.tenantId,
      overrides.taskKind || 'op_to_inpatient_transfer_review',
      fixture.patientUid,
      handoffId,
      fixture.recipientUid,
      JSON.stringify(metadata),
    ],
  );
  const handoff = await client.query(
    `INSERT INTO care_handoff_instances
       (id, tenant_id, patient_uid, sending_pathway_instance_id,
        sending_workflow_run_id, sending_step_key, handoff_type,
        source_resource_type, source_resource_id, urgency_code, policy_due_at,
        sender_uid, recipient_kind, intended_recipient_uid, status,
        task_id, idempotency_key, request_reason, request_fingerprint)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
             $5::integer, $6::text, 'op_to_inpatient_transfer',
             'appointment', $7::text, 'not_applicable', NULL,
             $8::uuid, 'user', $9::uuid, 'requested',
             $10::integer, $11::text, $12::text, $13::char(64))
     RETURNING id, task_id`,
    [
      handoffId,
      fixture.tenantId,
      fixture.patientUid,
      fixture.pathwayId,
      fixture.runId,
      fixture.stepKey,
      String(fixture.appointmentId),
      overrides.senderUid || fixture.ownerUid,
      fixture.recipientUid,
      Number(task.rows[0].id),
      overrides.idempotencyKey || `s4-op-transfer-${token()}`,
      reason,
      fingerprint,
    ],
  );
  return handoff.rows[0];
}

async function flushConstraint(client, constraintName = OP_TRANSFER_CONSTRAINT) {
  await client.query(`SET CONSTRAINTS ${constraintName} IMMEDIATE`);
  await client.query(`SET CONSTRAINTS ${constraintName} DEFERRED`);
}

async function expectDeferredFailure(
  client,
  statement,
  params,
  message,
  constraintName = OP_TRANSFER_CONSTRAINT,
) {
  await client.query('SAVEPOINT expected_deferred_failure');
  let failure;
  try {
    await client.query(statement, params);
    await client.query(`SET CONSTRAINTS ${constraintName} IMMEDIATE`);
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_deferred_failure');
  await client.query(`SET CONSTRAINTS ${constraintName} DEFERRED`);
  expect({
    code: failure?.code,
    message: failure?.message,
  }).toMatchObject({ code: '23514' });
  if (message) expect(failure.message).toContain(message);
  return failure;
}

async function expectDeferredOperationFailure(
  client,
  operation,
  message,
  constraintName,
) {
  await client.query('SAVEPOINT expected_deferred_operation_failure');
  let failure;
  try {
    await operation();
    await client.query(`SET CONSTRAINTS ${constraintName} IMMEDIATE`);
  } catch (error) {
    failure = error;
  }
  await client.query(
    'ROLLBACK TO SAVEPOINT expected_deferred_operation_failure',
  );
  await client.query(`SET CONSTRAINTS ${constraintName} DEFERRED`);
  if (failure?.code && failure.code !== '23514') throw failure;
  expect({
    code: failure?.code,
    message: failure?.message,
  }).toMatchObject({ code: '23514' });
  if (message) expect(failure.message).toContain(message);
  return failure;
}

async function expectStatementFailure(
  client,
  statement,
  params,
  code,
  message,
) {
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
  return failure;
}

describeIfDb('migration 595 OP-to-inpatient transfer integrity', () => {
  let client;
  let fixture;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    fixture = await seedOpPathway(client);
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  afterAll(async () => {
    await client.end();
  });

  test('accepts only the exact current-step request and immutable digest', async () => {
    const request = await insertOpTransferRequest(client, fixture);
    await expect(flushConstraint(client)).resolves.toBeUndefined();

    await client.query('SAVEPOINT expected_immutable_transfer');
    let failure;
    try {
      await client.query(
        `UPDATE care_handoff_instances
            SET request_reason = 'Changed after request',
                updated_at = updated_at + INTERVAL '1 second'
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [fixture.tenantId, request.id],
      );
    } catch (error) {
      failure = error;
    }
    await client.query('ROLLBACK TO SAVEPOINT expected_immutable_transfer');
    expect(failure).toMatchObject({ code: '23514' });
    expect(failure.message).toContain(
      'OP-to-inpatient transfer request evidence is immutable',
    );
  });

  test('rejects prior-visit follow-up lineage and preserves exact plan state', async () => {
    await client.query('SAVEPOINT expected_wrong_follow_up_origin');
    let wrongOriginFailure;
    try {
      await insertOpClosureWithFollowUp(client, fixture, {
        planOriginId: String(fixture.appointmentId + 1),
      });
    } catch (error) {
      wrongOriginFailure = error;
    }
    await client.query('ROLLBACK TO SAVEPOINT expected_wrong_follow_up_origin');
    expect(wrongOriginFailure).toMatchObject({ code: '23514' });
    expect(wrongOriginFailure.message).toContain(
      'exact appointment',
    );

    const closure = await insertOpClosureWithFollowUp(client, fixture);
    await client.query('SAVEPOINT expected_rebound_follow_up_plan');
    let dependencyFailure;
    try {
      await client.query(
        `UPDATE follow_up_plans
            SET origin_resource_id = $3::text,
                updated_at = updated_at + INTERVAL '1 second'
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        [
          fixture.tenantId,
          closure.planId,
          String(fixture.appointmentId + 1),
        ],
      );
      await client.query(
        'SET CONSTRAINTS trg_follow_up_plans_op_closure_dependency IMMEDIATE',
      );
    } catch (error) {
      dependencyFailure = error;
    }
    await client.query('ROLLBACK TO SAVEPOINT expected_rebound_follow_up_plan');
    await client.query(
      'SET CONSTRAINTS trg_follow_up_plans_op_closure_dependency DEFERRED',
    );
    expect(dependencyFailure).toMatchObject({ code: '23514' });
    expect(dependencyFailure.message).toContain(
      'remain bound to its exact appointment',
    );

    await client.query(
      `UPDATE follow_up_plans
          SET status = 'completed', closed_at = NOW(),
              updated_at = updated_at + INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, closure.planId],
    );
    await expect(
      flushConstraint(
        client,
        'trg_follow_up_plans_op_closure_dependency',
      ),
    ).resolves.toBeUndefined();
  });

  test('rejects a noncanonical review task and a stale OP step', async () => {
    await client.query('SAVEPOINT expected_wrong_task_contract');
    let wrongTaskFailure;
    try {
      await insertOpTransferRequest(client, fixture, {
        taskMetadata: { source_appointment_id: '999999' },
      });
      await client.query(
        `SET CONSTRAINTS ${OP_TRANSFER_CONSTRAINT} IMMEDIATE`,
      );
    } catch (error) {
      wrongTaskFailure = error;
    }
    await client.query('ROLLBACK TO SAVEPOINT expected_wrong_task_contract');
    await client.query(
      `SET CONSTRAINTS ${OP_TRANSFER_CONSTRAINT} DEFERRED`,
    );
    expect(wrongTaskFailure).toMatchObject({ code: '23514' });
    expect(wrongTaskFailure.message).toContain(
      'OP-to-inpatient transfer review task binding is noncanonical',
    );

    const valid = await insertOpTransferRequest(client, fixture, {
      idempotencyKey: `s4-op-stale-${token()}`,
    });
    await client.query(
      `UPDATE workflow_steps
          SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND workflow_run_id = $2::integer
          AND step_key = $3::text`,
      [fixture.tenantId, fixture.runId, fixture.stepKey],
    );
    await client.query(
      `INSERT INTO workflow_steps
         (tenant_id, workflow_run_id, step_key, display_name, step_kind,
          status, ordering)
       VALUES ($1::uuid, $2::integer, 'closure', 'Closure', 'task',
               'pending', 2)`,
      [fixture.tenantId, fixture.runId],
    );
    await expectDeferredFailure(
      client,
      `UPDATE workflow_runs
          SET current_step_key = 'closure', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.runId],
      'exact OP pathway, appointment, patient, step, and review task',
    );
    expect(valid.id).toBeDefined();
  });

  test('rejects partial acceptance and accepts exact recipient plus completed task', async () => {
    const request = await insertOpTransferRequest(client, fixture);
    await flushConstraint(client);
    await expectDeferredFailure(
      client,
      `UPDATE care_handoff_instances
          SET status = 'accepted', accepted_at = NOW(),
              accepted_by_uid = $3::uuid,
              updated_at = updated_at + INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [fixture.tenantId, request.id, fixture.recipientUid],
      'completed review task',
    );

    await client.query(
      `UPDATE tasks
          SET status = 'completed', completed_at = NOW(),
              updated_at = updated_at + INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, request.task_id],
    );
    await client.query(
      `UPDATE care_handoff_instances
          SET status = 'accepted', accepted_at = NOW(),
              accepted_by_uid = $3::uuid,
              updated_at = updated_at + INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [fixture.tenantId, request.id, fixture.recipientUid],
    );
    await expect(flushConstraint(client)).resolves.toBeUndefined();
  });
});

describeIfDb('migration 595 pending-result generation integrity', () => {
  const pendingConstraint =
    'trg_discharge_pending_result_handoffs_validate';
  const ownerActionConstraint =
    'trg_discharge_pending_result_owner_actions_validate';
  const ownerTaskStateConstraint =
    'trg_tasks_pending_result_owner_state_dependency';
  const trackingTaskStateConstraint =
    'trg_tasks_pending_result_tracking_state_dependency';
  const primaryAssignmentConstraint =
    'trg_inpatient_primary_assignments_pending_dependency';
  const reservedTaskConstraint =
    'trg_tasks_s4_reserved_domain_binding';
  let client;
  let fixture;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    fixture = await seedPendingResultFixture(client);
    await flushConstraint(client, primaryAssignmentConstraint);
    await flushConstraint(client, pendingConstraint);
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  afterAll(async () => {
    await client.end();
  });

  async function makeOwnerActionGenerationAvailable() {
    const generationId = await insertDiagnosticGeneration(client, fixture);
    await client.query(
      `UPDATE discharge_pending_result_handoffs
          SET handoff_state = 'result_available',
              resolution_generation_id = $3::uuid,
              result_status = 'available',
              updated_at = updated_at + INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [fixture.tenantId, fixture.pendingId, generationId],
    );
    return generationId;
  }

  async function makeAnchoredOwnerAction() {
    const generationId = await makeOwnerActionGenerationAvailable();
    const action = await insertPendingResultOwnerAction(
      client,
      fixture,
      generationId,
    );
    await flushConstraint(client, ownerActionConstraint);
    await flushConstraint(client, pendingConstraint);
    return { action, generationId };
  }

  test('uses an exact unpredicated unique key for the owner-action successor relation', async () => {
    const index = await client.query(
      `SELECT source.indisunique,
              source.indpred IS NULL AS is_unpredicated,
              ARRAY_TO_JSON(
                ARRAY_AGG(attribute.attname ORDER BY key.ordinality)
              ) AS columns
         FROM pg_index AS source
         JOIN pg_class AS index_relation
           ON index_relation.oid = source.indexrelid
         JOIN pg_class AS table_relation
           ON table_relation.oid = source.indrelid
         JOIN LATERAL UNNEST(source.indkey)
              WITH ORDINALITY AS key(attribute_number, ordinality)
           ON TRUE
         JOIN pg_attribute AS attribute
           ON attribute.attrelid = table_relation.oid
          AND attribute.attnum = key.attribute_number
        WHERE table_relation.relname =
              'discharge_pending_result_owner_actions'
          AND index_relation.relname =
              'ux_discharge_pending_result_owner_actions_successor'
        GROUP BY source.indisunique, source.indpred`,
    );

    expect(index.rows).toEqual([
      {
        indisunique: true,
        is_unpredicated: true,
        columns: [
          'tenant_id',
          'predecessor_owner_action_id',
          'handoff_id',
          'admission_id',
          'patient_uid',
        ],
      },
    ]);
  });

  test('protects the live parent tracking task from direct mutation', async () => {
    await expectDeferredFailure(
      client,
      `UPDATE tasks
          SET assigned_to_uid = $3::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [
        fixture.tenantId,
        fixture.taskId,
        fixture.transferredPhysicianUid,
      ],
      'must match the final handoff binding, owner, and lifecycle state',
      trackingTaskStateConstraint,
    );
    await expectDeferredFailure(
      client,
      `UPDATE tasks
          SET status = 'completed',
              completed_at = NOW(),
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.taskId],
      'must match the final handoff binding, owner, and lifecycle state',
      trackingTaskStateConstraint,
    );
    await expectDeferredFailure(
      client,
      `UPDATE tasks
          SET status = 'cancelled',
              cancelled_at = NOW(),
              cancellation_reason = 'Generic cancellation',
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.taskId],
      'must match the final handoff binding, owner, and lifecycle state',
      trackingTaskStateConstraint,
    );
    await expectStatementFailure(
      client,
      `UPDATE tasks
          SET related_resource_id = $3::text,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.taskId, randomUUID()],
      'P0001',
      'pending-result tracking task correlation evidence is immutable',
    );
    await expectStatementFailure(
      client,
      `DELETE FROM tasks
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, fixture.taskId],
      'P0001',
      'pending-result tracking task correlation evidence is immutable',
    );

    const unchanged = await client.query(
      `SELECT task.assigned_to_uid,
              task.assigned_to_role,
              task.status,
              task.related_resource_type,
              task.related_resource_id
         FROM tasks AS task
        WHERE task.tenant_id = $1::uuid AND task.id = $2::integer`,
      [fixture.tenantId, fixture.taskId],
    );
    expect(unchanged.rows).toEqual([
      {
        assigned_to_uid: fixture.physicianUid,
        assigned_to_role: null,
        status: 'open',
        related_resource_type: 'discharge_pending_result_handoff',
        related_resource_id: fixture.pendingId,
      },
    ]);
  });

  test('rejects deletion of the current pending-result owner-action task', async () => {
    const { action } = await makeAnchoredOwnerAction();
    await expectStatementFailure(
      client,
      `DELETE FROM tasks
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, action.taskId],
      'P0001',
      'pending-result owner-action task correlation evidence is immutable',
    );
  });

  test('does not apply pending-result immutability to unrelated tasks', async () => {
    const task = await client.query(
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid, status, created_by)
       VALUES ($1::uuid, 'general', 'Unrelated task', $2::uuid, 'open',
               $3::uuid)
       RETURNING id`,
      [fixture.tenantId, fixture.patientUid, fixture.physicianUid],
    );
    const taskId = Number(task.rows[0].id);
    await client.query(
      `UPDATE tasks
          SET title = 'Updated unrelated task', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, taskId],
    );
    await client.query(
      `DELETE FROM tasks
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, taskId],
    );
    await expect(
      flushConstraint(client, reservedTaskConstraint),
    ).resolves.toBeUndefined();
  });

  test.each([
    [
      'OP-to-inpatient transfer task kind',
      'op_to_inpatient_transfer_review',
      'care_handoff_instance',
    ],
    [
      'pending-result owner-transfer task kind',
      'pathway_owner_transfer_review',
      'care_handoff_instance',
    ],
    [
      'pending-result handoff resource',
      'follow_up',
      'discharge_pending_result_handoff',
    ],
    [
      'pending-result owner-action resource',
      'review',
      'discharge_pending_result_action',
    ],
  ])('rejects an orphan reserved %s', async (
    _label,
    taskKind,
    relatedResourceType,
  ) => {
    await expectDeferredFailure(
      client,
      `INSERT INTO tasks
         (tenant_id, task_kind, title, patient_uid,
          related_resource_type, related_resource_id, status,
          assigned_to_uid, created_by)
       VALUES ($1::uuid, $2::text, 'Orphan reserved S4 task', $3::uuid,
               $4::text, $5::text, 'open', $6::uuid, $6::uuid)`,
      [
        fixture.tenantId,
        taskKind,
        fixture.patientUid,
        relatedResourceType,
        randomUUID(),
        fixture.physicianUid,
      ],
      'must bind to exactly one matching current domain row',
      reservedTaskConstraint,
    );
  });

  test('rejects self-referencing and two-node orphan tracking-task cycles', async () => {
    await expectDeferredOperationFailure(
      client,
      async () => {
        const sequence = await client.query(
          `SELECT nextval(pg_get_serial_sequence('tasks', 'id'))::integer
             AS id`,
        );
        const taskId = Number(sequence.rows[0].id);
        await client.query(
          `INSERT INTO tasks
             (id, tenant_id, task_kind, title, patient_uid,
              related_resource_type, related_resource_id, status,
              completed_at, assigned_to_uid, metadata)
           VALUES ($1::integer, $2::uuid, 'follow_up',
                   'Self-cycle orphan', $3::uuid,
                   'discharge_pending_result_handoff', $4::text,
                   'completed', NOW(), $5::uuid,
                   jsonb_build_object(
                     'task_contract',
                       'discharge_pending_result_tracking_v1',
                     'predecessor_tracking_task_id', $1::integer,
                     'rearm_reason', 'corrected_generation'
                   ))`,
          [
            taskId,
            fixture.tenantId,
            fixture.patientUid,
            randomUUID(),
            fixture.physicianUid,
          ],
        );
      },
      'must bind to exactly one matching current domain row',
      reservedTaskConstraint,
    );

    await expectDeferredOperationFailure(
      client,
      async () => {
        const sequence = await client.query(
          `SELECT nextval(pg_get_serial_sequence('tasks', 'id'))::integer
                    AS first_id,
                  nextval(pg_get_serial_sequence('tasks', 'id'))::integer
                    AS second_id`,
        );
        const firstId = Number(sequence.rows[0].first_id);
        const secondId = Number(sequence.rows[0].second_id);
        const resourceId = randomUUID();
        for (const [taskId, predecessorTaskId] of [
          [firstId, secondId],
          [secondId, firstId],
        ]) {
          await client.query(
            `INSERT INTO tasks
               (id, tenant_id, task_kind, title, patient_uid,
                related_resource_type, related_resource_id, status,
                completed_at, assigned_to_uid, metadata)
             VALUES ($1::integer, $2::uuid, 'follow_up',
                     'Two-cycle orphan', $3::uuid,
                     'discharge_pending_result_handoff', $4::text,
                     'completed', NOW(), $5::uuid,
                     jsonb_build_object(
                       'task_contract',
                         'discharge_pending_result_tracking_v1',
                       'predecessor_tracking_task_id', $6::integer,
                       'rearm_reason', 'doctor_reopened'
                     ))`,
            [
              taskId,
              fixture.tenantId,
              fixture.patientUid,
              resourceId,
              fixture.physicianUid,
              predecessorTaskId,
            ],
          );
        }
      },
      'must bind to exactly one matching current domain row',
      reservedTaskConstraint,
    );
  });

  test('rejects a generation from another admission before state can advance', async () => {
    const generationId = await insertDiagnosticGeneration(client, fixture, {
      admissionId: fixture.otherAdmissionId,
      investigationId: fixture.otherAdmissionInvestigationId,
    });
    await client.query('SAVEPOINT expected_wrong_admission_generation');
    let failure;
    try {
      await client.query(
        `UPDATE discharge_pending_result_handoffs
            SET handoff_state = 'result_available',
                resolution_generation_id = $3::uuid,
                result_status = 'available',
                updated_at = updated_at + INTERVAL '1 second'
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [fixture.tenantId, fixture.pendingId, generationId],
      );
      // Migration 634 made composite patient_uid FKs DEFERRABLE (INITIALLY
      // IMMEDIATE), and this suite runs under SET CONSTRAINTS ALL DEFERRED,
      // so force the FK check to fire now instead of at COMMIT.
      await client.query(
        `SET CONSTRAINTS fk_discharge_pending_result_handoffs_generation
           IMMEDIATE`,
      );
    } catch (error) {
      failure = error;
    }
    await client.query(
      'ROLLBACK TO SAVEPOINT expected_wrong_admission_generation',
    );
    await client.query(
      `SET CONSTRAINTS fk_discharge_pending_result_handoffs_generation
         DEFERRED`,
    );
    expect(failure).toMatchObject({ code: '23503' });
    expect(failure.constraint).toBe(
      'fk_discharge_pending_result_handoffs_generation',
    );
  });

  test('rejects a same-admission generation for another typed source', async () => {
    const generationId = await insertDiagnosticGeneration(client, fixture, {
      investigationId: fixture.otherInvestigationId,
    });
    await expectDeferredFailure(
      client,
      `UPDATE discharge_pending_result_handoffs
          SET handoff_state = 'result_available',
              resolution_generation_id = $3::uuid,
              result_status = 'available',
              updated_at = updated_at + INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [fixture.tenantId, fixture.pendingId, generationId],
      'exact admission, patient, and typed source',
      pendingConstraint,
    );
  });

  test('accepts an exact generation once and rejects replacement', async () => {
    const generationId = await insertDiagnosticGeneration(client, fixture);
    await client.query(
      `UPDATE discharge_pending_result_handoffs
          SET handoff_state = 'result_available',
              resolution_generation_id = $3::uuid,
              result_status = 'available',
              updated_at = updated_at + INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [fixture.tenantId, fixture.pendingId, generationId],
    );
    await insertPendingResultOwnerAction(
      client,
      fixture,
      generationId,
    );
    await flushConstraint(client, ownerActionConstraint);
    await flushConstraint(client, pendingConstraint);

    const replacementId = await insertDiagnosticGeneration(client, fixture, {
      sourceVersion: 2,
    });
    await client.query('SAVEPOINT expected_generation_replacement');
    let failure;
    try {
      await client.query(
        `UPDATE discharge_pending_result_handoffs
            SET resolution_generation_id = $3::uuid,
                updated_at = updated_at + INTERVAL '1 second'
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [fixture.tenantId, fixture.pendingId, replacementId],
      );
    } catch (error) {
      failure = error;
    }
    await client.query('ROLLBACK TO SAVEPOINT expected_generation_replacement');
    expect(failure).toMatchObject({ code: 'P0001' });
    expect(failure.message).toContain(
      'pending-result resolution generation evidence is fill-once',
    );
  });

  test('accepts only the legacy canonical signed-summary event name', async () => {
    const summary = await client.query(
      `INSERT INTO discharge_summaries
         (tenant_id, admission_id, patient_uid, status, signed_by,
          signed_at, created_by)
       VALUES ($1::uuid, $2::integer, $3::uuid, 'signed', $4::uuid,
               NOW(), $4::uuid)
       RETURNING id`,
      [
        fixture.tenantId,
        fixture.admissionId,
        fixture.patientUid,
        fixture.physicianUid,
      ],
    );
    const summaryId = Number(summary.rows[0].id);
    const wrongTimelineId = randomUUID();
    await client.query(
      `INSERT INTO clinical_timeline_events
         (id, tenant_id, patient_uid, event_type, event_status,
          source_table, source_id, occurred_at, visible_to_patient,
          clinical_summary, payload, tags, idempotency_key)
       VALUES ($1::uuid, $2::uuid, $3::uuid,
               'clinical_document.discharge_summary.signed', 'signed',
               'discharge_summaries', $4::text, NOW(), FALSE,
               'Signed discharge summary', '{}'::jsonb,
               ARRAY['discharge_summary']::text[], $5::text)`,
      [
        wrongTimelineId,
        fixture.tenantId,
        fixture.patientUid,
        String(summaryId),
        `s4-wrong-summary-timeline-${wrongTimelineId}`,
      ],
    );
    await expectDeferredFailure(
      client,
      `UPDATE discharge_pending_result_handoffs
          SET discharge_summary_id = $3::integer,
              summary_included_at = NOW(),
              summary_inclusion_timeline_event_id = $4::uuid,
              updated_at = updated_at + INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [
        fixture.tenantId,
        fixture.pendingId,
        summaryId,
        wrongTimelineId,
      ],
      'exact signed discharge summary event',
      pendingConstraint,
    );

    const canonicalTimelineId = randomUUID();
    await client.query(
      `INSERT INTO clinical_timeline_events
         (id, tenant_id, patient_uid, event_type, event_status,
          source_table, source_id, occurred_at, visible_to_patient,
          clinical_summary, payload, tags, idempotency_key)
       VALUES ($1::uuid, $2::uuid, $3::uuid,
               'discharge_summary.signed', 'signed',
               'discharge_summaries', $4::text, NOW(), FALSE,
               'Signed discharge summary', '{}'::jsonb,
               ARRAY['discharge_summary']::text[], $5::text)`,
      [
        canonicalTimelineId,
        fixture.tenantId,
        fixture.patientUid,
        String(summaryId),
        `s4-canonical-summary-timeline-${canonicalTimelineId}`,
      ],
    );
    await client.query(
      `UPDATE discharge_pending_result_handoffs
          SET discharge_summary_id = $3::integer,
              summary_included_at = NOW(),
              summary_inclusion_timeline_event_id = $4::uuid,
              updated_at = updated_at + INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [
        fixture.tenantId,
        fixture.pendingId,
        summaryId,
        canonicalTimelineId,
      ],
    );
    await expect(
      flushConstraint(client, pendingConstraint),
    ).resolves.toBeUndefined();
  });

  test('appends a corrected-generation action and preserves the first anchor', async () => {
    const firstGenerationId =
      await insertDiagnosticGeneration(client, fixture);
    await client.query(
      `UPDATE discharge_pending_result_handoffs
          SET handoff_state = 'result_available',
              resolution_generation_id = $3::uuid,
              result_status = 'available',
              updated_at = updated_at + INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [fixture.tenantId, fixture.pendingId, firstGenerationId],
    );
    const firstAction = await insertPendingResultOwnerAction(
      client,
      fixture,
      firstGenerationId,
    );
    await flushConstraint(client, ownerActionConstraint);
    await flushConstraint(client, pendingConstraint);

    const correctedGenerationId = await insertDiagnosticGeneration(
      client,
      fixture,
      {
        sourceVersion: 2,
        predecessorGenerationId: firstGenerationId,
      },
    );
    await client.query(
      `UPDATE tasks
          SET status = 'cancelled', cancelled_at = NOW(),
              cancellation_reason = 'Superseded by corrected generation',
              updated_at = updated_at + INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, firstAction.taskId],
    );
    const correctedAction = await insertPendingResultOwnerAction(
      client,
      fixture,
      correctedGenerationId,
      { predecessorGenerationId: firstGenerationId },
    );
    await flushConstraint(client, ownerActionConstraint);
    await flushConstraint(client, ownerTaskStateConstraint);

    const evidence = await client.query(
      `SELECT generation_id, predecessor_generation_id, task_id
         FROM discharge_pending_result_owner_actions
        WHERE tenant_id = $1::uuid AND handoff_id = $2::uuid
        ORDER BY recorded_at ASC, id ASC`,
      [fixture.tenantId, fixture.pendingId],
    );
    expect(evidence.rows).toHaveLength(2);
    expect(new Set(evidence.rows.map((row) => row.generation_id))).toEqual(
      new Set([firstGenerationId, correctedGenerationId]),
    );
    expect(
      evidence.rows.find(
        (row) => row.generation_id === correctedGenerationId,
      ),
    ).toMatchObject({
      predecessor_generation_id: firstGenerationId,
      task_id: correctedAction.taskId,
    });
    const handoff = await client.query(
      `SELECT resolution_generation_id
         FROM discharge_pending_result_handoffs
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [fixture.tenantId, fixture.pendingId],
    );
    expect(handoff.rows[0].resolution_generation_id).toBe(
      firstGenerationId,
    );

    await expect(
      client.query(
        `UPDATE discharge_pending_result_owner_actions
            SET metadata = '{"rewritten":true}'::jsonb
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [fixture.tenantId, firstAction.actionId],
      ),
    ).rejects.toMatchObject({ code: 'P0001' });
  });

  test('rejects missing and null canonical evidence correlation keys', async () => {
    const generationId = await makeOwnerActionGenerationAvailable();

    await expectDeferredOperationFailure(
      client,
      () =>
        insertPendingResultOwnerAction(client, fixture, generationId, {
          beforeOwnerActionInsert: async ({ timelineId }) => {
            await client.query(
              `UPDATE clinical_timeline_events
                  SET payload = payload - 'predecessor_generation_id'
                WHERE tenant_id = $1::uuid AND id = $2::uuid`,
              [fixture.tenantId, timelineId],
            );
          },
        }),
      'timeline event does not match its exact handoff and generation',
      ownerActionConstraint,
    );

    await expectDeferredOperationFailure(
      client,
      () =>
        insertPendingResultOwnerAction(client, fixture, generationId, {
          beforeOwnerActionInsert: async ({ taskId }) => {
            await client.query(
              `UPDATE tasks
                  SET related_resource_type = NULL
                WHERE tenant_id = $1::uuid AND id = $2::integer`,
              [fixture.tenantId, taskId],
            );
          },
        }),
      'task must be the exact live named-owner generation task',
      ownerActionConstraint,
    );

    await expectDeferredOperationFailure(
      client,
      () =>
        insertPendingResultOwnerAction(client, fixture, generationId, {
          beforeOwnerActionInsert: async ({ outboxId }) => {
            await client.query(
              `UPDATE event_outbox
                  SET payload = jsonb_set(
                    payload,
                    '{action_task_id}',
                    'null'::jsonb,
                    FALSE
                  )
                WHERE tenant_id = $1::uuid AND id = $2::bigint`,
              [fixture.tenantId, outboxId],
            );
          },
        }),
      'outbox event does not correlate its exact canonical evidence',
      ownerActionConstraint,
    );
  });

  test('rejects wrong timeline and outbox correlation values', async () => {
    const generationId = await makeOwnerActionGenerationAvailable();
    const wrongGenerationId = randomUUID();

    await expectDeferredOperationFailure(
      client,
      () =>
        insertPendingResultOwnerAction(client, fixture, generationId, {
          beforeOwnerActionInsert: async ({ timelineId }) => {
            await client.query(
              `UPDATE clinical_timeline_events
                  SET payload = jsonb_set(
                    payload,
                    '{generation_id}',
                    to_jsonb($3::text),
                    FALSE
                  )
                WHERE tenant_id = $1::uuid AND id = $2::uuid`,
              [fixture.tenantId, timelineId, wrongGenerationId],
            );
          },
        }),
      'timeline event does not match its exact handoff and generation',
      ownerActionConstraint,
    );

    await expectDeferredOperationFailure(
      client,
      () =>
        insertPendingResultOwnerAction(client, fixture, generationId, {
          beforeOwnerActionInsert: async ({ outboxId }) => {
            await client.query(
              `UPDATE event_outbox
                  SET payload = jsonb_set(
                    payload,
                    '{generation_id}',
                    to_jsonb($3::text),
                    FALSE
                  )
                WHERE tenant_id = $1::uuid AND id = $2::bigint`,
              [fixture.tenantId, outboxId, wrongGenerationId],
            );
          },
        }),
      'outbox event does not correlate its exact canonical evidence',
      ownerActionConstraint,
    );
  });

  test('keeps referenced evidence immutable while allowing outbox delivery state', async () => {
    const generationId = await makeOwnerActionGenerationAvailable();
    const action = await insertPendingResultOwnerAction(
      client,
      fixture,
      generationId,
    );
    await flushConstraint(client, ownerActionConstraint);

    const delivered = await client.query(
      `UPDATE event_outbox
          SET status = 'delivered',
              attempts = attempts + 1,
              delivered_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [fixture.tenantId, action.outboxId],
    );
    expect(delivered.rowCount).toBe(1);

    await expectStatementFailure(
      client,
      `UPDATE clinical_timeline_events
          SET payload = payload - 'predecessor_generation_id'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [fixture.tenantId, action.timelineId],
      'P0001',
      'owner-action timeline correlation evidence is immutable',
    );
    await expectStatementFailure(
      client,
      `UPDATE event_outbox
          SET aggregate_id = $3::text
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [fixture.tenantId, action.outboxId, randomUUID()],
      'P0001',
      'owner-action outbox correlation evidence is immutable',
    );
    await expectStatementFailure(
      client,
      `UPDATE clinical_audit_events
          SET resource_id = $3::text
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [fixture.tenantId, action.auditId, randomUUID()],
      'P0001',
    );
  });

  test('allows only the exact accepted primary-physician transfer to move the current task', async () => {
    const { action, generationId } = await makeAnchoredOwnerAction();
    const transfer = await insertAcceptedPrimaryTransfer(
      client,
      fixture,
      action,
    );
    await flushConstraint(
      client,
      [
        ownerTaskStateConstraint,
        primaryAssignmentConstraint,
        'trg_care_handoff_covering_transfer_invariant',
        'trg_care_pathway_instances_covering_transfer_dependency',
        'trg_tasks_covering_transfer_dependency',
        trackingTaskStateConstraint,
        pendingConstraint,
      ].join(', '),
    );

    const moved = await client.query(
      `SELECT owner_action.owner_uid,
              task.assigned_to_uid,
              handoff.named_physician_uid,
              handoff.primary_physician_assignment_id,
              assignment.assignment_source,
              assignment.accepted_handoff_id
         FROM discharge_pending_result_owner_actions AS owner_action
         JOIN tasks AS task
           ON task.tenant_id = owner_action.tenant_id
          AND task.id = owner_action.task_id
         JOIN discharge_pending_result_handoffs AS handoff
           ON handoff.tenant_id = owner_action.tenant_id
          AND handoff.id = owner_action.handoff_id
         JOIN inpatient_primary_physician_assignments AS assignment
           ON assignment.tenant_id = handoff.tenant_id
          AND assignment.id = handoff.primary_physician_assignment_id
        WHERE owner_action.tenant_id = $1::uuid
          AND owner_action.handoff_id = $2::uuid
          AND owner_action.generation_id = $3::uuid`,
      [fixture.tenantId, fixture.pendingId, generationId],
    );
    expect(moved.rows).toEqual([
      expect.objectContaining({
        owner_uid: fixture.physicianUid,
        assigned_to_uid: fixture.transferredPhysicianUid,
        named_physician_uid: fixture.transferredPhysicianUid,
        primary_physician_assignment_id: transfer.assignmentId,
        assignment_source: 'accepted_covering_handoff',
        accepted_handoff_id: transfer.handoffId,
      }),
    ]);
  });

  test('rejects standalone reassignment and arbitrary cancellation without state drift', async () => {
    const { action } = await makeAnchoredOwnerAction();

    await expectDeferredFailure(
      client,
      `UPDATE tasks
          SET assigned_to_uid = $3::uuid,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [
        fixture.tenantId,
        action.taskId,
        fixture.transferredPhysicianUid,
      ],
      'task must match the final named physician',
      ownerTaskStateConstraint,
    );
    await expectDeferredFailure(
      client,
      `UPDATE tasks
          SET status = 'cancelled',
              cancelled_at = NOW(),
              cancellation_reason = 'Arbitrary cancellation',
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, action.taskId],
      'task cancellation requires its exact successor action',
      ownerTaskStateConstraint,
    );

    const unchanged = await client.query(
      `SELECT assigned_to_uid, assigned_to_role, status
         FROM tasks
        WHERE tenant_id = $1::uuid AND id = $2::integer`,
      [fixture.tenantId, action.taskId],
    );
    expect(unchanged.rows).toEqual([
      {
        assigned_to_uid: fixture.physicianUid,
        assigned_to_role: null,
        status: 'open',
      },
    ]);
  });

  test('rolls back an accepted transfer that omits the current child task', async () => {
    const { action } = await makeAnchoredOwnerAction();

    await expectDeferredOperationFailure(
      client,
      () =>
        insertAcceptedPrimaryTransfer(client, fixture, action, {
          updateChildTask: false,
        }),
      'must update every current pending-result owner-action task',
      primaryAssignmentConstraint,
    );

    const unchanged = await client.query(
      `SELECT handoff.named_physician_uid,
              handoff.primary_physician_assignment_id,
              tracking_task.assigned_to_uid AS tracking_owner_uid,
              action_task.assigned_to_uid AS action_owner_uid,
              (
                SELECT COUNT(*)::integer
                  FROM inpatient_primary_physician_assignments AS assignment
                 WHERE assignment.tenant_id = handoff.tenant_id
                   AND assignment.admission_id = handoff.admission_id
                   AND assignment.assignment_version > 1
              ) AS successor_count
         FROM discharge_pending_result_handoffs AS handoff
         JOIN tasks AS tracking_task
           ON tracking_task.tenant_id = handoff.tenant_id
          AND tracking_task.id = handoff.task_id
         JOIN tasks AS action_task
           ON action_task.tenant_id = $1::uuid
          AND action_task.id = $3::integer
        WHERE handoff.tenant_id = $1::uuid AND handoff.id = $2::uuid`,
      [fixture.tenantId, fixture.pendingId, action.taskId],
    );
    expect(unchanged.rows).toEqual([
      expect.objectContaining({
        named_physician_uid: fixture.physicianUid,
        primary_physician_assignment_id: fixture.assignmentId,
        tracking_owner_uid: fixture.physicianUid,
        action_owner_uid: fixture.physicianUid,
        successor_count: 0,
      }),
    ]);
  });

  test('rolls back an accepted transfer while the admission attending is stale', async () => {
    const { action } = await makeAnchoredOwnerAction();

    await expectDeferredOperationFailure(
      client,
      () =>
        insertAcceptedPrimaryTransfer(client, fixture, action, {
          updateAdmissionAttending: false,
        }),
      'requires exact accepted handoff, final admission attending, and canonical evidence',
      primaryAssignmentConstraint,
    );

    const unchanged = await client.query(
      `SELECT admission.attending_doctor,
              handoff.named_physician_uid,
              handoff.primary_physician_assignment_id,
              (
                SELECT COUNT(*)::integer
                  FROM inpatient_primary_physician_assignments AS assignment
                 WHERE assignment.tenant_id = handoff.tenant_id
                   AND assignment.admission_id = handoff.admission_id
                   AND assignment.assignment_version > 1
              ) AS successor_count
         FROM discharge_pending_result_handoffs AS handoff
         JOIN admissions AS admission
           ON admission.tenant_id = handoff.tenant_id
          AND admission.id = handoff.admission_id
          AND admission.patient_uid = handoff.patient_uid
        WHERE handoff.tenant_id = $1::uuid AND handoff.id = $2::uuid`,
      [fixture.tenantId, fixture.pendingId],
    );
    expect(unchanged.rows).toEqual([
      expect.objectContaining({
        attending_doctor: fixture.physicianUid,
        named_physician_uid: fixture.physicianUid,
        primary_physician_assignment_id: fixture.assignmentId,
        successor_count: 0,
      }),
    ]);
  });

  test('rolls back an accepted transfer while a successor generation awaits its owner action', async () => {
    const { action, generationId } = await makeAnchoredOwnerAction();
    const successorGenerationId = await insertDiagnosticGeneration(
      client,
      fixture,
      {
        sourceVersion: 2,
        predecessorGenerationId: generationId,
      },
    );

    await expectDeferredOperationFailure(
      client,
      () =>
        insertAcceptedPrimaryTransfer(client, fixture, action, {
          updateChildTask: false,
        }),
      'must wait for every signed successor generation to acquire its owner action',
      primaryAssignmentConstraint,
    );

    const unchanged = await client.query(
      `SELECT admission.attending_doctor,
              handoff.named_physician_uid,
              handoff.primary_physician_assignment_id,
              action_task.assigned_to_uid AS action_owner_uid,
              (
                SELECT COUNT(*)::integer
                  FROM inpatient_primary_physician_assignments AS assignment
                 WHERE assignment.tenant_id = handoff.tenant_id
                   AND assignment.admission_id = handoff.admission_id
                   AND assignment.assignment_version > 1
              ) AS successor_assignment_count,
              (
                SELECT COUNT(*)::integer
                  FROM discharge_pending_result_owner_actions AS successor
                 WHERE successor.tenant_id = handoff.tenant_id
                   AND successor.handoff_id = handoff.id
                   AND successor.generation_id = $4::uuid
              ) AS successor_action_count
         FROM discharge_pending_result_handoffs AS handoff
         JOIN admissions AS admission
           ON admission.tenant_id = handoff.tenant_id
          AND admission.id = handoff.admission_id
          AND admission.patient_uid = handoff.patient_uid
         JOIN tasks AS action_task
           ON action_task.tenant_id = handoff.tenant_id
          AND action_task.id = $3::integer
        WHERE handoff.tenant_id = $1::uuid AND handoff.id = $2::uuid`,
      [
        fixture.tenantId,
        fixture.pendingId,
        action.taskId,
        successorGenerationId,
      ],
    );
    expect(unchanged.rows).toEqual([
      expect.objectContaining({
        attending_doctor: fixture.physicianUid,
        named_physician_uid: fixture.physicianUid,
        primary_physician_assignment_id: fixture.assignmentId,
        action_owner_uid: fixture.physicianUid,
        successor_assignment_count: 0,
        successor_action_count: 0,
      }),
    ]);
  });

  test('real service re-arms a corrected generation with canonical lineage', async () => {
    const tx = pgTransactionClient(client);
    const firstGenerationId =
      await insertDiagnosticGeneration(client, fixture);
    const firstLinked =
      await linkPendingResultOwnerActionsForGenerationTx({
        tx,
        tenantId: fixture.tenantId,
        generationId: firstGenerationId,
      });
    expect(firstLinked).toHaveLength(1);
    expect(firstLinked[0].owner_action).toMatchObject({
      generation_id: firstGenerationId,
      predecessor_generation_id: null,
    });
    await flushConstraint(client, ownerActionConstraint);
    await flushConstraint(client, ownerTaskStateConstraint);
    await flushConstraint(client, pendingConstraint);

    const correctedGenerationId = await insertDiagnosticGeneration(
      client,
      fixture,
      {
        sourceVersion: 2,
        predecessorGenerationId: firstGenerationId,
      },
    );
    const correctedLinked =
      await linkPendingResultOwnerActionsForGenerationTx({
        tx,
        tenantId: fixture.tenantId,
        generationId: correctedGenerationId,
      });
    expect(correctedLinked).toHaveLength(1);
    expect(correctedLinked[0].owner_action).toMatchObject({
      generation_id: correctedGenerationId,
      predecessor_generation_id: firstGenerationId,
    });
    await flushConstraint(client, ownerActionConstraint);
    await flushConstraint(client, ownerTaskStateConstraint);
    await flushConstraint(client, pendingConstraint);

    const rows = await client.query(
      `SELECT action.generation_id, action.predecessor_generation_id,
              task.status AS task_status,
              timeline.event_status AS timeline_status,
              timeline.payload ->> 'predecessor_generation_id'
                AS timeline_predecessor,
              outbox.payload ->> 'predecessor_generation_id'
                AS outbox_predecessor
         FROM discharge_pending_result_owner_actions AS action
         JOIN tasks AS task
           ON task.tenant_id = action.tenant_id
          AND task.id = action.task_id
         JOIN clinical_timeline_events AS timeline
           ON timeline.tenant_id = action.tenant_id
          AND timeline.id = action.canonical_timeline_event_id
         JOIN event_outbox AS outbox
           ON outbox.tenant_id = action.tenant_id
          AND outbox.id = action.source_outbox_event_id
        WHERE action.tenant_id = $1::uuid
          AND action.handoff_id = $2::uuid
        ORDER BY action.predecessor_generation_id NULLS FIRST`,
      [fixture.tenantId, fixture.pendingId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({
      generation_id: firstGenerationId,
      predecessor_generation_id: null,
      task_status: 'cancelled',
      timeline_status: 'result_available',
      timeline_predecessor: null,
      outbox_predecessor: null,
    });
    expect(rows.rows[1]).toMatchObject({
      generation_id: correctedGenerationId,
      predecessor_generation_id: firstGenerationId,
      task_status: 'open',
      timeline_status: 'result_rearmed',
      timeline_predecessor: firstGenerationId,
      outbox_predecessor: firstGenerationId,
    });
    const handoff = await client.query(
      `SELECT resolution_generation_id
         FROM discharge_pending_result_handoffs
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [fixture.tenantId, fixture.pendingId],
    );
    expect(handoff.rows[0].resolution_generation_id).toBe(
      firstGenerationId,
    );
  });

  test('rejects an owner action for a generation that is no longer the leaf', async () => {
    const firstGenerationId =
      await insertDiagnosticGeneration(client, fixture);
    await client.query(
      `UPDATE discharge_pending_result_handoffs
          SET handoff_state = 'result_available',
              resolution_generation_id = $3::uuid,
              result_status = 'available',
              updated_at = updated_at + INTERVAL '1 second'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [fixture.tenantId, fixture.pendingId, firstGenerationId],
    );
    const firstAction = await insertPendingResultOwnerAction(
      client,
      fixture,
      firstGenerationId,
    );
    await flushConstraint(client, ownerActionConstraint);
    await flushConstraint(client, pendingConstraint);
    await insertDiagnosticGeneration(client, fixture, {
      sourceVersion: 2,
      predecessorGenerationId: firstGenerationId,
    });

    await client.query('SAVEPOINT expected_stale_owner_action');
    let failure;
    try {
      await client.query(
        `UPDATE tasks
            SET status = 'cancelled', cancelled_at = NOW(),
                cancellation_reason = 'Stale-leaf validation probe',
                updated_at = updated_at + INTERVAL '1 second'
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        [fixture.tenantId, firstAction.taskId],
      );
      await insertPendingResultOwnerAction(
        client,
        fixture,
        firstGenerationId,
        {
          predecessorGenerationId: firstGenerationId,
          predecessorOwnerActionId: firstAction.actionId,
        },
      );
      await client.query(
        `SET CONSTRAINTS ${ownerActionConstraint} IMMEDIATE`,
      );
    } catch (error) {
      failure = error;
    }
    await client.query('ROLLBACK TO SAVEPOINT expected_stale_owner_action');
    await client.query(
      `SET CONSTRAINTS ${ownerActionConstraint} DEFERRED`,
    );
    if (failure?.code && failure.code !== '23514') throw failure;
    expect(failure).toMatchObject({ code: '23514' });
    expect(failure.message).toContain('current signed leaf');
  });

  test('rejects parent-only, child-only, and wrong-child settlement', async () => {
    const { action, generationId } = await makeAnchoredOwnerAction();
    const resolution = await insertNormalDiagnosticResolutionAction(
      client,
      fixture,
      generationId,
    );
    const resolveHandoff = () =>
      client.query(
        `UPDATE discharge_pending_result_handoffs
            SET handoff_state = 'resolved',
                result_status = 'normal',
                resolved_at = NOW(),
                resolved_by_uid = NULL,
                resolution_action_id = $3::uuid,
                updated_at = updated_at + INTERVAL '1 second'
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [fixture.tenantId, fixture.pendingId, resolution.actionId],
      );
    const completeTask = (taskId) =>
      client.query(
        `UPDATE tasks
            SET status = 'completed', completed_at = NOW(),
                updated_at = updated_at + INTERVAL '1 second'
          WHERE tenant_id = $1::uuid AND id = $2::integer`,
        [fixture.tenantId, taskId],
      );

    await expectDeferredOperationFailure(
      client,
      async () => {
        await completeTask(fixture.taskId);
        await resolveHandoff();
      },
      'coherent parent/child task settlement',
      pendingConstraint,
    );

    await expectDeferredOperationFailure(
      client,
      async () => {
        await completeTask(action.taskId);
        await resolveHandoff();
      },
      'lifecycle state',
      pendingConstraint,
    );

    await expectDeferredOperationFailure(
      client,
      async () => {
        const wrongChild = await client.query(
          `INSERT INTO tasks
             (tenant_id, parent_task_id, task_kind, title, patient_uid,
              status, assigned_to_uid, created_by)
           VALUES ($1::uuid, $2::integer, 'review',
                   'Wrong pending-result child', $3::uuid,
                   'open', $4::uuid, $4::uuid)
           RETURNING id`,
          [
            fixture.tenantId,
            fixture.taskId,
            fixture.patientUid,
            fixture.physicianUid,
          ],
        );
        await completeTask(fixture.taskId);
        await completeTask(Number(wrongChild.rows[0].id));
        await resolveHandoff();
      },
      'coherent parent/child task settlement',
      pendingConstraint,
    );
  });

  test('requires exact settlement receipts and accepts the real service path', async () => {
    const { action, generationId } = await makeAnchoredOwnerAction();
    const resolution = await insertNormalDiagnosticResolutionAction(
      client,
      fixture,
      generationId,
    );

    for (const {
      receiptOptions,
      expectedMessage,
    } of [
      {
        receiptOptions: {
          includeTimeline: false,
          includeAudit: false,
          includeOutbox: false,
        },
        expectedMessage: 'exact discharge-resolution timeline receipt',
      },
      {
        receiptOptions: {
          includeTimeline: true,
          includeAudit: false,
          includeOutbox: false,
        },
        expectedMessage: 'exact discharge-resolution audit receipt',
      },
      {
        receiptOptions: {
          includeTimeline: true,
          includeAudit: true,
          includeOutbox: false,
        },
        expectedMessage: 'one exact discharge-resolution outbox receipt',
      },
    ]) {
      await expectDeferredOperationFailure(
        client,
        async () => {
          await client.query(
            `UPDATE tasks
                SET status = 'completed', completed_at = NOW(),
                    updated_at = updated_at + INTERVAL '1 second'
              WHERE tenant_id = $1::uuid
                AND id = ANY($2::integer[])`,
            [fixture.tenantId, [fixture.taskId, action.taskId]],
          );
          await insertPendingResultSettlementReceipts(
            client,
            fixture,
            action,
            generationId,
            resolution,
            receiptOptions,
          );
          await client.query(
            `UPDATE discharge_pending_result_handoffs
                SET handoff_state = 'resolved',
                    result_status = 'normal',
                    resolved_at = NOW(),
                    resolved_by_uid = NULL,
                    resolution_action_id = $3::uuid,
                    updated_at = updated_at + INTERVAL '1 second'
              WHERE tenant_id = $1::uuid AND id = $2::uuid`,
            [fixture.tenantId, fixture.pendingId, resolution.actionId],
          );
        },
        expectedMessage,
        pendingConstraint,
      );
    }

    const settled =
      await settlePendingResultOwnerActionsForDiagnosticActionTx({
        tx: pgTransactionClient(client),
        tenantId: fixture.tenantId,
        diagnosticActionId: resolution.actionId,
      });
    expect(settled).toHaveLength(1);
    await flushConstraint(
      client,
      [
        ownerTaskStateConstraint,
        trackingTaskStateConstraint,
        pendingConstraint,
        reservedTaskConstraint,
      ].join(', '),
    );

    const receipt = await client.query(
      `SELECT handoff.handoff_state,
              handoff.resolved_by_uid,
              handoff.resolution_action_id,
              action_task.status AS action_task_status,
              tracking_task.status AS tracking_task_status,
              timeline.id AS timeline_id,
              audit.id AS audit_id,
              COUNT(outbox.id)::integer AS outbox_count
         FROM discharge_pending_result_handoffs AS handoff
         JOIN tasks AS action_task
           ON action_task.tenant_id = handoff.tenant_id
          AND action_task.id = $3::integer
         JOIN tasks AS tracking_task
           ON tracking_task.tenant_id = handoff.tenant_id
          AND tracking_task.id = handoff.task_id
         JOIN clinical_timeline_events AS timeline
           ON timeline.tenant_id = handoff.tenant_id
          AND timeline.idempotency_key = $4::text
         JOIN clinical_audit_events AS audit
           ON audit.tenant_id = handoff.tenant_id
          AND audit.idempotency_key = $5::text
         JOIN event_outbox AS outbox
           ON outbox.tenant_id = handoff.tenant_id
          AND outbox.event_type = 'discharge.pending_result_resolved'
          AND outbox.aggregate_id = handoff.id::text
          AND outbox.payload ->> 'resolution_action_id' = $6::text
        WHERE handoff.tenant_id = $1::uuid AND handoff.id = $2::uuid
        GROUP BY handoff.handoff_state, handoff.resolved_by_uid,
                 handoff.resolution_action_id, action_task.status,
                 tracking_task.status, timeline.id, audit.id`,
      [
        fixture.tenantId,
        fixture.pendingId,
        action.taskId,
        `pending-result-resolved:${fixture.tenantId}:${fixture.pendingId}:${resolution.actionId}:timeline`,
        `pending-result-resolved:${fixture.tenantId}:${fixture.pendingId}:${resolution.actionId}:audit`,
        resolution.actionId,
      ],
    );
    expect(receipt.rows).toEqual([
      expect.objectContaining({
        handoff_state: 'resolved',
        resolved_by_uid: null,
        resolution_action_id: resolution.actionId,
        action_task_status: 'completed',
        tracking_task_status: 'completed',
        outbox_count: 1,
      }),
    ]);
  });

  test('requires exact same-owner disposition receipts and accepts the real service path', async () => {
    const { action, generationId } = await makeAnchoredOwnerAction();
    const resolution = await insertSameOwnerDiagnosticDispositionAction(
      client,
      fixture,
      generationId,
    );
    const directSettlement = async ({
      addReceipts = false,
      actorUid = fixture.physicianUid,
      actorRole = 'DOCTOR',
    } = {}) => {
      await client.query(
        `UPDATE tasks
            SET status = 'completed', completed_at = NOW(),
                updated_at = updated_at + INTERVAL '1 second'
          WHERE tenant_id = $1::uuid
            AND id = ANY($2::integer[])`,
        [fixture.tenantId, [fixture.taskId, action.taskId]],
      );
      if (addReceipts) {
        await insertPendingResultSettlementReceipts(
          client,
          fixture,
          action,
          generationId,
          resolution,
          {
            eventStatus: 'ordering_owner_disposition',
            actorUid,
            actorRole,
          },
        );
      }
      await client.query(
        `UPDATE discharge_pending_result_handoffs
            SET handoff_state = 'resolved',
                result_status = 'reviewed',
                resolved_at = NOW(),
                resolved_by_uid = $3::uuid,
                resolution_action_id = $4::uuid,
                updated_at = updated_at + INTERVAL '1 second'
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [
          fixture.tenantId,
          fixture.pendingId,
          fixture.physicianUid,
          resolution.actionId,
        ],
      );
    };

    await expectDeferredOperationFailure(
      client,
      () => directSettlement(),
      'exact discharge-resolution timeline receipt',
      pendingConstraint,
    );
    await expectDeferredOperationFailure(
      client,
      () => directSettlement({
        addReceipts: true,
        actorUid: fixture.transferredPhysicianUid,
        actorRole: 'CONSULTANT',
      }),
      'exact discharge-resolution timeline receipt',
      pendingConstraint,
    );

    const settled =
      await settlePendingResultOwnerActionsForDiagnosticActionTx({
        tx: pgTransactionClient(client),
        tenantId: fixture.tenantId,
        diagnosticActionId: resolution.actionId,
      });
    expect(settled).toHaveLength(1);
    await flushConstraint(
      client,
      [
        ownerTaskStateConstraint,
        trackingTaskStateConstraint,
        pendingConstraint,
        reservedTaskConstraint,
      ].join(', '),
    );

    const receipt = await client.query(
      `SELECT timeline.event_status, timeline.actor_uid,
              timeline.actor_role, audit.actor_uid, audit.actor_role,
              COUNT(outbox.id)::integer AS outbox_count
         FROM clinical_timeline_events AS timeline
         JOIN clinical_audit_events AS audit
           ON audit.tenant_id = timeline.tenant_id
          AND audit.idempotency_key = $4::text
         JOIN event_outbox AS outbox
           ON outbox.tenant_id = timeline.tenant_id
          AND outbox.event_type = 'discharge.pending_result_resolved'
          AND outbox.aggregate_id = $2::text
          AND outbox.payload ->> 'resolution_action_id' = $3::text
        WHERE timeline.tenant_id = $1::uuid
          AND timeline.idempotency_key = $5::text
        GROUP BY timeline.event_status, timeline.actor_uid,
                 timeline.actor_role, audit.actor_uid, audit.actor_role`,
      [
        fixture.tenantId,
        fixture.pendingId,
        resolution.actionId,
        `pending-result-resolved:${fixture.tenantId}:${fixture.pendingId}:${resolution.actionId}:audit`,
        `pending-result-resolved:${fixture.tenantId}:${fixture.pendingId}:${resolution.actionId}:timeline`,
      ],
    );
    expect(receipt.rows).toEqual([
      {
        event_status: 'ordering_owner_disposition',
        actor_uid: fixture.physicianUid,
        actor_role: 'DOCTOR',
        outbox_count: 1,
      },
    ]);
  });
});
