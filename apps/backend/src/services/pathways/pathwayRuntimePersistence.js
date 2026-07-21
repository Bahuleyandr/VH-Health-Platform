import { isTenantTransactionClient } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { resolvePathwayTaskOwnerTx } from '../workflow/workflowHumanOwnerService.js';

const PATHWAY_MODES = new Set(['off', 'shadow', 'active']);
export const PATHWAY_DEFINITION_APPROVAL_KIND = 'care_pathway_definition_governance';
export const PATHWAY_DEFINITION_SUBJECT_TYPE = 'care_pathway_definition';

const INSTANCE_COLUMNS = `id, tenant_id, workflow_run_id, patient_uid, encounter_id,
  pathway_key, pathway_version, workflow_definition_id, definition_governance_id,
  definition_checksum, source_episode_type, source_episode_id,
  parent_instance_id, owning_clinician_uid, owning_team_id, accountable_role,
  clinical_status, completion_outcome, closure_reason, patient_visibility_status,
  idempotency_key, activated_at, closed_at, created_by, updated_by, metadata,
  created_at, updated_at`;

const RUN_COLUMNS = `id, tenant_id, workflow_definition_id, workflow_key, workflow_version,
  pathway_governance_id, pathway_definition_checksum, trigger_kind, trigger_payload,
  status, current_step_key,
  context, started_at, ended_at,
  due_at, initiated_by, failure_reason, metadata, created_at, updated_at`;

const STEP_COLUMNS = `id, tenant_id, workflow_run_id, step_key, display_name, step_kind,
  status, ordering, assigned_to, assigned_role, due_at, started_at, completed_at,
  outcome, outcome_payload, metadata, created_at, updated_at`;

const TASK_COLUMNS = `id, tenant_id, workflow_run_id, workflow_step_id, parent_task_id,
  task_kind, title, description, patient_uid, encounter_id, related_resource_type,
  related_resource_id, priority, status, assigned_to_uid, assigned_to_role, created_by,
  due_at, completed_at, cancelled_at, cancellation_reason, workflow_sla_instance_id,
  sla_completion_semantics, stage_occurrence_key, metadata, created_at, updated_at`;

const APPROVAL_COLUMNS = `id, tenant_id, workflow_run_id, workflow_step_id, task_id,
  approval_kind, subject_resource_type, subject_resource_id, required_approvers,
  required_role, status, approved_by, rejection_reason, expires_at, decided_at,
  created_by, decided_by, materialization_key, metadata, created_at, updated_at`;

const HANDOFF_COLUMNS = `id, tenant_id, patient_uid, sending_pathway_instance_id,
  sending_workflow_run_id, sending_step_key, receiving_pathway_instance_id,
  receiving_workflow_run_id, receiving_step_key, handoff_type, source_resource_type,
  source_resource_id, urgency_code, policy_due_at, sender_uid, sender_system_key,
  recipient_kind, intended_recipient_uid, intended_recipient_role, intended_team_id,
  external_recipient_ref, status, task_id, idempotency_key, request_reason,
  request_fingerprint, metadata,
  decline_reason, cancellation_reason, requested_at, acknowledged_at, accepted_at,
  accepted_by_uid, declined_at, completed_at, originator_closed_at, cancelled_at,
  created_at, updated_at`;

function requireTx(tx) {
  if (
    !tx
    || typeof tx.$queryRawUnsafe !== 'function'
    || !isTenantTransactionClient(tx)
  ) {
    throw AppError.internal(
      'Pathway persistence requires an existing transaction',
      'PATHWAY_RUNTIME_TX_REQUIRED',
    );
  }
  return tx;
}

export async function assertPathwayPatientContextTx({
  tx,
  tenantId,
  patientUid,
  encounterId = null,
  owningClinicianUid = null,
} = {}) {
  const db = requireTx(tx);
  const patientRows = await db.$queryRawUnsafe(
    `SELECT uid
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND role = 'PATIENT'
      LIMIT 1
      FOR SHARE`,
    tenantId,
    patientUid,
  );
  if (!patientRows[0]) {
    throw AppError.badRequest(
      'Invalid pathway patient context',
      'PATHWAY_PATIENT_CONTEXT_INVALID',
    );
  }
  if (encounterId) {
    const encounterRows = await db.$queryRawUnsafe(
      `SELECT id
         FROM patient_encounters
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND patient_uid = $3::uuid
        LIMIT 1
        FOR SHARE`,
      tenantId,
      encounterId,
      patientUid,
    );
    if (!encounterRows[0]) {
      throw AppError.badRequest(
        'Invalid pathway patient context',
        'PATHWAY_PATIENT_CONTEXT_INVALID',
      );
    }
  }
  if (owningClinicianUid !== null && owningClinicianUid !== undefined) {
    await resolvePathwayTaskOwnerTx({
      tx: db,
      tenantId,
      requestedUid: owningClinicianUid,
    });
  }
}

function normalizeMode(value) {
  const mode = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PATHWAY_MODES.has(mode) ? mode : 'off';
}

function json(value) {
  return JSON.stringify(value ?? {});
}

function noRowConflict(message, code) {
  throw AppError.conflict(message, code);
}

function assertRuntimeDefinitionPin(instance, run, definition = null) {
  const instanceChecksum = String(instance?.definition_checksum || '');
  const runChecksum = String(run?.pathway_definition_checksum || '');
  if (
    Number(instance?.workflow_run_id) !== Number(run?.id)
    || Number(instance?.workflow_definition_id) !== Number(run?.workflow_definition_id)
    || String(instance?.definition_governance_id || '').toLowerCase()
      !== String(run?.pathway_governance_id || '').toLowerCase()
    || !/^[0-9a-f]{64}$/.test(instanceChecksum)
    || instanceChecksum !== runChecksum
    || (
      definition
      && (
        Number(definition.id) !== Number(run.workflow_definition_id)
        || String(definition.governance_id || '').toLowerCase()
          !== String(run.pathway_governance_id || '').toLowerCase()
        || String(definition.definition_checksum || '') !== runChecksum
      )
    )
  ) {
    throw AppError.conflict(
      'Care pathway runtime definition pin is inconsistent',
      'PATHWAY_DEFINITION_PIN_MISMATCH',
    );
  }
  return runChecksum;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function assertGovernanceApprovalEvidence(definition) {
  const decidingActor = String(definition.approval_decided_by || '').trim().toLowerCase();
  const governanceActor = String(definition.governance_approved_by || '').trim().toLowerCase();
  const approvedBy = parseJsonArray(definition.approval_approved_by);
  const approvalMetadata = parseJsonObject(definition.approval_metadata);
  const checksumReceipt = parseJsonObject(
    approvalMetadata.care_pathway_definition_governance,
  );
  const definitionChecksum = String(definition.definition_checksum || '').trim().toLowerCase();
  const approverUids = approvedBy.map((entry) => String(entry?.uid || '').trim().toLowerCase());
  const distinctApproverUids = new Set(approverUids.filter(Boolean));
  const decidedAt = definition.approval_decided_at
    ? new Date(definition.approval_decided_at).getTime()
    : Number.NaN;
  const governanceApprovedAt = definition.governance_approved_at
    ? new Date(definition.governance_approved_at).getTime()
    : Number.NaN;
  if (
    definition.approval_status !== 'approved'
    || definition.approval_kind !== PATHWAY_DEFINITION_APPROVAL_KIND
    || definition.approval_subject_resource_type !== PATHWAY_DEFINITION_SUBJECT_TYPE
    || String(definition.approval_subject_resource_id || '') !== String(definition.id)
    || !decidingActor
    || decidingActor !== governanceActor
    || !distinctApproverUids.has(decidingActor)
    || distinctApproverUids.size !== approvedBy.length
    || distinctApproverUids.size < Number(definition.approval_required_approvers || 1)
    || !Number.isFinite(decidedAt)
    || !Number.isFinite(governanceApprovedAt)
    || governanceApprovedAt < decidedAt
    || !definitionChecksum
    || typeof checksumReceipt.definition_checksum !== 'string'
    || checksumReceipt.definition_checksum !== definitionChecksum
  ) {
    throw AppError.conflict(
      'Pathway definition governance approval evidence is invalid',
      'PATHWAY_GOVERNANCE_APPROVAL_INVALID',
    );
  }
}

export async function assertPathwayTenantScopeTx({ tx, tenantId } = {}) {
  const db = requireTx(tx);
  const rows = await db.$queryRawUnsafe(
    `SELECT NULLIF(current_setting('app.current_tenant_id', true), '') AS tenant_scope`,
  );
  const scope = String(rows[0]?.tenant_scope || '').toLowerCase();
  if (scope !== String(tenantId).toLowerCase()) {
    throw AppError.forbidden(
      'Pathway transaction is not scoped to the requested tenant',
      'PATHWAY_TENANT_SCOPE_MISMATCH',
    );
  }
}

export async function resolvePathwayModeTx({ tx, tenantId, pathwayKey } = {}) {
  const db = requireTx(tx);
  const rows = await db.$queryRawUnsafe(
    `SELECT CASE
              WHEN jsonb_typeof(settings) = 'object'
               AND jsonb_typeof(settings -> 'care_pathways') = 'object'
              THEN settings #>> ARRAY['care_pathways', $2::text]
              ELSE NULL
            END AS mode
       FROM tenants
      WHERE id = $1::uuid
      LIMIT 1`,
    tenantId,
    pathwayKey,
  );
  if (!rows[0]) {
    throw AppError.notFound('Tenant not found', 'TENANT_NOT_FOUND');
  }
  return normalizeMode(rows[0].mode);
}

export async function acquirePathwayStartLocksTx({
  tx,
  tenantId,
  workflowDefinitionId,
  pathwayKey,
  sourceEpisodeType,
  sourceEpisodeId,
  idempotencyKey,
  waitForLocks = true,
} = {}) {
  const db = requireTx(tx);
  const lockKeys = [
    `${tenantId}:care_pathway:definition:${workflowDefinitionId}`,
    `${tenantId}:care_pathway:start:${idempotencyKey}`,
    `${tenantId}:care_pathway:episode:${pathwayKey}:${sourceEpisodeType}:${sourceEpisodeId}`,
  ].sort();
  if (!waitForLocks) {
    try {
      await db.$queryRawUnsafe(
        `SELECT care_pathway_acquire_serialization_fences(
                  $1::text[],
                  $2::boolean
                )::text AS fence_result`,
        lockKeys,
        false,
      );
    } catch (error) {
      const sqlState = error?.meta?.code
        || error?.meta?.driverAdapterError?.cause?.originalCode
        || error?.code;
      if (sqlState === '40001') {
        throw AppError.conflict(
          'Care pathway start is contended; retry the transaction',
          'PATHWAY_START_SERIALIZATION_BUSY',
        );
      }
      throw error;
    }
    return;
  }
  for (const key of lockKeys) {
    await db.$queryRawUnsafe(
      `SELECT COUNT(*)::integer AS lock_count
         FROM (
           SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))
         ) AS acquired_lock`,
      key,
    );
  }
}

export async function findPathwayInstanceByIdempotencyTx({ tx, tenantId, idempotencyKey } = {}) {
  const db = requireTx(tx);
  const rows = await db.$queryRawUnsafe(
    `SELECT ${INSTANCE_COLUMNS}
       FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND idempotency_key = $2::text
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    idempotencyKey,
  );
  return rows[0] || null;
}

export async function findActivePathwayEpisodeTx({
  tx,
  tenantId,
  pathwayKey,
  sourceEpisodeType,
  sourceEpisodeId,
} = {}) {
  const db = requireTx(tx);
  const rows = await db.$queryRawUnsafe(
    `SELECT ${INSTANCE_COLUMNS}
       FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND pathway_key = $2::text
        AND source_episode_type = $3::text
        AND source_episode_id = $4::text
        AND clinical_status IN ('planned', 'active', 'on_hold')
      ORDER BY created_at, id
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    pathwayKey,
    sourceEpisodeType,
    sourceEpisodeId,
  );
  return rows[0] || null;
}

export async function loadGovernedPathwayDefinitionTx({
  tx,
  tenantId,
  workflowDefinitionId,
} = {}) {
  const db = requireTx(tx);
  const rows = await db.$queryRawUnsafe(
    `SELECT d.id, d.tenant_id, d.workflow_key, d.version, d.display_name,
            d.steps, d.triggers, d.defaults, d.is_active,
            g.id AS governance_id, g.governance_status, g.definition_checksum,
            g.approval_id, g.approved_by AS governance_approved_by,
            g.approved_at AS governance_approved_at,
            g.patient_visibility_policy_ref, g.effective_from, g.effective_until,
            g.platform_gates, g.metadata AS governance_metadata,
            a.status AS approval_status, a.approval_kind,
            a.subject_resource_type AS approval_subject_resource_type,
            a.subject_resource_id AS approval_subject_resource_id,
            a.required_approvers AS approval_required_approvers,
            a.approved_by AS approval_approved_by,
            a.decided_by AS approval_decided_by,
            a.decided_at AS approval_decided_at,
            a.metadata AS approval_metadata
       FROM workflow_definitions AS d
       JOIN care_pathway_definition_governance AS g
        ON g.tenant_id = d.tenant_id
        AND g.workflow_definition_id = d.id
       JOIN approvals AS a
         ON a.tenant_id = g.tenant_id
        AND a.id = g.approval_id
      WHERE d.tenant_id = $1::uuid
        AND d.id = $2::integer
      LIMIT 1`,
    tenantId,
    workflowDefinitionId,
  );
  const definition = rows[0];
  if (!definition) {
    throw AppError.notFound(
      'Governed pathway definition not found',
      'PATHWAY_DEFINITION_NOT_FOUND',
    );
  }
  const now = Date.now();
  const effectiveFrom = definition.effective_from
    ? new Date(definition.effective_from).getTime()
    : null;
  const effectiveUntil = definition.effective_until
    ? new Date(definition.effective_until).getTime()
    : null;
  if (
    definition.is_active !== true
    || definition.governance_status !== 'approved'
    || !definition.definition_checksum
    || (effectiveFrom !== null && effectiveFrom > now)
    || (effectiveUntil !== null && effectiveUntil < now)
  ) {
    throw AppError.conflict(
      'Pathway definition is not currently approved and effective',
      'PATHWAY_DEFINITION_NOT_APPROVED',
    );
  }
  assertGovernanceApprovalEvidence(definition);
  return definition;
}

export async function preflightPathwaySlaRulesTx({
  tx,
  tenantId,
  compiledDefinition,
} = {}) {
  const db = requireTx(tx);
  const requiredRules = new Map();
  for (const step of compiledDefinition?.steps || []) {
    const semantics = step?.work_semantics?.sla_completion_semantics;
    const ruleCode = step?.work_semantics?.sla_rule_code;
    if (semantics === 'none' || !semantics || !ruleCode) continue;
    const priorSemantics = requiredRules.get(ruleCode);
    if (priorSemantics && priorSemantics !== semantics) {
      throw AppError.conflict(
        'Pathway definition reuses an SLA rule with conflicting completion semantics',
        'PATHWAY_SLA_RULE_CONTRACT_INVALID',
      );
    }
    requiredRules.set(ruleCode, semantics);
  }

  const resolvedRules = [];
  for (const [ruleCode, semantics] of [...requiredRules.entries()].sort(([a], [b]) => (
    a.localeCompare(b)
  ))) {
    const rows = await db.$queryRawUnsafe(
      `SELECT id, tenant_id, rule_code, target_minutes, owner_role_codes,
              escalation_role_codes, metadata
         FROM workflow_sla_rules
        WHERE enabled = TRUE
          AND rule_code = $2::text
          AND (tenant_id = $1::uuid OR tenant_id IS NULL)
        ORDER BY CASE WHEN tenant_id = $1::uuid THEN 0 ELSE 1 END
        LIMIT 1
        FOR SHARE`,
      tenantId,
      ruleCode,
    );
    const rule = rows[0];
    if (!rule) {
      throw AppError.conflict(
        `Pathway SLA rule is unavailable: ${ruleCode}`,
        'PATHWAY_SLA_RULE_UNAVAILABLE',
      );
    }
    const targetMinutes = Number(rule.target_minutes);
    if (!Number.isSafeInteger(targetMinutes) || targetMinutes <= 0) {
      throw AppError.conflict(
        `Pathway SLA rule has an invalid target: ${ruleCode}`,
        'PATHWAY_SLA_RULE_CONTRACT_INVALID',
      );
    }
    resolvedRules.push(Object.freeze({
      ...rule,
      target_minutes: targetMinutes,
      sla_completion_semantics: semantics,
    }));
  }
  return Object.freeze(resolvedRules);
}

export async function insertPathwayRuntimeTx({
  tx,
  tenantId,
  definition,
  compiledDefinition,
  patientUid,
  encounterId,
  sourceEpisodeType,
  sourceEpisodeId,
  parentInstanceId,
  owningClinicianUid,
  owningTeamId,
  accountableRole,
  triggerKind,
  triggerPayload,
  context,
  metadata,
  idempotencyKey,
  actorUid,
} = {}) {
  const db = requireTx(tx);
  const runRows = await db.$queryRawUnsafe(
    `INSERT INTO workflow_runs
       (tenant_id, workflow_definition_id, workflow_key, workflow_version,
        pathway_governance_id, pathway_definition_checksum,
        trigger_kind, trigger_payload, status, current_step_key, context,
        initiated_by, metadata)
     VALUES
       ($1::uuid, $2::integer, $3::text, $4::integer, $5::uuid, $6::char(64),
        $7::text, $8::jsonb, 'started', NULL, $9::jsonb,
        $10::uuid, $11::jsonb)
     RETURNING ${RUN_COLUMNS}`,
    tenantId,
    definition.id,
    compiledDefinition.workflow_key,
    compiledDefinition.version,
    definition.governance_id,
    compiledDefinition.checksum,
    triggerKind,
    json(triggerPayload),
    json(context),
    actorUid,
    json(metadata),
  );
  const run = runRows[0];
  if (!run) {
    throw AppError.internal('Pathway workflow run insert failed', 'PATHWAY_RUN_INSERT_FAILED');
  }

  const steps = [];
  for (const [ordering, step] of compiledDefinition.steps.entries()) {
    const rows = await db.$queryRawUnsafe(
      `INSERT INTO workflow_steps
         (tenant_id, workflow_run_id, step_key, display_name, step_kind,
          status, ordering, assigned_role, due_at, metadata)
       VALUES
         ($1::uuid, $2::integer, $3::text, $4::text, $5::text,
          'pending', $6::integer, $7::text, $8::timestamptz, $9::jsonb)
       RETURNING ${STEP_COLUMNS}`,
      tenantId,
      run.id,
      step.step_key,
      step.display_name,
      step.step_kind,
      ordering,
      step.assigned_role,
      step.due_at,
      json(step.metadata),
    );
    if (!rows[0]) {
      throw AppError.internal('Pathway workflow step insert failed', 'PATHWAY_STEP_INSERT_FAILED');
    }
    steps.push(rows[0]);
  }

  const instanceRows = await db.$queryRawUnsafe(
    `INSERT INTO care_pathway_instances
       (tenant_id, workflow_run_id, patient_uid, encounter_id,
        pathway_key, pathway_version, workflow_definition_id,
        definition_governance_id, definition_checksum, source_episode_type, source_episode_id,
        parent_instance_id, owning_clinician_uid, owning_team_id, accountable_role,
        clinical_status, patient_visibility_status, idempotency_key,
        created_by, updated_by, metadata)
     VALUES
       ($1::uuid, $2::integer, $3::uuid, $4::uuid,
        $5::text, $6::integer, $7::integer, $8::uuid, $9::char(64),
        $10::text, $11::text, $12::uuid, $13::uuid, $14::integer, $15::text,
        'planned', 'hidden', $16::text,
        $17::uuid, $17::uuid, $18::jsonb)
     RETURNING ${INSTANCE_COLUMNS}`,
    tenantId,
    run.id,
    patientUid,
    encounterId,
    compiledDefinition.workflow_key,
    compiledDefinition.version,
    definition.id,
    definition.governance_id,
    compiledDefinition.checksum,
    sourceEpisodeType,
    sourceEpisodeId,
    parentInstanceId,
    owningClinicianUid,
    owningTeamId,
    accountableRole,
    idempotencyKey,
    actorUid,
    json(metadata),
  );
  const instance = instanceRows[0];
  if (!instance) {
    throw AppError.internal(
      'Care pathway instance insert failed',
      'PATHWAY_INSTANCE_INSERT_FAILED',
    );
  }
  return { instance, run, steps };
}

export async function getCarePathwayInstanceTx({ tx, tenantId, id } = {}) {
  const db = requireTx(tx);
  const instanceRows = await db.$queryRawUnsafe(
    `SELECT ${INSTANCE_COLUMNS}
       FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
      LIMIT 1`,
    tenantId,
    id,
  );
  const instance = instanceRows[0];
  if (!instance) {
    throw AppError.notFound(
      'Care pathway instance not found',
      'CARE_PATHWAY_INSTANCE_NOT_FOUND',
    );
  }
  const [runRows, steps, tasks, approvals, handoffs] = await Promise.all([
    db.$queryRawUnsafe(
      `SELECT ${RUN_COLUMNS} FROM workflow_runs
        WHERE tenant_id = $1::uuid AND id = $2::integer LIMIT 1`,
      tenantId,
      instance.workflow_run_id,
    ),
    db.$queryRawUnsafe(
      `SELECT ${STEP_COLUMNS} FROM workflow_steps
        WHERE tenant_id = $1::uuid AND workflow_run_id = $2::integer
        ORDER BY ordering, id`,
      tenantId,
      instance.workflow_run_id,
    ),
    db.$queryRawUnsafe(
      `SELECT ${TASK_COLUMNS} FROM tasks
        WHERE tenant_id = $1::uuid AND workflow_run_id = $2::integer
        ORDER BY id`,
      tenantId,
      instance.workflow_run_id,
    ),
    db.$queryRawUnsafe(
      `SELECT ${APPROVAL_COLUMNS} FROM approvals
        WHERE tenant_id = $1::uuid AND workflow_run_id = $2::integer
        ORDER BY id`,
      tenantId,
      instance.workflow_run_id,
    ),
    db.$queryRawUnsafe(
      `SELECT ${HANDOFF_COLUMNS} FROM care_handoff_instances
        WHERE tenant_id = $1::uuid
          AND (sending_workflow_run_id = $2::integer OR receiving_workflow_run_id = $2::integer)
        ORDER BY id`,
      tenantId,
      instance.workflow_run_id,
    ),
  ]);
  if (!runRows[0]) {
    throw AppError.conflict(
      'Care pathway workflow run is missing',
      'PATHWAY_GRAPH_INVALID',
    );
  }
  assertRuntimeDefinitionPin(instance, runRows[0]);
  return { ...instance, run: runRows[0], steps, tasks, approvals, handoffs };
}

export async function assertPathwayReplayDefinitionPinTx({
  tx,
  tenantId,
  pathwayInstanceId,
  events,
} = {}) {
  const db = requireTx(tx);
  const rows = await db.$queryRawUnsafe(
    `SELECT instance.id AS instance_id,
            instance.tenant_id AS instance_tenant_id,
            instance.workflow_run_id AS instance_workflow_run_id,
            instance.workflow_definition_id AS instance_workflow_definition_id,
            instance.definition_governance_id AS instance_definition_governance_id,
            instance.definition_checksum AS instance_definition_checksum,
            run.id AS run_id,
            run.tenant_id AS run_tenant_id,
            run.workflow_definition_id AS run_workflow_definition_id,
            run.workflow_key AS run_workflow_key,
            run.workflow_version AS run_workflow_version,
            run.pathway_governance_id AS run_pathway_governance_id,
            run.pathway_definition_checksum AS run_pathway_definition_checksum,
            definition.id AS definition_id,
            definition.workflow_key AS definition_workflow_key,
            definition.version AS definition_version,
            governance.id AS governance_id,
            governance.governance_status,
            governance.definition_checksum,
            governance.approved_by AS governance_approved_by,
            governance.approved_at AS governance_approved_at,
            approval.status AS approval_status,
            approval.approval_kind,
            approval.subject_resource_type AS approval_subject_resource_type,
            approval.subject_resource_id AS approval_subject_resource_id,
            approval.required_approvers AS approval_required_approvers,
            approval.approved_by AS approval_approved_by,
            approval.decided_by AS approval_decided_by,
            approval.decided_at AS approval_decided_at,
            approval.metadata AS approval_metadata
       FROM care_pathway_instances AS instance
       JOIN workflow_runs AS run
         ON run.tenant_id = instance.tenant_id
        AND run.id = instance.workflow_run_id
       JOIN workflow_definitions AS definition
         ON definition.tenant_id = run.tenant_id
        AND definition.id = run.workflow_definition_id
        AND definition.workflow_key = run.workflow_key
        AND definition.version = run.workflow_version
       JOIN care_pathway_definition_governance AS governance
         ON governance.tenant_id = run.tenant_id
        AND governance.id = run.pathway_governance_id
        AND governance.workflow_definition_id = run.workflow_definition_id
        AND governance.definition_checksum = run.pathway_definition_checksum
       JOIN approvals AS approval
         ON approval.tenant_id = governance.tenant_id
        AND approval.id = governance.approval_id
      WHERE instance.tenant_id = $1::uuid
        AND instance.id = $2::uuid
      FOR SHARE OF run, definition, governance, approval`,
    tenantId,
    pathwayInstanceId,
  );
  const pin = rows[0];
  if (!pin || !['approved', 'retired'].includes(pin.governance_status)) {
    noRowConflict(
      'Care pathway replay definition pin is missing',
      'PATHWAY_DEFINITION_PIN_MISMATCH',
    );
  }

  const instance = {
    id: pin.instance_id,
    tenant_id: pin.instance_tenant_id,
    workflow_run_id: pin.instance_workflow_run_id,
    workflow_definition_id: pin.instance_workflow_definition_id,
    definition_governance_id: pin.instance_definition_governance_id,
    definition_checksum: pin.instance_definition_checksum,
  };
  const run = {
    id: pin.run_id,
    tenant_id: pin.run_tenant_id,
    workflow_definition_id: pin.run_workflow_definition_id,
    workflow_key: pin.run_workflow_key,
    workflow_version: pin.run_workflow_version,
    pathway_governance_id: pin.run_pathway_governance_id,
    pathway_definition_checksum: pin.run_pathway_definition_checksum,
  };
  const definition = {
    id: pin.definition_id,
    workflow_key: pin.definition_workflow_key,
    version: pin.definition_version,
    governance_id: pin.governance_id,
    governance_status: pin.governance_status,
    definition_checksum: pin.definition_checksum,
    governance_approved_by: pin.governance_approved_by,
    governance_approved_at: pin.governance_approved_at,
    approval_status: pin.approval_status,
    approval_kind: pin.approval_kind,
    approval_subject_resource_type: pin.approval_subject_resource_type,
    approval_subject_resource_id: pin.approval_subject_resource_id,
    approval_required_approvers: pin.approval_required_approvers,
    approval_approved_by: pin.approval_approved_by,
    approval_decided_by: pin.approval_decided_by,
    approval_decided_at: pin.approval_decided_at,
    approval_metadata: pin.approval_metadata,
  };
  const checksum = assertRuntimeDefinitionPin(instance, run, definition);
  assertGovernanceApprovalEvidence(definition);

  if (!Array.isArray(events) || events.length === 0) {
    noRowConflict('Care pathway replay evidence is missing', 'PATHWAY_REPLAY_RESULT_MISSING');
  }
  for (const event of events) {
    const metadata = parseJsonObject(event?.metadata);
    const runtimeMetadata = parseJsonObject(metadata.pathway_runtime);
    if (
      String(event?.tenant_id || '').toLowerCase() !== String(tenantId).toLowerCase()
      || String(event?.pathway_instance_id || '').toLowerCase()
        !== String(pathwayInstanceId).toLowerCase()
      || Number(event?.workflow_run_id) !== Number(run.id)
      || typeof runtimeMetadata.definition_checksum !== 'string'
      || runtimeMetadata.definition_checksum !== checksum
    ) {
      noRowConflict(
        'Care pathway replay evidence has an inconsistent definition pin',
        'PATHWAY_DEFINITION_PIN_MISMATCH',
      );
    }
    if (event.transition_key === 'pathway_instance_created') {
      const payload = parseJsonObject(event.event_payload);
      if (
        typeof payload.workflow_definition_id !== 'number'
        || Number(payload.workflow_definition_id) !== Number(run.workflow_definition_id)
        || typeof payload.governance_id !== 'string'
        || payload.governance_id.toLowerCase() !== String(run.pathway_governance_id).toLowerCase()
        || typeof payload.definition_checksum !== 'string'
        || payload.definition_checksum !== checksum
      ) {
        noRowConflict(
          'Care pathway creation replay evidence has an inconsistent definition pin',
          'PATHWAY_DEFINITION_PIN_MISMATCH',
        );
      }
    }
  }
  return Object.freeze({ instance, run, definition });
}

export async function lockPathwayRuntimeTx({ tx, tenantId, pathwayInstanceId } = {}) {
  const db = requireTx(tx);
  const instanceRows = await db.$queryRawUnsafe(
    `SELECT ${INSTANCE_COLUMNS}
       FROM care_pathway_instances
      WHERE tenant_id = $1::uuid AND id = $2::uuid
      FOR UPDATE`,
    tenantId,
    pathwayInstanceId,
  );
  const instance = instanceRows[0];
  if (!instance) {
    throw AppError.notFound(
      'Care pathway instance not found',
      'CARE_PATHWAY_INSTANCE_NOT_FOUND',
    );
  }

  const runRows = await db.$queryRawUnsafe(
    `SELECT ${RUN_COLUMNS}
       FROM workflow_runs
      WHERE tenant_id = $1::uuid AND id = $2::integer
      FOR UPDATE`,
    tenantId,
    instance.workflow_run_id,
  );
  const run = runRows[0];
  if (!run) noRowConflict('Care pathway workflow run is missing', 'PATHWAY_GRAPH_INVALID');
  assertRuntimeDefinitionPin(instance, run);

  const children = await db.$queryRawUnsafe(
    `SELECT ${INSTANCE_COLUMNS}
       FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND parent_instance_id = $2::uuid
      ORDER BY id
      FOR UPDATE`,
    tenantId,
    instance.id,
  );

  const steps = await db.$queryRawUnsafe(
    `SELECT ${STEP_COLUMNS}
       FROM workflow_steps
      WHERE tenant_id = $1::uuid AND workflow_run_id = $2::integer
      ORDER BY ordering, id
      FOR UPDATE`,
    tenantId,
    run.id,
  );
  const tasks = await db.$queryRawUnsafe(
    `SELECT ${TASK_COLUMNS}
       FROM tasks
      WHERE tenant_id = $1::uuid AND workflow_run_id = $2::integer
      ORDER BY id
      FOR UPDATE`,
    tenantId,
    run.id,
  );
  const approvals = await db.$queryRawUnsafe(
    `SELECT ${APPROVAL_COLUMNS}
       FROM approvals
      WHERE tenant_id = $1::uuid AND workflow_run_id = $2::integer
      ORDER BY id
      FOR UPDATE`,
    tenantId,
    run.id,
  );
  const handoffs = await db.$queryRawUnsafe(
    `SELECT ${HANDOFF_COLUMNS}
       FROM care_handoff_instances
      WHERE tenant_id = $1::uuid
        AND (sending_workflow_run_id = $2::integer OR receiving_workflow_run_id = $2::integer)
      ORDER BY id
      FOR UPDATE`,
    tenantId,
    run.id,
  );
  const slaIds = [...new Set(tasks
    .map((task) => task.workflow_sla_instance_id)
    .filter(Boolean)
    .map(String))]
    .sort();
  const slas = slaIds.length === 0
    ? []
    : await db.$queryRawUnsafe(
      `SELECT *
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND id = ANY($2::uuid[])
        ORDER BY id
        FOR UPDATE`,
      tenantId,
      slaIds,
    );
  const childRunIds = [...new Set(children
    .map((child) => Number(child.workflow_run_id))
    .filter((id) => Number.isSafeInteger(id) && id > 0))]
    .sort((a, b) => a - b);
  let childRuns = [];
  let childSteps = [];
  let childTasks = [];
  if (childRunIds.length > 0) {
    childRuns = await db.$queryRawUnsafe(
        `SELECT ${RUN_COLUMNS}
           FROM workflow_runs
          WHERE tenant_id = $1::uuid
            AND id = ANY($2::bigint[])
          ORDER BY id
          FOR UPDATE`,
        tenantId,
        childRunIds,
      );
    childSteps = await db.$queryRawUnsafe(
        `SELECT ${STEP_COLUMNS}
           FROM workflow_steps
          WHERE tenant_id = $1::uuid
            AND workflow_run_id = ANY($2::bigint[])
          ORDER BY workflow_run_id, ordering, id
          FOR UPDATE`,
        tenantId,
        childRunIds,
      );
    childTasks = await db.$queryRawUnsafe(
        `SELECT ${TASK_COLUMNS}
           FROM tasks
          WHERE tenant_id = $1::uuid
            AND workflow_run_id = ANY($2::bigint[])
          ORDER BY workflow_run_id, id
          FOR UPDATE`,
        tenantId,
        childRunIds,
      );
  }
  const childRuntimeGraphs = children.map((child) => Object.freeze({
    instance: child,
    run: childRuns.find((candidate) => Number(candidate.id) === Number(child.workflow_run_id))
      || null,
    steps: childSteps.filter(
      (candidate) => Number(candidate.workflow_run_id) === Number(child.workflow_run_id),
    ),
    tasks: childTasks.filter(
      (candidate) => Number(candidate.workflow_run_id) === Number(child.workflow_run_id),
    ),
  }));
  if (childRuntimeGraphs.some((graph) => !graph.run)) {
    noRowConflict('Child pathway workflow run is missing', 'PATHWAY_GRAPH_INVALID');
  }
  const definitionRows = await db.$queryRawUnsafe(
    `SELECT d.id, d.tenant_id, d.workflow_key, d.version, d.display_name,
            d.steps, d.triggers, d.defaults, d.is_active,
            g.id AS governance_id, g.governance_status, g.definition_checksum,
            g.approval_id, g.approved_by AS governance_approved_by,
            g.approved_at AS governance_approved_at,
            g.patient_visibility_policy_ref, g.effective_from, g.effective_until,
            g.platform_gates, g.metadata AS governance_metadata,
            a.status AS approval_status, a.approval_kind,
            a.subject_resource_type AS approval_subject_resource_type,
            a.subject_resource_id AS approval_subject_resource_id,
            a.required_approvers AS approval_required_approvers,
            a.approved_by AS approval_approved_by,
            a.decided_by AS approval_decided_by,
            a.decided_at AS approval_decided_at,
            a.metadata AS approval_metadata
       FROM workflow_definitions AS d
       JOIN care_pathway_definition_governance AS g
        ON g.tenant_id = d.tenant_id
        AND g.workflow_definition_id = d.id
        AND g.id = $3::uuid
        AND g.definition_checksum = $4::char(64)
       JOIN approvals AS a
         ON a.tenant_id = g.tenant_id
        AND a.id = g.approval_id
      WHERE d.tenant_id = $1::uuid
        AND d.id = $2::integer
      FOR SHARE OF d, g, a`,
    tenantId,
    run.workflow_definition_id,
    run.pathway_governance_id,
    run.pathway_definition_checksum,
  );
  if (!definitionRows[0]) {
    noRowConflict('Care pathway definition governance is missing', 'PATHWAY_GRAPH_INVALID');
  }
  assertGovernanceApprovalEvidence(definitionRows[0]);
  assertRuntimeDefinitionPin(instance, run, definitionRows[0]);
  return {
    instance,
    children,
    run,
    steps,
    tasks,
    approvals,
    handoffs,
    slas,
    childRuntimeGraphs,
    definition: definitionRows[0],
  };
}

export async function getPathwayTransitionLedgerStateTx({
  tx,
  tenantId,
  pathwayInstanceId,
} = {}) {
  const db = requireTx(tx);
  const rows = await db.$queryRawUnsafe(
    `SELECT COUNT(*)::integer AS event_count,
            COALESCE(MAX(sequence_number), 0)::integer AS max_sequence
       FROM care_pathway_transition_events
      WHERE tenant_id = $1::uuid
        AND pathway_instance_id = $2::uuid`,
    tenantId,
    pathwayInstanceId,
  );
  const eventCount = Number(rows[0]?.event_count);
  const maxSequence = Number(rows[0]?.max_sequence);
  if (
    !Number.isSafeInteger(eventCount)
    || eventCount < 0
    || !Number.isSafeInteger(maxSequence)
    || maxSequence < 0
  ) {
    throw AppError.conflict(
      'Care pathway transition ledger state is invalid',
      'PATHWAY_GRAPH_INVALID',
    );
  }
  return Object.freeze({ eventCount, maxSequence });
}

export async function transitionPathwayRunCasTx({
  tx,
  tenantId,
  runId,
  expectedStatus,
  expectedCurrentStepKey,
  nextStatus,
  nextCurrentStepKey,
  failureReason = null,
} = {}) {
  const db = requireTx(tx);
  const terminal = ['completed', 'cancelled', 'failed'].includes(nextStatus);
  const rows = await db.$queryRawUnsafe(
    `UPDATE workflow_runs
        SET status = $1::text,
            current_step_key = $2::text,
            ended_at = CASE WHEN $3::boolean THEN NOW() ELSE NULL END,
            failure_reason = $4::text,
            updated_at = NOW()
      WHERE tenant_id = $5::uuid
        AND id = $6::integer
        AND status = $7::text
        AND current_step_key IS NOT DISTINCT FROM $8::text
      RETURNING ${RUN_COLUMNS}`,
    nextStatus,
    nextCurrentStepKey,
    terminal,
    failureReason,
    tenantId,
    runId,
    expectedStatus,
    expectedCurrentStepKey,
  );
  if (!rows[0]) {
    noRowConflict(
      'Pathway workflow run changed before command completion',
      'PATHWAY_RUN_CAS_CONFLICT',
    );
  }
  return rows[0];
}

export async function transitionPathwayStepCasTx({
  tx,
  tenantId,
  workflowRunId,
  stepId,
  expectedStatus,
  nextStatus,
  outcome = null,
  outcomePayload = {},
} = {}) {
  const db = requireTx(tx);
  const starts = nextStatus === 'in_progress';
  const ends = ['completed', 'skipped', 'failed'].includes(nextStatus);
  const rows = await db.$queryRawUnsafe(
    `UPDATE workflow_steps
        SET status = $1::text,
            started_at = CASE
              WHEN $2::boolean THEN COALESCE(started_at, NOW())
              ELSE started_at
            END,
            completed_at = CASE WHEN $3::boolean THEN NOW() ELSE NULL END,
            outcome = $4::text,
            outcome_payload = $5::jsonb,
            updated_at = NOW()
      WHERE tenant_id = $6::uuid
        AND workflow_run_id = $7::integer
        AND id = $8::integer
        AND status = $9::text
      RETURNING ${STEP_COLUMNS}`,
    nextStatus,
    starts,
    ends,
    outcome,
    json(outcomePayload),
    tenantId,
    workflowRunId,
    stepId,
    expectedStatus,
  );
  if (!rows[0]) {
    noRowConflict(
      'Pathway workflow step changed before command completion',
      'PATHWAY_STEP_CAS_CONFLICT',
    );
  }
  return rows[0];
}

export async function closePathwayInstanceCasTx({
  tx,
  tenantId,
  instanceId,
  expectedClinicalStatus,
  nextClinicalStatus,
  completionOutcome,
  closureReason = null,
  actorUid = null,
} = {}) {
  const db = requireTx(tx);
  const rows = await db.$queryRawUnsafe(
    `UPDATE care_pathway_instances
        SET clinical_status = $1::text,
            completion_outcome = $2::text,
            closure_reason = $3::text,
            closed_at = NOW(),
            updated_by = $4::uuid,
            updated_at = NOW()
      WHERE tenant_id = $5::uuid
        AND id = $6::uuid
        AND clinical_status = $7::text
        AND closed_at IS NULL
      RETURNING ${INSTANCE_COLUMNS}`,
    nextClinicalStatus,
    completionOutcome,
    closureReason,
    actorUid,
    tenantId,
    instanceId,
    expectedClinicalStatus,
  );
  if (!rows[0]) {
    noRowConflict(
      'Care pathway instance changed before command completion',
      'PATHWAY_INSTANCE_CAS_CONFLICT',
    );
  }
  return rows[0];
}

export async function activatePathwayInstanceCasTx({
  tx,
  tenantId,
  instanceId,
  actorUid = null,
} = {}) {
  const db = requireTx(tx);
  const rows = await db.$queryRawUnsafe(
    `UPDATE care_pathway_instances
        SET clinical_status = 'active',
            activated_at = COALESCE(activated_at, NOW()),
            updated_by = $1::uuid,
            updated_at = NOW()
      WHERE tenant_id = $2::uuid
        AND id = $3::uuid
        AND clinical_status = 'planned'
        AND closed_at IS NULL
      RETURNING ${INSTANCE_COLUMNS}`,
    actorUid,
    tenantId,
    instanceId,
  );
  if (!rows[0]) {
    noRowConflict(
      'Care pathway instance changed before activation',
      'PATHWAY_INSTANCE_CAS_CONFLICT',
    );
  }
  return rows[0];
}

export async function assignPathwayOwnerCasTx({
  tx,
  tenantId,
  instanceId,
  expectedOwnerUid = null,
  nextOwnerUid,
  actorUid,
} = {}) {
  const db = requireTx(tx);
  const rows = await db.$queryRawUnsafe(
    `UPDATE care_pathway_instances
        SET owning_clinician_uid = $1::uuid,
            updated_by = $2::uuid,
            updated_at = NOW()
      WHERE tenant_id = $3::uuid
        AND id = $4::uuid
        AND owning_clinician_uid IS NOT DISTINCT FROM $5::uuid
        AND clinical_status IN ('planned', 'active', 'on_hold')
        AND closed_at IS NULL
      RETURNING ${INSTANCE_COLUMNS}`,
    nextOwnerUid,
    actorUid,
    tenantId,
    instanceId,
    expectedOwnerUid,
  );
  if (!rows[0]) {
    noRowConflict(
      'Care pathway owner changed before ownership operation completion',
      'PATHWAY_OWNER_CAS_CONFLICT',
    );
  }
  return rows[0];
}

export default {
  assertPathwayTenantScopeTx,
  assertPathwayPatientContextTx,
  resolvePathwayModeTx,
  acquirePathwayStartLocksTx,
  findPathwayInstanceByIdempotencyTx,
  findActivePathwayEpisodeTx,
  loadGovernedPathwayDefinitionTx,
  insertPathwayRuntimeTx,
  getCarePathwayInstanceTx,
  assertPathwayReplayDefinitionPinTx,
  lockPathwayRuntimeTx,
  transitionPathwayRunCasTx,
  transitionPathwayStepCasTx,
  activatePathwayInstanceCasTx,
  closePathwayInstanceCasTx,
  assignPathwayOwnerCasTx,
};
