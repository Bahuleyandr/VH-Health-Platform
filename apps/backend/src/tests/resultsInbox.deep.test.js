// Results-inbox safety net — END-TO-END deep test (real producer + engine + DB).
//
// Design docs/RESULTS_INBOX_ESCALATION_DESIGN.md §4 + §9. Proves the full
// pipeline against the REAL services + the QA DB under the default tenant:
//
//   1. enqueueCriticalResultTask (the producer) turns a critical lab result into
//      an assigned, ack-tracked `tasks` row linked to a mig-269
//      critical_result_ack SLA instance (metadata.sla_instance_id).
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

import { jest } from '@jest/globals';

const prisma = (await import('../lib/prisma.js')).default;
const { setTenantTx } = await import('../lib/prisma.js');
const { DEFAULT_TENANT_ID } = await import('../services/tenant/tenantService.js');
const { enqueueCriticalResultTask } = await import('../services/results/resultsInboxService.js');
const { runEscalationSweep } = await import('../services/workflow/escalationEngineService.js');
const taskService = await import('../services/workflow/taskService.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const PATIENT_UID = `c1100000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
// The ordering clinician — becomes the task assignee (assigned_to_uid).
const DOCTOR_UID = `c1200000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const PATIENT_PHONE = `+9198001${SUFFIX}`;
const DOCTOR_PHONE = `+9198002${SUFFIX}`;
// A unique resource id per run so the open-task idempotency index never collides
// with a previous run's leftover row.
const RESOURCE_ID = `9${SUFFIX}`;
const RESOURCE_TYPE = 'lab_result';

// Helpers to read a task's escalation tiers + SLA instance directly.
async function readTask(taskId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, priority, assigned_to_uid, metadata
       FROM tasks WHERE id = $1::int AND tenant_id = $2::uuid LIMIT 1`,
    taskId, DEFAULT_TENANT_ID,
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
async function setSlaBreachedAt(slaInstanceId, whenIso) {
  await prisma.$executeRawUnsafe(
    `UPDATE workflow_sla_instances
        SET status = 'breached', breached_at = $2::timestamptz, due_at = $2::timestamptz, updated_at = NOW()
      WHERE id = $1::uuid AND tenant_id = $3::uuid`,
    slaInstanceId, whenIso, DEFAULT_TENANT_ID,
  );
  const rows = await prisma.$queryRawUnsafe(
    `SELECT breached_at FROM workflow_sla_instances WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    slaInstanceId, DEFAULT_TENANT_ID,
  );
  return new Date(rows[0].breached_at);
}

async function cleanup() {
  // Remove the task(s) for this resource + any SLA instance + the test users.
  await prisma.$executeRawUnsafe(
    `DELETE FROM task_comments WHERE task_id IN (
       SELECT id FROM tasks WHERE tenant_id = $1::uuid
         AND related_resource_type = $2 AND related_resource_id = $3)`,
    DEFAULT_TENANT_ID, RESOURCE_TYPE, RESOURCE_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM tasks WHERE tenant_id = $1::uuid
       AND related_resource_type = $2 AND related_resource_id = $3`,
    DEFAULT_TENANT_ID, RESOURCE_TYPE, RESOURCE_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid
       AND rule_code = 'critical_result_ack' AND source_table = $2 AND source_id = $3`,
    DEFAULT_TENANT_ID, RESOURCE_TYPE, RESOURCE_ID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid)`, PATIENT_UID, DOCTOR_UID,
  ).catch(() => {});
}

d('Results-inbox pipeline (deep, real producer + engine + DB)', () => {
  let taskId = null;
  let slaInstanceId = null;
  // The breach moment the test pins the SLA instance to. The ENGINE-VISIBLE
  // breach Date (after timestamptz→JS round-trip, see setSlaBreachedAt) is
  // captured at breach time and the tier windows are measured forward from it,
  // so the comparison against the injected `now` is consistent regardless of the
  // server-TZ deserialization quirk.
  const breachLiteral = '2026-06-15T00:00:00.000Z';
  let breachSeen = null; // set in the tier-1 test once the instance is breached
  let afterT1 = null;
  let afterT2 = null;
  let afterT3 = null;

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'RI Patient [test]', 'PATIENT', true, $3::uuid, NOW()),
              ($4::uuid, $5, 'RI Doctor [test]', 'DOCTOR', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, DEFAULT_TENANT_ID, DOCTOR_UID, DOCTOR_PHONE,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  it('producer creates an assigned, SLA-linked critical-result task', async () => {
    const res = await enqueueCriticalResultTask({
      tenantId: DEFAULT_TENANT_ID,
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

    const task = await readTask(taskId);
    expect(task.status).toBe('open');
    expect(task.priority).toBe('critical');
    expect(task.assigned_to_uid).toBe(DOCTOR_UID);
    expect(task.metadata.source).toBe('lab_result');
    // The mig-269 critical_result_ack SLA instance is linked as the clock.
    expect(task.metadata.sla_instance_id).toBeTruthy();
    slaInstanceId = task.metadata.sla_instance_id;
    expect(task.metadata.sla_key).toBe('critical_result_ack');
  });

  it('is idempotent: a second producer call for the same resource creates no new task', async () => {
    const again = await enqueueCriticalResultTask({
      tenantId: DEFAULT_TENANT_ID,
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
      DEFAULT_TENANT_ID, RESOURCE_TYPE, RESOURCE_ID,
    );
    expect(rows[0].n).toBe(1);
  });

  it('appears in the ordering clinician inbox (me)', async () => {
    const inbox = await taskService.listInboxTasks({
      tenantId: DEFAULT_TENANT_ID,
      assigneeUid: DOCTOR_UID,
      roles: ['DOCTOR'],
    });
    const ids = inbox.tasks.map((t) => t.id);
    expect(ids).toContain(taskId);
    const mine = inbox.tasks.find((t) => t.id === taskId);
    expect(mine.status).toBe('open');
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
      tenantId: DEFAULT_TENANT_ID,
      id: taskId,
      actorUid: DOCTOR_UID,
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
      tenantId: DEFAULT_TENANT_ID,
      id: taskId,
      nextStatus: 'completed',
    });
    expect(done.status).toBe('completed');
    expect(done.completed_at).toBeTruthy();

    // A completed task is no longer in the inbox.
    const inbox = await taskService.listInboxTasks({
      tenantId: DEFAULT_TENANT_ID,
      assigneeUid: DOCTOR_UID,
      roles: ['DOCTOR'],
    });
    expect(inbox.tasks.map((t) => t.id)).not.toContain(taskId);
  });
});

// Keep eslint happy about the imported jest namespace in this ESM test.
void jest;
