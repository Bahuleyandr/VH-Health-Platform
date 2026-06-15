# Results-Inbox Safety Net + Escalation Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the dormant mig-118 tasks/workflow/escalation foundation with a real escalation **evaluation engine** + a deterministic **results-inbox producer**, so a critical clinical result becomes an assigned, acknowledgement-tracked task that escalates if unacked.

**Architecture:** Hybrid. A post-commit best-effort hook (`resultsInboxService`) creates a `tasks` row the instant a critical result/alert is recorded; a `withJobLock` cron (`escalationEngineService`) evaluates `escalation_rules` against overdue tasks / breached mig-269 SLA instances and fires actions (notify/reassign/escalate_priority/auto_resolve), with a backfill backstop. Reuses mig-269 `critical_result_ack` as the SLA clock and mig-118 `escalation_rules` for actions. No new SLA system; no UI.

**Tech Stack:** Node 22 / Express 5, PostgreSQL 17 via `src/lib/prisma.js` (`setTenantTx`), raw SQL (spread params, `::type` casts), Jest (chunked `test:ci`), `withJobLock` cron in `src/utils/scheduler.js`, `notificationOutbox` + `securityWebhook`.

**Spec:** [`docs/RESULTS_INBOX_ESCALATION_DESIGN.md`](../../RESULTS_INBOX_ESCALATION_DESIGN.md). **Gates (GHA billing-blocked → local-authoritative):** `npm --prefix apps/backend run lint`, `... run test:ci`, `... run check:schema-drift`.

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `apps/backend/src/migrations/NNN_results_inbox_idempotency.sql` | Create (NNN = next sequential number; check `ls src/migrations | tail`) | Partial unique index on `tasks` for one-open-task-per-resource + idempotent `escalation_rules` tier seed |
| `apps/backend/src/services/workflow/escalationEngineService.js` | Create | The sweeper: overdue-marking + `escalation_rules` evaluation + actions + backfill |
| `apps/backend/src/services/results/resultsInboxService.js` | Create | Producer: critical result/alert → assigned ack-task (idempotent) + AI-bridge `promoteTaskCandidate` |
| `apps/backend/src/utils/scheduler.js` | Modify | Register `runEscalationSweep` (withJobLock, `*/2`, NODE_ENV-guarded) |
| `apps/backend/src/routes/admin/tasksWorkflowRoutes.js` | Modify | Add `GET /tasks/inbox` + `POST /tasks/:id/acknowledge` |
| `apps/backend/src/services/workflow/taskService.js` | Modify | Add `acknowledgeTask(...)` thin wrapper + `listInboxTasks(...)` |
| `apps/backend/src/services/lab/labResultsService.js` | Modify | Post-commit hook on critical lab finalize |
| `apps/backend/src/utils/clinical/vitalSignMonitor.js` | Modify | Post-commit hook on CRITICAL `clinical_alerts` |
| `apps/backend/src/services/ai/clinical_task_extractor` decision path | Modify | Wire dormant `promoteTaskCandidate` on `accepted` |
| `apps/backend/src/tests/unit/escalationEngineService.test.js` | Create | Engine unit tests |
| `apps/backend/src/tests/unit/resultsInboxService.test.js` | Create | Producer unit tests |
| `apps/backend/src/tests/resultsInbox.deep.test.js` | Create | End-to-end deep test (QA DB) |

**Pattern references (read these first — mirror them):** `careTeamPopulationService.js` (best-effort post-commit + `setTenantTx` + `ON CONFLICT`), `breakGlassService.js` + the break-glass sweeper in `scheduler.js` (`withJobLock` cron + history + `securityWebhook`), `canonicalClinicalPlatformService.js` (`workflow_sla_instances` create/lookup), `taskService.js` (the existing CRUD + state machine to build on).

---

## PHASE 1 — Escalation engine (activates the dormant layer)

### Task 1: Seed migration — idempotency index + escalation tier rules

**Files:**
- Create: `apps/backend/src/migrations/NNN_results_inbox_idempotency.sql`
- Test: `apps/backend/src/tests/unit/resultsInboxMigration.test.js`

- [ ] **Step 1: Write the failing test**

```js
// resultsInboxMigration.test.js — mirror tasksWorkflowMigration.test.js structure
import { Client } from 'pg';
const url = process.env.DATABASE_URL || 'postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test';
test('partial unique index uq_task_open_per_resource exists', async () => {
  const c = new Client({ connectionString: url }); await c.connect();
  const r = await c.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_task_open_per_resource'`);
  await c.end();
  expect(r.rows.length).toBe(1);
  expect(r.rows[0].indexdef).toMatch(/related_resource_type/);
});
test('critical-result escalation tiers seeded for default tenant', async () => {
  const c = new Client({ connectionString: url }); await c.connect();
  const r = await c.query(`SELECT trigger_condition, action_kind FROM escalation_rules WHERE display_name LIKE 'Critical result %' ORDER BY id`);
  await c.end();
  expect(r.rows.length).toBeGreaterThanOrEqual(3);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/backend && node --experimental-vm-modules node_modules/jest/bin/jest.js resultsInboxMigration --runInBand`
Expected: FAIL (index/rows absent).

- [ ] **Step 3: Write the migration**

```sql
-- Migration NNN: results-inbox idempotency + escalation tier seed.
BEGIN;

-- One OPEN task per result resource → producer ON CONFLICT DO NOTHING is race-safe.
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_open_per_resource
  ON tasks (tenant_id, related_resource_type, related_resource_id)
  WHERE status IN ('open', 'in_progress', 'blocked')
    AND related_resource_type IS NOT NULL
    AND related_resource_id IS NOT NULL;

-- Default-tenant escalation tiers for the critical_result_ack SLA. Idempotent.
INSERT INTO escalation_rules
  (tenant_id, display_name, description, scope, match_filter, trigger_condition,
   trigger_window_minutes, action_kind, action_payload, is_active)
SELECT '00000000-0000-4000-8000-000000000001'::uuid, v.display_name, v.description,
       'task', v.match_filter::jsonb, 'sla_breach', v.win, v.action_kind, v.action_payload::jsonb, true
FROM (VALUES
  ('Critical result T1 re-notify', 'Re-notify assignee + bump priority at SLA breach',
     '{"task_kind":"review","priority":"critical","sla_key":"critical_result_ack"}', 0,
     'escalate_priority', '{"tier":1,"also_notify":"assignee"}'),
  ('Critical result T2 duty role', 'Notify ward/unit duty/charge role',
     '{"task_kind":"review","priority":"critical","sla_key":"critical_result_ack"}', 10,
     'notify', '{"tier":2,"notify_role":"DUTY"}'),
  ('Critical result T3 leadership', 'Notify clinical leadership + security webhook',
     '{"task_kind":"review","priority":"critical","sla_key":"critical_result_ack"}', 30,
     'notify', '{"tier":3,"notify_role":"LEADERSHIP","security_webhook":true}')
) AS v(display_name, description, match_filter, win, action_kind, action_payload)
WHERE NOT EXISTS (
  SELECT 1 FROM escalation_rules e
  WHERE e.tenant_id = '00000000-0000-4000-8000-000000000001'::uuid
    AND e.display_name = v.display_name);

COMMIT;
```

- [ ] **Step 4: Apply + regen schema + verify**

Run: `cd apps/backend && node scripts/ci-setup-db.mjs && npx prisma db pull --schema=prisma/schema.prisma && node scripts/check-schema-drift.mjs`
Then: `node --experimental-vm-modules node_modules/jest/bin/jest.js resultsInboxMigration --runInBand`
Expected: drift clean; tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/migrations/NNN_results_inbox_idempotency.sql apps/backend/prisma/schema.prisma apps/backend/prisma/SCHEMA_NOTES.md apps/backend/src/tests/unit/resultsInboxMigration.test.js
git commit -m "feat(results-inbox): idempotency index + escalation tier seed (mig NNN)"
```

### Task 2: `escalationEngineService.runEscalationSweep`

**Files:**
- Create: `apps/backend/src/services/workflow/escalationEngineService.js`
- Test: `apps/backend/src/tests/unit/escalationEngineService.test.js`

- [ ] **Step 1: Write the failing tests** (mock `prisma`/`setTenantTx` per the repo mock pattern — see `careTeamPopulationService.test.js`)

```js
// Key cases (write all):
// 1. marks an open task past due_at as 'overdue'
// 2. on sla_breach + tier rule, escalate_priority bumps priority + records metadata.escalations[{tier:1}]
// 3. once-per-(task,rule,tier): a second sweep does NOT re-fire (escalations already has tier)
// 4. tier-2 notify enqueues a notificationOutbox entry to the duty role
// 5. tier-3 sets security_webhook → sendSecurityWebhook called
// 6. acknowledged (status in_progress) task is NOT escalated
// 7. backfill: a breached critical SLA instance with no task → producer called once
// 8. never throws: a per-task error is logged + sweep continues
```

- [ ] **Step 2: Run to verify fail** — `... jest.js escalationEngineService --runInBand` → FAIL (module missing).

- [ ] **Step 3: Implement** the service. Core shape:

```js
// escalationEngineService.js
import { prisma, setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { queue as queueNotification } from '../../utils/notifications/notificationOutbox.js';
import { sendSecurityWebhook } from '../../utils/securityWebhook.js';
import { enqueueCriticalResultTask } from '../results/resultsInboxService.js';

// Evaluate active escalation_rules vs overdue tasks + breached SLA instances, per tenant.
export async function runEscalationSweep({ now = undefined, limit = 500 } = {}) {
  const counters = { scanned: 0, markedOverdue: 0, escalated: 0, autoResolved: 0, backfilled: 0 };
  // (a) mark overdue: open/in_progress/blocked tasks past due_at → status 'overdue' (tenant-agnostic admin sweep
  //     uses a superAdmin-scoped read; per-tenant write via setTenantTx). Use prisma.$executeRawUnsafe with ::uuid casts.
  // (b) load active escalation_rules (scope='task'); for each, find matching tasks
  //     (match_filter → task_kind/priority/sla_key) whose trigger holds:
  //       'sla_breach'      → joined mig-269 workflow_sla_instances.status='breached' (sla_key match) OR tasks.sla_breached_at <= now
  //       'pending_too_long'→ now - created_at >= trigger_window_minutes
  //     SKIP tasks whose status is 'completed'/'cancelled'; SKIP if metadata.escalations already contains this rule's tier.
  //   For each match, apply action_kind:
  //       escalate_priority → set priority='critical'; if also_notify, queue assignee notification
  //       notify            → resolve notify_role (DUTY/LEADERSHIP → real role codes via roleHelpers), queueNotification;
  //                           if action_payload.security_webhook → sendSecurityWebhook('CRITICAL_RESULT_UNACKED', {...})
  //       reassign          → taskService.reassignTask to action_payload.role
  //       auto_resolve      → taskService.transitionTask → 'completed' with reason
  //   Record append to tasks.metadata.escalations = [...prev, {tier, at: nowIso, action, rule_id}] (jsonb_set / re-serialize).
  // (c) backfill: critical_result_ack instances status='breached' with no task referencing the result →
  //       call enqueueCriticalResultTask(derived ctx); counters.backfilled++.
  // Each per-task block in try/catch (log + continue). All writes via setTenantTx(tenantId, ...).
  return counters;
}
```

Mirror the break-glass sweeper's structure; use `roleHelpers` to map DUTY/LEADERSHIP → concrete role codes; use `jsonb_set` or read-modify-write for `metadata.escalations` with `::jsonb` casts (raw-param rules).

- [ ] **Step 4: Run tests to pass** — `... jest.js escalationEngineService --runInBand` → PASS (8 cases).

- [ ] **Step 5: Commit** — `git add ...escalationEngineService.js ...escalationEngineService.test.js && git commit -m "feat(results-inbox): escalation evaluation engine (sweep + tiers + backfill)"`

### Task 3: Register the sweep on the scheduler

**Files:** Modify `apps/backend/src/utils/scheduler.js`

- [ ] **Step 1:** Add a test in `scheduler.test.js` (if present) asserting `results-inbox-escalation` is registered; else verify by grep.
- [ ] **Step 2:** Implement — mirror the break-glass sweeper registration exactly:

```js
import { runEscalationSweep } from '../services/workflow/escalationEngineService.js';
// inside the NODE_ENV !== 'test' guarded block, alongside other crons:
cron.schedule('*/2 * * * *', () => withJobLock('results-inbox-escalation', () => runEscalationSweep()));
// add runEscalationSweep() to runAllScheduledTasksNow() too.
```

- [ ] **Step 3:** Verify: `npm --prefix apps/backend run lint` clean; grep confirms registration.
- [ ] **Step 4: Commit** — `git commit -am "feat(results-inbox): schedule escalation sweep every 2m (withJobLock)"`

---

## PHASE 2 — Producer + inbox + acknowledge

### Task 4: `resultsInboxService.enqueueCriticalResultTask` (producer)

**Files:**
- Create: `apps/backend/src/services/results/resultsInboxService.js`
- Test: `apps/backend/src/tests/unit/resultsInboxService.test.js`

- [ ] **Step 1: Failing tests** (mock prisma + taskService):

```js
// 1. creates a task: priority from severity (critical→critical, high→high), task_kind='review',
//    related_resource_type/_id set, assigned_to_uid=orderingClinicianUid, metadata.sla_instance_id set
// 2. idempotent: second call for same (resourceType,resourceId) → ON CONFLICT → { created:false }
// 3. no orderingClinicianUid → assigned_to_role from careTeamRoleHint/DUTY fallback
// 4. never throws on DB error → returns { created:false, error:... }, logs
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement:**

```js
// resultsInboxService.js
import { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import * as taskService from '../workflow/taskService.js';
import { ensureCriticalResultSlaInstance } from '../clinical/canonicalClinicalPlatformService.js'; // reuse mig-269

const SEVERITY_PRIORITY = { critical: 'critical', high: 'high', moderate: 'normal' };

export async function enqueueCriticalResultTask({
  tenantId, patientUid, source, resourceType, resourceId, severity,
  title, summary, orderingClinicianUid, careTeamRoleHint, slaKey = 'critical_result_ack',
}) {
  try {
    return await setTenantTx(tenantId, async (tx) => {
      const sla = await ensureCriticalResultSlaInstance(tx, { tenantId, patientUid, slaKey, resourceType, resourceId });
      const created = await taskService.createTask({
        tenantId, tx,
        task_kind: 'review',
        title: title || `Critical ${source}: review required`,
        description: summary || null,
        patient_uid: patientUid,
        related_resource_type: resourceType,
        related_resource_id: String(resourceId),
        priority: SEVERITY_PRIORITY[severity] || 'high',
        assigned_to_uid: orderingClinicianUid || null,
        assigned_to_role: orderingClinicianUid ? null : (careTeamRoleHint || 'DUTY'),
        metadata: { source, sla_instance_id: sla?.id || null, sla_key: slaKey },
        onConflictResourceDoNothing: true, // taskService uses the uq_task_open_per_resource index
      });
      return { created: !!created?.id, taskId: created?.id || null };
    });
  } catch (err) {
    logger.error('enqueueCriticalResultTask failed', { err: err.message, resourceType, resourceId });
    return { created: false, error: err.message };
  }
}

export async function promoteTaskCandidate(candidateId, { tenantId } = {}) {
  // DORMANT bridge: read accepted clinical_ai_task_candidates row → enqueueCriticalResultTask
  // (resourceType='task_candidate'). No-op if not accepted. See Task 8.
}
```

Add `createTask` support for `tx` + `onConflictResourceDoNothing` (an `ON CONFLICT (...) DO NOTHING` branch keyed to `uq_task_open_per_resource`) in `taskService.js` if not present — follow its existing INSERT.

- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(results-inbox): resultsInboxService producer (idempotent critical-result task)"`

### Task 5: Deterministic producer hooks (lab + vitals)

**Files:** Modify `labResultsService.js` (critical-finalize path) + `vitalSignMonitor.js` (CRITICAL alert path).

- [ ] **Step 1:** Failing deep assertions added to `resultsInbox.deep.test.js` (Task 7) — defer running to Task 7.
- [ ] **Step 2: Implement hooks** — post-commit best-effort (mirror the care-team admission hook at `admissionService.js`):

```js
// in labResultsService, after a result is finalized + flagged critical, post-commit:
import { enqueueCriticalResultTask } from '../results/resultsInboxService.js';
// ...after the result tx commits:
enqueueCriticalResultTask({
  tenantId: req?.tenantId || result.tenant_id, patientUid: result.patient_uid,
  source: 'lab_result', resourceType: 'lab_result', resourceId: result.id,
  severity: result.critical ? 'critical' : 'high',
  title: `Critical lab: ${result.test_name}`, summary: result.value_summary,
  orderingClinicianUid: result.ordering_clinician_uid,
}).catch(() => {}); // never blocks
```

Same shape in `vitalSignMonitor.js` where a CRITICAL `clinical_alerts` row is persisted (`source:'vital_alert'`, `resourceType:'clinical_alert'`).

- [ ] **Step 3:** Lint clean. (Behavior verified in Task 7's deep test.)
- [ ] **Step 4: Commit** — `git commit -am "feat(results-inbox): wire critical lab + vital-alert producer hooks (post-commit, best-effort)"`

### Task 6: `acknowledgeTask` + `listInboxTasks` in taskService

**Files:** Modify `taskService.js`; Test `taskService.test.js` (extend).

- [ ] **Step 1: Failing tests:**

```js
// acknowledgeTask: open→in_progress, sets metadata.acknowledged_at + a 'state_change' task_comment, returns task
// acknowledgeTask on completed → throws invalidTransition
// listInboxTasks({assigneeUid, roles}): returns open/in_progress/overdue for me-or-my-role ordered by priority,due_at
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** both (reuse `transitionTask` for the state change; `listInboxTasks` wraps `listTasks` with an assignee-OR-role filter).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(results-inbox): acknowledgeTask + listInboxTasks"`

### Task 7: Inbox + acknowledge routes + end-to-end deep test

**Files:** Modify `tasksWorkflowRoutes.js`; Create `resultsInbox.deep.test.js`.

- [ ] **Step 1: Failing deep test** (QA DB; mirror an existing `*.deep.test.js`):

```js
// E2E: insert a critical lab result → call enqueueCriticalResultTask → assert task appears in
//   listInboxTasks for the ordering clinician; advance the SLA instance to breached →
//   runEscalationSweep() → assert tier-1 escalation recorded + a notificationOutbox row;
//   acknowledgeTask → second sweep does NOT escalate further; resolve → task completed.
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement routes** in `tasksWorkflowRoutes.js` (reuse existing `success`/`error`, the router's RBAC):

```js
router.get('/tasks/inbox', wrapAsync(async (req, res) => {
  const rows = await taskService.listInboxTasks({ tenantId: req.tenantId, assigneeUid: req.user.uid, roles: req.user.roles || [req.user.role] });
  return success(res, rows);
}));
router.post('/tasks/:id/acknowledge', wrapAsync(async (req, res) => {
  const t = await taskService.acknowledgeTask({ tenantId: req.tenantId, id: Number(req.params.id), actorUid: req.user.uid });
  return success(res, t, 'Acknowledged');
}));
```

- [ ] **Step 4:** Run the deep test (`node apps/backend/scripts/qa-cluster-up.mjs` first) → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(results-inbox): inbox + acknowledge routes + e2e deep test"`

---

## PHASE 3 — Dormant AI bridges

### Task 8: `promoteTaskCandidate` + abnormal_result_triage hook (dormant)

**Files:** Modify `resultsInboxService.js` (fill `promoteTaskCandidate`) + the `clinical_ai_task_candidates` decide path + `abnormalResultTriage` service. Test: `resultsInboxService.test.js` (extend).

- [ ] **Step 1: Failing tests:** accepted candidate → `enqueueCriticalResultTask` called with `resourceType:'task_candidate'`; non-accepted → no-op.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** `promoteTaskCandidate` (read the candidate; if `reviewer_decision='accepted'` → enqueue with the candidate's title/priority/owner_role/patient). Wire a best-effort call where a candidate is marked accepted, and where `abnormal_result_triage` produces an accepted output. These paths are inert until those AI modules are enabled (they produce nothing today).
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(results-inbox): dormant AI-producer bridges (task-candidate + abnormal-triage)"`

---

## Final: full verification

- [ ] `npm --prefix apps/backend run lint` → clean (eslint + lint:raw-params + phi-tenant-id + secrets:scan)
- [ ] `npm --prefix apps/backend run check:schema-drift` → no drift
- [ ] `node apps/backend/scripts/qa-cluster-up.mjs && npm --prefix apps/backend run test:ci` → all chunks pass (incl. the new + the kept-green tenant-rls / taskService suites)
- [ ] Push both remotes (origin + `git fetch github && git push github HEAD:refs/heads/main`); note GHA is billing-blocked (local gates authoritative).

---

## Self-Review (done by author)

- **Spec coverage:** engine (T2/T3), producer (T4/T5), inbox+ack (T6/T7), idempotency migration + seed (T1), SLA reconciliation (reuse mig-269 in T4 + sla_breach join in T2), backfill backstop (T2 step c), dormant AI bridges (T8), reliability/best-effort (T5 hooks, T2 try/catch), testing (each task + final). All spec sections mapped.
- **Type consistency:** `enqueueCriticalResultTask` signature identical in T4 + T2 + T5 + T8; `runEscalationSweep` counters consistent; `acknowledgeTask`/`listInboxTasks` names consistent T6↔T7.
- **Known implementation lookups (resolve against code, not placeholders):** the exact `NNN` migration number; the real DUTY/LEADERSHIP role codes (from `roleHelpers`/`rolePolicyGraph`); whether `taskService.createTask` already accepts `tx`/`onConflict` (extend if not, per T4); the exact `ensureCriticalResultSlaInstance` export name in `canonicalClinicalPlatformService` (T4 — use the existing create/lookup fn).
