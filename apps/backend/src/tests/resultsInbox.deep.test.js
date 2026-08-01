// Results-inbox safety net — END-TO-END deep test (real producer + engine + DB).
//
// Design docs/RESULTS_INBOX_ESCALATION_DESIGN.md §4 + §9. Proves the full
// pipeline against the REAL services + the QA DB, inside a tenant this suite
// creates and drops:
//
//   1. enqueueCriticalResultTask (the producer) turns a critical lab result into
//      an assigned, ack-tracked `tasks` row linked to a mig-269
//      critical_result_ack SLA instance (workflow_sla_instance_id).
//   2. The task appears in the ordering clinician's GET /tasks/inbox
//      (listInboxTasks for assignee = me).
//   3. SLA breach: with `now` advanced past the instance due_at, runEscalationSweep
//      records tier-1 in metadata.escalations[] and bumps priority → critical.
//   4. As `now` advances across the tier windows (0/10/30 min after breach), later
//      sweeps record tier-2 then tier-3 — each rule fires exactly once.
//   5. acknowledge (open/overdue → in_progress) HALTS escalation: a subsequent
//      sweep records NO new tier (in_progress is the acked, non-escalatable state).
//   6. resolve (→ completed) closes the task.
//
// `now` is injected into runEscalationSweep so the test does not have to wait the
// real 15-minute SLA + tier windows. The SLA instance + escalation tiers are the
// real pre-seeded rows (mig-269 critical_result_ack @ 15min; mig-312 T1/T2/T3).
//
// ---------------------------------------------------------------------------
// TENANT OWNERSHIP (post-#675/#678 pattern — see cath-scheduling-registry and
// nabh-indicators). This suite used to run on the DEFAULT tenant, where three of
// its assertions were hostage to state the comprehensive seeder and every
// cohabiting suite can write:
//
//   * listInboxTasks pages the assignee's tasks UNION the unassigned queue for
//     the actor's role, ORDER BY priority, due_at, created_at DESC LIMIT 50
//     (taskService DEFAULT_LIST_LIMIT). Fifty critical DOCTOR-queue tasks in the
//     default tenant evict this suite's task from the page and
//     `toContain(taskId)` fails.
//   * the exact COUNT(*) assertions over (tenant, resource_type, resource_id)
//     only hold while no cohabiting suite writes the same synthetic resource id;
//     SUFFIX is `Date.now() % 100000`, which recycles every 100 seconds.
//   * runEscalationSweep is global over every tenant holding active task-scope
//     escalation rules, so the exact `tiersOf(task)` assertions were coupled to
//     the sibling suite resultsInboxC3Escalation.deep, which pinned its SLA to
//     the SAME 2026-06-15 breach literal — the structural near-miss the
//     2026-08-01 fixed-date sweep flagged (PR #676).
//
// The suite now creates TENANT (+ TENANT_DECOY) in beforeAll and drops both in
// afterAll; nothing is read or written outside them. The mig-312 tier rules are
// CLONED from the default tenant rather than restated, so the fixture cannot
// drift from the migration, and the clone is asserted to be the 0/10/30 triple.
//
// TENANT_DECOY carries an identically-shaped task — same resource id, same
// breach instant, same critical priority — so the isolation guarantee stays
// honest: were tenant scoping to regress, the exact counts and the exact tier
// arrays below would move rather than hold. The tier-1 test PRE-ASSERTS that the
// decoy task really is a sweep candidate at that same injected `now`, so the
// guard cannot go silently vacuous.
//
// Residual, engine-level and deliberately out of scope for a test file:
// runEscalationSweep still iterates every tenant with active rules, so a foreign
// sweep running CONCURRENTLY against this database could still advance these
// tiers. CI and the chunked local runner both drive jest with --runInBand
// (scripts/run-ci-jest.mjs), so no second suite is ever in flight; the tenant
// split is what removes the shared-state coupling a serial run can actually hit.

import { jest } from '@jest/globals';

const prisma = (await import('../lib/prisma.js')).default;
const { setTenantTx } = await import('../lib/prisma.js');
const { DEFAULT_TENANT_ID } = await import('../services/tenant/tenantService.js');
const {
  enqueueCriticalResultTask,
  ensureCriticalResultTaskOpen,
} = await import('../services/results/resultsInboxService.js');
const { runEscalationSweep } = await import('../services/workflow/escalationEngineService.js');
const taskService = await import('../services/workflow/taskService.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// This suite's own tenant + its decoy. Both satisfy tenantContextMiddleware's
// UUID shape (version nibble [1-5], variant [89ab]) even though this suite calls
// the services directly rather than over HTTP, so the ids stay reusable if these
// paths ever grow an HTTP surface.
const TENANT = 'd5100000-0000-4000-8000-00000000c110';
const TENANT_DECOY = 'd5100000-0000-4000-8000-00000000dec0';

// tenants(id) is referenced by ~685 foreign keys, so every tenant DELETE pays a
// check per constraint (~2s each here). Both hooks below therefore carry an
// explicit timeout: jest's 5s default is not enough, and a standalone run must
// not silently depend on the CI runner's --testTimeout=60000.
const HOOK_TIMEOUT_MS = 120000;

const SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const PATIENT_UID = `c1100000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
// The ordering clinician — becomes the task assignee (assigned_to_uid).
const DOCTOR_UID = `c1200000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const PATIENT_PHONE = `+9198001${SUFFIX}`;
const DOCTOR_PHONE = `+9198002${SUFFIX}`;
// T2/T3 notify targets. Not asserted here (resultsInboxC3Escalation.deep owns
// recipient resolution) but seeded so the notify tiers below resolve to real
// people, exactly as they did on the default tenant. Without them the engine
// takes its "tier resolved to NO recipient" branch and pages the security
// webhook on every sweep — a behaviour change this refactor must not introduce.
const DUTY_UID = `c1500000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const CMO_UID = `c1600000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const DUTY_PHONE = `+9198005${SUFFIX}`;
const CMO_PHONE = `+9198006${SUFFIX}`;
// Decoy-tenant mirror of the same two actors (users.uid and users.phone are
// globally unique, so the decoy needs its own).
const DECOY_PATIENT_UID = `c1300000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const DECOY_DOCTOR_UID = `c1400000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const DECOY_DUTY_UID = `c1700000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const DECOY_CMO_UID = `c1800000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const DECOY_PATIENT_PHONE = `+9198003${SUFFIX}`;
const DECOY_DOCTOR_PHONE = `+9198004${SUFFIX}`;
const DECOY_DUTY_PHONE = `+9198007${SUFFIX}`;
const DECOY_CMO_PHONE = `+9198008${SUFFIX}`;
// A unique resource id per run so the open-task idempotency index never collides
// with a previous run's leftover row. Deliberately SHARED with the decoy tenant:
// uq_task_open_per_resource is keyed (tenant_id, type, id), so the same id living
// in both tenants is exactly what makes the COUNT assertions probative.
const RESOURCE_ID = `9${SUFFIX}`;
const RESOURCE_TYPE = 'lab_result';

// Helpers to read a task's escalation tiers + SLA instance directly.
async function readTask(taskId, tenantId = TENANT) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, priority, assigned_to_uid,
            due_at, workflow_sla_instance_id, sla_completion_semantics, metadata
       FROM tasks WHERE id = $1::int AND tenant_id = $2::uuid LIMIT 1`,
    taskId, tenantId,
  );
  return rows[0] || null;
}

function tiersOf(taskRow) {
  const esc = Array.isArray(taskRow?.metadata?.escalations) ? taskRow.metadata.escalations : [];
  return esc.map((e) => e.tier).sort((a, b) => a - b);
}

// Force the linked SLA instance to look breached AS OF a chosen moment, so the
// engine's COALESCE(breached_at, due_at, …) breach clock is deterministic.
//
// Returns the breach moment AS THE ENGINE SEES IT. The engine reads breach_at
// via prisma.$queryRawUnsafe, whose timestamptz → JS Date deserialization on
// this server reinterprets the stored wall-clock value in the server TZ (the
// documented "Postgres timezone matters" gotcha in apps/backend/CLAUDE.md). The
// injected `now` we pass to runEscalationSweep is a real UTC Date, so to compare
// apples-to-apples we anchor the tier windows to the SAME read-back value the
// engine will use, not to the literal we wrote.
async function setSlaBreachedAt(slaInstanceId, whenIso, tenantId = TENANT) {
  await setTenantTx(tenantId, async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE tasks
          SET due_at = $2::timestamptz, updated_at = NOW()
        WHERE workflow_sla_instance_id = $1::uuid
          AND tenant_id = $3::uuid`,
      slaInstanceId, whenIso, tenantId,
    );
    await tx.$executeRawUnsafe(
      `UPDATE workflow_sla_instances
          SET status = 'breached', breached_at = $2::timestamptz,
              due_at = $2::timestamptz, updated_at = NOW()
        WHERE id = $1::uuid AND tenant_id = $3::uuid`,
      slaInstanceId, whenIso, tenantId,
    );
  });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT breached_at FROM workflow_sla_instances WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    slaInstanceId, tenantId,
  );
  return new Date(rows[0].breached_at);
}

// Copy the mig-312 critical_result_ack tier rules (T1 @0 / T2 @10 / T3 @30) into
// a suite-owned tenant. Cloned FROM the default-tenant rows rather than restated
// so the fixture cannot drift from the migration, and so runEscalationSweep's
// tenant discovery (SELECT DISTINCT tenant_id FROM escalation_rules WHERE
// is_active AND scope='task') actually reaches this tenant at all.
async function cloneCriticalResultEscalationRules(tenantId) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO escalation_rules
       (tenant_id, display_name, description, scope, match_filter, trigger_condition,
        trigger_window_minutes, action_kind, action_payload, is_active)
     SELECT $2::uuid, display_name, description, scope, match_filter, trigger_condition,
            trigger_window_minutes, action_kind, action_payload, is_active
       FROM escalation_rules
      WHERE tenant_id = $1::uuid
        AND scope = 'task'
        AND is_active = TRUE
        AND (match_filter->>'sla_key') = 'critical_result_ack'`,
    DEFAULT_TENANT_ID, tenantId,
  );
  const cloned = await prisma.$queryRawUnsafe(
    `SELECT trigger_window_minutes AS win FROM escalation_rules
      WHERE tenant_id = $1::uuid AND scope = 'task' AND is_active = TRUE
      ORDER BY trigger_window_minutes`,
    tenantId,
  );
  return cloned.map((r) => Number(r.win));
}

async function cleanup() {
  // Escalation notifications are queued on the outbox singleton (outside the
  // tenant transaction), so those rows land on the DEFAULT tenant regardless of
  // the task's tenant — clean them by this run's unique patient uids, not by
  // tenant.
  await prisma.$executeRawUnsafe(
    `DELETE FROM notification_outbox
      WHERE (payload->>'kind') = 'results_inbox_escalation'
        AND (payload->>'patient_uid') IN ($1::text, $2::text)`,
    PATIENT_UID, DECOY_PATIENT_UID,
  ).catch(() => {});

  // Typed tasks and their SLA clocks are intentionally delete-protected. This
  // teardown is confined to the disposable superuser test database and to
  // tenants this suite created; no production cleanup path gets a bypass.
  for (const tenantId of [TENANT, TENANT_DECOY]) {
    await setTenantTx(tenantId, async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      // Children before parents, every statement scoped to this suite's tenant.
      await tx.$executeRawUnsafe(
        `DELETE FROM task_comments WHERE tenant_id = $1::uuid`, tenantId,
      );
      await tx.$executeRawUnsafe(`DELETE FROM tasks WHERE tenant_id = $1::uuid`, tenantId);
      await tx.$executeRawUnsafe(
        `DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid`, tenantId,
      );
      // The producer emits neither of these today, but the sibling suite's
      // clinical path emits both, and pathway_projector_inbox only materialises
      // once the comprehensive seeder has installed pathway definitions. Kept
      // here so a future producer change cannot leak a tenant past this teardown.
      await tx.$executeRawUnsafe(
        `DELETE FROM pathway_projector_inbox WHERE tenant_id = $1::uuid`, tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM event_outbox WHERE tenant_id = $1::uuid`, tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM escalation_rules WHERE tenant_id = $1::uuid`, tenantId,
      );
      await tx.$executeRawUnsafe(`DELETE FROM users WHERE tenant_id = $1::uuid`, tenantId);
    }).catch(() => {});
  }
  // Parent last — every child above carries an FK to tenants(id).
  //
  // Deliberately NOT swallowed. A tenant this suite cannot drop is a leak, and a
  // leaked tenant here is worse than a leaked row: it keeps ACTIVE escalation
  // rules, so every later runEscalationSweep in the same database would go on
  // visiting it. The FK error names the offending child table, which is the most
  // actionable signal available, so let it surface as a failed hook.
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, TENANT, TENANT_DECOY,
  );
}

d('Results-inbox pipeline (deep, real producer + engine + DB)', () => {
  let taskId = null;
  let slaInstanceId = null;
  let decoyTaskId = null;
  // The breach moment the test pins the SLA instance to. This is a WINDOW
  // BOUNDARY, not a stable fixture attribute — the engine measures every
  // trigger_window_minutes forward from it — so it is anchored relative to run
  // time rather than to a calendar literal. The old fixed '2026-06-15T00:00:00Z'
  // was shared verbatim with resultsInboxC3Escalation.deep, which aliased the
  // two suites' tier windows under the global sweep.
  //
  // The ENGINE-VISIBLE breach Date (after timestamptz→JS round-trip, see
  // setSlaBreachedAt) is captured at breach time and the tier windows are
  // measured forward from it, so the comparison against the injected `now` is
  // consistent regardless of the server-TZ deserialization quirk.
  const breachLiteral = new Date(Date.now() - 45 * 24 * 60 * 60_000).toISOString();
  let breachSeen = null; // set in the tier-1 test once the instance is breached
  let afterT1 = null;
  let afterT2 = null;
  let afterT3 = null;

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, 'ritest-inbox', 'RITEST Results Inbox Tenant', 'IN', 'DPDP', 'active'),
              ($2::uuid, 'ritest-inbox-decoy', 'RITEST Results Inbox Decoy', 'IN', 'DPDP', 'active')
       ON CONFLICT (id) DO NOTHING`,
      TENANT, TENANT_DECOY,
    );
    // Every fixture row sets tenant_id EXPLICITLY: raw inserts run with
    // app.current_tenant_id unset, so an omitted tenant_id silently falls to the
    // column DEFAULT (the default tenant) and the suite would measure nothing it
    // created.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'RI Patient [test]', 'PATIENT', true, $3::uuid, NOW()),
              ($4::uuid, $5, 'RI Doctor [test]', 'DOCTOR', true, $3::uuid, NOW()),
              ($6::uuid, $7, 'RI Duty Doc [test]', 'DUTY_DOCTOR', true, $3::uuid, NOW()),
              ($8::uuid, $9, 'RI CMO [test]', 'CMO', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, TENANT, DOCTOR_UID, DOCTOR_PHONE,
      DUTY_UID, DUTY_PHONE, CMO_UID, CMO_PHONE,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'RI Decoy Patient [test]', 'PATIENT', true, $3::uuid, NOW()),
              ($4::uuid, $5, 'RI Decoy Doctor [test]', 'DOCTOR', true, $3::uuid, NOW()),
              ($6::uuid, $7, 'RI Decoy Duty Doc [test]', 'DUTY_DOCTOR', true, $3::uuid, NOW()),
              ($8::uuid, $9, 'RI Decoy CMO [test]', 'CMO', true, $3::uuid, NOW())`,
      DECOY_PATIENT_UID, DECOY_PATIENT_PHONE, TENANT_DECOY,
      DECOY_DOCTOR_UID, DECOY_DOCTOR_PHONE,
      DECOY_DUTY_UID, DECOY_DUTY_PHONE, DECOY_CMO_UID, DECOY_CMO_PHONE,
    );

    // The tier rules must exist in BOTH tenants: in TENANT so this suite's tiers
    // fire at all, and in TENANT_DECOY so the decoy is a genuine sweep candidate
    // rather than a row the engine never looks at.
    const windows = await cloneCriticalResultEscalationRules(TENANT);
    const decoyWindows = await cloneCriticalResultEscalationRules(TENANT_DECOY);
    // Non-vacuity guard on the clone itself: if mig-312's tiers ever change, this
    // is where you find out, instead of inside a confusing tier assertion below.
    expect(windows).toEqual([0, 10, 30]);
    expect(decoyWindows).toEqual([0, 10, 30]);

    // Decoy fixture: identical shape, identical resource id, identical breach
    // instant — in a different tenant. Created here (not lazily) so it is already
    // in flight for the very first assertion.
    const decoy = await enqueueCriticalResultTask({
      tenantId: TENANT_DECOY,
      patientUid: DECOY_PATIENT_UID,
      source: 'lab_result',
      resourceType: RESOURCE_TYPE,
      resourceId: RESOURCE_ID,
      severity: 'critical',
      title: 'Critical lab: Potassium (decoy)',
      summary: 'Decoy-tenant critical potassium.',
      orderingClinicianUid: DECOY_DOCTOR_UID,
    });
    expect(decoy.created).toBe(true);
    decoyTaskId = decoy.taskId;
    const decoyTask = await readTask(decoyTaskId, TENANT_DECOY);
    await setSlaBreachedAt(decoyTask.workflow_sla_instance_id, breachLiteral, TENANT_DECOY);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, HOOK_TIMEOUT_MS);

  it('producer creates an assigned, SLA-linked critical-result task', async () => {
    const res = await enqueueCriticalResultTask({
      tenantId: TENANT,
      patientUid: PATIENT_UID,
      source: 'lab_result',
      resourceType: RESOURCE_TYPE,
      resourceId: RESOURCE_ID,
      severity: 'critical',
      title: 'Critical lab: Potassium',
      summary: 'Potassium = 7.1 mmol/L (threshold high 6.0).',
      orderingClinicianUid: DOCTOR_UID,
    });

    expect(res.created).toBe(true);
    expect(res.taskId).toBeTruthy();
    taskId = res.taskId;
    // The decoy already holds an OPEN task for the SAME (type, id) pair; the
    // producer still created ours, proving uq_task_open_per_resource is keyed by
    // tenant and the producer's conflict probe is tenant-scoped.
    expect(taskId).not.toBe(decoyTaskId);

    const task = await readTask(taskId);
    expect(task.status).toBe('open');
    expect(task.priority).toBe('critical');
    expect(task.assigned_to_uid).toBe(DOCTOR_UID);
    expect(task.metadata.source).toBe('lab_result');
    // The mig-269 critical_result_ack SLA instance is linked as the clock.
    expect(task.workflow_sla_instance_id).toBeTruthy();
    expect(task.sla_completion_semantics).toBe('acknowledgement');
    slaInstanceId = task.workflow_sla_instance_id;
    expect(task.metadata.sla_key).toBe('critical_result_ack');
    const deadlineRows = await prisma.$queryRawUnsafe(
      `SELECT t.due_at AS task_due_at,
              sla.due_at AS sla_due_at,
              t.due_at = sla.due_at AS exact_deadline,
              sla.assigned_user_uid AS sla_assigned_user_uid,
              sla.assigned_role_codes AS sla_assigned_role_codes
         FROM tasks t
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = t.tenant_id
          AND sla.id = t.workflow_sla_instance_id
        WHERE t.tenant_id = $1::uuid
          AND t.id = $2::int`,
      TENANT,
      taskId,
    );
    expect(deadlineRows[0].task_due_at).toBeTruthy();
    expect(deadlineRows[0].sla_due_at).toBeTruthy();
    expect(deadlineRows[0].exact_deadline).toBe(true);
    expect(deadlineRows[0].sla_assigned_user_uid).toBeNull();
    expect(deadlineRows[0].sla_assigned_role_codes).toEqual([]);
  });

  it('is idempotent: a second producer call for the same resource creates no new task', async () => {
    const again = await enqueueCriticalResultTask({
      tenantId: TENANT,
      patientUid: PATIENT_UID,
      source: 'lab_result',
      resourceType: RESOURCE_TYPE,
      resourceId: RESOURCE_ID,
      severity: 'critical',
      orderingClinicianUid: DOCTOR_UID,
    });
    expect(again.created).toBe(false);

    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM tasks
        WHERE tenant_id = $1::uuid AND related_resource_type = $2 AND related_resource_id = $3
          AND status IN ('open', 'in_progress', 'overdue', 'blocked')`,
      TENANT, RESOURCE_TYPE, RESOURCE_ID,
    );
    expect(rows[0].n).toBe(1);
    // Pre-assertion: the decoy tenant really does hold its own open task for the
    // very same resource id. The count above staying at 1 is what proves scoping,
    // and this is what stops that proof from being vacuous.
    const decoyRows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM tasks
        WHERE tenant_id = $1::uuid AND related_resource_type = $2 AND related_resource_id = $3
          AND status IN ('open', 'in_progress', 'overdue', 'blocked')`,
      TENANT_DECOY, RESOURCE_TYPE, RESOURCE_ID,
    );
    expect(decoyRows[0].n).toBe(1);
  });

  it('appears in the ordering clinician inbox (me)', async () => {
    const inbox = await taskService.listInboxTasks({
      tenantId: TENANT,
      assigneeUid: DOCTOR_UID,
      roles: ['DOCTOR'],
      primaryRole: 'DOCTOR',
      rawRole: 'DOCTOR',
    });
    const ids = inbox.tasks.map((t) => t.id);
    expect(ids).toContain(taskId);
    const mine = inbox.tasks.find((t) => t.id === taskId);
    expect(mine.status).toBe('open');
    // The identically-shaped decoy task is not on this page. The inbox is a
    // tenant-scoped LIMIT 50 page ordered by priority/due_at, so this is the
    // assertion that would have failed first once the shared default tenant
    // accumulated fifty critical DOCTOR-queue tasks.
    expect(ids).not.toContain(decoyTaskId);
  });

  it('SLA breach → tier-1 escalation recorded (priority bump + metadata.escalations[tier:1])', async () => {
    breachSeen = await setSlaBreachedAt(slaInstanceId, breachLiteral);
    // Tier windows are 0 / 10 / 30 min after the breach; pad +1 min past each.
    afterT1 = new Date(breachSeen.getTime() + 1 * 60_000);
    afterT2 = new Date(breachSeen.getTime() + 11 * 60_000);
    afterT3 = new Date(breachSeen.getTime() + 31 * 60_000);

    const counters = await runEscalationSweep({ now: afterT1 });
    expect(counters.escalated).toBeGreaterThanOrEqual(1);

    const task = await readTask(taskId);
    expect(tiersOf(task)).toEqual([1]);
    expect(task.priority).toBe('critical');
    // The fired escalation entry carries the rule action + a rule_id.
    const t1 = task.metadata.escalations.find((e) => e.tier === 1);
    expect(t1.action).toBe('escalate_priority');
    expect(t1.rule_id).toBeTruthy();

    // Pre-assertion that keeps the isolation guard honest: the decoy tenant's
    // task, breached at the SAME instant, IS a candidate at this same injected
    // `now` and escalated too. Without it the exact tier arrays above could be
    // passing merely because the sweep never reached a second tenant.
    expect(tiersOf(await readTask(decoyTaskId, TENANT_DECOY))).toEqual([1]);
  });

  it('does not re-fire tier-1 on a repeat sweep at the same window', async () => {
    await runEscalationSweep({ now: afterT1 });
    const task = await readTask(taskId);
    expect(tiersOf(task)).toEqual([1]); // still only tier 1, once
  });

  it('later windows add tier-2 then tier-3 (each once)', async () => {
    await runEscalationSweep({ now: afterT2 });
    let task = await readTask(taskId);
    expect(tiersOf(task)).toEqual([1, 2]);

    await runEscalationSweep({ now: afterT3 });
    task = await readTask(taskId);
    expect(tiersOf(task)).toEqual([1, 2, 3]);

    // The tier-2 entry is a notify action (duty role); tier-3 is the leadership
    // + security-webhook notify.
    expect(task.metadata.escalations.find((e) => e.tier === 2).action).toBe('notify');
    expect(task.metadata.escalations.find((e) => e.tier === 3).action).toBe('notify');
  });

  it('acknowledge halts escalation: a later sweep records no new tier', async () => {
    // The task may be 'overdue' by now (sweeps mark past-due open tasks). Ack
    // moves open|overdue → in_progress and stops the clock.
    const acked = await taskService.acknowledgeTask({
      tenantId: TENANT,
      id: taskId,
      actorUid: DOCTOR_UID,
      actorRoles: ['DOCTOR'],
      actorPrimaryRole: 'DOCTOR',
      actorRawRole: 'DOCTOR',
    });
    expect(acked.status).toBe('in_progress');
    expect(acked.metadata.acknowledged_at).toBeTruthy();

    // Advance well past every tier window — but because the task is acked
    // (in_progress), the engine must NOT escalate it further.
    const wayLater = new Date(breachSeen.getTime() + 120 * 60_000);
    const before = tiersOf(await readTask(taskId));
    await runEscalationSweep({ now: wayLater });
    const after = tiersOf(await readTask(taskId));
    expect(after).toEqual(before); // no new tier fired after acknowledge
  });

  it('resolve closes the task (→ completed)', async () => {
    const done = await taskService.transitionTask({
      tenantId: TENANT,
      id: taskId,
      nextStatus: 'completed',
    });
    expect(done.status).toBe('completed');
    expect(done.completed_at).toBeTruthy();

    // A completed task is no longer in the inbox.
    const inbox = await taskService.listInboxTasks({
      tenantId: TENANT,
      assigneeUid: DOCTOR_UID,
      roles: ['DOCTOR'],
      primaryRole: 'DOCTOR',
      rawRole: 'DOCTOR',
    });
    expect(inbox.tasks.map((t) => t.id)).not.toContain(taskId);
  });

  it('plain enqueue never creates a fresh task behind the completed SLA', async () => {
    const again = await enqueueCriticalResultTask({
      tenantId: TENANT,
      patientUid: PATIENT_UID,
      source: 'lab_result',
      resourceType: RESOURCE_TYPE,
      resourceId: RESOURCE_ID,
      severity: 'critical',
      orderingClinicianUid: DOCTOR_UID,
    });

    expect(again).toMatchObject({
      created: false,
      skipped: true,
      reason: 'task_already_acknowledged',
      slaInstanceId,
    });
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = $2
          AND related_resource_id = $3`,
      TENANT,
      RESOURCE_TYPE,
      RESOURCE_ID,
    );
    expect(rows[0].count).toBe(1);
  });

  it('refuses to reopen a synthetic lab closure without an immutable alert receipt', async () => {
    const beforeTasks = await prisma.$queryRawUnsafe(
      `SELECT id, status, completed_at, due_at, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = $2
          AND related_resource_id = $3
        ORDER BY id`,
      TENANT,
      RESOURCE_TYPE,
      RESOURCE_ID,
    );
    const beforeSlas = await prisma.$queryRawUnsafe(
      `SELECT id, status, completed_at, started_at, due_at, metadata
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid`,
      TENANT,
      slaInstanceId,
    );
    const beforeComments = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM task_comments
        WHERE tenant_id = $1::uuid
          AND task_id = $2::int`,
      TENANT,
      taskId,
    );

    await expect(ensureCriticalResultTaskOpen({
      tenantId: TENANT,
      patientUid: PATIENT_UID,
      source: 'lab_result',
      resourceType: RESOURCE_TYPE,
      resourceId: RESOURCE_ID,
      severity: 'critical',
      orderingClinicianUid: DOCTOR_UID,
      reason: 'deep_explicit_reopen',
      supersededByActorUid: DOCTOR_UID,
      strict: true,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAB_CRITICAL_ALERT_ACK_RECONCILIATION_REQUIRED',
    });

    const afterTasks = await prisma.$queryRawUnsafe(
      `SELECT id, status, completed_at, due_at, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = $2
          AND related_resource_id = $3
        ORDER BY id`,
      TENANT,
      RESOURCE_TYPE,
      RESOURCE_ID,
    );
    const afterSlas = await prisma.$queryRawUnsafe(
      `SELECT id, status, completed_at, started_at, due_at, metadata
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid`,
      TENANT,
      slaInstanceId,
    );
    const afterComments = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count
         FROM task_comments
        WHERE tenant_id = $1::uuid
          AND task_id = $2::int`,
      TENANT,
      taskId,
    );
    expect(afterTasks).toEqual(beforeTasks);
    expect(afterSlas).toEqual(beforeSlas);
    expect(afterComments).toEqual(beforeComments);
  });
});

// Keep eslint happy about the imported jest namespace in this ESM test.
void jest;
