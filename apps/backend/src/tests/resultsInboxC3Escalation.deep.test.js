// Critical-result escalation / SLA — audit §C-3 deep regression (real services + QA DB).
//
// resultsInbox.deep.test.js already proves the happy-path pipeline (producer →
// inbox → tiers fire once → ack halts → resolve closes). This file proves the
// FOUR specific C-3 fixes that test does NOT cover — i.e. that the escalation
// actually REACHES A HUMAN and the ack actually STOPS THE CLOCK:
//
//   FIX 1 — escalation tiers resolve to a REAL recipient, never a null no-op.
//     * __testing__.resolveRecipientsForRole('DUTY_DOCTOR'/'CMO') returns the
//       seeded on-duty / leadership users (exact-role + family fallback).
//     * After the T2 (DUTY) and T3 (LEADERSHIP) sweeps fire, notification_outbox
//       has rows with a NON-NULL recipient_id pointing at those users — proof the
//       drained outbox would deliver to a person, not enqueue a null-recipient
//       no-op.
//
//   FIX 2 — ack STOPS the SLA clock + backfill does NOT re-create the task.
//     * acknowledgeTask completes the linked workflow_sla_instances row (status
//       leaves 'active'/'breached' → terminal + completed_at + completed_via).
//     * a subsequent runEscalationSweep backfill (the breached-instance-with-no-
//       open-task backstop) does NOT spawn a fresh task for the already-handled
//       resource (terminal-task exclusion).
//     * the terminal/complete path (transitionTask→completed) ALSO stops the clock.
//
//   FIX 3 — the lab producer's SLA key is the one the ack flow closes.
//     * enqueueCriticalResultTask(resourceType:'lab_result') starts the SLA
//       keyed ('lab_result', id); emitCriticalLabAlertAcknowledged({result_id:id})
//       drives that SAME key terminal (and completes the open task).
//
//   FIX 4 — an investigation critical result creates an ack-task from minute 0.
//     * investigationService.addResults() with a PANIC-flagged result creates an
//       assigned task + a critical_result_ack SLA instance keyed
//       ('investigations', id), via the real critical path.
//
// SELF-ISOLATING: each `it` owns a DISTINCT resource id and asserts a complete
// story end-to-end — no cross-`it` shared state, so `-t` filtering and any run
// order behave identically. Injected `now` advances the engine past the 15-min
// SLA + 0/10/30-min tier windows without real waits (resultsInbox.deep.test.js
// pattern). All fixtures are unique-per-run and removed in afterAll; users.phone
// is globally unique so every seeded phone embeds the run suffix.

import { jest } from '@jest/globals';

const prisma = (await import('../lib/prisma.js')).default;
const { setTenantTx } = await import('../lib/prisma.js');
const { DEFAULT_TENANT_ID } = await import('../services/tenant/tenantService.js');
const { enqueueCriticalResultTask } = await import('../services/results/resultsInboxService.js');
const { runEscalationSweep, __testing__ } = await import('../services/workflow/escalationEngineService.js');
const taskService = await import('../services/workflow/taskService.js');
const investigationService = await import('../services/investigation/investigationService.js');
const { emitCriticalLabAlertAcknowledged } = await import('../services/clinical/canonicalOperationalBridgeService.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// Unique per run so the open-task idempotency index + globally-unique users.phone
// never collide with leftovers from a previous run.
const SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const pad12 = (s) => s.padStart(12, '0');
const PATIENT_UID = `c3a00000-0000-4000-8000-${pad12(SUFFIX)}`;
const DOCTOR_UID = `c3b00000-0000-4000-8000-${pad12(SUFFIX)}`;
const DUTY_UID = `c3c00000-0000-4000-8000-${pad12(SUFFIX)}`;
const CMO_UID = `c3d00000-0000-4000-8000-${pad12(SUFFIX)}`;
const PATIENT_PHONE = `+9197001${SUFFIX}`;
const DOCTOR_PHONE = `+9197002${SUFFIX}`;
const DUTY_PHONE = `+9197003${SUFFIX}`;
const CMO_PHONE = `+9197004${SUFFIX}`;

// A distinct resource id per `it` so no test aliases another's task / SLA.
const R = {
  recip: `93${SUFFIX}`, // FIX 1 — tier recipients
  ack: `95${SUFFIX}`, // FIX 2 — ack stops clock + backfill no re-create
  term: `96${SUFFIX}`, // FIX 2 — terminal/complete path stops clock
  lab: `94${SUFFIX}`, // FIX 3 — lab key unification
};
const LAB_ALERT_ID = Number(`81${SUFFIX}`); // synthetic lab_critical_alerts id (no row needed)
const ALL_RESOURCE_IDS = Object.values(R);

// ---- helpers (mirrors resultsInbox.deep.test.js) ---------------------------

async function readTaskById(taskId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, priority, assigned_to_uid, metadata
       FROM tasks WHERE id = $1::int AND tenant_id = $2::uuid LIMIT 1`,
    taskId, DEFAULT_TENANT_ID,
  );
  return rows[0] || null;
}

async function readSlaInstance(instanceId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, completed_at, due_at, breached_at, metadata
       FROM workflow_sla_instances WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    instanceId, DEFAULT_TENANT_ID,
  );
  return rows[0] || null;
}

async function readSlaByKey(sourceTable, sourceId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, completed_at, due_at
       FROM workflow_sla_instances
      WHERE tenant_id = $1::uuid AND rule_code = 'critical_result_ack'
        AND source_table = $2 AND source_id = $3
      LIMIT 1`,
    DEFAULT_TENANT_ID, sourceTable, sourceId,
  );
  return rows[0] || null;
}

async function countOpenTasksForResource(resourceType, resourceId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM tasks
      WHERE tenant_id = $1::uuid AND related_resource_type = $2 AND related_resource_id = $3
        AND status IN ('open', 'in_progress', 'overdue', 'blocked')`,
    DEFAULT_TENANT_ID, resourceType, resourceId,
  );
  return rows[0].n;
}

// Force the linked SLA instance to look breached AS OF a chosen moment, and
// return the breach moment AS THE ENGINE SEES IT (timestamptz→JS round-trip in
// the server TZ — the documented gotcha, see resultsInbox.deep.test.js).
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

// Re-breach an instance and clear completed_at, to bait the backfill backstop
// (an instance can be simultaneously past-due and previously completed).
async function rebreachInstance(slaInstanceId) {
  await prisma.$executeRawUnsafe(
    `UPDATE workflow_sla_instances
        SET status = 'breached', breached_at = NOW() - INTERVAL '40 minutes',
            due_at = NOW() - INTERVAL '40 minutes', completed_at = NULL, updated_at = NOW()
      WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    slaInstanceId, DEFAULT_TENANT_ID,
  );
}

// Read outbox rows the escalation enqueued for a given task id (the engine puts
// task_id into payload.data.task_id, persisted as payload->'task_id').
async function readEscalationOutboxForTask(taskId) {
  return prisma.$queryRawUnsafe(
    `SELECT id, recipient_id, recipient_phone, payload
       FROM notification_outbox
      WHERE (payload->>'task_id') = $1::text
        AND (payload->>'kind') = 'results_inbox_escalation'
      ORDER BY id ASC`,
    String(taskId),
  );
}

// Seed the producer task+SLA for a resource, breach the SLA at a fixed instant,
// and return { taskId, slaInstanceId, breachSeen }.
async function seedBreachedCriticalTask(resourceId, { breachIso = '2026-06-15T00:00:00.000Z' } = {}) {
  const res = await enqueueCriticalResultTask({
    tenantId: DEFAULT_TENANT_ID,
    patientUid: PATIENT_UID,
    source: 'lab_result',
    resourceType: 'lab_result',
    resourceId,
    severity: 'critical',
    title: 'Critical lab: Potassium',
    summary: 'Potassium critically high.',
    orderingClinicianUid: DOCTOR_UID,
  });
  if (!res.created) throw new Error(`fixture producer did not create a task for ${resourceId}`);
  const task = await readTaskById(res.taskId);
  const slaInstanceId = task.metadata.sla_instance_id;
  const breachSeen = await setSlaBreachedAt(slaInstanceId, breachIso);
  return { taskId: res.taskId, slaInstanceId, breachSeen };
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM notification_outbox
      WHERE (payload->>'kind') = 'results_inbox_escalation'
        AND (payload->>'patient_uid') = $1::text`,
    PATIENT_UID,
  ).catch(() => {});
  for (const id of ALL_RESOURCE_IDS) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM task_comments WHERE task_id IN (
         SELECT id FROM tasks WHERE tenant_id = $1::uuid
           AND related_resource_type = 'lab_result' AND related_resource_id = $2)`,
      DEFAULT_TENANT_ID, id,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM tasks WHERE tenant_id = $1::uuid
         AND related_resource_type = 'lab_result' AND related_resource_id = $2`,
      DEFAULT_TENANT_ID, id,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid
         AND rule_code = 'critical_result_ack' AND source_table = 'lab_result' AND source_id = $2`,
      DEFAULT_TENANT_ID, id,
    ).catch(() => {});
  }
  // Investigation fixture (resource id only known at run time → clean by patient).
  await prisma.$executeRawUnsafe(
    `DELETE FROM tasks WHERE tenant_id = $1::uuid
       AND related_resource_type = 'investigations'
       AND related_resource_id IN (
         SELECT id::text FROM investigations WHERE patient_uid = $2::uuid)`,
    DEFAULT_TENANT_ID, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid
       AND rule_code = 'critical_result_ack' AND source_table = 'investigations'
       AND source_id IN (SELECT id::text FROM investigations WHERE patient_uid = $2::uuid)`,
    DEFAULT_TENANT_ID, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM investigations WHERE patient_uid = $1::uuid`, PATIENT_UID,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
    PATIENT_UID, DOCTOR_UID, DUTY_UID, CMO_UID,
  ).catch(() => {});
}

d('Critical-result escalation/SLA — audit C-3 (deep, real services + DB)', () => {
  let patientIntId = null;

  beforeAll(async () => {
    await cleanup();
    // Patient + ordering doctor + an on-duty DUTY_DOCTOR (T2 target) + a CMO
    // (T3 target). DUTY_DOCTOR / CMO are the concrete roles resolveRoleCode maps
    // the seeded DUTY / LEADERSHIP tier tokens to.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'C3 Patient [test]', 'PATIENT', true, $3::uuid, NOW()),
              ($4::uuid, $5, 'C3 Doctor [test]', 'DOCTOR', true, $3::uuid, NOW()),
              ($6::uuid, $7, 'C3 Duty Doc [test]', 'DUTY_DOCTOR', true, $3::uuid, NOW()),
              ($8::uuid, $9, 'C3 CMO [test]', 'CMO', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, DEFAULT_TENANT_ID,
      DOCTOR_UID, DOCTOR_PHONE,
      DUTY_UID, DUTY_PHONE,
      CMO_UID, CMO_PHONE,
    );
    const prow = await prisma.$queryRawUnsafe(
      `SELECT id FROM users WHERE uid = $1::uuid LIMIT 1`, PATIENT_UID,
    );
    patientIntId = prow[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  // ----- FIX 1: tiers resolve to a real recipient ---------------------------

  it('FIX 1a — resolveRecipientsForRole resolves DUTY_DOCTOR (T2) + CMO (T3) to seeded active users (never empty)', async () => {
    // The engine resolves inside setTenantTx; resolve on a tenant tx here so the
    // same RLS-scoped SELECT runs.
    const { dutyRows, cmoRows, bogusRows } = await setTenantTx(DEFAULT_TENANT_ID, async (tx) => ({
      dutyRows: await __testing__.resolveRecipientsForRole(tx, DEFAULT_TENANT_ID, 'DUTY_DOCTOR'),
      cmoRows: await __testing__.resolveRecipientsForRole(tx, DEFAULT_TENANT_ID, 'CMO'),
      bogusRows: await __testing__.resolveRecipientsForRole(tx, DEFAULT_TENANT_ID, ''),
    }));

    expect(dutyRows.map((r) => r.uid)).toContain(DUTY_UID);
    expect(dutyRows.every((r) => Number.isInteger(r.id) && r.id > 0)).toBe(true);

    expect(cmoRows.map((r) => r.uid)).toContain(CMO_UID);
    expect(cmoRows.every((r) => Number.isInteger(r.id) && r.id > 0)).toBe(true);

    // Empty role → [] (guarded), proving the resolver is null-safe, not throwing.
    expect(bogusRows).toEqual([]);
  });

  it('FIX 1b — T2 (DUTY) + T3 (LEADERSHIP) sweeps enqueue outbox rows with NON-NULL recipient_id (reach a human)', async () => {
    const { taskId, breachSeen } = await seedBreachedCriticalTask(R.recip);

    // Drive sweeps through T1 (0m) / T2 (10m) / T3 (30m); pad +1 min past each.
    await runEscalationSweep({ now: new Date(breachSeen.getTime() + 1 * 60_000) });
    await runEscalationSweep({ now: new Date(breachSeen.getTime() + 11 * 60_000) });
    await runEscalationSweep({ now: new Date(breachSeen.getTime() + 31 * 60_000) });

    const task = await readTaskById(taskId);
    const tiers = (task.metadata.escalations || []).map((e) => e.tier).sort();
    expect(tiers).toEqual(expect.arrayContaining([1, 2, 3]));

    const outbox = await readEscalationOutboxForTask(taskId);
    // T2 → DUTY_DOCTOR, T3 → CMO. Each must produce a row to a REAL recipient id.
    const dutyRow = outbox.find((o) => o.payload?.notify_role === 'DUTY_DOCTOR');
    const cmoRow = outbox.find((o) => o.payload?.notify_role === 'CMO');
    expect(dutyRow).toBeTruthy();
    expect(Number(dutyRow.recipient_id)).toBeGreaterThan(0);
    expect(cmoRow).toBeTruthy();
    expect(Number(cmoRow.recipient_id)).toBeGreaterThan(0);
    // No escalation outbox row for this task may have a null recipient — the core
    // of the C-3 fix: no null-recipient no-op tier.
    expect(outbox.length).toBeGreaterThanOrEqual(2);
    expect(outbox.every((o) => o.recipient_id != null)).toBe(true);
  });

  // ----- FIX 2: ack stops the clock + backfill does not re-create -----------

  it('FIX 2a — acknowledge completes the linked SLA instance, then backfill does NOT re-create the task', async () => {
    const { taskId, slaInstanceId } = await seedBreachedCriticalTask(R.ack);

    const before = await readSlaInstance(slaInstanceId);
    expect(['active', 'breached']).toContain(before.status);
    expect(before.completed_at).toBeNull();

    // The task is assigned to the ordering clinician (DOCTOR_UID); acknowledge as
    // that assignee (post-authorization, a non-assignee non-role caller is 403).
    const acked = await taskService.acknowledgeTask({
      tenantId: DEFAULT_TENANT_ID, id: taskId, actorUid: DOCTOR_UID,
    });
    expect(acked.status).toBe('in_progress');

    // The clock stopped: terminal status + completed_at + our completion marker.
    const afterAck = await readSlaInstance(slaInstanceId);
    expect(['completed', 'breached']).toContain(afterAck.status);
    expect(afterAck.completed_at).not.toBeNull();
    expect(afterAck.metadata?.completed_via).toBe('task_ack');

    // Bait the backfill with a re-breached instance: the acked (in_progress) task
    // is non-terminal-OPEN, so the producer's ON CONFLICT de-dupe holds — no fresh
    // task. (One acked task stays.)
    await rebreachInstance(slaInstanceId);
    const openBefore = await countOpenTasksForResource('lab_result', R.ack);
    await runEscalationSweep({ now: new Date(Date.now() + 60 * 60_000) });
    expect(await countOpenTasksForResource('lab_result', R.ack)).toBe(openBefore);

    // Now drive the task TERMINAL and re-bait: the engine's terminal-task
    // exclusion (status IN completed/cancelled) must stop the backfill re-alerting
    // on an already-handled result.
    await taskService.transitionTask({
      tenantId: DEFAULT_TENANT_ID, id: taskId, nextStatus: 'completed',
    });
    await rebreachInstance(slaInstanceId);
    await runEscalationSweep({ now: new Date(Date.now() + 90 * 60_000) });
    expect(await countOpenTasksForResource('lab_result', R.ack)).toBe(0);
  });

  it('FIX 2b — completing a task (terminal path) also stops the SLA clock', async () => {
    const { taskId, slaInstanceId } = await seedBreachedCriticalTask(R.term);

    const before = await readSlaInstance(slaInstanceId);
    expect(before.completed_at).toBeNull();

    // Resolve the result directly (not via ack) — the terminal transition must
    // close the linked instance too (completeLinkedSla on transitionTask).
    const done = await taskService.transitionTask({
      tenantId: DEFAULT_TENANT_ID, id: taskId, nextStatus: 'completed',
    });
    expect(done.status).toBe('completed');

    const after = await readSlaInstance(slaInstanceId);
    expect(['completed', 'breached']).toContain(after.status);
    expect(after.completed_at).not.toBeNull();
    expect(after.metadata?.completed_via).toBe('task_ack'); // marker is shared
  });

  // ----- FIX 3: lab producer SLA key == ack-flow key ------------------------

  it('FIX 3 — lab producer SLA key ("lab_result", id) is the one emitCriticalLabAlertAcknowledged closes', async () => {
    const res = await enqueueCriticalResultTask({
      tenantId: DEFAULT_TENANT_ID,
      patientUid: PATIENT_UID,
      source: 'lab_result',
      resourceType: 'lab_result',
      resourceId: R.lab,
      severity: 'critical',
      title: 'Critical lab: Troponin',
      summary: 'Troponin critically high.',
      orderingClinicianUid: DOCTOR_UID,
    });
    expect(res.created).toBe(true);

    const slaBefore = await readSlaByKey('lab_result', R.lab);
    expect(slaBefore).toBeTruthy();
    expect(slaBefore.status).toBe('active');

    // The ack path resolves the result→investigation join best-effort; with no
    // lab_results row it finds nothing and STILL completes the ('lab_result',
    // result_id) SLA the producer started. result_id == the producer's resourceId
    // is the load-bearing unification (pre-fix the ack only closed
    // 'investigations'/'lab_critical_alerts').
    await emitCriticalLabAlertAcknowledged({
      alert: {
        id: LAB_ALERT_ID,
        result_id: R.lab,
        tenant_id: DEFAULT_TENANT_ID,
        patient_uid: PATIENT_UID,
        test_name: 'Troponin',
      },
      actorUid: DOCTOR_UID,
      actorRole: 'DOCTOR',
    });

    const slaAfter = await readSlaByKey('lab_result', R.lab);
    expect(['completed', 'breached']).toContain(slaAfter.status);
    expect(slaAfter.completed_at).not.toBeNull();

    // The open results-inbox task for the lab_result resource is also closed.
    const task = await readTaskById(res.taskId);
    expect(task.status).toBe('completed');
    expect(task.metadata?.completed_via).toBe('critical_result_ack');
  });

  // ----- FIX 4: investigation critical → ack-task from minute 0 -------------

  it('FIX 4 — investigation critical result creates an assigned ack-task + ("investigations", id) SLA immediately', async () => {
    // Seed an investigation row with NO results yet (first submit) for our
    // patient, ordered by the doctor.
    const invRow = await prisma.$queryRawUnsafe(
      `INSERT INTO investigations
         (phone, patient_id, patient_uid, test_name, test_type, status, requested_by, requested_at, updated_at)
       VALUES ($1, $2::int, $3::uuid, 'Serum Potassium', 'LAB', 'COLLECTED', $4::uuid, NOW(), NOW())
       RETURNING id`,
      PATIENT_PHONE, patientIntId, PATIENT_UID, DOCTOR_UID,
    );
    const investigationId = invRow[0].id;

    const updated = await investigationService.addResults(
      investigationId,
      {
        results: {
          analytes: [
            { name: 'Potassium', value: '7.6', unit: 'mmol/L', normal_range: '3.5-5.1', flag: 'PANIC' },
          ],
        },
      },
      DOCTOR_UID,
      DEFAULT_TENANT_ID,
    );
    expect(updated).toBeTruthy();
    expect(updated.id).toBe(investigationId);

    // The critical path is post-commit best-effort inside the same call; by the
    // time addResults resolves, the producer has run. The SLA instance + the
    // assigned task both exist for ('investigations', id).
    const sla = await readSlaByKey('investigations', String(investigationId));
    expect(sla).toBeTruthy();
    expect(sla.status).toBe('active');

    const taskRows = await prisma.$queryRawUnsafe(
      `SELECT id, status, assigned_to_uid, priority, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid AND related_resource_type = 'investigations'
          AND related_resource_id = $2 LIMIT 1`,
      DEFAULT_TENANT_ID, String(investigationId),
    );
    expect(taskRows.length).toBe(1);
    const task = taskRows[0];
    expect(task.status).toBe('open');
    expect(task.priority).toBe('critical');
    // Ack-tracked + assigned to the ordering clinician + linked to the SLA.
    expect(task.assigned_to_uid).toBe(DOCTOR_UID);
    expect(task.metadata.sla_instance_id).toBe(sla.id);
    expect(task.metadata.source).toBe('investigation');
  });
});

// Keep eslint happy about the imported jest namespace in this ESM test.
void jest;
