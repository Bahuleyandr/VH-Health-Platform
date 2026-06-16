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
    // 1. (Re)use the mig-269 critical_result_ack SLA instance as the clock.
    //    Best-effort: a null instance (SLA rule disabled / schema absent) must
    //    not stop the task from being created.
    //
    //    IMPORTANT (RLS): the seeded critical_result_ack rule is a GLOBAL rule
    //    (workflow_sla_rules.tenant_id IS NULL). The mig-075 tenant_isolation
    //    policy makes a NULL-tenant row INVISIBLE once the GUC is pinned to a
    //    concrete tenant (NULL = <tenant> is not true) — so reading the rule
    //    INSIDE setTenantTx(tenantId) silently returns no rule and the SLA
    //    instance never gets created (the safety-net clock never starts). We
    //    therefore start the SLA on the plain singleton (GUC unset → the global
    //    rule is visible); startWorkflowSla still writes the instance with the
    //    EXPLICIT tenant_id we pass, so tenant scoping is preserved and it stays
    //    single-tenant-safe. The instance is then visible to the tenant-scoped
    //    engine sweep because its tenant_id matches. Running it outside the task
    //    tx is fine: the producer is best-effort, and an instance with no task
    //    is reconciled by the engine's backfill backstop.
    const { startWorkflowSla } = await import('../clinical/canonicalClinicalPlatformService.js');
    const sla = await startWorkflowSla({
      tenantId,
      ruleCode: slaKey,
      patientUid,
      sourceTable: resourceType,
      sourceId: resourceIdStr,
      priority: SEVERITY_PRIORITY[severity] || 'high',
      metadata: { source },
    });
    const slaInstanceId = sla?.id || null;

    return await setTenantTx(tenantId, async (tx) => {
      // 2. Create the assigned, idempotent ack-task, linking the SLA instance.
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

export default {
  enqueueCriticalResultTask,
  promoteTaskCandidate,
  promoteAbnormalTriageResult,
  resolveRoleCode,
  ABSTRACT_ROLE_CODES,
};
