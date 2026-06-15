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
// CRITICAL: enqueueCriticalResultTask is BEST-EFFORT / post-commit (repo
// Phase 1.5 pattern, see apps/backend/CLAUDE.md). It must NEVER throw or block
// the originating clinical write (the lab finalize / vital-alert persist). It
// is idempotent: a second call for the same (related_resource_type,
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
import * as taskService from '../workflow/taskService.js';
// Reuse the mig-269 canonical SLA layer (do NOT add a new SLA system).
import { startWorkflowSla } from '../clinical/canonicalClinicalPlatformService.js';
import { ROLES } from '../../utils/roleHelpers.js';

// severity → task priority. Unknown/absent severity defaults to 'high' (a
// result that reached this producer is at least abnormal).
const SEVERITY_PRIORITY = Object.freeze({
  critical: 'critical',
  high: 'high',
  moderate: 'normal',
  low: 'normal',
});

// Abstract escalation/assignment tokens → concrete role codes (roleHelpers).
// The producer's role fallback and the escalation engine both speak these
// tokens; resolve them to real codes here so assigned_to_role is a value the
// RBAC / inbox-by-role query can match. A value already a concrete role passes
// through unchanged.
const ABSTRACT_ROLE_CODES = Object.freeze({
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
 */
function resolveRoleCode(hint) {
  const token = hint == null ? '' : String(hint).trim();
  if (!token) return ABSTRACT_ROLE_CODES.DUTY;
  return ABSTRACT_ROLE_CODES[token] || token;
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
} = {}) {
  const resourceIdStr = resourceId == null ? null : String(resourceId);
  try {
    return await setTenantTx(tenantId, async (tx) => {
      // 1. (Re)use the mig-269 critical_result_ack SLA instance as the clock.
      //    Best-effort: a null instance (SLA rule disabled / schema absent)
      //    must not stop the task from being created.
      const sla = await startWorkflowSla(
        {
          tenantId,
          ruleCode: slaKey,
          patientUid,
          sourceTable: resourceType,
          sourceId: resourceIdStr,
          priority: SEVERITY_PRIORITY[severity] || 'high',
          metadata: { source },
        },
        { db: tx },
      );
      const slaInstanceId = sla?.id || null;

      // 2. Create the assigned, idempotent ack-task in the same tx.
      const created = await taskService.createTask({
        tenantId,
        tx,
        taskKind: 'review',
        title: title || `Critical ${source}: review required`,
        description: summary || null,
        patientUid,
        relatedResourceType: resourceType,
        relatedResourceId: resourceIdStr,
        priority: SEVERITY_PRIORITY[severity] || 'high',
        assignedToUid: orderingClinicianUid || null,
        // Only fall back to a role when there is no ordering clinician.
        assignedToRole: orderingClinicianUid ? null : resolveRoleCode(careTeamRoleHint),
        metadata: { source, sla_instance_id: slaInstanceId, sla_key: slaKey },
        onConflictResourceDoNothing: true,
      });

      return {
        created: !!created?.id,
        taskId: created?.id || null,
        slaInstanceId,
      };
    });
  } catch (err) {
    // CRITICAL: never let the safety-net producer break the clinical write.
    logger.error('enqueueCriticalResultTask failed', {
      err: err?.message,
      resourceType,
      resourceId: resourceIdStr,
    });
    return { created: false, taskId: null, slaInstanceId: null, error: err?.message };
  }
}

/**
 * DORMANT AI-producer bridge (Wave 3). Promotes an accepted
 * clinical_ai_task_candidates row (mig 036) into a tracked task via the same
 * producer. Inert until the clinical_task_extractor module is enabled (no
 * candidates exist today), so this is a documented no-op for now and is filled
 * in Wave 3.
 *
 * @returns {Promise<{created:boolean, skipped:boolean}>}
 */
// eslint-disable-next-line no-unused-vars
export async function promoteTaskCandidate(candidateId, { tenantId } = {}) {
  // Wave 3 fills this: read the candidate; if reviewer_decision='accepted',
  // call enqueueCriticalResultTask with resourceType='task_candidate' and the
  // candidate's title/priority/owner_role/patient. Until then it is inert.
  return { created: false, skipped: true };
}

export default {
  enqueueCriticalResultTask,
  promoteTaskCandidate,
};
