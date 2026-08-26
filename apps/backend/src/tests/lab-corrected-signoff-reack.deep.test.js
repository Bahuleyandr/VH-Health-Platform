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

import { Client } from 'pg';
import { createHash } from 'node:crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import * as labResults from '../services/lab/labResultsService.js';
import * as taskService from '../services/workflow/taskService.js';
import { ensureCriticalResultTaskOpen } from '../services/results/resultsInboxService.js';
import {
  listLateLegacyCorrectiveSignoffs,
  reconcileLateLegacyLabCriticalAlerts,
} from '../services/lab/labCriticalAlertReconciliationService.js';
import { materializeLabCriticalAlertGeneration } from '../services/lab/labCriticalAlertService.js';
import { evaluateCriticalThreshold } from '../services/lab/labCriticalThresholdService.js';
import { seedActiveLabThresholdPolicy } from './helpers/labThresholdGovernanceFixture.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const d = DB_CONFIGURED ? describe : describe.skip;

const TENANT = '00000000-0000-4000-8000-000000000001';
const SUFFIX = String(Date.now() % 100000).padStart(5, '0');
const PATIENT_A_UID = `d2a00000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const PATIENT_B_UID = `d2b00000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const PATIENT_C_UID = `d2c00000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const DOCTOR_UID = `d2d00000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const PATHOLOGIST_UID = `d2e00000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const POLICY_AUTHOR_UID = `d2f00000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const POLICY_ACTIVATOR_UID = `d2f10000-0000-4000-8000-${SUFFIX.padStart(12, '0')}`;
const ALL_UIDS = [
  PATIENT_A_UID,
  PATIENT_B_UID,
  PATIENT_C_UID,
  DOCTOR_UID,
  PATHOLOGIST_UID,
  POLICY_AUTHOR_UID,
  POLICY_ACTIVATOR_UID,
];
// Synthetic analyte code so the seeded threshold set can never collide.
const TEST_CODE = `XKT${SUFFIX}`;
const CONVERTED_TEST_CODE = `XWB${SUFFIX}`;
const FAIL_REOPEN_FUNCTION = `vh_test_fail_result_reopen_${SUFFIX}`;
const FAIL_REOPEN_TRIGGER = `vh_test_fail_result_reopen_trigger_${SUFFIX}`;

const resultIds = [];
const investigationIds = [];
let manualCommandOrdinal = 0;
let policyFixture;

async function recordManualResult(args) {
  manualCommandOrdinal += 1;
  return labResults.recordResultManual({
    ...args,
    idempotencyKey: `reack-${SUFFIX}-${manualCommandOrdinal}`,
    requestBodySha256: createHash('sha256')
      .update(JSON.stringify(args.result))
      .digest('hex'),
  });
}

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
    `SELECT id, status, priority, title, description, assigned_to_uid,
            workflow_sla_instance_id, metadata
       FROM tasks
      WHERE tenant_id = $1::uuid
        AND related_resource_type = 'lab_result'
        AND related_resource_id = $2
      ORDER BY id ASC`,
    TENANT, String(resultId),
  );
}

async function signOff(ids, decision, patientUid) {
  if (decision === 'corrected' || decision === 'amended') {
    await setTenantTx(TENANT, async (tx) => {
      const predecessors = await tx.$queryRawUnsafe(
        `SELECT id
           FROM lab_pathologist_signoffs
          WHERE tenant_id = $1::uuid
            AND result_ids = $2::int[]
            AND decision IN ('verified', 'corrected', 'amended')
          LIMIT 1`,
        TENANT,
        ids,
      );
      if (predecessors.length === 0) {
        await tx.$executeRawUnsafe(
          `INSERT INTO lab_pathologist_signoffs
             (tenant_id, patient_uid, result_ids, signed_off_by, decision, comments, signed_at)
           VALUES ($1::uuid, $2::uuid, $3::int[], $4::uuid, 'verified',
                   'S2a fixture predecessor generation', NOW() - INTERVAL '1 second')`,
          TENANT,
          patientUid,
          ids,
          PATHOLOGIST_UID,
        );
      }
      await tx.$executeRawUnsafe(
        `UPDATE lab_results
            SET status = CASE
                           WHEN signed_off_at IS NULL THEN 'final'
                           ELSE status
                         END,
                signed_off_at = COALESCE(signed_off_at, NOW() - INTERVAL '1 second'),
                signed_off_by = COALESCE(signed_off_by, $1::uuid),
                updated_at = clock_timestamp()
          WHERE tenant_id = $2::uuid
            AND id = ANY($3::int[])`,
        PATHOLOGIST_UID,
        TENANT,
        ids,
      );
    });
  }
  return labResults.signOffResults({
    tenantId: TENANT,
    signed_off_by: PATHOLOGIST_UID,
    signed_off_by_role: 'PATHOLOGIST',
    result_ids: ids,
    decision,
    patient_uid: patientUid,
  });
}

async function insertLegacyCorrectiveSignoff(resultId, patientUid, decision = 'amended') {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO lab_pathologist_signoffs
       (tenant_id, patient_uid, result_ids, signed_off_by, decision, comments)
     VALUES ($1::uuid, $2::uuid, ARRAY[$3::int], $4::uuid, $5,
             'simulated old-writer corrective sign-off')
     RETURNING id`,
    TENANT,
    patientUid,
    resultId,
    PATHOLOGIST_UID,
    decision,
  );
  return Number(rows[0].id);
}

async function waitForResourceLockWait(client, blockerPid, minimumWaiters) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const waiting = await client.query(
      `SELECT COUNT(*)::int AS waiting
         FROM pg_stat_activity AS activity
        WHERE activity.datname = current_database()
          AND activity.pid <> $1::int
          AND $1::int = ANY(pg_blocking_pids(activity.pid))`,
      [blockerPid],
    );
    if (waiting.rows[0]?.waiting >= minimumWaiters) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for ordered critical-result resource-lock contenders');
}

async function cleanup() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${FAIL_REOPEN_TRIGGER}" ON tasks`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${FAIL_REOPEN_FUNCTION}"()`);
  const scopedResultIds = [...new Set(resultIds.map(Number))];
  const scopedResultIdTexts = scopedResultIds.map(String);
  const scopedInvestigationIds = [...new Set(investigationIds.map(Number))];
  await setTenantTx(TENANT, async (tx) => {
    // These rows intentionally include append-only clinical receipts and
    // immutable corrective sign-offs. Teardown is confined to the disposable
    // superuser test database and one transaction; exact fixture predicates
    // prevent it from weakening or touching normal runtime data.
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_critical_alert_acknowledgement_receipts
        WHERE tenant_id = $1::uuid
          AND result_id = ANY($2::int[])`,
      TENANT,
      scopedResultIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_critical_alert_reconciliation_receipts
        WHERE tenant_id = $1::uuid
          AND result_id = ANY($2::int[])`,
      TENANT,
      scopedResultIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_timeline_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = ANY($2::uuid[])`,
      TENANT,
      [PATIENT_A_UID, PATIENT_B_UID, PATIENT_C_UID],
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_critical_alerts
        WHERE tenant_id = $1::uuid
          AND result_id = ANY($2::int[])`,
      TENANT,
      scopedResultIds,
    );
    const diagnosticGenerationRows = await tx.$queryRawUnsafe(
      `SELECT DISTINCT generation.id
         FROM diagnostic_result_generations AS generation
         JOIN diagnostic_result_generation_items AS item
           ON item.tenant_id = generation.tenant_id
          AND item.generation_id = generation.id
        WHERE generation.tenant_id = $1::uuid
          AND item.source_table = 'lab_results'
          AND item.source_row_id = ANY($2::text[])`,
      TENANT,
      scopedResultIdTexts,
    );
    const diagnosticGenerationIds = diagnosticGenerationRows.map((row) => row.id);
    await tx.$executeRawUnsafe(
      `DELETE FROM diagnostic_result_actions
        WHERE tenant_id = $1::uuid
          AND generation_id = ANY($2::uuid[])`,
      TENANT,
      diagnosticGenerationIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM diagnostic_result_generation_items
        WHERE tenant_id = $1::uuid
          AND generation_id = ANY($2::uuid[])`,
      TENANT,
      diagnosticGenerationIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM diagnostic_result_generations
        WHERE tenant_id = $1::uuid
          AND id = ANY($2::uuid[])`,
      TENANT,
      diagnosticGenerationIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM task_comments
        WHERE tenant_id = $1::uuid
          AND task_id IN (
            SELECT id
              FROM tasks
             WHERE tenant_id = $1::uuid
               AND related_resource_type = 'lab_result'
               AND related_resource_id = ANY($2::text[])
          )`,
      TENANT,
      scopedResultIdTexts,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM tasks
        WHERE tenant_id = $1::uuid
          AND related_resource_type = 'lab_result'
          AND related_resource_id = ANY($2::text[])`,
      TENANT,
      scopedResultIdTexts,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND source_table = 'lab_result'
          AND source_id = ANY($2::text[])`,
      TENANT,
      scopedResultIdTexts,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_pathologist_signoffs
        WHERE tenant_id = $1::uuid
          AND result_ids && $2::int[]`,
      TENANT,
      scopedResultIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_results
        WHERE tenant_id = $1::uuid
          AND id = ANY($2::int[])`,
      TENANT,
      scopedResultIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_result_ingest_commands
        WHERE tenant_id = $1::uuid
          AND result_ids && $2::int[]`,
      TENANT,
      scopedResultIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM investigations
        WHERE tenant_id = $1::uuid
          AND id = ANY($2::int[])`,
      TENANT,
      scopedInvestigationIds,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM clinical_audit_events
        WHERE tenant_id = $1::uuid
          AND patient_uid = ANY($2::uuid[])`,
      TENANT,
      [PATIENT_A_UID, PATIENT_B_UID, PATIENT_C_UID],
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM notification_outbox
        WHERE recipient_id IN (
          SELECT id::text
            FROM users
           WHERE tenant_id = $1::uuid
             AND uid = ANY($2::uuid[])
        )`,
      TENANT,
      ALL_UIDS,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM notifications WHERE uid = ANY($1::uuid[])`,
      ALL_UIDS,
    );
    const policyResourceRows = await tx.$queryRawUnsafe(
      `SELECT id::text AS id FROM lab_threshold_policy_bundles
        WHERE tenant_id = $1::uuid AND facility_id = $2::int
       UNION ALL
       SELECT id::text FROM lab_threshold_policy_rules
        WHERE tenant_id = $1::uuid AND facility_id = $2::int
       UNION ALL
       SELECT id::text FROM lab_threshold_catalog_entries
        WHERE tenant_id = $1::uuid AND facility_id = $2::int`,
      TENANT,
      policyFixture?.facilityId || null,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM audit_logs
        WHERE tenant_id = $1::uuid
          AND (
            actor_uid = ANY($2::uuid[])
            OR resource_id = ANY($3::text[])
          )`,
      TENANT,
      ALL_UIDS,
      policyResourceRows.map((row) => row.id),
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_threshold_policy_rules
        WHERE tenant_id = $1::uuid AND facility_id = $2::int`,
      TENANT,
      policyFixture?.facilityId || null,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_threshold_policy_bundles
        WHERE tenant_id = $1::uuid AND facility_id = $2::int`,
      TENANT,
      policyFixture?.facilityId || null,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_threshold_catalog_entries
        WHERE tenant_id = $1::uuid AND facility_id = $2::int`,
      TENANT,
      policyFixture?.facilityId || null,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM lab_threshold_catalog_states
        WHERE tenant_id = $1::uuid AND facility_id = $2::int`,
      TENANT,
      policyFixture?.facilityId || null,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM facilities
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      TENANT,
      policyFixture?.facilityId || null,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM users
        WHERE tenant_id = $1::uuid
          AND uid = ANY($2::uuid[])`,
      TENANT,
      ALL_UIDS,
    );
  });
}

d('Corrected/amended sign-off restarts the critical-result safety loop', () => {
  beforeAll(async () => {
    await insertUser(PATIENT_A_UID, `98221${SUFFIX}1`.slice(0, 10), 'Reack Patient A [test]', 'PATIENT');
    await insertUser(PATIENT_B_UID, `98222${SUFFIX}2`.slice(0, 10), 'Reack Patient B [test]', 'PATIENT');
    await insertUser(PATIENT_C_UID, `98223${SUFFIX}3`.slice(0, 10), 'Reack Patient C [test]', 'PATIENT');
    await insertUser(DOCTOR_UID, `98224${SUFFIX}4`.slice(0, 10), 'Reack Doctor [test]', 'DOCTOR');
    await insertUser(PATHOLOGIST_UID, `98225${SUFFIX}5`.slice(0, 10), 'Reack Pathologist [test]', 'PATHOLOGIST');
    await insertUser(
      POLICY_AUTHOR_UID,
      `98226${SUFFIX}6`.slice(0, 10),
      'Reack Policy Author [test]',
      'ADMIN',
    );
    await insertUser(
      POLICY_ACTIVATOR_UID,
      `98227${SUFFIX}7`.slice(0, 10),
      'Reack Policy Activator [test]',
      'SUPER_ADMIN',
    );
    policyFixture = await seedActiveLabThresholdPolicy({
      db: prisma,
      tenantId: TENANT,
      facilityCode: `reack-policy-${SUFFIX}`,
      facilityName: `Corrected-result governed-policy facility ${SUFFIX}`,
      authorUid: POLICY_AUTHOR_UID,
      approverUid: PATHOLOGIST_UID,
      activatorUid: POLICY_ACTIVATOR_UID,
      sourceReference: `REACK-DEEP-${SUFFIX}`,
      metadata: { test_fixture: 'lab-corrected-signoff-reack-deep' },
      isDefault: true,
      entries: [
        {
          testCode: TEST_CODE,
          testName: 'Potassium [test]',
          specimenType: 'any',
          unit: 'mmol/L',
          referenceLow: 3.5,
          referenceHigh: 5.1,
          criticalLow: 2.5,
          criticalHigh: 6,
        },
        {
          testCode: CONVERTED_TEST_CODE,
          testName: 'White blood cell count [test]',
          specimenType: 'any',
          unit: '10^3/uL',
          referenceLow: 4,
          referenceHigh: 11,
          criticalLow: 2,
          criticalHigh: 30,
        },
      ],
    });
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
    let originalAlertId;
    let replacementAlertId;
    let replacementTaskId;
    let originalTaskId;

    it('precondition: recording a critical value creates an open task; the clinician acks it', async () => {
      const invId = await insertInvestigation(PATIENT_A_UID);
      const { result, alerts } = await recordManualResult({
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
      expect(result).toMatchObject({
        criticality_status: 'critical',
        facility_id: policyFixture.facilityId,
        threshold_policy_bundle_id: policyFixture.bundleId,
        threshold_policy_rule_id: policyFixture.policyRules.get(TEST_CODE),
        threshold_catalog_entry_id: policyFixture.catalogEntries.get(TEST_CODE),
      });
      expect(alerts.length).toBe(1);
      expect(alerts[0]).toMatchObject({
        threshold_policy_bundle_id: policyFixture.bundleId,
        threshold_policy_rule_id: policyFixture.policyRules.get(TEST_CODE),
        threshold_catalog_entry_id: policyFixture.catalogEntries.get(TEST_CODE),
      });
      originalAlertId = alerts[0].id;

      const tasks = await openTasksFor(resultId);
      expect(tasks.length).toBe(1);
      expect(tasks[0].status).toBe('open');
      expect(tasks[0].assigned_to_uid).toBe(DOCTOR_UID);
      originalTaskId = tasks[0].id;

      const acked = await labResults.acknowledgeAlert(alerts[0].id, {
        tenantId: TENANT,
        acknowledged_by: DOCTOR_UID,
        acknowledged_by_name: 'Reack Doctor [test]',
        actorRoles: ['DOCTOR'],
        actorRole: 'DOCTOR',
      });
      expect(acked.acknowledged_at).toBeTruthy();
      const acknowledgedTask = (await openTasksFor(resultId))
        .find((task) => task.id === originalTaskId);
      expect(acknowledgedTask).toMatchObject({
        status: 'in_progress',
        metadata: expect.objectContaining({ ack_contract_version: 2 }),
      });
    });

    it('rolls back supersession and SLA rearm when replacement task insertion fails', async () => {
      const beforeTasks = await openTasksFor(resultId);
      const beforeSla = await prisma.$queryRawUnsafe(
        `SELECT status, completed_at, metadata
           FROM workflow_sla_instances
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        TENANT,
        beforeTasks[0].workflow_sla_instance_id,
      );

      await prisma.$executeRawUnsafe(
        `CREATE FUNCTION "${FAIL_REOPEN_FUNCTION}"() RETURNS trigger
           LANGUAGE plpgsql AS $$
         BEGIN
           IF NEW.related_resource_type = 'lab_result'
              AND NEW.related_resource_id = '${resultId}' THEN
             RAISE EXCEPTION 'forced replacement task insert failure';
           END IF;
           RETURN NEW;
         END
         $$`,
      );
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER "${FAIL_REOPEN_TRIGGER}"
           BEFORE INSERT ON tasks
           FOR EACH ROW EXECUTE FUNCTION "${FAIL_REOPEN_FUNCTION}"()`,
      );

      let failed;
      try {
        failed = await ensureCriticalResultTaskOpen({
          tenantId: TENANT,
          patientUid: PATIENT_A_UID,
          source: 'lab_result',
          resourceType: 'lab_result',
          resourceId: resultId,
          severity: 'critical',
          orderingClinicianUid: DOCTOR_UID,
          reason: 'corrected_result',
          supersededByActorUid: DOCTOR_UID,
        });
      } finally {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${FAIL_REOPEN_TRIGGER}" ON tasks`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${FAIL_REOPEN_FUNCTION}"()`);
      }
      expect(failed).toMatchObject({ created: false });
      expect(failed.error).toMatch(/forced replacement task insert failure/i);

      const afterTasks = await openTasksFor(resultId);
      expect(afterTasks).toHaveLength(1);
      expect(afterTasks[0]).toMatchObject({ id: originalTaskId, status: 'in_progress' });
      const afterSla = await prisma.$queryRawUnsafe(
        `SELECT status, completed_at, metadata
           FROM workflow_sla_instances
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        TENANT,
        afterTasks[0].workflow_sla_instance_id,
      );
      expect(afterSla[0].status).toBe(beforeSla[0].status);
      expect(afterSla[0].completed_at?.toISOString()).toBe(beforeSla[0].completed_at?.toISOString());
      expect(afterSla[0].metadata).toMatchObject({
        completed_via: beforeSla[0].metadata.completed_via,
        completed_by_task: beforeSla[0].metadata.completed_by_task,
      });
      expect(afterSla[0].metadata).not.toHaveProperty('reopen_history');
    });

    it('corrected sign-off supersedes the acked task with a fresh, owned, unacknowledged one', async () => {
      await signOff([resultId], 'corrected', PATIENT_A_UID);

      const tasks = await openTasksFor(resultId);
      const fresh = tasks.filter((t) => t.status === 'open');
      expect(fresh.length).toBe(1);
      expect(fresh[0].id).not.toBe(originalTaskId);
      replacementTaskId = fresh[0].id;
      // Owned: assigned to the ordering clinician, not just a role bucket.
      expect(fresh[0].assigned_to_uid).toBe(DOCTOR_UID);
      // Unacknowledged: a brand-new ack window.
      expect(fresh[0].metadata?.acknowledged_at).toBeUndefined();
      // Reopen provenance points back at the superseded task.
      expect(fresh[0].metadata?.reopened_from_task_id).toBe(originalTaskId);

      const old = tasks.find((t) => t.id === originalTaskId);
      expect(old.status).toBe('completed');

      const currentAlerts = await prisma.$queryRawUnsafe(
        `SELECT id
           FROM lab_critical_alerts
          WHERE tenant_id = $1::uuid
            AND result_id = $2::int
            AND superseded_at IS NULL`,
        TENANT,
        resultId,
      );
      expect(currentAlerts).toHaveLength(1);
      replacementAlertId = currentAlerts[0].id;
      expect(replacementAlertId).not.toBe(originalAlertId);
    });

    it('restarts the critical_result_ack SLA clock for the corrected value', async () => {
      // due_at freshness is compared DB-side: raw timestamptz values
      // deserialize through the server TZ (IST on the QA box), so a JS
      // wall-clock comparison would shift by -5:30.
      const rows = await prisma.$queryRawUnsafe(
        `SELECT status, completed_at, (due_at > NOW()) AS due_in_future, metadata
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
      expect(rows[0].metadata).not.toHaveProperty('completed_via');
      expect(rows[0].metadata).not.toHaveProperty('completed_by_task');
      expect(rows[0].metadata).not.toHaveProperty('completed_by');
      expect(rows[0].metadata).not.toHaveProperty('acknowledged_by');
      expect(rows[0].metadata).not.toHaveProperty('completion_evidence');
      expect(rows[0].metadata).not.toHaveProperty('ack_contract_version');
      const receipt = rows[0].metadata?.reopen_history?.find(
        (entry) => entry.prior_completed_by_task === originalTaskId,
      );
      expect(receipt).toMatchObject({
        reopen_reason: 'lab_signoff_corrected',
        prior_status: 'completed',
        prior_completed_via: 'task_ack',
        prior_completed_by_task: originalTaskId,
        prior_ack_contract_version: 2,
      });
      expect(receipt.prior_started_at).toBeTruthy();
      expect(receipt.prior_due_at).toBeTruthy();
      expect(receipt.prior_completed_at).toBeTruthy();
      expect(receipt).toHaveProperty('prior_breached_at');
      expect(receipt).toHaveProperty('prior_escalated_at');

      const predecessorReceipts = await prisma.$queryRawUnsafe(
        `SELECT ack_contract_version,
                assert_lab_critical_alert_acknowledgement_receipt(
                  tenant_id,
                  alert_id,
                  FALSE
                ) AS receipt_valid
           FROM lab_critical_alert_acknowledgement_receipts
          WHERE tenant_id = $1::uuid
            AND alert_id = $2::int`,
        TENANT,
        originalAlertId,
      );
      expect(predecessorReceipts).toEqual([{
        ack_contract_version: 2,
        receipt_valid: true,
      }]);
    });

    it('acknowledges the replacement as a distinct v2 generation without erasing predecessor history', async () => {
      const acknowledged = await labResults.acknowledgeAlert(replacementAlertId, {
        tenantId: TENANT,
        acknowledged_by: DOCTOR_UID,
        acknowledged_by_name: 'Reack Doctor [test]',
        actorRoles: ['DOCTOR'],
        actorRole: 'DOCTOR',
      });
      expect(acknowledged.acknowledged_at).toBeTruthy();

      const rows = await prisma.$queryRawUnsafe(
        `SELECT task.status AS task_status,
                sla.status AS sla_status,
                sla.metadata,
                (SELECT COUNT(*)::int
                   FROM lab_critical_alert_acknowledgement_receipts AS receipt
                  WHERE receipt.tenant_id = task.tenant_id
                    AND receipt.result_id = $3::int) AS receipt_count,
                (SELECT bool_and(assert_lab_critical_alert_acknowledgement_receipt(
                                      receipt.tenant_id,
                                      receipt.alert_id,
                                      FALSE
                                    ))
                   FROM lab_critical_alert_acknowledgement_receipts AS receipt
                  WHERE receipt.tenant_id = task.tenant_id
                    AND receipt.result_id = $3::int) AS receipts_valid
           FROM tasks AS task
           JOIN workflow_sla_instances AS sla
             ON sla.tenant_id = task.tenant_id
            AND sla.id = task.workflow_sla_instance_id
          WHERE task.tenant_id = $1::uuid
            AND task.id = $2::int`,
        TENANT,
        replacementTaskId,
        resultId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        task_status: 'in_progress',
        sla_status: 'completed',
        receipt_count: 2,
        receipts_valid: true,
      });
      expect(rows[0].metadata.ack_contract_version).toBe(2);
      const prior = rows[0].metadata.reopen_history.find(
        (entry) => entry.prior_completed_by_task === originalTaskId,
      );
      expect(prior.prior_ack_contract_version).toBe(2);
    });

    it('does not announce a corrected result before its release policy permits visibility', async () => {
      const notifs = await prisma.$queryRawUnsafe(
        `SELECT title, body, data FROM notifications
          WHERE uid = $1::uuid AND type = 'lab_result_corrected'`,
        PATIENT_A_UID,
      );
      expect(notifs).toHaveLength(0);
    });
  });

  it('rearms from an immutable v2 predecessor receipt when mutable SLA version metadata is absent', async () => {
    const invId = await insertInvestigation(PATIENT_A_UID);
    const { result, alerts } = await recordManualResult({
      tenantId: TENANT,
      performed_by: DOCTOR_UID,
      performed_by_role: 'DOCTOR',
      result: {
        patient_uid: PATIENT_A_UID,
        investigation_id: invId,
        test_code: TEST_CODE,
        test_name: 'Potassium [test]',
        value_text: '7.3',
        unit: 'mmol/L',
        status: 'preliminary',
      },
    });
    resultIds.push(result.id);
    expect(alerts).toHaveLength(1);

    const predecessorAlertId = alerts[0].id;
    const predecessorTask = (await openTasksFor(result.id))[0];
    await labResults.acknowledgeAlert(predecessorAlertId, {
      tenantId: TENANT,
      acknowledged_by: DOCTOR_UID,
      acknowledged_by_name: 'Reack Doctor [test]',
      actorRoles: ['DOCTOR'],
      actorRole: 'DOCTOR',
    });

    // Simulate a rolling-version/stale mutable SLA projection. The immutable
    // receipt and all exact source evidence stay intact; only the redundant
    // top-level version marker is absent.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      await tx.$executeRawUnsafe(
        `UPDATE workflow_sla_instances
            SET metadata = metadata - 'ack_contract_version'
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid`,
        TENANT,
        predecessorTask.workflow_sla_instance_id,
      );
    });

    const predecessorProof = await prisma.$queryRawUnsafe(
      `SELECT assert_lab_critical_alert_acknowledgement_receipt(
                tenant_id,
                alert_id,
                FALSE
              ) AS receipt_valid
         FROM lab_critical_alert_acknowledgement_receipts
        WHERE tenant_id = $1::uuid
          AND alert_id = $2::int`,
      TENANT,
      predecessorAlertId,
    );
    expect(predecessorProof).toEqual([{ receipt_valid: true }]);

    await signOff([result.id], 'amended', PATIENT_A_UID);

    const tasks = await openTasksFor(result.id);
    const successorTask = tasks.find((task) => task.status === 'open');
    expect(successorTask).toMatchObject({
      metadata: expect.objectContaining({
        reopened_from_task_id: predecessorTask.id,
      }),
    });
    const rearmedRows = await prisma.$queryRawUnsafe(
      `SELECT status, completed_at, metadata
         FROM workflow_sla_instances
        WHERE tenant_id = $1::uuid
          AND id = $2::uuid`,
      TENANT,
      predecessorTask.workflow_sla_instance_id,
    );
    expect(rearmedRows[0]).toMatchObject({ status: 'active', completed_at: null });
    expect(rearmedRows[0].metadata).not.toHaveProperty('ack_contract_version');
    const prior = rearmedRows[0].metadata.reopen_history.find(
      (entry) => entry.prior_completed_by_task === predecessorTask.id,
    );
    expect(prior).toHaveProperty('prior_ack_contract_version');
    expect(prior.prior_ack_contract_version).toBeNull();

    const successorAlerts = await prisma.$queryRawUnsafe(
      `SELECT id
         FROM lab_critical_alerts
        WHERE tenant_id = $1::uuid
          AND result_id = $2::int
          AND superseded_at IS NULL`,
      TENANT,
      result.id,
    );
    expect(successorAlerts).toHaveLength(1);
    await labResults.acknowledgeAlert(successorAlerts[0].id, {
      tenantId: TENANT,
      acknowledged_by: DOCTOR_UID,
      acknowledged_by_name: 'Reack Doctor [test]',
      actorRoles: ['DOCTOR'],
      actorRole: 'DOCTOR',
    });

    const closedRows = await prisma.$queryRawUnsafe(
      `SELECT sla.status, sla.metadata,
              COUNT(receipt.alert_id)::int AS receipt_count,
              bool_and(assert_lab_critical_alert_acknowledgement_receipt(
                         receipt.tenant_id,
                         receipt.alert_id,
                         FALSE
                       )) AS receipts_valid
         FROM workflow_sla_instances AS sla
         JOIN lab_critical_alert_acknowledgement_receipts AS receipt
           ON receipt.tenant_id = sla.tenant_id
          AND receipt.workflow_sla_instance_id = sla.id
        WHERE sla.tenant_id = $1::uuid
          AND sla.id = $2::uuid
        GROUP BY sla.status, sla.metadata`,
      TENANT,
      predecessorTask.workflow_sla_instance_id,
    );
    expect(closedRows[0]).toMatchObject({
      status: 'completed',
      receipt_count: 2,
      receipts_valid: true,
    });
    expect(closedRows[0].metadata.ack_contract_version).toBe(2);
    const preservedPrior = closedRows[0].metadata.reopen_history.find(
      (entry) => entry.prior_completed_by_task === predecessorTask.id,
    );
    expect(preservedPrior).toHaveProperty('prior_ack_contract_version');
    expect(preservedPrior.prior_ack_contract_version).toBeNull();
  }, 45_000);

  describe('corrected sign-off after the original task was blocked', () => {
    it('supersedes the blocked obligation without cancelling or stranding it', async () => {
      const invId = await insertInvestigation(PATIENT_A_UID);
      const { result } = await recordManualResult({
        tenantId: TENANT,
        performed_by: DOCTOR_UID,
        performed_by_role: 'DOCTOR',
        result: {
          patient_uid: PATIENT_A_UID,
          investigation_id: invId,
          test_code: TEST_CODE,
          test_name: 'Potassium [test]',
          value_text: '7.4',
          unit: 'mmol/L',
          status: 'preliminary',
        },
      });
      resultIds.push(result.id);
      const before = await openTasksFor(result.id);
      expect(before).toHaveLength(1);
      const originalTaskId = before[0].id;
      await taskService.transitionTask({
        tenantId: TENANT,
        id: originalTaskId,
        nextStatus: 'blocked',
        actorUid: DOCTOR_UID,
      });

      await signOff([result.id], 'corrected', PATIENT_A_UID);

      const after = await openTasksFor(result.id);
      const original = after.find((task) => task.id === originalTaskId);
      const fresh = after.find((task) => task.id !== originalTaskId && task.status === 'open');
      expect(original?.status).toBe('completed');
      expect(fresh).toMatchObject({
        status: 'open',
        assigned_to_uid: DOCTOR_UID,
        metadata: { reopened_from_task_id: originalTaskId },
      });

      const slaRows = await prisma.$queryRawUnsafe(
        `SELECT status, completed_at, metadata
           FROM workflow_sla_instances
          WHERE tenant_id = $1::uuid
            AND rule_code = 'critical_result_ack'
            AND source_table = 'lab_result'
            AND source_id = $2
          LIMIT 1`,
        TENANT,
        String(result.id),
      );
      expect(slaRows[0].status).toBe('active');
      expect(slaRows[0].completed_at).toBeNull();
      expect(slaRows[0].metadata?.reopen_history).toEqual(expect.arrayContaining([
        expect.objectContaining({
          reopen_reason: 'lab_signoff_corrected',
          prior_completed_via: 'task_completion',
          prior_completed_by_task: originalTaskId,
        }),
      ]));
    });
  });

  describe('corrected-result reopen concurrent with acknowledgement', () => {
    it('re-reads the task under lock when acknowledgement commits first', async () => {
      const invId = await insertInvestigation(PATIENT_A_UID);
      const { result, alerts } = await recordManualResult({
        tenantId: TENANT,
        performed_by: DOCTOR_UID,
        performed_by_role: 'DOCTOR',
        result: {
          patient_uid: PATIENT_A_UID,
          investigation_id: invId,
          test_code: TEST_CODE,
          test_name: 'Potassium [test]',
          value_text: '7.6',
          unit: 'mmol/L',
          status: 'preliminary',
        },
      });
      resultIds.push(result.id);
      expect(alerts).toHaveLength(1);
      const before = await openTasksFor(result.id);
      expect(before).toHaveLength(1);
      const original = before[0];

      const blocker = new Client({ connectionString: DATABASE_URL });
      await blocker.connect();
      let acknowledgePromise;
      let reopenPromise;
      let committed = false;
      try {
        await blocker.query('BEGIN');
        const pidRows = await blocker.query('SELECT pg_backend_pid() AS pid');
        const blockerPid = pidRows.rows[0].pid;
        await blocker.query(
          `SELECT pg_advisory_xact_lock(
                    hashtextextended(
                      jsonb_build_array($1::text, 'lab_result', $2::text)::text,
                      0
                    )
                  )`,
          [TENANT, String(result.id)],
        );

        acknowledgePromise = labResults.acknowledgeAlert(alerts[0].id, {
          tenantId: TENANT,
          acknowledged_by: DOCTOR_UID,
          acknowledged_by_name: 'Reack Doctor [test]',
          actorRoles: ['DOCTOR'],
          actorRole: 'DOCTOR',
        });
        await waitForResourceLockWait(blocker, blockerPid, 1);

        reopenPromise = signOff([result.id], 'corrected', PATIENT_A_UID);
        await blocker.query('COMMIT');
        committed = true;

        const acknowledged = await acknowledgePromise;
        expect(acknowledged.acknowledged_at).toBeTruthy();
        await reopenPromise;
      } finally {
        if (!committed) await blocker.query('ROLLBACK').catch(() => {});
        if (acknowledgePromise && !committed) await acknowledgePromise.catch(() => {});
        if (reopenPromise && !committed) await reopenPromise.catch(() => {});
        await blocker.end();
      }

      const after = await openTasksFor(result.id);
      expect(after.find((task) => task.id === original.id)?.status).toBe('completed');
      expect(after.some((task) => task.id !== original.id && task.status === 'open')).toBe(true);
      const slaRows = await prisma.$queryRawUnsafe(
        `SELECT status, completed_at
           FROM workflow_sla_instances
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        TENANT,
        original.workflow_sla_instance_id,
      );
      expect(slaRows[0]).toMatchObject({ status: 'active', completed_at: null });
      const receipts = await prisma.$queryRawUnsafe(
        `SELECT assert_lab_critical_alert_acknowledgement_receipt(
                  tenant_id,
                  alert_id,
                  FALSE
                ) AS receipt_valid
           FROM lab_critical_alert_acknowledgement_receipts
          WHERE tenant_id = $1::uuid
            AND alert_id = $2::int`,
        TENANT,
        alerts[0].id,
      );
      expect(receipts).toEqual([{ receipt_valid: true }]);
    }, 30_000);
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
    it('closes a post-migration old-writer window with a fresh bound task after replica drain', async () => {
      const invId = await insertInvestigation(PATIENT_B_UID);
      const { result, alerts } = await recordManualResult({
        tenantId: TENANT,
        performed_by: DOCTOR_UID,
        performed_by_role: 'DOCTOR',
        result: {
          patient_uid: PATIENT_B_UID,
          investigation_id: invId,
          test_code: TEST_CODE,
          test_name: 'Potassium [test]',
          value_text: '8.0',
          unit: 'mmol/L',
          status: 'preliminary',
        },
      });
      resultIds.push(result.id);
      const staleAlertId = alerts[0].id;
      const [originalTask] = await openTasksFor(result.id);

      const signoffs = await prisma.$queryRawUnsafe(
        `INSERT INTO lab_pathologist_signoffs
           (tenant_id, patient_uid, result_ids, signed_off_by, decision, comments)
         VALUES ($1::uuid, $2::uuid, ARRAY[$3::int], $4::uuid, 'amended',
                 'simulated pre-581 replica sign-off after migration')
         RETURNING id`,
        TENANT,
        PATIENT_B_UID,
        result.id,
        PATHOLOGIST_UID,
      );
      const signoffId = signoffs[0].id;

      // Old PR #587 semantics reused a still-open window and therefore could
      // not create a 581 alert generation for this just-committed sign-off.
      const oldWriter = await ensureCriticalResultTaskOpen({
        tenantId: TENANT,
        patientUid: PATIENT_B_UID,
        source: 'lab_result',
        resourceType: 'lab_result',
        resourceId: result.id,
        severity: 'critical',
        orderingClinicianUid: DOCTOR_UID,
        reason: 'lab_signoff_amended',
        supersededByActorUid: PATHOLOGIST_UID,
      });
      expect(oldWriter).toMatchObject({
        created: false,
        reopened: false,
        taskId: originalTask.id,
      });
      const pending = await listLateLegacyCorrectiveSignoffs({
        tenantId: TENANT,
        limit: 20,
      });
      expect(pending).toEqual(expect.arrayContaining([
        expect.objectContaining({ result_id: result.id, signoff_id: signoffId }),
      ]));

      await expect(reconcileLateLegacyLabCriticalAlerts({
        tenantId: TENANT,
        batchSize: 20,
      })).resolves.toMatchObject({ reconciled: 1 });

      const generations = await prisma.$queryRawUnsafe(
        `SELECT id, superseded_at, superseded_by_alert_id,
                generation_signoff_id, acknowledgement_task_id,
                generation_metadata
           FROM lab_critical_alerts
          WHERE tenant_id = $1::uuid AND result_id = $2::int
          ORDER BY id`,
        TENANT,
        result.id,
      );
      expect(generations).toHaveLength(2);
      const currentAlert = generations[1];
      expect(generations[0]).toMatchObject({
        id: staleAlertId,
        superseded_by_alert_id: currentAlert.id,
      });
      expect(generations[0].superseded_at).toBeTruthy();
      expect(currentAlert).toMatchObject({
        generation_signoff_id: signoffId,
        generation_metadata: {
          kind: 'corrected_result_generation',
          source: 'lab_post_drain_reconciliation',
        },
      });
      expect(currentAlert.acknowledgement_task_id).not.toBe(originalTask.id);
      const tasks = await openTasksFor(result.id);
      expect(tasks.find((task) => task.id === originalTask.id)?.status).toBe('completed');
      expect(tasks.find((task) => task.id === currentAlert.acknowledgement_task_id)).toMatchObject({
        status: 'open',
        assigned_to_uid: DOCTOR_UID,
      });
      await expect(listLateLegacyCorrectiveSignoffs({
        tenantId: TENANT,
        limit: 20,
      })).resolves.toHaveLength(0);

      await expect(labResults.acknowledgeAlert(staleAlertId, {
        tenantId: TENANT,
        acknowledged_by: DOCTOR_UID,
        acknowledged_by_name: 'Reack Doctor [test]',
        actorRoles: ['DOCTOR'],
        actorRole: 'DOCTOR',
        read_back_method: 'phone',
      })).rejects.toMatchObject({ statusCode: 403 });
      await expect(labResults.acknowledgeAlert(currentAlert.id, {
        tenantId: TENANT,
        acknowledged_by: DOCTOR_UID,
        acknowledged_by_name: 'Reack Doctor [test]',
        actorRoles: ['DOCTOR'],
        actorRole: 'DOCTOR',
        read_back_method: 'phone',
      })).resolves.toMatchObject({ id: currentAlert.id });
    }, 30_000);

    it('materializes a missed critical generation when an old writer committed no alert at all', async () => {
      const invId = await insertInvestigation(PATIENT_B_UID);
      const resultId = await insertRawResult(PATIENT_B_UID, invId, '8.6');
      const signoffId = await insertLegacyCorrectiveSignoff(resultId, PATIENT_B_UID);

      const before = await prisma.$queryRawUnsafe(
        `SELECT id FROM lab_critical_alerts
          WHERE tenant_id = $1::uuid AND result_id = $2::int`,
        TENANT,
        resultId,
      );
      expect(before).toHaveLength(0);
      await expect(listLateLegacyCorrectiveSignoffs({
        tenantId: TENANT,
        limit: 50,
      })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ result_id: resultId, signoff_id: signoffId }),
      ]));

      await expect(reconcileLateLegacyLabCriticalAlerts({
        tenantId: TENANT,
        batchSize: 50,
      })).resolves.toMatchObject({ alertGenerations: 1 });
      const alerts = await prisma.$queryRawUnsafe(
        `SELECT id, generation_signoff_id, acknowledgement_task_id
           FROM lab_critical_alerts
          WHERE tenant_id = $1::uuid AND result_id = $2::int`,
        TENANT,
        resultId,
      );
      expect(alerts).toEqual([
        expect.objectContaining({ generation_signoff_id: signoffId }),
      ]);
      expect(await openTasksFor(resultId)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: alerts[0].acknowledgement_task_id,
          status: 'open',
          assigned_to_uid: DOCTOR_UID,
        }),
      ]));
    }, 30_000);

    it('persists an immutable threshold snapshot for a normal zero-alert correction', async () => {
      const invId = await insertInvestigation(PATIENT_B_UID);
      const resultId = await insertRawResult(PATIENT_B_UID, invId, '4.1');
      const signoffId = await insertLegacyCorrectiveSignoff(resultId, PATIENT_B_UID);

      await expect(reconcileLateLegacyLabCriticalAlerts({
        tenantId: TENANT,
        batchSize: 50,
      })).resolves.toMatchObject({ receipts: 1 });
      const receipts = await prisma.$queryRawUnsafe(
        `SELECT id, outcome, result_value_text, result_value_numeric, result_unit,
                evaluated_value, threshold_id, threshold_test_code,
                threshold_low, threshold_high, threshold_unit,
                threshold_applies_to, threshold_policy_bundle_id,
                threshold_policy_rule_id, threshold_catalog_entry_id,
                successor_alert_id, successor_receipt_id
           FROM lab_critical_alert_reconciliation_receipts
          WHERE tenant_id = $1::uuid
            AND result_id = $2::int
            AND signoff_id = $3::int`,
        TENANT,
        resultId,
        signoffId,
      );
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        outcome: 'within_active_critical_thresholds',
        result_value_text: '4.1',
        result_unit: 'mmol/L',
        threshold_test_code: TEST_CODE,
        threshold_unit: 'mmol/l',
        threshold_applies_to: 'all',
        threshold_id: null,
        threshold_policy_bundle_id: policyFixture.bundleId,
        threshold_policy_rule_id: policyFixture.policyRules.get(TEST_CODE),
        threshold_catalog_entry_id: policyFixture.catalogEntries.get(TEST_CODE),
        successor_alert_id: null,
        successor_receipt_id: null,
      });
      expect(Number(receipts[0].result_value_numeric)).toBe(4.1);
      expect(Number(receipts[0].evaluated_value)).toBe(4.1);
      expect(Number(receipts[0].threshold_low)).toBe(2.5);
      expect(Number(receipts[0].threshold_high)).toBe(6);
      await expect(prisma.$executeRawUnsafe(
        `UPDATE lab_critical_alert_reconciliation_receipts
            SET source = 'tampered'
          WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        TENANT,
        receipts[0].id,
      )).rejects.toThrow(/append-only/i);
      await expect(reconcileLateLegacyLabCriticalAlerts({
        tenantId: TENANT,
        batchSize: 50,
      })).resolves.toMatchObject({ observed: 0, reconciled: 0 });
    }, 30_000);

    it('records an older missed S1 behind a correctly represented S2 without inventing an ACK', async () => {
      const invId = await insertInvestigation(PATIENT_B_UID);
      const { result } = await recordManualResult({
        tenantId: TENANT,
        performed_by: DOCTOR_UID,
        performed_by_role: 'DOCTOR',
        result: {
          patient_uid: PATIENT_B_UID,
          investigation_id: invId,
          test_code: TEST_CODE,
          test_name: 'Potassium [test]',
          value_text: '8.7',
          unit: 'mmol/L',
          status: 'preliminary',
        },
      });
      resultIds.push(result.id);
      const s1Id = await insertLegacyCorrectiveSignoff(result.id, PATIENT_B_UID, 'amended');
      await signOff([result.id], 'corrected', PATIENT_B_UID);

      const representedS2 = await prisma.$queryRawUnsafe(
        `SELECT id, generation_signoff_id, acknowledgement_task_id, acknowledged_at
           FROM lab_critical_alerts
          WHERE tenant_id = $1::uuid
            AND result_id = $2::int
            AND superseded_at IS NULL`,
        TENANT,
        result.id,
      );
      expect(representedS2).toHaveLength(1);
      expect(representedS2[0].generation_signoff_id).toBeGreaterThan(s1Id);
      expect(representedS2[0].acknowledged_at).toBeNull();

      await expect(reconcileLateLegacyLabCriticalAlerts({
        tenantId: TENANT,
        batchSize: 50,
      })).resolves.toMatchObject({ historicalGaps: 1 });
      const s1Receipt = await prisma.$queryRawUnsafe(
        `SELECT outcome, successor_signoff_id, successor_alert_id,
                successor_receipt_id
           FROM lab_critical_alert_reconciliation_receipts
          WHERE tenant_id = $1::uuid
            AND result_id = $2::int
            AND signoff_id = $3::int`,
        TENANT,
        result.id,
        s1Id,
      );
      expect(s1Receipt).toEqual([
        expect.objectContaining({
          outcome: 'superseded_by_later_generation',
          successor_signoff_id: representedS2[0].generation_signoff_id,
          successor_alert_id: representedS2[0].id,
          successor_receipt_id: null,
        }),
      ]);
      const successorTask = (await openTasksFor(result.id)).find(
        (task) => task.id === representedS2[0].acknowledgement_task_id,
      );
      expect(successorTask).toMatchObject({ status: 'open' });
      const successorSla = await prisma.$queryRawUnsafe(
        `SELECT status, completed_at
           FROM workflow_sla_instances
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        TENANT,
        successorTask.workflow_sla_instance_id,
      );
      expect(successorSla[0]).toMatchObject({ status: 'active', completed_at: null });
    }, 30_000);

    it('fails closeout on a legacy sign-off whose patient does not own the result', async () => {
      const invId = await insertInvestigation(PATIENT_B_UID);
      const resultId = await insertRawResult(PATIENT_B_UID, invId, '4.3');
      const mismatchedSignoffId = await insertLegacyCorrectiveSignoff(
        resultId,
        PATIENT_C_UID,
      );
      try {
        await expect(reconcileLateLegacyLabCriticalAlerts({
          tenantId: TENANT,
          batchSize: 50,
        })).rejects.toThrow(/patient binding mismatch/i);
        const receipts = await prisma.$queryRawUnsafe(
          `SELECT id FROM lab_critical_alert_reconciliation_receipts
            WHERE tenant_id = $1::uuid
              AND result_id = $2::int
              AND signoff_id = $3::int`,
          TENANT,
          resultId,
          mismatchedSignoffId,
        );
        expect(receipts).toHaveLength(0);
      } finally {
        await prisma.$executeRawUnsafe(
          `DELETE FROM lab_pathologist_signoffs
            WHERE tenant_id = $1::uuid AND id = $2::int`,
          TENANT,
          mismatchedSignoffId,
        );
      }
    });

    it('prohibits a non-ACK in-progress transition and retains the exact open window', async () => {
      const invId = await insertInvestigation(PATIENT_B_UID);
      const { result, alerts } = await recordManualResult({
        tenantId: TENANT,
        performed_by: DOCTOR_UID,
        performed_by_role: 'DOCTOR',
        result: {
          patient_uid: PATIENT_B_UID,
          investigation_id: invId,
          test_code: TEST_CODE,
          test_name: 'Potassium [test]',
          value_text: '8.8',
          unit: 'mmol/L',
          status: 'preliminary',
        },
      });
      resultIds.push(result.id);
      const taskId = alerts[0].acknowledgement_task_id;
      await expect(taskService.transitionTask({
        tenantId: TENANT,
        id: taskId,
        nextStatus: 'in_progress',
        actorUid: DOCTOR_UID,
      })).rejects.toMatchObject({ code: 'TASK_ACKNOWLEDGEMENT_REQUIRED' });

      await expect(materializeLabCriticalAlertGeneration({
        tenantId: TENANT,
        resultId: result.id,
        expectedPatientUid: PATIENT_B_UID,
        evaluateCriticality: ({ tx, result: currentResult }) => evaluateCriticalThreshold({
          client: tx,
          tenantId: TENANT,
          result: currentResult,
        }),
      })).resolves.toMatchObject({
        created: false,
        skippedReason: 'alert_generation_already_current',
        task: { taskId },
      });
      const alertRows = await prisma.$queryRawUnsafe(
        `SELECT id, acknowledged_at FROM lab_critical_alerts
          WHERE tenant_id = $1::uuid AND result_id = $2::int`,
        TENANT,
        result.id,
      );
      expect(alertRows).toEqual([
        expect.objectContaining({ id: alerts[0].id, acknowledged_at: null }),
      ]);
      expect((await openTasksFor(result.id)).find((task) => task.id === taskId)).toMatchObject({
        status: 'open',
      });
    }, 30_000);

    it('stores the raw converted analyte value/unit and the evaluated threshold value separately', async () => {
      const invId = await insertInvestigation(PATIENT_B_UID);
      const { result, alerts } = await recordManualResult({
        tenantId: TENANT,
        performed_by: DOCTOR_UID,
        performed_by_role: 'DOCTOR',
        result: {
          patient_uid: PATIENT_B_UID,
          investigation_id: invId,
          test_code: CONVERTED_TEST_CODE,
          test_name: 'White blood cell count [test]',
          value_text: '1000',
          unit: '/uL',
          status: 'preliminary',
        },
      });
      resultIds.push(result.id);
      expect(result).toMatchObject({
        criticality_status: 'critical',
        facility_id: policyFixture.facilityId,
        threshold_policy_bundle_id: policyFixture.bundleId,
        threshold_policy_rule_id: policyFixture.policyRules.get(CONVERTED_TEST_CODE),
        threshold_catalog_entry_id: policyFixture.catalogEntries.get(CONVERTED_TEST_CODE),
      });
      expect(alerts).toHaveLength(1);
      const rows = await prisma.$queryRawUnsafe(
        `SELECT value_numeric, unit, generation_metadata
           FROM lab_critical_alerts
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        TENANT,
        alerts[0].id,
      );
      expect(Number(rows[0].value_numeric)).toBe(1000);
      expect(rows[0].unit).toBe('/uL');
      expect(rows[0].generation_metadata).toMatchObject({
        active_threshold_test_code: CONVERTED_TEST_CODE,
        active_threshold_unit: '10^3/ul',
        threshold_evaluated_value: 1,
        threshold_value_conversion: 'per_microliter_to_thousands_per_microliter',
      });
    }, 30_000);

    it('supersedes an overdue task with a distinct fresh acknowledgement window', async () => {
      const invId = await insertInvestigation(PATIENT_B_UID);
      const { result } = await recordManualResult({
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
      expect(after).toHaveLength(2);
      expect(after.find((task) => task.id === before[0].id)?.status).toBe('completed');
      const fresh = after.find((task) => task.id !== before[0].id);
      expect(fresh).toMatchObject({ status: 'open' });
      expect(fresh.metadata?.acknowledged_at).toBeUndefined();
    });

    it('binds acknowledgement to the fresh corrected alert generation', async () => {
      const invId = await insertInvestigation(PATIENT_B_UID);
      const { result, alerts: originalAlerts } = await recordManualResult({
        tenantId: TENANT,
        performed_by: DOCTOR_UID,
        performed_by_role: 'DOCTOR',
        result: {
          patient_uid: PATIENT_B_UID,
          investigation_id: invId,
          test_code: TEST_CODE,
          test_name: 'Potassium [test]',
          value_text: '8.1',
          unit: 'mmol/L',
          status: 'preliminary',
        },
      });
      resultIds.push(result.id);
      expect(originalAlerts).toHaveLength(1);
      const staleAlertId = originalAlerts[0].id;
      const before = await openTasksFor(result.id);
      expect(before).toHaveLength(1);

      await signOff([result.id], 'corrected', PATIENT_B_UID);

      const generations = await prisma.$queryRawUnsafe(
        `SELECT id, acknowledged_at, superseded_at, superseded_by_alert_id,
                generation_signoff_id, acknowledgement_task_id,
                generation_metadata
           FROM lab_critical_alerts
          WHERE tenant_id = $1::uuid
            AND result_id = $2::int
          ORDER BY id ASC`,
        TENANT,
        result.id,
      );
      expect(generations).toHaveLength(2);
      expect(generations[0]).toMatchObject({
        id: staleAlertId,
        acknowledged_at: null,
        superseded_by_alert_id: generations[1].id,
      });
      expect(generations[0].superseded_at).toBeTruthy();
      const currentAlert = generations[1];
      expect(currentAlert.id).toBeGreaterThan(staleAlertId);
      expect(currentAlert.generation_metadata).toMatchObject({
        kind: 'corrected_result_generation',
        decision: 'corrected',
        supersedes_alert_id: staleAlertId,
        acknowledgement_task_id: currentAlert.acknowledgement_task_id,
      });
      expect(currentAlert.acknowledgement_task_id).not.toBe(before[0].id);
      const visibleOpenGenerations = (await labResults.listOpenCriticalAlerts({
        tenantId: TENANT,
        limit: 200,
      })).filter((alert) => alert.result_id === result.id);
      expect(visibleOpenGenerations).toEqual([
        expect.objectContaining({ id: currentAlert.id }),
      ]);

      await expect(labResults.acknowledgeAlert(staleAlertId, {
        tenantId: TENANT,
        acknowledged_by: DOCTOR_UID,
        acknowledged_by_name: 'Reack Doctor [test]',
        actorRoles: ['DOCTOR'],
        actorRole: 'DOCTOR',
        read_back_method: 'phone',
      })).rejects.toMatchObject({
        statusCode: 403,
        message: 'Not authorized to acknowledge this critical alert',
      });

      const afterStaleAttempt = await openTasksFor(result.id);
      expect(afterStaleAttempt).toHaveLength(2);
      expect(afterStaleAttempt.find((task) => task.id === before[0].id)?.status).toBe('completed');
      const currentTask = afterStaleAttempt.find(
        (task) => task.id === currentAlert.acknowledgement_task_id,
      );
      expect(currentTask).toMatchObject({ status: 'open' });
      expect(currentTask.metadata).not.toHaveProperty('acknowledged_at');
      const activeSla = await prisma.$queryRawUnsafe(
        `SELECT status, completed_at
           FROM workflow_sla_instances
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid`,
        TENANT,
        currentTask.workflow_sla_instance_id,
      );
      expect(activeSla[0]).toMatchObject({ status: 'active', completed_at: null });

      const acknowledged = await labResults.acknowledgeAlert(currentAlert.id, {
        tenantId: TENANT,
        acknowledged_by: DOCTOR_UID,
        acknowledged_by_name: 'Reack Doctor [test]',
        actorRoles: ['DOCTOR'],
        actorRole: 'DOCTOR',
        read_back_method: 'phone',
      });
      expect(acknowledged).toMatchObject({ id: currentAlert.id, acknowledged_by: DOCTOR_UID });

      const afterCurrentAck = await openTasksFor(result.id);
      const acknowledgedTask = afterCurrentAck.find(
        (task) => task.id === currentAlert.acknowledgement_task_id,
      );
      expect(acknowledgedTask.status).toBe('in_progress');
      expect(acknowledgedTask.metadata).toMatchObject({
        acknowledged_by: DOCTOR_UID,
        acknowledged_via: 'assignee',
      });
      const completedSla = await prisma.$queryRawUnsafe(
        `SELECT status, completed_at
           FROM workflow_sla_instances
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid`,
        TENANT,
        acknowledgedTask.workflow_sla_instance_id,
      );
      expect(completedSla[0].status).toBe('completed');
      expect(completedSla[0].completed_at).toBeTruthy();
    }, 30_000);

    it('hands a high-to-noncritical correction to its immutable diagnostic generation', async () => {
      const invId = await insertInvestigation(PATIENT_B_UID);
      const { result, alerts } = await recordManualResult({
        tenantId: TENANT,
        performed_by: DOCTOR_UID,
        performed_by_role: 'DOCTOR',
        result: {
          patient_uid: PATIENT_B_UID,
          investigation_id: invId,
          test_code: TEST_CODE,
          test_name: 'Potassium [test]',
          value_text: '8.2',
          unit: 'mmol/L',
          status: 'preliminary',
        },
      });
      resultIds.push(result.id);
      expect(alerts[0].threshold_breached).toBe('high');
      await prisma.$executeRawUnsafe(
        `UPDATE lab_results
            SET value_text = '4.0', value_numeric = 4.0, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        TENANT,
        result.id,
      );

      await signOff([result.id], 'corrected', PATIENT_B_UID);

      const currentRows = await prisma.$queryRawUnsafe(
        `SELECT alert.id, alert.value_text, alert.value_numeric,
                alert.threshold_breached, alert.threshold_value,
                alert.superseded_at,
                alert.superseded_by_diagnostic_generation_id,
                generation.classification AS diagnostic_classification
           FROM lab_critical_alerts AS alert
           JOIN diagnostic_result_generations AS generation
             ON generation.tenant_id = alert.tenant_id
            AND generation.id = alert.superseded_by_diagnostic_generation_id
          WHERE alert.tenant_id = $1::uuid AND alert.result_id = $2::int
          ORDER BY alert.id DESC
          LIMIT 1`,
        TENANT,
        result.id,
      );
      expect(currentRows[0]).toMatchObject({
        value_text: '8.2',
        threshold_breached: 'high',
        diagnostic_classification: 'normal',
      });
      expect(Number(currentRows[0].value_numeric)).toBe(8.2);
      expect(currentRows[0].superseded_at).toBeTruthy();
      expect(currentRows[0].superseded_by_diagnostic_generation_id).toBeTruthy();

      const tasks = await openTasksFor(result.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        status: 'completed',
        metadata: {
          supersession_reason: 'diagnostic_generation_noncritical_correction',
          superseded_by_diagnostic_generation_id:
            currentRows[0].superseded_by_diagnostic_generation_id,
        },
      });
      const slaRows = await prisma.$queryRawUnsafe(
        `SELECT status, completed_at, metadata
           FROM workflow_sla_instances
          WHERE tenant_id = $1::uuid
            AND id = $2::uuid`,
        TENANT,
        tasks[0].workflow_sla_instance_id,
      );
      expect(slaRows[0]).toMatchObject({
        status: 'completed',
        metadata: {
          supersession_reason: 'diagnostic_generation_noncritical_correction',
          superseded_by_diagnostic_generation_id:
            currentRows[0].superseded_by_diagnostic_generation_id,
        },
      });
      expect(slaRows[0].completed_at).toBeTruthy();
      const receipts = await prisma.$queryRawUnsafe(
        `SELECT outcome, source
           FROM lab_critical_alert_reconciliation_receipts
          WHERE tenant_id = $1::uuid
            AND result_id = $2::integer
          ORDER BY id DESC
          LIMIT 1`,
        TENANT,
        result.id,
      );
      expect(receipts).toEqual([{
        outcome: 'within_active_critical_thresholds',
        source: 'diagnostic_generation_supersession',
      }]);
    });

    it('re-evaluates a high-to-low correction against the current low threshold', async () => {
      const invId = await insertInvestigation(PATIENT_B_UID);
      const { result, alerts } = await recordManualResult({
        tenantId: TENANT,
        performed_by: DOCTOR_UID,
        performed_by_role: 'DOCTOR',
        result: {
          patient_uid: PATIENT_B_UID,
          investigation_id: invId,
          test_code: TEST_CODE,
          test_name: 'Potassium [test]',
          value_text: '8.4',
          unit: 'mmol/L',
          status: 'preliminary',
        },
      });
      resultIds.push(result.id);
      expect(alerts[0].threshold_breached).toBe('high');
      await prisma.$executeRawUnsafe(
        `UPDATE lab_results
            SET value_text = '1.9', value_numeric = 1.9, updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        TENANT,
        result.id,
      );

      await signOff([result.id], 'corrected', PATIENT_B_UID);

      const currentRows = await prisma.$queryRawUnsafe(
        `SELECT value_text, value_numeric, threshold_breached, threshold_value,
                generation_metadata
           FROM lab_critical_alerts
          WHERE tenant_id = $1::uuid AND result_id = $2::int
          ORDER BY id DESC
          LIMIT 1`,
        TENANT,
        result.id,
      );
      expect(currentRows[0]).toMatchObject({
        value_text: '1.9',
        threshold_breached: 'low',
      });
      expect(Number(currentRows[0].value_numeric)).toBe(1.9);
      expect(Number(currentRows[0].threshold_value)).toBe(2.5);
      expect(currentRows[0].generation_metadata).toMatchObject({
        corrected_state: 'critical',
        prior_threshold_breached: 'high',
        active_threshold_low: 2.5,
        active_threshold_high: 6,
      });

      const tasks = await openTasksFor(result.id);
      expect(tasks).toHaveLength(2);
      const currentTask = tasks.find((task) => task.status === 'open');
      expect(currentTask).toMatchObject({
        status: 'open',
        title: 'Critical lab (corrected): Potassium [test]',
        metadata: { lab_alert_generation_state: 'critical' },
      });
      expect(currentTask.description).toMatch(/active low critical threshold 2\.5/i);
    });
  });

  // ── Scenario C — patient re-notify honors the release policy ─────────
  // Whole-panel release is authoritative: one held row suppresses the
  // corrected-result announcement for the entire episode.
  describe('corrected sign-off notifies only per the release policy', () => {
    let heldId;
    let plainId;

    it('does not announce a panel while any corrected row is held', async () => {
      const invId = await insertInvestigation(PATIENT_C_UID);
      heldId = await insertRawResult(PATIENT_C_UID, invId, '4.2', { releaseHold: true });
      plainId = await insertRawResult(PATIENT_C_UID, invId, '4.4');

      await signOff([heldId, plainId], 'corrected', PATIENT_C_UID);

      const notifs = await prisma.$queryRawUnsafe(
        `SELECT data FROM notifications
          WHERE uid = $1::uuid AND type = 'lab_result_corrected'`,
        PATIENT_C_UID,
      );
      expect(notifs).toHaveLength(0);
    });
  });

  // ── Regression guard — rejected sign-off stays inert ─────────────────
  it('rejects a non-sign-off decision without firing the corrected-result loop', async () => {
    const invId = await insertInvestigation(PATIENT_C_UID);
    const rid = await insertRawResult(PATIENT_C_UID, invId, '7.9');

    await expect(signOff([rid], 'rejected', PATIENT_C_UID)).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAB_SIGNOFF_DECISION_UNSUPPORTED',
    });

    expect((await openTasksFor(rid)).length).toBe(0);
    const rows = await prisma.$queryRawUnsafe(
      `SELECT is_critical FROM lab_results WHERE id = $1::int AND tenant_id = $2::uuid`,
      rid, TENANT,
    );
    expect(rows[0].is_critical).not.toBe(true);
  });
});
