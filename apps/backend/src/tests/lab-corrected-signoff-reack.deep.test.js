// Corrected/amended lab sign-off must restart the critical-result safety loop.
//
// Care-pathways program design §11 quick-win 1
// (docs/superpowers/specs/2026-07-14-unified-care-pathways-program-design.md):
// signOffResults gates every downstream consequence (patient notify, order
// completion) to decision==='verified', so a pathologist sign-off with
// decision 'corrected'/'amended':
//
//   1. never re-runs critical detection over the corrected values (a value
//      whose threshold was configured after recording stays silently
//      non-critical),
//   2. never reopens the results-inbox acknowledgement loop (an already-
//      acknowledged task swallows the corrected value — the clinician who
//      acked the OLD value is never asked to re-acknowledge the NEW one), and
//   3. never re-notifies the patient (they keep acting on the stale value).
//
// This deep test proves the full loop against the real services + QA DB:
// a corrected critical result must end with an OWNED, UNACKNOWLEDGED open
// task (fresh ack window), and the patient must be told — except for rows a
// clinician has explicitly held from the patient (portalAccessService
// release policy, migration 294).

import prisma from '../lib/prisma.js';
import * as labResults from '../services/lab/labResultsService.js';
import * as taskService from '../services/workflow/taskService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const PATIENT_A_UID = `d2a00000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const PATIENT_B_UID = `d2b00000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const PATIENT_C_UID = `d2c00000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const DOCTOR_UID = `d2d00000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const PATHOLOGIST_UID = `d2e00000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const ALL_UIDS = [PATIENT_A_UID, PATIENT_B_UID, PATIENT_C_UID, DOCTOR_UID, PATHOLOGIST_UID];
// Synthetic analyte code so the seeded threshold set can never collide.
const TEST_CODE = `XKT${SUFFIX}`;

const resultIds = [];
const investigationIds = [];

async function insertUser(uid, phone, name, role) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, true, $5::uuid, NOW())
     ON CONFLICT (uid) DO UPDATE SET phone = EXCLUDED.phone
     RETURNING id`,
    uid, phone, name, role, TENANT,
  );
  return rows[0].id;
}

async function insertInvestigation(patientUid) {
  const patientRows = await prisma.$queryRawUnsafe(
    `SELECT id, phone FROM users WHERE uid = $1::uuid`, patientUid,
  );
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO investigations
       (tenant_id, phone, patient_id, patient_uid, test_name, test_type,
        status, priority, requested_by, requested_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4::uuid, 'Potassium [test]', 'blood',
             'REQUESTED', 'NORMAL', $5::uuid, NOW(), NOW())
     RETURNING id`,
    TENANT, patientRows[0].phone, patientRows[0].id, patientUid, DOCTOR_UID,
  );
  investigationIds.push(rows[0].id);
  return rows[0].id;
}

// Raw result insert — simulates a row recorded WITHOUT critical detection
// having fired for it (e.g. the threshold was configured after recording).
async function insertRawResult(patientUid, investigationId, valueText, { releaseHold = false } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_results
       (tenant_id, patient_uid, investigation_id, test_code, test_name,
        value_text, value_numeric, unit, status, release_hold)
     VALUES ($1::uuid, $2::uuid, $3::int, $4, 'Potassium [test]',
             $5, $6::numeric, 'mmol/L', 'preliminary', $7)
     RETURNING id`,
    TENANT, patientUid, investigationId, TEST_CODE, valueText, Number(valueText), releaseHold,
  );
  resultIds.push(rows[0].id);
  return rows[0].id;
}

async function openTasksFor(resultId) {
  return prisma.$queryRawUnsafe(
    `SELECT id, status, priority, assigned_to_uid, metadata
       FROM tasks
      WHERE tenant_id = $1::uuid
        AND related_resource_type = 'lab_result'
        AND related_resource_id = $2
      ORDER BY id ASC`,
    TENANT, String(resultId),
  );
}

async function signOff(ids, decision, patientUid) {
  return labResults.signOffResults({
    tenantId: TENANT,
    signed_off_by: PATHOLOGIST_UID,
    signed_off_by_role: 'PATHOLOGIST',
    result_ids: ids,
    decision,
    patient_uid: patientUid,
  });
}

async function cleanup() {
  const ridStrs = resultIds.map(String);
  if (resultIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM task_comments WHERE task_id IN (
         SELECT id FROM tasks WHERE tenant_id = $1::uuid
           AND related_resource_type = 'lab_result' AND related_resource_id = ANY($2::text[]))`,
      TENANT, ridStrs,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM tasks WHERE tenant_id = $1::uuid
         AND related_resource_type = 'lab_result' AND related_resource_id = ANY($2::text[])`,
      TENANT, ridStrs,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances WHERE tenant_id = $1::uuid
         AND source_table = 'lab_result' AND source_id = ANY($2::text[])`,
      TENANT, ridStrs,
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM lab_critical_alerts WHERE tenant_id = $1::uuid AND result_id = ANY($2::int[])`,
      TENANT, resultIds,
    ).catch(() => {});
    for (const rid of resultIds) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM lab_pathologist_signoffs WHERE $1 = ANY(result_ids)`, rid,
      ).catch(() => {});
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events WHERE tenant_id = $1::uuid
         AND source_table IN ('lab_results', 'lab_pathologist_signoffs')
         AND patient_uid = ANY($2::uuid[])`,
      TENANT, [PATIENT_A_UID, PATIENT_B_UID, PATIENT_C_UID],
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events WHERE tenant_id = $1::uuid
         AND patient_uid = ANY($2::uuid[])`,
      TENANT, [PATIENT_A_UID, PATIENT_B_UID, PATIENT_C_UID],
    ).catch(() => {});
    await prisma.$executeRawUnsafe(
      `DELETE FROM lab_results WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
      TENANT, resultIds,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM notifications WHERE uid = ANY($1::uuid[])`, ALL_UIDS,
  ).catch(() => {});
  if (investigationIds.length) {
    await prisma.$executeRawUnsafe(
      `DELETE FROM investigations WHERE tenant_id = $1::uuid AND id = ANY($2::int[])`,
      TENANT, investigationIds,
    ).catch(() => {});
  }
  await prisma.$executeRawUnsafe(
    `DELETE FROM lab_critical_thresholds WHERE tenant_id = $1::uuid AND test_code = $2`,
    TENANT, TEST_CODE,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid = ANY($1::uuid[])`, ALL_UIDS,
  ).catch(() => {});
}

d('Corrected/amended sign-off restarts the critical-result safety loop', () => {
  beforeAll(async () => {
    await insertUser(PATIENT_A_UID, `98221${SUFFIX}1`.slice(0, 10), 'Reack Patient A [test]', 'PATIENT');
    await insertUser(PATIENT_B_UID, `98222${SUFFIX}2`.slice(0, 10), 'Reack Patient B [test]', 'PATIENT');
    await insertUser(PATIENT_C_UID, `98223${SUFFIX}3`.slice(0, 10), 'Reack Patient C [test]', 'PATIENT');
    await insertUser(DOCTOR_UID, `98224${SUFFIX}4`.slice(0, 10), 'Reack Doctor [test]', 'DOCTOR');
    await insertUser(PATHOLOGIST_UID, `98225${SUFFIX}5`.slice(0, 10), 'Reack Pathologist [test]', 'PATHOLOGIST');
    await prisma.$executeRawUnsafe(
      `INSERT INTO lab_critical_thresholds
         (tenant_id, test_code, test_name, unit, critical_low, critical_high, is_active)
       VALUES ($1::uuid, $2, 'Potassium [test]', 'mmol/L', 2.5, 6.0, true)`,
      TENANT, TEST_CODE,
    );
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  // ── Scenario A — reopen after acknowledgement ─────────────────────────
  // The ordering clinician acknowledged the ORIGINAL critical value; the
  // pathologist then signs the corrected value. The acked (in_progress)
  // task sits inside the mig-312 open-task index, so a plain re-enqueue is
  // a silent no-op — the sign-off must supersede it and open a FRESH,
  // unacknowledged ack window.
  describe('corrected sign-off after the original task was acknowledged', () => {
    let resultId;
    let originalTaskId;

    it('precondition: recording a critical value creates an open task; the clinician acks it', async () => {
      const invId = await insertInvestigation(PATIENT_A_UID);
      const { result, alerts } = await labResults.recordResultManual({
        tenantId: TENANT,
        performed_by: DOCTOR_UID,
        performed_by_role: 'DOCTOR',
        result: {
          patient_uid: PATIENT_A_UID,
          investigation_id: invId,
          test_code: TEST_CODE,
          test_name: 'Potassium [test]',
          value_text: '7.2',
          unit: 'mmol/L',
          status: 'preliminary',
        },
      });
      resultId = result.id;
      resultIds.push(resultId);
      expect(alerts.length).toBe(1);

      const tasks = await openTasksFor(resultId);
      expect(tasks.length).toBe(1);
      expect(tasks[0].status).toBe('open');
      expect(tasks[0].assigned_to_uid).toBe(DOCTOR_UID);
      originalTaskId = tasks[0].id;

      const acked = await taskService.acknowledgeTask({
        tenantId: TENANT, id: originalTaskId, actorUid: DOCTOR_UID,
      });
      expect(acked.status).toBe('in_progress');
    });

    it('corrected sign-off supersedes the acked task with a fresh, owned, unacknowledged one', async () => {
      await signOff([resultId], 'corrected', PATIENT_A_UID);

      const tasks = await openTasksFor(resultId);
      const fresh = tasks.filter((t) => t.status === 'open');
      expect(fresh.length).toBe(1);
      expect(fresh[0].id).not.toBe(originalTaskId);
      // Owned: assigned to the ordering clinician, not just a role bucket.
      expect(fresh[0].assigned_to_uid).toBe(DOCTOR_UID);
      // Unacknowledged: a brand-new ack window.
      expect(fresh[0].metadata?.acknowledged_at).toBeUndefined();
      // Reopen provenance points back at the superseded task.
      expect(fresh[0].metadata?.reopened_from_task_id).toBe(originalTaskId);

      const old = tasks.find((t) => t.id === originalTaskId);
      expect(old.status).toBe('completed');
    });

    it('restarts the critical_result_ack SLA clock for the corrected value', async () => {
      // due_at freshness is compared DB-side: raw timestamptz values
      // deserialize through the server TZ (IST on the QA box), so a JS
      // wall-clock comparison would shift by -5:30.
      const rows = await prisma.$queryRawUnsafe(
        `SELECT status, completed_at, (due_at > NOW()) AS due_in_future
           FROM workflow_sla_instances
          WHERE tenant_id = $1::uuid AND rule_code = 'critical_result_ack'
            AND source_table = 'lab_result' AND source_id = $2
          ORDER BY created_at DESC LIMIT 1`,
        TENANT, String(resultId),
      );
      expect(rows.length).toBe(1);
      expect(rows[0].status).toBe('active');
      expect(rows[0].completed_at).toBeNull();
      expect(rows[0].due_in_future).toBe(true);
    });

    it('re-notifies the patient that the result was corrected', async () => {
      const notifs = await prisma.$queryRawUnsafe(
        `SELECT title, body, data FROM notifications
          WHERE uid = $1::uuid AND type = 'lab_result_corrected'`,
        PATIENT_A_UID,
      );
      expect(notifs.length).toBeGreaterThanOrEqual(1);
      expect(notifs[0].body).toMatch(/correct/i);
    });
  });

  // ── Scenario B — re-detection over the corrected values ──────────────
  // The row's value breaches a threshold that detection never evaluated
  // (configured after recording). An 'amended' sign-off must re-run
  // detection: flag the row, fire the alert, and open an owned task.
  describe('amended sign-off re-runs critical detection', () => {
    let resultId;

    it('precondition: the raw row is not flagged critical and has no task', async () => {
      const invId = await insertInvestigation(PATIENT_B_UID);
      resultId = await insertRawResult(PATIENT_B_UID, invId, '7.5');

      const rows = await prisma.$queryRawUnsafe(
        `SELECT is_critical FROM lab_results WHERE id = $1::int AND tenant_id = $2::uuid`,
        resultId, TENANT,
      );
      expect(rows[0].is_critical).not.toBe(true);
      expect((await openTasksFor(resultId)).length).toBe(0);
    });

    it('amended sign-off flags the row, fires the alert, and opens an owned task', async () => {
      await signOff([resultId], 'amended', PATIENT_B_UID);

      const rows = await prisma.$queryRawUnsafe(
        `SELECT is_critical FROM lab_results WHERE id = $1::int AND tenant_id = $2::uuid`,
        resultId, TENANT,
      );
      expect(rows[0].is_critical).toBe(true);

      const alerts = await prisma.$queryRawUnsafe(
        `SELECT id FROM lab_critical_alerts WHERE tenant_id = $1::uuid AND result_id = $2::int`,
        TENANT, resultId,
      );
      expect(alerts.length).toBe(1);

      const tasks = await openTasksFor(resultId);
      expect(tasks.length).toBe(1);
      expect(tasks[0].status).toBe('open');
      expect(tasks[0].assigned_to_uid).toBe(DOCTOR_UID);
      expect(tasks[0].metadata?.acknowledged_at).toBeUndefined();
    });
  });

  // ── Scenario B2 — a still-unacknowledged window is never duplicated ──
  // If the existing task is 'overdue' (the escalation sweep marks past-due
  // open tasks), the mig-312 partial index no longer covers it — only the
  // reopen helper's explicit open/overdue check prevents a second window
  // for the same resource.
  describe('corrected sign-off with a still-unacknowledged window', () => {
    it('does not duplicate the task when the existing window is overdue', async () => {
      const invId = await insertInvestigation(PATIENT_B_UID);
      const { result } = await labResults.recordResultManual({
        tenantId: TENANT,
        performed_by: DOCTOR_UID,
        performed_by_role: 'DOCTOR',
        result: {
          patient_uid: PATIENT_B_UID,
          investigation_id: invId,
          test_code: TEST_CODE,
          test_name: 'Potassium [test]',
          value_text: '7.8',
          unit: 'mmol/L',
          status: 'preliminary',
        },
      });
      resultIds.push(result.id);
      const before = await openTasksFor(result.id);
      expect(before.length).toBe(1);
      await prisma.$executeRawUnsafe(
        `UPDATE tasks SET status = 'overdue', updated_at = NOW()
          WHERE id = $1::int AND tenant_id = $2::uuid`,
        before[0].id, TENANT,
      );

      await signOff([result.id], 'corrected', PATIENT_B_UID);

      const after = await openTasksFor(result.id);
      expect(after.length).toBe(1);
      expect(after[0].id).toBe(before[0].id);
      expect(['open', 'overdue']).toContain(after[0].status);
      expect(after[0].metadata?.acknowledged_at).toBeUndefined();
    });
  });

  // ── Scenario C — patient re-notify honors the release policy ─────────
  // A row a clinician explicitly held from the patient (migration 294,
  // portalAccessService) must NOT be announced; the non-held row in the
  // same corrected batch must be.
  describe('corrected sign-off notifies only per the release policy', () => {
    let heldId;
    let plainId;

    it('notifies for the released row and never references the held row', async () => {
      const invId = await insertInvestigation(PATIENT_C_UID);
      heldId = await insertRawResult(PATIENT_C_UID, invId, '4.2', { releaseHold: true });
      plainId = await insertRawResult(PATIENT_C_UID, invId, '4.4');

      await signOff([heldId, plainId], 'corrected', PATIENT_C_UID);

      const notifs = await prisma.$queryRawUnsafe(
        `SELECT data FROM notifications
          WHERE uid = $1::uuid AND type = 'lab_result_corrected'`,
        PATIENT_C_UID,
      );
      expect(notifs.length).toBe(1);
      const notifiedIds = notifs[0].data?.result_ids || [];
      expect(notifiedIds).toContain(plainId);
      expect(notifiedIds).not.toContain(heldId);
    });
  });

  // ── Regression guard — rejected sign-off stays inert ─────────────────
  it('a rejected sign-off does not fire the corrected-result loop', async () => {
    const invId = await insertInvestigation(PATIENT_C_UID);
    const rid = await insertRawResult(PATIENT_C_UID, invId, '7.9');

    await signOff([rid], 'rejected', PATIENT_C_UID);

    expect((await openTasksFor(rid)).length).toBe(0);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT is_critical FROM lab_results WHERE id = $1::int AND tenant_id = $2::uuid`,
      rid, TENANT,
    );
    expect(rows[0].is_critical).not.toBe(true);
  });
});
