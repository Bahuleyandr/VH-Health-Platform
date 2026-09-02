/**
 * Generic Tasks / Workflow / Approval / SLA / Automation service (Phase B2).
 *
 * Backs the nine tables added in migration 118:
 *   - workflow_definitions
 *   - workflow_runs / workflow_steps
 *   - tasks / task_comments
 *   - approvals
 *   - escalation_rules
 *   - sla_definitions
 *   - automation_rules
 *
 * The clinical-AI workflow runner (clinical_ai_workflow_runs) is a
 * peer, not a parent. This service owns staff-facing follow-ups,
 * non-AI approvals, generic SLA tracking. Workflow runs created here
 * can spawn AI sub-tasks via step_kind='ai_call', linking back to
 * clinical_ai_workflow_runs by foreign key in the step's outcome_payload.
 *
 * Decision-support only: no auto-resolve, no auto-billing. Escalation
 * rules + automation rules write rows; admins approve / dispatch them.
 */

import { createHash } from 'node:crypto';

import { getStaffRosterRoleCodes } from '../../config/rolePolicyGraph.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { isAdmin, isDoctor } from '../../utils/roleHelpers.js';
import { normalizeRole } from '../../utils/roles.js';
import { isInpatientPendingResultPhysicianRole } from '../emr/inpatientPendingResultPolicy.js';
import { isValidIdempotencyKey } from '../idempotency/idempotencyService.js';
import { resolveMergedPatientUidSet } from '../clinical/mergedPatientReadUnion.js';
import { roleCanBreakGlass } from '../security/breakGlassService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  WORKFLOW_STEP_KINDS,
  validateWorkflowDefinitionSteps,
} from './workflowDefinitionContract.js';
import { assertWorkflowJsonBudget } from './workflowJsonGuard.js';
import {
  isTaskHumanOwnerRole,
  resolveCurrentHumanActorTx,
} from './workflowHumanOwnerService.js';

export { WORKFLOW_STEP_KINDS };

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const TEXT_MAX = 8000;
const SHORT_MAX = 255;
const HANDLER_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*\.v[1-9][0-9]*$/;
const DURABLE_TIMESTAMP_BINDING_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const REGISTERED_CONDITION_COMPLETION_BINDINGS = Object.freeze({
  'op.recovery_action.v1': Object.freeze({
    evidenceResourceType: 'op_visit_closure_evidence',
    evidenceResourceIdField: 'closure_evidence_id',
  }),
});

export const TASK_KINDS = [
  'general',
  'follow_up',
  'review',
  'pathway_owner_transfer_review',
  'op_to_inpatient_transfer_review',
  'ed_destination_handoff_review',
  'ed_closure_review',
  'escalation',
  'verification',
  'admin',
  'consent',
  'investigation',
  'other',
];
export const TASK_PRIORITIES = ['low', 'normal', 'high', 'critical'];
export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'completed', 'cancelled', 'overdue'];
export const TASK_SLA_COMPLETION_SEMANTICS = ['none', 'acknowledgement', 'domain_evidence'];
export const TASK_COMMENT_KINDS = ['comment', 'system_event', 'state_change'];
export const LAB_CRITICAL_ALERT_ACK_CONTRACT_VERSION = 2;
export const WORKFLOW_TRIGGER_KINDS = ['manual', 'event', 'schedule', 'api', 'subgraph'];
export const WORKFLOW_STATUSES = ['started', 'running', 'blocked', 'completed', 'cancelled', 'failed'];
export const WORKFLOW_STEP_STATUSES = ['pending', 'in_progress', 'blocked', 'completed', 'skipped', 'failed'];
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'expired'];
export const ESCALATION_SCOPES = ['task', 'workflow_step', 'approval'];
export const ESCALATION_TRIGGERS = ['sla_breach', 'no_progress_after', 'pending_too_long', 'on_status_change'];
export const ESCALATION_ACTIONS = ['notify', 'reassign', 'escalate_priority', 'auto_resolve', 'webhook'];
// The subset of the mig-118 enums the sweep engine actually evaluates and can
// perform (escalationEngineService.js mirrors the action set — a unit test
// pins the two lists together). An ACTIVE rule outside these subsets is silent
// dead config: it stores fine but no code path will ever fire it, so
// upsertEscalationRule refuses to activate one (inactive drafts still save,
// preserving the "plug your own engine in later" storage contract).
export const ENGINE_EVALUATED_ESCALATION_SCOPES = ['task'];
export const ENGINE_EVALUATED_ESCALATION_TRIGGERS = ['sla_breach', 'pending_too_long'];
export const ENGINE_EXECUTABLE_ESCALATION_ACTIONS = ['notify', 'reassign', 'escalate_priority', 'auto_resolve'];
export const AUTOMATION_ACTIONS = ['create_task', 'start_workflow', 'create_approval', 'webhook', 'notify'];

const DOMAIN_EVIDENCE_COMPLETION_AUTHORITY = Symbol('DOMAIN_EVIDENCE_COMPLETION_AUTHORITY');
const TASK_SLA_SOURCE_BINDING_AUTHORITY = Symbol('TASK_SLA_SOURCE_BINDING_AUTHORITY');
const ACKNOWLEDGEMENT_TRANSITION_AUTHORITY = Symbol('ACKNOWLEDGEMENT_TRANSITION_AUTHORITY');
const LAB_CRITICAL_ALERT_ACKNOWLEDGEMENT_AUTHORITY = Symbol(
  'LAB_CRITICAL_ALERT_ACKNOWLEDGEMENT_AUTHORITY',
);
const COVERING_TRANSFER_TASK_AUTHORITY = Symbol('COVERING_TRANSFER_TASK_AUTHORITY');
const OP_INPATIENT_TRANSFER_TASK_AUTHORITY = Symbol('OP_INPATIENT_TRANSFER_TASK_AUTHORITY');
const ED_DESTINATION_HANDOFF_TASK_AUTHORITY = Symbol('ED_DESTINATION_HANDOFF_TASK_AUTHORITY');
const PENDING_RESULT_OWNER_ACTION_TASK_AUTHORITY = Symbol(
  'PENDING_RESULT_OWNER_ACTION_TASK_AUTHORITY',
);
const PENDING_RESULT_TASK_TRANSFER_AUTHORITY = Symbol(
  'PENDING_RESULT_TASK_TRANSFER_AUTHORITY',
);
const PENDING_RESULT_TASK_CREATION_AUTHORITY = Symbol(
  'PENDING_RESULT_TASK_CREATION_AUTHORITY',
);
const COVERING_TRANSFER_TASK_CREATION_AUTHORITY = Symbol(
  'COVERING_TRANSFER_TASK_CREATION_AUTHORITY',
);
const OP_INPATIENT_TRANSFER_TASK_CREATION_AUTHORITY = Symbol(
  'OP_INPATIENT_TRANSFER_TASK_CREATION_AUTHORITY',
);
const ED_DESTINATION_HANDOFF_TASK_CREATION_AUTHORITY = Symbol(
  'ED_DESTINATION_HANDOFF_TASK_CREATION_AUTHORITY',
);
const ED_CLOSURE_TASK_CREATION_AUTHORITY = Symbol(
  'ED_CLOSURE_TASK_CREATION_AUTHORITY',
);
const LAB_THRESHOLD_EXCEPTION_TASK_CREATION_AUTHORITY = Symbol(
  'LAB_THRESHOLD_EXCEPTION_TASK_CREATION_AUTHORITY',
);
const WARD_MEDICATION_TASK_CREATION_AUTHORITY = Symbol(
  'WARD_MEDICATION_TASK_CREATION_AUTHORITY',
);
const MAR_MEDICATION_EXCEPTION_TASK_CREATION_AUTHORITY = Symbol(
  'MAR_MEDICATION_EXCEPTION_TASK_CREATION_AUTHORITY',
);
const CATH_INVENTORY_SHORTFALL_TASK_CREATION_AUTHORITY = Symbol(
  'CATH_INVENTORY_SHORTFALL_TASK_CREATION_AUTHORITY',
);
const MAR_MEDICATION_EXCEPTION_TASK_CLAIM_AUTHORITY = Symbol(
  'MAR_MEDICATION_EXCEPTION_TASK_CLAIM_AUTHORITY',
);
const PENDING_RESULT_TASK_SETTLEMENT_AUTHORITY = Symbol(
  'PENDING_RESULT_TASK_SETTLEMENT_AUTHORITY',
);

const GENERIC_RUNTIME_DENIED_APPROVAL_KINDS = new Set([
  'care_pathway_definition_governance',
  'credential_privilege_grant',
  'pharmacy_substitution_funding_reauthorisation',
]);
const COVERING_TRANSFER_TASK_CONTRACT = 'covering_clinician_transfer_review_v1';
const OP_INPATIENT_TRANSFER_TASK_CONTRACT = 'op_to_inpatient_transfer_review_v1';
const ED_DESTINATION_HANDOFF_TASK_CONTRACT = 'ed_destination_handoff_review_v1';
const ED_CLOSURE_TASK_CONTRACT = 'ed_closure_review_v1';
const LAB_THRESHOLD_EXCEPTION_TASK_CONTRACT = 'lab_threshold_policy_exception_v1';
const WARD_MEDICATION_TASK_CONTRACT = 'ward_medication_obligation_v1';
const CLINICAL_ALERT_DELIVERY_RECOVERY_TASK_CONTRACT =
  'clinical_alert_delivery_recovery_v1';
const MAR_MEDICATION_EXCEPTION_TASK_CONTRACT = 'mar_medication_exception_v1';
const CATH_INVENTORY_SHORTFALL_TASK_CONTRACT = 'cath_inventory_shortfall_v1';
const SUBSTITUTION_FUNDING_TASK_CONTRACT = 'pharmacy_substitution_funding_task_v1';
const MAR_MEDICATION_EXCEPTION_EXACT_PRESCRIBER_ROLES = new Set([
  'DOCTOR',
  'DUTY_DOCTOR',
  'CONSULTANT',
  'JUNIOR_DOCTOR',
  'RESIDENT',
]);
const WARD_MEDICATION_SLA_RULES = new Set([
  'ward_indent_pharmacy_response',
  'ward_indent_substitution_authorization',
  'ward_indent_controlled_handoff',
  'ward_indent_pharmacy_issue',
  'ward_indent_ward_receipt',
  'ward_indent_reconciliation',
  'ward_indent_mar_supply_reconciliation',
  'ward_indent_credit_note_review',
  'ward_indent_notification_coverage',
]);
const CLINICAL_ALERT_DELIVERY_RECOVERY_SLA_RULES = new Set([
  'clinical_alert_delivery_manual_hold_review',
  'clinical_alert_delivery_recipient_coverage',
]);
const MAR_MEDICATION_EXCEPTION_SLA_RULE = 'mar_medication_exception_review';
const CATH_INVENTORY_SHORTFALL_SLA_RULE = 'cath_consumable_inventory_reconciliation';
const CATH_INVENTORY_SHORTFALL_OPERATOR_ROLES = new Set([
  'PHARMACIST',
  'PHARMACY_STAFF',
  'PHARMACY_INCHARGE',
]);

function requiredTaskFactoryTx(tx, code, message) {
  if (!tx?.$queryRawUnsafe) {
    throw AppError.internal(message, code);
  }
  return tx;
}

function assertProtectedTaskCreationAllowed({
  taskKind,
  relatedResourceType,
  metadata,
  authority,
}) {
  const requiresPendingResultAuthority = [
    'discharge_pending_result_handoff',
    'discharge_pending_result_action',
  ].includes(relatedResourceType);
  if (
    requiresPendingResultAuthority
    && authority !== PENDING_RESULT_TASK_CREATION_AUTHORITY
  ) {
    throw AppError.conflict(
      'Pending-result tasks must use the inpatient domain task factory',
      'INPATIENT_PENDING_RESULT_TASK_FACTORY_REQUIRED',
    );
  }
  if (
    taskKind === 'pathway_owner_transfer_review'
    && authority !== COVERING_TRANSFER_TASK_CREATION_AUTHORITY
  ) {
    throw AppError.conflict(
      'Covering-transfer review tasks must use the pathway ownership task factory',
      'COVERING_TRANSFER_TASK_FACTORY_REQUIRED',
    );
  }
  if (
    taskKind === 'op_to_inpatient_transfer_review'
    && authority !== OP_INPATIENT_TRANSFER_TASK_CREATION_AUTHORITY
  ) {
    throw AppError.conflict(
      'OP-to-inpatient review tasks must use the appointment transfer task factory',
      'OP_INPATIENT_TRANSFER_TASK_FACTORY_REQUIRED',
    );
  }
  if (
    taskKind === 'ed_destination_handoff_review'
    && authority !== ED_DESTINATION_HANDOFF_TASK_CREATION_AUTHORITY
  ) {
    throw AppError.conflict(
      'ED destination review tasks must use the ED handoff task factory',
      'ED_DESTINATION_HANDOFF_TASK_FACTORY_REQUIRED',
    );
  }
  if (
    taskKind === 'ed_closure_review'
    && authority !== ED_CLOSURE_TASK_CREATION_AUTHORITY
  ) {
    throw AppError.conflict(
      'ED closure review tasks must use the ED closure task factory',
      'ED_CLOSURE_TASK_FACTORY_REQUIRED',
    );
  }
  if (
    relatedResourceType === 'lab_threshold_exception'
    && authority !== LAB_THRESHOLD_EXCEPTION_TASK_CREATION_AUTHORITY
  ) {
    throw AppError.conflict(
      'Lab threshold exception tasks must use the laboratory policy domain task factory',
      'LAB_THRESHOLD_EXCEPTION_TASK_FACTORY_REQUIRED',
    );
  }
  if (
    metadata?.task_contract
    && ![
      COVERING_TRANSFER_TASK_CREATION_AUTHORITY,
      OP_INPATIENT_TRANSFER_TASK_CREATION_AUTHORITY,
      ED_DESTINATION_HANDOFF_TASK_CREATION_AUTHORITY,
      ED_CLOSURE_TASK_CREATION_AUTHORITY,
      PENDING_RESULT_TASK_CREATION_AUTHORITY,
      LAB_THRESHOLD_EXCEPTION_TASK_CREATION_AUTHORITY,
      WARD_MEDICATION_TASK_CREATION_AUTHORITY,
      MAR_MEDICATION_EXCEPTION_TASK_CREATION_AUTHORITY,
      CATH_INVENTORY_SHORTFALL_TASK_CREATION_AUTHORITY,
    ].includes(authority)
  ) {
    throw AppError.conflict(
      'Contract-bound tasks must use their registered domain task factory',
      'TASK_CONTRACT_FACTORY_REQUIRED',
    );
  }
}

const TASK_TRANSITIONS = {
  open: ['in_progress', 'blocked', 'completed', 'cancelled'],
  in_progress: ['blocked', 'completed', 'cancelled'],
  blocked: ['in_progress', 'cancelled'],
  completed: [],
  cancelled: [],
  overdue: ['in_progress', 'completed', 'cancelled'],
};

const WORKFLOW_RUN_TRANSITIONS = {
  started: ['running', 'cancelled', 'failed'],
  running: ['blocked', 'completed', 'cancelled', 'failed'],
  blocked: ['running', 'cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
};

const WORKFLOW_STEP_TRANSITIONS = {
  pending: ['in_progress', 'blocked', 'skipped', 'failed'],
  in_progress: ['blocked', 'completed', 'skipped', 'failed'],
  blocked: ['in_progress', 'skipped', 'failed'],
  completed: [],
  skipped: [],
  failed: [],
};

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function isFkViolation(err) {
  return /foreign key constraint/i.test(String(err?.message || ''));
}

function safeText(value, max = TEXT_MAX) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return max ? text.slice(0, max) : text;
}

function normalizeId(value, label = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${label} must be a positive integer`);
  }
  return parsed;
}

function maybeUuid(value, label = 'uid') {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) {
    throw AppError.badRequest(`${label} must be a UUID`);
  }
  return text;
}

function normalizeTaskAssignment({ assignedToUid = null, assignedToRole = null } = {}) {
  const uid = maybeUuid(assignedToUid, 'assigned_to_uid');
  const role = safeText(assignedToRole, 80);
  if (uid && role) {
    throw AppError.badRequest(
      'Task cannot be assigned to both a user and a role',
      'TASK_ASSIGNMENT_AMBIGUOUS',
    );
  }
  return { uid, role };
}

function requireActorUid(value, label = 'actor_uid') {
  const uid = maybeUuid(value, label);
  if (!uid) throw AppError.unauthorized('Authenticated actor is required');
  return uid;
}

function assertGenericApprovalKindAllowed(value) {
  const normalizedKind = String(value || '').trim().toLowerCase();
  if (GENERIC_RUNTIME_DENIED_APPROVAL_KINDS.has(normalizedKind)) {
    throw AppError.conflict(
      'Approval must be managed through its owning domain workflow',
      'DOMAIN_OWNED_APPROVAL_KIND',
    );
  }
}

function normalizeLimit(value, fallback = DEFAULT_LIST_LIMIT, max = MAX_LIST_LIMIT) {
  return Math.min(Math.max(Number.parseInt(value, 10) || fallback, 1), max);
}

function normalizeJsonObject(value, label) {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON object`);
  }
  return value;
}

const RESERVED_TASK_METADATA_KEYS = new Set([
  'workflow_sla_instance_id',
  'sla_completion_semantics',
  'stage_occurrence_key',
  // Legacy task/SLA links were stored here. The typed column is authoritative;
  // accepting this key would recreate an ambiguous second contract.
  'sla_instance_id',
]);

function normalizeTaskMetadata(value) {
  const metadata = normalizeJsonObject(value, 'metadata');
  const reservedKey = Object.keys(metadata).find((key) => RESERVED_TASK_METADATA_KEYS.has(key));
  if (reservedKey) {
    throw AppError.badRequest(
      `metadata.${reservedKey} is reserved; use the typed task/SLA fields`,
      'TASK_METADATA_KEY_RESERVED',
    );
  }
  return metadata;
}

function normalizeJsonArray(value, label) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw AppError.badRequest(`${label} must be a JSON array`);
  }
  return value;
}

function normalizeEnum(value, allowed, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw AppError.badRequest(`${label} is required`);
    return null;
  }
  const text = String(value).trim();
  if (!allowed.includes(text)) {
    throw AppError.badRequest(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return text;
}

function normalizeBoolean(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return Boolean(value);
}

function normalizeInt(value, label, { min = null, max = null } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw AppError.badRequest(`${label} must be an integer`);
  if (min !== null && parsed < min) throw AppError.badRequest(`${label} must be >= ${min}`);
  if (max !== null && parsed > max) throw AppError.badRequest(`${label} must be <= ${max}`);
  return parsed;
}

function normalizeTimestamp(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date
    ? value
    : (typeof value === 'number' ? new Date(value) : new Date(String(value)));
  if (Number.isNaN(date.getTime())) throw AppError.badRequest(`${label} must be a valid timestamp`);
  // The driver-adapter raw path can reinterpret Date/string timestamp
  // parameters in the process timezone. Bind epoch milliseconds and convert
  // inside PostgreSQL so the stored timestamptz preserves the caller's instant.
  return date.getTime();
}

function parseDurableTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function durableTimestampBinding(value) {
  const instant = parseDurableTimestamp(value);
  if (!instant) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (DURABLE_TIMESTAMP_BINDING_PATTERN.test(text)) return text;
  }
  return instant.toISOString();
}

function normalizeStrictPositiveId(value, label) {
  const text = typeof value === 'number'
    ? (Number.isSafeInteger(value) ? String(value) : '')
    : (typeof value === 'bigint' ? value.toString() : value);
  if (typeof text !== 'string' || !/^[1-9]\d*$/.test(text)) {
    throw AppError.badRequest(
      `${label} must be a canonical positive integer`,
      'PATHWAY_TASK_CONTEXT_INVALID',
    );
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw AppError.badRequest(
      `${label} exceeds the supported integer range`,
      'PATHWAY_TASK_CONTEXT_INVALID',
    );
  }
  return parsed;
}

function requireCanonicalHandlerId(value) {
  if (
    typeof value !== 'string'
    || value.length > 120
    || value.trim() !== value
    || !HANDLER_ID_PATTERN.test(value)
  ) {
    throw AppError.badRequest(
      'condition_handler must be a versioned canonical handler id',
      'PATHWAY_HANDLER_CONTRACT_INVALID',
    );
  }
  return value;
}

function cloneBudgetedWorkflowJson(value, label, code) {
  assertWorkflowJsonBudget(value, {
    label,
    onViolation: ({ kind, message }) => {
      throw AppError.badRequest(message, code, { field: label, violation: kind });
    },
  });
  return JSON.parse(JSON.stringify(value));
}

async function normalizePathwayEvidenceProvenance(actor, signal) {
  const cleanActor = cloneBudgetedWorkflowJson(
    normalizeJsonObject(actor, 'actor'),
    'actor',
    'PATHWAY_EVIDENCE_PROVENANCE_INVALID',
  );
  const cleanSignal = cloneBudgetedWorkflowJson(
    normalizeJsonObject(signal, 'signal'),
    'signal',
    'PATHWAY_EVIDENCE_PROVENANCE_INVALID',
  );
  const signalKind = typeof cleanSignal.kind === 'string' && cleanSignal.kind.trim() === cleanSignal.kind
    ? safeText(cleanSignal.kind, 120)
    : null;
  if (!signalKind) {
    throw AppError.badRequest(
      'Pathway evidence signal kind is required',
      'PATHWAY_EVIDENCE_PROVENANCE_INVALID',
    );
  }

  if (cleanActor.kind === 'user') {
    const uid = maybeUuid(cleanActor.uid, 'actor.uid');
    const authorizationMode = typeof cleanActor.authorizationMode === 'string'
      && cleanActor.authorizationMode.trim() === cleanActor.authorizationMode
      ? safeText(cleanActor.authorizationMode, 80)
      : null;
    if (!uid || !authorizationMode) {
      throw AppError.badRequest(
        'Normalized user evidence provenance is required',
        'PATHWAY_EVIDENCE_PROVENANCE_INVALID',
      );
    }
    return Object.freeze({
      actor_kind: 'user',
      actor_uid: uid,
      authorization_mode: authorizationMode,
      override_reason: cleanActor.overrideReason == null
        ? null
        : safeText(cleanActor.overrideReason, 2000),
      break_glass_id: cleanActor.breakGlassId == null
        ? null
        : normalizeStrictPositiveId(cleanActor.breakGlassId, 'actor.breakGlassId'),
      signal_kind: signalKind,
      source_resource_type: cleanSignal.source_resource_type || null,
      source_resource_id: cleanSignal.source_resource_id || null,
      occurred_at: cleanSignal.occurred_at || null,
    });
  }

  if (cleanActor.kind === 'system') {
    const { isRegisteredWorkflowSystemActor } = await import('./workflowRuntimeRegistry.js');
    if (!isRegisteredWorkflowSystemActor(actor)) {
      throw AppError.forbidden(
        'Pathway evidence system actor is not sealed',
        'PATHWAY_EVIDENCE_PROVENANCE_INVALID',
      );
    }
    const signalContext = cleanActor.signalContext;
    const systemKey = requireCanonicalHandlerId(cleanActor.systemKey);
    const sourceEventId = String(cleanActor.sourceEventId ?? '');
    const causationId = cleanActor.causationId == null ? null : String(cleanActor.causationId);
    if (
      !/^\d+$/.test(sourceEventId)
      || sourceEventId.length > 19
      || (causationId !== null && (
        !causationId
        || causationId.trim() !== causationId
        || causationId.length > 160
      ))
      || !signalContext
      || cleanSignal.source_resource_type !== signalContext.sourceResourceType
      || cleanSignal.source_resource_id !== signalContext.sourceResourceId
      || cleanSignal.occurred_at !== signalContext.occurredAt
    ) {
      throw AppError.badRequest(
        'Normalized system evidence provenance does not match its sealed signal context',
        'PATHWAY_EVIDENCE_PROVENANCE_INVALID',
      );
    }
    return Object.freeze({
      actor_kind: 'system',
      system_key: systemKey,
      source_event_id: sourceEventId,
      causation_id: causationId,
      signal_kind: signalKind,
      source_resource_type: signalContext.sourceResourceType,
      source_resource_id: signalContext.sourceResourceId,
      occurred_at: signalContext.occurredAt,
    });
  }

  throw AppError.badRequest(
    'Pathway evidence actor kind must be user or sealed system',
    'PATHWAY_EVIDENCE_PROVENANCE_INVALID',
  );
}

async function hasPathwayExecutorAuthority(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  const { isPathwayExecutorCapability } = await import('../pathways/pathwayExecutorService.js');
  return typeof isPathwayExecutorCapability === 'function'
    && isPathwayExecutorCapability(candidate) === true;
}

async function assertPathwayExecutorAuthority({
  tenantId,
  workflowRunId,
  db,
  executorAuthority = null,
  verifiedExecutorAuthority = null,
}) {
  const verified = verifiedExecutorAuthority === null
    ? await hasPathwayExecutorAuthority(executorAuthority)
    : verifiedExecutorAuthority === true;
  if (!workflowRunId || verified) return verified;
  const rows = await db.$queryRawUnsafe(
    `SELECT 1
       FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND workflow_run_id = $2::bigint
      LIMIT 1`,
    tenantId,
    workflowRunId,
  );
  if (rows[0]) {
    throw AppError.conflict(
      'Pathway-bound workflow mutations must use the pathway executor',
      'PATHWAY_EXECUTOR_REQUIRED',
    );
  }
  return false;
}

async function taskWorkflowRunId({ tenantId, taskId, db }) {
  if (!taskId) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT COALESCE(task.workflow_run_id, step.workflow_run_id) AS workflow_run_id
       FROM tasks task
       LEFT JOIN workflow_steps step
         ON step.tenant_id = task.tenant_id
        AND step.id = task.workflow_step_id
      WHERE task.tenant_id = $1::uuid
        AND task.id = $2::bigint
      LIMIT 1`,
    tenantId,
    taskId,
  );
  return rows[0]?.workflow_run_id || null;
}

async function stepWorkflowRunId({ tenantId, workflowStepId, db }) {
  if (!workflowStepId) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT workflow_run_id
       FROM workflow_steps
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
      LIMIT 1`,
    tenantId,
    workflowStepId,
  );
  return rows[0]?.workflow_run_id || null;
}

async function taskRowWorkflowRunId({ tenantId, taskRow, db }) {
  if (!taskRow) return null;
  return taskRow.workflow_run_id || stepWorkflowRunId({
    tenantId,
    workflowStepId: taskRow.workflow_step_id,
    db,
  });
}

async function assertTaskSlaSourceBinding({
  tenantId,
  taskRow,
  db,
}) {
  const slaInstanceId = taskRow?.workflow_sla_instance_id;
  if (!slaInstanceId) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT sla.id, sla.rule_code, sla.source_table, sla.source_id, sla.due_at,
            sla.status, sla.completed_at, sla.assigned_user_uid,
            sla.assigned_role_codes
       FROM workflow_sla_instances sla
      WHERE sla.tenant_id = $1::uuid
        AND sla.id = $2::uuid
      LIMIT 1
      FOR SHARE`,
    tenantId,
    slaInstanceId,
  );
  const sla = rows[0];
  const taskResourceType = taskRow.related_resource_type == null
    ? null
    : String(taskRow.related_resource_type);
  const taskResourceId = taskRow.related_resource_id == null
    ? null
    : String(taskRow.related_resource_id);
  const sourceTable = sla?.source_table == null ? null : String(sla.source_table);
  const sourceId = sla?.source_id == null ? null : String(sla.source_id);
  const workflowStepId = taskRow.workflow_step_id == null
    ? null
    : String(taskRow.workflow_step_id);

  let valid = false;
  if (sla && workflowStepId) {
    valid = sourceTable === 'workflow_steps' && sourceId === workflowStepId;
  } else if (
    sla
    && ['critical_result_ack', 'cold_chain_excursion_ack', 'referral_response']
      .includes(sla.rule_code)
  ) {
    valid = taskRow.sla_completion_semantics === 'acknowledgement'
      && Boolean(taskResourceType && taskResourceId)
      && sourceTable === taskResourceType
      && sourceId === taskResourceId;
  } else if (sla?.rule_code === 'mortuary_unclaimed_body') {
    valid = taskRow.sla_completion_semantics === 'domain_evidence'
      && taskResourceType === 'death_record'
      && Boolean(taskResourceId)
      && sourceTable === 'death_records'
      && sourceId === taskResourceId;
    if (valid) {
      const deathRecord = await db.$queryRawUnsafe(
        `SELECT 1
           FROM death_records
          WHERE tenant_id = $1::uuid
            AND id::text = $2::text
          LIMIT 1`,
        tenantId,
        taskResourceId,
      );
      valid = Boolean(deathRecord[0]);
    }
  } else if (sla && WARD_MEDICATION_SLA_RULES.has(String(sla.rule_code))) {
    valid = taskRow.sla_completion_semantics === 'domain_evidence'
      && Boolean(taskResourceType && taskResourceId)
      && sourceTable === taskResourceType
      && sourceId === taskResourceId;
  } else if (
    sla
    && CLINICAL_ALERT_DELIVERY_RECOVERY_SLA_RULES.has(String(sla.rule_code))
  ) {
    const caseKind = String(taskRow?.metadata?.case_kind || '');
    const expectedRule = caseKind === 'manual_hold'
      ? 'clinical_alert_delivery_manual_hold_review'
      : caseKind === 'recipient_coverage'
        ? 'clinical_alert_delivery_recipient_coverage'
        : null;
    valid = taskRow.sla_completion_semantics === 'domain_evidence'
      && taskRow?.metadata?.task_contract
        === CLINICAL_ALERT_DELIVERY_RECOVERY_TASK_CONTRACT
      && taskResourceType === 'clinical_alert_delivery_recovery_cases'
      && Boolean(taskResourceId)
      && sourceTable === taskResourceType
      && sourceId === taskResourceId
      && sla.rule_code === expectedRule;
  } else if (sla?.rule_code === MAR_MEDICATION_EXCEPTION_SLA_RULE) {
    valid = taskRow.sla_completion_semantics === 'domain_evidence'
      && taskRow?.metadata?.task_contract === MAR_MEDICATION_EXCEPTION_TASK_CONTRACT
      && taskResourceType === 'mar_medication_exception_cases'
      && Boolean(taskResourceId)
      && taskResourceId === String(taskRow?.metadata?.exception_case_id || '')
      && sourceTable === taskResourceType
      && sourceId === taskResourceId;
  } else if (sla?.rule_code === CATH_INVENTORY_SHORTFALL_SLA_RULE) {
    valid = taskRow.sla_completion_semantics === 'domain_evidence'
      && taskRow?.metadata?.task_contract === CATH_INVENTORY_SHORTFALL_TASK_CONTRACT
      && taskResourceType === 'cath_case_consumable_usage'
      && /^[1-9]\d*$/.test(String(taskResourceId || ''))
      && taskResourceId === String(taskRow?.metadata?.cath_consumable_usage_id || '')
      && sourceTable === taskResourceType
      && sourceId === taskResourceId;
  } else if (sla?.rule_code === 'payment_gateway_refund_recovery') {
    valid = taskRow.sla_completion_semantics === 'domain_evidence'
      && taskResourceType === 'payment_gateway_refunds'
      && Boolean(taskResourceId)
      && sourceTable === 'payment_gateway_refunds'
      && sourceId === taskResourceId;
    if (valid) {
      const refund = await db.$queryRawUnsafe(
        `SELECT 1
           FROM payment_gateway_refunds
          WHERE tenant_id = $1::uuid
            AND id::text = $2::text
          LIMIT 1`,
        tenantId,
        taskResourceId,
      );
      valid = Boolean(refund[0]);
    }
  }

  if (!valid) {
    throw AppError.conflict(
      'Task and linked SLA source do not describe the same obligation',
      'TASK_SLA_SOURCE_BINDING_INVALID',
    );
  }
  return sla;
}

async function completeLinkedSla({
  tenantId,
  taskRow,
  db = null,
  completedBy = null,
  completionTrigger,
  completedAt = null,
  evidence = null,
  ackContractVersion = null,
  strict = false,
}) {
  const slaInstanceId = taskRow?.workflow_sla_instance_id;
  if (!slaInstanceId) return null;
  const semantics = taskRow?.sla_completion_semantics || 'none';
  const triggerAllowed = (
    semantics === 'acknowledgement'
      && (completionTrigger === 'acknowledgement' || completionTrigger === 'task_completion')
  ) || (semantics === 'domain_evidence' && completionTrigger === 'domain_evidence');
  if (!triggerAllowed) return null;
  const completionMarker = completionTrigger === 'acknowledgement' ? 'task_ack' : completionTrigger;
  const completionTimestamp = completionTrigger === 'acknowledgement'
    ? (durableTimestampBinding(completedAt)
      || durableTimestampBinding(taskRow?.metadata?.acknowledged_at))
    : (durableTimestampBinding(completedAt) || new Date().toISOString());
  if (!completionTimestamp) {
    throw AppError.conflict(
      'A durable acknowledgement receipt is required to complete the linked SLA',
      'TASK_ACKNOWLEDGEMENT_RECEIPT_REQUIRED',
    );
  }
  const client = db || prisma;
  try {
    const rows = await client.$queryRawUnsafe(
      `UPDATE workflow_sla_instances
              SET status = CASE
                WHEN due_at IS NOT NULL AND $7::text::timestamptz > due_at
                  THEN CASE WHEN status = 'escalated' THEN 'escalated' ELSE 'breached' END
                ELSE 'completed'
              END,
              completed_at = $7::text::timestamptz,
              breached_at = CASE
                WHEN due_at IS NOT NULL AND $7::text::timestamptz > due_at THEN due_at
                ELSE NULL
              END,
              metadata = COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object(
                     'completed_via', $4::text,
                     'completed_by_task', $1::int
                   )
                || CASE WHEN $5::text IS NOT NULL
                        THEN jsonb_build_object('completed_by', $5::text)
                        ELSE '{}'::jsonb END
                 || CASE WHEN $6::jsonb IS NOT NULL
                         THEN jsonb_build_object('completion_evidence', $6::jsonb)
                         ELSE '{}'::jsonb END
                 || CASE WHEN $8::int IS NOT NULL
                         THEN jsonb_build_object('ack_contract_version', $8::int)
                         ELSE '{}'::jsonb END,
              updated_at = NOW()
        WHERE id = $2::uuid
          AND tenant_id = $3::uuid
          AND status NOT IN ('completed', 'cancelled')
          AND completed_at IS NULL
        RETURNING id, status, completed_at`,
      taskRow.id,
      String(slaInstanceId),
      tenantId,
      completionMarker,
      completedBy ? String(completedBy) : null,
      evidence ? JSON.stringify(evidence) : null,
      completionTimestamp,
      ackContractVersion,
    );
    return rows[0] || null;
  } catch (err) {
    if (strict) throw err;
    if (isMissingSchemaError(err)) return null;
    logger.warn('completeLinkedSla: SLA completion failed', {
      taskId: taskRow?.id, slaInstanceId, err: err?.message,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const TASK_RETURNING = `id, tenant_id, workflow_run_id, workflow_step_id, parent_task_id,
  task_kind, title, description, patient_uid, encounter_id,
  related_resource_type, related_resource_id,
  priority, status, assigned_to_uid, assigned_to_role, created_by,
  due_at, completed_at, cancelled_at, cancellation_reason,
  sla_definition_id, sla_breached_at,
  workflow_sla_instance_id, sla_completion_semantics, stage_occurrence_key,
  metadata, created_at, updated_at`;

export async function createTask({
  tenantId = null,
  workflowRunId = null,
  workflowStepId = null,
  parentTaskId = null,
  taskKind = 'general',
  title,
  description = null,
  patientUid = null,
  encounterId = null,
  relatedResourceType = null,
  relatedResourceId = null,
  priority = 'normal',
  assignedToUid = null,
  assignedToRole = null,
  createdBy = null,
  dueAt = null,
  slaDefinitionId = null,
  workflowSlaInstanceId = null,
  slaCompletionSemantics = 'none',
  stageOccurrenceKey = null,
  metadata = null,
  executorAuthority = null,
  protectedTaskCreationAuthority = null,
  // Optional transaction client (e.g. a setTenantTx tx) — defaults to the
  // singleton. Lets the results-inbox producer create a task inside the same
  // tenant-scoped transaction as its SLA-instance link.
  tx = null,
  // When true, append `ON CONFLICT … DO NOTHING` inferring the partial unique
  // index `uq_task_open_per_resource` (expanded by migration 580). Makes the producer's
  // "one open task per result resource" insert race-safe: a concurrent insert
  // for the same (tenant, related_resource_type, related_resource_id) while an
  // open/in_progress/blocked/overdue task already exists is a no-op (RETURNING yields
  // no row → this returns undefined).
  onConflictResourceDoNothing = false,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanTitle = safeText(title, 500);
  if (!cleanTitle) throw AppError.badRequest('title is required');
  const db = tx || prisma;
  const cleanWorkflowRunId = workflowRunId ? normalizeId(workflowRunId, 'workflow_run_id') : null;
  const cleanWorkflowStepId = workflowStepId ? normalizeId(workflowStepId, 'workflow_step_id') : null;
  const cleanParentTaskId = parentTaskId ? normalizeId(parentTaskId, 'parent_task_id') : null;
  const cleanTaskKind = normalizeEnum(taskKind, TASK_KINDS, 'task_kind') || 'general';
  const cleanRelatedResourceType = safeText(relatedResourceType, 60);
  const cleanRelatedResourceId = safeText(relatedResourceId, 120);
  const assignment = normalizeTaskAssignment({ assignedToUid, assignedToRole });
  const cleanWorkflowSlaInstanceId = maybeUuid(workflowSlaInstanceId, 'workflow_sla_instance_id');
  const cleanSlaCompletionSemantics = normalizeEnum(
    slaCompletionSemantics,
    TASK_SLA_COMPLETION_SEMANTICS,
    'sla_completion_semantics',
  ) || 'none';
  if (Boolean(cleanWorkflowSlaInstanceId) !== (cleanSlaCompletionSemantics !== 'none')) {
    throw AppError.badRequest(
      'workflow_sla_instance_id and a non-none sla_completion_semantics must be supplied together',
      'TASK_SLA_CONTRACT_INVALID',
    );
  }
  const cleanStageOccurrenceKey = safeText(stageOccurrenceKey, 200);
  const cleanMetadata = normalizeTaskMetadata(metadata);
  assertProtectedTaskCreationAllowed({
    taskKind: cleanTaskKind,
    relatedResourceType: cleanRelatedResourceType,
    metadata: cleanMetadata,
    authority: protectedTaskCreationAuthority,
  });
  const verifiedExecutorAuthority = await hasPathwayExecutorAuthority(executorAuthority);
  await assertPathwayExecutorAuthority({
    tenantId: tid,
    workflowRunId: cleanWorkflowRunId,
    db,
    executorAuthority,
    verifiedExecutorAuthority,
  });
  if (!verifiedExecutorAuthority) {
    const attachedStepRunId = await stepWorkflowRunId({
      tenantId: tid,
      workflowStepId: cleanWorkflowStepId,
      db,
    });
    if (attachedStepRunId && String(attachedStepRunId) !== String(cleanWorkflowRunId || '')) {
      await assertPathwayExecutorAuthority({
        tenantId: tid,
        workflowRunId: attachedStepRunId,
        db,
        executorAuthority,
      });
    }
    const parentRunId = await taskWorkflowRunId({ tenantId: tid, taskId: cleanParentTaskId, db });
    if (parentRunId && String(parentRunId) !== String(cleanWorkflowRunId || '')) {
      await assertPathwayExecutorAuthority({
        tenantId: tid,
        workflowRunId: parentRunId,
        db,
        executorAuthority,
      });
    }
  }
  const linkedSla = await assertTaskSlaSourceBinding({
    tenantId: tid,
    taskRow: {
      workflow_sla_instance_id: cleanWorkflowSlaInstanceId,
      sla_completion_semantics: cleanSlaCompletionSemantics,
      workflow_step_id: cleanWorkflowStepId,
      related_resource_type: cleanRelatedResourceType,
      related_resource_id: cleanRelatedResourceId,
      metadata: cleanMetadata,
    },
    db,
  });
  const suppliedDueAt = normalizeTimestamp(dueAt, 'due_at');
  let taskDueAt = suppliedDueAt;
  if (cleanWorkflowSlaInstanceId) {
    const linkedSlaDueAt = normalizeTimestamp(linkedSla?.due_at, 'linked SLA due_at');
    if (linkedSlaDueAt === null) {
      throw AppError.conflict(
        'Typed task SLA must have a due_at deadline',
        'TASK_SLA_DUE_AT_MISSING',
      );
    }
    if (suppliedDueAt !== null) {
      throw AppError.badRequest(
        'Typed task due_at is derived from the linked SLA and must not be supplied',
        'TASK_SLA_DUE_AT_DERIVED',
      );
    }
    // The INSERT selects this deadline from workflow_sla_instances directly.
    // A JS Date cannot carry PostgreSQL's microseconds, so round-tripping the
    // selected value through Prisma would violate the exact DB invariant.
    taskDueAt = null;
  }

  // Infer the partial unique index by its column list + predicate (Postgres
  // resolves a partial unique index from a matching ON CONFLICT predicate; the
  // index is not a named constraint so it cannot be targeted by name).
  const conflictClause = onConflictResourceDoNothing
    ? `ON CONFLICT (tenant_id, related_resource_type, related_resource_id)
         WHERE status IN ('open', 'in_progress', 'blocked', 'overdue')
           AND related_resource_type IS NOT NULL
           AND related_resource_id IS NOT NULL
       DO NOTHING`
    : '';

  try {
    const rows = await db.$queryRawUnsafe(
      `INSERT INTO tasks
         (tenant_id, workflow_run_id, workflow_step_id, parent_task_id,
          task_kind, title, description,
          patient_uid, encounter_id, related_resource_type, related_resource_id,
          priority, status,
          assigned_to_uid, assigned_to_role, created_by,
          due_at, sla_definition_id,
          workflow_sla_instance_id, sla_completion_semantics, stage_occurrence_key,
          metadata)
       VALUES ($1::uuid, $2, $3, $4,
         $5, $6, $7,
         $8::uuid, $9, $10, $11,
         $12, 'open',
         $13::uuid, $14, $15::uuid,
         CASE WHEN $18::uuid IS NULL
              THEN to_timestamp($16::double precision / 1000.0)
              ELSE (
                SELECT sla.due_at
                  FROM workflow_sla_instances sla
                 WHERE sla.tenant_id = $1::uuid
                   AND sla.id = $18::uuid
              )
          END, $17,
         $18::uuid, $19, $20,
         $21::jsonb)
       ${conflictClause}
       RETURNING ${TASK_RETURNING}`,
      tid,
      cleanWorkflowRunId,
      cleanWorkflowStepId,
      cleanParentTaskId,
      cleanTaskKind,
      cleanTitle,
      safeText(description),
      maybeUuid(patientUid, 'patient_uid'),
      encounterId ? normalizeId(encounterId, 'encounter_id') : null,
      cleanRelatedResourceType,
      cleanRelatedResourceId,
      normalizeEnum(priority, TASK_PRIORITIES, 'priority') || 'normal',
      assignment.uid,
      assignment.role,
      maybeUuid(createdBy, 'created_by'),
      taskDueAt,
      slaDefinitionId ? normalizeId(slaDefinitionId, 'sla_definition_id') : null,
      cleanWorkflowSlaInstanceId,
      cleanSlaCompletionSemantics,
      cleanStageOccurrenceKey,
      JSON.stringify(cleanMetadata),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function createWardMedicationObligationTaskTx({
  tenantId = null,
  taskKind = 'review',
  title,
  description = null,
  patientUid = null,
  encounterId = null,
  relatedResourceType,
  relatedResourceId,
  priority = 'high',
  assignedToRole,
  createdBy = null,
  workflowSlaInstanceId,
  stageOccurrenceKey,
  metadata = null,
  tx,
} = {}) {
  const db = requiredTaskFactoryTx(
    tx,
    'WARD_MEDICATION_TASK_TRANSACTION_REQUIRED',
    'Ward medication obligation tasks require the caller transaction',
  );
  const slaId = maybeUuid(workflowSlaInstanceId, 'workflow_sla_instance_id');
  if (!slaId) {
    throw AppError.internal(
      'Ward medication obligation tasks require a linked workflow SLA',
      'WARD_MEDICATION_TASK_SLA_REQUIRED',
    );
  }
  const cleanMetadata = normalizeTaskMetadata(metadata);
  const cleanCanonicalEncounterId = maybeUuid(encounterId, 'encounter_id');
  const ruleCode = safeText(cleanMetadata?.sla_key, 120);
  if (!WARD_MEDICATION_SLA_RULES.has(ruleCode)) {
    throw AppError.internal(
      'Ward medication obligation task has an unregistered SLA rule',
      'WARD_MEDICATION_TASK_SLA_UNREGISTERED',
    );
  }
  return createTask({
    tenantId,
    taskKind,
    title,
    description,
    patientUid,
    relatedResourceType,
    relatedResourceId,
    priority,
    assignedToRole,
    createdBy,
    workflowSlaInstanceId: slaId,
    slaCompletionSemantics: 'domain_evidence',
    stageOccurrenceKey,
    metadata: {
      ...cleanMetadata,
      ...(cleanCanonicalEncounterId
        ? { canonical_encounter_id: cleanCanonicalEncounterId }
        : {}),
      task_contract: WARD_MEDICATION_TASK_CONTRACT,
    },
    protectedTaskCreationAuthority: WARD_MEDICATION_TASK_CREATION_AUTHORITY,
    tx: db,
    onConflictResourceDoNothing: true,
  });
}

export async function createMarMedicationExceptionTaskTx({
  tenantId = null,
  title,
  description = null,
  patientUid,
  encounterId = null,
  relatedResourceId,
  assignedToUid = null,
  assignedToRole = null,
  createdBy,
  workflowSlaInstanceId,
  stageOccurrenceKey,
  metadata = null,
  tx,
} = {}) {
  const db = requiredTaskFactoryTx(
    tx,
    'MAR_EXCEPTION_TASK_TRANSACTION_REQUIRED',
    'MAR medication exception tasks require the caller transaction',
  );
  const slaId = maybeUuid(workflowSlaInstanceId, 'workflow_sla_instance_id');
  if (!slaId) {
    throw AppError.internal(
      'MAR medication exception tasks require a linked workflow SLA',
      'MAR_EXCEPTION_TASK_SLA_REQUIRED',
    );
  }
  const caseId = safeText(relatedResourceId, 120);
  const cleanMetadata = normalizeTaskMetadata(metadata);
  const medicationAdministrationId = String(
    cleanMetadata?.medication_administration_id || '',
  );
  const exceptionKind = safeText(cleanMetadata?.exception_kind, 20);
  if (
    !/^[1-9][0-9]{0,18}$/.test(caseId)
    || BigInt(caseId) > 9223372036854775807n
    || !/^[1-9]\d*$/.test(medicationAdministrationId)
    || !['held', 'missed'].includes(exceptionKind)
  ) {
    throw AppError.internal(
      'MAR medication exception task identity is invalid',
      'MAR_EXCEPTION_TASK_IDENTITY_INVALID',
    );
  }
  const cleanCanonicalEncounterId = maybeUuid(encounterId, 'encounter_id');
  return createTask({
    tenantId,
    taskKind: 'review',
    title,
    description,
    patientUid,
    relatedResourceType: 'mar_medication_exception_cases',
    relatedResourceId: caseId,
    priority: 'critical',
    assignedToUid,
    assignedToRole,
    createdBy,
    workflowSlaInstanceId: slaId,
    slaCompletionSemantics: 'domain_evidence',
    stageOccurrenceKey,
    metadata: {
      ...cleanMetadata,
      exception_case_id: caseId,
      medication_administration_id: Number(medicationAdministrationId),
      exception_kind: exceptionKind,
      assignment_origin: assignedToUid
        ? 'source_prescriber'
        : 'prescriber_coverage_queue',
      sla_key: MAR_MEDICATION_EXCEPTION_SLA_RULE,
      ...(cleanCanonicalEncounterId
        ? { canonical_encounter_id: cleanCanonicalEncounterId }
        : {}),
      task_contract: MAR_MEDICATION_EXCEPTION_TASK_CONTRACT,
    },
    protectedTaskCreationAuthority: MAR_MEDICATION_EXCEPTION_TASK_CREATION_AUTHORITY,
    tx: db,
    onConflictResourceDoNothing: true,
  });
}

export async function createCathInventoryShortfallTaskTx({
  tenantId = null,
  title,
  description = null,
  patientUid,
  encounterId = null,
  relatedResourceId,
  createdBy,
  workflowSlaInstanceId,
  stageOccurrenceKey,
  metadata = null,
  tx,
} = {}) {
  const db = requiredTaskFactoryTx(
    tx,
    'CATH_INVENTORY_SHORTFALL_TASK_TRANSACTION_REQUIRED',
    'Cath inventory shortfall tasks require the caller transaction',
  );
  const slaId = maybeUuid(workflowSlaInstanceId, 'workflow_sla_instance_id');
  if (!slaId) {
    throw AppError.internal(
      'Cath inventory shortfall tasks require a linked workflow SLA',
      'CATH_INVENTORY_SHORTFALL_TASK_SLA_REQUIRED',
    );
  }
  const usageId = safeText(relatedResourceId, 120);
  const cleanMetadata = normalizeTaskMetadata(metadata);
  const caseId = String(cleanMetadata?.cath_case_id || '').trim();
  const inventoryItemId = String(cleanMetadata?.inventory_item_id || '').trim();
  const movementKind = safeText(cleanMetadata?.movement_kind, 20);
  const expectedStageOccurrenceKey = `cath-inventory-shortfall:usage:${usageId}`;
  const expectedDeepLink = '/pharmacy/cath-inventory-reconciliation'
    + `?case_id=${caseId}&consumable_usage_id=${usageId}`;
  const expectedRetryPath = `/api/v1/cath-lab/cases/${caseId}`
    + `/consumables/${usageId}/inventory-reconcile`;
  if (
    !/^[1-9]\d*$/.test(usageId)
    || !/^[1-9]\d*$/.test(caseId)
    || !/^[1-9]\d*$/.test(inventoryItemId)
    || !['issue', 'dispose'].includes(movementKind)
    || stageOccurrenceKey !== expectedStageOccurrenceKey
    || cleanMetadata?.deep_link !== expectedDeepLink
    || cleanMetadata?.retry_path !== expectedRetryPath
  ) {
    throw AppError.internal(
      'Cath inventory shortfall task identity is invalid',
      'CATH_INVENTORY_SHORTFALL_TASK_IDENTITY_INVALID',
    );
  }
  const cleanCanonicalEncounterId = maybeUuid(encounterId, 'encounter_id');
  return createTask({
    tenantId,
    taskKind: 'review',
    title,
    description,
    patientUid,
    relatedResourceType: 'cath_case_consumable_usage',
    relatedResourceId: usageId,
    priority: 'high',
    assignedToRole: 'PHARMACIST',
    createdBy,
    workflowSlaInstanceId: slaId,
    slaCompletionSemantics: 'domain_evidence',
    stageOccurrenceKey,
    metadata: {
      ...cleanMetadata,
      cath_consumable_usage_id: usageId,
      cath_case_id: caseId,
      inventory_item_id: inventoryItemId,
      movement_kind: movementKind,
      sla_key: CATH_INVENTORY_SHORTFALL_SLA_RULE,
      ...(cleanCanonicalEncounterId
        ? { canonical_encounter_id: cleanCanonicalEncounterId }
        : {}),
      task_contract: CATH_INVENTORY_SHORTFALL_TASK_CONTRACT,
    },
    protectedTaskCreationAuthority: CATH_INVENTORY_SHORTFALL_TASK_CREATION_AUTHORITY,
    tx: db,
    onConflictResourceDoNothing: true,
  });
}

export async function createPendingResultTrackingTaskTx({
  tenantId = null,
  handoffId,
  admissionId,
  patientUid,
  sourceType,
  sourceId,
  patientSafeLabel,
  ownerUid,
  createdBy,
  predecessorTrackingTaskId = null,
  rearmReason = null,
  tx = null,
} = {}) {
  requiredTaskFactoryTx(
    tx,
    'INPATIENT_PENDING_RESULT_TASK_FACTORY_TX_REQUIRED',
    'Pending-result tracking task creation requires a transaction',
  );
  const cleanHandoffId = maybeUuid(handoffId, 'handoff_id');
  const cleanAdmissionId = normalizeId(admissionId, 'admission_id');
  const cleanPatientUid = maybeUuid(patientUid, 'patient_uid');
  const cleanOwnerUid = maybeUuid(ownerUid, 'owner_uid');
  const cleanCreatedBy = maybeUuid(createdBy, 'created_by');
  const cleanSourceType = safeText(sourceType, 60);
  const cleanSourceId = safeText(sourceId, 160);
  const cleanLabel = safeText(patientSafeLabel, 240);
  const cleanPredecessorTrackingTaskId = predecessorTrackingTaskId == null
    ? null
    : normalizeId(predecessorTrackingTaskId, 'predecessor_tracking_task_id');
  const cleanRearmReason = safeText(rearmReason, 80);
  if (
    !cleanHandoffId
    || !cleanPatientUid
    || !cleanOwnerUid
    || !cleanCreatedBy
    || !cleanSourceType
    || !cleanSourceId
    || !cleanLabel
  ) {
    throw AppError.badRequest(
      'Pending-result tracking task requires exact handoff, admission, patient, source, owner, and provenance',
      'INPATIENT_PENDING_RESULT_TASK_FACTORY_INPUT_INVALID',
    );
  }
  if (
    Boolean(cleanPredecessorTrackingTaskId) !== Boolean(cleanRearmReason)
    || (
      cleanRearmReason
      && !['doctor_reopened', 'corrected_generation'].includes(cleanRearmReason)
    )
  ) {
    throw AppError.badRequest(
      'Pending-result tracking task rearm requires its exact predecessor task and reason',
      'INPATIENT_PENDING_RESULT_TASK_FACTORY_LINEAGE_INVALID',
    );
  }
  return createTask({
    tenantId,
    taskKind: 'follow_up',
    title: `Follow up ${cleanLabel}`,
    description: 'Track the named physician handoff for a result pending at discharge.',
    patientUid: cleanPatientUid,
    relatedResourceType: 'discharge_pending_result_handoff',
    relatedResourceId: cleanHandoffId,
    assignedToUid: cleanOwnerUid,
    createdBy: cleanCreatedBy,
    metadata: {
      admission_id: cleanAdmissionId,
      source_type: cleanSourceType,
      source_id: cleanSourceId,
      relationship_kind: 'child_action',
      blocking_state: 'handoff_warning',
      task_contract: 'discharge_pending_result_tracking_v1',
      correlation_contract: 'pending_result_tracking_v1',
      predecessor_tracking_task_id: cleanPredecessorTrackingTaskId,
      rearm_reason: cleanRearmReason,
    },
    protectedTaskCreationAuthority: PENDING_RESULT_TASK_CREATION_AUTHORITY,
    tx,
    onConflictResourceDoNothing: true,
  });
}

export async function createLabThresholdExceptionReviewTaskTx({
  tenantId = null,
  exceptionId,
  resultId,
  patientUid,
  testName,
  unmatchedReason,
  source,
  assignedToUid = null,
  assignedToRole = 'LAB_INCHARGE',
  createdBy = null,
  tx = null,
} = {}) {
  requiredTaskFactoryTx(
    tx,
    'LAB_THRESHOLD_EXCEPTION_TASK_FACTORY_TX_REQUIRED',
    'Lab threshold exception task creation requires a transaction',
  );
  const cleanExceptionId = maybeUuid(exceptionId, 'exception_id');
  const cleanResultId = normalizeId(resultId, 'result_id');
  const cleanPatientUid = maybeUuid(patientUid, 'patient_uid');
  const cleanTestName = safeText(testName, 240);
  const cleanUnmatchedReason = safeText(unmatchedReason, 80);
  const cleanSource = safeText(source, 120);
  const assignment = normalizeTaskAssignment({ assignedToUid, assignedToRole });
  const cleanCreatedBy = maybeUuid(createdBy, 'created_by');
  if (
    !cleanExceptionId
    || !cleanPatientUid
    || !cleanTestName
    || !cleanUnmatchedReason
    || !cleanSource
    || (!assignment.uid && assignment.role !== 'LAB_INCHARGE')
  ) {
    throw AppError.badRequest(
      'Lab threshold exception task requires exact exception, result, patient, reason, source, and laboratory owner',
      'LAB_THRESHOLD_EXCEPTION_TASK_FACTORY_INPUT_INVALID',
    );
  }
  return createTask({
    tenantId,
    taskKind: 'review',
    title: `Lab policy exception: ${cleanTestName}`,
    description: `${cleanTestName} could not be classified by the active governed laboratory policy (${cleanUnmatchedReason}); review and reconcile the policy coverage.`,
    patientUid: cleanPatientUid,
    relatedResourceType: 'lab_threshold_exception',
    relatedResourceId: cleanExceptionId,
    priority: 'high',
    assignedToUid: assignment.uid,
    assignedToRole: assignment.role,
    createdBy: cleanCreatedBy,
    metadata: {
      task_contract: LAB_THRESHOLD_EXCEPTION_TASK_CONTRACT,
      lab_result_id: cleanResultId,
      unmatched_reason: cleanUnmatchedReason,
      source: cleanSource,
    },
    protectedTaskCreationAuthority: LAB_THRESHOLD_EXCEPTION_TASK_CREATION_AUTHORITY,
    tx,
    onConflictResourceDoNothing: true,
  });
}

export async function createPendingResultOwnerActionTaskTx({
  tenantId = null,
  handoffId,
  generationId,
  admissionId,
  patientUid,
  parentTaskId,
  patientSafeLabel,
  sourceType,
  sourceId,
  ownerUid,
  createdBy,
  predecessorGenerationId = null,
  predecessorOwnerActionId = null,
  predecessorResolutionActionId = null,
  rearmSourceActionId = null,
  rearmReason = null,
  tx = null,
} = {}) {
  requiredTaskFactoryTx(
    tx,
    'INPATIENT_PENDING_RESULT_TASK_FACTORY_TX_REQUIRED',
    'Pending-result owner-action task creation requires a transaction',
  );
  const cleanHandoffId = maybeUuid(handoffId, 'handoff_id');
  const cleanGenerationId = maybeUuid(generationId, 'generation_id');
  const cleanAdmissionId = normalizeId(admissionId, 'admission_id');
  const cleanPatientUid = maybeUuid(patientUid, 'patient_uid');
  const cleanParentTaskId = normalizeId(parentTaskId, 'parent_task_id');
  const cleanLabel = safeText(patientSafeLabel, 240);
  const cleanSourceType = safeText(sourceType, 60);
  const cleanSourceId = safeText(sourceId, 160);
  const cleanOwnerUid = maybeUuid(ownerUid, 'owner_uid');
  const cleanCreatedBy = maybeUuid(createdBy, 'created_by');
  const cleanPredecessorGenerationId = maybeUuid(
    predecessorGenerationId,
    'predecessor_generation_id',
  );
  const cleanPredecessorOwnerActionId = maybeUuid(
    predecessorOwnerActionId,
    'predecessor_owner_action_id',
  );
  const cleanPredecessorResolutionActionId = maybeUuid(
    predecessorResolutionActionId,
    'predecessor_resolution_action_id',
  );
  const cleanRearmSourceActionId = maybeUuid(
    rearmSourceActionId,
    'rearm_source_action_id',
  );
  const cleanRearmReason = safeText(rearmReason, 80);
  if (
    !cleanHandoffId
    || !cleanGenerationId
    || !cleanPatientUid
    || !cleanLabel
    || !cleanSourceType
    || !cleanSourceId
    || !cleanOwnerUid
    || !cleanCreatedBy
  ) {
    throw AppError.badRequest(
      'Pending-result owner-action task requires exact handoff, generation, admission, patient, owner, and provenance',
      'INPATIENT_PENDING_RESULT_TASK_FACTORY_INPUT_INVALID',
    );
  }
  const isDoctorReopen = cleanRearmReason === 'doctor_reopened';
  const isCorrectedGeneration = cleanRearmReason === 'corrected_generation';
  if (
    (isDoctorReopen && (
      !cleanPredecessorOwnerActionId
      || !cleanPredecessorResolutionActionId
      || !cleanRearmSourceActionId
      || cleanPredecessorGenerationId
    ))
    || (isCorrectedGeneration && (
      !cleanPredecessorOwnerActionId
      || !cleanPredecessorGenerationId
      || cleanRearmSourceActionId
    ))
    || (!isDoctorReopen && !isCorrectedGeneration && (
      cleanPredecessorOwnerActionId
      || cleanPredecessorGenerationId
      || cleanPredecessorResolutionActionId
      || cleanRearmSourceActionId
      || cleanRearmReason
    ))
  ) {
    throw AppError.badRequest(
      'Pending-result owner-action task lineage does not match initial, correction, or doctor-reopen creation',
      'INPATIENT_PENDING_RESULT_TASK_FACTORY_LINEAGE_INVALID',
    );
  }
  return createTask({
    tenantId,
    parentTaskId: cleanParentTaskId,
    taskKind: 'review',
    title: `Review ${cleanLabel}`,
    description: isDoctorReopen
      ? 'A pending-at-discharge result requires renewed review by the named physician.'
      : isCorrectedGeneration
        ? 'A corrected result pending at discharge is available for the named physician.'
        : 'A result pending at discharge is now available for the named physician.',
    patientUid: cleanPatientUid,
    relatedResourceType: 'discharge_pending_result_action',
    relatedResourceId: isDoctorReopen
      ? `${cleanHandoffId}:${cleanGenerationId}:${cleanPredecessorOwnerActionId}`
      : `${cleanHandoffId}:${cleanGenerationId}`,
    assignedToUid: cleanOwnerUid,
    createdBy: cleanCreatedBy,
    metadata: {
      admission_id: cleanAdmissionId,
      handoff_id: cleanHandoffId,
      generation_id: cleanGenerationId,
      predecessor_generation_id: cleanPredecessorGenerationId,
      predecessor_owner_action_id: cleanPredecessorOwnerActionId,
      predecessor_resolution_action_id: cleanPredecessorResolutionActionId,
      rearm_source_action_id: cleanRearmSourceActionId,
      source_type: cleanSourceType,
      source_id: cleanSourceId,
      relationship_kind: 'child_action',
      blocking_state: 'result_action',
      correlation_source: 'diagnostic_generation',
      task_contract: 'discharge_pending_result_action_v1',
      correlation_contract: 'pending_result_owner_action_v2',
      rearm_reason: cleanRearmReason,
    },
    protectedTaskCreationAuthority: PENDING_RESULT_TASK_CREATION_AUTHORITY,
    tx,
    onConflictResourceDoNothing: true,
  });
}

export async function createCoveringTransferReviewTaskTx({
  tenantId = null,
  handoffId,
  pathwayInstanceId,
  patientUid,
  encounterId = null,
  recipientUid,
  senderUid,
  requestFingerprint,
  tx = null,
} = {}) {
  requiredTaskFactoryTx(
    tx,
    'COVERING_TRANSFER_TASK_FACTORY_TX_REQUIRED',
    'Covering-transfer review task creation requires a transaction',
  );
  const cleanHandoffId = maybeUuid(handoffId, 'handoff_id');
  const cleanPathwayInstanceId = maybeUuid(pathwayInstanceId, 'pathway_instance_id');
  const cleanPatientUid = maybeUuid(patientUid, 'patient_uid');
  const cleanEncounterId = maybeUuid(encounterId, 'encounter_id');
  const cleanRecipientUid = maybeUuid(recipientUid, 'recipient_uid');
  const cleanSenderUid = maybeUuid(senderUid, 'sender_uid');
  const cleanFingerprint = safeText(requestFingerprint, 128);
  if (
    !cleanHandoffId
    || !cleanPathwayInstanceId
    || !cleanPatientUid
    || !cleanRecipientUid
    || !cleanSenderUid
    || cleanSenderUid.toLowerCase() === cleanRecipientUid.toLowerCase()
    || !/^[0-9a-f]{64}$/.test(cleanFingerprint)
  ) {
    throw AppError.badRequest(
      'Covering-transfer task requires exact handoff, pathway, patient, actors, and request evidence',
      'COVERING_TRANSFER_TASK_FACTORY_INPUT_INVALID',
    );
  }
  return createTask({
    tenantId,
    taskKind: 'pathway_owner_transfer_review',
    title: 'Review covering clinician transfer request',
    description: 'Accept or decline the explicit covering clinician handoff.',
    patientUid: cleanPatientUid,
    relatedResourceType: 'care_handoff_instance',
    relatedResourceId: cleanHandoffId,
    priority: 'normal',
    assignedToUid: cleanRecipientUid,
    createdBy: cleanSenderUid,
    slaCompletionSemantics: 'none',
    metadata: {
      task_contract: COVERING_TRANSFER_TASK_CONTRACT,
      care_pathway_instance_id: cleanPathwayInstanceId,
      canonical_encounter_id: cleanEncounterId,
      request_fingerprint: cleanFingerprint,
    },
    protectedTaskCreationAuthority: COVERING_TRANSFER_TASK_CREATION_AUTHORITY,
    tx,
  });
}

export async function createOpInpatientTransferReviewTaskTx({
  tenantId = null,
  handoffId,
  pathwayInstanceId,
  sourceAppointmentId,
  patientUid,
  recipientUid,
  senderUid,
  requestFingerprint,
  tx = null,
} = {}) {
  requiredTaskFactoryTx(
    tx,
    'OP_INPATIENT_TRANSFER_TASK_FACTORY_TX_REQUIRED',
    'OP-to-inpatient review task creation requires a transaction',
  );
  const cleanHandoffId = maybeUuid(handoffId, 'handoff_id');
  const cleanPathwayInstanceId = maybeUuid(pathwayInstanceId, 'pathway_instance_id');
  const cleanAppointmentId = normalizeId(sourceAppointmentId, 'source_appointment_id');
  const cleanPatientUid = maybeUuid(patientUid, 'patient_uid');
  const cleanRecipientUid = maybeUuid(recipientUid, 'recipient_uid');
  const cleanSenderUid = maybeUuid(senderUid, 'sender_uid');
  const cleanFingerprint = safeText(requestFingerprint, 128);
  if (
    !cleanHandoffId
    || !cleanPathwayInstanceId
    || !cleanPatientUid
    || !cleanRecipientUid
    || !cleanSenderUid
    || cleanSenderUid.toLowerCase() === cleanRecipientUid.toLowerCase()
    || !/^[0-9a-f]{64}$/.test(cleanFingerprint)
  ) {
    throw AppError.badRequest(
      'OP-to-inpatient task requires exact handoff, pathway, appointment, patient, actors, and request evidence',
      'OP_INPATIENT_TRANSFER_TASK_FACTORY_INPUT_INVALID',
    );
  }
  return createTask({
    tenantId,
    taskKind: 'op_to_inpatient_transfer_review',
    title: 'Review OP-to-inpatient transfer request',
    description: 'Accept the exact originating outpatient transfer before admission.',
    patientUid: cleanPatientUid,
    relatedResourceType: 'care_handoff_instance',
    relatedResourceId: cleanHandoffId,
    priority: 'normal',
    assignedToUid: cleanRecipientUid,
    createdBy: cleanSenderUid,
    dueAt: null,
    slaCompletionSemantics: 'none',
    metadata: {
      task_contract: OP_INPATIENT_TRANSFER_TASK_CONTRACT,
      care_pathway_instance_id: cleanPathwayInstanceId,
      source_appointment_id: cleanAppointmentId,
      request_fingerprint: cleanFingerprint,
    },
    protectedTaskCreationAuthority: OP_INPATIENT_TRANSFER_TASK_CREATION_AUTHORITY,
    tx,
  });
}

export async function createEdDestinationHandoffReviewTaskTx({
  tenantId = null,
  handoffId,
  pathwayInstanceId,
  emergencyVisitId,
  patientUid,
  encounterId,
  recipientRole,
  senderUid,
  destination,
  requestFingerprint,
  tx = null,
} = {}) {
  requiredTaskFactoryTx(
    tx,
    'ED_DESTINATION_HANDOFF_TASK_FACTORY_TX_REQUIRED',
    'ED destination review task creation requires a transaction',
  );
  const cleanHandoffId = maybeUuid(handoffId, 'handoff_id');
  const cleanPathwayInstanceId = maybeUuid(pathwayInstanceId, 'pathway_instance_id');
  const cleanVisitId = normalizeId(emergencyVisitId, 'emergency_visit_id');
  const cleanPatientUid = maybeUuid(patientUid, 'patient_uid');
  const cleanEncounterId = maybeUuid(encounterId, 'encounter_id');
  const cleanRecipientRole = safeText(recipientRole, 80);
  const cleanSenderUid = maybeUuid(senderUid, 'sender_uid');
  const cleanDestination = safeText(destination, 40);
  const cleanFingerprint = safeText(requestFingerprint, 128);
  if (
    !cleanHandoffId
    || !cleanPathwayInstanceId
    || !cleanPatientUid
    || !cleanEncounterId
    || !cleanRecipientRole
    || !/^[A-Z][A-Z0-9_]{1,79}$/.test(cleanRecipientRole)
    || !cleanSenderUid
    || !cleanDestination
    || !/^[0-9a-f]{64}$/.test(cleanFingerprint)
  ) {
    throw AppError.badRequest(
      'ED destination task requires exact handoff, pathway, visit, patient, encounter, sender, destination, role, and request evidence',
      'ED_DESTINATION_HANDOFF_TASK_FACTORY_INPUT_INVALID',
    );
  }
  return createTask({
    tenantId,
    taskKind: 'ed_destination_handoff_review',
    title: `Accept ED destination handoff: ${cleanDestination.replaceAll('_', ' ')}`,
    description: 'Accept or decline the exact Emergency Department destination handoff.',
    patientUid: cleanPatientUid,
    relatedResourceType: 'care_handoff_instance',
    relatedResourceId: cleanHandoffId,
    priority: 'high',
    assignedToRole: cleanRecipientRole,
    createdBy: cleanSenderUid,
    dueAt: null,
    slaCompletionSemantics: 'none',
    metadata: {
      task_contract: ED_DESTINATION_HANDOFF_TASK_CONTRACT,
      care_pathway_instance_id: cleanPathwayInstanceId,
      emergency_visit_id: cleanVisitId,
      canonical_encounter_id: cleanEncounterId,
      destination: cleanDestination,
      request_fingerprint: cleanFingerprint,
    },
    protectedTaskCreationAuthority: ED_DESTINATION_HANDOFF_TASK_CREATION_AUTHORITY,
    tx,
  });
}

export async function createEdClosureReviewTaskTx({
  tenantId = null,
  pathwayInstanceId,
  emergencyVisitId,
  patientUid,
  encounterId,
  assignedToUid,
  evidenceRevision = null,
  supersedesTaskId = null,
  tx = null,
} = {}) {
  requiredTaskFactoryTx(
    tx,
    'ED_CLOSURE_TASK_FACTORY_TX_REQUIRED',
    'ED closure review task creation requires a transaction',
  );
  const cleanPathwayInstanceId = maybeUuid(pathwayInstanceId, 'pathway_instance_id');
  const cleanVisitId = normalizeId(emergencyVisitId, 'emergency_visit_id');
  const cleanPatientUid = maybeUuid(patientUid, 'patient_uid');
  const cleanEncounterId = maybeUuid(encounterId, 'encounter_id');
  const cleanAssignedToUid = maybeUuid(assignedToUid, 'assigned_to_uid');
  const cleanEvidenceRevision = evidenceRevision == null
    ? null
    : normalizeId(evidenceRevision, 'evidence_revision');
  const cleanSupersedesTaskId = supersedesTaskId == null
    ? null
    : normalizeId(supersedesTaskId, 'supersedes_task_id');
  if (
    !cleanPathwayInstanceId
    || !cleanPatientUid
    || !cleanEncounterId
    || !cleanAssignedToUid
  ) {
    throw AppError.badRequest(
      'ED closure task requires exact pathway, visit, patient, encounter, and clinician evidence',
      'ED_CLOSURE_TASK_FACTORY_INPUT_INVALID',
    );
  }
  return createTask({
    tenantId,
    taskKind: 'ed_closure_review',
    title: `Complete ED destination or closure evidence for visit #${cleanVisitId}`,
    description:
      'Record the exact destination acceptance, patient-safe aftercare, recovery outcome, or death/MLC/mortuary evidence for this ED visit.',
    patientUid: cleanPatientUid,
    relatedResourceType: 'emergency_visit_closure',
    relatedResourceId: String(cleanVisitId),
    priority: 'normal',
    assignedToUid: cleanAssignedToUid,
    dueAt: null,
    slaCompletionSemantics: 'none',
    metadata: {
      task_contract: ED_CLOSURE_TASK_CONTRACT,
      emergency_visit_id: cleanVisitId,
      canonical_encounter_id: cleanEncounterId,
      care_pathway_instance_id: cleanPathwayInstanceId,
      created_by_system_key: 'emergency.pathway_projector.v2',
      supersedes_task_id: cleanSupersedesTaskId,
      closure_evidence_revision: cleanEvidenceRevision,
    },
    protectedTaskCreationAuthority: ED_CLOSURE_TASK_CREATION_AUTHORITY,
    onConflictResourceDoNothing: true,
    tx,
  });
}

export async function listTasks({
  tenantId = null,
  status = null,
  priority = null,
  taskKind = null,
  assignedToUid = null,
  assignedToRole = null,
  patientUid = null,
  workflowRunId = null,
  overdueOnly = false,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, TASK_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (priority) {
    params.push(normalizeEnum(priority, TASK_PRIORITIES, 'priority'));
    filters.push(`priority = $${params.length}`);
  }
  if (taskKind) {
    params.push(normalizeEnum(taskKind, TASK_KINDS, 'task_kind'));
    filters.push(`task_kind = $${params.length}`);
  }
  if (assignedToUid) {
    params.push(maybeUuid(assignedToUid, 'assigned_to_uid'));
    filters.push(`assigned_to_uid = $${params.length}::uuid`);
  }
  if (assignedToRole) {
    params.push(safeText(assignedToRole, 80));
    filters.push(`assigned_to_role = $${params.length}`);
  }
  if (patientUid) {
    const cleanPatientUid = maybeUuid(patientUid, 'patient_uid');
    params.push(await resolveMergedPatientUidSet(prisma, {
      tenantId: tid,
      patientUid: cleanPatientUid,
    }));
    filters.push(`patient_uid = ANY($${params.length}::uuid[])`);
  }
  if (workflowRunId) {
    params.push(normalizeId(workflowRunId, 'workflow_run_id'));
    filters.push(`workflow_run_id = $${params.length}`);
  }
  if (overdueOnly) {
    filters.push(`due_at IS NOT NULL AND due_at < NOW() AND status IN ('open', 'in_progress', 'blocked')`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${TASK_RETURNING} FROM tasks
       WHERE ${filters.join(' AND ')}
       ORDER BY
         CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         due_at NULLS LAST,
         created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { tasks: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { tasks: [], count: 0 };
    throw err;
  }
}

// Optional `tx` (a setTenantTx tx client) threads these through the SAME
// tenant-scoped transaction as the caller; defaults to the singleton. Used by
// the escalation engine so an auto_resolve / reassign action and its
// metadata-escalation marker commit atomically. Backward-compatible: existing
// callers pass no tx and run on the singleton exactly as before.
export async function getTask({ tenantId = null, id, tx = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  const db = tx || prisma;
  const rows = await db.$queryRawUnsafe(
    `SELECT ${TASK_RETURNING} FROM tasks
     WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    taskId, tid,
  );
  if (!rows[0]) throw AppError.notFound('Task not found');
  return rows[0];
}

async function getTaskForUpdate({ tenantId, id, db }) {
  const rows = await db.$queryRawUnsafe(
    `SELECT ${TASK_RETURNING} FROM tasks
      WHERE id = $1 AND tenant_id = $2::uuid
      FOR UPDATE`,
    id,
    tenantId,
  );
  if (!rows[0]) throw AppError.notFound('Task not found');
  return rows[0];
}

function isCoveringTransferReviewTask(taskRow) {
  return taskRow?.task_kind === 'pathway_owner_transfer_review'
    && taskRow?.related_resource_type === 'care_handoff_instance'
    && taskRow?.metadata?.task_contract === COVERING_TRANSFER_TASK_CONTRACT;
}

function isOpInpatientTransferReviewTask(taskRow) {
  return taskRow?.task_kind === 'op_to_inpatient_transfer_review'
    && taskRow?.related_resource_type === 'care_handoff_instance'
    && taskRow?.metadata?.task_contract === OP_INPATIENT_TRANSFER_TASK_CONTRACT;
}

function isEdDestinationHandoffReviewTask(taskRow) {
  return taskRow?.task_kind === 'ed_destination_handoff_review'
    && taskRow?.related_resource_type === 'care_handoff_instance'
    && taskRow?.metadata?.task_contract === ED_DESTINATION_HANDOFF_TASK_CONTRACT;
}

function isPendingResultOwnerActionTask(taskRow) {
  return taskRow?.related_resource_type === 'discharge_pending_result_action';
}

function isPendingResultTrackingTask(taskRow) {
  return taskRow?.related_resource_type === 'discharge_pending_result_handoff';
}

function isSubstitutionFundingApprovalTask(taskRow) {
  return taskRow?.task_kind === 'review'
    && [
      'pharmacy_tpa_line_decision',
      'pharmacy_posted_payment',
      'pharmacy_patient_advance',
    ].includes(
      taskRow?.related_resource_type,
    )
    && taskRow?.metadata?.contract === SUBSTITUTION_FUNDING_TASK_CONTRACT
    && taskRow?.metadata?.stage === 'substitution_reauthorisation';
}

function assertGenericTaskMutationAllowed(taskRow, authority = null) {
  if (isSubstitutionFundingApprovalTask(taskRow)) {
    throw AppError.conflict(
      'Substitution funding tasks must be actioned through the funding reauthorisation workflow',
      'SUBSTITUTION_FUNDING_TASK_WORKFLOW_REQUIRED',
    );
  }
  if (
    isCoveringTransferReviewTask(taskRow)
    && authority !== COVERING_TRANSFER_TASK_AUTHORITY
  ) {
    throw AppError.conflict(
      'Covering-transfer review tasks must use the pathway ownership workflow',
      'COVERING_TRANSFER_TASK_WORKFLOW_REQUIRED',
    );
  }
  if (
    isOpInpatientTransferReviewTask(taskRow)
    && authority !== OP_INPATIENT_TRANSFER_TASK_AUTHORITY
  ) {
    throw AppError.conflict(
      'OP-to-inpatient transfer review tasks must use the appointment transfer workflow',
      'OP_INPATIENT_TRANSFER_TASK_WORKFLOW_REQUIRED',
    );
  }
  if (
    isEdDestinationHandoffReviewTask(taskRow)
    && authority !== ED_DESTINATION_HANDOFF_TASK_AUTHORITY
  ) {
    throw AppError.conflict(
      'ED destination review tasks must use the ED handoff workflow',
      'ED_DESTINATION_HANDOFF_TASK_WORKFLOW_REQUIRED',
    );
  }
  if (
    isPendingResultOwnerActionTask(taskRow)
    && ![
      PENDING_RESULT_OWNER_ACTION_TASK_AUTHORITY,
      PENDING_RESULT_TASK_TRANSFER_AUTHORITY,
      PENDING_RESULT_TASK_SETTLEMENT_AUTHORITY,
    ].includes(authority)
  ) {
    throw AppError.conflict(
      'Pending-result owner-action tasks must use the inpatient result review workflow',
      'INPATIENT_PENDING_RESULT_ACTION_TASK_WORKFLOW_REQUIRED',
    );
  }
  if (
    isPendingResultTrackingTask(taskRow)
    && ![
      PENDING_RESULT_TASK_TRANSFER_AUTHORITY,
      PENDING_RESULT_TASK_SETTLEMENT_AUTHORITY,
    ].includes(authority)
  ) {
    throw AppError.conflict(
      'Pending-result tracking tasks must use the inpatient handoff workflow',
      'INPATIENT_PENDING_RESULT_HANDOFF_TASK_WORKFLOW_REQUIRED',
    );
  }
}

function assertGovernedClinicalTaskTransitionAllowed(
  taskRow,
  nextStatus,
  domainEvidenceAuthority = null,
) {
  if (domainEvidenceAuthority === DOMAIN_EVIDENCE_COMPLETION_AUTHORITY) return;
  if (isMarMedicationExceptionContractBoundTask(taskRow)) {
    throw AppError.conflict(
      'MAR medication exception tasks must be actioned through the medication-exception workflow',
      'MAR_EXCEPTION_TASK_WORKFLOW_REQUIRED',
    );
  }
  if (
    isClinicalAlertDeliveryRecoveryContractBoundTask(taskRow)
    && !(taskRow?.status === 'open' && nextStatus === 'in_progress')
  ) {
    throw AppError.conflict(
      'Clinical alert recovery tasks must be actioned through the recovery workflow',
      'CLINICAL_ALERT_RECOVERY_TASK_WORKFLOW_REQUIRED',
    );
  }
}

export async function transitionTask({
  tenantId = null, id, nextStatus,
  cancellationReason = null,
  actorUid = undefined,
  executorAuthority = null,
  domainEvidenceAuthority = null,
  slaSourceBindingAuthority = null,
  acknowledgementTransitionAuthority = null,
  coveringTransferTaskAuthority = null,
  pendingResultOwnerActionTaskAuthority = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  const cleanNext = normalizeEnum(nextStatus, TASK_STATUSES, 'next_status', { required: true });
  // ADMIN HTTP callers always pass actorUid (including null when authentication
  // context is absent), which is validated here. Trusted in-process task
  // producers omit the property until S1b-b adds durable user/system events.
  if (actorUid !== undefined) requireActorUid(actorUid);
  if (!tx) {
    return setTenantTx(tid, (scopedTx) => transitionTask({
      tenantId: tid,
      id: taskId,
      nextStatus: cleanNext,
      cancellationReason,
      actorUid,
      executorAuthority,
      domainEvidenceAuthority,
      slaSourceBindingAuthority,
      acknowledgementTransitionAuthority,
      coveringTransferTaskAuthority,
      pendingResultOwnerActionTaskAuthority,
      tx: scopedTx,
    }));
  }
  const db = tx;

  const current = await getTaskForUpdate({ tenantId: tid, id: taskId, db });
  assertGovernedClinicalTaskTransitionAllowed(current, cleanNext, domainEvidenceAuthority);
  if (
    isCathInventoryShortfallContractBoundTask(current)
    && domainEvidenceAuthority !== DOMAIN_EVIDENCE_COMPLETION_AUTHORITY
  ) {
    throw AppError.conflict(
      'Cath inventory shortfall tasks must be actioned through the inventory reconciliation workflow',
      'CATH_INVENTORY_SHORTFALL_TASK_WORKFLOW_REQUIRED',
    );
  }
  assertGenericTaskMutationAllowed(
    current,
    coveringTransferTaskAuthority
      || pendingResultOwnerActionTaskAuthority,
  );
  const attachedRunId = await taskRowWorkflowRunId({ tenantId: tid, taskRow: current, db });
  await assertPathwayExecutorAuthority({
    tenantId: tid,
    workflowRunId: attachedRunId,
    db,
    executorAuthority,
  });
  if (slaSourceBindingAuthority !== TASK_SLA_SOURCE_BINDING_AUTHORITY) {
    await assertTaskSlaSourceBinding({ tenantId: tid, taskRow: current, db });
  }
  if (
    cleanNext === 'in_progress'
    && current.sla_completion_semantics === 'acknowledgement'
    && current.workflow_sla_instance_id
    && acknowledgementTransitionAuthority !== ACKNOWLEDGEMENT_TRANSITION_AUTHORITY
  ) {
    throw AppError.conflict(
      'Acknowledgement-tracked tasks must use the acknowledgement workflow',
      'TASK_ACKNOWLEDGEMENT_REQUIRED',
    );
  }
  if (
    cleanNext === 'completed'
    && current.sla_completion_semantics === 'acknowledgement'
    && current.workflow_sla_instance_id
    && acknowledgementTransitionAuthority !== ACKNOWLEDGEMENT_TRANSITION_AUTHORITY
    && !parseDurableTimestamp(current.metadata?.acknowledged_at)
  ) {
    // Completion closes the linked SLA (completeLinkedSla admits
    // 'task_completion' for acknowledgement semantics), so a generic completed
    // transition with no durable acknowledgement receipt behind it would stop
    // a critical_result_ack / cold_chain_excursion_ack / referral_response
    // clock with zero evidence anyone saw the result. The mig-581 boundary
    // covers only lab-alert-bound tasks; this covers every other
    // acknowledgement SLA. Acknowledge first (stamping
    // metadata.acknowledged_at), or come through the acknowledgement workflow.
    throw AppError.conflict(
      'Acknowledgement-tracked tasks must be acknowledged before completion',
      'TASK_ACKNOWLEDGEMENT_REQUIRED',
    );
  }
  if (
    cleanNext === 'completed'
    && current.sla_completion_semantics === 'domain_evidence'
    && domainEvidenceAuthority !== DOMAIN_EVIDENCE_COMPLETION_AUTHORITY
  ) {
    throw AppError.conflict(
      'Registered domain evidence is required to complete this task',
      'DOMAIN_EVIDENCE_REQUIRED',
    );
  }
  const allowed = TASK_TRANSITIONS[current.status] || [];
  if (!allowed.includes(cleanNext)) {
    throw AppError.invalidTransition(current.status, cleanNext, allowed);
  }
  if (
    cleanNext === 'cancelled'
    && current.sla_completion_semantics !== 'none'
    && current.workflow_sla_instance_id
  ) {
    const linkedSla = await db.$queryRawUnsafe(
      `SELECT completed_at
         FROM workflow_sla_instances
        WHERE id = $1::uuid
          AND tenant_id = $2::uuid
        FOR UPDATE`,
      current.workflow_sla_instance_id,
      tid,
    );
    if (!linkedSla[0]?.completed_at) {
      throw AppError.conflict(
        'A task with an incomplete linked SLA cannot be cancelled',
        'TASK_LINKED_SLA_INCOMPLETE',
      );
    }
  }

  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanNext];
  let transitionInstant = null;
  if (cleanNext === 'completed') {
    transitionInstant = new Date();
    params.push(transitionInstant.getTime());
    updates.push(`completed_at = to_timestamp($${params.length}::double precision / 1000.0)`);
  }
  if (cleanNext === 'cancelled') {
    transitionInstant = new Date();
    params.push(transitionInstant.getTime());
    updates.push(`cancelled_at = to_timestamp($${params.length}::double precision / 1000.0)`);
    if (cancellationReason) {
      params.push(safeText(cancellationReason));
      updates.push(`cancellation_reason = $${params.length}`);
    }
  }
  params.push(taskId);
  params.push(tid);
  params.push(current.status);

  const rows = await db.$queryRawUnsafe(
    `UPDATE tasks SET ${updates.join(', ')}
     WHERE id = $${params.length - 2}
       AND tenant_id = $${params.length - 1}::uuid
       AND status = $${params.length}
     RETURNING ${TASK_RETURNING}`,
    ...params,
  );
  if (!rows[0]) {
    await getTask({ tenantId: tid, id: taskId, tx });
    throw AppError.conflict('Task status changed before transition completed', 'TASK_TRANSITION_CONFLICT');
  }

  // A direct completion closes only an acknowledgement-semantics SLA.
  // Cancellation is work withdrawal, never evidence that the obligation was met.
  if (cleanNext === 'completed') {
    await completeLinkedSla({
      tenantId: tid,
      taskRow: rows[0],
      db,
      completionTrigger: 'task_completion',
      completedAt: transitionInstant,
      completedBy: actorUid,
      strict: true,
    });
  }
  return rows[0];
}

export async function supersedePendingResultOwnerActionTaskFromGenerationTx({
  tenantId = null,
  id,
  handoffId,
  generationId,
  supersedingGenerationId,
  patientUid,
  ownerUid,
  parentTaskId,
  actorUid,
  tx = null,
} = {}) {
  if (!tx) {
    throw AppError.internal(
      'Pending-result owner-action supersession requires a transaction',
      'INPATIENT_PENDING_RESULT_ACTION_TASK_TX_REQUIRED',
    );
  }
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  const cleanHandoffId = maybeUuid(handoffId, 'handoff_id').toLowerCase();
  const cleanGenerationId = maybeUuid(generationId, 'generation_id').toLowerCase();
  const cleanSupersedingGenerationId = maybeUuid(
    supersedingGenerationId,
    'superseding_generation_id',
  ).toLowerCase();
  const cleanPatientUid = maybeUuid(patientUid, 'patient_uid').toLowerCase();
  const cleanOwnerUid = maybeUuid(ownerUid, 'owner_uid').toLowerCase();
  const cleanParentTaskId = normalizeId(parentTaskId, 'parent_task_id');
  const cleanActorUid = requireActorUid(actorUid);
  const current = await getTaskForUpdate({
    tenantId: tid,
    id: taskId,
    db: tx,
  });
  if (
    current.task_kind !== 'review'
    || current.related_resource_type !== 'discharge_pending_result_action'
    || current.related_resource_id !== `${cleanHandoffId}:${cleanGenerationId}`
    || Number(current.parent_task_id) !== cleanParentTaskId
    || String(current.patient_uid || '').toLowerCase() !== cleanPatientUid
    || String(current.assigned_to_uid || '').toLowerCase() !== cleanOwnerUid
    || current.assigned_to_role != null
    || current.workflow_run_id != null
    || current.workflow_step_id != null
    || current.workflow_sla_instance_id != null
    || current.sla_completion_semantics !== 'none'
  ) {
    throw AppError.conflict(
      'Pending-result owner-action task does not match the generation being superseded',
      'INPATIENT_PENDING_RESULT_ACTION_TASK_BINDING_INVALID',
    );
  }
  const binding = await tx.$queryRawUnsafe(
    `SELECT action.id
       FROM discharge_pending_result_owner_actions AS action
       JOIN discharge_pending_result_handoffs AS handoff
         ON handoff.tenant_id = action.tenant_id
        AND handoff.id = action.handoff_id
        AND handoff.admission_id = action.admission_id
        AND handoff.patient_uid = action.patient_uid
       JOIN diagnostic_result_generations AS successor
         ON successor.tenant_id = action.tenant_id
        AND successor.id = $7::uuid
        AND successor.predecessor_generation_id = action.generation_id
        AND successor.patient_uid = action.patient_uid
        AND successor.admission_id = action.admission_id
      WHERE action.tenant_id = $1::uuid
        AND action.task_id = $2::integer
        AND action.handoff_id = $3::uuid
        AND action.generation_id = $4::uuid
        AND action.patient_uid = $5::uuid
        AND handoff.task_id = $8::integer
        AND handoff.named_physician_uid = $6::uuid
        AND NOT EXISTS (
          SELECT 1
            FROM discharge_pending_result_owner_actions AS action_successor
           WHERE action_successor.tenant_id = action.tenant_id
             AND action_successor.handoff_id = action.handoff_id
              AND action_successor.predecessor_owner_action_id = action.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM diagnostic_result_generations AS newer_generation
           WHERE newer_generation.tenant_id = successor.tenant_id
             AND newer_generation.predecessor_generation_id = successor.id
             AND newer_generation.patient_uid = successor.patient_uid
             AND newer_generation.admission_id = successor.admission_id
        )
      LIMIT 2
      FOR SHARE OF action, handoff, successor`,
    tid,
    taskId,
    cleanHandoffId,
    cleanGenerationId,
    cleanPatientUid,
    cleanOwnerUid,
    cleanSupersedingGenerationId,
    cleanParentTaskId,
  );
  if (binding.length !== 1) {
    throw AppError.conflict(
      'Pending-result owner-action task lacks an exact current correction binding',
      'INPATIENT_PENDING_RESULT_ACTION_TASK_BINDING_INVALID',
    );
  }
  return transitionTask({
    tenantId: tid,
    id: taskId,
    nextStatus: 'cancelled',
    cancellationReason: 'Superseded by a corrected diagnostic generation',
    actorUid: cleanActorUid,
    pendingResultOwnerActionTaskAuthority:
      PENDING_RESULT_OWNER_ACTION_TASK_AUTHORITY,
    tx,
  });
}

export async function reassignPendingResultTasksForAcceptedCoveringHandoffTx({
  tenantId = null,
  admissionId,
  patientUid,
  priorAssignmentId,
  assignmentId,
  acceptedHandoffId,
  priorPhysicianUid,
  physicianUid,
  actorUid,
  tx = null,
} = {}) {
  if (!tx) {
    throw AppError.internal(
      'Pending-result ownership reassignment requires a transaction',
      'INPATIENT_PENDING_RESULT_TASK_REASSIGNMENT_TX_REQUIRED',
    );
  }
  const tid = resolveTenantId({ tenantId });
  const cleanAdmissionId = normalizeId(admissionId, 'admission_id');
  const cleanPatientUid = maybeUuid(patientUid, 'patient_uid');
  const cleanPriorAssignmentId = maybeUuid(priorAssignmentId, 'prior_assignment_id');
  const cleanAssignmentId = maybeUuid(assignmentId, 'assignment_id');
  const cleanAcceptedHandoffId = maybeUuid(acceptedHandoffId, 'accepted_handoff_id');
  const cleanPriorPhysicianUid = maybeUuid(priorPhysicianUid, 'prior_physician_uid');
  const cleanPhysicianUid = maybeUuid(physicianUid, 'physician_uid');
  const cleanActorUid = requireActorUid(actorUid);
  if (
    !cleanPatientUid
    || !cleanPriorAssignmentId
    || !cleanAssignmentId
    || !cleanAcceptedHandoffId
    || !cleanPriorPhysicianUid
    || !cleanPhysicianUid
  ) {
    throw AppError.badRequest(
      'Pending-result ownership reassignment requires exact assignment, handoff, patient, and physician identifiers',
      'INPATIENT_PENDING_RESULT_TASK_REASSIGNMENT_BINDING_INVALID',
    );
  }

  const acceptedTransfer = await tx.$queryRawUnsafe(
    `SELECT assignment.id
       FROM inpatient_primary_physician_assignments AS assignment
       JOIN inpatient_primary_physician_assignments AS prior_assignment
         ON prior_assignment.tenant_id = assignment.tenant_id
        AND prior_assignment.id = assignment.supersedes_assignment_id
        AND prior_assignment.admission_id = assignment.admission_id
        AND prior_assignment.patient_uid = assignment.patient_uid
       JOIN admissions AS admission
         ON admission.tenant_id = assignment.tenant_id
        AND admission.id = assignment.admission_id
        AND admission.patient_uid = assignment.patient_uid
       JOIN care_handoff_instances AS coverage
         ON coverage.tenant_id = assignment.tenant_id
        AND coverage.id = assignment.accepted_handoff_id
        AND coverage.patient_uid = assignment.patient_uid
       JOIN care_pathway_instances AS pathway
         ON pathway.tenant_id = coverage.tenant_id
        AND pathway.id = coverage.sending_pathway_instance_id
        AND pathway.patient_uid = coverage.patient_uid
        AND pathway.workflow_run_id = coverage.sending_workflow_run_id
      WHERE assignment.tenant_id = $1::uuid
        AND assignment.id = $2::uuid
        AND assignment.admission_id = $3::integer
        AND assignment.patient_uid = $4::uuid
        AND assignment.physician_uid = $5::uuid
        AND assignment.assignment_source = 'accepted_covering_handoff'
        AND assignment.accepted_handoff_id = $6::uuid
        AND assignment.supersedes_assignment_id = $7::uuid
        AND assignment.assigned_by_uid = $8::uuid
        AND prior_assignment.physician_uid = $9::uuid
        AND admission.attending_doctor = assignment.physician_uid
        AND pathway.pathway_key = 'inpatient_admission_to_recovery'
        AND pathway.source_episode_type = 'admission'
        AND pathway.source_episode_id = assignment.admission_id::text
        AND pathway.owning_clinician_uid = assignment.physician_uid
        AND coverage.handoff_type = 'covering_clinician_reassignment'
        AND coverage.status = 'accepted'
        AND coverage.accepted_at IS NOT NULL
        AND coverage.sender_uid = prior_assignment.physician_uid
        AND coverage.recipient_kind = 'user'
        AND coverage.intended_recipient_uid = assignment.physician_uid
        AND coverage.accepted_by_uid = assignment.physician_uid
        AND coverage.receiving_pathway_instance_id = pathway.id
        AND coverage.receiving_workflow_run_id = pathway.workflow_run_id
        AND coverage.receiving_step_key = coverage.sending_step_key
        AND coverage.source_resource_type = 'care_pathway_instance'
        AND coverage.source_resource_id = pathway.id::text
      LIMIT 2
      FOR SHARE OF assignment, prior_assignment, admission, coverage, pathway`,
    tid,
    cleanAssignmentId,
    cleanAdmissionId,
    cleanPatientUid,
    cleanPhysicianUid,
    cleanAcceptedHandoffId,
    cleanPriorAssignmentId,
    cleanActorUid,
    cleanPriorPhysicianUid,
  );
  if (acceptedTransfer.length !== 1) {
    throw AppError.conflict(
      'Pending-result task ownership lacks an exact accepted inpatient covering handoff',
      'INPATIENT_PENDING_RESULT_TASK_REASSIGNMENT_BINDING_INVALID',
    );
  }

  const trackingTasks = await tx.$queryRawUnsafe(
    `SELECT handoff.id AS handoff_id,
            handoff.task_id,
            handoff.primary_physician_assignment_id,
            handoff.named_physician_uid,
            task.task_kind,
            task.patient_uid,
            task.related_resource_type,
            task.related_resource_id,
            task.assigned_to_uid,
            task.assigned_to_role,
            task.workflow_run_id,
            task.workflow_step_id,
            task.workflow_sla_instance_id,
            task.sla_completion_semantics,
            task.status
       FROM discharge_pending_result_handoffs AS handoff
       JOIN tasks AS task
         ON task.tenant_id = handoff.tenant_id
        AND task.id = handoff.task_id
      WHERE handoff.tenant_id = $1::uuid
        AND handoff.admission_id = $2::integer
        AND handoff.patient_uid = $3::uuid
        AND handoff.handoff_state IN ('pending', 'result_available')
      ORDER BY handoff.id
      FOR UPDATE OF handoff, task`,
    tid,
    cleanAdmissionId,
    cleanPatientUid,
  );
  const liveStatuses = new Set(['open', 'in_progress', 'blocked', 'overdue']);
  for (const row of trackingTasks) {
    if (
      String(row.primary_physician_assignment_id || '').toLowerCase()
        !== cleanPriorAssignmentId.toLowerCase()
      || String(row.named_physician_uid || '').toLowerCase()
        !== cleanPriorPhysicianUid.toLowerCase()
      || row.task_kind !== 'follow_up'
      || String(row.patient_uid || '').toLowerCase() !== cleanPatientUid.toLowerCase()
      || row.related_resource_type !== 'discharge_pending_result_handoff'
      || row.related_resource_id !== String(row.handoff_id)
      || String(row.assigned_to_uid || '').toLowerCase()
        !== cleanPriorPhysicianUid.toLowerCase()
      || row.assigned_to_role != null
      || row.workflow_run_id != null
      || row.workflow_step_id != null
      || row.workflow_sla_instance_id != null
      || row.sla_completion_semantics !== 'none'
      || !liveStatuses.has(row.status)
    ) {
      throw AppError.conflict(
        'A live pending-result tracking task does not match its exact handoff owner',
        'INPATIENT_PENDING_RESULT_TASK_REASSIGNMENT_BINDING_INVALID',
      );
    }
  }

  const handoffIds = trackingTasks.map((row) => String(row.handoff_id).toLowerCase());
  const actionTasks = handoffIds.length === 0
    ? []
    : await tx.$queryRawUnsafe(
      `SELECT action.handoff_id,
              action.generation_id,
              action.task_id,
              task.task_kind,
              task.patient_uid,
              task.related_resource_type,
              task.related_resource_id,
              task.parent_task_id,
              task.assigned_to_uid,
              task.assigned_to_role,
              task.workflow_run_id,
              task.workflow_step_id,
              task.workflow_sla_instance_id,
              task.sla_completion_semantics,
              task.status
         FROM discharge_pending_result_owner_actions AS action
         JOIN tasks AS task
           ON task.tenant_id = action.tenant_id
          AND task.id = action.task_id
        WHERE action.tenant_id = $1::uuid
          AND action.handoff_id = ANY($2::uuid[])
          AND NOT EXISTS (
            SELECT 1
              FROM discharge_pending_result_owner_actions AS successor
             WHERE successor.tenant_id = action.tenant_id
               AND successor.handoff_id = action.handoff_id
               AND successor.predecessor_owner_action_id = action.id
          )
        ORDER BY action.handoff_id, action.recorded_at, action.id
        FOR UPDATE OF action, task`,
      tid,
      handoffIds,
    );
  const trackingByHandoff = new Map(
    trackingTasks.map((row) => [String(row.handoff_id).toLowerCase(), row]),
  );
  for (const row of actionTasks) {
    const tracking = trackingByHandoff.get(String(row.handoff_id).toLowerCase());
    if (
      !tracking
      || row.task_kind !== 'review'
      || String(row.patient_uid || '').toLowerCase() !== cleanPatientUid.toLowerCase()
      || row.related_resource_type !== 'discharge_pending_result_action'
      || row.related_resource_id !== `${row.handoff_id}:${row.generation_id}`
      || Number(row.parent_task_id) !== Number(tracking.task_id)
      || String(row.assigned_to_uid || '').toLowerCase()
        !== cleanPriorPhysicianUid.toLowerCase()
      || row.assigned_to_role != null
      || row.workflow_run_id != null
      || row.workflow_step_id != null
      || row.workflow_sla_instance_id != null
      || row.sla_completion_semantics !== 'none'
      || !liveStatuses.has(row.status)
    ) {
      throw AppError.conflict(
        'A current pending-result owner-action task does not match its exact handoff owner',
        'INPATIENT_PENDING_RESULT_TASK_REASSIGNMENT_BINDING_INVALID',
      );
    }
  }

  const taskIds = [
    ...trackingTasks.map((row) => Number(row.task_id)),
    ...actionTasks.map((row) => Number(row.task_id)),
  ];
  for (const taskId of taskIds) {
    await reassignTask({
      tenantId: tid,
      id: taskId,
      assignedToUid: cleanPhysicianUid,
      assignedToRole: null,
      pendingResultTaskTransferAuthority: PENDING_RESULT_TASK_TRANSFER_AUTHORITY,
      tx,
    });
  }
  return Object.freeze({
    tracking_task_ids: Object.freeze(
      trackingTasks.map((row) => Number(row.task_id)),
    ),
    action_task_ids: Object.freeze(actionTasks.map((row) => Number(row.task_id))),
  });
}

async function completePendingResultTaskWithSettlementAuthority({
  tenantId,
  task,
  actorUid,
  tx,
}) {
  let current = task;
  if (current.status === 'blocked') {
    current = await transitionTask({
      tenantId,
      id: Number(current.id),
      nextStatus: 'in_progress',
      actorUid,
      pendingResultOwnerActionTaskAuthority:
        PENDING_RESULT_TASK_SETTLEMENT_AUTHORITY,
      tx,
    });
  }
  if (current.status === 'completed') return current;
  return transitionTask({
    tenantId,
    id: Number(current.id),
    nextStatus: 'completed',
    actorUid,
    pendingResultOwnerActionTaskAuthority:
      PENDING_RESULT_TASK_SETTLEMENT_AUTHORITY,
    tx,
  });
}

export async function settlePendingResultTasksFromOwnerCrossSignTx({
  tenantId = null,
  handoffId,
  generationId,
  ownerActionId,
  crossSignActionId,
  actionTaskId,
  trackingTaskId,
  patientUid,
  actorUid,
  tx = null,
} = {}) {
  requiredTaskFactoryTx(
    tx,
    'INPATIENT_PENDING_RESULT_TASK_SETTLEMENT_TX_REQUIRED',
    'Pending-result task settlement requires a transaction',
  );
  const tid = resolveTenantId({ tenantId });
  const cleanHandoffId = maybeUuid(handoffId, 'handoff_id');
  const cleanGenerationId = maybeUuid(generationId, 'generation_id');
  const cleanOwnerActionId = maybeUuid(ownerActionId, 'owner_action_id');
  const cleanCrossSignActionId = maybeUuid(crossSignActionId, 'cross_sign_action_id');
  const cleanActionTaskId = normalizeId(actionTaskId, 'action_task_id');
  const cleanTrackingTaskId = normalizeId(trackingTaskId, 'tracking_task_id');
  const cleanPatientUid = maybeUuid(patientUid, 'patient_uid');
  const cleanActorUid = requireActorUid(actorUid);
  if (
    !cleanHandoffId
    || !cleanGenerationId
    || !cleanOwnerActionId
    || !cleanCrossSignActionId
    || !cleanPatientUid
  ) {
    throw AppError.badRequest(
      'Pending-result settlement requires exact handoff, generation, owner-action, task, patient, and action identifiers',
      'INPATIENT_PENDING_RESULT_TASK_SETTLEMENT_BINDING_INVALID',
    );
  }

  const rows = await tx.$queryRawUnsafe(
    `SELECT cross_sign.id AS cross_sign_action_id,
            cross_sign.signature_id,
            cross_sign.canonical_timeline_event_id,
            cross_sign.canonical_audit_event_id,
            prior_action.id AS prior_action_id,
            prior_action.action_kind AS prior_action_kind,
            prior_action.signature_id AS prior_signature_id,
            owner_action.id AS owner_action_id,
            owner_action.owner_uid,
            owner_action.predecessor_owner_action_id,
            owner_action.predecessor_generation_id,
            owner_action.rearm_source_action_id,
            handoff.id AS handoff_id,
            handoff.admission_id,
            handoff.patient_uid,
            handoff.named_physician_uid,
            handoff.task_id AS tracking_task_id,
            handoff.handoff_state,
            handoff.resolution_action_id,
            handoff.resolved_by_uid,
            pathway.id AS pathway_instance_id,
            action_task.id AS action_task_id,
            action_task.task_kind AS action_task_kind,
            action_task.parent_task_id AS action_parent_task_id,
            action_task.patient_uid AS action_patient_uid,
            action_task.related_resource_type AS action_resource_type,
            action_task.related_resource_id AS action_resource_id,
            action_task.assigned_to_uid AS action_assigned_to_uid,
            action_task.assigned_to_role AS action_assigned_to_role,
            action_task.workflow_run_id AS action_workflow_run_id,
            action_task.workflow_step_id AS action_workflow_step_id,
            action_task.workflow_sla_instance_id AS action_sla_id,
            action_task.sla_completion_semantics AS action_sla_semantics,
            action_task.status AS action_task_status,
            tracking_task.task_kind AS tracking_task_kind,
            tracking_task.parent_task_id AS tracking_parent_task_id,
            tracking_task.patient_uid AS tracking_patient_uid,
            tracking_task.related_resource_type AS tracking_resource_type,
            tracking_task.related_resource_id AS tracking_resource_id,
            tracking_task.assigned_to_uid AS tracking_assigned_to_uid,
            tracking_task.assigned_to_role AS tracking_assigned_to_role,
            tracking_task.workflow_run_id AS tracking_workflow_run_id,
            tracking_task.workflow_step_id AS tracking_workflow_step_id,
            tracking_task.workflow_sla_instance_id AS tracking_sla_id,
            tracking_task.sla_completion_semantics AS tracking_sla_semantics,
            tracking_task.status AS tracking_task_status
       FROM diagnostic_result_actions AS cross_sign
       JOIN diagnostic_result_actions AS prior_action
         ON prior_action.tenant_id = cross_sign.tenant_id
        AND prior_action.id = cross_sign.predecessor_action_id
        AND prior_action.patient_uid = cross_sign.patient_uid
        AND prior_action.generation_id = cross_sign.generation_id
       JOIN discharge_pending_result_owner_actions AS owner_action
         ON owner_action.tenant_id = cross_sign.tenant_id
        AND owner_action.id = $4::uuid
        AND owner_action.patient_uid = cross_sign.patient_uid
        AND owner_action.generation_id = cross_sign.generation_id
        AND owner_action.task_id = cross_sign.task_id
        AND owner_action.owner_uid = cross_sign.actor_uid
       JOIN discharge_pending_result_handoffs AS handoff
         ON handoff.tenant_id = owner_action.tenant_id
        AND handoff.id = owner_action.handoff_id
        AND handoff.admission_id = owner_action.admission_id
        AND handoff.patient_uid = owner_action.patient_uid
       JOIN care_pathway_instances AS pathway
         ON pathway.tenant_id = handoff.tenant_id
        AND pathway.id = cross_sign.pathway_instance_id
        AND pathway.patient_uid = handoff.patient_uid
        AND pathway.pathway_key = 'inpatient_admission_to_recovery'
        AND pathway.source_episode_type = 'admission'
        AND pathway.source_episode_id = handoff.admission_id::text
       JOIN tasks AS action_task
         ON action_task.tenant_id = owner_action.tenant_id
        AND action_task.id = owner_action.task_id
       JOIN tasks AS tracking_task
         ON tracking_task.tenant_id = handoff.tenant_id
        AND tracking_task.id = handoff.task_id
      WHERE cross_sign.tenant_id = $1::uuid
        AND cross_sign.id = $2::uuid
        AND cross_sign.action_kind = 'discharge_owner_cross_sign'
        AND cross_sign.generation_id = $3::uuid
        AND cross_sign.patient_uid = $8::uuid
        AND cross_sign.task_id = $6::integer
        AND cross_sign.actor_uid = $9::uuid
        AND cross_sign.signature_id IS NOT NULL
        AND cross_sign.canonical_timeline_event_id IS NOT NULL
        AND cross_sign.canonical_audit_event_id IS NOT NULL
        AND cross_sign.downstream_resource_type =
              'discharge_pending_result_handoff'
        AND cross_sign.downstream_resource_id = $5::uuid::text
        AND prior_action.action_kind = 'doctor_disposition'
        AND prior_action.signature_id IS NOT NULL
        AND handoff.id = $5::uuid
        AND handoff.task_id = $7::integer
        AND handoff.named_physician_uid = $9::uuid
        AND handoff.handoff_state = 'resolved'
        AND handoff.resolution_action_id = cross_sign.id
        AND handoff.resolved_by_uid = $9::uuid
        AND NOT EXISTS (
          SELECT 1
            FROM discharge_pending_result_owner_actions AS successor
           WHERE successor.tenant_id = owner_action.tenant_id
             AND successor.handoff_id = owner_action.handoff_id
             AND successor.predecessor_owner_action_id = owner_action.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM diagnostic_result_generations AS successor_generation
           WHERE successor_generation.tenant_id = cross_sign.tenant_id
             AND successor_generation.patient_uid = cross_sign.patient_uid
             AND successor_generation.admission_id = handoff.admission_id
             AND successor_generation.predecessor_generation_id =
                   cross_sign.generation_id
        )
      LIMIT 2
      FOR UPDATE OF cross_sign, prior_action, owner_action, handoff,
                    action_task, tracking_task`,
    tid,
    cleanCrossSignActionId,
    cleanGenerationId,
    cleanOwnerActionId,
    cleanHandoffId,
    cleanActionTaskId,
    cleanTrackingTaskId,
    cleanPatientUid,
    cleanActorUid,
  );
  if (rows.length !== 1) {
    throw AppError.conflict(
      'Pending-result settlement lacks an exact current named-owner cross-sign binding',
      'INPATIENT_PENDING_RESULT_TASK_SETTLEMENT_BINDING_INVALID',
    );
  }
  const row = rows[0];
  const expectedActionResourceId = row.rearm_source_action_id != null
    ? `${cleanHandoffId}:${cleanGenerationId}:${row.predecessor_owner_action_id}`
    : `${cleanHandoffId}:${cleanGenerationId}`;
  const actionTaskIsExact = (
    row.action_task_kind === 'review'
    && Number(row.action_parent_task_id) === cleanTrackingTaskId
    && String(row.action_patient_uid || '').toLowerCase() === cleanPatientUid.toLowerCase()
    && row.action_resource_type === 'discharge_pending_result_action'
    && row.action_resource_id === expectedActionResourceId
    && String(row.action_assigned_to_uid || '').toLowerCase() === cleanActorUid
    && row.action_assigned_to_role == null
    && row.action_workflow_run_id == null
    && row.action_workflow_step_id == null
    && row.action_sla_id == null
    && row.action_sla_semantics === 'none'
  );
  const trackingTaskIsExact = (
    row.tracking_task_kind === 'follow_up'
    && row.tracking_parent_task_id == null
    && String(row.tracking_patient_uid || '').toLowerCase() === cleanPatientUid.toLowerCase()
    && row.tracking_resource_type === 'discharge_pending_result_handoff'
    && row.tracking_resource_id === cleanHandoffId
    && String(row.tracking_assigned_to_uid || '').toLowerCase() === cleanActorUid
    && row.tracking_assigned_to_role == null
    && row.tracking_workflow_run_id == null
    && row.tracking_workflow_step_id == null
    && row.tracking_sla_id == null
    && row.tracking_sla_semantics === 'none'
  );
  if (!actionTaskIsExact || !trackingTaskIsExact) {
    throw AppError.conflict(
      'Pending-result settlement tasks do not match their exact handoff, owner, and generation',
      'INPATIENT_PENDING_RESULT_TASK_SETTLEMENT_BINDING_INVALID',
    );
  }
  const liveStatuses = new Set(['open', 'in_progress', 'blocked', 'overdue']);
  const bothCompleted = row.action_task_status === 'completed'
    && row.tracking_task_status === 'completed';
  const bothLive = liveStatuses.has(row.action_task_status)
    && liveStatuses.has(row.tracking_task_status);
  if (!bothCompleted && !bothLive) {
    throw AppError.conflict(
      'Pending-result settlement tasks are not in one coherent live or completed state',
      'INPATIENT_PENDING_RESULT_TASK_SETTLEMENT_STATE_INVALID',
    );
  }
  if (bothCompleted) {
    return Object.freeze({
      action_task_id: cleanActionTaskId,
      tracking_task_id: cleanTrackingTaskId,
      replayed: true,
    });
  }
  const actionTask = await completePendingResultTaskWithSettlementAuthority({
    tenantId: tid,
    task: { id: cleanActionTaskId, status: row.action_task_status },
    actorUid: cleanActorUid,
    tx,
  });
  const trackingTask = await completePendingResultTaskWithSettlementAuthority({
    tenantId: tid,
    task: { id: cleanTrackingTaskId, status: row.tracking_task_status },
    actorUid: cleanActorUid,
    tx,
  });
  return Object.freeze({
    action_task_id: Number(actionTask.id),
    tracking_task_id: Number(trackingTask.id),
    replayed: false,
  });
}

export async function settlePendingResultTasksFromDiagnosticActionTx({
  tenantId = null,
  handoffId,
  generationId,
  ownerActionId,
  diagnosticActionId,
  actionTaskId,
  trackingTaskId,
  patientUid,
  tx = null,
} = {}) {
  requiredTaskFactoryTx(
    tx,
    'INPATIENT_PENDING_RESULT_TASK_SETTLEMENT_TX_REQUIRED',
    'Pending-result diagnostic settlement requires a transaction',
  );
  const tid = resolveTenantId({ tenantId });
  const cleanHandoffId = maybeUuid(handoffId, 'handoff_id');
  const cleanGenerationId = maybeUuid(generationId, 'generation_id');
  const cleanOwnerActionId = maybeUuid(ownerActionId, 'owner_action_id');
  const cleanDiagnosticActionId = maybeUuid(diagnosticActionId, 'diagnostic_action_id');
  const cleanActionTaskId = normalizeId(actionTaskId, 'action_task_id');
  const cleanTrackingTaskId = normalizeId(trackingTaskId, 'tracking_task_id');
  const cleanPatientUid = maybeUuid(patientUid, 'patient_uid');
  const rows = await tx.$queryRawUnsafe(
    `SELECT diagnostic_action.action_kind,
            diagnostic_action.actor_uid,
            diagnostic_action.signature_id,
            owner_action.predecessor_generation_id,
            owner_action.predecessor_owner_action_id,
            owner_action.rearm_source_action_id,
            handoff.named_physician_uid,
            handoff.resolved_by_uid,
            action_task.id AS action_task_id,
            action_task.task_kind AS action_task_kind,
            action_task.parent_task_id AS action_parent_task_id,
            action_task.patient_uid AS action_patient_uid,
            action_task.related_resource_type AS action_resource_type,
            action_task.related_resource_id AS action_resource_id,
            action_task.assigned_to_uid AS action_assigned_to_uid,
            action_task.assigned_to_role AS action_assigned_to_role,
            action_task.workflow_run_id AS action_workflow_run_id,
            action_task.workflow_step_id AS action_workflow_step_id,
            action_task.workflow_sla_instance_id AS action_sla_id,
            action_task.sla_completion_semantics AS action_sla_semantics,
            action_task.status AS action_task_status,
            tracking_task.id AS tracking_task_id,
            tracking_task.task_kind AS tracking_task_kind,
            tracking_task.parent_task_id AS tracking_parent_task_id,
            tracking_task.patient_uid AS tracking_patient_uid,
            tracking_task.related_resource_type AS tracking_resource_type,
            tracking_task.related_resource_id AS tracking_resource_id,
            tracking_task.assigned_to_uid AS tracking_assigned_to_uid,
            tracking_task.assigned_to_role AS tracking_assigned_to_role,
            tracking_task.workflow_run_id AS tracking_workflow_run_id,
            tracking_task.workflow_step_id AS tracking_workflow_step_id,
            tracking_task.workflow_sla_instance_id AS tracking_sla_id,
            tracking_task.sla_completion_semantics AS tracking_sla_semantics,
            tracking_task.status AS tracking_task_status
       FROM diagnostic_result_actions AS diagnostic_action
       JOIN discharge_pending_result_owner_actions AS owner_action
         ON owner_action.tenant_id = diagnostic_action.tenant_id
        AND owner_action.id = $4::uuid
        AND owner_action.generation_id = diagnostic_action.generation_id
        AND owner_action.patient_uid = diagnostic_action.patient_uid
       JOIN discharge_pending_result_handoffs AS handoff
         ON handoff.tenant_id = owner_action.tenant_id
        AND handoff.id = owner_action.handoff_id
        AND handoff.admission_id = owner_action.admission_id
        AND handoff.patient_uid = owner_action.patient_uid
       JOIN tasks AS action_task
         ON action_task.tenant_id = owner_action.tenant_id
        AND action_task.id = owner_action.task_id
       JOIN tasks AS tracking_task
         ON tracking_task.tenant_id = handoff.tenant_id
        AND tracking_task.id = handoff.task_id
      WHERE diagnostic_action.tenant_id = $1::uuid
        AND diagnostic_action.id = $2::uuid
        AND diagnostic_action.generation_id = $3::uuid
        AND diagnostic_action.patient_uid = $8::uuid
        AND diagnostic_action.action_kind IN (
              'doctor_disposition',
              'normal_auto_closed'
            )
        AND handoff.id = $5::uuid
        AND handoff.handoff_state = 'resolved'
        AND handoff.resolution_action_id = diagnostic_action.id
        AND handoff.task_id = $7::integer
        AND owner_action.task_id = $6::integer
        AND (
          (
            diagnostic_action.action_kind = 'doctor_disposition'
            AND diagnostic_action.signature_id IS NOT NULL
            AND diagnostic_action.actor_uid = owner_action.owner_uid
            AND diagnostic_action.actor_uid = handoff.named_physician_uid
            AND handoff.resolved_by_uid = diagnostic_action.actor_uid
          )
          OR
          (
            diagnostic_action.action_kind = 'normal_auto_closed'
            AND diagnostic_action.actor_uid IS NULL
            AND handoff.resolved_by_uid IS NULL
          )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM discharge_pending_result_owner_actions AS successor
           WHERE successor.tenant_id = owner_action.tenant_id
             AND successor.handoff_id = owner_action.handoff_id
             AND successor.predecessor_owner_action_id = owner_action.id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM diagnostic_result_generations AS successor_generation
           WHERE successor_generation.tenant_id = diagnostic_action.tenant_id
             AND successor_generation.patient_uid = diagnostic_action.patient_uid
             AND successor_generation.admission_id = handoff.admission_id
             AND successor_generation.predecessor_generation_id =
                   diagnostic_action.generation_id
        )
      LIMIT 2
      FOR UPDATE OF diagnostic_action, owner_action, handoff,
                    action_task, tracking_task`,
    tid,
    cleanDiagnosticActionId,
    cleanGenerationId,
    cleanOwnerActionId,
    cleanHandoffId,
    cleanActionTaskId,
    cleanTrackingTaskId,
    cleanPatientUid,
  );
  if (rows.length !== 1) {
    throw AppError.conflict(
      'Pending-result diagnostic settlement lacks an exact current action and owner binding',
      'INPATIENT_PENDING_RESULT_TASK_SETTLEMENT_BINDING_INVALID',
    );
  }
  const row = rows[0];
  const expectedActionResourceId = row.rearm_source_action_id
    ? `${cleanHandoffId}:${cleanGenerationId}:${row.predecessor_owner_action_id}`
    : `${cleanHandoffId}:${cleanGenerationId}`;
  const actionTaskIsExact = (
    row.action_task_kind === 'review'
    && Number(row.action_parent_task_id) === cleanTrackingTaskId
    && String(row.action_patient_uid || '').toLowerCase() === cleanPatientUid.toLowerCase()
    && row.action_resource_type === 'discharge_pending_result_action'
    && row.action_resource_id === expectedActionResourceId
    && String(row.action_assigned_to_uid || '').toLowerCase()
      === String(row.named_physician_uid || '').toLowerCase()
    && row.action_assigned_to_role == null
    && row.action_workflow_run_id == null
    && row.action_workflow_step_id == null
    && row.action_sla_id == null
    && row.action_sla_semantics === 'none'
  );
  const trackingTaskIsExact = (
    row.tracking_task_kind === 'follow_up'
    && row.tracking_parent_task_id == null
    && String(row.tracking_patient_uid || '').toLowerCase() === cleanPatientUid.toLowerCase()
    && row.tracking_resource_type === 'discharge_pending_result_handoff'
    && row.tracking_resource_id === cleanHandoffId
    && String(row.tracking_assigned_to_uid || '').toLowerCase()
      === String(row.named_physician_uid || '').toLowerCase()
    && row.tracking_assigned_to_role == null
    && row.tracking_workflow_run_id == null
    && row.tracking_workflow_step_id == null
    && row.tracking_sla_id == null
    && row.tracking_sla_semantics === 'none'
  );
  const liveStatuses = new Set(['open', 'in_progress', 'blocked', 'overdue']);
  const bothCompleted = row.action_task_status === 'completed'
    && row.tracking_task_status === 'completed';
  const bothLive = liveStatuses.has(row.action_task_status)
    && liveStatuses.has(row.tracking_task_status);
  if (!actionTaskIsExact || !trackingTaskIsExact || (!bothCompleted && !bothLive)) {
    throw AppError.conflict(
      'Pending-result diagnostic settlement tasks are not exact and coherent',
      'INPATIENT_PENDING_RESULT_TASK_SETTLEMENT_STATE_INVALID',
    );
  }
  if (bothCompleted) {
    return Object.freeze({
      action_task_id: cleanActionTaskId,
      tracking_task_id: cleanTrackingTaskId,
      replayed: true,
    });
  }
  const completionActorUid = row.action_kind === 'doctor_disposition'
    ? String(row.actor_uid)
    : undefined;
  const actionTask = await completePendingResultTaskWithSettlementAuthority({
    tenantId: tid,
    task: { id: cleanActionTaskId, status: row.action_task_status },
    actorUid: completionActorUid,
    tx,
  });
  const trackingTask = await completePendingResultTaskWithSettlementAuthority({
    tenantId: tid,
    task: { id: cleanTrackingTaskId, status: row.tracking_task_status },
    actorUid: completionActorUid,
    tx,
  });
  return Object.freeze({
    action_task_id: Number(actionTask.id),
    tracking_task_id: Number(trackingTask.id),
    replayed: false,
  });
}

/**
 * Narrow in-process bridge for corrected-result supersession. The private
 * capability never leaves this module, so generic routes and caller-supplied
 * objects cannot manufacture supersession or the blocked -> in_progress edge.
 */
export async function supersedeAcknowledgementTaskFromTrustedWorkflow({
  tenantId = null,
  id,
  relatedResourceType,
  relatedResourceId,
  workflowSlaInstanceId,
  supersededByActorUid,
  supersedingDiagnosticGenerationId,
  supersessionReason = 'diagnostic_generation_noncritical_correction',
  tx = null,
} = {}) {
  if (!tx) {
    throw AppError.internal(
      'Trusted acknowledgement supersession requires a transaction',
      'TRUSTED_TASK_SUPERSESSION_TRANSACTION_REQUIRED',
    );
  }
  const tid = resolveTenantId({ tenantId });
  const supersessionActorUid = requireActorUid(
    supersededByActorUid,
    'superseded_by_actor_uid',
  );
  const taskId = normalizeId(id, 'task id');
  const expectedResourceType = safeText(relatedResourceType, 120);
  const expectedResourceId = safeText(relatedResourceId, 255);
  const expectedSlaId = maybeUuid(workflowSlaInstanceId, 'workflow_sla_instance_id');
  const diagnosticGenerationId = supersedingDiagnosticGenerationId == null
    ? null
    : maybeUuid(
      supersedingDiagnosticGenerationId,
      'superseding_diagnostic_generation_id',
    );
  const cleanSupersessionReason = safeText(supersessionReason, 120);
  if (![
    'diagnostic_generation_noncritical_correction',
    'diagnostic_generation_superseded',
    'superseded_by_correction',
  ].includes(cleanSupersessionReason)) {
    throw AppError.badRequest(
      'Acknowledgement supersession reason is invalid',
      'ACKNOWLEDGEMENT_SUPERSESSION_INVALID',
    );
  }
  if (!expectedResourceType || !expectedResourceId || !expectedSlaId) {
    throw AppError.badRequest(
      'Trusted acknowledgement supersession requires its exact resource and SLA binding',
      'ACKNOWLEDGEMENT_SUPERSESSION_INVALID',
    );
  }

  let current = await getTaskForUpdate({ tenantId: tid, id: taskId, db: tx });
  const linkedSla = await assertTaskSlaSourceBinding({ tenantId: tid, taskRow: current, db: tx });
  if (
    current.sla_completion_semantics !== 'acknowledgement'
    || String(current.workflow_sla_instance_id || '') !== expectedSlaId
    || current.related_resource_type !== expectedResourceType
    || String(current.related_resource_id || '') !== expectedResourceId
    || linkedSla?.rule_code !== 'critical_result_ack'
  ) {
    throw AppError.conflict(
      'Task is not the expected critical-result acknowledgement obligation',
      'ACKNOWLEDGEMENT_SUPERSESSION_INVALID',
    );
  }
  if (!['open', 'overdue', 'blocked', 'in_progress'].includes(current.status)) {
    throw AppError.invalidTransition(current.status, 'completed', TASK_TRANSITIONS[current.status] || []);
  }
  const stampsCorrection = cleanSupersessionReason === 'superseded_by_correction';
  const supersededAt = diagnosticGenerationId || stampsCorrection ? new Date() : null;
  if (diagnosticGenerationId || stampsCorrection) {
    const prepared = await tx.$queryRawUnsafe(
      `UPDATE tasks
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
                'supersession_reason', $6::text,
                'superseded_at', $3::timestamptz,
                'superseded_by_actor_uid', $4::uuid,
                'superseded_by_diagnostic_generation_id', $5::uuid
              )),
              updated_at = $3::timestamptz
        WHERE tenant_id = $1::uuid
          AND id = $2::integer
        RETURNING ${TASK_RETURNING}`,
      tid,
      taskId,
      supersededAt,
      supersessionActorUid,
      diagnosticGenerationId,
      cleanSupersessionReason,
    );
    if (!prepared[0]) {
      throw AppError.conflict(
        'Acknowledgement task changed before supersession',
        'ACKNOWLEDGEMENT_SUPERSESSION_CONFLICT',
      );
    }
    current = prepared[0];
  }
  if (current.status === 'blocked') {
    current = await transitionTask({
      tenantId: tid,
      id: taskId,
      nextStatus: 'in_progress',
      acknowledgementTransitionAuthority: ACKNOWLEDGEMENT_TRANSITION_AUTHORITY,
      slaSourceBindingAuthority: TASK_SLA_SOURCE_BINDING_AUTHORITY,
      tx,
    });
  }
  const completed = await transitionTask({
    tenantId: tid,
    id: taskId,
    nextStatus: 'completed',
    actorUid: supersessionActorUid,
    // Supersession retires an obligation that was never acknowledged; the
    // trusted-workflow capability stands in for the missing receipt.
    acknowledgementTransitionAuthority: ACKNOWLEDGEMENT_TRANSITION_AUTHORITY,
    slaSourceBindingAuthority: TASK_SLA_SOURCE_BINDING_AUTHORITY,
    tx,
  });
  if (diagnosticGenerationId || stampsCorrection) {
    await tx.$executeRawUnsafe(
      `UPDATE workflow_sla_instances
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
                'supersession_reason', $6::text,
                'superseded_at', $3::timestamptz,
                'superseded_by_actor_uid', $4::uuid,
                'superseded_by_diagnostic_generation_id', $5::uuid
              )),
              updated_at = $3::timestamptz
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid`,
      tid,
      expectedSlaId,
      supersededAt,
      supersessionActorUid,
      diagnosticGenerationId,
      cleanSupersessionReason,
    );
  }
  return completed;
}

const DOMAIN_EVIDENCE_VALIDATORS = Object.freeze({
  mortuary_body_release: async ({ tenantId, taskRow, evidenceResourceType, evidenceResourceId, db }) => {
    if (evidenceResourceType !== 'body_custody_event') return null;
    const evidenceId = String(evidenceResourceId || '').trim();
    const deathRecordId = String(taskRow.related_resource_id || '').trim();
    if (
      taskRow.related_resource_type !== 'death_record'
      || !/^[1-9]\d*$/.test(evidenceId)
      || !/^[1-9]\d*$/.test(deathRecordId)
    ) {
      return null;
    }
    const rows = await db.$queryRawUnsafe(
      `SELECT custody.id, custody.event_type, custody.event_at, custody.created_at,
              (EXTRACT(EPOCH FROM custody.event_at) * 1000)::double precision AS event_at_epoch_ms,
              (EXTRACT(EPOCH FROM custody.created_at) * 1000)::double precision AS created_at_epoch_ms
         FROM body_custody_events custody
        WHERE custody.tenant_id = $1::uuid
          AND custody.id::text = $2::text
          AND custody.death_record_id::text = $3::text
          AND custody.event_type = 'release'
          AND EXISTS (
            SELECT 1
              FROM workflow_sla_instances sla
             WHERE sla.tenant_id = custody.tenant_id
               AND sla.id = $4::uuid
               AND sla.rule_code = 'mortuary_unclaimed_body'
          )
        LIMIT 1`,
      tenantId,
      evidenceId,
      deathRecordId,
      taskRow.workflow_sla_instance_id,
    );
    if (!rows[0]) return null;
    return {
      kind: 'mortuary_body_release',
      resource_type: 'body_custody_event',
      resource_id: String(rows[0].id),
      occurred_at: new Date(rows[0].event_at_epoch_ms).toISOString(),
      recorded_at: new Date(rows[0].created_at_epoch_ms).toISOString(),
    };
  },
  ward_indent_transition: async ({ tenantId, taskRow, evidenceResourceType, evidenceResourceId, db }) => {
    if (
      evidenceResourceType !== 'ward_indent_event'
      || taskRow?.metadata?.task_contract !== WARD_MEDICATION_TASK_CONTRACT
      || taskRow?.metadata?.obligation_kind === 'notification_coverage'
    ) {
      return null;
    }
    const evidenceId = String(evidenceResourceId || '').trim();
    const indentId = String(taskRow?.metadata?.ward_indent_id || '').trim();
    const stateVersion = Number(taskRow?.metadata?.state_version);
    const currentState = safeText(taskRow?.metadata?.current_state, 40);
    if (
      !/^[1-9]\d*$/.test(evidenceId)
      || !/^[1-9]\d*$/.test(indentId)
      || !Number.isSafeInteger(stateVersion)
      || stateVersion <= 0
      || !currentState
    ) {
      return null;
    }
    const rows = await db.$queryRawUnsafe(
      `SELECT event.id, event.action, event.from_status, event.to_status,
              event.state_version, event.occurred_at,
              (EXTRACT(EPOCH FROM event.occurred_at) * 1000)::double precision AS occurred_at_epoch_ms
         FROM ward_indent_events event
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = event.tenant_id
          AND sla.id = $6::uuid
        WHERE event.tenant_id = $1::uuid
          AND event.id::text = $2::text
          AND event.ward_indent_id::text = $3::text
          AND event.state_version > $4::int
          AND event.from_status = $5::text
          AND sla.rule_code = ANY($7::text[])
          AND sla.source_table = $8::text
          AND sla.source_id = $9::text
        LIMIT 1`,
      tenantId,
      evidenceId,
      indentId,
      stateVersion,
      currentState,
      taskRow.workflow_sla_instance_id,
      [...WARD_MEDICATION_SLA_RULES],
      String(taskRow.related_resource_type || ''),
      String(taskRow.related_resource_id || ''),
    );
    if (!rows[0]) return null;
    const occurredAt = new Date(rows[0].occurred_at_epoch_ms).toISOString();
    return {
      kind: 'ward_indent_transition',
      resource_type: 'ward_indent_event',
      resource_id: String(rows[0].id),
      occurred_at: occurredAt,
      recorded_at: occurredAt,
      action: rows[0].action,
      from_status: rows[0].from_status,
      to_status: rows[0].to_status,
      state_version: Number(rows[0].state_version),
    };
  },
  billing_credit_note_decision: async ({
    tenantId, taskRow, evidenceResourceType, evidenceResourceId, db,
  }) => {
    if (
      evidenceResourceType !== 'billing_credit_note_event'
      || taskRow?.metadata?.task_contract !== WARD_MEDICATION_TASK_CONTRACT
      || taskRow?.metadata?.obligation_kind !== 'credit_note_review'
    ) {
      return null;
    }
    const evidenceId = String(evidenceResourceId || '').trim();
    const creditNoteId = String(taskRow?.metadata?.credit_note_id || '').trim();
    if (!/^[1-9]\d*$/.test(evidenceId) || !/^[1-9]\d*$/.test(creditNoteId)) return null;
    const rows = await db.$queryRawUnsafe(
      `SELECT event.id, event.credit_note_id, event.event_type, event.occurred_at,
              (EXTRACT(EPOCH FROM event.occurred_at) * 1000)::double precision AS occurred_at_epoch_ms
         FROM billing_credit_note_events event
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = event.tenant_id
          AND sla.id = $4::uuid
        WHERE event.tenant_id = $1::uuid
          AND event.id::text = $2::text
          AND event.credit_note_id::text = $3::text
          AND event.event_type IN ('approved', 'rejected')
          AND sla.rule_code = 'ward_indent_credit_note_review'
          AND sla.source_table = $5::text
          AND sla.source_id = $6::text
        LIMIT 1`,
      tenantId,
      evidenceId,
      creditNoteId,
      taskRow.workflow_sla_instance_id,
      String(taskRow.related_resource_type || ''),
      String(taskRow.related_resource_id || ''),
    );
    if (!rows[0]) return null;
    const occurredAt = new Date(rows[0].occurred_at_epoch_ms).toISOString();
    return {
      kind: 'billing_credit_note_decision',
      resource_type: 'billing_credit_note_event',
      resource_id: String(rows[0].id),
      occurred_at: occurredAt,
      recorded_at: occurredAt,
      credit_note_id: String(rows[0].credit_note_id),
      decision: rows[0].event_type,
    };
  },
  billing_credit_note_application: async ({
    tenantId, taskRow, evidenceResourceType, evidenceResourceId, db,
  }) => {
    if (
      evidenceResourceType !== 'billing_credit_note_event'
      || taskRow?.metadata?.task_contract !== WARD_MEDICATION_TASK_CONTRACT
      || taskRow?.metadata?.obligation_kind !== 'credit_note_review'
    ) {
      return null;
    }
    const evidenceId = String(evidenceResourceId || '').trim();
    const creditNoteId = String(taskRow?.metadata?.credit_note_id || '').trim();
    if (!/^[1-9]\d*$/.test(evidenceId) || !/^[1-9]\d*$/.test(creditNoteId)) return null;
    const rows = await db.$queryRawUnsafe(
      `SELECT event.id, event.credit_note_id, event.occurred_at,
              (EXTRACT(EPOCH FROM event.occurred_at) * 1000)::double precision AS occurred_at_epoch_ms
         FROM billing_credit_note_events event
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = event.tenant_id
          AND sla.id = $4::uuid
        WHERE event.tenant_id = $1::uuid
          AND event.id::text = $2::text
          AND event.credit_note_id::text = $3::text
          AND event.event_type = 'applied'
          AND sla.rule_code = 'ward_indent_credit_note_review'
          AND sla.source_table = $5::text
          AND sla.source_id = $6::text
        LIMIT 1`,
      tenantId,
      evidenceId,
      creditNoteId,
      taskRow.workflow_sla_instance_id,
      String(taskRow.related_resource_type || ''),
      String(taskRow.related_resource_id || ''),
    );
    if (!rows[0]) return null;
    const occurredAt = new Date(rows[0].occurred_at_epoch_ms).toISOString();
    return {
      kind: 'billing_credit_note_application',
      resource_type: 'billing_credit_note_event',
      resource_id: String(rows[0].id),
      occurred_at: occurredAt,
      recorded_at: occurredAt,
      credit_note_id: String(rows[0].credit_note_id),
      event_type: 'applied',
    };
  },
  billing_credit_note_refund_paid: async ({
    tenantId, taskRow, evidenceResourceType, evidenceResourceId, db,
  }) => {
    if (
      evidenceResourceType !== 'billing_refund'
      || taskRow?.metadata?.task_contract !== WARD_MEDICATION_TASK_CONTRACT
      || taskRow?.metadata?.obligation_kind !== 'credit_note_review'
    ) {
      return null;
    }
    const refundId = String(evidenceResourceId || '').trim();
    const creditNoteId = String(taskRow?.metadata?.credit_note_id || '').trim();
    if (
      !/^[1-9]\d*$/.test(refundId)
      || !/^[1-9]\d*$/.test(creditNoteId)
      || String(taskRow?.metadata?.refund_id || '') !== refundId
    ) {
      return null;
    }
    const rows = await db.$queryRawUnsafe(
      `SELECT refund.id, refund.paid_at, refund.payout_rail,
              COALESCE(refund.paid_by, execution.initiated_by) AS completion_actor,
              (EXTRACT(EPOCH FROM refund.paid_at) * 1000)::double precision AS paid_at_epoch_ms
         FROM billing_refunds refund
         JOIN billing_credit_notes note
           ON note.tenant_id = refund.tenant_id
          AND note.refund_id = refund.id
          AND note.id::text = $3::text
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = refund.tenant_id
          AND sla.id = $4::uuid
         LEFT JOIN payment_gateway_refunds execution
           ON execution.tenant_id = refund.tenant_id
          AND execution.id = refund.gateway_refund_id
          AND execution.billing_refund_id = refund.id
        WHERE refund.tenant_id = $1::uuid
          AND refund.id::text = $2::text
          AND refund.approval_status = 'PAID'
          AND refund.paid_at IS NOT NULL
          AND COALESCE(refund.paid_by, execution.initiated_by) IS NOT NULL
          AND sla.rule_code = 'ward_indent_credit_note_review'
          AND sla.source_table = $5::text
          AND sla.source_id = $6::text
        LIMIT 1`,
      tenantId,
      refundId,
      creditNoteId,
      taskRow.workflow_sla_instance_id,
      String(taskRow.related_resource_type || ''),
      String(taskRow.related_resource_id || ''),
    );
    if (!rows[0]) return null;
    const paidAt = new Date(rows[0].paid_at_epoch_ms).toISOString();
    return {
      kind: 'billing_credit_note_refund_paid',
      resource_type: 'billing_refund',
      resource_id: String(rows[0].id),
      occurred_at: paidAt,
      recorded_at: paidAt,
      credit_note_id: creditNoteId,
      payout_rail: rows[0].payout_rail,
      completion_actor: String(rows[0].completion_actor),
    };
  },
  mar_supply_reconciled: async ({
    tenantId, taskRow, evidenceResourceType, evidenceResourceId, db,
  }) => {
    if (
      evidenceResourceType !== 'mar_supply_reconciliation_link'
      || taskRow?.metadata?.task_contract !== WARD_MEDICATION_TASK_CONTRACT
      || taskRow?.metadata?.obligation_kind !== 'mar_supply_reconciliation'
    ) {
      return null;
    }
    const evidenceId = String(evidenceResourceId || '').trim();
    const medicationAdministrationId = String(
      taskRow?.metadata?.medication_administration_id || '',
    ).trim();
    if (
      !/^[1-9]\d*$/.test(evidenceId)
      || !/^[1-9]\d*$/.test(medicationAdministrationId)
    ) {
      return null;
    }
    const rows = await db.$queryRawUnsafe(
      `SELECT link.id, link.unmatched_consumption_id, link.created_at,
              consumption.medication_administration_id,
              (EXTRACT(EPOCH FROM link.created_at) * 1000)::double precision
                AS created_at_epoch_ms
         FROM mar_supply_reconciliation_links link
         JOIN mar_supply_consumptions consumption
           ON consumption.tenant_id = link.tenant_id
          AND consumption.id = link.unmatched_consumption_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = link.tenant_id
          AND sla.id = $5::uuid
        WHERE link.tenant_id = $1::uuid
          AND link.id::text = $2::text
          AND consumption.medication_administration_id::text = $3::text
          AND consumption.evidence_status = 'unmatched_override'
          AND consumption.reconciliation_task_id = $4::int
          AND sla.rule_code = 'ward_indent_mar_supply_reconciliation'
          AND sla.source_table = $6::text
          AND sla.source_id = $7::text
          AND (
            SELECT COALESCE(SUM(all_links.quantity), 0)
              FROM mar_supply_reconciliation_links all_links
             WHERE all_links.tenant_id = consumption.tenant_id
               AND all_links.unmatched_consumption_id = consumption.id
          ) = consumption.quantity
        LIMIT 1`,
      tenantId,
      evidenceId,
      medicationAdministrationId,
      Number(taskRow.id),
      taskRow.workflow_sla_instance_id,
      String(taskRow.related_resource_type || ''),
      String(taskRow.related_resource_id || ''),
    );
    if (!rows[0]) return null;
    const occurredAt = new Date(rows[0].created_at_epoch_ms).toISOString();
    return {
      kind: 'mar_supply_reconciled',
      resource_type: 'mar_supply_reconciliation_link',
      resource_id: String(rows[0].id),
      occurred_at: occurredAt,
      recorded_at: occurredAt,
      unmatched_consumption_id: String(rows[0].unmatched_consumption_id),
      medication_administration_id: String(rows[0].medication_administration_id),
    };
  },
  mar_medication_exception_resolution: async ({
    tenantId,
    taskRow,
    evidenceResourceType,
    evidenceResourceId,
    actorUid,
    db,
  }) => {
    if (
      evidenceResourceType !== 'mar_medication_exception_event'
      || taskRow?.metadata?.task_contract !== MAR_MEDICATION_EXCEPTION_TASK_CONTRACT
      || taskRow?.related_resource_type !== 'mar_medication_exception_cases'
    ) {
      return null;
    }
    const evidenceId = String(evidenceResourceId || '').trim();
    const caseId = String(taskRow?.metadata?.exception_case_id || '').trim();
    const medicationAdministrationId = String(
      taskRow?.metadata?.medication_administration_id || '',
    ).trim();
    if (
      !/^[1-9]\d*$/.test(evidenceId)
      || !/^[1-9]\d*$/.test(caseId)
      || !/^[1-9]\d*$/.test(medicationAdministrationId)
      || String(taskRow.related_resource_id || '') !== caseId
      || !actorUid
    ) {
      return null;
    }
    const rows = await db.$queryRawUnsafe(
      `SELECT event.id,
              event.disposition,
              event.occurred_at,
              event.actor_uid::text,
              (EXTRACT(EPOCH FROM event.occurred_at) * 1000)::double precision
                AS occurred_at_epoch_ms
         FROM mar_medication_exception_events event
         JOIN mar_medication_exception_cases exception_case
           ON exception_case.tenant_id = event.tenant_id
          AND exception_case.id = event.exception_case_id
         JOIN medication_administrations administration
           ON administration.tenant_id = exception_case.tenant_id
          AND administration.id = exception_case.medication_administration_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = exception_case.tenant_id
          AND sla.id = exception_case.workflow_sla_instance_id
        WHERE event.tenant_id = $1::uuid
          AND event.id::text = $2::text
          AND event.exception_case_id::text = $3::text
          AND event.medication_administration_id::text = $4::text
          AND event.event_type = 'resolved'
          AND event.actor_uid = $5::uuid
          AND exception_case.task_id = $6::integer
          AND exception_case.exception_kind = $7::text
          AND sla.rule_code = $8::text
          AND sla.source_table = $9::text
          AND sla.source_id = $10::text
           AND (
             (exception_case.exception_kind = 'held'
              AND event.disposition IN ('hold_released', 'order_stopped'))
            OR
            (exception_case.exception_kind = 'missed'
             AND event.disposition IN (
               'reviewed_no_replacement',
               'replacement_ordered',
               'order_stopped'
             ))
           )
           AND (
             event.disposition <> 'hold_released'
             OR LOWER(administration.status) = 'scheduled'
           )
          AND (
            event.disposition <> 'replacement_ordered'
            OR EXISTS (
              SELECT 1
                FROM clinical_orders replacement_order
               WHERE replacement_order.tenant_id = event.tenant_id
                 AND replacement_order.id = event.replacement_clinical_order_id
                 AND replacement_order.id IS DISTINCT FROM exception_case.clinical_order_id
                 AND replacement_order.patient_uid = exception_case.patient_uid
                 AND replacement_order.order_type = 'medication'
                 AND LOWER(replacement_order.status) IN ('ordered', 'verified', 'in_progress')
                 AND replacement_order.created_at >= exception_case.raised_at
            )
          )
          AND (
            event.disposition <> 'order_stopped'
            OR EXISTS (
              SELECT 1
                FROM clinical_orders stopped_order
               WHERE stopped_order.tenant_id = exception_case.tenant_id
                 AND stopped_order.id = exception_case.clinical_order_id
                 AND LOWER(stopped_order.status) NOT IN ('ordered', 'verified', 'in_progress')
            )
          )
        LIMIT 1`,
      tenantId,
      evidenceId,
      caseId,
      medicationAdministrationId,
      actorUid,
      Number(taskRow.id),
      String(taskRow?.metadata?.exception_kind || ''),
      MAR_MEDICATION_EXCEPTION_SLA_RULE,
      String(taskRow.related_resource_type || ''),
      String(taskRow.related_resource_id || ''),
    );
    if (!rows[0]) return null;
    const occurredAt = new Date(rows[0].occurred_at_epoch_ms).toISOString();
    return {
      kind: 'mar_medication_exception_resolution',
      resource_type: 'mar_medication_exception_event',
      resource_id: String(rows[0].id),
      occurred_at: occurredAt,
      recorded_at: occurredAt,
      disposition: rows[0].disposition,
      actor_uid: String(rows[0].actor_uid),
    };
  },
  cath_consumable_inventory_reconciled: async ({
    tenantId, taskRow, evidenceResourceType, evidenceResourceId, actorUid, db,
  }) => {
    if (
      evidenceResourceType !== 'pharmacy_stock_movement'
      || taskRow?.metadata?.task_contract !== CATH_INVENTORY_SHORTFALL_TASK_CONTRACT
      || taskRow?.related_resource_type !== 'cath_case_consumable_usage'
      || !actorUid
    ) {
      return null;
    }
    const evidenceId = String(evidenceResourceId || '').trim();
    const usageId = String(taskRow?.metadata?.cath_consumable_usage_id || '').trim();
    if (
      !/^[1-9]\d*$/.test(evidenceId)
      || !/^[1-9]\d*$/.test(usageId)
      || String(taskRow.related_resource_id || '') !== usageId
    ) {
      return null;
    }
    const rows = await db.$queryRawUnsafe(
      `SELECT usage.id,
              usage.quantity::numeric(14,4)::text AS documented_quantity,
              evidence.id AS evidence_id,
              to_char(
                evidence.created_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ) AS evidence_created_at
         FROM cath_case_consumable_usage usage
         JOIN cath_lab_cases cath_case
           ON cath_case.tenant_id = usage.tenant_id
          AND cath_case.id = usage.case_id
          AND cath_case.patient_uid = usage.patient_uid
         JOIN cath_consumable_catalog catalog
           ON catalog.tenant_id = usage.tenant_id
          AND catalog.id = usage.catalog_item_id
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = usage.tenant_id
          AND sla.id = $4::uuid
          AND sla.rule_code = $5::text
          AND sla.source_table = 'cath_case_consumable_usage'
          AND sla.source_id = usage.id::text
         JOIN pharmacy_stock_movements evidence
           ON evidence.tenant_id = usage.tenant_id
          AND evidence.id::text = $2::text
          AND evidence.id = usage.inventory_movement_id
          AND evidence.reference_type = 'cath_consumable_reconciliation'
          AND evidence.metadata->>'cath_consumable_usage_id' = usage.id::text
          AND evidence.performed_by = $6::uuid
        WHERE usage.tenant_id = $1::uuid
          AND usage.id::text = $3::text
          AND usage.inventory_decrement_status = 'decremented'
          AND catalog.inventory_item_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
              FROM pharmacy_stock_movements invalid
             WHERE invalid.tenant_id = usage.tenant_id
               AND (
                 (invalid.reference_type = 'cath_consumable_usage'
                  AND invalid.reference_id = usage.id::text)
                 OR
                 (invalid.reference_type = 'cath_consumable_reconciliation'
                  AND invalid.metadata->>'cath_consumable_usage_id' = usage.id::text)
               )
               AND (
                 invalid.inventory_item_id IS DISTINCT FROM catalog.inventory_item_id
                 OR invalid.quantity_delta >= 0
                 OR invalid.movement_kind IS DISTINCT FROM
                      CASE WHEN usage.wasted THEN 'dispose' ELSE 'issue' END
                 OR (
                   usage.inventory_batch_id IS NOT NULL
                   AND invalid.inventory_batch_id IS DISTINCT FROM usage.inventory_batch_id
                 )
                 OR (
                   invalid.reference_type = 'cath_consumable_reconciliation'
                   AND (
                     invalid.reference_id !~ '^[0-9a-f]{64}$'
                     OR invalid.metadata->>'command_contract'
                          IS DISTINCT FROM 'cath_inventory_reconciliation_v1'
                     OR invalid.metadata->>'command_key_sha256'
                          IS DISTINCT FROM invalid.reference_id
                     OR invalid.metadata->>'request_fingerprint' !~ '^[0-9a-f]{64}$'
                     OR invalid.metadata->>'http_idempotency_claim_id' !~ '^[1-9][0-9]*$'
                     OR invalid.metadata->>'source_reference_type'
                          IS DISTINCT FROM 'cath_case_consumable_usage'
                     OR invalid.metadata->>'source_reference_id'
                          IS DISTINCT FROM usage.id::text
                   )
                 )
               )
          )
          AND (
            SELECT COALESCE(SUM(-movement.quantity_delta), 0::numeric)
              FROM pharmacy_stock_movements movement
             WHERE movement.tenant_id = usage.tenant_id
               AND (
                 (movement.reference_type = 'cath_consumable_usage'
                  AND movement.reference_id = usage.id::text)
                 OR
                 (movement.reference_type = 'cath_consumable_reconciliation'
                  AND movement.metadata->>'cath_consumable_usage_id' = usage.id::text)
               )
          ) = usage.quantity
        LIMIT 1`,
      tenantId,
      evidenceId,
      usageId,
      taskRow.workflow_sla_instance_id,
      CATH_INVENTORY_SHORTFALL_SLA_RULE,
      actorUid,
    );
    if (!rows[0]) return null;
    const recordedAt = rows[0].evidence_created_at;
    return {
      kind: 'cath_consumable_inventory_reconciled',
      resource_type: 'pharmacy_stock_movement',
      resource_id: String(rows[0].evidence_id),
      occurred_at: recordedAt,
      recorded_at: recordedAt,
      cath_consumable_usage_id: String(rows[0].id),
      documented_quantity: rows[0].documented_quantity,
      decremented_quantity: rows[0].documented_quantity,
      actor_uid: String(actorUid),
    };
  },
  notification_coverage_restored: async ({
    tenantId, taskRow, evidenceResourceType, evidenceResourceId, db,
  }) => {
    if (
      evidenceResourceType !== 'notification_outbox'
      || taskRow?.metadata?.task_contract !== WARD_MEDICATION_TASK_CONTRACT
      || taskRow?.metadata?.obligation_kind !== 'notification_coverage'
    ) {
      return null;
    }
    const evidenceId = String(evidenceResourceId || '').trim();
    if (!/^[1-9]\d*$/.test(evidenceId)) return null;
    const rows = await db.$queryRawUnsafe(
      `SELECT outbox.id, outbox.created_at, outbox.recipient_id,
              (EXTRACT(EPOCH FROM outbox.created_at) * 1000)::double precision AS created_at_epoch_ms
         FROM notification_outbox outbox
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = outbox.tenant_id
          AND sla.id = $3::uuid
        WHERE outbox.tenant_id = $1::uuid
          AND outbox.id::text = $2::text
          AND outbox.recipient_id IS NOT NULL
          AND outbox.payload->>'coverage_task_id' = $4::text
          AND sla.rule_code = 'ward_indent_notification_coverage'
          AND sla.source_table = $5::text
          AND sla.source_id = $6::text
        LIMIT 1`,
      tenantId,
      evidenceId,
      taskRow.workflow_sla_instance_id,
      String(taskRow.id),
      String(taskRow.related_resource_type || ''),
      String(taskRow.related_resource_id || ''),
    );
    if (!rows[0]) return null;
    const occurredAt = new Date(rows[0].created_at_epoch_ms).toISOString();
    return {
      kind: 'notification_coverage_restored',
      resource_type: 'notification_outbox',
      resource_id: String(rows[0].id),
      occurred_at: occurredAt,
      recorded_at: occurredAt,
      recipient_id: String(rows[0].recipient_id),
    };
  },
  payment_gateway_refund_provider_status: async ({
    tenantId, taskRow, evidenceResourceType, evidenceResourceId, db,
  }) => {
    const refundId = String(evidenceResourceId || '').trim();
    if (evidenceResourceType !== 'payment_gateway_refunds'
        || taskRow.related_resource_type !== 'payment_gateway_refunds'
        || String(taskRow.related_resource_id || '') !== refundId
        || !/^[1-9]\d*$/.test(refundId)) return null;
    const rows = await db.$queryRawUnsafe(
      `SELECT status, provider_refund_id,
              EXTRACT(EPOCH FROM COALESCE(
                provider_status_checked_at, processed_at, failed_at, updated_at
              )) * 1000 AS recorded_at_epoch_ms
         FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid AND id::text = $2::text
          AND status IN ('processed', 'failed')
        LIMIT 1`,
      tenantId,
      refundId,
    );
    if (!rows[0]) return null;
    return {
      kind: 'payment_gateway_refund_provider_status',
      resource_type: 'payment_gateway_refunds',
      resource_id: refundId,
      provider_status: rows[0].status,
      provider_refund_id: rows[0].provider_refund_id,
      recorded_at: new Date(Number(rows[0].recorded_at_epoch_ms)).toISOString(),
    };
  },
  payment_gateway_refund_operator_reconciliation: async ({
    tenantId, taskRow, evidenceResourceType, evidenceResourceId, db,
  }) => {
    const refundId = String(evidenceResourceId || '').trim();
    if (evidenceResourceType !== 'payment_gateway_refunds'
        || taskRow.related_resource_type !== 'payment_gateway_refunds'
        || String(taskRow.related_resource_id || '') !== refundId
        || !/^[1-9]\d*$/.test(refundId)) return null;
    const rows = await db.$queryRawUnsafe(
      `SELECT refund.reconciliation_disposition, refund.reconciliation_evidence,
              refund.reconciled_by,
              EXTRACT(EPOCH FROM refund.reconciled_at) * 1000 AS recorded_at_epoch_ms
         FROM payment_gateway_refunds refund
         LEFT JOIN billing_refunds billing
           ON billing.tenant_id = refund.tenant_id
          AND billing.id = refund.billing_refund_id
        WHERE refund.tenant_id = $1::uuid AND refund.id::text = $2::text
          AND refund.reconciled_at IS NOT NULL
          AND refund.reconciliation_disposition = 'provider_failed'
          AND refund.provider_refund_id IS NOT NULL
          AND length(btrim(refund.provider_refund_id)) BETWEEN 1 AND 120
          AND (
            (refund.provider = 'razorpay'
             AND refund.provider_refund_id ~ '^rfnd_[A-Za-z0-9]+$')
            OR
            (refund.provider <> 'razorpay'
             AND refund.provider_refund_id !~* '(\\*{2,}|masked|redacted)')
          )
          AND refund.reconciliation_reviewed_by = refund.reconciled_by
          AND refund.status = 'failed'
          AND refund.reconciled_by IS DISTINCT FROM refund.initiated_by
          AND refund.reconciled_by IS DISTINCT FROM billing.raised_by
          AND refund.reconciled_by IS DISTINCT FROM billing.approved_by
        LIMIT 1`,
      tenantId,
      refundId,
    );
    if (!rows[0]) return null;
    return {
      kind: 'payment_gateway_refund_operator_reconciliation',
      resource_type: 'payment_gateway_refunds',
      resource_id: refundId,
      disposition: rows[0].reconciliation_disposition,
      evidence: rows[0].reconciliation_evidence,
      reviewed_by: String(rows[0].reconciled_by),
      recorded_at: new Date(Number(rows[0].recorded_at_epoch_ms)).toISOString(),
    };
  },
});

export async function completeTaskFromDomainEvidence({
  tenantId = null,
  id,
  evidenceKind,
  evidenceResourceType,
  evidenceResourceId,
  actorUid = null,
  executorAuthority = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  if (!tx) {
    return setTenantTx(tid, (scopedTx) => completeTaskFromDomainEvidence({
      tenantId: tid,
      id: taskId,
      evidenceKind,
      evidenceResourceType,
      evidenceResourceId,
      actorUid,
      executorAuthority,
      tx: scopedTx,
    }));
  }

  let current = await getTaskForUpdate({ tenantId: tid, id: taskId, db: tx });
  const attachedRunId = await taskRowWorkflowRunId({ tenantId: tid, taskRow: current, db: tx });
  await assertPathwayExecutorAuthority({
    tenantId: tid,
    workflowRunId: attachedRunId,
    db: tx,
    executorAuthority,
  });
  await assertTaskSlaSourceBinding({ tenantId: tid, taskRow: current, db: tx });
  if (
    current.sla_completion_semantics !== 'domain_evidence'
    || !current.workflow_sla_instance_id
  ) {
    throw AppError.conflict(
      'Task is not registered for domain-evidence SLA completion',
      'DOMAIN_EVIDENCE_COMPLETION_NOT_ALLOWED',
    );
  }

  const cleanEvidenceKind = safeText(evidenceKind, 120);
  const validator = DOMAIN_EVIDENCE_VALIDATORS[cleanEvidenceKind];
  if (!validator) {
    throw AppError.badRequest('Unregistered domain evidence kind', 'DOMAIN_EVIDENCE_KIND_UNREGISTERED');
  }
  const evidence = await validator({
    tenantId: tid,
    taskRow: current,
    evidenceResourceType: safeText(evidenceResourceType, 120),
    evidenceResourceId,
    actorUid,
    db: tx,
  });
  if (!evidence) {
    throw AppError.conflict('Registered domain evidence was not found', 'DOMAIN_EVIDENCE_NOT_FOUND');
  }

  const wasCompleted = current.status === 'completed';
  if (current.status === 'cancelled') {
    throw AppError.invalidTransition('cancelled', 'completed', TASK_TRANSITIONS.cancelled);
  }
  if (!wasCompleted) {
    if (current.status === 'blocked') {
      current = await transitionTask({
        tenantId: tid,
        id: taskId,
        nextStatus: 'in_progress',
        executorAuthority,
        domainEvidenceAuthority: DOMAIN_EVIDENCE_COMPLETION_AUTHORITY,
        slaSourceBindingAuthority: TASK_SLA_SOURCE_BINDING_AUTHORITY,
        tx,
      });
    }
    current = await transitionTask({
      tenantId: tid,
      id: taskId,
      nextStatus: 'completed',
      ...(actorUid ? { actorUid } : {}),
      executorAuthority,
      domainEvidenceAuthority: DOMAIN_EVIDENCE_COMPLETION_AUTHORITY,
      slaSourceBindingAuthority: TASK_SLA_SOURCE_BINDING_AUTHORITY,
      tx,
    });
    if (isMarMedicationExceptionContractBoundTask(current)) {
      const stamped = await tx.$queryRawUnsafe(
        `UPDATE tasks
            SET completed_at = $3::timestamptz,
                updated_at = $3::timestamptz
          WHERE tenant_id = $1::uuid
            AND id = $2::integer
            AND status = 'completed'
          RETURNING ${TASK_RETURNING}`,
        tid,
        taskId,
        evidence.recorded_at,
      );
      if (!stamped[0]) {
        throw AppError.conflict(
          'MAR medication exception task completion timestamp changed concurrently',
          'MAR_EXCEPTION_TASK_COMPLETION_CONFLICT',
        );
      }
      current = stamped[0];
    }
    if (isCathInventoryShortfallContractBoundTask(current)) {
      const stamped = await tx.$queryRawUnsafe(
        `UPDATE tasks
            SET completed_at = $3::timestamptz,
                updated_at = $3::timestamptz
          WHERE tenant_id = $1::uuid
            AND id = $2::integer
            AND status = 'completed'
          RETURNING ${TASK_RETURNING}`,
        tid,
        taskId,
        evidence.recorded_at,
      );
      if (!stamped[0]) {
        throw AppError.conflict(
          'Cath inventory shortfall task completion timestamp changed concurrently',
          'CATH_INVENTORY_SHORTFALL_TASK_COMPLETION_CONFLICT',
        );
      }
      current = stamped[0];
    }
  }

  const completedSla = await completeLinkedSla({
    tenantId: tid,
    taskRow: current,
    db: tx,
    completedBy: actorUid,
    completionTrigger: 'domain_evidence',
    completedAt: evidence.recorded_at,
    evidence,
    strict: true,
  });
  if (!completedSla) {
    const existing = await tx.$queryRawUnsafe(
      `SELECT id, completed_at, metadata
         FROM workflow_sla_instances
        WHERE id = $1::uuid
          AND tenant_id = $2::uuid
        LIMIT 1`,
      current.workflow_sla_instance_id,
      tid,
    );
    if (!existing[0]?.completed_at) {
      throw AppError.conflict('SLA completion changed concurrently', 'SLA_COMPLETION_CONFLICT');
    }
    const storedEvidence = existing[0].metadata?.completion_evidence;
    const evidenceMatches = (
      existing[0].metadata?.completed_via === 'domain_evidence'
      && storedEvidence?.kind === evidence.kind
      && storedEvidence?.resource_type === evidence.resource_type
      && String(storedEvidence?.resource_id || '') === evidence.resource_id
    );
    if (!evidenceMatches) {
      throw AppError.conflict(
        'Existing SLA completion is not backed by the registered domain evidence',
        'SLA_DOMAIN_EVIDENCE_MISMATCH',
      );
    }
  }

  if (!wasCompleted) {
    await postTaskComment({
      tenantId: tid,
      taskId,
      authorUid: actorUid,
      body: `Task completed from registered domain evidence ${evidence.kind}:${evidence.resource_id}`,
      bodyKind: 'state_change',
      metadata: { to: 'completed', completion_via: 'domain_evidence', evidence },
      tx,
    });
  }
  return current;
}

export async function completePathwayTaskFromRegisteredEvidence({
  tenantId = null,
  pathwayInstanceId,
  id,
  workflowRunId,
  workflowStepId,
  conditionHandler,
  evidence = {},
  actor = null,
  signal = null,
  executorAuthority = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  if (!await hasPathwayExecutorAuthority(executorAuthority)) {
    throw AppError.conflict(
      'Pathway-bound workflow mutations must use the pathway executor',
      'PATHWAY_EXECUTOR_REQUIRED',
    );
  }
  const taskId = normalizeStrictPositiveId(id, 'task id');
  const runId = normalizeStrictPositiveId(workflowRunId, 'workflow_run_id');
  const stepId = normalizeStrictPositiveId(workflowStepId, 'workflow_step_id');
  const cleanPathwayInstanceId = maybeUuid(pathwayInstanceId, 'pathway_instance_id');
  if (!cleanPathwayInstanceId) {
    throw AppError.badRequest(
      'pathway_instance_id is required',
      'PATHWAY_TASK_CONTEXT_INVALID',
    );
  }
  const { isTenantTransactionClient } = await import('../../lib/prisma.js');
  if (!tx || !isTenantTransactionClient(tx)) {
    throw AppError.conflict(
      'Pathway evidence completion requires a branded tenant transaction',
      'PATHWAY_RUNTIME_TX_REQUIRED',
    );
  }
  const cleanHandler = requireCanonicalHandlerId(conditionHandler);
  const payload = cloneBudgetedWorkflowJson(
    normalizeJsonObject(evidence, 'evidence'),
    'evidence',
    'PATHWAY_HANDLER_CONTRACT_INVALID',
  );
  const provenance = await normalizePathwayEvidenceProvenance(actor, signal);
  const cleanActorUid = provenance.actor_kind === 'user' ? provenance.actor_uid : null;
  const normalizedEvidence = Object.freeze(cloneBudgetedWorkflowJson({
    kind: 'pathway_registered_condition',
    handler_id: cleanHandler,
    decision: 'satisfied',
    resource_type: 'workflow_steps',
    resource_id: String(stepId),
    payload,
    provenance,
  }, 'normalized_evidence', 'PATHWAY_HANDLER_CONTRACT_INVALID'));

  // Resolve without taking a row lock, then acquire the complete runtime using
  // the executor's single global lock order (instance, run, children, steps,
  // tasks, approvals, handoffs, SLAs). Locking the task first here would
  // deadlock against an executor transaction that already owns the instance.
  const pathwayRows = await tx.$queryRawUnsafe(
    `SELECT id
      FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND workflow_run_id = $2::bigint
        AND id = $3::uuid
      LIMIT 1`,
    tid,
    runId,
    cleanPathwayInstanceId,
  );
  if (!pathwayRows[0]?.id) {
    throw AppError.conflict(
      'Pathway task run and step context is not registered',
      'PATHWAY_TASK_CONTEXT_MISMATCH',
    );
  }
  const { lockPathwayRuntimeTx } = await import('../pathways/pathwayRuntimePersistence.js');
  const runtime = await lockPathwayRuntimeTx({
    tx,
    tenantId: tid,
    pathwayInstanceId: pathwayRows[0].id,
  });
  const current = runtime.tasks.find((task) => Number(task.id) === taskId);
  const step = runtime.steps.find((candidate) => Number(candidate.id) === stepId);
  if (
    Number(runtime.run?.id) !== runId
    || !step
    || Number(step.workflow_run_id) !== runId
    || !current
    || Number(current.workflow_run_id) !== runId
    || Number(current.workflow_step_id) !== stepId
  ) {
    throw AppError.conflict(
      'Pathway task does not belong to the supplied run and step',
      'PATHWAY_TASK_CONTEXT_MISMATCH',
    );
  }
  let pinnedSteps = runtime.definition?.steps;
  if (typeof pinnedSteps === 'string') {
    try {
      pinnedSteps = JSON.parse(pinnedSteps);
    } catch {
      pinnedSteps = null;
    }
  }
  const pinnedStep = Array.isArray(pinnedSteps)
    ? pinnedSteps.find((candidate) => candidate?.step_key === step.step_key)
    : null;
  const pinnedHandler = safeText(pinnedStep?.condition_handler, 120);
  if (!pinnedStep || !pinnedHandler || pinnedHandler !== cleanHandler) {
    throw AppError.conflict(
      'Pathway evidence handler does not match the pinned governed step',
      'PATHWAY_HANDLER_CONTRACT_INVALID',
    );
  }
  let taskState = current;
  const linkedSla = await assertTaskSlaSourceBinding({
    tenantId: tid,
    taskRow: taskState,
    db: tx,
  });
  if (
    taskState.sla_completion_semantics !== 'domain_evidence'
    || !taskState.workflow_sla_instance_id
  ) {
    throw AppError.conflict(
      'Pathway task is not registered for domain-evidence SLA completion',
      'DOMAIN_EVIDENCE_COMPLETION_NOT_ALLOWED',
    );
  }

  const previousTaskStatus = taskState.status;
  const previousSlaStatus = linkedSla.status;
  const wasCompleted = taskState.status === 'completed';
  if (taskState.status === 'cancelled') {
    throw AppError.invalidTransition('cancelled', 'completed', TASK_TRANSITIONS.cancelled);
  }
  if (!wasCompleted) {
    if (taskState.status === 'blocked') {
      taskState = await transitionTask({
        tenantId: tid,
        id: taskId,
        nextStatus: 'in_progress',
        executorAuthority,
        slaSourceBindingAuthority: TASK_SLA_SOURCE_BINDING_AUTHORITY,
        tx,
      });
    }
    taskState = await transitionTask({
      tenantId: tid,
      id: taskId,
      nextStatus: 'completed',
      ...(cleanActorUid ? { actorUid: cleanActorUid } : {}),
      executorAuthority,
      domainEvidenceAuthority: DOMAIN_EVIDENCE_COMPLETION_AUTHORITY,
      slaSourceBindingAuthority: TASK_SLA_SOURCE_BINDING_AUTHORITY,
      tx,
    });
  }

  const completedSla = await completeLinkedSla({
    tenantId: tid,
    taskRow: taskState,
    db: tx,
    completedBy: cleanActorUid,
    completionTrigger: 'domain_evidence',
    evidence: normalizedEvidence,
    strict: true,
  });
  const slaRows = await tx.$queryRawUnsafe(
    `SELECT *,
            (metadata->'completion_evidence' = $3::jsonb) AS evidence_matches
       FROM workflow_sla_instances
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
      LIMIT 1`,
    taskState.workflow_sla_instance_id,
    tid,
    JSON.stringify(normalizedEvidence),
  );
  const sla = slaRows[0];
  if (!sla?.completed_at) {
    throw AppError.conflict('SLA completion changed concurrently', 'SLA_COMPLETION_CONFLICT');
  }
  if (!completedSla && (
    sla.metadata?.completed_via !== 'domain_evidence'
    || sla.evidence_matches !== true
  )) {
    throw AppError.conflict(
      'Existing SLA completion is not backed by the same registered pathway evidence',
      'SLA_DOMAIN_EVIDENCE_MISMATCH',
    );
  }

  if (!wasCompleted) {
    await postTaskComment({
      tenantId: tid,
      taskId,
      authorUid: cleanActorUid,
      body: `Task completed from registered pathway condition ${cleanHandler}`,
      bodyKind: 'state_change',
      metadata: {
        to: 'completed',
        completion_via: 'domain_evidence',
        evidence: normalizedEvidence,
      },
      tx,
    });
  }
  return Object.freeze({
    task: taskState,
    sla,
    evidence: normalizedEvidence,
    previousTaskStatus,
    previousSlaStatus,
    mutated: !wasCompleted || Boolean(completedSla),
  });
}

export async function completePathwayTaskFromRegisteredCondition({
  tenantId = null,
  pathwayInstanceId,
  id,
  workflowRunId,
  workflowStepId,
  conditionHandler,
  evidenceResourceType,
  evidenceResourceId,
  evidence = {},
  actor = null,
  signal = null,
  executorAuthority = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  if (!await hasPathwayExecutorAuthority(executorAuthority)) {
    throw AppError.conflict(
      'Pathway-bound workflow mutations must use the pathway executor',
      'PATHWAY_EXECUTOR_REQUIRED',
    );
  }
  const taskId = normalizeStrictPositiveId(id, 'task id');
  const runId = normalizeStrictPositiveId(workflowRunId, 'workflow_run_id');
  const stepId = normalizeStrictPositiveId(workflowStepId, 'workflow_step_id');
  const cleanPathwayInstanceId = maybeUuid(pathwayInstanceId, 'pathway_instance_id');
  if (!cleanPathwayInstanceId) {
    throw AppError.badRequest(
      'pathway_instance_id is required',
      'PATHWAY_TASK_CONTEXT_INVALID',
    );
  }
  const { isTenantTransactionClient } = await import('../../lib/prisma.js');
  if (!tx || !isTenantTransactionClient(tx)) {
    throw AppError.conflict(
      'Pathway condition completion requires a branded tenant transaction',
      'PATHWAY_RUNTIME_TX_REQUIRED',
    );
  }
  const cleanHandler = requireCanonicalHandlerId(conditionHandler);
  const cleanResourceType = safeText(evidenceResourceType, 120);
  const cleanResourceId = safeText(evidenceResourceId, 220);
  if (!cleanResourceType || !cleanResourceId) {
    throw AppError.badRequest(
      'Registered condition completion requires an evidence resource',
      'PATHWAY_REGISTERED_CONDITION_EVIDENCE_INVALID',
    );
  }
  const payload = cloneBudgetedWorkflowJson(
    normalizeJsonObject(evidence, 'evidence'),
    'evidence',
    'PATHWAY_HANDLER_CONTRACT_INVALID',
  );
  const completionBinding = REGISTERED_CONDITION_COMPLETION_BINDINGS[cleanHandler];
  const payloadResourceId = safeText(
    payload?.[completionBinding?.evidenceResourceIdField],
    220,
  );
  if (
    !completionBinding
    || cleanResourceType !== completionBinding.evidenceResourceType
    || !maybeUuid(cleanResourceId, 'evidence_resource_id')
    || payloadResourceId !== cleanResourceId
  ) {
    throw AppError.conflict(
      'Registered condition evidence does not match its sealed completion binding',
      'PATHWAY_REGISTERED_CONDITION_EVIDENCE_INVALID',
    );
  }
  const provenance = await normalizePathwayEvidenceProvenance(actor, signal);
  const cleanActorUid = provenance.actor_kind === 'user' ? provenance.actor_uid : null;
  const normalizedEvidence = Object.freeze(cloneBudgetedWorkflowJson({
    kind: 'pathway_registered_condition',
    handler_id: cleanHandler,
    decision: 'satisfied',
    resource_type: cleanResourceType,
    resource_id: cleanResourceId,
    payload,
    provenance,
  }, 'normalized_evidence', 'PATHWAY_HANDLER_CONTRACT_INVALID'));

  const pathwayRows = await tx.$queryRawUnsafe(
    `SELECT id
       FROM care_pathway_instances
      WHERE tenant_id = $1::uuid
        AND workflow_run_id = $2::bigint
        AND id = $3::uuid
      LIMIT 1`,
    tid,
    runId,
    cleanPathwayInstanceId,
  );
  if (!pathwayRows[0]?.id) {
    throw AppError.conflict(
      'Pathway task run and step context is not registered',
      'PATHWAY_TASK_CONTEXT_MISMATCH',
    );
  }
  const { lockPathwayRuntimeTx } = await import('../pathways/pathwayRuntimePersistence.js');
  const runtime = await lockPathwayRuntimeTx({
    tx,
    tenantId: tid,
    pathwayInstanceId: pathwayRows[0].id,
  });
  const current = runtime.tasks.find((task) => Number(task.id) === taskId);
  const step = runtime.steps.find((candidate) => Number(candidate.id) === stepId);
  if (
    Number(runtime.run?.id) !== runId
    || !step
    || runtime.run.current_step_key !== step.step_key
    || Number(step.workflow_run_id) !== runId
    || !current
    || Number(current.workflow_run_id) !== runId
    || Number(current.workflow_step_id) !== stepId
  ) {
    throw AppError.conflict(
      'Pathway task is not the supplied run current step',
      'PATHWAY_TASK_CONTEXT_MISMATCH',
    );
  }
  let pinnedSteps = runtime.definition?.steps;
  if (typeof pinnedSteps === 'string') {
    try {
      pinnedSteps = JSON.parse(pinnedSteps);
    } catch {
      pinnedSteps = null;
    }
  }
  const pinnedStep = Array.isArray(pinnedSteps)
    ? pinnedSteps.find((candidate) => candidate?.step_key === step.step_key)
    : null;
  const pinnedHandler = safeText(pinnedStep?.condition_handler, 120);
  if (
    !pinnedStep
    || pinnedStep.step_kind !== 'task'
    || !pinnedHandler
    || pinnedHandler !== cleanHandler
  ) {
    throw AppError.conflict(
      'Pathway evidence handler does not match the pinned governed task step',
      'PATHWAY_HANDLER_CONTRACT_INVALID',
    );
  }
  if (
    pinnedStep.work_semantics?.sla_completion_semantics !== 'none'
    || current.sla_completion_semantics !== 'none'
    || current.workflow_sla_instance_id
  ) {
    throw AppError.conflict(
      'Pathway task is not registered for no-SLA condition completion',
      'REGISTERED_CONDITION_COMPLETION_NOT_ALLOWED',
    );
  }

  let taskState = current;
  const previousTaskStatus = taskState.status;
  const wasCompleted = taskState.status === 'completed';
  if (taskState.status === 'cancelled') {
    throw AppError.invalidTransition('cancelled', 'completed', TASK_TRANSITIONS.cancelled);
  }
  if (!wasCompleted) {
    if (taskState.status === 'blocked') {
      taskState = await transitionTask({
        tenantId: tid,
        id: taskId,
        nextStatus: 'in_progress',
        executorAuthority,
        tx,
      });
    }
    taskState = await transitionTask({
      tenantId: tid,
      id: taskId,
      nextStatus: 'completed',
      ...(cleanActorUid ? { actorUid: cleanActorUid } : {}),
      executorAuthority,
      tx,
    });
    await postTaskComment({
      tenantId: tid,
      taskId,
      authorUid: cleanActorUid,
      body: `Task completed from registered pathway condition ${cleanHandler}`,
      bodyKind: 'state_change',
      metadata: {
        to: 'completed',
        completion_via: 'registered_condition',
        evidence: normalizedEvidence,
      },
      tx,
    });
  }
  return Object.freeze({
    task: taskState,
    evidence: normalizedEvidence,
    previousTaskStatus,
    mutated: !wasCompleted,
  });
}

const TASK_CLAIMABLE_STATUSES = new Set(['open', 'in_progress', 'blocked', 'overdue']);
const TASK_CLAIM_FORBIDDEN_MESSAGE = 'Not authorized to claim this task';

function normalizeClaimIdempotencyKey(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!isValidIdempotencyKey(key)) {
    throw AppError.badRequest(
      'Idempotency-Key must be 1-200 chars [A-Za-z0-9_-:.]',
      'TASK_CLAIM_IDEMPOTENCY_KEY_INVALID',
    );
  }
  return key;
}

function deriveTaskClaimReceipt({ tenantId, taskId, actorUid, rawKey }) {
  const commandFingerprint = createHash('sha256')
    .update(JSON.stringify({
      operation: 'clinical_inbox_task_claim',
      tenantId,
      taskId: String(taskId),
      actorUid,
    }))
    .digest('hex');
  const receipt = createHash('sha256')
    .update(JSON.stringify({ commandFingerprint, rawKey }))
    .digest('hex');
  return Object.freeze({
    commandFingerprint,
    receipt: `task-claim-v1:${receipt}`,
  });
}

function taskClaimForbidden(taskRow = null) {
  const err = AppError.forbidden(TASK_CLAIM_FORBIDDEN_MESSAGE, 'TASK_CLAIM_FORBIDDEN');
  if (taskRow?.patient_uid) {
    Object.defineProperty(err, 'phiPatientUid', {
      value: String(taskRow.patient_uid),
      enumerable: false,
    });
  }
  return err;
}

function acknowledgedByUid(taskRow) {
  const value = String(taskRow?.metadata?.acknowledged_by || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value) ? value : null;
}

function isMarMedicationExceptionContractBoundTask(taskRow) {
  return taskRow?.metadata?.task_contract === MAR_MEDICATION_EXCEPTION_TASK_CONTRACT
    || taskRow?.related_resource_type === 'mar_medication_exception_cases'
    || taskRow?.metadata?.sla_key === MAR_MEDICATION_EXCEPTION_SLA_RULE;
}

function isClinicalAlertDeliveryRecoveryContractBoundTask(taskRow) {
  return taskRow?.metadata?.task_contract
      === CLINICAL_ALERT_DELIVERY_RECOVERY_TASK_CONTRACT
    || taskRow?.related_resource_type === 'clinical_alert_delivery_recovery_cases'
    || CLINICAL_ALERT_DELIVERY_RECOVERY_SLA_RULES.has(
      String(taskRow?.metadata?.sla_key || ''),
    );
}

function isCathInventoryShortfallContractBoundTask(taskRow) {
  return taskRow?.metadata?.task_contract === CATH_INVENTORY_SHORTFALL_TASK_CONTRACT
    || taskRow?.related_resource_type === 'cath_case_consumable_usage'
    || taskRow?.metadata?.sla_key === CATH_INVENTORY_SHORTFALL_SLA_RULE;
}

function isCathInventoryShortfallOperatorRole(role) {
  return CATH_INVENTORY_SHORTFALL_OPERATOR_ROLES.has(
    String(role || '').trim().toUpperCase(),
  );
}

function isExactCathInventoryShortfallTask(taskRow) {
  const resourceId = String(taskRow?.related_resource_id || '').trim();
  return taskRow?.task_kind === 'review'
    && taskRow?.sla_completion_semantics === 'domain_evidence'
    && taskRow?.metadata?.task_contract === CATH_INVENTORY_SHORTFALL_TASK_CONTRACT
    && taskRow?.metadata?.sla_key === CATH_INVENTORY_SHORTFALL_SLA_RULE
    && taskRow?.related_resource_type === 'cath_case_consumable_usage'
    && /^[1-9]\d*$/.test(resourceId)
    && resourceId === String(taskRow?.metadata?.cath_consumable_usage_id || '')
    && /^[1-9]\d*$/.test(String(taskRow?.metadata?.cath_case_id || ''))
    && /^[1-9]\d*$/.test(String(taskRow?.metadata?.inventory_item_id || ''))
    && ['issue', 'dispose'].includes(String(taskRow?.metadata?.movement_kind || ''));
}

function assertGovernedClinicalTaskReassignmentAllowed(taskRow) {
  if (isClinicalAlertDeliveryRecoveryContractBoundTask(taskRow)) {
    throw AppError.conflict(
      'Clinical alert recovery task ownership is managed by the recovery workflow',
      'CLINICAL_ALERT_RECOVERY_TASK_WORKFLOW_REQUIRED',
    );
  }
  if (isMarMedicationExceptionContractBoundTask(taskRow)) {
    throw AppError.conflict(
      'MAR medication exception task ownership is managed by the medication-exception workflow',
      'MAR_EXCEPTION_TASK_WORKFLOW_REQUIRED',
    );
  }
  if (isCathInventoryShortfallContractBoundTask(taskRow)) {
    throw AppError.conflict(
      'Cath inventory shortfall task ownership is managed by the inventory reconciliation workflow',
      'CATH_INVENTORY_SHORTFALL_TASK_WORKFLOW_REQUIRED',
    );
  }
}

function assertGovernedClinicalTaskAcknowledgementAllowed(taskRow) {
  if (isClinicalAlertDeliveryRecoveryContractBoundTask(taskRow)) {
    throw AppError.conflict(
      'Clinical alert recovery tasks must be actioned through the recovery workflow',
      'CLINICAL_ALERT_RECOVERY_TASK_WORKFLOW_REQUIRED',
    );
  }
  if (isMarMedicationExceptionContractBoundTask(taskRow)) {
    throw AppError.conflict(
      'MAR medication exception tasks must be actioned through the medication-exception workflow',
      'MAR_EXCEPTION_TASK_WORKFLOW_REQUIRED',
    );
  }
  if (isCathInventoryShortfallContractBoundTask(taskRow)) {
    throw AppError.conflict(
      'Cath inventory shortfall tasks must be actioned through the inventory reconciliation workflow',
      'CATH_INVENTORY_SHORTFALL_TASK_WORKFLOW_REQUIRED',
    );
  }
}

function isExactMarMedicationExceptionTask(taskRow) {
  const resourceId = String(taskRow?.related_resource_id || '').trim();
  const caseId = String(taskRow?.metadata?.exception_case_id || '').trim();
  const medicationAdministrationId = String(
    taskRow?.metadata?.medication_administration_id || '',
  ).trim();
  return taskRow?.task_kind === 'review'
    && taskRow?.sla_completion_semantics === 'domain_evidence'
    && taskRow?.metadata?.task_contract === MAR_MEDICATION_EXCEPTION_TASK_CONTRACT
    && taskRow?.metadata?.sla_key === MAR_MEDICATION_EXCEPTION_SLA_RULE
    && taskRow?.related_resource_type === 'mar_medication_exception_cases'
    && /^[1-9]\d*$/.test(resourceId)
    && resourceId === caseId
    && /^[1-9]\d*$/.test(medicationAdministrationId)
    && ['held', 'missed'].includes(String(taskRow?.metadata?.exception_kind || ''));
}

function isExactMarMedicationExceptionPrescriberRawRole(value) {
  return MAR_MEDICATION_EXCEPTION_EXACT_PRESCRIBER_ROLES.has(
    String(value || '').trim().toUpperCase(),
  );
}

function assertMarMedicationExceptionClaimAuthority(taskRow, authority = null) {
  if (!isMarMedicationExceptionContractBoundTask(taskRow)) return;
  if (
    authority !== MAR_MEDICATION_EXCEPTION_TASK_CLAIM_AUTHORITY
    || !isExactMarMedicationExceptionTask(taskRow)
  ) {
    throw AppError.conflict(
      'MAR medication exception tasks must use the medication-exception claim workflow',
      'MAR_EXCEPTION_TASK_CLAIM_WORKFLOW_REQUIRED',
    );
  }
}

function wardMedicationOwnerRoleCodes(taskRow) {
  if (taskRow?.metadata?.task_contract !== WARD_MEDICATION_TASK_CONTRACT) return [];
  const declaredRoles = taskRow?.metadata?.owner_role_codes;
  if (!Array.isArray(declaredRoles)) return [];
  return [...new Set(declaredRoles.map(normalizeRole).filter(Boolean))];
}

async function claimTaskForCurrentActorTx({
  tenantId,
  taskId,
  actor,
  idempotencyKey,
  db,
  marMedicationExceptionClaimAuthority = null,
} = {}) {
  const current = await getTaskForUpdate({ tenantId, id: taskId, db });
  assertGenericTaskMutationAllowed(current);
  assertMarMedicationExceptionClaimAuthority(
    current,
    marMedicationExceptionClaimAuthority,
  );
  const isCathInventoryShortfallClaim = isCathInventoryShortfallContractBoundTask(current);
  if (
    isCathInventoryShortfallClaim
    && (
      !isExactCathInventoryShortfallTask(current)
      || !isCathInventoryShortfallOperatorRole(actor.role)
    )
  ) {
    throw AppError.conflict(
      'Cath inventory shortfall tasks can only be claimed by the exact pharmacy-operator workflow',
      'CATH_INVENTORY_SHORTFALL_TASK_CLAIM_WORKFLOW_REQUIRED',
    );
  }
  const claimReceipt = deriveTaskClaimReceipt({
    tenantId,
    taskId,
    actorUid: actor.uid,
    rawKey: idempotencyKey,
  });
  const currentUid = String(current.assigned_to_uid || '').trim().toLowerCase() || null;
  const currentRole = String(current.assigned_to_role || '').trim().toUpperCase() || null;
  const wardMedicationOwnerRoles = wardMedicationOwnerRoleCodes(current);
  const isMarMedicationExceptionClaim = marMedicationExceptionClaimAuthority
    === MAR_MEDICATION_EXCEPTION_TASK_CLAIM_AUTHORITY;
  const isClinicalAlertDeliveryRecoveryClaim =
    isClinicalAlertDeliveryRecoveryContractBoundTask(current);
  const claimQueueRole = isMarMedicationExceptionClaim
    ? 'DOCTOR'
    : isClinicalAlertDeliveryRecoveryClaim
      ? 'ADMIN'
    : isCathInventoryShortfallClaim
      ? 'PHARMACIST'
      : actor.queueRole;
  const claimsDeclaredWardMedicationRole = wardMedicationOwnerRoles.includes(currentRole)
    && wardMedicationOwnerRoles.includes(claimQueueRole);
  const receiptKey = String(current.metadata?.role_claim_receipt || '').trim();
  const receiptFingerprint = String(current.metadata?.role_claim_command_fingerprint || '').trim();
  const receiptActor = String(current.metadata?.role_claimed_by || '').trim().toLowerCase();

  if (
    currentUid === actor.uid
    && receiptKey === claimReceipt.receipt
    && receiptFingerprint === claimReceipt.commandFingerprint
    && receiptActor === actor.uid
  ) {
    return Object.freeze({ task: current, replayed: true });
  }
  if (
    !TASK_CLAIMABLE_STATUSES.has(String(current.status || '').toLowerCase())
    || currentUid
    || !currentRole
    || (
      currentRole !== claimQueueRole
      && !claimsDeclaredWardMedicationRole
    )
  ) {
    throw taskClaimForbidden(current);
  }
  const recordedAcker = acknowledgedByUid(current);
  const recordedRoleAcknowledgementReceipt = Boolean(
    current.status === 'in_progress'
    && recordedAcker
  );
  if (
    recordedRoleAcknowledgementReceipt
    && recordedAcker !== actor.uid
    && !isMarMedicationExceptionClaim
    && !isClinicalAlertDeliveryRecoveryClaim
  ) {
    throw taskClaimForbidden(current);
  }

  const attachedRunId = await taskRowWorkflowRunId({ tenantId, taskRow: current, db });
  await assertPathwayExecutorAuthority({
    tenantId,
    workflowRunId: attachedRunId,
    db,
    executorAuthority: null,
  });
  const linkedSla = await assertTaskSlaSourceBinding({ tenantId, taskRow: current, db });
  const claimedAt = new Date().toISOString();
  const rows = await db.$queryRawUnsafe(
    `UPDATE tasks
        SET assigned_to_uid = $3::uuid,
            assigned_to_role = NULL,
            metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'role_claim_receipt', $4::text,
                   'role_claim_command_fingerprint', $8::text,
                   'role_claimed_by', $3::text,
                   'role_claimed_from_role', $5::text,
                   'role_claimed_at', $6::text
                 )
              || $9::jsonb,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status = $7::text
        AND assigned_to_uid IS NULL
        AND UPPER(BTRIM(assigned_to_role)) = $10::text
      RETURNING ${TASK_RETURNING}`,
    tenantId,
    taskId,
    actor.uid,
    claimReceipt.receipt,
    currentRole,
    claimedAt,
    current.status,
    claimReceipt.commandFingerprint,
    JSON.stringify(
      isMarMedicationExceptionClaim
      || isClinicalAlertDeliveryRecoveryClaim
      || isCathInventoryShortfallClaim
      || (claimsDeclaredWardMedicationRole && currentRole !== claimQueueRole) ? {
      role_claimed_actor_role: actor.role,
      role_claimed_actor_raw_role: actor.rawRole,
    } : {}),
    currentRole,
  );
  const claimed = rows[0];
  if (!claimed) throw taskClaimForbidden(current);

  if (linkedSla && !linkedSla.completed_at && !['completed', 'cancelled'].includes(linkedSla.status)) {
    const slaRows = await db.$queryRawUnsafe(
      `UPDATE workflow_sla_instances
          SET assigned_user_uid = $3::uuid,
              assigned_role_codes = ARRAY[]::text[],
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid
          AND completed_at IS NULL
          AND status NOT IN ('completed', 'cancelled')
        RETURNING id`,
      tenantId,
      linkedSla.id,
      actor.uid,
    );
    if (!slaRows[0]) {
      throw AppError.conflict(
        'Task claim changed before linked SLA ownership was updated',
        'TASK_CLAIM_SLA_CONFLICT',
      );
    }
  }

  await postTaskComment({
    tenantId,
    taskId,
    authorUid: actor.uid,
    body: claimsDeclaredWardMedicationRole && currentRole !== claimQueueRole
      ? `Task claimed under ${claimQueueRole} authority from ${currentRole} role queue`
      : `Task claimed from ${claimQueueRole} role queue`,
    bodyKind: 'state_change',
    metadata: {
      from_assigned_to_role: currentRole,
      claim_authority_role: claimQueueRole,
      to_assigned_to_uid: actor.uid,
      claimed_at: claimedAt,
      claim_receipt: claimReceipt.receipt,
      command_fingerprint: claimReceipt.commandFingerprint,
      ...(
        isMarMedicationExceptionClaim
        || isClinicalAlertDeliveryRecoveryClaim
        || isCathInventoryShortfallClaim ? {
        actor_role: actor.role,
        actor_raw_role: actor.rawRole,
      } : {}),
    },
    tx: db,
  });
  return Object.freeze({ task: claimed, replayed: false });
}

export async function claimInboxTask({
  tenantId = null,
  id,
  actorUid = null,
  actorRoles = [],
  actorPrimaryRole = null,
  actorRawRole = null,
  idempotencyKey,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  const key = normalizeClaimIdempotencyKey(idempotencyKey);
  if (!tx) {
    return setTenantTx(tid, (tenantTx) => claimInboxTask({
      tenantId: tid,
      id: taskId,
      actorUid,
      actorRoles,
      actorPrimaryRole,
      actorRawRole,
      idempotencyKey: key,
      tx: tenantTx,
    }));
  }
  const actor = await resolveCurrentHumanActorTx({
    tx,
    tenantId: tid,
    actorUid,
    authenticatedRoles: actorRoles,
    authenticatedPrimaryRole: actorPrimaryRole,
    authenticatedRawRole: actorRawRole,
    rolePredicate: isTaskHumanOwnerRole,
  });
  const claimed = await claimTaskForCurrentActorTx({
    tenantId: tid,
    taskId,
    actor,
    idempotencyKey: key,
    db: tx,
  });
  return Object.freeze({ ...claimed.task, replayed: claimed.replayed });
}

export async function recoverCathInventoryShortfallTaskAssignmentTx({
  tenantId = null,
  id,
  actorUid = null,
  actorRoles = [],
  actorPrimaryRole = null,
  actorRawRole = null,
  idempotencyKey,
  tx,
} = {}) {
  const db = requiredTaskFactoryTx(
    tx,
    'CATH_INVENTORY_SHORTFALL_RECOVERY_TRANSACTION_REQUIRED',
    'Cath inventory shortfall assignment recovery requires the caller transaction',
  );
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  const key = normalizeClaimIdempotencyKey(idempotencyKey);
  const actor = await resolveCurrentHumanActorTx({
    tx: db,
    tenantId: tid,
    actorUid,
    authenticatedRoles: actorRoles,
    authenticatedPrimaryRole: actorPrimaryRole,
    authenticatedRawRole: actorRawRole,
    rolePredicate: isTaskHumanOwnerRole,
  });
  if (!isCathInventoryShortfallOperatorRole(actor.role)) {
    throw AppError.forbidden(
      'Only a pharmacy operator may recover an inactive Cath inventory assignee',
      'CATH_INVENTORY_SHORTFALL_RECOVERY_ROLE_REQUIRED',
    );
  }
  const current = await getTaskForUpdate({ tenantId: tid, id: taskId, db });
  const staleUid = String(current.assigned_to_uid || '').trim().toLowerCase();
  if (
    !isExactCathInventoryShortfallTask(current)
    || !TASK_CLAIMABLE_STATUSES.has(String(current.status || '').toLowerCase())
    || !staleUid
    || staleUid === actor.uid
    || current.assigned_to_role
  ) {
    throw taskClaimForbidden(current);
  }
  const activeOwners = await db.$queryRawUnsafe(
    `SELECT uid
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND is_active = TRUE
        AND status = 'active'
        AND COALESCE(is_deleted, FALSE) = FALSE
        AND role = ANY($3::text[])
      LIMIT 1`,
    tid,
    staleUid,
    [...CATH_INVENTORY_SHORTFALL_OPERATOR_ROLES],
  );
  if (activeOwners[0]) throw taskClaimForbidden(current);

  const linkedSla = await assertTaskSlaSourceBinding({
    tenantId: tid,
    taskRow: current,
    db,
  });
  if (
    !linkedSla
    || linkedSla.completed_at
    || ['completed', 'cancelled'].includes(String(linkedSla.status || '').toLowerCase())
    || String(linkedSla.assigned_user_uid || '').toLowerCase() !== staleUid
  ) {
    throw AppError.conflict(
      'Cath inventory shortfall SLA ownership cannot be recovered',
      'CATH_INVENTORY_SHORTFALL_RECOVERY_SLA_CONFLICT',
    );
  }

  const claimReceipt = deriveTaskClaimReceipt({
    tenantId: tid,
    taskId,
    actorUid: actor.uid,
    rawKey: key,
  });
  const recoveryFingerprint = createHash('sha256')
    .update(JSON.stringify({
      operation: 'cath_inventory_shortfall_assignment_recovery',
      tenantId: tid,
      taskId: String(taskId),
      fromUid: staleUid,
      toUid: actor.uid,
    }))
    .digest('hex');
  const recoveryReceipt = `cath-assignment-recovery-v1:${createHash('sha256')
    .update(JSON.stringify({ recoveryFingerprint, rawKey: key }))
    .digest('hex')}`;
  const recoveredAt = new Date().toISOString();
  const rows = await db.$queryRawUnsafe(
    `UPDATE tasks
        SET assigned_to_uid = $3::uuid,
            assigned_to_role = NULL,
            metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'role_claim_receipt', $4::text,
                   'role_claim_command_fingerprint', $5::text,
                   'role_claimed_by', $3::text,
                   'role_claimed_from_role', 'PHARMACIST',
                   'role_claimed_at', $6::text,
                   'role_claimed_actor_role', $12::text,
                   'role_claimed_actor_raw_role', $7::text,
                   'assignment_recovery_receipt', $8::text,
                   'assignment_recovery_command_fingerprint', $9::text,
                   'assignment_recovered_from_uid', $10::text,
                   'assignment_recovered_at', $6::text
                 ),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND assigned_to_uid = $10::uuid
        AND assigned_to_role IS NULL
        AND status = $11::text
      RETURNING ${TASK_RETURNING}`,
    tid,
    taskId,
    actor.uid,
    claimReceipt.receipt,
    claimReceipt.commandFingerprint,
    recoveredAt,
    actor.rawRole,
    recoveryReceipt,
    recoveryFingerprint,
    staleUid,
    current.status,
    actor.role,
  );
  const recovered = rows[0];
  if (!recovered) throw taskClaimForbidden(current);

  const slaRows = await db.$queryRawUnsafe(
    `UPDATE workflow_sla_instances
        SET assigned_user_uid = $3::uuid,
            assigned_role_codes = ARRAY[]::text[],
            metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'assignment_recovery_receipt', $4::text,
                   'assignment_recovered_from_uid', $5::text,
                   'assignment_recovered_at', $6::text
                 ),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND assigned_user_uid = $5::uuid
        AND completed_at IS NULL
        AND status NOT IN ('completed', 'cancelled')
      RETURNING id`,
    tid,
    linkedSla.id,
    actor.uid,
    recoveryReceipt,
    staleUid,
    recoveredAt,
  );
  if (!slaRows[0]) {
    throw AppError.conflict(
      'Cath inventory shortfall SLA ownership changed before recovery',
      'CATH_INVENTORY_SHORTFALL_RECOVERY_SLA_CONFLICT',
    );
  }
  await postTaskComment({
    tenantId: tid,
    taskId,
    authorUid: actor.uid,
    body: 'Inactive Cath inventory assignee recovered by Pharmacy Incharge',
    bodyKind: 'state_change',
    metadata: {
      from_assigned_to_uid: staleUid,
      to_assigned_to_uid: actor.uid,
      recovered_at: recoveredAt,
      recovery_receipt: recoveryReceipt,
      command_fingerprint: recoveryFingerprint,
      actor_role: actor.role,
      actor_raw_role: actor.rawRole,
    },
    tx: db,
  });
  return Object.freeze(recovered);
}

export async function claimMarMedicationExceptionTaskTx({
  tenantId = null,
  id,
  actorUid = null,
  actorRoles = [],
  actorPrimaryRole = null,
  actorRawRole = null,
  idempotencyKey,
  tx,
} = {}) {
  const db = requiredTaskFactoryTx(
    tx,
    'MAR_EXCEPTION_TASK_CLAIM_TRANSACTION_REQUIRED',
    'MAR medication exception task claims require the caller transaction',
  );
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  const key = normalizeClaimIdempotencyKey(idempotencyKey);
  const actor = await resolveCurrentHumanActorTx({
    tx: db,
    tenantId: tid,
    actorUid,
    authenticatedRoles: actorRoles,
    authenticatedPrimaryRole: actorPrimaryRole,
    authenticatedRawRole: actorRawRole,
    rolePredicate: isDoctor,
  });
  if (!isExactMarMedicationExceptionPrescriberRawRole(actor.rawRole)) {
    throw taskClaimForbidden();
  }
  const claimed = await claimTaskForCurrentActorTx({
    tenantId: tid,
    taskId,
    actor,
    idempotencyKey: key,
    db,
    marMedicationExceptionClaimAuthority:
      MAR_MEDICATION_EXCEPTION_TASK_CLAIM_AUTHORITY,
  });
  return Object.freeze({ ...claimed.task, replayed: claimed.replayed });
}

/**
 * Acknowledge a task: open|overdue → in_progress, stamping
 * `metadata.acknowledged_at` and appending a `state_change` task_comment.
 *
 * This is the results-inbox "assignee saw it / stopped the escalation clock"
 * action (design §4.5). It is a thin, intention-revealing wrapper over the
 * existing state machine: the engine treats an in_progress task as acked, so
 * no new status is introduced. Already-acknowledged (in_progress) tasks are
 * returned without re-stamping or duplicating the audit comment; the same
 * authority-checked statement repairs any legacy active linked SLA. A
 * completed/cancelled task cannot be acknowledged → AppError.invalidTransition
 * (400).
 */
function actorRolesUpper(actorRoles) {
  const arr = Array.isArray(actorRoles) ? actorRoles : (actorRoles ? [actorRoles] : []);
  return arr.map((r) => String(r || '').trim().toUpperCase()).filter(Boolean);
}

const ACK_FORBIDDEN_MESSAGE = 'Not authorized to acknowledge this task';
const COLD_CHAIN_ACK_SOURCE = 'cold_chain_excursion_ack';
const COLD_CHAIN_ACK_REASON = 'Acknowledged via cold-chain excursion acknowledgement';
const POSTGRES_INT_MAX = 2_147_483_647;

function ackForbidden(taskRow = null) {
  const err = AppError.forbidden(ACK_FORBIDDEN_MESSAGE);
  if (taskRow?.patient_uid) {
    // Internal-only context for phiAccessLogger. Keep it non-enumerable so the
    // generic 403 response cannot disclose which patient owns a probed task id.
    Object.defineProperty(err, 'phiPatientUid', {
      value: String(taskRow.patient_uid),
      enumerable: false,
    });
  }
  return err;
}

// Who may acknowledge a task — and thereby STOP its escalation/SLA clock.
// Caller text is never authority. Normal authority comes from assignment or task
// administration; an override must already have been verified against a durable
// server-side authority record before it reaches this resolver.
function resolveDirectAckAuthorization(taskRow, {
  actorUid = null,
  actorRoles = [],
  actorRole = null,
  actorQueueRole = null,
} = {}) {
  const roles = actorRolesUpper(actorRoles);
  const canonicalRole = String(actorRole || '').trim().toUpperCase() || null;
  const queueRole = String(actorQueueRole || '').trim().toUpperCase() || null;
  const callerUid = actorUid ? String(actorUid).toLowerCase() : null;
  const assignedUid = taskRow?.assigned_to_uid ? String(taskRow.assigned_to_uid).toLowerCase() : null;
  const assignedRole = taskRow?.assigned_to_role ? String(taskRow.assigned_to_role).trim().toUpperCase() : null;
  const claimedBy = String(taskRow?.metadata?.role_claimed_by || '').trim().toLowerCase() || null;
  const claimedFromRole = String(taskRow?.metadata?.role_claimed_from_role || '')
    .trim().toUpperCase() || null;

  if (!callerUid) return null;
  if (
    callerUid === assignedUid
    && callerUid === claimedBy
    && queueRole
    && queueRole === claimedFromRole
  ) {
    return { mode: 'role', assignedRole: claimedFromRole };
  }
  if (callerUid && assignedUid && callerUid === assignedUid) return { mode: 'assignee' };
  if (
    !assignedUid
    && assignedRole
    && (queueRole ? queueRole === assignedRole : roles.includes(assignedRole))
  ) {
    return { mode: 'role', assignedRole };
  }
  if (isAdmin(canonicalRole) || roles.some((r) => isAdmin(r))) return { mode: 'admin' };
  return null;
}

function resolveAckAuthorization(taskRow, {
  actorUid = null,
  actorRoles = [],
  actorRole = null,
  actorQueueRole = null,
  verifiedOverride = null,
} = {}) {
  const direct = resolveDirectAckAuthorization(taskRow, {
    actorUid,
    actorRoles,
    actorRole,
    actorQueueRole,
  });
  if (direct) return direct;
  if (verifiedOverride?.source && verifiedOverride?.id && verifiedOverride?.reason) {
    return { mode: 'override', ...verifiedOverride };
  }
  throw ackForbidden(taskRow);
}

async function loadVerifiedPatientBreakGlass({
  tenantId, taskRow, actorUid, actorRoles, breakGlassId, db,
}) {
  const numericId = Number(breakGlassId);
  if (
    !Number.isSafeInteger(numericId)
    || numericId <= 0
    || numericId > POSTGRES_INT_MAX
    || !taskRow?.patient_uid
    || !actorUid
  ) return null;

  const roles = actorRolesUpper(actorRoles);
  if (!roles.some((role) => roleCanBreakGlass(role))) return null;

  const rows = await db.$queryRawUnsafe(
    `SELECT id, actor_role, reason
       FROM patient_access_break_glass
      WHERE tenant_id = $1::uuid
        AND patient_uid = $2::uuid
        AND actor_uid = $3::uuid
        AND id = $4::int
        AND status = 'active'
        AND expires_at > NOW()
      LIMIT 1`,
    tenantId,
    taskRow.patient_uid,
    actorUid,
    numericId,
  );
  const row = rows[0];
  const sessionRole = row?.actor_role ? String(row.actor_role).trim().toUpperCase() : null;
  const reason = safeText(row?.reason, TEXT_MAX);
  if (!row || !sessionRole || !roles.includes(sessionRole) || !roleCanBreakGlass(sessionRole) || !reason) return null;

  return {
    source: 'patient_access_break_glass',
    id: String(row.id),
    reason,
    sessionRole,
  };
}

function resolveTrustedWorkflowOverride(taskRow, trustedOverride) {
  const source = safeText(trustedOverride?.source, 120);
  const resourceId = safeText(trustedOverride?.id, 120);
  const reason = safeText(trustedOverride?.reason, TEXT_MAX);
  if (
    source !== COLD_CHAIN_ACK_SOURCE
    || reason !== COLD_CHAIN_ACK_REASON
    || taskRow?.related_resource_type !== 'cold_chain_excursions'
    || String(taskRow?.related_resource_id || '') !== resourceId
  ) return null;

  return { source, id: resourceId, reason };
}

async function resolveVerifiedAckAuthorization({
  tenantId,
  taskRow,
  actorUid,
  actorRoles,
  actorRole,
  actorQueueRole,
  breakGlassId,
  trustedOverride,
  db,
}) {
  let verifiedOverride = null;
  if (trustedOverride) {
    verifiedOverride = resolveTrustedWorkflowOverride(taskRow, trustedOverride);
    if (!verifiedOverride) throw ackForbidden(taskRow);
  }

  let authz = resolveDirectAckAuthorization(taskRow, {
    actorUid,
    actorRoles,
    actorRole,
    actorQueueRole,
  });
  if (!authz && !verifiedOverride && breakGlassId !== null && breakGlassId !== undefined) {
    verifiedOverride = await loadVerifiedPatientBreakGlass({
      tenantId,
      taskRow,
      actorUid,
      actorRoles,
      breakGlassId,
      db,
    });
  }

  authz ||= resolveAckAuthorization(taskRow, {
    actorUid,
    actorRoles,
    actorRole,
    actorQueueRole,
    verifiedOverride,
  });
  return { authz, verifiedOverride };
}

// Shared by the state-changing CAS and the idempotent-repair read. This makes
// the database statement that stops (or repairs) the SLA clock re-check the
// exact authority selected from the pre-read instead of trusting stale state.
const ACK_AUTHORITY_PREDICATE = `
  (
    ($3::text = 'assignee' AND tasks.assigned_to_uid = $4::uuid)
    OR (
      $3::text = 'role'
      AND (
        (
          tasks.assigned_to_uid IS NULL
          AND UPPER(TRIM(tasks.assigned_to_role)) = $5::text
        )
        OR (
          tasks.assigned_to_uid = $4::uuid
          AND LOWER(COALESCE(tasks.metadata->>'role_claimed_by', '')) = LOWER($4::text)
          AND UPPER(COALESCE(tasks.metadata->>'role_claimed_from_role', '')) = $5::text
        )
      )
    )
    OR $3::text = 'admin'
    OR (
      $3::text = 'override'
      AND (
        (
          $6::text = 'patient_access_break_glass'
          AND EXISTS (
            SELECT 1
              FROM patient_access_break_glass bg
             WHERE bg.id = $11::int
               AND bg.tenant_id = $2::uuid
               AND bg.patient_uid = tasks.patient_uid
               AND bg.actor_uid = $4::uuid
               AND UPPER(TRIM(bg.actor_role)) = $9::text
               AND bg.reason = $8::text
               AND bg.status = 'active'
               AND bg.expires_at > NOW()
          )
        )
        OR (
          $6::text = 'cold_chain_excursion_ack'
          AND tasks.related_resource_type = 'cold_chain_excursions'
          AND tasks.related_resource_id = $7::text
        )
      )
    )
  )
  AND (
    $10::text IS NULL
    OR (
      tasks.related_resource_type = 'cold_chain_excursions'
      AND tasks.related_resource_id = $10::text
    )
  )`;

function ackAuthorityParams({ tenantId, taskId, actorUid, authz, trustedResourceId = null }) {
  return [
    taskId,
    tenantId,
    authz.mode,
    actorUid,
    authz.assignedRole || null,
    authz.source || null,
    authz.id || null,
    authz.reason || null,
    authz.sessionRole || null,
    trustedResourceId,
    authz.source === 'patient_access_break_glass' ? Number(authz.id) : null,
  ];
}

async function reconcileInProgressAcknowledgement({
  tenantId,
  taskId,
  actorUid,
  authz,
  trustedResourceId,
  taskRow,
  db,
}) {
  const authorityParams = ackAuthorityParams({
    tenantId, taskId, actorUid, authz, trustedResourceId,
  });
  const rows = await db.$queryRawUnsafe(
    `SELECT ${TASK_RETURNING}
       FROM tasks
      WHERE tasks.id = $1
        AND tasks.tenant_id = $2::uuid
        AND tasks.status = 'in_progress'
        AND ${ACK_AUTHORITY_PREDICATE}
      LIMIT 1
      FOR UPDATE`,
    ...authorityParams,
  );
  const current = rows[0];
  if (!current) throw ackForbidden(taskRow);
  await assertTaskSlaSourceBinding({ tenantId, taskRow: current, db });

  const durableReceipt = parseDurableTimestamp(current.metadata?.acknowledged_at);
  if (durableReceipt) {
    await completeLinkedSla({
      tenantId,
      taskRow: current,
      db,
      completedBy: current.metadata?.acknowledged_by || actorUid,
      completionTrigger: 'acknowledgement',
      completedAt: durableReceipt,
      strict: true,
    });
    return current;
  }

  // Some pre-receipt releases could leave a task in_progress without durable
  // acknowledgement evidence. An authorized re-ack repairs the receipt and
  // records that repair before the SLA clock is reconciled in this transaction.
  const previousAcknowledgedAt = current.metadata?.acknowledged_at ?? null;
  const repairedFrom = previousAcknowledgedAt === null ? 'missing' : 'malformed';
  const repairedAt = new Date().toISOString();
  const repairedRows = await db.$queryRawUnsafe(
    `WITH repair_input AS (
       SELECT to_char(
                to_timestamp($12::double precision / 1000.0) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS acknowledged_at,
              $13::jsonb AS previous_acknowledged_at,
              $14::text AS repaired_from
     )
     UPDATE tasks
        SET metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object(
               'acknowledged_at', repair_input.acknowledged_at,
               'acknowledged_by', $4::text,
               'acknowledged_via', $3::text,
               'acknowledgement_receipt_repaired', TRUE,
               'previous_acknowledged_at', repair_input.previous_acknowledged_at,
               'acknowledgement_receipt_repaired_from', repair_input.repaired_from
             )
          || CASE WHEN $6::text IS NOT NULL
                  THEN jsonb_build_object(
                    'acknowledge_override_source', $6::text,
                    'acknowledge_override_id', $7::text,
                    'acknowledge_override_reason', $8::text
                  )
                  ELSE '{}'::jsonb END,
            updated_at = NOW()
       FROM repair_input
      WHERE tasks.id = $1
        AND tasks.tenant_id = $2::uuid
        AND tasks.status = 'in_progress'
        AND ${ACK_AUTHORITY_PREDICATE}
      RETURNING ${TASK_RETURNING}`,
    ...authorityParams,
    new Date(repairedAt).getTime(),
    JSON.stringify(previousAcknowledgedAt),
    repairedFrom,
  );
  const repaired = repairedRows[0];
  if (!repaired) throw ackForbidden(taskRow);

  await completeLinkedSla({
    tenantId,
    taskRow: repaired,
    db,
    completedBy: actorUid,
    completionTrigger: 'acknowledgement',
    completedAt: repairedAt,
    strict: true,
  });
  const overrideNote = authz.mode === 'override'
    ? ` [override ${authz.source}:${authz.id}: ${authz.reason}]`
    : '';
  await postTaskComment({
    tenantId,
    taskId,
    authorUid: actorUid,
    body: `Task acknowledgement receipt repaired (in_progress) via ${authz.mode}${overrideNote}`,
    bodyKind: 'state_change',
    metadata: {
      from: 'in_progress',
      to: 'in_progress',
      acknowledged_at: repairedAt,
      previous_acknowledged_at: previousAcknowledgedAt,
      via: authz.mode,
      receipt_repaired: true,
      repaired_from: repairedFrom,
      ...(authz.mode === 'override' ? {
        override_source: authz.source,
        override_id: authz.id,
        override_reason: authz.reason,
      } : {}),
    },
    tx: db,
  });
  return repaired;
}

async function updateTaskForAcknowledgement({
  tenantId,
  taskId,
  actorUid,
  authz,
  trustedResourceId,
  acknowledgedAt,
  allowBlocked = false,
  ackContractVersion = null,
  db,
}) {
  const authorityParams = ackAuthorityParams({
    tenantId, taskId, actorUid, authz, trustedResourceId,
  });
  const acknowledgeableStatuses = allowBlocked
    ? "('open', 'overdue', 'blocked')"
    : "('open', 'overdue')";
  return db.$queryRawUnsafe(
    `WITH ack_input AS (
       SELECT to_char(
                to_timestamp($12::double precision / 1000.0) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
              ) AS acknowledged_at
     )
     UPDATE tasks
        SET status = 'in_progress',
            metadata = COALESCE(metadata, '{}'::jsonb)
                || jsonb_build_object('acknowledged_at', ack_input.acknowledged_at, 'acknowledged_by', $4::text, 'acknowledged_via', $3::text)
                || CASE WHEN $6::text IS NOT NULL
                        THEN jsonb_build_object(
                          'acknowledge_override_source', $6::text,
                          'acknowledge_override_id', $7::text,
                          'acknowledge_override_reason', $8::text
                        )
                        ELSE '{}'::jsonb END
                || CASE WHEN $13::int IS NOT NULL
                        THEN jsonb_build_object('ack_contract_version', $13::int)
                        ELSE '{}'::jsonb END,
             updated_at = NOW()
       FROM ack_input
      WHERE tasks.id = $1::int AND tasks.tenant_id = $2::uuid
        AND tasks.status IN ${acknowledgeableStatuses}
        AND ${ACK_AUTHORITY_PREDICATE}
      RETURNING ${TASK_RETURNING}`,
    ...authorityParams,
    new Date(acknowledgedAt).getTime(),
    ackContractVersion,
  );
}

function hasLabCriticalAlertBinding(taskRow) {
  return taskRow?.metadata?.lab_critical_alert_id !== undefined
    && taskRow?.metadata?.lab_critical_alert_id !== null;
}

async function assertLabCriticalAlertAcknowledgementBoundary({
  tenantId,
  taskRow,
  authority,
  db,
}) {
  const hasBinding = hasLabCriticalAlertBinding(taskRow);
  const hasAuthority = authority?.capability === LAB_CRITICAL_ALERT_ACKNOWLEDGEMENT_AUTHORITY;
  if (!hasBinding && !hasAuthority) return;

  if (!hasAuthority) {
    throw AppError.conflict(
      'Lab critical-result tasks must be acknowledged through the critical-alert workflow',
      'LAB_CRITICAL_ALERT_ACK_REQUIRED',
    );
  }

  const alertId = normalizeId(authority.alertId, 'critical alert id');
  const resultId = safeText(authority.resultId, 120);
  const patientUid = maybeUuid(authority.patientUid, 'patient_uid');
  if (
    !resultId
    || !patientUid
    || String(taskRow.metadata.lab_critical_alert_id) !== String(alertId)
  ) {
    throw AppError.forbidden('Not authorized to acknowledge this task');
  }

  const bindings = await db.$queryRawUnsafe(
    `SELECT alert.id
       FROM tasks AS task
       JOIN lab_critical_alerts AS alert
         ON alert.tenant_id = task.tenant_id
        AND alert.acknowledgement_task_id = task.id
       JOIN workflow_sla_instances AS sla
         ON sla.tenant_id = task.tenant_id
        AND sla.id = task.workflow_sla_instance_id
      WHERE task.tenant_id = $1::uuid
        AND task.id = $2::int
        AND alert.id = $3::int
        AND alert.result_id::text = $4::text
        AND alert.patient_uid = $5::uuid
        AND alert.superseded_at IS NULL
        AND task.patient_uid = alert.patient_uid
        AND task.related_resource_type = 'lab_result'
        AND task.related_resource_id = alert.result_id::text
        AND task.sla_completion_semantics = 'acknowledgement'
        AND task.metadata->>'lab_critical_alert_id' = alert.id::text
        AND (
          alert.generation_signoff_id IS NULL
          OR task.metadata->>'lab_alert_generation_signoff_id'
               = alert.generation_signoff_id::text
        )
        AND task.metadata->>'lab_alert_generation_state'
             = alert.generation_metadata->>'corrected_state'
        AND sla.rule_code = 'critical_result_ack'
        AND sla.source_table = 'lab_result'
        AND sla.source_id = alert.result_id::text
        AND sla.patient_uid = alert.patient_uid
      LIMIT 2`,
    tenantId,
    taskRow.id,
    alertId,
    resultId,
    patientUid,
  );
  if (bindings.length !== 1) {
    throw AppError.forbidden('Not authorized to acknowledge this task');
  }
}

async function acknowledgeTaskInternal({
  tenantId = null,
  id,
  actorUid = null,
  actorRoles = [],
  actorPrimaryRole = null,
  actorRawRole = null,
  breakGlassId = null,
  trustedOverride = null,
  labCriticalAlertAuthority = null,
  trustedAcknowledgedAt = null,
  executorAuthority = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  const db = tx || prisma;

  const currentActor = await resolveCurrentHumanActorTx({
    tx: db,
    tenantId: tid,
    actorUid: requireActorUid(actorUid),
    authenticatedRoles: actorRoles,
    authenticatedPrimaryRole: actorPrimaryRole,
    authenticatedRawRole: actorRawRole,
    rolePredicate: (role) => (
      isTaskHumanOwnerRole(role)
      || isAdmin(role)
      || role === 'SUPER_ADMIN'
    ),
  });
  const ackUid = currentActor.uid;
  const currentActorRoles = [currentActor.role];

  // Pre-read for a clean, intention-revealing error before attempting the write.
  let current = await getTask({ tenantId: tid, id: taskId, tx });
  assertGenericTaskMutationAllowed(current);

  if (
    isClinicalAlertDeliveryRecoveryContractBoundTask(current)
    || isMarMedicationExceptionContractBoundTask(current)
    || isCathInventoryShortfallContractBoundTask(current)
  ) {
    await resolveVerifiedAckAuthorization({
      tenantId: tid,
      taskRow: current,
      actorUid: ackUid,
      actorRoles: currentActorRoles,
      actorRole: currentActor.role,
      actorQueueRole: currentActor.queueRole,
      breakGlassId,
      trustedOverride,
      db,
    });
    assertGovernedClinicalTaskAcknowledgementAllowed(current);
  }

  const recordedRoleAcknowledgementReceipt = Boolean(
    current.status === 'in_progress'
    && !current.assigned_to_uid
    && current.assigned_to_role
    && acknowledgedByUid(current),
  );
  if (
    recordedRoleAcknowledgementReceipt
    && acknowledgedByUid(current) !== ackUid
    && !isAdmin(currentActor.role)
  ) {
    throw ackForbidden(current);
  }

  // A role-queue acknowledgement is also the moment responsibility becomes
  // personal. Claim under the same transaction before stopping the SLA clock.
  // Legacy in_progress rows may be repaired only by their recorded acker.
  if (
    !current.assigned_to_uid
    && String(current.assigned_to_role || '').trim().toUpperCase() === currentActor.queueRole
    && (
      !recordedRoleAcknowledgementReceipt
      || acknowledgedByUid(current) === ackUid
    )
  ) {
    const claim = await claimTaskForCurrentActorTx({
      tenantId: tid,
      taskId,
      actor: currentActor,
      idempotencyKey: `task-role-ack:${taskId}:${ackUid}`,
      db,
    });
    current = claim.task;
  }

  // Authorize BEFORE any idempotent return, so an unauthorized caller neither
  // stops the clock nor learns the task's state/PHI. Throws forbidden otherwise.
  const { authz, verifiedOverride } = await resolveVerifiedAckAuthorization({
    tenantId: tid,
    taskRow: current,
    actorUid: ackUid,
    actorRoles: currentActorRoles,
    actorRole: currentActor.role,
    actorQueueRole: currentActor.queueRole,
    breakGlassId,
    trustedOverride,
    db,
  });
  // A lab critical alert, its task receipt, linked SLA, task comment, and
  // canonical clinical evidence are one clinical transition. Generic task
  // callers may never execute only the task/SLA half. Migration 581 makes the
  // metadata pointer immutable for every alert-bound task; the dedicated
  // transaction-only entrypoint below additionally revalidates the exact
  // current tenant/alert/task/resource/SLA binding before mutation.
  await assertLabCriticalAlertAcknowledgementBoundary({
    tenantId: tid,
    taskRow: current,
    authority: labCriticalAlertAuthority,
    db,
  });
  const allowBlocked = labCriticalAlertAuthority?.capability
    === LAB_CRITICAL_ALERT_ACKNOWLEDGEMENT_AUTHORITY;
  const ackContractVersion = allowBlocked
    ? LAB_CRITICAL_ALERT_ACK_CONTRACT_VERSION
    : null;
  // Only an authorized task actor may learn that this work is pathway-bound.
  // The generic route still fails closed for valid assignees/roles; probes keep
  // the same non-enumerating 403 response as every other unauthorized task id.
  const attachedRunId = await taskRowWorkflowRunId({ tenantId: tid, taskRow: current, db });
  await assertPathwayExecutorAuthority({
    tenantId: tid,
    workflowRunId: attachedRunId,
    db,
    executorAuthority,
  });
  let effectiveAuthz = authz;
  let effectiveTrustedResourceId = trustedOverride ? verifiedOverride.id : null;
  let effectiveFromStatus = current.status;

  // Already acknowledged → do not re-stamp or duplicate the comment, but repair
  // a legacy task/SLA split after atomically re-checking current authority.
  if (current.status === 'in_progress') {
    return reconcileInProgressAcknowledgement({
      tenantId: tid,
      taskId,
      actorUid: ackUid,
      authz: effectiveAuthz,
      trustedResourceId: effectiveTrustedResourceId,
      taskRow: current,
      db,
    });
  }
  // Terminal states can never be acknowledged.
  if (current.status === 'completed' || current.status === 'cancelled') {
    throw AppError.invalidTransition(current.status, 'in_progress', TASK_TRANSITIONS[current.status] || []);
  }

  // Atomic state change: guard the acknowledgeable statuses IN the UPDATE so a
  // concurrent completion/cancel (or a racing acker) cannot be flipped back to
  // in_progress between the pre-read and the write (TOCTOU). RETURNING yields no
  // row when the guard excludes the current status. `acknowledged_via` records
  // the authorization mode; a verified override stamps its durable authority
  // source, record id, and server-loaded reason.
  const authoritativeAckedAt = parseDurableTimestamp(trustedAcknowledgedAt);
  if (labCriticalAlertAuthority && !authoritativeAckedAt) {
    throw AppError.internal(
      'Critical-alert acknowledgement requires the authoritative database clock',
      'LAB_CRITICAL_ALERT_ACK_DATABASE_CLOCK_REQUIRED',
    );
  }
  const ackedAt = (authoritativeAckedAt || new Date()).toISOString();
  let rows = await updateTaskForAcknowledgement({
    tenantId: tid,
    taskId,
    actorUid: ackUid,
    authz: effectiveAuthz,
    trustedResourceId: effectiveTrustedResourceId,
    acknowledgedAt: ackedAt,
    allowBlocked,
    ackContractVersion,
    db,
  });
  if (!rows[0]) {
    // The guarded UPDATE matched nothing: status or authority changed. Re-read
    // without returning task details until current authority is re-established.
    const after = await getTask({ tenantId: tid, id: taskId, tx });
    const fresh = await resolveVerifiedAckAuthorization({
      tenantId: tid,
      taskRow: after,
      actorUid: ackUid,
      actorRoles: currentActorRoles,
      actorRole: currentActor.role,
      actorQueueRole: currentActor.queueRole,
      breakGlassId,
      trustedOverride,
      db,
    });
    if (after.status === 'in_progress') {
      return reconcileInProgressAcknowledgement({
        tenantId: tid,
        taskId,
        actorUid: ackUid,
        authz: fresh.authz,
        trustedResourceId: trustedOverride ? fresh.verifiedOverride.id : null,
        taskRow: after,
        db,
      });
    }
    if (
      after.status === 'open'
      || after.status === 'overdue'
      || (allowBlocked && after.status === 'blocked')
    ) {
      // The selected authority can change while another valid mode remains
      // (for example, an assignee who is also an administrator). Retry the CAS
      // once with freshly resolved authority before returning a generic denial.
      effectiveAuthz = fresh.authz;
      effectiveTrustedResourceId = trustedOverride ? fresh.verifiedOverride.id : null;
      rows = await updateTaskForAcknowledgement({
        tenantId: tid,
        taskId,
        actorUid: ackUid,
        authz: effectiveAuthz,
        trustedResourceId: effectiveTrustedResourceId,
        acknowledgedAt: ackedAt,
        allowBlocked,
        ackContractVersion,
        db,
      });
      if (!rows[0]) throw ackForbidden(after);
      effectiveFromStatus = after.status;
    } else {
      // Otherwise it was completed/cancelled out from under us → not acknowledgeable.
      throw AppError.invalidTransition(after.status, 'in_progress', TASK_TRANSITIONS[after.status] || []);
    }
  }

  // The guarded task UPDATE above acquires the task row lock before we touch
  // the SLA row. Corrected-result reopen follows the same task -> SLA order.
  await assertTaskSlaSourceBinding({ tenantId: tid, taskRow: rows[0], db });

  // Acknowledging a critical result STOPS the SLA clock (audit C-3): complete
  // the linked mig-269 instance so it leaves 'active'/'breached' and the
  // escalation backfill stops re-creating a task for this already-handled
  // result. Inside a caller transaction both this write and the audit comment
  // are load-bearing so all acknowledgement state commits or rolls back as one.
  await completeLinkedSla({
    tenantId: tid,
    taskRow: rows[0],
    db,
    completedBy: ackUid,
    completionTrigger: 'acknowledgement',
    completedAt: ackedAt,
    ackContractVersion,
    strict: Boolean(tx),
  });

  const overrideNote = effectiveAuthz.mode === 'override'
    ? ` [override ${effectiveAuthz.source}:${effectiveAuthz.id}: ${effectiveAuthz.reason}]`
    : '';
  const commentWrite = () => postTaskComment({
    tenantId: tid,
    taskId,
    authorUid: ackUid,
    body: `Task acknowledged (${effectiveFromStatus} → in_progress) via ${effectiveAuthz.mode}${overrideNote}`,
    bodyKind: 'state_change',
    metadata: {
      from: effectiveFromStatus, to: 'in_progress', acknowledged_at: ackedAt, via: effectiveAuthz.mode,
      ...(ackContractVersion ? { ack_contract_version: ackContractVersion } : {}),
      ...(effectiveAuthz.mode === 'override' ? {
        override_source: effectiveAuthz.source,
        override_id: effectiveAuthz.id,
        override_reason: effectiveAuthz.reason,
      } : {}),
    },
    tx,
  });
  if (tx) {
    await commentWrite();
  } else {
    try {
      await commentWrite();
    } catch (err) {
      logger.warn('acknowledgeTask: state_change comment failed', { taskId, err: err?.message });
    }
  }
  return rows[0];
}

export async function acknowledgeTask({
  tenantId = null, id, actorUid = null, actorRoles = [], actorPrimaryRole = null,
  actorRawRole = null,
  breakGlassId = null,
  executorAuthority = null, tx = null,
} = {}) {
  const args = {
    tenantId, id, actorUid, actorRoles, actorPrimaryRole, actorRawRole,
    breakGlassId, executorAuthority, tx,
  };
  if (tx) return acknowledgeTaskInternal(args);

  const tid = resolveTenantId({ tenantId });
  return setTenantTx(tid, (tenantTx) => acknowledgeTaskInternal({
    ...args,
    tenantId: tid,
    tx: tenantTx,
  }));
}

export async function acknowledgeLabCriticalAlertTaskFromTrustedWorkflow({
  tenantId = null,
  id,
  alertId,
  resultId,
  patientUid,
  actorUid = null,
  actorRoles = [],
  actorPrimaryRole = null,
  actorRawRole = null,
  breakGlassId = null,
  acknowledgedAt = null,
  tx = null,
} = {}) {
  if (!tx) {
    throw AppError.internal(
      'Critical-alert task acknowledgement requires a transaction',
      'LAB_CRITICAL_ALERT_ACK_TRANSACTION_REQUIRED',
    );
  }
  return acknowledgeTaskInternal({
    tenantId,
    id,
    actorUid,
    actorRoles,
    actorPrimaryRole,
    actorRawRole,
    breakGlassId,
    trustedAcknowledgedAt: acknowledgedAt,
    labCriticalAlertAuthority: {
      capability: LAB_CRITICAL_ALERT_ACKNOWLEDGEMENT_AUTHORITY,
      alertId,
      resultId,
      patientUid,
    },
    tx,
  });
}

export async function acknowledgeColdChainTaskFromTrustedWorkflow({
  tenantId = null,
  id,
  actorUid = null,
  actorRoles = [],
  actorPrimaryRole = null,
  actorRawRole = null,
  excursionId,
  tx = null,
} = {}) {
  if (!tx) {
    throw AppError.internal(
      'Trusted workflow acknowledgement requires a transaction',
      'TRUSTED_TASK_ACK_TRANSACTION_REQUIRED',
    );
  }
  const trustedOverride = {
    source: COLD_CHAIN_ACK_SOURCE,
    reason: COLD_CHAIN_ACK_REASON,
    id: String(excursionId),
  };
  return acknowledgeTaskInternal({
    tenantId, id, actorUid, actorRoles, actorPrimaryRole, actorRawRole, trustedOverride, tx,
  });
}

/**
 * Results-inbox query: the open work for "me or my role".
 *
 * Returns tasks in the active inbox statuses (open / in_progress / blocked / overdue)
 * assigned to `assigneeUid` OR to any of `roles`, ordered by clinical urgency
 * (priority, then due_at). Thin wrapper over the same raw SELECT `listTasks`
 * uses; degrades to empty when the schema is absent (mirrors listTasks).
 */
export async function listInboxTasks({
  tenantId = null,
  assigneeUid = null,
  roles = [],
  primaryRole = null,
  rawRole = null,
  limit = DEFAULT_LIST_LIMIT,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  if (!tx) {
    return setTenantTx(tid, (tenantTx) => listInboxTasks({
      tenantId: tid,
      assigneeUid,
      roles,
      primaryRole,
      rawRole,
      limit,
      tx: tenantTx,
    }));
  }
  const actor = await resolveCurrentHumanActorTx({
    tx,
    tenantId: tid,
    actorUid: assigneeUid,
    authenticatedRoles: roles,
    authenticatedPrimaryRole: primaryRole,
    authenticatedRawRole: rawRole,
    rolePredicate: isTaskHumanOwnerRole,
  });

  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await tx.$queryRawUnsafe(
      `SELECT inbox.*,
              pathway.id AS pathway_instance_id,
              pathway.pathway_key,
              pathway.owning_clinician_uid AS pathway_owner_uid,
              pathway.accountable_role AS pathway_accountable_role,
              step.step_key AS pathway_stage_key,
              COALESCE(
                pathway_generation.id,
                direct_generation.id,
                pending_generation.id
              ) AS diagnostic_generation_id,
              COALESCE(
                pathway_generation.classification,
                direct_generation.classification,
                pending_generation.classification
              )
                AS diagnostic_classification,
              COALESCE(
                pathway_generation.snapshot_sha256,
                direct_generation.snapshot_sha256,
                pending_generation.snapshot_sha256
              )
                AS diagnostic_generation_snapshot_sha256,
              COALESCE(
                pathway_generation.source_version,
                direct_generation.source_version,
                pending_generation.source_version
              )
                AS diagnostic_source_version,
              COALESCE(
                pathway_generation.predecessor_generation_id,
                direct_generation.predecessor_generation_id,
                pending_generation.predecessor_generation_id
              ) AS diagnostic_predecessor_generation_id,
              (
                COALESCE(
                  pathway_generation.predecessor_generation_id,
                  direct_generation.predecessor_generation_id,
                  pending_generation.predecessor_generation_id
                ) IS NOT NULL
              ) AS diagnostic_is_correction,
              pending_handoff.admission_id AS pending_result_admission_id,
              pending_handoff.id AS pending_result_handoff_id,
              pending_owner_action.id AS pending_result_owner_action_id,
              pending_handoff.named_physician_uid
                AS pending_result_named_physician_uid,
              pending_handoff.handoff_state AS pending_result_handoff_state,
              pending_handoff.resolution_action_id
                AS pending_result_resolution_action_id,
              pending_handoff.resolved_at AS pending_result_resolved_at,
              pending_handoff.resolved_by_uid AS pending_result_resolved_by_uid,
              pending_tracking_task.id AS pending_result_tracking_task_id,
              pending_tracking_task.status AS pending_result_tracking_task_status,
              authoritative_action.id AS diagnostic_authoritative_action_id,
              authoritative_action.action_kind
                AS diagnostic_authoritative_action_kind,
              authoritative_action.disposition
                AS diagnostic_authoritative_disposition,
              authoritative_action.occurred_at
                AS diagnostic_authoritative_action_occurred_at,
              recovery_obligation.id
                AS external_recovery_critical_review_obligation_id,
              recovery_obligation.interface_family
                AS external_recovery_interface_family,
              recovery_obligation.source_occurred_at
                AS external_recovery_source_occurred_at,
              recovery_obligation.recorded_at
                AS external_recovery_awareness_recorded_at,
              recovery_acknowledgement.id
                AS external_recovery_critical_review_acknowledgement_id,
              recovery_acknowledgement.recorded_at
                AS external_recovery_awareness_acknowledged_at,
              (
                recovery_obligation.id IS NOT NULL
                AND recovery_acknowledgement.id IS NULL
              ) AS external_recovery_awareness_acknowledgement_required,
              (
                pending_owner_action.id IS NOT NULL
                AND $5::boolean
                AND pending_handoff.handoff_state = 'result_available'
                AND pending_handoff.resolution_action_id IS NULL
                AND pending_handoff.resolved_at IS NULL
                AND pending_handoff.resolved_by_uid IS NULL
                AND pending_handoff.named_physician_uid = $2::uuid
                AND pending_tracking_task.status IN (
                  'open',
                  'in_progress',
                  'blocked',
                  'overdue'
                )
                AND authoritative_action.action_kind = 'doctor_disposition'
                AND authoritative_action.signature_id IS NOT NULL
                AND authoritative_action.actor_uid IS DISTINCT FROM
                      pending_handoff.named_physician_uid
                AND NOT EXISTS (
                  SELECT 1
                    FROM diagnostic_result_generations AS newer_generation
                   WHERE newer_generation.tenant_id = pending_generation.tenant_id
                     AND newer_generation.patient_uid = pending_generation.patient_uid
                     AND newer_generation.admission_id = pending_generation.admission_id
                     AND newer_generation.predecessor_generation_id =
                           pending_generation.id
                )
              ) AS can_cross_sign
         FROM (
           SELECT ${TASK_RETURNING}
             FROM tasks
            WHERE tenant_id = $1::uuid
              AND status IN ('open', 'in_progress', 'blocked', 'overdue')
              AND (
                assigned_to_uid = $2::uuid
                OR (
                  assigned_to_uid IS NULL
                  AND UPPER(BTRIM(assigned_to_role)) = $3::text
                )
                OR (
                  assigned_to_uid IS NULL
                  AND metadata->>'task_contract' = 'ward_medication_obligation_v1'
                  AND jsonb_typeof(metadata->'owner_role_codes') = 'array'
                  AND EXISTS (
                    SELECT 1
                      FROM jsonb_array_elements_text(
                        CASE
                          WHEN jsonb_typeof(metadata->'owner_role_codes') = 'array'
                            THEN metadata->'owner_role_codes'
                          ELSE '[]'::jsonb
                        END
                      )
                           AS canonical_owner(role_code)
                     WHERE UPPER(BTRIM(canonical_owner.role_code)) =
                           UPPER(BTRIM(assigned_to_role))
                  )
                  AND EXISTS (
                    SELECT 1
                      FROM jsonb_array_elements_text(
                        CASE
                          WHEN jsonb_typeof(metadata->'owner_role_codes') = 'array'
                            THEN metadata->'owner_role_codes'
                          ELSE '[]'::jsonb
                        END
                      )
                           AS declared_owner(role_code)
                     WHERE UPPER(BTRIM(declared_owner.role_code)) = $3::text
                  )
                )
                OR (
                  $6::boolean
                  AND assigned_to_uid IS NULL
                  AND UPPER(BTRIM(assigned_to_role)) = 'DOCTOR'
                  AND task_kind = 'review'
                  AND sla_completion_semantics = 'domain_evidence'
                  AND related_resource_type = 'mar_medication_exception_cases'
                  AND related_resource_id = metadata->>'exception_case_id'
                  AND metadata->>'task_contract' = 'mar_medication_exception_v1'
                  AND metadata->>'sla_key' = 'mar_medication_exception_review'
                  AND metadata->>'medication_administration_id' ~ '^[1-9][0-9]*$'
                  AND metadata->>'exception_kind' IN ('held', 'missed')
                  AND EXISTS (
                    SELECT 1
                      FROM mar_medication_exception_cases exception_case
                      JOIN workflow_sla_instances exception_sla
                        ON exception_sla.tenant_id = exception_case.tenant_id
                       AND exception_sla.id = exception_case.workflow_sla_instance_id
                     WHERE exception_case.tenant_id = tasks.tenant_id
                       AND exception_case.id::text = tasks.related_resource_id
                       AND exception_case.task_id = tasks.id
                       AND exception_case.status = 'open'
                       AND exception_case.assigned_prescriber_uid IS NULL
                       AND exception_sla.id = tasks.workflow_sla_instance_id
                       AND exception_sla.rule_code = 'mar_medication_exception_review'
                       AND exception_sla.source_table = 'mar_medication_exception_cases'
                       AND exception_sla.source_id = tasks.related_resource_id
                       AND exception_sla.completed_at IS NULL
                       AND exception_sla.status IN ('active', 'breached', 'escalated')
                   )
                 )
                OR (
                  $8::boolean
                  AND assigned_to_uid IS NOT NULL
                  AND assigned_to_role IS NULL
                  AND task_kind = 'review'
                  AND sla_completion_semantics = 'domain_evidence'
                  AND related_resource_type = 'mar_medication_exception_cases'
                  AND related_resource_id = metadata->>'exception_case_id'
                  AND metadata->>'task_contract' = 'mar_medication_exception_v1'
                  AND metadata->>'sla_key' = 'mar_medication_exception_review'
                  AND metadata->>'medication_administration_id' ~ '^[1-9][0-9]*$'
                  AND metadata->>'exception_kind' IN ('held', 'missed')
                  AND EXISTS (
                    SELECT 1
                      FROM mar_medication_exception_cases exception_case
                      JOIN workflow_sla_instances exception_sla
                        ON exception_sla.tenant_id = exception_case.tenant_id
                       AND exception_sla.id = exception_case.workflow_sla_instance_id
                     WHERE exception_case.tenant_id = tasks.tenant_id
                       AND exception_case.id::text = tasks.related_resource_id
                       AND exception_case.task_id = tasks.id
                       AND exception_case.status = 'open'
                       AND exception_case.assigned_prescriber_uid = tasks.assigned_to_uid
                       AND exception_sla.id = tasks.workflow_sla_instance_id
                       AND exception_sla.rule_code = 'mar_medication_exception_review'
                       AND exception_sla.source_table = 'mar_medication_exception_cases'
                       AND exception_sla.source_id = tasks.related_resource_id
                       AND exception_sla.assigned_user_uid = tasks.assigned_to_uid
                       AND exception_sla.completed_at IS NULL
                       AND exception_sla.status IN ('active', 'breached', 'escalated')
                  )
                )
                OR (
                  $7::boolean
                  AND assigned_to_uid IS NULL
                  AND UPPER(BTRIM(assigned_to_role)) = 'PHARMACIST'
                  AND task_kind = 'review'
                  AND sla_completion_semantics = 'domain_evidence'
                  AND related_resource_type = 'cath_case_consumable_usage'
                  AND related_resource_id = metadata->>'cath_consumable_usage_id'
                  AND metadata->>'task_contract' = 'cath_inventory_shortfall_v1'
                  AND metadata->>'sla_key' = 'cath_consumable_inventory_reconciliation'
                  AND metadata->>'cath_case_id' ~ '^[1-9][0-9]*$'
                  AND metadata->>'inventory_item_id' ~ '^[1-9][0-9]*$'
                  AND metadata->>'movement_kind' IN ('issue', 'dispose')
                  AND EXISTS (
                    SELECT 1
                      FROM cath_case_consumable_usage cath_usage
                      JOIN workflow_sla_instances cath_sla
                        ON cath_sla.tenant_id = cath_usage.tenant_id
                       AND cath_sla.id = tasks.workflow_sla_instance_id
                     WHERE cath_usage.tenant_id = tasks.tenant_id
                       AND cath_usage.id::text = tasks.related_resource_id
                       AND cath_usage.case_id::text = tasks.metadata->>'cath_case_id'
                       AND cath_usage.patient_uid = tasks.patient_uid
                       AND cath_usage.inventory_decrement_status = 'insufficient_stock'
                       AND cath_sla.rule_code = 'cath_consumable_inventory_reconciliation'
                       AND cath_sla.source_table = 'cath_case_consumable_usage'
                       AND cath_sla.source_id = tasks.related_resource_id
                       AND cath_sla.completed_at IS NULL
                       AND cath_sla.status IN ('active', 'breached', 'escalated')
                   )
                 )
                OR (
                  $8::boolean
                  AND assigned_to_uid IS NULL
                  AND UPPER(BTRIM(assigned_to_role)) = 'ADMIN'
                  AND task_kind = 'escalation'
                  AND sla_completion_semantics = 'domain_evidence'
                  AND related_resource_type = 'clinical_alert_delivery_recovery_cases'
                  AND metadata->>'task_contract' =
                        'clinical_alert_delivery_recovery_v1'
                  AND related_resource_id ~ '^[1-9][0-9]*$'
                  AND metadata->>'case_kind' IN (
                    'manual_hold',
                    'recipient_coverage'
                  )
                  AND EXISTS (
                    SELECT 1
                      FROM clinical_alert_delivery_recovery_cases recovery_case
                      JOIN workflow_sla_instances recovery_sla
                        ON recovery_sla.tenant_id = recovery_case.tenant_id
                       AND recovery_sla.id = recovery_case.workflow_sla_instance_id
                     WHERE recovery_case.tenant_id = tasks.tenant_id
                       AND recovery_case.id::text = tasks.related_resource_id
                       AND recovery_case.task_id = tasks.id
                       AND recovery_case.status = 'open'
                       AND recovery_sla.id = tasks.workflow_sla_instance_id
                       AND recovery_sla.source_table =
                             'clinical_alert_delivery_recovery_cases'
                       AND recovery_sla.source_id = tasks.related_resource_id
                       AND recovery_sla.completed_at IS NULL
                       AND recovery_sla.status IN (
                         'active',
                         'breached',
                         'escalated'
                       )
                   )
                 )
              )
         ) AS inbox
         LEFT JOIN workflow_steps AS step
           ON step.tenant_id = inbox.tenant_id
          AND step.id = inbox.workflow_step_id
          AND step.workflow_run_id = inbox.workflow_run_id
         LEFT JOIN care_pathway_instances AS pathway
           ON pathway.tenant_id = inbox.tenant_id
          AND pathway.workflow_run_id = inbox.workflow_run_id
         LEFT JOIN diagnostic_result_generations AS pathway_generation
           ON pathway_generation.tenant_id = pathway.tenant_id
          AND pathway.pathway_key = 'diagnostics_order_to_action'
          AND pathway.source_episode_type = 'diagnostic_result_generation'
          AND pathway_generation.id::text = pathway.source_episode_id
         LEFT JOIN diagnostic_result_generations AS direct_generation
           ON direct_generation.tenant_id = inbox.tenant_id
           AND inbox.related_resource_type = 'diagnostic_result_generation'
           AND direct_generation.id::text = inbox.related_resource_id
         LEFT JOIN discharge_pending_result_owner_actions AS pending_owner_action
           ON pending_owner_action.tenant_id = inbox.tenant_id
          AND pending_owner_action.task_id = inbox.id
          AND inbox.related_resource_type = 'discharge_pending_result_action'
          AND NOT EXISTS (
            SELECT 1
              FROM discharge_pending_result_owner_actions AS successor
             WHERE successor.tenant_id = pending_owner_action.tenant_id
               AND successor.handoff_id = pending_owner_action.handoff_id
               AND successor.predecessor_owner_action_id =
                     pending_owner_action.id
          )
         LEFT JOIN discharge_pending_result_handoffs AS pending_handoff
           ON pending_handoff.tenant_id = pending_owner_action.tenant_id
          AND pending_handoff.id = pending_owner_action.handoff_id
          AND pending_handoff.admission_id = pending_owner_action.admission_id
          AND pending_handoff.patient_uid = pending_owner_action.patient_uid
          AND pending_handoff.named_physician_uid = pending_owner_action.owner_uid
         LEFT JOIN tasks AS pending_tracking_task
           ON pending_tracking_task.tenant_id = pending_handoff.tenant_id
          AND pending_tracking_task.id = pending_handoff.task_id
          AND pending_tracking_task.patient_uid = pending_handoff.patient_uid
          AND pending_tracking_task.related_resource_type =
                'discharge_pending_result_handoff'
          AND pending_tracking_task.related_resource_id =
                pending_handoff.id::text
          AND pending_tracking_task.assigned_to_uid =
                pending_handoff.named_physician_uid
          AND pending_tracking_task.assigned_to_role IS NULL
         LEFT JOIN diagnostic_result_generations AS pending_generation
           ON pending_generation.tenant_id = pending_owner_action.tenant_id
          AND pending_generation.id = pending_owner_action.generation_id
          AND pending_generation.patient_uid = pending_owner_action.patient_uid
          AND pending_generation.admission_id = pending_owner_action.admission_id
         LEFT JOIN LATERAL (
           SELECT action.id,
                  action.action_kind,
                  action.disposition,
                  action.actor_uid,
                  action.signature_id,
                  action.occurred_at
             FROM diagnostic_result_actions AS action
            WHERE action.tenant_id = pending_owner_action.tenant_id
              AND action.generation_id = pending_owner_action.generation_id
              AND action.patient_uid = pending_owner_action.patient_uid
              AND (
                (
                  action.action_kind = 'doctor_disposition'
                  AND action.signature_id IS NOT NULL
                )
                OR action.action_kind = 'normal_auto_closed'
              )
            ORDER BY
              CASE action.action_kind
                WHEN 'doctor_disposition' THEN 0
                ELSE 1
              END,
              action.occurred_at DESC,
              action.id DESC
            LIMIT 1
         ) AS authoritative_action ON pending_owner_action.id IS NOT NULL
         LEFT JOIN external_recovery_critical_review_obligations
           AS recovery_obligation
           ON recovery_obligation.tenant_id = inbox.tenant_id
          AND recovery_obligation.task_id = inbox.id
         LEFT JOIN external_recovery_critical_review_acknowledgements
           AS recovery_acknowledgement
           ON recovery_acknowledgement.tenant_id = recovery_obligation.tenant_id
          AND recovery_acknowledgement.obligation_id = recovery_obligation.id
       ORDER BY
         CASE inbox.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
         inbox.due_at NULLS LAST,
         inbox.created_at DESC
       LIMIT $4`,
      tid,
      actor.uid,
      actor.queueRole,
      safeLimit,
      isInpatientPendingResultPhysicianRole(actor.role),
      isExactMarMedicationExceptionPrescriberRawRole(actor.rawRole),
      isCathInventoryShortfallOperatorRole(actor.role),
      isAdmin(actor.role),
    );
    return { tasks: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { tasks: [], count: 0 };
    throw err;
  }
}

export async function settleCoveringTransferReviewTaskTx({
  tenantId = null,
  id,
  handoffId,
  recipientUid,
  actorUid,
  outcome,
  reason = null,
  tx,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  if (!tx) {
    throw AppError.internal(
      'Covering-transfer task settlement requires a transaction',
      'COVERING_TRANSFER_TASK_TX_REQUIRED',
    );
  }
  const taskId = normalizeId(id, 'task id');
  const cleanHandoffId = maybeUuid(handoffId, 'handoff_id');
  const cleanRecipientUid = maybeUuid(recipientUid, 'recipient_uid');
  const cleanActorUid = requireActorUid(actorUid);
  const cleanOutcome = normalizeEnum(
    outcome,
    ['accepted', 'declined', 'cancelled'],
    'outcome',
    { required: true },
  );
  const cleanReason = safeText(reason, TEXT_MAX);
  if (cleanOutcome !== 'accepted' && !cleanReason) {
    throw AppError.badRequest(
      'A reason is required to close a covering-transfer task',
      'COVERING_TRANSFER_TASK_REASON_REQUIRED',
    );
  }

  const current = await getTaskForUpdate({ tenantId: tid, id: taskId, db: tx });
  assertGenericTaskMutationAllowed(current, COVERING_TRANSFER_TASK_AUTHORITY);
  const bindings = await tx.$queryRawUnsafe(
    `SELECT chi.id
       FROM care_handoff_instances chi
       JOIN tasks task
         ON task.tenant_id = chi.tenant_id
        AND task.id = chi.task_id
      WHERE chi.tenant_id = $1::uuid
        AND chi.id = $2::uuid
        AND chi.task_id = $3::bigint
        AND chi.intended_recipient_uid = $4::uuid
        AND chi.handoff_type = 'covering_clinician_reassignment'
        AND chi.status = 'requested'
        AND task.patient_uid = chi.patient_uid
        AND task.workflow_run_id IS NULL
        AND task.workflow_step_id IS NULL
        AND task.task_kind = 'pathway_owner_transfer_review'
        AND task.related_resource_type = 'care_handoff_instance'
        AND task.related_resource_id = chi.id::text
        AND task.assigned_to_uid = chi.intended_recipient_uid
        AND task.assigned_to_role IS NULL
        AND task.workflow_sla_instance_id IS NULL
        AND task.sla_completion_semantics = 'none'
      LIMIT 1
      FOR SHARE`,
    tid,
    cleanHandoffId,
    taskId,
    cleanRecipientUid,
  );
  if (
    !bindings[0]
    || current.workflow_run_id !== null
    || current.workflow_step_id !== null
    || String(current.patient_uid || '') === ''
    || current.related_resource_type !== 'care_handoff_instance'
    || String(current.related_resource_id || '').toLowerCase() !== cleanHandoffId.toLowerCase()
    || String(current.assigned_to_uid || '').toLowerCase() !== cleanRecipientUid.toLowerCase()
    || current.assigned_to_role !== null
    || current.workflow_sla_instance_id !== null
    || current.sla_completion_semantics !== 'none'
    || !TASK_CLAIMABLE_STATUSES.has(current.status)
  ) {
    throw AppError.conflict(
      'Covering-transfer review task binding is invalid',
      'COVERING_TRANSFER_TASK_BINDING_INVALID',
    );
  }

  const nextStatus = cleanOutcome === 'accepted' ? 'completed' : 'cancelled';
  const settledAt = new Date().toISOString();
  const rows = await tx.$queryRawUnsafe(
    `UPDATE tasks
        SET status = $3::text,
            completed_at = CASE WHEN $3::text = 'completed' THEN $4::timestamptz ELSE NULL END,
            cancelled_at = CASE WHEN $3::text = 'cancelled' THEN $4::timestamptz ELSE NULL END,
            cancellation_reason = CASE WHEN $3::text = 'cancelled' THEN $5::text ELSE NULL END,
            metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'covering_transfer_outcome', $6::text,
                   'covering_transfer_settled_by', $7::text,
                   'covering_transfer_settled_at', $4::text
                 ),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status = $8::text
      RETURNING ${TASK_RETURNING}`,
    tid,
    taskId,
    nextStatus,
    settledAt,
    cleanReason,
    cleanOutcome,
    cleanActorUid,
    current.status,
  );
  const settled = rows[0];
  if (!settled) {
    throw AppError.conflict(
      'Covering-transfer review task changed before settlement',
      'COVERING_TRANSFER_TASK_CAS_CONFLICT',
    );
  }
  await postTaskComment({
    tenantId: tid,
    taskId,
    authorUid: cleanActorUid,
    body: `Covering clinician transfer ${cleanOutcome}`,
    bodyKind: 'state_change',
    metadata: {
      from: current.status,
      to: nextStatus,
      outcome: cleanOutcome,
      handoff_id: cleanHandoffId,
      ...(cleanReason ? { reason: cleanReason } : {}),
    },
    tx,
  });
  return settled;
}

export async function settleOpInpatientTransferReviewTaskTx({
  tenantId = null,
  id,
  handoffId,
  pathwayInstanceId,
  appointmentId,
  patientUid,
  requestFingerprint,
  recipientUid,
  actorUid,
  tx,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  if (!tx) {
    throw AppError.internal(
      'OP-to-inpatient transfer task settlement requires a transaction',
      'OP_INPATIENT_TRANSFER_TASK_TX_REQUIRED',
    );
  }
  const taskId = normalizeId(id, 'task id');
  const cleanHandoffId = maybeUuid(handoffId, 'handoff_id');
  const cleanPathwayInstanceId = maybeUuid(pathwayInstanceId, 'pathway_instance_id');
  const cleanAppointmentId = normalizeId(appointmentId, 'appointment_id');
  const cleanPatientUid = maybeUuid(patientUid, 'patient_uid');
  const cleanRecipientUid = maybeUuid(recipientUid, 'recipient_uid');
  const cleanActorUid = requireActorUid(actorUid);
  const cleanFingerprint = safeText(requestFingerprint, 64);
  if (!/^[0-9a-f]{64}$/.test(cleanFingerprint || '')) {
    throw AppError.badRequest(
      'request_fingerprint must be a SHA-256 digest',
      'OP_INPATIENT_TRANSFER_TASK_FINGERPRINT_INVALID',
    );
  }

  const current = await getTaskForUpdate({ tenantId: tid, id: taskId, db: tx });
  assertGenericTaskMutationAllowed(current, OP_INPATIENT_TRANSFER_TASK_AUTHORITY);
  const bindings = await tx.$queryRawUnsafe(
    `SELECT handoff.id
       FROM care_handoff_instances AS handoff
       JOIN tasks AS task
         ON task.tenant_id = handoff.tenant_id
        AND task.id = handoff.task_id
      WHERE handoff.tenant_id = $1::uuid
        AND handoff.id = $2::uuid
        AND handoff.sending_pathway_instance_id = $3::uuid
        AND handoff.source_resource_type = 'appointment'
        AND handoff.source_resource_id = $4::integer::text
        AND handoff.patient_uid = $5::uuid
        AND handoff.intended_recipient_uid = $6::uuid
        AND handoff.accepted_by_uid IS NULL
        AND handoff.handoff_type = 'op_to_inpatient_transfer'
        AND handoff.status = 'requested'
        AND handoff.task_id = $7::bigint
        AND handoff.request_fingerprint = $8::char(64)
        AND task.patient_uid = handoff.patient_uid
        AND task.workflow_run_id IS NULL
        AND task.workflow_step_id IS NULL
        AND task.task_kind = 'op_to_inpatient_transfer_review'
        AND task.related_resource_type = 'care_handoff_instance'
        AND task.related_resource_id = handoff.id::text
        AND task.assigned_to_uid = handoff.intended_recipient_uid
        AND task.assigned_to_role IS NULL
        AND task.due_at IS NULL
        AND task.workflow_sla_instance_id IS NULL
        AND task.sla_completion_semantics = 'none'
        AND task.metadata ->> 'task_contract' =
              'op_to_inpatient_transfer_review_v1'
        AND task.metadata ->> 'care_pathway_instance_id' =
              handoff.sending_pathway_instance_id::text
        AND task.metadata ->> 'source_appointment_id' =
              handoff.source_resource_id
        AND task.metadata ->> 'request_fingerprint' =
              handoff.request_fingerprint::text
      LIMIT 1
      FOR SHARE OF handoff`,
    tid,
    cleanHandoffId,
    cleanPathwayInstanceId,
    cleanAppointmentId,
    cleanPatientUid,
    cleanRecipientUid,
    taskId,
    cleanFingerprint,
  );
  if (
    !bindings[0]
    || current.workflow_run_id !== null
    || current.workflow_step_id !== null
    || String(current.patient_uid || '').toLowerCase() !== cleanPatientUid.toLowerCase()
    || current.task_kind !== 'op_to_inpatient_transfer_review'
    || current.related_resource_type !== 'care_handoff_instance'
    || String(current.related_resource_id || '').toLowerCase() !== cleanHandoffId.toLowerCase()
    || String(current.assigned_to_uid || '').toLowerCase() !== cleanRecipientUid.toLowerCase()
    || current.assigned_to_role !== null
    || current.due_at !== null
    || current.workflow_sla_instance_id !== null
    || current.sla_completion_semantics !== 'none'
    || current.metadata?.task_contract !== OP_INPATIENT_TRANSFER_TASK_CONTRACT
    || String(current.metadata?.care_pathway_instance_id || '').toLowerCase()
      !== cleanPathwayInstanceId.toLowerCase()
    || String(current.metadata?.source_appointment_id || '') !== String(cleanAppointmentId)
    || String(current.metadata?.request_fingerprint || '') !== cleanFingerprint
    || !TASK_CLAIMABLE_STATUSES.has(current.status)
  ) {
    throw AppError.conflict(
      'OP-to-inpatient transfer review task binding is invalid',
      'OP_INPATIENT_TRANSFER_TASK_BINDING_INVALID',
    );
  }

  const settledAt = new Date().toISOString();
  const rows = await tx.$queryRawUnsafe(
    `UPDATE tasks
        SET status = 'completed',
            completed_at = $3::timestamptz,
            cancelled_at = NULL,
            cancellation_reason = NULL,
            metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'op_inpatient_transfer_outcome', 'accepted',
                   'op_inpatient_transfer_settled_by', $4::text,
                   'op_inpatient_transfer_settled_at', $3::text
                 ),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status = $5::text
        AND task_kind = 'op_to_inpatient_transfer_review'
        AND workflow_run_id IS NULL
        AND workflow_step_id IS NULL
        AND patient_uid = $6::uuid
        AND related_resource_type = 'care_handoff_instance'
        AND related_resource_id = $7::uuid::text
        AND assigned_to_uid = $4::uuid
        AND assigned_to_role IS NULL
        AND due_at IS NULL
        AND workflow_sla_instance_id IS NULL
        AND sla_completion_semantics = 'none'
      RETURNING ${TASK_RETURNING}`,
    tid,
    taskId,
    settledAt,
    cleanActorUid,
    current.status,
    cleanPatientUid,
    cleanHandoffId,
  );
  const settled = rows[0];
  if (!settled) {
    throw AppError.conflict(
      'OP-to-inpatient transfer review task changed before settlement',
      'OP_INPATIENT_TRANSFER_TASK_CAS_CONFLICT',
    );
  }
  await postTaskComment({
    tenantId: tid,
    taskId,
    authorUid: cleanActorUid,
    body: 'OP-to-inpatient transfer accepted',
    bodyKind: 'state_change',
    metadata: {
      from: current.status,
      to: 'completed',
      outcome: 'accepted',
      handoff_id: cleanHandoffId,
      appointment_id: cleanAppointmentId,
      care_pathway_instance_id: cleanPathwayInstanceId,
    },
    tx,
  });
  return settled;
}

export async function settleEdDestinationHandoffReviewTaskTx({
  tenantId = null,
  id,
  handoffId,
  pathwayInstanceId,
  emergencyVisitId,
  patientUid,
  encounterId,
  requestFingerprint,
  recipientRole,
  actorUid,
  outcome,
  reason = null,
  tx,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  if (!tx) {
    throw AppError.internal(
      'ED destination task settlement requires a transaction',
      'ED_DESTINATION_HANDOFF_TASK_TX_REQUIRED',
    );
  }
  const taskId = normalizeId(id, 'task id');
  const cleanHandoffId = maybeUuid(handoffId, 'handoff_id');
  const cleanPathwayInstanceId = maybeUuid(pathwayInstanceId, 'pathway_instance_id');
  const cleanVisitId = normalizeId(emergencyVisitId, 'emergency_visit_id');
  const cleanPatientUid = maybeUuid(patientUid, 'patient_uid');
  const cleanEncounterId = maybeUuid(encounterId, 'encounter_id');
  const cleanFingerprint = safeText(requestFingerprint, 64);
  const cleanRecipientRole = safeText(recipientRole, 80);
  const cleanActorUid = requireActorUid(actorUid);
  const cleanOutcome = normalizeEnum(outcome, ['accepted', 'declined'], 'outcome', {
    required: true,
  });
  const cleanReason = safeText(reason, 2000);
  if (!/^[0-9a-f]{64}$/.test(cleanFingerprint || '')) {
    throw AppError.badRequest(
      'request_fingerprint must be a SHA-256 digest',
      'ED_DESTINATION_HANDOFF_TASK_FINGERPRINT_INVALID',
    );
  }
  if (!/^[A-Z][A-Z0-9_]{1,79}$/.test(cleanRecipientRole || '')) {
    throw AppError.badRequest(
      'recipient_role is invalid',
      'ED_DESTINATION_HANDOFF_TASK_ROLE_INVALID',
    );
  }
  if (cleanOutcome === 'declined' && !cleanReason) {
    throw AppError.badRequest(
      'A decline reason is required',
      'ED_DESTINATION_HANDOFF_DECLINE_REASON_REQUIRED',
    );
  }

  const current = await getTaskForUpdate({ tenantId: tid, id: taskId, db: tx });
  assertGenericTaskMutationAllowed(current, ED_DESTINATION_HANDOFF_TASK_AUTHORITY);
  const bindings = await tx.$queryRawUnsafe(
    `SELECT handoff.id
       FROM care_handoff_instances AS handoff
       JOIN tasks AS task
         ON task.tenant_id = handoff.tenant_id
        AND task.id = handoff.task_id
      WHERE handoff.tenant_id = $1::uuid
        AND handoff.id = $2::uuid
        AND handoff.sending_pathway_instance_id = $3::uuid
        AND handoff.source_resource_type = 'emergency_visit'
        AND handoff.source_resource_id = $4::integer::text
        AND handoff.patient_uid = $5::uuid
        AND handoff.intended_recipient_role = $6::text
        AND handoff.accepted_by_uid IS NULL
        AND handoff.handoff_type = 'ed_destination_handoff'
        AND handoff.status = 'requested'
        AND handoff.task_id = $7::bigint
        AND handoff.request_fingerprint = $8::char(64)
        AND task.patient_uid = handoff.patient_uid
        AND task.encounter_id IS NULL
        AND task.workflow_run_id IS NULL
        AND task.workflow_step_id IS NULL
        AND task.task_kind = 'ed_destination_handoff_review'
        AND task.related_resource_type = 'care_handoff_instance'
        AND task.related_resource_id = handoff.id::text
        AND task.assigned_to_uid IS NULL
        AND task.assigned_to_role = handoff.intended_recipient_role
        AND task.due_at IS NULL
        AND task.workflow_sla_instance_id IS NULL
        AND task.sla_completion_semantics = 'none'
        AND task.metadata ->> 'task_contract' =
              'ed_destination_handoff_review_v1'
        AND task.metadata ->> 'care_pathway_instance_id' =
              handoff.sending_pathway_instance_id::text
        AND task.metadata ->> 'emergency_visit_id' =
              handoff.source_resource_id
        AND task.metadata ->> 'canonical_encounter_id' =
              $9::uuid::text
        AND task.metadata ->> 'request_fingerprint' =
              handoff.request_fingerprint::text
      LIMIT 1
      FOR SHARE OF handoff`,
    tid,
    cleanHandoffId,
    cleanPathwayInstanceId,
    cleanVisitId,
    cleanPatientUid,
    cleanRecipientRole,
    taskId,
    cleanFingerprint,
    cleanEncounterId,
  );
  if (
    !bindings[0]
    || current.workflow_run_id !== null
    || current.workflow_step_id !== null
    || String(current.patient_uid || '').toLowerCase() !== cleanPatientUid.toLowerCase()
    || current.encounter_id !== null
    || current.task_kind !== 'ed_destination_handoff_review'
    || current.related_resource_type !== 'care_handoff_instance'
    || String(current.related_resource_id || '').toLowerCase() !== cleanHandoffId.toLowerCase()
    || current.assigned_to_uid !== null
    || current.assigned_to_role !== cleanRecipientRole
    || current.due_at !== null
    || current.workflow_sla_instance_id !== null
    || current.sla_completion_semantics !== 'none'
    || current.metadata?.task_contract !== ED_DESTINATION_HANDOFF_TASK_CONTRACT
    || String(current.metadata?.care_pathway_instance_id || '').toLowerCase()
      !== cleanPathwayInstanceId.toLowerCase()
    || String(current.metadata?.emergency_visit_id || '') !== String(cleanVisitId)
    || String(current.metadata?.canonical_encounter_id || '').toLowerCase()
      !== cleanEncounterId.toLowerCase()
    || String(current.metadata?.request_fingerprint || '') !== cleanFingerprint
    || !TASK_CLAIMABLE_STATUSES.has(current.status)
  ) {
    throw AppError.conflict(
      'ED destination review task binding is invalid',
      'ED_DESTINATION_HANDOFF_TASK_BINDING_INVALID',
    );
  }

  const settledAt = new Date().toISOString();
  const nextStatus = cleanOutcome === 'accepted' ? 'completed' : 'cancelled';
  const rows = await tx.$queryRawUnsafe(
    `UPDATE tasks
        SET status = $3::text,
            completed_at = CASE
              WHEN $3::text = 'completed' THEN $4::timestamptz
              ELSE NULL
            END,
            cancelled_at = CASE
              WHEN $3::text = 'cancelled' THEN $4::timestamptz
              ELSE NULL
            END,
            cancellation_reason = CASE
              WHEN $3::text = 'cancelled' THEN $5::text
              ELSE NULL
            END,
            metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'ed_destination_handoff_outcome', $6::text,
                   'ed_destination_handoff_settled_by', $7::text,
                   'ed_destination_handoff_settled_at', $4::text
                 ),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status = $8::text
        AND task_kind = 'ed_destination_handoff_review'
        AND workflow_run_id IS NULL
        AND workflow_step_id IS NULL
        AND patient_uid = $9::uuid
        AND encounter_id IS NULL
        AND related_resource_type = 'care_handoff_instance'
        AND related_resource_id = $10::uuid::text
        AND assigned_to_uid IS NULL
        AND assigned_to_role = $11::text
        AND due_at IS NULL
        AND workflow_sla_instance_id IS NULL
        AND sla_completion_semantics = 'none'
      RETURNING ${TASK_RETURNING}`,
    tid,
    taskId,
    nextStatus,
    settledAt,
    cleanReason,
    cleanOutcome,
    cleanActorUid,
    current.status,
    cleanPatientUid,
    cleanHandoffId,
    cleanRecipientRole,
  );
  const settled = rows[0];
  if (!settled) {
    throw AppError.conflict(
      'ED destination review task changed before settlement',
      'ED_DESTINATION_HANDOFF_TASK_CAS_CONFLICT',
    );
  }
  await postTaskComment({
    tenantId: tid,
    taskId,
    authorUid: cleanActorUid,
    body: `ED destination handoff ${cleanOutcome}`,
    bodyKind: 'state_change',
    metadata: {
      from: current.status,
      to: nextStatus,
      outcome: cleanOutcome,
      handoff_id: cleanHandoffId,
      emergency_visit_id: cleanVisitId,
      care_pathway_instance_id: cleanPathwayInstanceId,
      ...(cleanReason ? { reason: cleanReason } : {}),
    },
    tx,
  });
  return settled;
}

// Role codes a task may be (re)assigned to. Use the authoritative human staff
// roster rather than the legacy ROLES constants: the latter omits valid queues
// such as COMPLIANCE_OFFICER and includes non-human principals such as PATIENT
// and DEVICE_GATEWAY. TENANT_ADMIN remains an explicit system recovery queue
// used by the external integration recovery services.
const ASSIGNABLE_TASK_ROLE_CODES = new Set([
  ...getStaffRosterRoleCodes({ includeAdmin: true }),
  'TENANT_ADMIN',
]);

function requireAssignableTaskRole(role) {
  const canonical = normalizeRole(role);
  if (!canonical || !ASSIGNABLE_TASK_ROLE_CODES.has(canonical)) {
    throw AppError.badRequest(
      'assigned_to_role must be a known role code',
      'TASK_ASSIGNMENT_ROLE_UNKNOWN',
    );
  }
  return canonical;
}

export async function reassignTask({
  tenantId = null, id, assignedToUid, assignedToRole,
  executorAuthority = null,
  pendingResultTaskTransferAuthority = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const taskId = normalizeId(id, 'task id');
  const db = tx || prisma;
  if (assignedToUid === undefined && assignedToRole === undefined) {
    throw AppError.badRequest(
      'Task reassignment requires a user or role field',
      'TASK_ASSIGNMENT_REQUIRED',
    );
  }
  const assignment = normalizeTaskAssignment({ assignedToUid, assignedToRole });
  if (assignment.role) {
    // Store the canonical uppercase code so queue-role matching stays exact.
    assignment.role = requireAssignableTaskRole(assignment.role);
  }
  const updates = [
    'assigned_to_uid = $1::uuid',
    'assigned_to_role = $2',
    'updated_at = NOW()',
  ];
  const params = [assignment.uid, assignment.role];
  if (!tx) {
    return setTenantTx(tid, (scopedTx) => reassignTask({
      tenantId: tid,
      id: taskId,
      assignedToUid,
      assignedToRole,
      executorAuthority,
      pendingResultTaskTransferAuthority,
      tx: scopedTx,
    }));
  }
  const current = await getTaskForUpdate({ tenantId: tid, id: taskId, db });
  assertGovernedClinicalTaskReassignmentAllowed(current);
  assertGenericTaskMutationAllowed(current, pendingResultTaskTransferAuthority);
  const attachedRunId = await taskRowWorkflowRunId({ tenantId: tid, taskRow: current, db });
  await assertPathwayExecutorAuthority({
    tenantId: tid,
    workflowRunId: attachedRunId,
    db,
    executorAuthority,
  });
  params.push(taskId);
  params.push(tid);
  const rows = await db.$queryRawUnsafe(
    `UPDATE tasks SET ${updates.join(', ')}
     WHERE id = $${params.length - 1} AND tenant_id = $${params.length}::uuid
     RETURNING ${TASK_RETURNING}`,
    ...params,
  );
  if (!rows[0]) throw AppError.notFound('Task not found');
  // Mirror ownership onto the linked SLA instance so the mig-269 clock and the
  // task never disagree about who is accountable. Terminal instances
  // (completed_at set) are historical record and stay untouched.
  if (current.workflow_sla_instance_id) {
    await db.$executeRawUnsafe(
      `UPDATE workflow_sla_instances
          SET assigned_user_uid = $1::uuid,
              assigned_role_codes = CASE
                WHEN $2::text IS NULL THEN ARRAY[]::text[]
                ELSE ARRAY[$2::text]
              END,
              updated_at = NOW()
        WHERE id = $3::uuid
          AND tenant_id = $4::uuid
          AND completed_at IS NULL`,
      assignment.uid,
      assignment.role,
      current.workflow_sla_instance_id,
      tid,
    );
  }
  return rows[0];
}

export async function postTaskComment({
  tenantId = null, taskId,
  authorUid = null, body, bodyKind = 'comment',
  metadata = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanTaskId = normalizeId(taskId, 'task_id');
  const cleanBody = safeText(body);
  if (!cleanBody) throw AppError.badRequest('body is required');
  const db = tx || prisma;
  try {
    const rows = await db.$queryRawUnsafe(
      `INSERT INTO task_comments
         (tenant_id, task_id, author_uid, body, body_kind, metadata)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::jsonb)
       RETURNING id, tenant_id, task_id, author_uid, body, body_kind, metadata, created_at`,
      tid, cleanTaskId, maybeUuid(authorUid, 'author_uid'),
      cleanBody,
      normalizeEnum(bodyKind, TASK_COMMENT_KINDS, 'body_kind') || 'comment',
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid task_id');
    throw err;
  }
}

export async function listTaskComments({
  tenantId = null, taskId, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanTaskId = normalizeId(taskId, 'task_id');
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, task_id, author_uid, body, body_kind, metadata, created_at
       FROM task_comments
       WHERE tenant_id = $1::uuid AND task_id = $2
       ORDER BY created_at ASC
       LIMIT $3`,
      tid, cleanTaskId, safeLimit,
    );
    return { comments: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { comments: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Workflow definitions
// ---------------------------------------------------------------------------

const WORKFLOW_DEF_RETURNING = `id, tenant_id, workflow_key, version, display_name,
  description, category, steps, triggers, defaults, is_active,
  created_by, created_at, updated_at`;

export async function createWorkflowDefinition({
  tenantId = null,
  workflowKey,
  version = 1,
  displayName = null,
  description = null,
  category = null,
  steps = null,
  triggers = null,
  defaults = null,
  isActive = false,
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanKey = safeText(workflowKey, 120);
  if (!cleanKey) throw AppError.badRequest('workflow_key is required');
  const cleanVersion = normalizeInt(version, 'version', { min: 1, max: 1000 }) || 1;
  const normalizedSteps = validateWorkflowDefinitionSteps(steps);
  const normalizedTriggers = normalizeJsonArray(triggers, 'triggers');
  if (normalizedTriggers.length > 0) {
    throw AppError.badRequest(
      'Workflow definition triggers are unavailable until registered handlers exist',
      'WORKFLOW_TRIGGER_ACTIVATION_UNAVAILABLE',
    );
  }
  const cleanIsActive = normalizeBoolean(isActive, false);
  if (cleanIsActive) {
    throw AppError.badRequest(
      'New workflow definitions must be inactive until governance activation is available',
      'WORKFLOW_DEFINITION_ACTIVATION_UNAVAILABLE',
    );
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO workflow_definitions
         (tenant_id, workflow_key, version, display_name, description, category,
          steps, triggers, defaults, is_active, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::uuid)
       RETURNING ${WORKFLOW_DEF_RETURNING}`,
      tid, cleanKey, cleanVersion,
      safeText(displayName, SHORT_MAX), safeText(description),
      safeText(category, 80),
      JSON.stringify(normalizedSteps),
      JSON.stringify(normalizedTriggers),
      JSON.stringify(normalizeJsonObject(defaults, 'defaults')),
      false,
      maybeUuid(createdBy, 'created_by'),
    );
    return rows[0];
  } catch (err) {
    if (/duplicate key value/i.test(String(err?.message || ''))) {
      throw AppError.conflict(`workflow_key/version pair already exists: ${cleanKey} v${cleanVersion}`);
    }
    throw err;
  }
}

export async function listWorkflowDefinitions({
  tenantId = null, isActive = null, category = null, limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (isActive !== null) {
    params.push(normalizeBoolean(isActive));
    filters.push(`is_active = $${params.length}`);
  }
  if (category) {
    params.push(safeText(category, 80));
    filters.push(`category = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${WORKFLOW_DEF_RETURNING} FROM workflow_definitions
       WHERE ${filters.join(' AND ')}
       ORDER BY workflow_key, version DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { definitions: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { definitions: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Workflow runs (start + transition)
// ---------------------------------------------------------------------------

const WORKFLOW_RUN_RETURNING = `id, tenant_id, workflow_definition_id, workflow_key, workflow_version,
  pathway_governance_id, pathway_definition_checksum,
  trigger_kind, trigger_payload, status, current_step_key, context,
  started_at, ended_at, due_at, initiated_by, failure_reason,
  metadata, created_at, updated_at`;

export async function startWorkflowRun({
  tenantId = null,
  workflowDefinitionId,
  triggerKind = 'manual',
  triggerPayload = null,
  context = null,
  dueAt = null,
  initiatedBy = null,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const defId = normalizeId(workflowDefinitionId, 'workflow_definition_id');
  const cleanInitiatedBy = requireActorUid(initiatedBy, 'initiated_by');
  try {
    return await setTenantTx(tid, async (tx) => {
      const definitions = await tx.$queryRawUnsafe(
        `SELECT definition.id, definition.workflow_key, definition.version,
                definition.steps, definition.triggers, definition.is_active,
                EXISTS (
                  SELECT 1
                    FROM care_pathway_definition_governance AS governance
                   WHERE governance.tenant_id = definition.tenant_id
                     AND governance.workflow_definition_id = definition.id
                ) AS has_pathway_governance
           FROM workflow_definitions AS definition
          WHERE definition.id = $1 AND definition.tenant_id = $2::uuid
         LIMIT 1
         FOR SHARE`,
        defId, tid,
      );
      if (!definitions[0]) throw AppError.notFound('Workflow definition not found');
      const definition = definitions[0];
      if (definition.has_pathway_governance === true) {
        throw AppError.conflict(
          'Governed care pathway definitions must be started through the pathway executor',
          'CARE_PATHWAY_DEFINITION_REQUIRES_PATHWAY_EXECUTOR',
        );
      }
      if (!definition.is_active) {
        throw AppError.badRequest('Workflow definition is inactive', 'INACTIVE_WORKFLOW_DEFINITION');
      }
      const normalizedSteps = validateWorkflowDefinitionSteps(definition.steps);
      const normalizedTriggers = normalizeJsonArray(definition.triggers, 'triggers');
      if (normalizedTriggers.length > 0) {
        throw AppError.badRequest(
          'Workflow definition contains unregistered triggers',
          'WORKFLOW_TRIGGER_ACTIVATION_UNAVAILABLE',
        );
      }

      const runRows = await tx.$queryRawUnsafe(
        `INSERT INTO workflow_runs
           (tenant_id, workflow_definition_id, workflow_key, workflow_version,
            trigger_kind, trigger_payload, status, context,
            due_at, initiated_by, metadata)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, 'started', $7::jsonb,
           to_timestamp($8::double precision / 1000.0), $9::uuid, $10::jsonb)
         RETURNING ${WORKFLOW_RUN_RETURNING}`,
        tid, definition.id, definition.workflow_key, definition.version,
        normalizeEnum(triggerKind, WORKFLOW_TRIGGER_KINDS, 'trigger_kind') || 'manual',
        JSON.stringify(normalizeJsonObject(triggerPayload, 'trigger_payload')),
        JSON.stringify(normalizeJsonObject(context, 'context')),
        normalizeTimestamp(dueAt, 'due_at'),
        cleanInitiatedBy,
        JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
      );
      const run = runRows[0];

      for (const [order, step] of normalizedSteps.entries()) {
        await tx.$queryRawUnsafe(
          `INSERT INTO workflow_steps
             (tenant_id, workflow_run_id, step_key, display_name, step_kind,
               status, ordering, assigned_role, due_at, metadata)
            VALUES ($1::uuid, $2, $3, $4, $5, 'pending', $6, $7,
              to_timestamp($8::double precision / 1000.0), $9::jsonb)`,
          tid, run.id, step.step_key,
          step.display_name,
          step.step_kind, order,
          step.assigned_role,
          normalizeTimestamp(step.due_at, `steps[${order}].due_at`),
          JSON.stringify(step.metadata),
        );
      }
      return run;
    });
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function listWorkflowRuns({
  tenantId = null, status = null, workflowKey = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, WORKFLOW_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (workflowKey) {
    params.push(safeText(workflowKey, 120));
    filters.push(`workflow_key = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${WORKFLOW_RUN_RETURNING} FROM workflow_runs
       WHERE ${filters.join(' AND ')}
       ORDER BY started_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { runs: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { runs: [], count: 0 };
    throw err;
  }
}

export async function transitionWorkflowRun({
  tenantId = null, id, nextStatus,
  failureReason = null, currentStepKey = null,
  actorUid = null,
  executorAuthority = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const runId = normalizeId(id, 'workflow_run id');
  const cleanStatus = normalizeEnum(nextStatus, WORKFLOW_STATUSES, 'next_status', { required: true });
  requireActorUid(actorUid);
  if (!tx) {
    return setTenantTx(tid, (scopedTx) => transitionWorkflowRun({
      tenantId: tid,
      id: runId,
      nextStatus: cleanStatus,
      failureReason,
      currentStepKey,
      actorUid,
      executorAuthority,
      tx: scopedTx,
    }));
  }
  const db = tx;
  await assertPathwayExecutorAuthority({
    tenantId: tid,
    workflowRunId: runId,
    db,
    executorAuthority,
  });
  const currentRows = await db.$queryRawUnsafe(
    `SELECT id, status FROM workflow_runs
     WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
    runId, tid,
  );
  if (!currentRows[0]) throw AppError.notFound('Workflow run not found');
  const currentStatus = currentRows[0].status;
  const allowed = WORKFLOW_RUN_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(cleanStatus)) {
    throw AppError.invalidTransition(currentStatus, cleanStatus, allowed);
  }
  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanStatus];
  if (currentStepKey !== null) {
    params.push(safeText(currentStepKey, 120));
    updates.push(`current_step_key = $${params.length}`);
  }
  if (cleanStatus === 'completed' || cleanStatus === 'failed' || cleanStatus === 'cancelled') {
    params.push(Date.now());
    updates.push(`ended_at = to_timestamp($${params.length}::double precision / 1000.0)`);
  }
  if (cleanStatus === 'failed' && failureReason) {
    params.push(safeText(failureReason));
    updates.push(`failure_reason = $${params.length}`);
  }
  params.push(runId);
  params.push(tid);
  params.push(currentStatus);
  const rows = await db.$queryRawUnsafe(
    `UPDATE workflow_runs SET ${updates.join(', ')}
     WHERE id = $${params.length - 2}
       AND tenant_id = $${params.length - 1}::uuid
       AND status = $${params.length}
     RETURNING ${WORKFLOW_RUN_RETURNING}`,
    ...params,
  );
  if (!rows[0]) {
    const latest = await db.$queryRawUnsafe(
      `SELECT id FROM workflow_runs
       WHERE id = $1 AND tenant_id = $2::uuid LIMIT 1`,
      runId, tid,
    );
    if (!latest[0]) throw AppError.notFound('Workflow run not found');
    throw AppError.conflict(
      'Workflow run status changed before transition completed',
      'WORKFLOW_RUN_TRANSITION_CONFLICT',
    );
  }
  return rows[0];
}

export async function listWorkflowSteps({ tenantId = null, workflowRunId } = {}) {
  const tid = resolveTenantId({ tenantId });
  const runId = normalizeId(workflowRunId, 'workflow_run_id');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, workflow_run_id, step_key, display_name, step_kind,
              status, ordering, assigned_to, assigned_role,
              due_at, started_at, completed_at, outcome, outcome_payload,
              metadata, created_at, updated_at
       FROM workflow_steps
       WHERE tenant_id = $1::uuid AND workflow_run_id = $2
       ORDER BY ordering, step_key`,
      tid, runId,
    );
    return { steps: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { steps: [], count: 0 };
    throw err;
  }
}

export async function transitionWorkflowStep({
  tenantId = null, workflowRunId, stepKey, nextStatus,
  outcome = null, outcomePayload = null,
  actorUid = null,
  executorAuthority = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const runId = normalizeId(workflowRunId, 'workflow_run_id');
  const cleanStatus = normalizeEnum(nextStatus, WORKFLOW_STEP_STATUSES, 'next_status', { required: true });
  requireActorUid(actorUid);
  const cleanStepKey = safeText(stepKey, 120);
  if (!cleanStepKey) throw AppError.badRequest('step_key is required');
  if (!tx) {
    return setTenantTx(tid, (scopedTx) => transitionWorkflowStep({
      tenantId: tid,
      workflowRunId: runId,
      stepKey: cleanStepKey,
      nextStatus: cleanStatus,
      outcome,
      outcomePayload,
      actorUid,
      executorAuthority,
      tx: scopedTx,
    }));
  }
  const db = tx;
  await assertPathwayExecutorAuthority({
    tenantId: tid,
    workflowRunId: runId,
    db,
    executorAuthority,
  });
  const currentRows = await db.$queryRawUnsafe(
    `SELECT id, status FROM workflow_steps
     WHERE workflow_run_id = $1 AND step_key = $2 AND tenant_id = $3::uuid LIMIT 1`,
    runId, cleanStepKey, tid,
  );
  if (!currentRows[0]) throw AppError.notFound('Workflow step not found');
  const currentStatus = currentRows[0].status;
  const allowed = WORKFLOW_STEP_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(cleanStatus)) {
    throw AppError.invalidTransition(currentStatus, cleanStatus, allowed);
  }
  const updates = ['status = $1', 'updated_at = NOW()'];
  const params = [cleanStatus];
  if (cleanStatus === 'in_progress') {
    params.push(Date.now());
    updates.push(`started_at = COALESCE(started_at, to_timestamp($${params.length}::double precision / 1000.0))`);
  }
  if (cleanStatus === 'completed' || cleanStatus === 'skipped' || cleanStatus === 'failed') {
    params.push(Date.now());
    updates.push(`completed_at = to_timestamp($${params.length}::double precision / 1000.0)`);
  }
  if (outcome) {
    params.push(safeText(outcome, 40));
    updates.push(`outcome = $${params.length}`);
  }
  if (outcomePayload) {
    params.push(JSON.stringify(normalizeJsonObject(outcomePayload, 'outcome_payload')));
    updates.push(`outcome_payload = $${params.length}::jsonb`);
  }
  params.push(runId);
  params.push(cleanStepKey);
  params.push(tid);
  params.push(currentStatus);
  const rows = await db.$queryRawUnsafe(
    `UPDATE workflow_steps SET ${updates.join(', ')}
     WHERE workflow_run_id = $${params.length - 3}
       AND step_key = $${params.length - 2}
       AND tenant_id = $${params.length - 1}::uuid
       AND status = $${params.length}
     RETURNING id, tenant_id, workflow_run_id, step_key, status, outcome, outcome_payload, completed_at`,
    ...params,
  );
  if (!rows[0]) {
    const latest = await db.$queryRawUnsafe(
      `SELECT id FROM workflow_steps
       WHERE workflow_run_id = $1 AND step_key = $2 AND tenant_id = $3::uuid LIMIT 1`,
      runId, cleanStepKey, tid,
    );
    if (!latest[0]) throw AppError.notFound('Workflow step not found');
    throw AppError.conflict(
      'Workflow step status changed before transition completed',
      'WORKFLOW_STEP_TRANSITION_CONFLICT',
    );
  }
  return rows[0];
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

const APPROVAL_RETURNING = `id, tenant_id, workflow_run_id, workflow_step_id, task_id,
  approval_kind, subject_resource_type, subject_resource_id,
  required_approvers, required_role, status, approved_by,
  rejection_reason, expires_at, decided_at,
  created_by, decided_by, materialization_key,
  metadata, created_at, updated_at`;

export async function createApproval({
  tenantId = null,
  workflowRunId = null,
  workflowStepId = null,
  taskId = null,
  approvalKind,
  subjectResourceType = null,
  subjectResourceId = null,
  requiredApprovers = 1,
  requiredRole = null,
  expiresAt = null,
  createdBy = null,
  materializationKey = null,
  metadata = null,
  executorAuthority = null,
  tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanKind = safeText(approvalKind, 80);
  if (!cleanKind) throw AppError.badRequest('approval_kind is required');
  assertGenericApprovalKindAllowed(cleanKind);
  const db = tx || prisma;
  const cleanWorkflowRunId = workflowRunId ? normalizeId(workflowRunId, 'workflow_run_id') : null;
  const cleanWorkflowStepId = workflowStepId ? normalizeId(workflowStepId, 'workflow_step_id') : null;
  const cleanTaskId = taskId ? normalizeId(taskId, 'task_id') : null;
  const verifiedExecutorAuthority = await hasPathwayExecutorAuthority(executorAuthority);
  if (!verifiedExecutorAuthority) {
    await assertPathwayExecutorAuthority({
      tenantId: tid,
      workflowRunId: cleanWorkflowRunId,
      db,
      executorAuthority,
      verifiedExecutorAuthority,
    });
    const attachedTaskRunId = await taskWorkflowRunId({ tenantId: tid, taskId: cleanTaskId, db });
    if (attachedTaskRunId && String(attachedTaskRunId) !== String(cleanWorkflowRunId || '')) {
      await assertPathwayExecutorAuthority({
        tenantId: tid,
        workflowRunId: attachedTaskRunId,
        db,
        executorAuthority,
      });
    }
    const attachedStepRunId = await stepWorkflowRunId({
      tenantId: tid,
      workflowStepId: cleanWorkflowStepId,
      db,
    });
    if (attachedStepRunId && String(attachedStepRunId) !== String(cleanWorkflowRunId || '')) {
      await assertPathwayExecutorAuthority({
        tenantId: tid,
        workflowRunId: attachedStepRunId,
        db,
        executorAuthority,
      });
    }
  }
  try {
    const rows = await db.$queryRawUnsafe(
      `INSERT INTO approvals
         (tenant_id, workflow_run_id, workflow_step_id, task_id,
           approval_kind, subject_resource_type, subject_resource_id,
           required_approvers, required_role, status, expires_at,
           created_by, materialization_key, metadata)
        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, 'pending',
          to_timestamp($10::double precision / 1000.0),
          $11::uuid, $12, $13::jsonb)
        RETURNING ${APPROVAL_RETURNING}`,
      tid,
      cleanWorkflowRunId,
      cleanWorkflowStepId,
      cleanTaskId,
      cleanKind,
      safeText(subjectResourceType, 60),
      safeText(subjectResourceId, 120),
      normalizeInt(requiredApprovers, 'required_approvers', { min: 1, max: 100 }) || 1,
      safeText(requiredRole, 80),
      normalizeTimestamp(expiresAt, 'expires_at'),
      maybeUuid(createdBy, 'created_by'),
      safeText(materializationKey, 200),
      JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
    );
    return rows[0];
  } catch (err) {
    if (isFkViolation(err)) throw AppError.badRequest('Invalid foreign key reference');
    throw err;
  }
}

export async function recordApprovalDecision({
  tenantId = null, id, actorUid, actorRoles = [], decision, rejectionReason = null,
  executorAuthority = null, tx = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const apId = normalizeId(id, 'approval id');
  const cleanApprover = requireActorUid(actorUid).toLowerCase();
  const roles = actorRolesUpper(actorRoles);
  if (decision !== 'approve' && decision !== 'reject') {
    throw AppError.badRequest('decision must be "approve" or "reject"');
  }
  if (!tx) {
    return setTenantTx(tid, (scopedTx) => recordApprovalDecision({
      tenantId: tid,
      id: apId,
      actorUid: cleanApprover,
      actorRoles,
      decision,
      rejectionReason,
      executorAuthority,
      tx: scopedTx,
    }));
  }

  const current = await tx.$queryRawUnsafe(
      `SELECT id, status, approval_kind, approved_by, required_approvers, required_role,
              workflow_run_id, workflow_step_id, task_id,
              expires_at,
              (expires_at IS NOT NULL AND expires_at <= NOW()) AS is_expired
         FROM approvals
       WHERE id = $1 AND tenant_id = $2::uuid
       FOR UPDATE`,
      apId, tid,
  );
  if (!current[0]) throw AppError.notFound('Approval not found');
  const attachedRunId = current[0].workflow_run_id
    || await taskWorkflowRunId({ tenantId: tid, taskId: current[0].task_id, db: tx })
    || await stepWorkflowRunId({
      tenantId: tid,
      workflowStepId: current[0].workflow_step_id,
      db: tx,
    });
  await assertPathwayExecutorAuthority({
    tenantId: tid,
    workflowRunId: attachedRunId,
    db: tx,
    executorAuthority,
  });
  assertGenericApprovalKindAllowed(current[0].approval_kind);
  if (current[0].status !== 'pending') {
    throw AppError.badRequest(`Approval already ${current[0].status}`);
  }
  if (current[0].is_expired) {
    throw AppError.conflict('Approval has expired', 'APPROVAL_EXPIRED');
  }

  const requiredRole = safeText(current[0].required_role, 80)?.toUpperCase() || null;
  const isTaskAdministrator = roles.some((role) => isAdmin(role)) || roles.includes('SUPER_ADMIN');
  if (requiredRole && !roles.includes(requiredRole) && !isTaskAdministrator) {
    throw AppError.forbidden('Not authorized to decide this approval');
  }

  if (decision === 'reject') {
    const rows = await tx.$queryRawUnsafe(
        `UPDATE approvals
         SET status = 'rejected', rejection_reason = $1,
             decided_by = $2::uuid, decided_at = NOW(), updated_at = NOW()
         WHERE id = $3 AND tenant_id = $4::uuid AND status = 'pending'
         RETURNING ${APPROVAL_RETURNING}`,
        safeText(rejectionReason), cleanApprover, apId, tid,
      );
    if (!rows[0]) {
      throw AppError.conflict('Approval status changed before decision completed', 'APPROVAL_DECISION_CONFLICT');
    }
    return rows[0];
  }

  const existingApprovers = Array.isArray(current[0].approved_by) ? current[0].approved_by : [];
  if (existingApprovers.some(
    (entry) => String(entry?.uid || '').toLowerCase() === cleanApprover,
  )) {
    throw AppError.badRequest('Approver has already approved this gate');
  }
  const next = [...existingApprovers, { uid: cleanApprover, at: new Date().toISOString() }];
  const required = Number(current[0].required_approvers || 1);
  const reachQuorum = next.length >= required;

  const rows = await tx.$queryRawUnsafe(
      `UPDATE approvals
       SET approved_by = $1::jsonb,
           status = $2,
           decided_by = $3::uuid,
           decided_at = CASE WHEN $3::uuid IS NOT NULL THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE id = $4 AND tenant_id = $5::uuid AND status = 'pending'
       RETURNING ${APPROVAL_RETURNING}`,
      JSON.stringify(next),
      reachQuorum ? 'approved' : 'pending',
      reachQuorum ? cleanApprover : null,
      apId, tid,
    );
  if (!rows[0]) {
    throw AppError.conflict('Approval status changed before decision completed', 'APPROVAL_DECISION_CONFLICT');
  }
  return rows[0];
}

export async function listApprovals({
  tenantId = null, status = null, workflowRunId = null, taskId = null,
  limit = DEFAULT_LIST_LIMIT,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (status) {
    params.push(normalizeEnum(status, APPROVAL_STATUSES, 'status'));
    filters.push(`status = $${params.length}`);
  }
  if (workflowRunId) {
    params.push(normalizeId(workflowRunId, 'workflow_run_id'));
    filters.push(`workflow_run_id = $${params.length}`);
  }
  if (taskId) {
    params.push(normalizeId(taskId, 'task_id'));
    filters.push(`task_id = $${params.length}`);
  }
  const safeLimit = normalizeLimit(limit);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT ${APPROVAL_RETURNING} FROM approvals
       WHERE ${filters.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1}`,
      ...params, safeLimit,
    );
    return { approvals: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { approvals: [], count: 0 };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Escalation rules + SLA + automation rules. Task-scope escalation rules are
// evaluated by escalationEngineService (the ENGINE_EVALUATED_* /
// ENGINE_EXECUTABLE_* subsets above); everything else remains CRUD-only
// storage for hospitals that want to plug their own rule engine in later —
// which is why such rules may be saved, but only inactive.
// ---------------------------------------------------------------------------

function assertEscalationRuleEvaluable({ scope, triggerCondition, actionKind }) {
  if (!ENGINE_EVALUATED_ESCALATION_SCOPES.includes(scope)) {
    throw AppError.badRequest(
      `Active escalation rules must use scope: ${ENGINE_EVALUATED_ESCALATION_SCOPES.join(', ')} — no engine evaluates other scopes yet; save the rule inactive instead`,
      'ESCALATION_RULE_SCOPE_UNAVAILABLE',
    );
  }
  if (!ENGINE_EVALUATED_ESCALATION_TRIGGERS.includes(triggerCondition)) {
    throw AppError.badRequest(
      `Active escalation rules must use trigger_condition: ${ENGINE_EVALUATED_ESCALATION_TRIGGERS.join(', ')} — no engine evaluates other triggers yet; save the rule inactive instead`,
      'ESCALATION_RULE_TRIGGER_UNAVAILABLE',
    );
  }
  if (!ENGINE_EXECUTABLE_ESCALATION_ACTIONS.includes(actionKind)) {
    throw AppError.badRequest(
      `Active escalation rules must use action_kind: ${ENGINE_EXECUTABLE_ESCALATION_ACTIONS.join(', ')} — no executor exists for other actions yet; save the rule inactive instead`,
      'ESCALATION_RULE_ACTION_UNAVAILABLE',
    );
  }
}

export async function upsertEscalationRule({
  tenantId = null,
  id = null,
  displayName,
  description = null,
  scope = 'task',
  matchFilter = null,
  triggerCondition,
  triggerWindowMinutes = null,
  actionKind,
  actionPayload = null,
  isActive = true,
  createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const cleanScope = normalizeEnum(scope, ESCALATION_SCOPES, 'scope') || 'task';
  const cleanTrigger = normalizeEnum(triggerCondition, ESCALATION_TRIGGERS, 'trigger_condition', { required: true });
  const cleanAction = normalizeEnum(actionKind, ESCALATION_ACTIONS, 'action_kind', { required: true });
  const cleanIsActive = normalizeBoolean(isActive, true);
  if (cleanIsActive) {
    assertEscalationRuleEvaluable({
      scope: cleanScope,
      triggerCondition: cleanTrigger,
      actionKind: cleanAction,
    });
  }

  if (id) {
    const ruleId = normalizeId(id, 'escalation_rule id');
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE escalation_rules
       SET display_name = $1, description = $2, scope = $3, match_filter = $4::jsonb,
           trigger_condition = $5, trigger_window_minutes = $6,
           action_kind = $7, action_payload = $8::jsonb,
           is_active = $9, updated_at = NOW()
       WHERE id = $10 AND tenant_id = $11::uuid
       RETURNING id, tenant_id, display_name, description, scope, match_filter,
                 trigger_condition, trigger_window_minutes, action_kind, action_payload,
                 is_active, created_by, created_at, updated_at`,
      cleanName, safeText(description),
      cleanScope,
      JSON.stringify(normalizeJsonObject(matchFilter, 'match_filter')),
      cleanTrigger,
      normalizeInt(triggerWindowMinutes, 'trigger_window_minutes', { min: 1, max: 1440 * 30 }),
      cleanAction,
      JSON.stringify(normalizeJsonObject(actionPayload, 'action_payload')),
      cleanIsActive,
      ruleId, tid,
    );
    if (!rows[0]) throw AppError.notFound('Escalation rule not found');
    return rows[0];
  }

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO escalation_rules
       (tenant_id, display_name, description, scope, match_filter,
        trigger_condition, trigger_window_minutes, action_kind, action_payload,
        is_active, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10, $11::uuid)
     RETURNING id, tenant_id, display_name, description, scope, match_filter,
               trigger_condition, trigger_window_minutes, action_kind, action_payload,
               is_active, created_by, created_at, updated_at`,
    tid, cleanName, safeText(description),
    cleanScope,
    JSON.stringify(normalizeJsonObject(matchFilter, 'match_filter')),
    cleanTrigger,
    normalizeInt(triggerWindowMinutes, 'trigger_window_minutes', { min: 1, max: 1440 * 30 }),
    cleanAction,
    JSON.stringify(normalizeJsonObject(actionPayload, 'action_payload')),
    cleanIsActive,
    maybeUuid(createdBy, 'created_by'),
  );
  return rows[0];
}

export async function listEscalationRules({
  tenantId = null, isActive = null, scope = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (isActive !== null) {
    params.push(normalizeBoolean(isActive));
    filters.push(`is_active = $${params.length}`);
  }
  if (scope) {
    params.push(normalizeEnum(scope, ESCALATION_SCOPES, 'scope'));
    filters.push(`scope = $${params.length}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, display_name, description, scope, match_filter,
              trigger_condition, trigger_window_minutes, action_kind, action_payload,
              is_active, created_at, updated_at
       FROM escalation_rules
       WHERE ${filters.join(' AND ')}
       ORDER BY scope, display_name`,
      ...params,
    );
    return { rules: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { rules: [], count: 0 };
    throw err;
  }
}

export async function upsertSlaDefinition({
  tenantId = null,
  slaKey,
  displayName = null,
  description = null,
  targetMinutes,
  warnAtPct = 75,
  businessHoursOnly = false,
  metadata = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanKey = safeText(slaKey, 120);
  if (!cleanKey) throw AppError.badRequest('sla_key is required');
  const target = normalizeInt(targetMinutes, 'target_minutes', { min: 1, max: 1440 * 365 });
  if (!target) throw AppError.badRequest('target_minutes is required');
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO sla_definitions
       (tenant_id, sla_key, display_name, description,
        target_minutes, warn_at_pct, business_hours_only, metadata)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (tenant_id, sla_key) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       target_minutes = EXCLUDED.target_minutes,
       warn_at_pct = EXCLUDED.warn_at_pct,
       business_hours_only = EXCLUDED.business_hours_only,
       metadata = EXCLUDED.metadata,
       updated_at = NOW()
     RETURNING id, tenant_id, sla_key, display_name, description,
               target_minutes, warn_at_pct, business_hours_only, metadata,
               created_at, updated_at`,
    tid, cleanKey, safeText(displayName, SHORT_MAX), safeText(description),
    target,
    normalizeInt(warnAtPct, 'warn_at_pct', { min: 0, max: 100 }) ?? 75,
    normalizeBoolean(businessHoursOnly, false),
    JSON.stringify(normalizeJsonObject(metadata, 'metadata')),
  );
  return rows[0];
}

export async function listSlaDefinitions({ tenantId = null } = {}) {
  const tid = resolveTenantId({ tenantId });
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, sla_key, display_name, description,
              target_minutes, warn_at_pct, business_hours_only, metadata,
              created_at, updated_at
       FROM sla_definitions
       WHERE tenant_id = $1::uuid
       ORDER BY sla_key`,
      tid,
    );
    return { slas: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { slas: [], count: 0 };
    throw err;
  }
}

export async function upsertAutomationRule({
  tenantId = null, id = null,
  displayName, description = null,
  eventType,
  matchFilter = null, actionKind, actionPayload = null,
  isActive = true, createdBy = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const cleanName = safeText(displayName, SHORT_MAX);
  if (!cleanName) throw AppError.badRequest('display_name is required');
  const cleanEvent = safeText(eventType, 120);
  if (!cleanEvent) throw AppError.badRequest('event_type is required');

  if (id) {
    const ruleId = normalizeId(id, 'automation_rule id');
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE automation_rules
       SET display_name = $1, description = $2, event_type = $3,
           match_filter = $4::jsonb, action_kind = $5, action_payload = $6::jsonb,
           is_active = $7, updated_at = NOW()
       WHERE id = $8 AND tenant_id = $9::uuid
       RETURNING id, tenant_id, display_name, description, event_type, match_filter,
                 action_kind, action_payload, is_active, last_fired_at, fire_count,
                 created_at, updated_at`,
      cleanName, safeText(description), cleanEvent,
      JSON.stringify(normalizeJsonObject(matchFilter, 'match_filter')),
      normalizeEnum(actionKind, AUTOMATION_ACTIONS, 'action_kind', { required: true }),
      JSON.stringify(normalizeJsonObject(actionPayload, 'action_payload')),
      normalizeBoolean(isActive, true),
      ruleId, tid,
    );
    if (!rows[0]) throw AppError.notFound('Automation rule not found');
    return rows[0];
  }

  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO automation_rules
       (tenant_id, display_name, description, event_type, match_filter,
        action_kind, action_payload, is_active, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9::uuid)
     RETURNING id, tenant_id, display_name, description, event_type, match_filter,
               action_kind, action_payload, is_active, last_fired_at, fire_count,
               created_at, updated_at`,
    tid, cleanName, safeText(description), cleanEvent,
    JSON.stringify(normalizeJsonObject(matchFilter, 'match_filter')),
    normalizeEnum(actionKind, AUTOMATION_ACTIONS, 'action_kind', { required: true }),
    JSON.stringify(normalizeJsonObject(actionPayload, 'action_payload')),
    normalizeBoolean(isActive, true),
    maybeUuid(createdBy, 'created_by'),
  );
  return rows[0];
}

export async function listAutomationRules({
  tenantId = null, eventType = null, isActive = null,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const filters = ['tenant_id = $1::uuid'];
  const params = [tid];
  if (eventType) {
    params.push(safeText(eventType, 120));
    filters.push(`event_type = $${params.length}`);
  }
  if (isActive !== null) {
    params.push(normalizeBoolean(isActive));
    filters.push(`is_active = $${params.length}`);
  }
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, tenant_id, display_name, description, event_type, match_filter,
              action_kind, action_payload, is_active, last_fired_at, fire_count,
              created_at, updated_at
       FROM automation_rules
       WHERE ${filters.join(' AND ')}
       ORDER BY event_type, display_name`,
      ...params,
    );
    return { rules: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { rules: [], count: 0 };
    throw err;
  }
}

export const __testing__ = {
  TASK_STATUSES,
  TASK_TRANSITIONS,
  TASK_PRIORITIES,
  TASK_KINDS,
  WORKFLOW_RUN_TRANSITIONS,
  WORKFLOW_STEP_TRANSITIONS,
  WORKFLOW_STATUSES,
  WORKFLOW_STEP_KINDS,
  APPROVAL_STATUSES,
  resolveAckAuthorization,
};

export default {
  createTask,
  createWardMedicationObligationTaskTx,
  createMarMedicationExceptionTaskTx,
  createCathInventoryShortfallTaskTx,
  claimMarMedicationExceptionTaskTx,
  createLabThresholdExceptionReviewTaskTx,
  createPendingResultTrackingTaskTx,
  createPendingResultOwnerActionTaskTx,
  createCoveringTransferReviewTaskTx,
  createOpInpatientTransferReviewTaskTx,
  listTasks,
  listInboxTasks,
  claimInboxTask,
  getTask,
  transitionTask,
  supersedePendingResultOwnerActionTaskFromGenerationTx,
  reassignPendingResultTasksForAcceptedCoveringHandoffTx,
  settlePendingResultTasksFromDiagnosticActionTx,
  settlePendingResultTasksFromOwnerCrossSignTx,
  supersedeAcknowledgementTaskFromTrustedWorkflow,
  completeTaskFromDomainEvidence,
  completePathwayTaskFromRegisteredCondition,
  completePathwayTaskFromRegisteredEvidence,
  acknowledgeTask,
  acknowledgeColdChainTaskFromTrustedWorkflow,
  settleCoveringTransferReviewTaskTx,
  settleOpInpatientTransferReviewTaskTx,
  reassignTask,
  postTaskComment,
  listTaskComments,
  createWorkflowDefinition,
  listWorkflowDefinitions,
  startWorkflowRun,
  listWorkflowRuns,
  transitionWorkflowRun,
  listWorkflowSteps,
  transitionWorkflowStep,
  createApproval,
  recordApprovalDecision,
  listApprovals,
  upsertEscalationRule,
  listEscalationRules,
  upsertSlaDefinition,
  listSlaDefinitions,
  upsertAutomationRule,
  listAutomationRules,
};
