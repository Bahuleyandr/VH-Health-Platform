// src/services/results/resultsInboxService.js
//
// Results-inbox producer (design: docs/RESULTS_INBOX_ESCALATION_DESIGN.md §4.1).
//
// Turns a critical clinical result / alert into an ASSIGNED,
// acknowledgement-tracked task the instant it is recorded, so "no critical
// result falls through the cracks". This is the deterministic core of the
// results-inbox safety net — it has ZERO dependency on the (dormant) clinical
// AI modules.
//
// Standalone enqueueCriticalResultTask calls are BEST-EFFORT / post-commit
// (repo Phase 1.5 pattern, see apps/backend/CLAUDE.md). A caller that supplies
// its clinical transaction with strict=true deliberately makes task/SLA rails
// part of that atomic clinical write. The producer is idempotent: a second call
// for the same (related_resource_type,
// related_resource_id) while an open task already exists is a no-op via the
// mig-312 partial unique index uq_task_open_per_resource (ON CONFLICT DO
// NOTHING → { created:false }).
//
// SLA reconciliation (design §6): the clinical-result clock is mig-269's
// canonical workflow_sla_instances — we (re)use the pre-seeded
// `critical_result_ack` rule via canonicalClinicalPlatformService.startWorkflowSla
// rather than inventing a new SLA system. The mig-118 escalation_rules engine
// (Wave-1 Task 2) reads those breaches for what-to-do-on-breach.

import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import * as taskService from '../workflow/taskService.js';
import {
  repairCriticalResultTaskOwnerTx,
  resolveClinicalTaskOwnerTx,
} from '../workflow/workflowHumanOwnerService.js';
import { lockResultsInboxResourceTx } from './resultsInboxResourceLock.js';
// Reuse the mig-269 canonical SLA layer (do NOT add a new SLA system).
// NOTE: startWorkflowSla is imported LAZILY at its call site below (not as a
// static top-level import) to avoid an ESM circular-import link-time failure
// ("does not provide an export named 'startWorkflowSla'") that surfaces under
// certain module load orders (canonicalClinicalPlatformService is mid-eval when
// this module is linked). Resolving at call time defers it past full eval.
import { ROLES } from '../../utils/roleHelpers.js';

// severity → task priority. Unknown/absent severity defaults to 'high' (a
// result that reached this producer is at least abnormal).
const SEVERITY_PRIORITY = Object.freeze({
  critical: 'critical',
  high: 'high',
  moderate: 'normal',
  low: 'normal',
});

const ACTIVE_TASK_STATUSES = new Set(['open', 'in_progress', 'blocked', 'overdue']);
const UNACKNOWLEDGED_TASK_STATUSES = new Set(['open', 'blocked', 'overdue']);
const INCOMPLETE_SLA_STATUSES = new Set(['active', 'breached', 'escalated']);
const ACKNOWLEDGEMENT_AUTHORIZATION_MODES = new Set(['assignee', 'role', 'admin', 'override']);
const TASK_MATERIALIZATION_CONTRACT = 'application_atomic_v1';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function criticalResultAckReconciliationRequired() {
  return AppError.conflict(
    'Critical-result acknowledgement requires reconciliation',
    'LAB_CRITICAL_ALERT_ACK_RECONCILIATION_REQUIRED',
  );
}

function isIncompleteSla(sla) {
  return Boolean(
    sla?.id
    && sla.completed_at == null
    && INCOMPLETE_SLA_STATUSES.has(String(sla.status || '').toLowerCase())
  );
}

function isLegacyCriticalTask(task, slaKey) {
  return Boolean(
    task
    && task.sla_completion_semantics === 'none'
    && !task.workflow_sla_instance_id
    && task.metadata?.sla_key === slaKey
  );
}

function isTypedCriticalTask(task, slaInstanceId) {
  return Boolean(
    task
    && task.sla_completion_semantics === 'acknowledgement'
    && String(task.workflow_sla_instance_id || '') === String(slaInstanceId || '')
  );
}

function isExactHandledTypedCriticalTask(task, { slaKey, resourceType, resourceId }) {
  return Boolean(
    task
    && task.sla_completion_semantics === 'acknowledgement'
    && task.workflow_sla_instance_id
    && task.linked_sla_rule_code === slaKey
    && String(task.linked_sla_source_table || '') === String(resourceType || '')
    && String(task.linked_sla_source_id || '') === String(resourceId || '')
  );
}

async function requireClosedLabAcknowledgementReceipt({
  tx,
  tenantId,
  patientUid,
  resourceId,
  taskId,
  slaInstanceId,
}) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT assert_lab_critical_alert_acknowledgement_receipt(
              receipt.tenant_id,
              receipt.alert_id,
              FALSE
            ) AS receipt_valid
       FROM lab_critical_alert_acknowledgement_receipts AS receipt
       JOIN lab_critical_alerts AS alert
         ON alert.tenant_id = receipt.tenant_id
        AND alert.id = receipt.alert_id
      WHERE receipt.tenant_id = $1::uuid
        AND receipt.result_id = $2::int
        AND receipt.patient_uid = $3::uuid
        AND receipt.acknowledgement_task_id = $4::int
        AND receipt.workflow_sla_instance_id = $5::uuid
        AND receipt.ack_contract_version = 2
        AND alert.result_id = receipt.result_id
        AND alert.patient_uid = receipt.patient_uid
        AND alert.acknowledgement_task_id = receipt.acknowledgement_task_id
        AND alert.acknowledged_at = receipt.acknowledged_at
        AND alert.acknowledged_by = receipt.acknowledged_by
        AND alert.superseded_at IS NULL
      LIMIT 1`,
    tenantId,
    Number(resourceId),
    patientUid,
    Number(taskId),
    String(slaInstanceId),
  );
  if (rows[0]?.receipt_valid !== true) {
    throw criticalResultAckReconciliationRequired();
  }
}

async function upgradeLegacyCriticalTask({
  tx, tenantId, task, slaKey, slaInstanceId,
}) {
  const rows = await tx.$queryRawUnsafe(
    `UPDATE tasks
        SET workflow_sla_instance_id = $3::uuid,
            sla_completion_semantics = 'acknowledgement',
            due_at = (
              SELECT sla.due_at
                FROM workflow_sla_instances sla
               WHERE sla.tenant_id = $1::uuid
                 AND sla.id = $3::uuid
            ),
            metadata = COALESCE(metadata, '{}'::jsonb) - 'sla_instance_id',
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::bigint
        AND status = $4::text
        AND workflow_sla_instance_id IS NULL
        AND sla_completion_semantics = 'none'
        AND metadata->>'sla_key' = $5::text
      RETURNING id, status, completed_at, workflow_sla_instance_id,
                sla_completion_semantics, assigned_to_uid, assigned_to_role, metadata`,
    tenantId,
    task.id,
    slaInstanceId,
    task.status,
    slaKey,
  );
  const upgraded = rows[0] || null;
  if (!isTypedCriticalTask(upgraded, slaInstanceId)) {
    throw new Error('Legacy critical-result task could not be upgraded to its SLA');
  }
  return upgraded;
}

function acknowledgementReceipt(task) {
  const rawReceipt = task?.metadata?.acknowledged_at;
  const parsed = rawReceipt instanceof Date ? rawReceipt : new Date(String(rawReceipt || ''));
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.conflict(
      'Critical-result acknowledgement receipt is missing or invalid; manual SLA reconciliation is required',
      'CRITICAL_RESULT_ACK_RECEIPT_REQUIRED',
    );
  }

  const acknowledgedBy = String(task?.metadata?.acknowledged_by || '').trim().toLowerCase();
  const acknowledgedVia = String(task?.metadata?.acknowledged_via || '').trim().toLowerCase();
  if (
    !UUID_PATTERN.test(acknowledgedBy)
    || !ACKNOWLEDGEMENT_AUTHORIZATION_MODES.has(acknowledgedVia)
  ) {
    throw AppError.conflict(
      'Critical-result acknowledgement authorization evidence is missing or invalid; manual SLA reconciliation is required',
      'CRITICAL_RESULT_ACK_AUTHORIZATION_REQUIRED',
    );
  }

  return {
    acknowledgedAt: parsed.toISOString(),
    acknowledgedAtEpochMs: parsed.getTime(),
    acknowledgedBy,
    acknowledgedVia,
  };
}

async function reconcileAcknowledgedTaskSla({ tx, tenantId, task, slaInstanceId }) {
  const receipt = acknowledgementReceipt(task);
  await tx.$queryRawUnsafe(
    `UPDATE workflow_sla_instances
        SET status = CASE
              WHEN status IN ('breached', 'escalated') THEN status
              WHEN due_at IS NOT NULL
               AND to_timestamp($3::double precision / 1000.0) > due_at
                THEN 'breached'
              ELSE 'completed'
            END,
            completed_at = to_timestamp($3::double precision / 1000.0),
            breached_at = CASE
              WHEN due_at IS NOT NULL
               AND to_timestamp($3::double precision / 1000.0) > due_at
                THEN COALESCE(breached_at, due_at)
              ELSE breached_at
            END,
            metadata = COALESCE(metadata, '{}'::jsonb)
              || jsonb_build_object(
                   'completed_via', 'task_ack',
                   'completed_by_task', $2::bigint,
                   'completed_by', $6::text,
                   'acknowledged_at', to_char(
                     to_timestamp($3::double precision / 1000.0) AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                   ),
                   'acknowledged_by', $6::text,
                   'acknowledged_via', $7::text,
                   'completion_evidence', jsonb_build_object(
                     'kind', 'legacy_critical_result_task_ack',
                     'task_status', $4::text,
                     'recorded_at', to_char(
                       to_timestamp($3::double precision / 1000.0) AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                     )
                   )
                 ),
            updated_at = NOW()
      WHERE id = $1::uuid
        AND tenant_id = $5::uuid
        AND status NOT IN ('completed', 'cancelled')
        AND completed_at IS NULL`,
    slaInstanceId,
    task.id,
    receipt.acknowledgedAtEpochMs,
    task.status,
    tenantId,
    receipt.acknowledgedBy,
    receipt.acknowledgedVia,
  );
}

// Abstract escalation/assignment tokens → concrete role codes (roleHelpers).
// The producer's role fallback and the escalation engine both speak these
// tokens; resolve them to real codes here so assigned_to_role is a value the
// RBAC / inbox-by-role query can match. A value already a concrete role passes
// through unchanged.
//
// EXPORTED so the escalation engine (escalationEngineService.js) reuses the
// EXACT same mapping when resolving an escalation rule's
// action_payload.notify_role token — the mig-312 seed tokens (DUTY/LEADERSHIP)
// MUST resolve to the identical concrete role on both the producer (assignment)
// and the engine (notification) sides. Do NOT duplicate this map.
export const ABSTRACT_ROLE_CODES = Object.freeze({
  // Ward/unit duty/charge clinician — the first human accountable when there is
  // no ordering clinician on the result.
  DUTY: ROLES.DUTY_DOCTOR,
  // Clinical leadership — matches the mig-269 critical_result_ack
  // escalation_role_codes (CMO / MEDICAL_SUPERINTENDENT); we pick CMO as the
  // single assignable role code.
  LEADERSHIP: ROLES.CMO,
});

/**
 * Resolve a role hint to a concrete role code. Abstract tokens (DUTY,
 * LEADERSHIP) map via ABSTRACT_ROLE_CODES; anything else is treated as an
 * already-concrete role code and returned as-is. Defaults to the DUTY role.
 *
 * EXPORTED + reused by escalationEngineService so a rule's notify_role token
 * resolves identically to the producer's assignment fallback (single source of
 * truth for the DUTY/LEADERSHIP → concrete-role mapping).
 */
export function resolveRoleCode(hint) {
  const token = hint == null ? '' : String(hint).trim();
  if (!token) return ABSTRACT_ROLE_CODES.DUTY;
  return ABSTRACT_ROLE_CODES[token] || token;
}

async function repairCriticalResultOwner({
  tx,
  tenantId,
  task,
  orderingClinicianUid,
  careTeamRoleHint,
}) {
  return repairCriticalResultTaskOwnerTx({
    tx,
    tenantId,
    task,
    requestedUid: orderingClinicianUid,
    fallbackRole: resolveRoleCode(careTeamRoleHint),
  });
}

async function createCriticalResultTask({
  tenantId,
  tx,
  patientUid,
  source,
  resourceType,
  resourceId,
  severity,
  title,
  summary,
  orderingClinicianUid,
  careTeamRoleHint,
  slaKey,
  slaInstanceId,
  extraMetadata = null,
}) {
  if (!slaInstanceId) throw new Error('Critical-result task requires an active SLA instance');
  const owner = await resolveClinicalTaskOwnerTx({
    tx,
    tenantId,
    requestedUid: orderingClinicianUid,
    fallbackRole: resolveRoleCode(careTeamRoleHint),
  });
  return taskService.createTask({
    tenantId,
    tx,
    taskKind: 'review',
    title: title || `Critical ${source}: review required`,
    description: summary || null,
    patientUid,
    relatedResourceType: resourceType,
    relatedResourceId: resourceId,
    priority: SEVERITY_PRIORITY[severity] || 'high',
    assignedToUid: owner.assignedToUid,
    assignedToRole: owner.assignedToRole,
    workflowSlaInstanceId: slaInstanceId,
    slaCompletionSemantics: 'acknowledgement',
    metadata: {
      ...(extraMetadata || {}),
      source,
      sla_key: slaKey,
      critical_result_owner_resolution: owner.resolution,
      critical_result_owner_fallback_reason: owner.fallbackReason,
    },
    onConflictResourceDoNothing: true,
  });
}

/**
 * Create an assigned, acknowledgement-tracked task for a critical result/alert.
 *
 * Idempotent + tenant-scoped + never-throws. Returns
 * `{ created, taskId, slaInstanceId }`. `created` is false both on a DB error
 * (the error is logged + returned) and on an idempotency conflict (an open task
 * for this resource already exists).
 *
 * @param {object} params
 * @param {string} params.tenantId            tenant uuid (required for scoping).
 * @param {string} [params.patientUid]        patient uuid.
 * @param {string} [params.source]            originating signal label ('lab_result'|'vital_alert'|…).
 * @param {string} params.resourceType        related resource type (e.g. 'lab_result').
 * @param {string|number} params.resourceId   related resource id.
 * @param {string} [params.severity]          'critical'|'high'|… → task priority.
 * @param {string} [params.title]             task title (defaulted from source).
 * @param {string} [params.summary]           task description.
 * @param {string} [params.orderingClinicianUid] primary assignee (ordering clinician).
 * @param {string} [params.careTeamRoleHint]  role fallback when no clinician (abstract or concrete).
 * @param {string} [params.slaKey]            mig-269 SLA rule code (default 'critical_result_ack').
 * @param {object} [params.extraMetadata]     extra task metadata keys (e.g. reopen provenance).
 * @param {object} [params.tx]                existing tenant transaction for atomic clinical writes.
 * @param {boolean} [params.strict]            rethrow producer failures when the caller owns the transaction.
 * @returns {Promise<{created:boolean, taskId:(number|null), slaInstanceId:(string|number|null), error?:string}>}
 */
export async function enqueueCriticalResultTask({
  tenantId,
  patientUid = null,
  source = 'result',
  resourceType,
  resourceId,
  severity = null,
  title = null,
  summary = null,
  orderingClinicianUid = null,
  careTeamRoleHint = null,
  slaKey = 'critical_result_ack',
  extraMetadata = null,
  tx: callerTx = null,
  strict = false,
} = {}) {
  const resourceIdStr = resourceId == null ? null : String(resourceId);
  try {
    const produce = async (tx) => {
      await lockResultsInboxResourceTx({
        tx,
        tenantId,
        resourceType,
        resourceId: resourceIdStr,
      });
      // Lock a pre-580 task before starting a clock. Old best-effort producers
      // could leave an active task with metadata.sla_key but no SLA link when
      // rule lookup failed. Open work is upgraded below; an acknowledged or
      // completed legacy task is a conservative no-op so replay never creates a
      // false fresh alert. An unrelated untyped active task is a hard collision.
      const priorTasks = await tx.$queryRawUnsafe(
        `SELECT task.id, task.status, task.completed_at, task.workflow_sla_instance_id,
                task.sla_completion_semantics, task.assigned_to_uid,
                task.assigned_to_role, task.metadata,
                sla.rule_code AS linked_sla_rule_code,
                sla.source_table AS linked_sla_source_table,
                sla.source_id AS linked_sla_source_id
           FROM tasks task
           LEFT JOIN workflow_sla_instances sla
             ON sla.tenant_id = task.tenant_id
            AND sla.id = task.workflow_sla_instance_id
          WHERE task.tenant_id = $1::uuid
            AND task.related_resource_type = $2::text
            AND task.related_resource_id = $3::text
          ORDER BY task.id DESC
          LIMIT 1
          FOR UPDATE OF task`,
        tenantId,
        resourceType,
        resourceIdStr,
      );
      const priorTask = priorTasks[0] || null;
      const priorIsLegacy = isLegacyCriticalTask(priorTask, slaKey);
      const priorIsHandledTyped = isExactHandledTypedCriticalTask(priorTask, {
          slaKey,
          resourceType,
          resourceId: resourceIdStr,
        });
      const priorWasHandled = Boolean(
        (priorIsLegacy || priorIsHandledTyped)
        && ['in_progress', 'completed'].includes(priorTask.status)
      );
      if (
        priorTask
        && ACTIVE_TASK_STATUSES.has(priorTask.status)
        && priorTask.sla_completion_semantics === 'none'
        && !priorIsLegacy
      ) {
        throw new Error('Active resource slot is occupied by an incompatible untyped task');
      }

      // Global workflow SLA rules are intentionally exposed under a concrete
      // tenant GUC by migration 352, so clock and task can be one transaction.
      const { startWorkflowSla } = await import('../clinical/canonicalClinicalPlatformService.js');
      const sla = await startWorkflowSla({
        tenantId,
        ruleCode: slaKey,
        patientUid,
        sourceTable: resourceType,
        sourceId: resourceIdStr,
        priority: SEVERITY_PRIORITY[severity] || 'high',
        metadata: {
          source,
          task_materialization_contract: TASK_MATERIALIZATION_CONTRACT,
        },
      }, { db: tx });
      if (!sla?.id) {
        throw new Error('Critical-result SLA rule is unavailable');
      }
      const slaInstanceId = sla.id;
      if (priorWasHandled) {
        let handledTask = priorTask;
        if (priorIsLegacy) {
          handledTask = await upgradeLegacyCriticalTask({
            tx,
            tenantId,
            task: priorTask,
            slaKey,
            slaInstanceId,
          });
        } else if (!isTypedCriticalTask(priorTask, slaInstanceId)) {
          throw new Error('Handled critical-result task is linked to a different SLA instance');
        }
        if (isIncompleteSla(sla)) {
          await reconcileAcknowledgedTaskSla({
            tx,
            tenantId,
            task: handledTask,
            slaInstanceId,
          });
        }
        return {
          created: false,
          skipped: true,
          reason: priorIsLegacy
            ? 'legacy_task_ack_reconciled'
            : 'task_already_acknowledged',
          taskId: handledTask.id,
          slaInstanceId,
        };
      }
      if (!isIncompleteSla(sla)) {
        return {
          created: false,
          skipped: true,
          reason: 'sla_terminal',
          taskId: null,
          slaInstanceId,
        };
      }

      if (priorTask && ACTIVE_TASK_STATUSES.has(priorTask.status)) {
        if (priorIsLegacy && UNACKNOWLEDGED_TASK_STATUSES.has(priorTask.status)) {
          let upgraded = await upgradeLegacyCriticalTask({
            tx,
            tenantId,
            task: priorTask,
            slaKey,
            slaInstanceId,
          });
          upgraded = await repairCriticalResultOwner({
            tx,
            tenantId,
            task: upgraded,
            orderingClinicianUid,
            careTeamRoleHint,
          });
          return {
            created: false,
            upgraded: true,
            taskId: upgraded.id,
            slaInstanceId,
          };
        }
        if (isTypedCriticalTask(priorTask, slaInstanceId)) {
          const ownedTask = await repairCriticalResultOwner({
            tx,
            tenantId,
            task: priorTask,
            orderingClinicianUid,
            careTeamRoleHint,
          });
          return {
            created: false,
            taskId: ownedTask.id,
            slaInstanceId,
          };
        }
        throw new Error('Active critical-result task is linked to a different SLA obligation');
      }

      // 2. Create the assigned, idempotent ack-task, linking the SLA instance.
      const created = await createCriticalResultTask({
        tenantId,
        tx,
        patientUid,
        source,
        resourceType,
        resourceId: resourceIdStr,
        severity,
        title,
        summary,
        orderingClinicianUid,
        careTeamRoleHint,
        slaKey,
        slaInstanceId,
        extraMetadata,
      });

      if (created?.id) {
        return { created: true, taskId: created.id, slaInstanceId };
      }
      // A concurrent producer may have won the partial-unique slot after our
      // pre-read. Treat it as idempotent only when it is the exact typed task
      // for this SLA; otherwise roll back the orphan clock and report loudly.
      const conflicts = await tx.$queryRawUnsafe(
        `SELECT id, status, workflow_sla_instance_id, sla_completion_semantics,
                assigned_to_uid, assigned_to_role, metadata
           FROM tasks
          WHERE tenant_id = $1::uuid
            AND related_resource_type = $2::text
            AND related_resource_id = $3::text
            AND status IN ('open', 'in_progress', 'blocked', 'overdue')
          ORDER BY id DESC
          LIMIT 1
          FOR UPDATE`,
        tenantId,
        resourceType,
        resourceIdStr,
      );
      let conflict = conflicts[0] || null;
      if (!isTypedCriticalTask(conflict, slaInstanceId)) {
        throw new Error('Critical-result task slot was claimed by an incompatible SLA obligation');
      }
      conflict = await repairCriticalResultOwner({
        tx,
        tenantId,
        task: conflict,
        orderingClinicianUid,
        careTeamRoleHint,
      });
      return { created: false, taskId: conflict.id, slaInstanceId };
    };
    return await (callerTx ? produce(callerTx) : setTenantTx(tenantId, produce));
  } catch (err) {
    if (strict) throw err;
    // Standalone safety-net producers remain best-effort for their existing callers.
    logger.error('enqueueCriticalResultTask failed', {
      err: err?.message,
      resourceType,
      resourceId: resourceIdStr,
    });
    return { created: false, taskId: null, slaInstanceId: null, error: err?.message };
  }
}

/**
 * Reopen semantics for a corrected/amended result (care-pathways design §11
 * quick-win 1): make sure an OPEN, UNACKNOWLEDGED ack-task exists for the
 * resource after its value changed.
 *
 * Why the plain producer is not enough: the active-resource partial unique index
 * covers status IN ('open','in_progress','blocked','overdue') — an ALREADY-ACKNOWLEDGED
 * task (acknowledge = open→in_progress, taskService.acknowledgeTask) still
 * occupies the slot, so `enqueueCriticalResultTask` is a silent no-op and the
 * clinician who acked the OLD value is never asked to look at the NEW one.
 * There is also no reopen edge in the task state machine (in_progress can only
 * go to blocked/completed/cancelled), and a completed critical_result_ack SLA
 * instance never re-activates through startWorkflowSla's ON CONFLICT (one
 * instance per (rule, resource) forever).
 *
 * So this helper:
 *   1. leaves a still-unacknowledged task (open/overdue) in place — the fresh
 *      ack window already exists; it only gets a system comment for the audit
 *      trail;
 *   2. closes out an acknowledged/in-flight task (in_progress → completed;
 *      blocked resumes then completes) using the authenticated supersession
 *      actor as its durable receipt — it answered the superseded value;
 *   3. re-arms a stopped SLA instance (completed_at back to NULL, fresh
 *      due_at from the rule's target_minutes) so the escalation engine chases
 *      the new ack window too;
 *   4. creates the fresh task and forward audit link in the same transaction,
 *      stamping reopen provenance (`metadata.reopened_from_task_id`).
 *
 * Same contract as the producer: tenant-scoped, idempotent, NEVER throws.
 *
 * @returns {Promise<{created:boolean, reopened:boolean, taskId:(number|null),
 *   supersededTaskId:(number|null), slaInstanceId:(string|number|null), error?:string}>}
 */
export async function ensureCriticalResultTaskOpen({
  tenantId,
  patientUid = null,
  source = 'lab_result',
  resourceType,
  resourceId,
  severity = 'critical',
  title = null,
  summary = null,
  orderingClinicianUid = null,
  careTeamRoleHint = null,
  slaKey = 'critical_result_ack',
  reason = 'corrected_result',
  supersededByActorUid = null,
  forceNewAcknowledgementWindow = false,
  tx: callerTx = null,
  strict = false,
} = {}) {
  const resourceIdStr = resourceId == null ? null : String(resourceId);
  try {
    const produce = async (tx) => {
      await lockResultsInboxResourceTx({
        tx,
        tenantId,
        resourceType,
        resourceId: resourceIdStr,
      });
      // Lock the current resource slot before deciding whether the corrected
      // value can reuse it. This serializes against acknowledgement: if ack wins
      // first we supersede/rearm, and if this lock wins first the later ack
      // acknowledges the already-annotated corrected value.
      const activeRows = await tx.$queryRawUnsafe(
        `SELECT id, status, workflow_sla_instance_id, sla_completion_semantics,
                assigned_to_uid, assigned_to_role, metadata
           FROM tasks
          WHERE tenant_id = $1::uuid
            AND related_resource_type = $2
            AND related_resource_id = $3
            AND status IN ('open', 'in_progress', 'blocked', 'overdue')
          ORDER BY id DESC
          LIMIT 1
          FOR UPDATE`,
        tenantId,
        resourceType,
        resourceIdStr,
      );
      let active = activeRows[0] || null;
      const initialActiveStatus = active?.status || null;
      const hasUnacknowledgedActiveStatus = ['open', 'overdue'].includes(initialActiveStatus);
      let predecessor = null;
      if (!active) {
        const predecessorRows = await tx.$queryRawUnsafe(
          `SELECT id, status, workflow_sla_instance_id, sla_completion_semantics, metadata
             FROM tasks
            WHERE tenant_id = $1::uuid
              AND related_resource_type = $2
              AND related_resource_id = $3
              AND status IN ('completed', 'cancelled')
            ORDER BY id DESC
            LIMIT 1
            FOR UPDATE`,
          tenantId,
          resourceType,
          resourceIdStr,
        );
        predecessor = predecessorRows[0] || null;
      }
      let provenanceTask = active || predecessor;
      let supersededTaskId = null;

      const priorInstances = await tx.$queryRawUnsafe(
        `SELECT id, rule_id, status, started_at, due_at, completed_at,
                breached_at, escalated_at, metadata
           FROM workflow_sla_instances
          WHERE tenant_id = $1::uuid
            AND rule_code = $2
            AND source_table = $3
            AND source_id = $4
          LIMIT 1
          FOR UPDATE`,
        tenantId,
        slaKey,
        resourceType,
        resourceIdStr,
      );
      const priorSla = priorInstances[0] || null;
      let sla = priorSla;
      if (!sla) {
        const { startWorkflowSla } = await import('../clinical/canonicalClinicalPlatformService.js');
        sla = await startWorkflowSla({
          tenantId,
          ruleCode: slaKey,
          patientUid,
          sourceTable: resourceType,
          sourceId: resourceIdStr,
          priority: SEVERITY_PRIORITY[severity] || 'high',
          metadata: {
            source,
            task_materialization_contract: TASK_MATERIALIZATION_CONTRACT,
          },
        }, { db: tx });
      }
      const slaInstanceId = sla?.id || null;
      if (!slaInstanceId) throw new Error('Critical-result SLA rule is unavailable');
      if (!priorSla && !isIncompleteSla(sla)) {
        throw new Error('New critical-result SLA is not an incomplete clock');
      }

      if (
        priorSla
        && !isIncompleteSla(priorSla)
        && resourceType === 'lab_result'
      ) {
        if (!provenanceTask?.id || !patientUid) {
          throw criticalResultAckReconciliationRequired();
        }
        await requireClosedLabAcknowledgementReceipt({
          tx,
          tenantId,
          patientUid,
          resourceId: resourceIdStr,
          taskId: provenanceTask.id,
          slaInstanceId,
        });
      }

      if (active) {
        if (isLegacyCriticalTask(active, slaKey)) {
          active = await upgradeLegacyCriticalTask({
            tx,
            tenantId,
            task: active,
            slaKey,
            slaInstanceId,
          });
          provenanceTask = active;
        } else if (!isTypedCriticalTask(active, slaInstanceId)) {
          throw new Error('Active corrected-result task is linked to a different SLA obligation');
        }
      }
      if (
        provenanceTask?.workflow_sla_instance_id
        && String(provenanceTask.workflow_sla_instance_id) !== String(slaInstanceId)
      ) {
        throw new Error('Prior critical-result task is linked to a different SLA instance');
      }

      const canReuseActive = Boolean(
        active
        && !forceNewAcknowledgementWindow
        && hasUnacknowledgedActiveStatus
        && isTypedCriticalTask(active, slaInstanceId)
        && isIncompleteSla(sla)
      );
      if (canReuseActive) {
        active = await repairCriticalResultOwner({
          tx,
          tenantId,
          task: active,
          orderingClinicianUid,
          careTeamRoleHint,
        });
      }
      supersededTaskId = canReuseActive ? null : (provenanceTask?.id || null);
      if (active && !canReuseActive) {
        await taskService.supersedeAcknowledgementTaskFromTrustedWorkflow({
          tenantId,
          id: active.id,
          relatedResourceType: resourceType,
          relatedResourceId: resourceIdStr,
          workflowSlaInstanceId: slaInstanceId,
          supersededByActorUid,
          tx,
        });
      }

      const shouldRearm = Boolean(
        !canReuseActive
        && (priorSla || active)
      );
      if (slaInstanceId && shouldRearm) {
        const timing = await tx.$queryRawUnsafe(
          `SELECT target_minutes
             FROM workflow_sla_rules
            WHERE id = $1::uuid
              AND enabled = TRUE
            LIMIT 1`,
          sla.rule_id,
        );
        const targetMinutes = Number(timing[0]?.target_minutes);
        if (!Number.isInteger(targetMinutes) || targetMinutes <= 0) {
          throw new Error('Critical-result SLA rule target is invalid');
        }
        const rearmed = await tx.$queryRawUnsafe(
          `UPDATE workflow_sla_instances i
              SET status = 'active',
                  completed_at = NULL,
                  breached_at = NULL,
                  escalated_at = NULL,
                  started_at = NOW(),
                  due_at = NOW() + ($3::int * INTERVAL '1 minute'),
                  metadata = (
                    COALESCE(i.metadata, '{}'::jsonb)
                      - 'completed_via'
                      - 'completed_by_task'
                      - 'completed_by'
                      - 'acknowledged_by'
                      - 'completion_evidence'
                      - 'ack_contract_version'
                  ) || jsonb_build_object(
                    'reopened_at', NOW(),
                    'reopen_reason', $4::text,
                    'reopen_history',
                      CASE WHEN jsonb_typeof(i.metadata->'reopen_history') = 'array'
                        THEN i.metadata->'reopen_history'
                        ELSE '[]'::jsonb
                      END
                      || jsonb_build_array(jsonb_build_object(
                        'reopened_at', NOW(),
                        'reopen_reason', $4::text,
                        'prior_status', i.status,
                        'prior_started_at', i.started_at,
                        'prior_due_at', i.due_at,
                        'prior_completed_at', i.completed_at,
                        'prior_breached_at', i.breached_at,
                        'prior_escalated_at', i.escalated_at,
                        'prior_ack_contract_version', i.metadata->'ack_contract_version'
                      ) || jsonb_strip_nulls(jsonb_build_object(
                        'prior_completed_via', i.metadata->'completed_via',
                        'prior_completed_by_task', i.metadata->'completed_by_task',
                        'prior_completed_by', i.metadata->'completed_by',
                        'prior_acknowledged_by', i.metadata->'acknowledged_by',
                        'prior_completion_evidence', i.metadata->'completion_evidence'
                      )))
                  ),
                  updated_at = NOW()
            WHERE i.id = $1::uuid
              AND i.tenant_id = $2::uuid
            RETURNING i.id`,
          slaInstanceId,
          tenantId,
          targetMinutes,
          String(reason),
        );
        if (!rearmed[0]) throw new Error('Critical-result SLA disappeared during reopen');
      }

      if (canReuseActive) {
        await taskService.postTaskComment({
          tenantId,
          taskId: active.id,
          authorUid: null,
          body: `Result superseded (${reason}) while awaiting acknowledgement — review the updated value before acting.`,
          bodyKind: 'system_event',
          metadata: { reason },
          tx,
        });
        return {
          created: false,
          reopened: false,
          taskId: active.id,
          supersededTaskId: null,
          slaInstanceId,
        };
      }

      const created = await createCriticalResultTask({
        tenantId,
        tx,
        patientUid,
        source,
        resourceType,
        resourceId: resourceIdStr,
        severity,
        title,
        summary,
        orderingClinicianUid,
        careTeamRoleHint,
        slaKey,
        slaInstanceId,
        extraMetadata: supersededTaskId
          ? { reopened_from_task_id: supersededTaskId, reopen_reason: reason }
          : { reopen_reason: reason },
      });
      if (!created?.id) {
        throw new Error('Replacement critical-result task could not claim the active resource slot');
      }

      if (supersededTaskId) {
        await taskService.postTaskComment({
          tenantId,
          taskId: supersededTaskId,
          authorUid: null,
          body: `Superseded (${reason}): re-acknowledgement required on task #${created.id}.`,
          bodyKind: 'system_event',
          metadata: { reason, superseded_by_task_id: created.id },
          tx,
        });
      }

      return {
        created: true,
        reopened: !!supersededTaskId,
        taskId: created.id,
        supersededTaskId,
        slaInstanceId,
      };
    };
    return await (callerTx ? produce(callerTx) : setTenantTx(tenantId, produce));
  } catch (err) {
    if (strict) throw err;
    // Standalone safety-net callers keep the original never-throw contract.
    logger.error('ensureCriticalResultTaskOpen failed', {
      err: err?.message,
      resourceType,
      resourceId: resourceIdStr,
    });
    return {
      created: false, reopened: false, taskId: null,
      supersededTaskId: null, slaInstanceId: null, error: err?.message,
    };
  }
}

// Candidate priority vocabulary (mig-036: routine|soon|urgent|critical|unknown)
// → producer severity. Only an explicit 'critical' candidate maps to a critical
// task; everything else that reaches promotion is at least 'high' (an accepted,
// human-reviewed candidate is actionable work). The producer then maps severity
// → task priority via SEVERITY_PRIORITY.
const CANDIDATE_SEVERITY = Object.freeze({
  critical: 'critical',
  urgent: 'high',
  soon: 'high',
  routine: 'moderate',
  unknown: 'high',
});

/**
 * DORMANT AI-producer bridge (Wave 3, design §4.7). Promotes an ACCEPTED
 * clinical_ai_task_candidates row (mig-036) into a tracked, assigned task via
 * the same deterministic producer, so a clinician-accepted AI task suggestion
 * joins the results-inbox / escalation safety net.
 *
 * This is inert in practice today: the clinical_task_extractor module is
 * disabled, so no candidates exist — the call sites (clinicalTaskExtractorService
 * decision path) only fire it once that module is enabled and a reviewer accepts
 * a candidate. It is NOT load-bearing for the deterministic lab/vital safety net.
 *
 * Behavior:
 *   - tenant-scoped (setTenantTx) — the candidate table is RLS-forced + tenant-keyed.
 *   - reads the candidate; if reviewer_decision !== 'accepted' (or the row is
 *     absent) → { created:false, skipped:true } (no task).
 *   - else → enqueueCriticalResultTask(resourceType='task_candidate',
 *     resourceId=candidate id, severity from the candidate priority,
 *     title/summary/owner_role/patient from the candidate). Idempotent via the
 *     mig-312 open-task index (one open task per candidate).
 *   - NEVER throws (best-effort): a DB error → { created:false, error }, logged.
 *
 * @param {number|string} candidateId  clinical_ai_task_candidates.id
 * @param {object} [opts]
 * @param {string} [opts.tenantId]     tenant uuid for scoping.
 * @returns {Promise<{created:boolean, skipped?:boolean, taskId?:(number|null), error?:string}>}
 */
export async function promoteTaskCandidate(candidateId, { tenantId } = {}) {
  const idStr = candidateId == null ? null : String(candidateId);
  let candidate = null;
  try {
    candidate = await setTenantTx(tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT id, patient_uid, task_title, task_description, priority,
                owner_role, reviewer_decision
           FROM clinical_ai_task_candidates
          WHERE id = $1::int AND tenant_id = $2::uuid
          LIMIT 1`,
        Number(candidateId),
        tenantId,
      );
      return rows[0] || null;
    });
  } catch (err) {
    logger.error('promoteTaskCandidate: candidate read failed', {
      err: err?.message,
      candidateId: idStr,
    });
    return { created: false, error: err?.message };
  }

  // Only an accepted candidate is promoted; anything else is a clean no-op.
  if (!candidate || candidate.reviewer_decision !== 'accepted') {
    return { created: false, skipped: true };
  }

  // Reuse the deterministic producer (idempotent + tenant-scoped + never-throws).
  return enqueueCriticalResultTask({
    tenantId,
    patientUid: candidate.patient_uid || null,
    source: 'task_candidate',
    resourceType: 'task_candidate',
    resourceId: candidate.id,
    severity: CANDIDATE_SEVERITY[String(candidate.priority || '').toLowerCase()] || 'high',
    title: candidate.task_title || 'Accepted AI task candidate: review required',
    summary: candidate.task_description || null,
    careTeamRoleHint: candidate.owner_role || null,
  });
}

const ABNORMAL_TRIAGE_MODULE_KEY = 'abnormal_result_triage';

/**
 * DORMANT AI-producer bridge (Wave 3, design §4.7) for the abnormal_result_triage
 * module. Promotes an accepted abnormal-result-triage draft into the
 * results-inbox safety net via the same producer (resourceType='abnormal_triage').
 *
 * GUARDED + INERT: it first checks that the abnormal_result_triage clinical-AI
 * module is ENABLED for the tenant; it is disabled platform-wide today, so this
 * is a no-op ({ created:false, skipped:true }) until the module is turned on and
 * an abnormal-triage output is accepted. This is the wiring point spec §4.7 calls
 * for — a call this bridge can be invoked from the abnormal-triage review-accept
 * path once that module produces accepted outputs. Tenant-scoped, never-throws.
 *
 * @param {object} draft  an accepted abnormal-triage draft.
 * @param {string} draft.generationId   clinical_ai_generations.id (the resource).
 * @param {string} [draft.patientUid]
 * @param {string} [draft.urgencyBand]  'critical'|'urgent'|'watch'|'routine'.
 * @param {string} [draft.title]
 * @param {string} [draft.summary]
 * @param {object} [opts]
 * @param {string} [opts.tenantId]
 * @returns {Promise<{created:boolean, skipped?:boolean, taskId?:(number|null), error?:string}>}
 */
export async function promoteAbnormalTriageResult(draft = {}, { tenantId } = {}) {
  try {
    // Module-enabled gate — the dormant guard. Lazy import avoids pulling the
    // large clinicalAiModuleService into this module's static graph.
    const { getClinicalAiModule } = await import('../ai/clinicalAiModuleService.js');
    const module = await getClinicalAiModule(ABNORMAL_TRIAGE_MODULE_KEY, { tenantId });
    if (!module?.enabled) {
      // Inert: the module is off (the platform default), so the abnormal-triage
      // producer bridge does nothing.
      return { created: false, skipped: true };
    }
    if (draft.generationId == null) return { created: false, skipped: true };

    return await enqueueCriticalResultTask({
      tenantId,
      patientUid: draft.patientUid || null,
      source: 'abnormal_triage',
      resourceType: 'abnormal_triage',
      resourceId: draft.generationId,
      severity: draft.urgencyBand === 'critical' ? 'critical' : 'high',
      title: draft.title || 'Abnormal result triage: review required',
      summary: draft.summary || null,
    });
  } catch (err) {
    logger.error('promoteAbnormalTriageResult failed', {
      err: err?.message,
      generationId: draft?.generationId ?? null,
    });
    return { created: false, error: err?.message };
  }
}

const LAB_AUTOVERIFICATION_MODULE_KEY = 'lab_autoverification_delta';

/**
 * AI-producer bridge (Wave 3, design §4.7) for the lab_autoverification_delta
 * module.  Promotes an accepted lab-autoverification row into the results-inbox
 * safety net via the same deterministic producer.
 *
 * GUARDED: gates on the lab_autoverification_delta module being ENABLED for the
 * tenant.  Disabled = { created:false, skipped:true }.  Tenant-scoped,
 * never-throws (best-effort).
 *
 * When the reviewer decision is 'accepted' the autoverification row is treated
 * as a confirmed actionable result and enqueued.  For 'critical' rule-decisions
 * (the rules-engine decision, not the reviewer decision) the task priority is
 * 'critical'; everything else maps to 'high'.
 *
 * @param {object} autoverification  row from clinical_ai_lab_autoverifications.
 * @param {number|string} autoverification.id           row id (the resource id).
 * @param {string}  [autoverification.patient_uid]
 * @param {string}  [autoverification.decision]         rules decision ('critical'|…).
 * @param {string}  [autoverification.critical_band]    'critical_low'|'critical_high'|…
 * @param {string}  [autoverification.test_name]        used in the task title.
 * @param {string}  [autoverification.decision_reason]  used as summary.
 * @param {object}  [opts]
 * @param {string}  [opts.tenantId]
 * @returns {Promise<{created:boolean, skipped?:boolean, taskId?:(number|null), error?:string}>}
 */
export async function promoteLabAutoverification(autoverification = {}, { tenantId } = {}) {
  try {
    const { getClinicalAiModule } = await import('../ai/clinicalAiModuleService.js');
    const module = await getClinicalAiModule(LAB_AUTOVERIFICATION_MODULE_KEY, { tenantId });
    if (!module?.enabled) {
      return { created: false, skipped: true };
    }
    if (autoverification.id == null) return { created: false, skipped: true };

    const isCritical =
      autoverification.decision === 'critical' ||
      autoverification.critical_band === 'critical_low' ||
      autoverification.critical_band === 'critical_high';

    const testName = autoverification.test_name
      ? String(autoverification.test_name).trim()
      : 'Lab result';

    return await enqueueCriticalResultTask({
      tenantId,
      patientUid: autoverification.patient_uid || null,
      source: 'lab_autoverification',
      resourceType: 'lab_autoverification',
      resourceId: autoverification.id,
      severity: isCritical ? 'critical' : 'high',
      title: `Lab autoverification accepted: ${testName} – review required`,
      summary: autoverification.decision_reason || null,
    });
  } catch (err) {
    logger.error('promoteLabAutoverification failed', {
      err: err?.message,
      autoverificationId: autoverification?.id ?? null,
    });
    return { created: false, error: err?.message };
  }
}

export default {
  enqueueCriticalResultTask,
  ensureCriticalResultTaskOpen,
  promoteTaskCandidate,
  promoteAbnormalTriageResult,
  promoteLabAutoverification,
  resolveRoleCode,
  ABSTRACT_ROLE_CODES,
};
