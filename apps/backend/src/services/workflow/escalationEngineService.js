// src/services/workflow/escalationEngineService.js
//
// Results-inbox escalation EVALUATION ENGINE (design: §4.3 of
// docs/RESULTS_INBOX_ESCALATION_DESIGN.md). This is the piece that was
// MISSING — the mig-118 `escalation_rules` table has had CRUD since Phase B2
// but "the engine [was] left to a follow-up" (taskService.js comment). This
// service activates it: a `withJobLock` cron (utils/scheduler.js, every 2 min)
// calls runEscalationSweep, which evaluates active rules against overdue tasks
// / breached mig-269 SLA instances and FIRES the configured actions.
//
// What it does, per sweep (design §4.3):
//   (a) marks open/blocked tasks past due_at as 'overdue';
//   (b) for each active escalation_rules row (scope='task'), finds matching
//       tasks whose trigger holds and fires action_kind ONCE PER TIER;
//   (c) backfill backstop: a breached critical_result_ack SLA instance with no
//       linked task → re-creates the task via the producer (self-heals if a
//       producer hook ever failed).
//
// SLA breach detection (design §6 — two SLA systems coexist by design):
//   The clinical clock is mig-269 `workflow_sla_instances`. A task links its
//   instance via tasks.workflow_sla_instance_id. The engine treats the linked
//   instance as breached when its status='breached' (set by the mig-269
//   reconciliation), OR — defensively — when it is still 'active' but already
//   past due_at, OR when the generic-task column tasks.sla_breached_at is set
//   (mig-118 generic SLA path). The breach MOMENT is
//   COALESCE(instance.breached_at, instance.due_at, tasks.sla_breached_at);
//   a rule's trigger_window_minutes delays its tier that long AFTER breach, so
//   T1/T2/T3 (windows 0/10/30) fire in sequence as the breach ages.
//
// Idempotency (design §7): every fired (task, rule) is recorded in
// tasks.metadata.escalations[] = {tier, at, action, rule_id}; the engine never
// re-fires a rule already present there. Per-task errors are caught + logged;
// they never abort the sweep. All writes are tenant-scoped via setTenantTx.
//
// Conventions (apps/backend/CLAUDE.md): raw params spread (never an array);
// bare params inside jsonb builders cast with ::type; no empty catch; Winston
// logger; AppError for typed failures (none surface from a best-effort sweep).

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import * as taskService from './taskService.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { sendSecurityWebhook } from '../../utils/securityWebhook.js';
import { ROLES, DOCTOR_TIERS, LEADERSHIP_ROLES } from '../../utils/roleHelpers.js';
import { runTransportEscalationSweep } from '../patientFlow/porterTransportService.js';
// Reuse the producer's role-token resolver + backfill entrypoint. resolveRoleCode
// MUST be shared (not duplicated) so the mig-312 seed tokens (DUTY/LEADERSHIP)
// resolve to the IDENTICAL concrete role on the assignment (producer) and
// notification (engine) sides — see resultsInboxService.js.
import { enqueueCriticalResultTask, resolveRoleCode } from '../results/resultsInboxService.js';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

// Acknowledgement-mode tasks leave escalation at in_progress. Domain-evidence
// tasks remain actionable there until their registered evidence completes the
// linked SLA, so candidate SQL adds that one typed exception.
const ESCALATABLE_STATUSES = ['open', 'overdue', 'blocked'];

// The mig-269 rule_code that is the critical-result clock; also the sla_key the
// producer stamps and the backfill backstop re-derives from.
const CRITICAL_RESULT_RULE_CODE = 'critical_result_ack';

// Security event name for the tier-3 "a critical result is STILL unacknowledged
// at the final tier" signal. Not in securityWebhook's CRITICAL_EVENTS set, but
// the helper delivers any event when webhooks are enabled.
const UNACKED_EVENT = 'CRITICAL_RESULT_UNACKED';

const S4_PROTECTED_TASK_KINDS = new Set([
  'pathway_owner_transfer_review',
  'op_to_inpatient_transfer_review',
]);
const S4_PROTECTED_RESOURCE_TYPES = new Set([
  'discharge_pending_result_handoff',
  'discharge_pending_result_action',
]);

function isS4ProtectedTask(taskRow) {
  return S4_PROTECTED_TASK_KINDS.has(String(taskRow?.task_kind || ''))
    || S4_PROTECTED_RESOURCE_TYPES.has(String(taskRow?.related_resource_type || ''));
}

// Role-family fallback so a tier is NEVER a silent no-op. A notify tier resolves
// to its primary concrete role (DUTY→DUTY_DOCTOR, LEADERSHIP→CMO); if NO active
// user holds that exact role in the tenant, we widen to the role's clinical
// "family" (the way drugChartSlaService falls back from the roster nurse to the
// nursing incharge). Keyed by the primary concrete role code resolveRoleCode
// produces for the seeded DUTY/LEADERSHIP tokens.
const ROLE_FAMILY_FALLBACK = Object.freeze({
  // DUTY (mig-312 T2) resolves to DUTY_DOCTOR — widen to every doctor tier so a
  // ward with no one tagged DUTY_DOCTOR still reaches an on-shift physician.
  [ROLES.DUTY_DOCTOR]: DOCTOR_TIERS,
  // LEADERSHIP (mig-312 T3) resolves to CMO — widen to the full leadership group
  // (CMO/CNO/DEPT_HEAD/MED_SUPERINTENDENT), matching the mig-269
  // critical_result_ack escalation_role_codes intent (CMO + MEDICAL_SUPERINTENDENT).
  [ROLES.CMO]: LEADERSHIP_ROLES,
});

// De-dupe resolved recipient rows by integer user id (a user can match both the
// primary role and the family fallback set).
function uniqueRecipients(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const id = Number(row?.id);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, uid: row.uid || null, phone: row.phone || null, role: row.role || null });
  }
  return out;
}

// Resolve a concrete role code → real, active recipients in THIS tenant (the tx
// is already scoped via setTenantTx, so the SELECT is tenant-isolated by RLS).
// Tries the exact role first; if empty, widens to the role family so a DUTY /
// LEADERSHIP tier always reaches a human. Returns [] only when the tenant truly
// has no clinician in the role or its family (logged loudly by the caller).
async function resolveRecipientsForRole(tx, tenantId, roleCode) {
  const role = roleCode == null ? '' : String(roleCode).trim();
  if (!role) return [];
  const exact = await tx.$queryRawUnsafe(
    `SELECT id, uid, phone, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND role = $2
        AND is_active = TRUE
      ORDER BY id
      LIMIT 50`,
    tenantId,
    role,
  );
  if (Array.isArray(exact) && exact.length > 0) return uniqueRecipients(exact);

  const family = ROLE_FAMILY_FALLBACK[role];
  if (!Array.isArray(family) || family.length === 0) return [];
  const widened = await tx.$queryRawUnsafe(
    `SELECT id, uid, phone, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND role = ANY($2::text[])
        AND is_active = TRUE
      ORDER BY id
      LIMIT 50`,
    tenantId,
    family.map(String),
  );
  return uniqueRecipients(widened);
}

// Resolve a single assignee uid → its recipient row (for the T1 re-notify, which
// targets the task's existing assignee, not a role).
async function resolveRecipientByUid(tx, tenantId, uid) {
  const clean = uid == null ? '' : String(uid).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clean)) {
    return [];
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, uid, phone, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND uid = $2::uuid
        AND is_active = TRUE
      LIMIT 1`,
    tenantId,
    clean,
  );
  return uniqueRecipients(rows);
}

// Enqueue ONE outbox row per resolved recipient with a REAL recipientId +
// recipientPhone, so the drained outbox (scheduler.js drainNotificationOutbox)
// actually delivers a push/WS (by userId) and/or SMS (by phone) to a human. A
// per-recipient failure is swallowed so a single bad row never undoes the
// already-recorded escalation marker. Returns the count enqueued.
async function queueRecipientNotifications({ recipients, title, body, data }) {
  let queued = 0;
  for (const r of (Array.isArray(recipients) ? recipients : [])) {
    try {
      await notificationOutbox.queue({
        type: 'push',
        recipientId: r.id,
        recipientPhone: r.phone || null,
        title,
        body,
        data: { ...data, recipient_role: r.role || null },
      });
      queued += 1;
    } catch (err) {
      logger.warn('escalation notify: outbox queue failed for recipient', {
        recipientId: r.id, err: err?.message,
      });
    }
  }
  return queued;
}

function clampLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Has this rule already fired against this task? We key on rule_id so a single
// rule (one tier) fires at most once per task, regardless of replays.
function alreadyFired(taskMetadata, ruleId) {
  const escalations = Array.isArray(taskMetadata?.escalations) ? taskMetadata.escalations : [];
  return escalations.some((e) => Number(e?.rule_id) === Number(ruleId));
}

// match_filter is a jsonb subset that must be satisfied by the task. We support
// the two keys the seed uses: task_kind and the linked SLA rule code. A filter
// key absent from the rule is not constrained.
function matchesFilter(taskRow, matchFilter) {
  const filter = matchFilter && typeof matchFilter === 'object' ? matchFilter : {};
  if (filter.task_kind != null && String(taskRow.task_kind) !== String(filter.task_kind)) {
    return false;
  }
  if (filter.priority != null && String(taskRow.priority) !== String(filter.priority)) {
    return false;
  }
  if (filter.sla_key != null) {
    const taskSlaKey = taskRow.sla_rule_code;
    if (String(taskSlaKey ?? '') !== String(filter.sla_key)) return false;
  }
  return true;
}

// Is the rule's trigger satisfied for this task AT `now`?
//   sla_breach       → a breach signal exists AND the tier window has elapsed
//                      since the breach moment.
//   pending_too_long → the task has been open at least trigger_window_minutes.
// The candidate SELECT already filters to plausibly-breached rows for
// sla_breach; this re-checks the per-tier window in JS so `now` is injectable.
function triggerHolds(taskRow, ruleRow, now) {
  const windowMin = Number(ruleRow.trigger_window_minutes) || 0;
  if (ruleRow.trigger_condition === 'pending_too_long') {
    const createdAt = taskRow.created_at ? new Date(taskRow.created_at) : null;
    if (!createdAt) return false;
    return now.getTime() - createdAt.getTime() >= windowMin * 60_000;
  }
  // sla_breach (default for the seeded critical-result tiers)
  const breachAt = taskRow.breach_at
    ? new Date(taskRow.breach_at)
    : (taskRow.sla_breached_at ? new Date(taskRow.sla_breached_at) : null);
  if (!breachAt || Number.isNaN(breachAt.getTime())) return false;
  return now.getTime() >= breachAt.getTime() + windowMin * 60_000;
}

/**
 * Apply a single rule's action to one task and record the tier in
 * metadata.escalations[] atomically. Returns the action label on success.
 *
 * escalate_priority → bump priority to 'critical' + (also_notify) re-notify the
 *                     assignee; the metadata append + priority bump are one UPDATE.
 * notify            → resolve notify_role token → notificationOutbox.queue, and
 *                     fire sendSecurityWebhook when action_payload.security_webhook.
 * reassign          → taskService.reassignTask to the resolved role.
 * auto_resolve      → taskService.transitionTask → 'completed'.
 */
async function fireAction({ tx, tenantId, taskRow, ruleRow, now }) {
  // S1b-b preserves the existing outward notification/webhook taxonomy for all
  // task rules. A generic clinical-task taxonomy needs owner-approved S1b-c
  // recipient and notification policy before it can become externally visible.
  const payload = ruleRow.action_payload && typeof ruleRow.action_payload === 'object'
    ? ruleRow.action_payload
    : {};
  const tier = payload.tier ?? null;
  const action = ruleRow.action_kind;
  const nowIso = now.toISOString();

  if (action === 'escalate_priority' && isS4ProtectedTask(taskRow)) {
    throw new Error('Protected S4 tasks cannot be reprioritized by the generic escalation engine');
  }

  // Build the escalations[] entry + the new metadata object (read-modify-write).
  const prevMeta = taskRow.metadata && typeof taskRow.metadata === 'object' ? taskRow.metadata : {};
  const prevEsc = Array.isArray(prevMeta.escalations) ? prevMeta.escalations : [];
  const nextMeta = {
    ...prevMeta,
    escalations: [...prevEsc, { tier, at: nowIso, action, rule_id: ruleRow.id }],
  };
  const nextMetaJson = JSON.stringify(nextMeta);

  // reassign / auto_resolve go through the taskService state machine FIRST
  // (they own the row update); we then stamp the escalation marker separately.
  if (action === 'reassign') {
    const role = resolveRoleCode(payload.notify_role || payload.role);
    await taskService.reassignTask({ tenantId, id: taskRow.id, assignedToRole: role, tx });
  } else if (action === 'auto_resolve') {
    if (taskRow.workflow_sla_instance_id || taskRow.sla_completion_semantics !== 'none') {
      throw new Error('Linked-SLA tasks cannot be auto-resolved by the generic escalation engine');
    }
    await taskService.transitionTask({
      tenantId,
      id: taskRow.id,
      nextStatus: 'completed',
      tx,
    });
  }

  // Record the fired tier (and, for escalate_priority, bump priority) in one
  // tenant-scoped UPDATE. metadata carries the new escalations[] array.
  // jsonb param is cast ::jsonb (raw-param rules).
  const setPriority = action === 'escalate_priority' ? `priority = 'critical',` : '';
  await tx.$executeRawUnsafe(
    `UPDATE tasks
        SET ${setPriority}
            metadata = $1::jsonb,
            updated_at = NOW()
      WHERE id = $2 AND tenant_id = $3::uuid`,
    nextMetaJson,
    taskRow.id,
    tenantId,
  );

  // Notifications (best-effort, REAL DELIVERY). We resolve the tier's target
  // (assignee uid for T1 re-notify; the notify_role → on-shift/active users for
  // T2/T3) to concrete recipients and enqueue ONE outbox row PER recipient with
  // a real recipientId + recipientPhone. The outbox is now drained
  // (scheduler.js drainNotificationOutbox, audit C-6 fix), so these rows are
  // actually delivered as a push/WS (by userId) and/or SMS (by phone) — no tier
  // is a silent no-op. A failed notify must never undo the already-recorded
  // escalation marker (it is appended above, before this point), so resolution
  // + queueing is wrapped defensively.
  if (action === 'escalate_priority' && payload.also_notify === 'assignee') {
    try {
      const recipients = await resolveRecipientByUid(tx, tenantId, taskRow.assigned_to_uid);
      const queued = await queueRecipientNotifications({
        recipients,
        title: 'Critical result still needs review',
        body: `Escalated (tier ${tier ?? 1}): ${taskRow.title || 'critical result'} — please review now.`,
        data: {
          kind: 'results_inbox_escalation',
          task_id: taskRow.id,
          tier,
          assigned_to_uid: taskRow.assigned_to_uid || null,
          assigned_to_role: taskRow.assigned_to_role || null,
        },
      });
      if (queued === 0) {
        // No deliverable assignee — the priority bump (visible in GET
        // /tasks/inbox) still escalates, but record that the page didn't land.
        logger.warn('escalation tier-1: no deliverable assignee for re-notify', {
          tenantId, taskId: taskRow.id, tier, assignedToUid: taskRow.assigned_to_uid || null,
        });
      }
    } catch (err) {
      logger.warn('escalation tier-1: assignee re-notify failed', {
        tenantId, taskId: taskRow.id, err: err?.message,
      });
    }
  } else if (action === 'notify') {
    const role = resolveRoleCode(payload.notify_role);
    let queued = 0;
    try {
      const recipients = await resolveRecipientsForRole(tx, tenantId, role);
      queued = await queueRecipientNotifications({
        recipients,
        title: 'Critical result escalation',
        body: `Tier ${tier ?? ''} escalation: ${taskRow.title || 'critical result'} unacknowledged — please action now.`,
        data: {
          kind: 'results_inbox_escalation',
          task_id: taskRow.id,
          tier,
          notify_role: role,
          patient_uid: taskRow.patient_uid || null,
        },
      });
    } catch (err) {
      logger.warn('escalation notify: recipient resolution failed', {
        tenantId, taskId: taskRow.id, role, err: err?.message,
      });
    }
    if (queued === 0) {
      // A DUTY/LEADERSHIP tier resolved to NO active clinician (and no family
      // fallback) — this is the one case a notify could still go unheard, so
      // make it LOUD via the security webhook regardless of the rule flag, so an
      // unstaffed-role escalation is never a silent no-op.
      logger.error('escalation notify: tier resolved to NO recipient — paging via security webhook', {
        tenantId, taskId: taskRow.id, tier, role, patientUid: taskRow.patient_uid || null,
      });
      sendSecurityWebhook(UNACKED_EVENT, {
        userId: taskRow.assigned_to_uid || null,
        path: `/api/v1/admin/workflow/tasks/${taskRow.id}`,
        reason: `tier=${tier ?? ''} role=${role} patient=${taskRow.patient_uid || 'unknown'} :: NO recipient resolved for critical-result escalation`,
      });
    }
    if (payload.security_webhook) {
      // Loud final-tier signal: a critical result is STILL unacknowledged.
      sendSecurityWebhook(UNACKED_EVENT, {
        userId: taskRow.assigned_to_uid || null,
        path: `/api/v1/admin/workflow/tasks/${taskRow.id}`,
        reason: `tier=${tier ?? ''} role=${role} patient=${taskRow.patient_uid || 'unknown'} :: critical result unacknowledged past SLA`,
      });
    }
  }

  return action;
}

/**
 * Evaluate the active escalation_rules against overdue tasks / breached SLA
 * instances for every tenant, firing actions once per tier, plus a backfill
 * backstop. Best-effort + idempotent + tenant-scoped.
 *
 * Runs from the scheduler inside runWithSuperAdmin (GUC='bypass'), so the
 * initial tenant-discovery read sees every tenant; the per-tenant work then
 * re-scopes via setTenantTx so RLS-guarded writes stay tenant-isolated and
 * single-tenant-safe.
 *
 * @param {object}  [args]
 * @param {Date}    [args.now]   Injectable clock (tests). Defaults to new Date().
 * @param {number}  [args.limit] Max candidate tasks per rule + max backfill rows
 *                               per tenant (default 500, cap 5000).
 * @returns {Promise<{scanned:number, markedOverdue:number, escalated:number,
 *                    autoResolved:number, backfilled:number}>}
 */
export async function runEscalationSweep({ now = undefined, limit = DEFAULT_LIMIT } = {}) {
  const clock = now instanceof Date ? now : (now ? new Date(now) : new Date());
  const cap = clampLimit(limit);
  const counters = { scanned: 0, markedOverdue: 0, escalated: 0, autoResolved: 0, backfilled: 0 };

  let tenants = [];
  try {
    // Tenants that actually have active task-scope escalation rules. Keeps a
    // single-tenant deployment to one iteration and avoids touching tenants
    // with nothing to evaluate. Read on the singleton (super-admin context).
    tenants = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT tenant_id
         FROM escalation_rules
        WHERE is_active = TRUE AND scope = 'task'`,
    );
  } catch (err) {
    logger.error('escalation sweep: tenant discovery failed', { err: err?.message });
    return counters;
  }
  for (const t of (Array.isArray(tenants) ? tenants : [])) {
    const tenantId = t.tenant_id;
    if (!tenantId) continue;
    try {
      await setTenantTx(tenantId, async (tx) => {
        // (a) Mark open/blocked tasks past due_at as 'overdue' (state hygiene).
        // in_progress is the ACKED state (§4.5: acknowledge STOPS the clock) and
        // is deliberately NOT flipped — flipping it would re-expose an
        // acknowledged task to escalation, since 'overdue' is escalatable.
        // (Producer tasks currently carry due_at=NULL — the mig-269 instance is
        // the clock — so this is belt-and-suspenders for any task that does set
        // due_at.) RETURNING ids → count.
        const overdue = await tx.$queryRawUnsafe(
          `UPDATE tasks
              SET status = 'overdue', updated_at = NOW()
            WHERE tenant_id = $1::uuid
              AND status IN ('open', 'blocked')
              AND due_at IS NOT NULL
              AND due_at < $2::timestamptz
            RETURNING id`,
          tenantId,
          clock.toISOString(),
        );
        counters.markedOverdue += Array.isArray(overdue) ? overdue.length : 0;

        // (b) Active task-scope rules for this tenant.
        const rules = await tx.$queryRawUnsafe(
          `SELECT id, tenant_id, scope, match_filter, trigger_condition,
                  trigger_window_minutes, action_kind, action_payload, is_active
             FROM escalation_rules
            WHERE tenant_id = $1::uuid AND is_active = TRUE AND scope = 'task'
            ORDER BY trigger_window_minutes ASC, id ASC`,
          tenantId,
        );

        for (const ruleRow of (Array.isArray(rules) ? rules : [])) {
          // Candidate tasks: escalatable status, NOT acked/terminal; left-join
          // the linked mig-269 instance (workflow_sla_instance_id) for the breach
          // signal. For sla_breach rules we require SOME breach signal
          // (registered instance breached, active-but-past-due under this task
          // rule, or tasks.sla_breached_at). This evaluates a matching task; it
          // does not reconcile table-wide SLA status (deferred to S1b-c).
          // — the precise per-tier window is then checked in JS (triggerHolds)
          // so `now` stays injectable. pending_too_long rules skip the SLA join.
          let candidates;
          try {
            if (ruleRow.trigger_condition === 'sla_breach') {
              candidates = await tx.$queryRawUnsafe(
                `SELECT t.id, t.tenant_id, t.task_kind, t.title, t.status, t.priority,
                        t.patient_uid, t.assigned_to_uid, t.assigned_to_role,
                        t.related_resource_type, t.related_resource_id,
                        t.due_at, t.sla_breached_at, t.created_at, t.metadata,
                        t.workflow_sla_instance_id, t.sla_completion_semantics,
                        s.status AS sla_status, s.rule_code AS sla_rule_code,
                        COALESCE(s.breached_at, s.due_at, t.sla_breached_at) AS breach_at
                   FROM tasks t
                   LEFT JOIN workflow_sla_instances s
                     ON s.id = t.workflow_sla_instance_id
                    AND s.tenant_id = t.tenant_id
                   WHERE t.tenant_id = $1::uuid
                     AND (
                       t.status IN ('open', 'overdue', 'blocked')
                       OR (
                         t.status = 'in_progress'
                         AND t.sla_completion_semantics = 'domain_evidence'
                       )
                     )
                     AND s.completed_at IS NULL
                     AND (
                       s.status = 'breached'
                       OR (
                         s.status = 'active'
                         AND s.due_at IS NOT NULL
                         AND s.due_at < $2::timestamptz
                       )
                       OR t.sla_breached_at IS NOT NULL
                     )
                  ORDER BY t.id ASC
                  LIMIT $3::int`,
                tenantId,
                clock.toISOString(),
                cap,
              );
            } else {
              candidates = await tx.$queryRawUnsafe(
                `SELECT t.id, t.tenant_id, t.task_kind, t.title, t.status, t.priority,
                        t.patient_uid, t.assigned_to_uid, t.assigned_to_role,
                        t.related_resource_type, t.related_resource_id,
                        t.due_at, t.sla_breached_at, t.created_at, t.metadata,
                        t.workflow_sla_instance_id, t.sla_completion_semantics,
                        NULL AS sla_status, NULL AS sla_rule_code, NULL AS breach_at
                   FROM tasks t
                  WHERE t.tenant_id = $1::uuid
                     AND (
                       t.status IN ('open', 'overdue', 'blocked')
                       OR (
                         t.status = 'in_progress'
                         AND t.sla_completion_semantics = 'domain_evidence'
                       )
                     )
                  ORDER BY t.id ASC
                  LIMIT $2::int`,
                tenantId,
                cap,
              );
            }
          } catch (err) {
            logger.error('escalation sweep: candidate query failed', {
              err: err?.message, tenantId, ruleId: ruleRow.id,
            });
            continue;
          }

          for (const taskRow of (Array.isArray(candidates) ? candidates : [])) {
            counters.scanned += 1;
            // Per-task guard: a single bad row must never abort the sweep.
            try {
              if (alreadyFired(taskRow.metadata, ruleRow.id)) continue;
              if (!matchesFilter(taskRow, ruleRow.match_filter)) continue;
              if (!triggerHolds(taskRow, ruleRow, clock)) continue;

              const action = await fireAction({ tx, tenantId, taskRow, ruleRow, now: clock });
              if (action === 'auto_resolve') counters.autoResolved += 1;
              else counters.escalated += 1;
            } catch (err) {
              logger.error('escalation sweep: per-task action failed', {
                err: err?.message, tenantId, taskId: taskRow.id, ruleId: ruleRow.id,
              });
              // continue — do not abort the sweep for one task.
            }
          }
        }

        // (c) Backfill backstop: breached critical_result_ack instances with NO
        // actionable task linking back to them (workflow_sla_instance_id) → re-create the
        // task via the producer. Closes the net if a producer hook ever failed.
        //
        // TWO exclusions so we never re-alert an already-handled result (audit
        // C-3): skip an instance if EITHER (1) a non-cancelled task already
        // links it via workflow_sla_instance_id (its own producer-created task),
        // OR (2) a completed task already exists for the same
        // (source_table, source_id) resource. Cancellation is work withdrawal,
        // not acknowledgement evidence; an active SLA behind a cancelled task
        // must be eligible for task re-materialization. The producer's ON CONFLICT only
        // de-dupes active tasks (migration 580 expands the partial unique index
        // through overdue), so without guard (2) a stale
        // breached instance whose task was acked→completed would spawn a FRESH
        // open task for a result a clinician already actioned — the exact
        // false-re-alert the audit flags. Acking now completes the linked
        // instance too (taskService.completeLinkedSla), so the common path is
        // already covered by status; (2) is the belt-and-braces for any instance
        // that stayed breached after its task was completed.
        let orphans;
        try {
          orphans = await tx.$queryRawUnsafe(
            `SELECT s.id, s.tenant_id, s.rule_code, s.patient_uid,
                    s.source_table, s.source_id, s.priority, s.metadata
               FROM workflow_sla_instances s
              WHERE s.tenant_id = $1::uuid
                AND s.rule_code = $2
                AND s.completed_at IS NULL
                 AND (
                   s.status = 'breached'
                   OR (
                     s.status = 'active'
                     AND s.due_at IS NOT NULL
                     AND s.due_at < $3::timestamptz
                   )
                 )
                AND s.source_table IS NOT NULL
                AND s.source_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM tasks t
                   WHERE t.tenant_id = s.tenant_id
                     AND t.workflow_sla_instance_id = s.id
                     AND t.status <> 'cancelled'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM tasks t2
                   WHERE t2.tenant_id = s.tenant_id
                      AND t2.related_resource_type = s.source_table
                      AND t2.related_resource_id = s.source_id
                      AND t2.status = 'completed'
                )
              ORDER BY s.id ASC
              LIMIT $4::int`,
            tenantId,
            CRITICAL_RESULT_RULE_CODE,
            clock.toISOString(),
            cap,
          );
        } catch (err) {
          logger.error('escalation sweep: backfill query failed', { err: err?.message, tenantId });
          orphans = [];
        }

        for (const inst of (Array.isArray(orphans) ? orphans : [])) {
          try {
            const res = await enqueueCriticalResultTask({
              tenantId,
              patientUid: inst.patient_uid || null,
              source: inst.metadata?.source || inst.source_table || 'result',
              resourceType: inst.source_table,
              resourceId: inst.source_id,
              severity: inst.priority === 'critical' ? 'critical' : 'high',
              slaKey: inst.rule_code || CRITICAL_RESULT_RULE_CODE,
            });
            if (res?.created) counters.backfilled += 1;
          } catch (err) {
            // enqueueCriticalResultTask is itself best-effort, but guard anyway.
            logger.error('escalation sweep: backfill enqueue failed', {
              err: err?.message, tenantId, instanceId: inst.id,
            });
          }
        }
      });
    } catch (err) {
      // A whole-tenant failure (e.g. tx open failed) must not stop other tenants.
      logger.error('escalation sweep: tenant pass failed', { err: err?.message, tenantId });
    }
  }

  if (
    counters.escalated
    || counters.autoResolved
    || counters.backfilled
    || counters.markedOverdue
  ) {
    logger.info('escalation sweep complete', { ...counters });
  }
  try {
    const transport = await runTransportEscalationSweep({ now: clock, limit: cap });
    if (transport.scanned || transport.breached || transport.notified) {
      logger.info('transport escalation sweep complete', {
        transportScanned: transport.scanned,
        transportBreached: transport.breached,
        transportNotified: transport.notified,
      });
    }
  } catch (err) {
    logger.error('transport escalation sweep failed', { err: err?.message });
  }
  return counters;
}

export default { runEscalationSweep };

// Exposed for unit tests of the pure predicates without DB plumbing.
export const __testing__ = {
  alreadyFired,
  matchesFilter,
  triggerHolds,
  ESCALATABLE_STATUSES,
  toIso,
  uniqueRecipients,
  resolveRecipientsForRole,
  resolveRecipientByUid,
  queueRecipientNotifications,
  ROLE_FAMILY_FALLBACK,
};
