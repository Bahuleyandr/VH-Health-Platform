# Results-Inbox Safety Net + Escalation Engine — Design

**Created 2026-06-15.** Brainstormed design (spec). Activates the dormant
mig-118 tasks/workflow/escalation foundation by adding the missing **evaluation
engine** + **producer wiring**, delivering a clinical-safety **results-inbox**
("no critical result falls through the cracks"). Companion to
[`CANONICAL_CLINICAL_TIMELINE.md`](CANONICAL_CLINICAL_TIMELINE.md) (SLA layer) and
the AI enablement plan (the deferred AI producers).

> **Status: IMPLEMENTED 2026-06-15** — shipped as the clinical results-inbox + escalation engine (`clinicalInboxRoutes.js`, merged `2c286c35`). This document is the durable design of record.

---

## 1. Context (grounded in code)

The generic tasks/workflow stack **already exists and is mostly built**, but the
useful parts are dormant:

- **BUILT** (`migration 118_tasks_workflow_foundation.sql` + `services/workflow/taskService.js` + `routes/admin/tasksWorkflowRoutes.js`, mounted at `/api/v1/admin/workflow/*`, admin-gated): `tasks` CRUD + state machine (open→in_progress→blocked→completed/cancelled/overdue), `workflow_definitions/runs/steps`, quorum `approvals`, `task_comments`. 18 endpoints, tests.
- **DORMANT (schema + CRUD only, never evaluated):** `escalation_rules`, `sla_definitions`, `automation_rules` — `taskService` comment literally says *"engine left to a follow-up."* Zero consumers.
- **PARTIAL (mig 269 canonical SLA):** `workflow_sla_rules`/`workflow_sla_instances` + `canonicalClinicalPlatformService` create SLA instances on clinical events and mark `status='breached'` when overdue — incl. a pre-seeded **`critical_result_ack` (15 min)** rule — but **never notify or escalate**.
- **MISSING:** any producer that creates a `tasks` row; the `clinical_ai_task_candidates` (mig 036) → `tasks` bridge; a per-clinician inbox; the results-inbox.

**The real gap = the evaluation engine + the producer wiring, not the schema.**

## 2. Goals & non-goals

**Goals**
1. A critical clinical result/alert becomes an **assigned, acknowledgement-tracked task** the moment it's recorded.
2. Unacknowledged critical tasks **escalate on SLA breach** (the `critical_result_ack` clock already exists) — re-notify → duty/charge role → leadership.
3. Activate the dormant `escalation_rules` layer with a real, idempotent **evaluator**.
4. Work **today, with zero dependency on the (dormant) clinical-AI modules**; leave dormant AI-producer bridges for when those activate.
5. Safety-net-grade reliability: a missed task must be self-healing.

**Non-goals (YAGNI)**
- UI (admin Next.js / staff Flutter inbox screens) — separate effort; this ships the backend API.
- The full `automation_rules` event engine — the post-commit hook covers creation; automation_rules generalization is later.
- The RCA/quality-committee workflow (the other foundational use case).
- Non-critical results (start with critical/abnormal; widen later).
- A third SLA system — reuse mig-269 for clinical SLAs, mig-118 `escalation_rules` for actions.

## 3. Architecture

Two isolated units over the existing tables, plus a thin inbox query:

```
critical result / clinical_alert recorded
        │  (post-commit, best-effort hook — never blocks the clinical write)
        ▼
resultsInboxService.enqueueCriticalResultTask(ctx)
        │  → tasks row (assigned, priority, related_resource, sla link)  [idempotent]
        │  → (mig-269 critical_result_ack SLA instance is the clock)
        ▼
assignee sees it: GET /tasks/inbox  →  acknowledge (open→in_progress) STOPS the clock  →  resolve (→completed)
        │
        │  if unacked past SLA:
        ▼
escalationEngineService.runEscalationSweep()  (withJobLock cron, ~2 min)
        → evaluate escalation_rules vs overdue tasks / breached SLA instances
        → fire action_kind once-per-tier: escalate_priority · notify (notificationOutbox) · reassign · auto_resolve
        → BACKFILL backstop: critical SLA instance with no task → create one
```

## 4. Components (each: what / interface / depends on)

### 4.1 `services/results/resultsInboxService.js` (NEW) — the producer
- **What:** turns a critical result/alert into a tracked task.
- **Interface:** `enqueueCriticalResultTask({ tenantId, patientUid, source, resourceType, resourceId, severity, title, summary, orderingClinicianUid, careTeamRoleHint, slaKey })` → `{ created, taskId }`. Idempotent.
- **Behavior:** maps `severity`→task `priority` (critical/high); `task_kind='review'`; `related_resource_type/_id` = the result; `assigned_to_uid` = ordering clinician, else `assigned_to_role` = care-team/duty role fallback; links the mig-269 SLA instance id in `metadata.sla_instance_id`. Tenant-scoped (`setTenantTx`). Never throws (best-effort).
- **Depends on:** `taskService.createTask`, the mig-269 SLA instance (read/create via `canonicalClinicalPlatformService`), `roleHelpers`, the new idempotency index (4.6).

### 4.2 Producer hooks (deterministic core)
- **What:** call `enqueueCriticalResultTask` post-commit from the two deterministic critical signals:
  - critical/abnormal **lab result** finalization (`labResultsService` critical-flag path),
  - **`vitalSignMonitor`** CRITICAL `clinical_alerts`.
- **Pattern:** post-commit Phase-1.5 best-effort (mirrors the care-team admission hook) — never blocks/fails the clinical write.

### 4.3 `services/workflow/escalationEngineService.js` (NEW) — the evaluator
- **What:** the missing engine that makes `escalation_rules` + SLA breaches act.
- **Interface:** `runEscalationSweep({ now, limit })` → `{ scanned, escalated, autoResolved, backfilled }`.
- **Behavior:** per tenant, for active `escalation_rules` (scope=task): find tasks/SLA-instances matching `match_filter` whose `trigger_condition` holds (`sla_breach` via the mig-269 instance or `tasks.sla_breached_at`; `pending_too_long` via `trigger_window_minutes`); fire `action_kind` **once per tier** (`escalate_priority`, `notify`→`notificationOutbox` + `securityWebhook` for criticals, `reassign`, `auto_resolve`). **Idempotency:** record fired tiers in `tasks.metadata.escalations[]` (`{tier, at, action, rule_id}`); never re-fire the same (task, rule). Also marks open tasks past `due_at` as `overdue`.
- **Backfill backstop:** find `critical_result_ack` SLA instances (or critical `clinical_alerts`) with **no linked task** → call the producer (closes the net if a hook ever fails).
- **Depends on:** `taskService` (transition/reassign), `escalation_rules`/`sla_definitions` reads, mig-269 instances, `notificationOutbox`, `securityWebhook`.

### 4.4 Scheduler registration
- Register `runEscalationSweep` on `utils/scheduler.js` via `withJobLock('results-inbox-escalation', …)`, `*/2 * * * *`, inside the `NODE_ENV!=='test'` guard (mirrors the break-glass sweeper).

### 4.5 Acknowledge model + inbox API
- **Ack:** reuse `taskService.transitionTask` — assignee `acknowledge` = open→in_progress (stops the escalation clock; the engine treats in_progress as acked unless a separate `no_progress_after` rule applies); `resolve` = →completed. No new state machine. A thin `acknowledgeTask(taskId, actorUid)` wrapper records `metadata.acknowledged_at` + a `task_comments` system event.
- **Inbox:** `GET /api/v1/.../tasks/inbox` — thin wrapper over `taskService.listTasks` (assignee = me OR my role; status open/in_progress/overdue; ordered priority, due_at). Reuses the existing route module + RBAC. **No UI in scope.**

### 4.6 Schema — one small additive migration
- `NNN_results_inbox_idempotency.sql`: a **partial unique index** on `tasks (tenant_id, related_resource_type, related_resource_id) WHERE status IN ('open','in_progress','blocked') AND related_resource_type IS NOT NULL` → enforces "one open task per result resource" so the producer's `ON CONFLICT DO NOTHING` is race-safe. Safe: nothing creates `tasks` today, so no existing-data conflict. Regenerate `schema.prisma` + drift-check.
- Seed (idempotent, default tenant): the `escalation_rules` rows for the critical-result tiers (T1 re-notify / T2 duty-role / T3 leadership) so the engine has rules to act on out of the box. (Per-tenant seeding deferred to the operator playbook.)

### 4.7 AI producer bridges (DORMANT until AI modules enabled)
- `promoteTaskCandidate(candidateId)` — accepted `clinical_ai_task_candidates` → `tasks` (via the same producer). Wired into the candidate-decision path but inert (candidates only appear when `clinical_task_extractor` is enabled).
- abnormal_result_triage → producer hook (inert until that module is on).
- These add tasks; they are never load-bearing for the deterministic safety net.

## 5. Assignment & escalation chain (clinical accountability)
- **Primary assignee:** the **ordering clinician** (from the result's order). Fallback: the patient's **care team** (ABAC `care_team`); final fallback: the ward/unit **duty role** (`assigned_to_role`).
- **Escalation tiers** (config in `escalation_rules`, fire once each on `critical_result_ack` breach):
  - **T1** (immediate on breach): re-notify the assignee + `escalate_priority` to critical.
  - **T2** (next window): notify the ward/unit **duty/charge role**.
  - **T3** (final window): notify **clinical leadership** (CMO / duty consultant) + a loud `securityWebhook`.
- Acknowledgement (4.5) halts further tiers.

## 6. SLA reconciliation (two systems coexist — by design)
- **Clinical-result clock = mig-269** canonical `workflow_sla_instances` (reuse the seeded `critical_result_ack` rule; do not duplicate).
- **Actions = mig-118 `escalation_rules`** (the new engine reads these for what-to-do-on-breach).
- **Generic-task SLAs = mig-118 `sla_definitions`** (for non-clinical tasks; the engine also honors `tasks.sla_breached_at`).
- The engine bridges both: SLA *state* comes from mig-269 for results / mig-118 for generic tasks; the *action* always comes from `escalation_rules`. No third SLA system.

## 7. Reliability & error handling
- Creation hook is **best-effort, post-commit** — a failed task-create never blocks recording the critical result.
- **Backfill backstop** (4.3) re-derives missing tasks from breached critical SLA instances — the net self-heals if a hook fails.
- Sweeper: `withJobLock` (no overlap); each (task, rule, tier) fires once (recorded in `metadata.escalations`); per-task errors are logged and do not abort the sweep.
- All writes tenant-scoped via `setTenantTx`; raw SQL follows repo rules (spread params, `::type` casts).

## 8. Phasing (each independently shippable + testable)
1. **Engine** — `escalationEngineService` + scheduler + the `escalation_rules` seed + overdue-marking. Activates the dormant layer; the canonical SLA breaches finally get acted on. (No producer yet — escalates whatever tasks/instances exist.)
2. **Producer + inbox + ack** — `resultsInboxService` + the two deterministic hooks + the idempotency migration + `GET /tasks/inbox` + `acknowledgeTask`. The core safety net.
3. **AI bridges (dormant)** — `promoteTaskCandidate` + abnormal_result_triage hook.

## 9. Testing
- **Unit:** producer (idempotent task from a critical result; assignment precedence; SLA link); engine (overdue-marking; tier-by-tier escalation; once-per-tier idempotency; auto_resolve; backfill creates a missing task); ack stops the clock.
- **Deep/integration (QA DB):** critical lab result → task in assignee inbox → unacked past SLA → T1/T2/T3 escalation notifications recorded → acknowledge halts escalation → resolve closes it.
- **Keep green:** `taskService.test.js`, `tasksWorkflowMigration.test.js`, the tenant-rls suites, schema-drift.
- **Gates (GHA billing-blocked → local-authoritative):** `test:ci` chunked, `lint`, schema-drift.

## 10. Out of scope (explicit)
UI (admin/staff); full `automation_rules` event engine; RCA workflow; non-critical results; cross-tenant/global escalation rollups.
