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
//   (a) marks open tasks past due_at as 'overdue' — blocked tasks keep their
//       status: blocked→overdue is not a TASK_TRANSITIONS edge, and because
//       overdue→completed IS one, flipping would make blocked work directly
//       completable without ever unblocking. Blocked tasks stay escalation-
//       eligible via the candidate SQL's status list;
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
// re-fires a successfully recorded rule. Required notification enqueue shares
// that transaction, so an unconfirmed enqueue rolls the marker back and leaves
// the tier retryable. Per-task errors are caught + logged; they never abort the
// sweep. All writes are tenant-scoped via setTenantTx.
//
// Bounded work, audibly (2026-08-02): every bound this sweep applies is now
// either derived from the caller's `limit` or a named constant, and hitting one
// is logged AND counted rather than inferred from silence. Recipient fan-out is
// capped by ESCALATION_RECIPIENT_FANOUT_CAP and ordered by a documented
// availability proxy; a full candidate page raises a warning. Both feed
// observability/escalationMetrics.js. Dropping a clinician from a critical-result
// page is clinical-safety-adjacent, so "we silently sent to the first N" is not
// an acceptable failure mode here.
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
import {
  recordEscalationCandidateLockSkipped,
  recordEscalationCandidatePageFull,
  recordEscalationRecipientRankingFailure,
  recordEscalationRecipientsTrimmed,
  recordEscalationRecipientsTrimmedByRank,
} from '../../observability/escalationMetrics.js';
import { DEFAULT_PRESENCE_WINDOW_MINUTES } from './escalationRecipientRankingService.js';
// Reuse the producer's role-token resolver + backfill entrypoint. resolveRoleCode
// MUST be shared (not duplicated) so the mig-312 seed tokens (DUTY/LEADERSHIP)
// resolve to the IDENTICAL concrete role on the assignment (producer) and
// notification (engine) sides — see resultsInboxService.js.
import { enqueueCriticalResultTask, resolveRoleCode } from '../results/resultsInboxService.js';

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

// Blast-radius backstop on ONE tier's recipient fan-out.
//
// This is deliberately NOT a pagination page size: every active clinician the
// tier matches, up to this many, is notified. Exceeding it means a rule is
// paging more humans than any single critical result plausibly warrants, which
// is a misconfiguration signal — so a trim is always logged AND counted, never
// silent. The value it replaces (a bare `LIMIT 50`, introduced incidentally
// with the C-3 recipient fix in 679201338 and never discussed in
// docs/RESULTS_INBOX_ESCALATION_DESIGN.md) sat well inside a real hospital's
// doctor-tier headcount, so it could evict an on-shift clinician during
// entirely ordinary operation.
const DEFAULT_RECIPIENT_FANOUT_CAP = 500;
const MAX_RECIPIENT_FANOUT_CAP = 5000;

function clampFanoutCap(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RECIPIENT_FANOUT_CAP;
  return Math.min(parsed, MAX_RECIPIENT_FANOUT_CAP);
}

const RECIPIENT_FANOUT_CAP = clampFanoutCap(process.env.ESCALATION_RECIPIENT_FANOUT_CAP);

// Acknowledgement-mode tasks leave escalation at in_progress. Domain-evidence
// tasks remain actionable there until their registered evidence completes the
// linked SLA, so candidate SQL adds that one typed exception.
const ESCALATABLE_STATUSES = ['open', 'overdue', 'blocked'];

// Action kinds this engine can actually perform. The mig-118 CHECK (and the
// CRUD enum) also allow 'webhook', but no executor exists for it; a rule whose
// action cannot be performed must NOT consume its tier — recording the fired
// marker while doing nothing would silently swallow the escalation. Such rules
// are skipped loudly instead (upsertEscalationRule refuses to activate them).
const ENGINE_SUPPORTED_ACTION_KINDS = Object.freeze([
  'notify',
  'reassign',
  'escalate_priority',
  'auto_resolve',
]);

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

// Shared tail of both resolution arms: de-dupe the page, and if the cap actually
// trimmed the match set, say so out loud.
//
// `total_matched` is a COUNT(*) OVER () computed across every matching row
// BEFORE the LIMIT is applied, so the dropped count is exact rather than a
// "there was at least one more" guess, and it costs no extra round trip. The
// unit suites mock the tx and return rows without that column; falling back to
// the page length then reports zero dropped, which is the correct answer for a
// page that was never truncated.
function finishRecipients({ rows, tenantId, role, arm }) {
  const recipients = uniqueRecipients(rows);
  const matched = Number(rows?.[0]?.total_matched ?? recipients.length);
  if (Number.isFinite(matched) && matched > RECIPIENT_FANOUT_CAP) {
    const dropped = matched - RECIPIENT_FANOUT_CAP;
    const droppedByRank = rows?.[0]?.dropped_by_rank || {};
    const droppedByPresence = rows?.[0]?.dropped_by_presence || {};
    // Clinical-safety-adjacent: these are staff who will NOT be paged about an
    // unacknowledged critical result. Never let this be inferred from silence.
    logger.warn('escalation notify: recipient fan-out exceeded cap — tail of the role was NOT notified', {
      tenantId, role, arm, matched, notified: recipients.length, dropped,
      droppedByRank, droppedByPresence, cap: RECIPIENT_FANOUT_CAP,
    });
    try {
      recordEscalationRecipientsTrimmed({ role, arm, dropped });
    } catch (err) {
      logger.warn('escalation notify: recipient-trim metric failed', { err: err?.message });
    }
    for (const [rank, count] of Object.entries(droppedByRank)) {
      try {
        recordEscalationRecipientsTrimmedByRank({ role, arm, rank, dropped: Number(count) });
      } catch (err) {
        logger.warn('escalation notify: recipient-trim-by-rank metric failed', {
          rank, err: err?.message,
        });
      }
    }
  }
  return recipients;
}

function parseRankingControl(row) {
  const raw = row?.ranking_control;
  if (!raw || typeof raw !== 'object' || raw.configured !== true) {
    return {
      configured: false,
      revision: 0,
      presenceWindowMinutes: DEFAULT_PRESENCE_WINDOW_MINUTES,
      expectedMappingCount: 0,
      observedMappingCount: Number(row?.observed_mapping_count || 0),
    };
  }
  const window = Number(raw.presence_window_minutes);
  return {
    configured: true,
    revision: Math.max(1, Number.parseInt(raw.revision, 10) || 1),
    presenceWindowMinutes: Number.isInteger(window) && window >= 15 && window <= 2880
      ? window
      : DEFAULT_PRESENCE_WINDOW_MINUTES,
    expectedMappingCount: Math.max(0, Number.parseInt(raw.expected_mapping_count, 10) || 0),
    observedMappingCount: Number(row?.observed_mapping_count || 0),
  };
}

async function loadRecipientRankingContext(tx, tenantId) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT settings -> 'escalation_recipient_ranking' AS ranking_control,
            (
              SELECT COUNT(*)::int
                FROM escalation_recipient_rank_mappings mappings
               WHERE mappings.tenant_id = tenants.id
            ) AS observed_mapping_count
       FROM tenants
      WHERE id = $1::uuid
      LIMIT 1`,
    tenantId,
  );
  return parseRankingControl(rows?.[0]);
}

function reportRecipientRankingFailures({ context, rows, tenantId, role, arm }) {
  if (!context.configured || context.expectedMappingCount <= 0) return;
  const matched = Number(rows?.[0]?.total_matched || 0);
  const rankedCandidates = Number(rows?.[0]?.ranked_candidates || 0);
  const reasons = [];
  if (context.observedMappingCount !== context.expectedMappingCount) {
    reasons.push('mapping_count_mismatch');
  }
  if (matched > 0 && rankedCandidates === 0) {
    reasons.push('zero_ranked_candidates');
  }
  for (const reason of reasons) {
    logger.warn('escalation notify: configured recipient ranking failed visibility check', {
      tenantId,
      role,
      arm,
      reason,
      expectedMappingCount: context.expectedMappingCount,
      observedMappingCount: context.observedMappingCount,
      rankedCandidates,
      matched,
      controlRevision: context.revision,
      presenceWindowMinutes: context.presenceWindowMinutes,
    });
    try {
      recordEscalationRecipientRankingFailure({ role, arm, reason });
    } catch (err) {
      logger.warn('escalation notify: recipient-ranking-failure metric failed', {
        reason, err: err?.message,
      });
    }
  }
}

async function resolveRankedRecipients({
  tx,
  tenantId,
  role,
  arm,
  roleValue,
  context,
  clock,
}) {
  const rolePredicate = arm === 'family'
    ? 'u.role = ANY($2::text[])'
    : 'u.role = $2::text';
  const rows = await tx.$queryRawUnsafe(
    `WITH candidates AS (
       SELECT u.id, u.uid, u.phone, u.role, u.last_sign_in_at,
              staff_state.effective_rank,
              CASE
                WHEN u.last_sign_in_at >= $4::timestamptz
                       - make_interval(mins => $5::int)
                 AND COALESCE(staff_state.on_leave, FALSE) = FALSE
                THEN 0
                ELSE 1
              END AS presence_bucket,
              CASE WHEN EXISTS (
                SELECT 1 FROM staff_on_call_assignments oc
                 WHERE oc.tenant_id = u.tenant_id
                   AND oc.staff_id = u.id
                   AND oc.is_active
                   AND oc.start_at <= $4::timestamptz
                   AND oc.end_at > $4::timestamptz
              ) THEN 0 ELSE 1 END AS on_call_bucket
         FROM users u
         LEFT JOIN LATERAL (
           SELECT COALESCE(
                    MIN(m.priority_rank) FILTER (WHERE m.source_kind = 'position'),
                    MIN(m.priority_rank) FILTER (WHERE m.source_kind = 'designation')
                  ) AS effective_rank,
                  BOOL_OR(s.on_leave) AS on_leave
             FROM staff s
             LEFT JOIN escalation_recipient_rank_mappings m
               ON m.tenant_id = s.tenant_id
              AND (
                (
                  m.source_kind = 'position'
                  AND m.normalized_source_value = lower(
                    regexp_replace(btrim(s.position), '[[:space:]]+', ' ', 'g')
                  )
                )
                OR (
                  m.source_kind = 'designation'
                  AND m.normalized_source_value = lower(
                    regexp_replace(btrim(s.designation), '[[:space:]]+', ' ', 'g')
                  )
                )
              )
            WHERE s.tenant_id = u.tenant_id
              AND s.user_id = u.uid
              AND s.is_active = TRUE
              AND s.archived = FALSE
         ) staff_state ON TRUE
        WHERE u.tenant_id = $1::uuid
          AND ${rolePredicate}
          AND u.is_active = TRUE
     ), ranked AS (
       SELECT candidates.*,
              COUNT(*) OVER () AS total_matched,
              COUNT(*) FILTER (WHERE effective_rank IS NOT NULL) OVER () AS ranked_candidates,
              ROW_NUMBER() OVER (
                ORDER BY on_call_bucket ASC,
                         presence_bucket ASC,
                         effective_rank ASC NULLS LAST,
                         last_sign_in_at DESC NULLS LAST,
                         id ASC
              ) AS recipient_number
         FROM candidates
     ), dropped_groups AS (
       SELECT COALESCE(effective_rank::text, 'unranked') AS rank_label,
              presence_bucket,
              COUNT(*)::int AS dropped
         FROM ranked
        WHERE recipient_number > $3::int
        GROUP BY COALESCE(effective_rank::text, 'unranked'), presence_bucket
     ), dropped_by_rank AS (
       SELECT COALESCE(jsonb_object_agg(rank_label, dropped), '{}'::jsonb) AS value
         FROM (
           SELECT rank_label, SUM(dropped)::int AS dropped
             FROM dropped_groups
            GROUP BY rank_label
         ) grouped
     ), dropped_by_presence AS (
       SELECT jsonb_build_object(
                'plausibly_present', COALESCE(SUM(dropped) FILTER (WHERE presence_bucket = 0), 0),
                'less_reachable', COALESCE(SUM(dropped) FILTER (WHERE presence_bucket = 1), 0)
              ) AS value
         FROM dropped_groups
     )
     SELECT ranked.id, ranked.uid, ranked.phone, ranked.role,
            ranked.total_matched, ranked.ranked_candidates,
            ranked.effective_rank, ranked.presence_bucket,
            dropped_by_rank.value AS dropped_by_rank,
            dropped_by_presence.value AS dropped_by_presence
       FROM ranked
       CROSS JOIN dropped_by_rank
       CROSS JOIN dropped_by_presence
      WHERE ranked.recipient_number <= $3::int
      ORDER BY ranked.recipient_number ASC`,
    tenantId,
    roleValue,
    RECIPIENT_FANOUT_CAP,
    clock.toISOString(),
    context.presenceWindowMinutes,
  );
  reportRecipientRankingFailures({ context, rows, tenantId, role, arm });
  return rows;
}

// Resolve a concrete role code → real, active recipients in THIS tenant (the tx
// is already scoped via setTenantTx, so the SELECT is tenant-isolated by RLS).
// Tries the exact role first; if empty, widens to the role family so a DUTY /
// LEADERSHIP tier always reaches a human. Returns [] only when the tenant truly
// has no clinician in the role or its family (logged loudly by the caller).
//
// ORDERING. The on-call roster (staff_on_call_assignments, migration 682) is
// the primary duty signal: a candidate holding an ACTIVE on-call stint at the
// resolution instant sorts ahead of everyone else. It is an ordering signal,
// not a filter — a tenant with no on-call rows behaves exactly as before.
// Within each on-call bucket the order stays `last_sign_in_at DESC NULLS LAST,
// id ASC`: an availability PROXY, not a duty signal. It puts the most
// recently-signed-in clinicians first and sorts never-signed-in accounts (the
// provisioned-but-dormant records, least likely to action a page) to the very
// end, so when the cap does trim it trims the least-reachable people rather than
// whoever happens to hold the highest user id. `id ASC` makes the order total,
// so the page is deterministic across sweeps.
async function resolveRecipientsForRole(tx, tenantId, roleCode, clock = new Date()) {
  const role = roleCode == null ? '' : String(roleCode).trim();
  if (!role) return [];
  const context = await loadRecipientRankingContext(tx, tenantId);
  const rankingActive = context.configured && context.expectedMappingCount > 0;
  const exact = rankingActive
    ? await resolveRankedRecipients({
      tx, tenantId, role, arm: 'exact', roleValue: role, context, clock,
    })
    : await tx.$queryRawUnsafe(
      `SELECT u.id, u.uid, u.phone, u.role, COUNT(*) OVER () AS total_matched
         FROM users u
        WHERE u.tenant_id = $1::uuid
          AND u.role = $2
          AND u.is_active = TRUE
        ORDER BY (EXISTS (
                   SELECT 1 FROM staff_on_call_assignments oc
                    WHERE oc.tenant_id = u.tenant_id
                      AND oc.staff_id = u.id
                      AND oc.is_active
                      AND oc.start_at <= $4::timestamptz
                      AND oc.end_at > $4::timestamptz
                 )) DESC,
                 u.last_sign_in_at DESC NULLS LAST, u.id ASC
        LIMIT $3::int`,
      tenantId,
      role,
      RECIPIENT_FANOUT_CAP,
      clock.toISOString(),
    );
  if (Array.isArray(exact) && exact.length > 0) {
    return finishRecipients({ rows: exact, tenantId, role, arm: 'exact' });
  }

  const family = ROLE_FAMILY_FALLBACK[role];
  if (!Array.isArray(family) || family.length === 0) return [];
  const widened = rankingActive
    ? await resolveRankedRecipients({
      tx,
      tenantId,
      role,
      arm: 'family',
      roleValue: family.map(String),
      context,
      clock,
    })
    : await tx.$queryRawUnsafe(
      `SELECT u.id, u.uid, u.phone, u.role, COUNT(*) OVER () AS total_matched
         FROM users u
        WHERE u.tenant_id = $1::uuid
          AND u.role = ANY($2::text[])
          AND u.is_active = TRUE
        ORDER BY (EXISTS (
                   SELECT 1 FROM staff_on_call_assignments oc
                    WHERE oc.tenant_id = u.tenant_id
                      AND oc.staff_id = u.id
                      AND oc.is_active
                      AND oc.start_at <= $4::timestamptz
                      AND oc.end_at > $4::timestamptz
                 )) DESC,
                 u.last_sign_in_at DESC NULLS LAST, u.id ASC
        LIMIT $3::int`,
      tenantId,
      family.map(String),
      RECIPIENT_FANOUT_CAP,
      clock.toISOString(),
    );
  return finishRecipients({ rows: widened, tenantId, role, arm: 'family' });
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
// queue is part of the same transaction that records the escalation marker.
// Notify actions fail closed when enqueue is unconfirmed. Tier-1 priority
// escalation isolates its optional assignee re-notification behind a savepoint:
// the clinical priority transition still commits and dispatches a loud fallback.
async function queueRecipientNotifications({ recipients, title, body, data, tenantId, tx }) {
  const resolved = Array.isArray(recipients) ? recipients : [];
  if (resolved.length === 0) {
    const error = new Error('Escalation notification has no deliverable recipient');
    error.code = 'ESCALATION_DURABLE_ENQUEUE_UNCONFIRMED';
    throw error;
  }
  let queued = 0;
  for (const r of resolved) {
    let row;
    try {
      row = await notificationOutbox.queue({
        type: 'push',
        tenantId,
        recipientId: r.id,
        recipientPhone: r.phone || null,
        sourceEventKey: `workflow-escalation:${data.task_id}:${data.rule_id}:${r.id}`,
        title,
        body,
        data: { ...data, recipient_role: r.role || null },
      }, { tx, strict: true });
    } catch (cause) {
      const error = new Error(`Escalation notification enqueue failed for recipient ${r.id}`, { cause });
      error.code = 'ESCALATION_DURABLE_ENQUEUE_UNCONFIRMED';
      throw error;
    }
    if (!row?.id) {
      const error = new Error(`Escalation notification enqueue was not confirmed for recipient ${r.id}`);
      error.code = 'ESCALATION_DURABLE_ENQUEUE_UNCONFIRMED';
      throw error;
    }
    queued += 1;
  }
  return queued;
}

async function queuePriorityEscalationNotification({ recipients, notification, tenantId, tx }) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return { queued: 0, fallbackCode: 'no_active_assignee' };
  }

  await tx.$executeRawUnsafe('SAVEPOINT tier1_assignee_notification');
  try {
    const queued = await queueRecipientNotifications({
      recipients,
      tenantId,
      tx,
      ...notification,
    });
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT tier1_assignee_notification');
    return { queued, fallbackCode: null };
  } catch (cause) {
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT tier1_assignee_notification');
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT tier1_assignee_notification');
    return {
      queued: 0,
      fallbackCode: 'durable_enqueue_unconfirmed',
      fallbackError: cause?.message || 'unknown enqueue failure',
    };
  }
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

function noKeyUpdateTaskMutationTx(tx) {
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property !== '$queryRawUnsafe') return Reflect.get(target, property, receiver);
      return (sql, ...params) => {
        const statement = typeof sql === 'string' ? sql : '';
        const isTaskServiceReread = /^\s*SELECT[\s\S]+FROM tasks\s+WHERE id = \$1 AND tenant_id = \$2::uuid\s+FOR UPDATE\s*$/i
          .test(statement);
        return tx.$queryRawUnsafe(
          isTaskServiceReread
            ? statement.replace(/FOR UPDATE\s*$/i, 'FOR NO KEY UPDATE')
            : sql,
          ...params,
        );
      };
    },
  });
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
async function applyActionAndMarker({ tx, tenantId, taskRow, ruleRow, now }) {
  // S1b-b preserves the existing outward notification/webhook taxonomy for all
  // task rules. A generic clinical-task taxonomy needs owner-approved S1b-c
  // recipient and notification policy before it can become externally visible.
  const payload = ruleRow.action_payload && typeof ruleRow.action_payload === 'object'
    ? ruleRow.action_payload
    : {};
  const tier = payload.tier ?? null;
  const action = ruleRow.action_kind;
  const nowIso = now.toISOString();

  // In-transaction backstop for the sweep-loop guard above: an action kind
  // with no executor must never consume its tier. The rule loop already skips
  // such rules loudly, but any future caller that reaches this function with
  // an unsupported kind would stamp the fired marker while performing
  // nothing — so refuse here, before any write, and roll the claim back.
  if (!ENGINE_SUPPORTED_ACTION_KINDS.includes(action)) {
    throw new Error(
      `escalation action_kind '${action}' has no executor — refusing to record a fired marker for rule ${ruleRow.id}`,
    );
  }

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
  // Their internal task reread must retain the claim's NO KEY UPDATE strength;
  // upgrading that one reread to FOR UPDATE would block ordinary FK child inserts.
  const taskMutationTx = noKeyUpdateTaskMutationTx(tx);
  if (action === 'reassign') {
    const role = resolveRoleCode(payload.notify_role || payload.role);
    await taskService.reassignTask({
      tenantId, id: taskRow.id, assignedToRole: role, tx: taskMutationTx,
    });
  } else if (action === 'auto_resolve') {
    if (taskRow.workflow_sla_instance_id || taskRow.sla_completion_semantics !== 'none') {
      throw new Error('Linked-SLA tasks cannot be auto-resolved by the generic escalation engine');
    }
    await taskService.transitionTask({
      tenantId,
      id: taskRow.id,
      nextStatus: 'completed',
      tx: taskMutationTx,
    });
  }

  let queued = 0;
  let notifyRole = null;
  let fallbackCode = null;
  let fallbackError = null;
  if (action === 'escalate_priority' && payload.also_notify === 'assignee') {
    const recipients = await resolveRecipientByUid(tx, tenantId, taskRow.assigned_to_uid);
    const delivery = await queuePriorityEscalationNotification({
      recipients,
      tenantId,
      tx,
      notification: {
        title: 'Critical result still needs review',
        body: `Escalated (tier ${tier ?? 1}): ${taskRow.title || 'critical result'} — please review now.`,
        data: {
          kind: 'results_inbox_escalation',
          task_id: taskRow.id,
          rule_id: ruleRow.id,
          tier,
          assigned_to_uid: taskRow.assigned_to_uid || null,
          assigned_to_role: taskRow.assigned_to_role || null,
        },
      },
    });
    ({ queued, fallbackCode, fallbackError } = delivery);
  } else if (action === 'notify') {
    notifyRole = resolveRoleCode(payload.notify_role);
    const recipients = await resolveRecipientsForRole(tx, tenantId, notifyRole, now);
    queued = await queueRecipientNotifications({
      recipients,
      tenantId,
      tx,
      title: 'Critical result escalation',
      body: `Tier ${tier ?? ''} escalation: ${taskRow.title || 'critical result'} unacknowledged — please action now.`,
      data: {
        kind: 'results_inbox_escalation',
        task_id: taskRow.id,
        rule_id: ruleRow.id,
        tier,
        notify_role: notifyRole,
        patient_uid: taskRow.patient_uid || null,
      },
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

  return Object.freeze({
    action,
    payload: Object.freeze({ ...payload }),
    task: Object.freeze({
      id: taskRow.id,
      title: taskRow.title || null,
      patient_uid: taskRow.patient_uid || null,
      assigned_to_uid: taskRow.assigned_to_uid || null,
      assigned_to_role: taskRow.assigned_to_role || null,
    }),
    delivery: Object.freeze({ queued, notifyRole, fallbackCode, fallbackError }),
    firedAt: nowIso,
  });
}

// Provider-independent webhook fallback runs after the task + durable outbox
// transaction commits. Recipient resolution and enqueue already succeeded (or
// rolled the tier marker back) in applyActionAndMarker.
async function dispatchAction({ plan }) {
  const { action, payload, task: taskRow } = plan;
  const tier = payload.tier ?? null;
  if (action === 'escalate_priority'
    && payload.also_notify === 'assignee'
    && plan.delivery.fallbackCode) {
    const fallbackReason = plan.delivery.fallbackCode === 'no_active_assignee'
      ? 'no active assignee; durable tier-1 notification was not enqueued'
      : 'durable tier-1 assignee notification was not enqueued';
    logger.error('escalation sweep: critical priority committed without durable assignee notification', {
      taskId: taskRow.id,
      tier,
      fallbackCode: plan.delivery.fallbackCode,
      fallbackError: plan.delivery.fallbackError,
    });
    sendSecurityWebhook(UNACKED_EVENT, {
      userId: taskRow.assigned_to_uid || null,
      path: `/api/v1/admin/workflow/tasks/${taskRow.id}`,
      reason: `tier=${tier ?? 1} patient=${taskRow.patient_uid || 'unknown'} :: ${fallbackReason}`,
    });
  }
  if (action === 'notify') {
    const role = plan.delivery.notifyRole;
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

const ELIGIBLE_TASK_COLUMNS = `t.id, t.tenant_id, t.task_kind, t.title,
  t.status, t.priority, t.patient_uid, t.assigned_to_uid, t.assigned_to_role,
  t.related_resource_type, t.related_resource_id, t.due_at,
  t.sla_breached_at, t.created_at, t.metadata,
  t.workflow_sla_instance_id, t.sla_completion_semantics`;

function eligibilityParams({ tenantId, ruleRow, clock }) {
  const filter = ruleRow.match_filter && typeof ruleRow.match_filter === 'object'
    ? ruleRow.match_filter
    : {};
  const nullableString = (value) => value == null ? null : String(value);
  return [
    tenantId,
    clock.toISOString(),
    Number(ruleRow.trigger_window_minutes) || 0,
    nullableString(filter.task_kind),
    nullableString(filter.priority),
    nullableString(filter.sla_key),
    String(ruleRow.id),
  ];
}

function taskStatusEligibilitySql() {
  return `(
    t.status IN ('open', 'overdue', 'blocked')
    OR (
      t.status = 'in_progress'
      AND t.sla_completion_semantics = 'domain_evidence'
    )
  )`;
}

function firedMarkerEligibilitySql() {
  return `NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(t.metadata -> 'escalations') = 'array'
          THEN t.metadata -> 'escalations'
          ELSE '[]'::jsonb
        END
      ) AS fired(entry)
     WHERE fired.entry ->> 'rule_id' = $7::text
  )`;
}

// This is the one eligibility builder used by both Phase 0 paging and every
// Phase 1 lock/revalidation arm. The supported filters, trigger boundary, and
// fired-marker exclusion therefore cannot drift across the transaction split.
function buildEligibilitySql(ruleRow) {
  const commonFilters = `
    AND ($4::text IS NULL OR t.task_kind::text = $4::text)
    AND ($5::text IS NULL OR t.priority::text = $5::text)`;
  if (ruleRow.trigger_condition === 'sla_breach') {
    return {
      select: `${ELIGIBLE_TASK_COLUMNS},
        s.status AS sla_status, s.rule_code AS sla_rule_code,
        COALESCE(s.breached_at, s.due_at, t.sla_breached_at) AS breach_at`,
      from: `tasks t
        LEFT JOIN workflow_sla_instances s
          ON s.id = t.workflow_sla_instance_id
         AND s.tenant_id = t.tenant_id`,
      where: `t.tenant_id = $1::uuid
        AND ${taskStatusEligibilitySql()}
        AND s.completed_at IS NULL
        AND (
          s.status = 'breached'
          OR (
            s.status = 'active'
            AND s.due_at IS NOT NULL
            AND s.due_at < $2::timestamptz
          )
          OR t.sla_breached_at IS NOT NULL
        )${commonFilters}
        AND ($6::text IS NULL OR s.rule_code::text = $6::text)
        AND COALESCE(s.breached_at, s.due_at, t.sla_breached_at) IS NOT NULL
        AND COALESCE(s.breached_at, s.due_at, t.sla_breached_at)
              <= $2::timestamptz - make_interval(mins => $3::int)
        AND ${firedMarkerEligibilitySql()}`,
    };
  }
  return {
    select: `${ELIGIBLE_TASK_COLUMNS},
      NULL::text AS sla_status,
      NULL::text AS sla_rule_code,
      NULL::timestamptz AS breach_at`,
    from: 'tasks t',
    where: `t.tenant_id = $1::uuid
      AND ${taskStatusEligibilitySql()}${commonFilters}
      AND $6::text IS NULL
      AND t.created_at <= $2::timestamptz - make_interval(mins => $3::int)
      AND ${ruleRow.trigger_condition === 'pending_too_long' ? 'TRUE' : 'FALSE'}
      AND ${firedMarkerEligibilitySql()}`,
  };
}

async function readEligibleCandidatePage(tx, { tenantId, ruleRow, clock, cap }) {
  const eligibility = buildEligibilitySql(ruleRow);
  return tx.$queryRawUnsafe(
    `SELECT ${eligibility.select}
       FROM ${eligibility.from}
      WHERE ${eligibility.where}
      ORDER BY t.id ASC
      LIMIT $8::int`,
    ...eligibilityParams({ tenantId, ruleRow, clock }),
    cap,
  );
}

async function claimEligibleCandidate(tx, { tenantId, taskId, ruleRow, clock }) {
  const eligibility = buildEligibilitySql(ruleRow);
  const params = [...eligibilityParams({ tenantId, ruleRow, clock }), taskId];
  const results = await tx.$queryRawUnsafe(
    `WITH claimed AS MATERIALIZED (
       SELECT ${eligibility.select}
         FROM ${eligibility.from}
        WHERE ${eligibility.where}
          AND t.id = $8::bigint
        FOR NO KEY UPDATE OF t SKIP LOCKED
     ), fallback AS MATERIALIZED (
       SELECT EXISTS (
                SELECT 1
                  FROM ${eligibility.from}
                 WHERE ${eligibility.where}
                   AND t.id = $8::bigint
              ) AS still_eligible
        WHERE NOT EXISTS (SELECT 1 FROM claimed)
     )
     SELECT 'claimed'::text AS outcome, to_jsonb(claimed) AS task
       FROM claimed
     UNION ALL
     SELECT CASE WHEN still_eligible THEN 'lock_skipped' ELSE 'stale' END,
            NULL::jsonb AS task
       FROM fallback
      LIMIT 1`,
    ...params,
  );
  const result = results?.[0] || { outcome: 'stale', task: null };
  if (result.outcome !== 'claimed') return result;
  const plan = await applyActionAndMarker({
    tx,
    tenantId,
    taskRow: result.task,
    ruleRow,
    now: clock,
  });
  return { outcome: 'claimed', plan };
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
      // Only 'open' flips to 'overdue'. 'blocked' is excluded on purpose: the
      // task state machine has no blocked→overdue edge, and overdue allows a
      // direct →completed that blocked forbids, so flipping would let blocked
      // work be completed without ever unblocking. Blocked tasks past due are
      // still escalated (the candidate SQL matches status 'blocked' directly).
      const overdue = await setTenantTx(tenantId, (tx) => tx.$queryRawUnsafe(
        `UPDATE tasks
            SET status = 'overdue', updated_at = NOW()
          WHERE tenant_id = $1::uuid
            AND status = 'open'
            AND due_at IS NOT NULL
            AND due_at < $2::timestamptz
          RETURNING id`,
        tenantId,
        clock.toISOString(),
      ));
      counters.markedOverdue += Array.isArray(overdue) ? overdue.length : 0;
    } catch (err) {
      logger.error('escalation sweep: overdue-state pass failed', { err: err?.message, tenantId });
    }

    let rules = [];
    try {
      rules = await setTenantTx(
        tenantId,
        (tx) => tx.$queryRawUnsafe(
          `SELECT id, tenant_id, scope, match_filter, trigger_condition,
                  trigger_window_minutes, action_kind, action_payload, is_active
             FROM escalation_rules
            WHERE tenant_id = $1::uuid AND is_active = TRUE AND scope = 'task'
            ORDER BY trigger_window_minutes ASC, id ASC`,
          tenantId,
        ),
        { readOnly: true },
      );
    } catch (err) {
      logger.error('escalation sweep: rule query failed', { err: err?.message, tenantId });
      rules = [];
    }

    for (const ruleRow of (Array.isArray(rules) ? rules : [])) {
      if (!ENGINE_SUPPORTED_ACTION_KINDS.includes(ruleRow.action_kind)) {
        // No executor for this action. Skipping WITHOUT a fired marker keeps
        // the tier live (it will be evaluated again once an executor exists or
        // the rule is fixed) and keeps the misconfiguration visible each sweep.
        logger.error('escalation sweep: rule action_kind has no executor — rule skipped, tier not consumed', {
          tenantId, ruleId: ruleRow.id, actionKind: ruleRow.action_kind,
        });
        continue;
      }
      let candidates = [];
      try {
        candidates = await setTenantTx(
          tenantId,
          (tx) => readEligibleCandidatePage(tx, { tenantId, ruleRow, clock, cap }),
          { readOnly: true },
        );
      } catch (err) {
        logger.error('escalation sweep: candidate query failed', {
          err: err?.message, tenantId, ruleId: ruleRow.id,
        });
        continue;
      }

      if (Array.isArray(candidates) && candidates.length >= cap) {
        logger.warn('escalation sweep: candidate page full — tasks beyond the page were NOT evaluated', {
          tenantId,
          ruleId: ruleRow.id,
          triggerCondition: ruleRow.trigger_condition,
          cap,
        });
        try {
          recordEscalationCandidatePageFull({ triggerCondition: ruleRow.trigger_condition });
        } catch (err) {
          logger.warn('escalation sweep: candidate-page metric failed', { err: err?.message });
        }
      }

      let skippedLocked = 0;
      for (const taskRow of (Array.isArray(candidates) ? candidates : [])) {
        counters.scanned += 1;
        let claim;
        try {
          claim = await setTenantTx(tenantId, (tx) => claimEligibleCandidate(tx, {
            tenantId,
            taskId: taskRow.id,
            ruleRow,
            clock,
          }));
        } catch (err) {
          logger.error('escalation sweep: per-task atomic action failed', {
            err: err?.message, tenantId, taskId: taskRow.id, ruleId: ruleRow.id,
          });
          if (err?.code === 'ESCALATION_DURABLE_ENQUEUE_UNCONFIRMED'
            && ruleRow.action_kind === 'notify') {
            const payload = ruleRow.action_payload || {};
            sendSecurityWebhook(UNACKED_EVENT, {
              userId: taskRow.assigned_to_uid || null,
              path: `/api/v1/admin/workflow/tasks/${taskRow.id}`,
              reason: `tier=${payload.tier ?? ''} role=${resolveRoleCode(payload.notify_role)} patient=${taskRow.patient_uid || 'unknown'} :: durable critical-result escalation was not enqueued`,
            });
          }
          continue;
        }

        if (claim.outcome === 'lock_skipped') {
          skippedLocked += 1;
          continue;
        }
        if (claim.outcome !== 'claimed') continue;

        if (claim.plan.action === 'auto_resolve') counters.autoResolved += 1;
        else counters.escalated += 1;
        try {
          await dispatchAction({ plan: claim.plan });
        } catch (err) {
          logger.error('escalation sweep: post-commit dispatch failed', {
            err: err?.message, tenantId, taskId: taskRow.id, ruleId: ruleRow.id,
          });
        }
      }

      if (skippedLocked > 0) {
        logger.warn('escalation sweep: eligible task claims skipped due to task-row contention', {
          tenantId,
          ruleId: ruleRow.id,
          triggerCondition: ruleRow.trigger_condition,
          skippedLocked,
          cap,
        });
        try {
          recordEscalationCandidateLockSkipped({
            triggerCondition: ruleRow.trigger_condition,
            count: skippedLocked,
          });
        } catch (err) {
          logger.warn('escalation sweep: candidate-lock-skipped metric failed', {
            err: err?.message,
          });
        }
      }
    }

    let orphans = [];
    try {
      orphans = await setTenantTx(
        tenantId,
        (tx) => tx.$queryRawUnsafe(
          `SELECT s.id, s.tenant_id, s.rule_code, s.patient_uid,
                  s.source_table, s.source_id, s.priority, s.metadata
             FROM workflow_sla_instances s
            WHERE s.tenant_id = $1::uuid
              AND s.rule_code = $2::text
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
                SELECT 1 FROM tasks task
                 WHERE task.tenant_id = s.tenant_id
                   AND task.workflow_sla_instance_id = s.id
                   AND task.status <> 'cancelled'
              )
              AND NOT EXISTS (
                SELECT 1 FROM tasks completed_task
                 WHERE completed_task.tenant_id = s.tenant_id
                   AND completed_task.related_resource_type = s.source_table
                   AND completed_task.related_resource_id = s.source_id
                   AND completed_task.status = 'completed'
              )
            ORDER BY s.id ASC
            LIMIT $4::int`,
          tenantId,
          CRITICAL_RESULT_RULE_CODE,
          clock.toISOString(),
          cap,
        ),
        { readOnly: true },
      );
    } catch (err) {
      logger.error('escalation sweep: backfill query failed', { err: err?.message, tenantId });
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
        logger.error('escalation sweep: backfill enqueue failed', {
          err: err?.message, tenantId, instanceId: inst.id,
        });
      }
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
  buildEligibilitySql,
  eligibilityParams,
  readEligibleCandidatePage,
  claimEligibleCandidate,
  parseRankingControl,
  reportRecipientRankingFailures,
  noKeyUpdateTaskMutationTx,
  ROLE_FAMILY_FALLBACK,
  RECIPIENT_FANOUT_CAP,
  clampFanoutCap,
  ENGINE_SUPPORTED_ACTION_KINDS,
};
