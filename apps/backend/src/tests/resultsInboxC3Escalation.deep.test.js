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
//       keyed ('lab_result', id); the authorized task acknowledgement drives
//       that SAME linked instance terminal while the task stays in_progress.
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
//
// ---------------------------------------------------------------------------
// TENANT OWNERSHIP (post-#675/#678 pattern — see cath-scheduling-registry and
// nabh-indicators). This suite used to run on the DEFAULT tenant, where FIX 1a
// in particular was hostage to state the comprehensive seeder and every
// cohabiting suite can write:
//
//   * escalationEngineService.resolveRecipientsForRole reads
//     `... WHERE tenant_id = $1 AND role = $2 AND is_active ORDER BY id LIMIT 50`.
//     Fifty active DUTY_DOCTOR (or, via the family fallback, DOCTOR_TIERS) users
//     in the default tenant with lower ids than this suite's push its own seeded
//     recipient off the end of the page and `toContain(DUTY_UID)` fails. The QA
//     database already carries 55 active DOCTOR rows, so the fallback arm of that
//     query is over the limit today.
//   * FIX 4's investigations INSERT omitted tenant_id entirely. Raw inserts run
//     with app.current_tenant_id unset, so the column DEFAULT put the row on the
//     default tenant — invisible while everything else was there too, and a
//     silent mis-scope the moment anything moved.
//   * runEscalationSweep is global over every tenant holding active task-scope
//     escalation rules, so these tiers were coupled to the sibling suite
//     resultsInbox.deep, which pinned its SLA to the SAME 2026-06-15 breach
//     literal — the structural near-miss the 2026-08-01 fixed-date sweep flagged
//     (PR #676).
//
// The suite now creates TENANT (+ TENANT_DECOY) in beforeAll and drops both in
// afterAll; nothing is read or written outside them. The mig-312 tier rules are
// CLONED from the default tenant rather than restated, so the fixture cannot
// drift from the migration, and the clone is asserted to be the 0/10/30 triple.
//
// TENANT_DECOY carries its own DUTY_DOCTOR + CMO and its own identically-breached
// task, so the isolation guarantee stays honest: the exact recipient arrays in
// FIX 1a would grow, and the FIX 2a counts would move, were tenant scoping to
// regress. Each guard is paired with a pre-assertion that the decoy row really is
// in play, so none of them can go silently vacuous.
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
const { enqueueCriticalResultTask } = await import('../services/results/resultsInboxService.js');
const { runEscalationSweep, __testing__ } = await import('../services/workflow/escalationEngineService.js');
const taskService = await import('../services/workflow/taskService.js');
const investigationService = await import('../services/investigation/investigationService.js');

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// This suite's own tenant + its decoy. Distinct from resultsInbox.deep's pair so
// the two suites share no tenant, no resource id, and no breach instant.
const TENANT = 'd5200000-0000-4000-8000-00000000c3c3';
const TENANT_DECOY = 'd5200000-0000-4000-8000-00000000dec3';

// tenants(id) is referenced by ~685 foreign keys, so every tenant DELETE pays a
// check per constraint (~2s each here). Both hooks below therefore carry an
// explicit timeout: jest's 5s default is not enough, and a standalone run must
// not silently depend on the CI runner's --testTimeout=60000.
const HOOK_TIMEOUT_MS = 120000;

// The SLA breach clock origin. This is a WINDOW BOUNDARY, not a stable fixture
// attribute — the engine measures every trigger_window_minutes forward from it —
// so it is anchored relative to run time rather than to a calendar literal. The
// old fixed '2026-06-15T00:00:00.000Z' was shared verbatim with
// resultsInbox.deep, which aliased the two suites' tier windows under the global
// sweep. The 75-day offset is deliberately different from that suite's 45.
const BREACH_ISO = new Date(Date.now() - 75 * 24 * 60 * 60_000).toISOString();

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
// Decoy-tenant mirrors (users.uid and users.phone are globally unique).
const DECOY_PATIENT_UID = `c3e00000-0000-4000-8000-${pad12(SUFFIX)}`;
const DECOY_DOCTOR_UID = `c3f00000-0000-4000-8000-${pad12(SUFFIX)}`;
const DECOY_DUTY_UID = `c3a10000-0000-4000-8000-${pad12(SUFFIX)}`;
const DECOY_CMO_UID = `c3b10000-0000-4000-8000-${pad12(SUFFIX)}`;
const DECOY_PATIENT_PHONE = `+9197005${SUFFIX}`;
const DECOY_DOCTOR_PHONE = `+9197006${SUFFIX}`;
const DECOY_DUTY_PHONE = `+9197007${SUFFIX}`;
const DECOY_CMO_PHONE = `+9197008${SUFFIX}`;

// A distinct resource id per `it` so no test aliases another's task / SLA.
const R = {
  recip: `93${SUFFIX}`, // FIX 1 — tier recipients
  ack: `95${SUFFIX}`, // FIX 2 — ack stops clock + backfill no re-create
  term: `96${SUFFIX}`, // FIX 2 — terminal/complete path stops clock
  lab: `94${SUFFIX}`, // FIX 3 — lab key unification
};

// ---- helpers (mirrors resultsInbox.deep.test.js) ---------------------------

async function readTaskById(taskId, tenantId = TENANT) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, priority, assigned_to_uid,
            workflow_sla_instance_id, sla_completion_semantics, metadata
       FROM tasks WHERE id = $1::int AND tenant_id = $2::uuid LIMIT 1`,
    taskId, tenantId,
  );
  return rows[0] || null;
}

async function readSlaInstance(instanceId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, completed_at, due_at, breached_at, metadata
       FROM workflow_sla_instances WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    instanceId, TENANT,
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
    TENANT, sourceTable, sourceId,
  );
  return rows[0] || null;
}

async function countOpenTasksForResource(resourceType, resourceId, tenantId = TENANT) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM tasks
      WHERE tenant_id = $1::uuid AND related_resource_type = $2 AND related_resource_id = $3
        AND status IN ('open', 'in_progress', 'overdue', 'blocked')`,
    tenantId, resourceType, resourceId,
  );
  return rows[0].n;
}

// Force the linked SLA instance to look breached AS OF a chosen moment, and
// return the breach moment AS THE ENGINE SEES IT (timestamptz→JS round-trip in
// the server TZ — the documented gotcha, see resultsInbox.deep.test.js).
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

// Read outbox rows the escalation enqueued for a given task id (the engine puts
// task_id into payload.data.task_id, persisted as payload->'task_id').
//
// Deliberately NOT filtered by tenant: notificationOutbox.queue() runs on the
// prisma singleton rather than inside the engine's tenant transaction, so these
// rows carry the DEFAULT tenant no matter which tenant owns the task. tasks.id
// is a global SERIAL, so the task_id predicate is already exact.
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
async function seedBreachedCriticalTask(resourceId, {
  breachIso = BREACH_ISO,
  tenantId = TENANT,
  patientUid = PATIENT_UID,
  clinicianUid = DOCTOR_UID,
} = {}) {
  const res = await enqueueCriticalResultTask({
    tenantId,
    patientUid,
    source: 'lab_result',
    resourceType: 'lab_result',
    resourceId,
    severity: 'critical',
    title: 'Critical lab: Potassium',
    summary: 'Potassium critically high.',
    orderingClinicianUid: clinicianUid,
  });
  if (!res.created) throw new Error(`fixture producer did not create a task for ${resourceId}`);
  const task = await readTaskById(res.taskId, tenantId);
  const slaInstanceId = task.workflow_sla_instance_id;
  const breachSeen = await setSlaBreachedAt(slaInstanceId, breachIso, tenantId);
  return { taskId: res.taskId, slaInstanceId, breachSeen };
}

async function cleanup() {
  // Escalation notifications are queued on the outbox singleton (outside the
  // tenant transaction), so those rows carry the DEFAULT tenant regardless of the
  // task's tenant — clean them by this run's unique patient uids, not by tenant.
  await prisma.$executeRawUnsafe(
    `DELETE FROM notification_outbox
      WHERE (payload->>'kind') = 'results_inbox_escalation'
        AND (payload->>'patient_uid') IN ($1::text, $2::text)`,
    PATIENT_UID, DECOY_PATIENT_UID,
  ).catch(() => {});

  for (const tenantId of [TENANT, TENANT_DECOY]) {
    await setTenantTx(tenantId, async (tx) => {
      // Replica mode disables the append-only / receipt-protection triggers on
      // clinical_timeline_events + clinical_audit_events for this transaction
      // only. Confined to the disposable test database and to tenants this suite
      // created; no production cleanup path gets a bypass.
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      // Children before parents, every statement scoped to this suite's tenant.
      await tx.$executeRawUnsafe(
        `DELETE FROM task_comments WHERE tenant_id = $1::uuid`, tenantId,
      );
      await tx.$executeRawUnsafe(`DELETE FROM tasks WHERE tenant_id = $1::uuid`, tenantId);
      await tx.$executeRawUnsafe(
        `DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid`, tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid`, tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid`, tenantId,
      );
      // FIX 4's addResults path writes these three beyond the obvious clinical
      // tables; each carries an FK to tenants(id) and so blocks the tenant
      // DELETE. pathway_projector_inbox in particular only appears once the
      // comprehensive seeder has installed pathway definitions — it is invisible
      // on a bare migrated database, which is exactly why this teardown is
      // verified after the seeder and not only on a fresh DB.
      await tx.$executeRawUnsafe(
        `DELETE FROM diagnostic_result_generations WHERE tenant_id = $1::uuid`, tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM pathway_projector_inbox WHERE tenant_id = $1::uuid`, tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM event_outbox WHERE tenant_id = $1::uuid`, tenantId,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM investigations WHERE tenant_id = $1::uuid`, tenantId,
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
  // visiting it. Swallowing this is what hid exactly that during development —
  // the FK error names the offending child table, which is the most actionable
  // signal available, so let it surface as a failed hook.
  await prisma.$executeRawUnsafe(
    `DELETE FROM tenants WHERE id IN ($1::uuid, $2::uuid)`, TENANT, TENANT_DECOY,
  );
}

d('Critical-result escalation/SLA — audit C-3 (deep, real services + DB)', () => {
  let patientIntId = null;
  let decoyRecipTaskId = null;

  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, 'c3test-escalation', 'C3TEST Escalation Tenant', 'IN', 'DPDP', 'active'),
              ($2::uuid, 'c3test-escalation-decoy', 'C3TEST Escalation Decoy', 'IN', 'DPDP', 'active')
       ON CONFLICT (id) DO NOTHING`,
      TENANT, TENANT_DECOY,
    );
    // Patient + ordering doctor + an on-duty DUTY_DOCTOR (T2 target) + a CMO
    // (T3 target). DUTY_DOCTOR / CMO are the concrete roles resolveRoleCode maps
    // the seeded DUTY / LEADERSHIP tier tokens to. tenant_id is set EXPLICITLY on
    // every row: raw inserts run with app.current_tenant_id unset, so an omitted
    // tenant_id silently falls to the column DEFAULT (the default tenant).
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'C3 Patient [test]', 'PATIENT', true, $3::uuid, NOW()),
              ($4::uuid, $5, 'C3 Doctor [test]', 'DOCTOR', true, $3::uuid, NOW()),
              ($6::uuid, $7, 'C3 Duty Doc [test]', 'DUTY_DOCTOR', true, $3::uuid, NOW()),
              ($8::uuid, $9, 'C3 CMO [test]', 'CMO', true, $3::uuid, NOW())`,
      PATIENT_UID, PATIENT_PHONE, TENANT,
      DOCTOR_UID, DOCTOR_PHONE,
      DUTY_UID, DUTY_PHONE,
      CMO_UID, CMO_PHONE,
    );
    // Decoy tenant: the same four roles. These are what make FIX 1a's exact
    // recipient arrays probative rather than merely true.
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, 'C3 Decoy Patient [test]', 'PATIENT', true, $3::uuid, NOW()),
              ($4::uuid, $5, 'C3 Decoy Doctor [test]', 'DOCTOR', true, $3::uuid, NOW()),
              ($6::uuid, $7, 'C3 Decoy Duty Doc [test]', 'DUTY_DOCTOR', true, $3::uuid, NOW()),
              ($8::uuid, $9, 'C3 Decoy CMO [test]', 'CMO', true, $3::uuid, NOW())`,
      DECOY_PATIENT_UID, DECOY_PATIENT_PHONE, TENANT_DECOY,
      DECOY_DOCTOR_UID, DECOY_DOCTOR_PHONE,
      DECOY_DUTY_UID, DECOY_DUTY_PHONE,
      DECOY_CMO_UID, DECOY_CMO_PHONE,
    );
    const prow = await prisma.$queryRawUnsafe(
      `SELECT id FROM users WHERE uid = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
      PATIENT_UID, TENANT,
    );
    patientIntId = prow[0].id;

    // The tier rules must exist in BOTH tenants: in TENANT so this suite's tiers
    // fire at all, and in TENANT_DECOY so the decoy is a genuine sweep candidate
    // rather than a row the engine never looks at.
    const windows = await cloneCriticalResultEscalationRules(TENANT);
    const decoyWindows = await cloneCriticalResultEscalationRules(TENANT_DECOY);
    // Non-vacuity guard on the clone itself: if mig-312's tiers ever change, this
    // is where you find out, instead of inside a confusing tier assertion below.
    expect(windows).toEqual([0, 10, 30]);
    expect(decoyWindows).toEqual([0, 10, 30]);

    // Decoy tasks: same resource ids, same breach instant, different tenant.
    const decoyRecip = await seedBreachedCriticalTask(R.recip, {
      tenantId: TENANT_DECOY,
      patientUid: DECOY_PATIENT_UID,
      clinicianUid: DECOY_DOCTOR_UID,
    });
    decoyRecipTaskId = decoyRecip.taskId;
    await seedBreachedCriticalTask(R.ack, {
      tenantId: TENANT_DECOY,
      patientUid: DECOY_PATIENT_UID,
      clinicianUid: DECOY_DOCTOR_UID,
    });
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, HOOK_TIMEOUT_MS);

  // ----- FIX 1: tiers resolve to a real recipient ---------------------------

  it('FIX 1a — resolveRecipientsForRole resolves DUTY_DOCTOR (T2) + CMO (T3) to seeded active users (never empty)', async () => {
    // The engine resolves inside setTenantTx; resolve on a tenant tx here so the
    // same RLS-scoped SELECT runs.
    const { dutyRows, cmoRows, bogusRows } = await setTenantTx(TENANT, async (tx) => ({
      dutyRows: await __testing__.resolveRecipientsForRole(tx, TENANT, 'DUTY_DOCTOR'),
      cmoRows: await __testing__.resolveRecipientsForRole(tx, TENANT, 'CMO'),
      bogusRows: await __testing__.resolveRecipientsForRole(tx, TENANT, ''),
    }));

    expect(dutyRows.map((r) => r.uid)).toContain(DUTY_UID);
    expect(dutyRows.every((r) => Number.isInteger(r.id) && r.id > 0)).toBe(true);

    expect(cmoRows.map((r) => r.uid)).toContain(CMO_UID);
    expect(cmoRows.every((r) => Number.isInteger(r.id) && r.id > 0)).toBe(true);

    // Empty role → [] (guarded), proving the resolver is null-safe, not throwing.
    expect(bogusRows).toEqual([]);

    // Tenant-owned strengthening: this tenant holds exactly ONE user per role, so
    // the resolver's `ORDER BY id LIMIT 50` page is fully determined. On the
    // default tenant these could only ever be `toContain`, because 55 active
    // DOCTOR rows already sit in the fallback arm of that query.
    expect(dutyRows.map((r) => r.uid)).toEqual([DUTY_UID]);
    expect(cmoRows.map((r) => r.uid)).toEqual([CMO_UID]);

    // Pre-assertion: the decoy tenant really does hold an active user in each of
    // the same two roles, so the exact arrays above are a scoping proof rather
    // than a statement about an empty database.
    const decoy = await setTenantTx(TENANT_DECOY, async (tx) => ({
      duty: await __testing__.resolveRecipientsForRole(tx, TENANT_DECOY, 'DUTY_DOCTOR'),
      cmo: await __testing__.resolveRecipientsForRole(tx, TENANT_DECOY, 'CMO'),
    }));
    expect(decoy.duty.map((r) => r.uid)).toEqual([DECOY_DUTY_UID]);
    expect(decoy.cmo.map((r) => r.uid)).toEqual([DECOY_CMO_UID]);
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

    // The tier notifications went to THIS tenant's on-duty pair, not the decoy's.
    const recipientUids = await prisma.$queryRawUnsafe(
      `SELECT uid FROM users WHERE id = ANY($1::int[]) ORDER BY uid`,
      outbox.map((o) => Number(o.recipient_id)),
    );
    const uids = recipientUids.map((r) => r.uid);
    expect(uids).not.toContain(DECOY_DUTY_UID);
    expect(uids).not.toContain(DECOY_CMO_UID);

    // Pre-assertion: the decoy tenant's task, breached at the SAME instant, IS a
    // candidate at these same injected sweeps and escalated too — so the outbox
    // scoping above is a real result, not an artefact of the sweep skipping the
    // decoy entirely.
    const decoyTask = await readTaskById(decoyRecipTaskId, TENANT_DECOY);
    const decoyTiers = (decoyTask.metadata.escalations || []).map((e) => e.tier).sort();
    expect(decoyTiers).toEqual(expect.arrayContaining([1, 2, 3]));
  });

  // ----- FIX 2: ack stops the clock + backfill does not re-create -----------

  it('FIX 2a — acknowledge completes the linked SLA instance, then later sweeps do not re-create the task', async () => {
    const { taskId, slaInstanceId, breachSeen } = await seedBreachedCriticalTask(R.ack);

    const before = await readSlaInstance(slaInstanceId);
    expect(['active', 'breached']).toContain(before.status);
    expect(before.completed_at).toBeNull();

    // The task is assigned to the ordering clinician (DOCTOR_UID); acknowledge as
    // that assignee (post-authorization, a non-assignee non-role caller is 403).
    const acked = await taskService.acknowledgeTask({
      tenantId: TENANT, id: taskId, actorUid: DOCTOR_UID,
      actorRoles: ['DOCTOR'], actorPrimaryRole: 'DOCTOR', actorRawRole: 'DOCTOR',
    });
    expect(acked.status).toBe('in_progress');

    // The clock stopped: terminal status + completed_at + our completion marker.
    const afterAck = await readSlaInstance(slaInstanceId);
    expect(['completed', 'breached']).toContain(afterAck.status);
    expect(afterAck.completed_at).not.toBeNull();
    expect(afterAck.metadata?.completed_via).toBe('task_ack');

    // A completed SLA is the durable signal that the clock stopped. A later
    // sweep must not recreate the work item; migration 580 intentionally
    // forbids manufacturing an in_progress task with an incomplete SLA clock.
    // `now` is anchored to the breach (not to real wall-clock time) so this sweep
    // clears every tier window without also being a sweep at "now + 1 hour" over
    // every other breached SLA in the database.
    const openBefore = await countOpenTasksForResource('lab_result', R.ack);
    await runEscalationSweep({ now: new Date(breachSeen.getTime() + 60 * 60_000) });
    expect(await countOpenTasksForResource('lab_result', R.ack)).toBe(openBefore);

    // Once the human work is terminal, the completed SLA still prevents a
    // future sweep from re-alerting on the already-handled result.
    await taskService.transitionTask({
      tenantId: TENANT, id: taskId, nextStatus: 'completed',
    });
    await runEscalationSweep({ now: new Date(breachSeen.getTime() + 90 * 60_000) });
    expect(await countOpenTasksForResource('lab_result', R.ack)).toBe(0);

    // Pre-assertion: the decoy tenant holds its own OPEN task for this very same
    // resource id throughout. The zero above is a tenant-scoped zero, not an
    // empty-table zero.
    expect(await countOpenTasksForResource('lab_result', R.ack, TENANT_DECOY)).toBe(1);
  });

  it('FIX 2b — completing a task (terminal path) also stops the SLA clock', async () => {
    const { taskId, slaInstanceId } = await seedBreachedCriticalTask(R.term);

    const before = await readSlaInstance(slaInstanceId);
    expect(before.completed_at).toBeNull();

    // Resolve the result directly (not via ack) — the terminal transition must
    // close the linked instance too (completeLinkedSla on transitionTask).
    const done = await taskService.transitionTask({
      tenantId: TENANT,
      id: taskId,
      nextStatus: 'completed',
      actorUid: DOCTOR_UID,
    });
    expect(done.status).toBe('completed');

    const after = await readSlaInstance(slaInstanceId);
    expect(['completed', 'breached']).toContain(after.status);
    expect(after.completed_at).not.toBeNull();
    expect(after.metadata?.completed_via).toBe('task_completion');
    expect(after.metadata?.completed_by).toBe(DOCTOR_UID);
  });

  // ----- FIX 3: lab producer SLA key == ack-flow key ------------------------

  it('FIX 3 — the authorized task acknowledgement closes the lab producer SLA key', async () => {
    const res = await enqueueCriticalResultTask({
      tenantId: TENANT,
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

    await taskService.acknowledgeTask({
      tenantId: TENANT,
      id: res.taskId,
      actorUid: DOCTOR_UID,
      actorRoles: ['DOCTOR'],
      actorPrimaryRole: 'DOCTOR',
      actorRawRole: 'DOCTOR',
    });

    const slaAfter = await readSlaByKey('lab_result', R.lab);
    expect(['completed', 'breached']).toContain(slaAfter.status);
    expect(slaAfter.completed_at).not.toBeNull();

    // Acknowledgement stops the clock but leaves the human work item open until
    // its clinical action is complete.
    const task = await readTaskById(res.taskId);
    expect(task.status).toBe('in_progress');
    expect(task.metadata?.acknowledged_via).toBe('assignee');
  });

  // ----- FIX 4: investigation critical → ack-task from minute 0 -------------

  it('FIX 4 — investigation critical result creates an assigned ack-task + ("investigations", id) SLA immediately', async () => {
    // Seed an investigation row with NO results yet (first submit) for our
    // patient, ordered by the doctor. tenant_id is EXPLICIT — this insert used to
    // omit it, which put the row on the default tenant via the column DEFAULT.
    const invRow = await prisma.$queryRawUnsafe(
      `INSERT INTO investigations
         (phone, patient_id, patient_uid, tenant_id, test_name, test_type, status,
          requested_by, requested_at, updated_at)
       VALUES ($1, $2::int, $3::uuid, $5::uuid, 'Serum Potassium', 'LAB', 'COLLECTED',
               $4::uuid, NOW(), NOW())
       RETURNING id`,
      PATIENT_PHONE, patientIntId, PATIENT_UID, DOCTOR_UID, TENANT,
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
      TENANT,
      'DOCTOR',
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
      `SELECT id, status, assigned_to_uid, priority,
              workflow_sla_instance_id, sla_completion_semantics, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid AND related_resource_type = 'investigations'
          AND related_resource_id = $2 LIMIT 1`,
      TENANT, String(investigationId),
    );
    expect(taskRows.length).toBe(1);
    const task = taskRows[0];
    expect(task.status).toBe('open');
    expect(task.priority).toBe('critical');
    // Ack-tracked + assigned to the ordering clinician + linked to the SLA.
    expect(task.assigned_to_uid).toBe(DOCTOR_UID);
    expect(task.workflow_sla_instance_id).toBe(sla.id);
    expect(task.sla_completion_semantics).toBe('acknowledgement');
    expect(task.metadata.source).toBe('investigation');

    await taskService.transitionTask({
      tenantId: TENANT,
      id: task.id,
      nextStatus: 'completed',
      actorUid: DOCTOR_UID,
    });
    const directCompletion = await prisma.$queryRawUnsafe(
      `SELECT task.status AS task_status,
              sla.status AS sla_status,
              (EXTRACT(EPOCH FROM task.completed_at) * 1000)::double precision AS task_completed_epoch_ms,
              (EXTRACT(EPOCH FROM sla.completed_at) * 1000)::double precision AS sla_completed_epoch_ms,
              (EXTRACT(EPOCH FROM sla.due_at) * 1000)::double precision AS sla_due_epoch_ms
         FROM tasks task
         JOIN workflow_sla_instances sla
           ON sla.tenant_id = task.tenant_id
          AND sla.id = task.workflow_sla_instance_id
        WHERE task.tenant_id = $1::uuid AND task.id = $2::int`,
      TENANT,
      task.id,
    );
    expect(directCompletion[0]).toMatchObject({
      task_status: 'completed',
      sla_status: 'completed',
    });
    expect(directCompletion[0].task_completed_epoch_ms)
      .toBe(directCompletion[0].sla_completed_epoch_ms);
    expect(directCompletion[0].sla_completed_epoch_ms)
      .toBeLessThanOrEqual(directCompletion[0].sla_due_epoch_ms);

    await investigationService.addResults(
      investigationId,
      {
        results: {
          analytes: [
            { name: 'Potassium', value: '7.8', unit: 'mmol/L', normal_range: '3.5-5.1', flag: 'PANIC' },
          ],
        },
        re_run: true,
        re_run_reason: 'Analyzer rerun confirmed the panic value',
      },
      DOCTOR_UID,
      TENANT,
      'DOCTOR',
    );

    const rerunTasks = await prisma.$queryRawUnsafe(
      `SELECT id, status, title, description, priority,
              workflow_sla_instance_id, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'investigations'
          AND related_resource_id = $2
        ORDER BY id`,
      TENANT,
      String(investigationId),
    );
    expect(rerunTasks).toHaveLength(2);
    expect(rerunTasks[0]).toMatchObject({ id: task.id, status: 'completed' });
    expect(rerunTasks[1]).toMatchObject({
      status: 'open',
      title: 'Critical result: Serum Potassium',
      priority: 'critical',
      workflow_sla_instance_id: sla.id,
      metadata: {
        reopened_from_task_id: task.id,
        reopen_reason: 'investigation_result_rerun',
      },
    });
    const rerunSla = await readSlaByKey('investigations', String(investigationId));
    expect(rerunSla).toMatchObject({ id: sla.id, status: 'active', completed_at: null });

    await taskService.transitionTask({
      tenantId: TENANT,
      id: rerunTasks[1].id,
      nextStatus: 'completed',
      actorUid: DOCTOR_UID,
    });
    const completedRerunSla = await readSlaByKey(
      'investigations',
      String(investigationId),
    );
    expect(completedRerunSla).toMatchObject({
      id: sla.id,
      status: 'completed',
    });
    expect(completedRerunSla.completed_at).not.toBeNull();

    await investigationService.addResults(
      investigationId,
      {
        results: {
          analytes: [
            { name: 'Potassium', value: '4.2', unit: 'mmol/L', normal_range: '3.5-5.1', flag: 'N' },
          ],
        },
        re_run: true,
        re_run_reason: 'Corrected analyzer calibration result',
      },
      DOCTOR_UID,
      TENANT,
      'DOCTOR',
    );

    const correctedTasks = await prisma.$queryRawUnsafe(
      `SELECT id, status, title, description, priority,
              workflow_sla_instance_id, metadata
         FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'investigations'
          AND related_resource_id = $2
        ORDER BY id`,
      TENANT,
      String(investigationId),
    );
    // The shipped high-to-normal re-ack compatibility rule is lab-only. Until
    // D4/D5 define normal and abnormal-noncritical disposition, a currently
    // noncritical investigation correction must not manufacture or re-arm a
    // critical-result obligation.
    expect(correctedTasks).toHaveLength(2);
    expect(correctedTasks).toEqual([
      expect.objectContaining({ id: task.id, status: 'completed' }),
      expect.objectContaining({ id: rerunTasks[1].id, status: 'completed' }),
    ]);
    const unchangedSla = await readSlaByKey('investigations', String(investigationId));
    expect(unchangedSla).toMatchObject({ id: sla.id, status: 'completed' });
    expect(unchangedSla.completed_at).toEqual(completedRerunSla.completed_at);
  });
});

// Keep eslint happy about the imported jest namespace in this ESM test.
void jest;
