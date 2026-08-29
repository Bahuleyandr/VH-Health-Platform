// SLA-halves audit (MEDIUM) — regression coverage for the cancel leg of the
// SLA lifecycle and the generic overdue sweep.
//
// G1 — cath-lab transitionCaseStatus closed the clock only on 'completed'; a
//      cancelled case leaked an 'active' instance forever.
// G3 — emitHousekeepingRequestStatus completed only for
//      completed/verified/closed; a cancelled request leaked the
//      request-keyed bed_cleaning_turnaround clock.
// Sweep — nothing generic ever flipped active past-due instances to
//      'breached'; instances with no linked task never left 'active'.
// (G2 — stroke cancel — is covered in stroke-pathway.deep.test.js, which owns
// the stroke fixture set.)
//
// Template: workflow-sla-canonical-guard.deep.test.js (throwaway
// source_table marker, seeded global bed_cleaning_turnaround rule, exact
// status/timestamp assertions). Requires a reachable Postgres (DATABASE_URL);
// skipped if none configured.

import { randomUUID } from 'crypto';
import prisma from '../lib/prisma.js';
import { deleteWithAuditBypass } from './helpers/auditBypass.js';
import {
  cancelWorkflowSla,
  completeWorkflowSla,
  startWorkflowSla,
} from '../services/clinical/canonicalClinicalPlatformService.js';
import { emitHousekeepingRequestStatus } from '../services/clinical/canonicalOperationalBridgeService.js';
import { createCase, transitionCaseStatus } from '../services/clinical/cathLabService.js';
import { runWorkflowSlaOverdueSweep } from '../services/workflow/slaOverdueSweepService.js';

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
// Global (tenant NULL, enabled) rules seeded by migration 269.
const BED_RULE = 'bed_cleaning_turnaround';
const REFERRAL_RULE = 'referral_response';
const SOURCE_TABLE = 'sla_cancel_guard_test';
const MARK = `SLA-CANCEL-${process.pid}-${Date.now()}`;
let seq = 0;

// Isolated throwaway tenants: the sweep is tenant-scoped, so a random tenant
// guarantees no interference with other suites' active instances (Jest runs
// deep files in parallel workers against the shared test DB).
const TENANT_W = randomUUID(); // wrapper-semantics tenant
const TENANT_S = randomUUID(); // sweep tenant

// Cath fixtures live on the default tenant (users FK) with random identities.
const CATH_PATIENT = randomUUID();
const CATH_PHONE = `7${String(Date.now() % 1_000_000_000).padStart(9, '0')}`;
const ACTOR = randomUUID();

// Housekeeping request ids far outside any realistic sequence.
const HK_CANCELLED_ID = 900000000 + (Date.now() % 1000000);
const HK_COMPLETED_ID = HK_CANCELLED_ID + 1;

function nextSourceId() {
  return `${MARK}.${++seq}`;
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflow_sla_instances WHERE source_table = $1`,
    SOURCE_TABLE,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflow_sla_instances WHERE tenant_id IN ($1::uuid, $2::uuid)`,
    TENANT_W,
    TENANT_S,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflow_sla_instances
      WHERE tenant_id = $1::uuid
        AND source_table = 'housekeeping_requests'
        AND source_id IN ($2, $3)`,
    DEFAULT_TENANT,
    String(HK_CANCELLED_ID),
    String(HK_COMPLETED_ID),
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events
      WHERE source_table = 'housekeeping_requests' AND source_id IN ($1, $2)`,
    String(HK_CANCELLED_ID),
    String(HK_COMPLETED_ID),
  ).catch(() => {});
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM clinical_audit_events
      WHERE resource_type = 'housekeeping_request' AND resource_id IN ($1, $2)`,
    String(HK_CANCELLED_ID),
    String(HK_COMPLETED_ID),
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflow_sla_instances
      WHERE source_table = 'cath_lab_cases'
        AND source_id IN (SELECT id::text FROM cath_lab_cases WHERE patient_uid = $1::uuid)`,
    CATH_PATIENT,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM cath_lab_readiness_checks
      WHERE case_id IN (SELECT id FROM cath_lab_cases WHERE patient_uid = $1::uuid)`,
    CATH_PATIENT,
  ).catch(() => {});
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role='replica'");
    await tx.$executeRawUnsafe(
      `DELETE FROM cath_lab_cases WHERE patient_uid = $1::uuid`,
      CATH_PATIENT,
    );
  }).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM clinical_timeline_events WHERE patient_uid = $1::uuid`,
    CATH_PATIENT,
  ).catch(() => {});
  await deleteWithAuditBypass(
    prisma,
    `DELETE FROM clinical_audit_events WHERE patient_uid = $1::uuid`,
    CATH_PATIENT,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `DELETE FROM users WHERE uid = $1::uuid`,
    CATH_PATIENT,
  ).catch(() => {});
}

async function instanceRow(tenantId, ruleCode, sourceTable, sourceId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM workflow_sla_instances
      WHERE tenant_id = $1::uuid AND rule_code = $2 AND source_table = $3 AND source_id = $4`,
    tenantId,
    ruleCode,
    sourceTable,
    sourceId,
  );
  return rows[0] || null;
}

d('SLA cancel leg + generic overdue sweep (SLA-halves audit)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO users (uid, phone, name, role, is_active, tenant_id, updated_at)
       VALUES ($1::uuid, $2, $3, 'PATIENT', true, $4::uuid, NOW())`,
      CATH_PATIENT,
      CATH_PHONE,
      `SLA Cancel Cath Patient ${MARK}`,
      DEFAULT_TENANT,
    );
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  describe('cancelWorkflowSla wrapper semantics', () => {
    test('cancels only the named rule, then the rest without a rule filter', async () => {
      const sourceId = nextSourceId();
      const startedBed = await startWorkflowSla({
        tenantId: TENANT_W,
        ruleCode: BED_RULE,
        sourceTable: SOURCE_TABLE,
        sourceId,
      });
      const startedReferral = await startWorkflowSla({
        tenantId: TENANT_W,
        ruleCode: REFERRAL_RULE,
        sourceTable: SOURCE_TABLE,
        sourceId,
      });
      expect(startedBed?.status).toBe('active');
      expect(startedReferral?.status).toBe('active');

      const cancelled = await cancelWorkflowSla({
        tenantId: TENANT_W,
        ruleCode: BED_RULE,
        sourceTable: SOURCE_TABLE,
        sourceId,
        metadata: { cancel_reason: 'rule-filter test' },
      });
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0].rule_code).toBe(BED_RULE);
      expect(cancelled[0].status).toBe('cancelled');
      expect(cancelled[0].metadata.cancel_reason).toBe('rule-filter test');

      const referralRow = await instanceRow(TENANT_W, REFERRAL_RULE, SOURCE_TABLE, sourceId);
      expect(referralRow.status).toBe('active');

      const cancelledRest = await cancelWorkflowSla({
        tenantId: TENANT_W,
        sourceTable: SOURCE_TABLE,
        sourceId,
      });
      expect(cancelledRest).toHaveLength(1);
      expect(cancelledRest[0].rule_code).toBe(REFERRAL_RULE);
      expect(cancelledRest[0].status).toBe('cancelled');
    });

    test('a cancelled clock is terminal: late completion never resurrects it', async () => {
      const sourceId = nextSourceId();
      await startWorkflowSla({
        tenantId: TENANT_W,
        ruleCode: BED_RULE,
        sourceTable: SOURCE_TABLE,
        sourceId,
      });
      await cancelWorkflowSla({
        tenantId: TENANT_W,
        ruleCode: BED_RULE,
        sourceTable: SOURCE_TABLE,
        sourceId,
      });

      const afterComplete = await completeWorkflowSla({
        tenantId: TENANT_W,
        ruleCode: BED_RULE,
        sourceTable: SOURCE_TABLE,
        sourceId,
      });
      expect(afterComplete.status).toBe('cancelled');
      expect(afterComplete.completed_at).toBeNull();
    });

    test('cancel never re-touches a completed clock', async () => {
      const sourceId = nextSourceId();
      await startWorkflowSla({
        tenantId: TENANT_W,
        ruleCode: BED_RULE,
        sourceTable: SOURCE_TABLE,
        sourceId,
      });
      const completed = await completeWorkflowSla({
        tenantId: TENANT_W,
        ruleCode: BED_RULE,
        sourceTable: SOURCE_TABLE,
        sourceId,
      });
      expect(completed.status).toBe('completed');

      const cancelled = await cancelWorkflowSla({
        tenantId: TENANT_W,
        ruleCode: BED_RULE,
        sourceTable: SOURCE_TABLE,
        sourceId,
      });
      expect(cancelled).toHaveLength(0);
      const row = await instanceRow(TENANT_W, BED_RULE, SOURCE_TABLE, sourceId);
      expect(row.status).toBe('completed');
    });

    test('a breached clock IS cancellable — the obligation disappearing supersedes the breach', async () => {
      const sourceId = nextSourceId();
      const started = await startWorkflowSla({
        tenantId: TENANT_W,
        ruleCode: BED_RULE,
        sourceTable: SOURCE_TABLE,
        sourceId,
      });
      await prisma.$executeRawUnsafe(
        `UPDATE workflow_sla_instances SET status = 'breached', breached_at = NOW() WHERE id = $1::uuid`,
        started.id,
      );

      const cancelled = await cancelWorkflowSla({
        tenantId: TENANT_W,
        ruleCode: BED_RULE,
        sourceTable: SOURCE_TABLE,
        sourceId,
      });
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0].status).toBe('cancelled');
    });
  });

  describe('G1 — cancelled cath-lab case stops its SLA clock', () => {
    test('transitionCaseStatus to cancelled cancels the case-keyed instance', async () => {
      const created = await createCase(
        {
          tenantId: DEFAULT_TENANT,
          patient_uid: CATH_PATIENT,
          facility_id: Number((await prisma.$queryRawUnsafe(
            `SELECT id FROM facilities
              WHERE tenant_id=$1::uuid AND status='active'
              ORDER BY is_default DESC, id
              LIMIT 1`,
            DEFAULT_TENANT,
          ))[0].id),
          requested_procedure: 'Coronary angiogram (SLA cancel regression)',
          urgency: 'routine',
          sla_rule_code: BED_RULE,
        },
        { actorUid: ACTOR, actorRole: 'DOCTOR' },
      );
      const started = await instanceRow(
        DEFAULT_TENANT, BED_RULE, 'cath_lab_cases', String(created.id),
      );
      expect(started.status).toBe('active');

      const cancelledCase = await transitionCaseStatus(
        created.id,
        { tenantId: DEFAULT_TENANT, status: 'cancelled', reason: 'patient unfit for procedure' },
        { actorUid: ACTOR, actorRole: 'DOCTOR' },
      );
      expect(cancelledCase.status).toBe('cancelled');

      const instance = await instanceRow(
        DEFAULT_TENANT, BED_RULE, 'cath_lab_cases', String(created.id),
      );
      expect(instance.status).toBe('cancelled');
      expect(instance.completed_at).toBeNull();
      expect(instance.metadata.cancel_reason).toBe('patient unfit for procedure');
      expect(instance.metadata.cancelled_by).toBe(ACTOR);
    });
  });

  describe('G3 — cancelled housekeeping request stops the request-keyed clock', () => {
    test('emitHousekeepingRequestStatus cancelled cancels; completed still completes', async () => {
      for (const id of [HK_CANCELLED_ID, HK_COMPLETED_ID]) {
        const started = await startWorkflowSla({
          tenantId: DEFAULT_TENANT,
          ruleCode: BED_RULE,
          sourceTable: 'housekeeping_requests',
          sourceId: String(id),
        });
        expect(started?.status).toBe('active');
      }

      await emitHousekeepingRequestStatus({
        request: {
          id: HK_CANCELLED_ID,
          tenant_id: DEFAULT_TENANT,
          status: 'cancelled',
          request_number: `HK-${MARK}-C`,
        },
        actorUid: ACTOR,
        actorRole: 'ADMIN',
        eventType: 'housekeeping.cancelled',
        previousStatus: 'pending',
      });
      const cancelledRow = await instanceRow(
        DEFAULT_TENANT, BED_RULE, 'housekeeping_requests', String(HK_CANCELLED_ID),
      );
      expect(cancelledRow.status).toBe('cancelled');
      expect(cancelledRow.completed_at).toBeNull();
      expect(cancelledRow.metadata.cancelled_status).toBe('cancelled');

      await emitHousekeepingRequestStatus({
        request: {
          id: HK_COMPLETED_ID,
          tenant_id: DEFAULT_TENANT,
          status: 'completed',
          request_number: `HK-${MARK}-D`,
        },
        actorUid: ACTOR,
        actorRole: 'HOUSEKEEPING_STAFF',
        eventType: 'housekeeping.completed',
        previousStatus: 'in_progress',
      });
      const completedRow = await instanceRow(
        DEFAULT_TENANT, BED_RULE, 'housekeeping_requests', String(HK_COMPLETED_ID),
      );
      expect(completedRow.status).toBe('completed');
      expect(completedRow.completed_at).not.toBeNull();
    });
  });

  describe('generic overdue sweep', () => {
    test('flips only active past-due instances, honors the limit, and leaves terminal/undated/future rows alone', async () => {
      const overdueA = nextSourceId(); // due 2h ago — first claimed (ORDER BY due_at)
      const overdueE = nextSourceId(); // due 1h ago
      const escalatedB = nextSourceId();
      const undatedC = nextSourceId();
      const futureD = nextSourceId();

      const ids = {};
      for (const sourceId of [overdueA, overdueE, escalatedB, futureD]) {
        const started = await startWorkflowSla({
          tenantId: TENANT_S,
          ruleCode: BED_RULE,
          sourceTable: SOURCE_TABLE,
          sourceId,
        });
        expect(started?.status).toBe('active');
        ids[sourceId] = started.id;
      }
      await prisma.$executeRawUnsafe(
        `UPDATE workflow_sla_instances SET due_at = NOW() - INTERVAL '2 hours' WHERE id = $1::uuid`,
        ids[overdueA],
      );
      await prisma.$executeRawUnsafe(
        `UPDATE workflow_sla_instances SET due_at = NOW() - INTERVAL '1 hour' WHERE id = $1::uuid`,
        ids[overdueE],
      );
      await prisma.$executeRawUnsafe(
        `UPDATE workflow_sla_instances
            SET status = 'escalated', escalated_at = NOW(), due_at = NOW() - INTERVAL '1 hour'
          WHERE id = $1::uuid`,
        ids[escalatedB],
      );
      // A NULL due_at is only legal in the STEMI targets-pending shape
      // (workflow_sla_instances_due_or_targets_pending_chk, migration 562) —
      // insert the undated clock raw in exactly that shape, like
      // stemiPathwayService does before door-time/targets arrive.
      await prisma.$executeRawUnsafe(
        `INSERT INTO workflow_sla_instances
           (tenant_id, rule_id, rule_code, source_table, source_id,
            status, priority, started_at, due_at, metadata)
         VALUES ($1::uuid, NULL, 'stemi_door_to_balloon', 'stemi_activations', $2,
                 'active', 'critical', NOW(), NULL, '{"targets_pending": true}'::jsonb)`,
        TENANT_S,
        undatedC,
      );
      // futureD keeps its 30-minute future due_at from startWorkflowSla.

      // Limit 1 claims exactly the earliest-due candidate.
      const first = await runWorkflowSlaOverdueSweep({ tenantId: TENANT_S, limit: 1 });
      expect(first).toEqual({ breached: 1, byRule: { [BED_RULE]: 1 } });
      const rowA = await instanceRow(TENANT_S, BED_RULE, SOURCE_TABLE, overdueA);
      expect(rowA.status).toBe('breached');
      // The breach moment is due_at, not detection time.
      expect(new Date(rowA.breached_at).getTime()).toBe(new Date(rowA.due_at).getTime());
      expect(rowA.metadata.breached_by).toBe('workflow-sla-overdue-sweep');

      // Second pass picks up the remaining overdue row — and nothing else.
      const second = await runWorkflowSlaOverdueSweep({ tenantId: TENANT_S });
      expect(second).toEqual({ breached: 1, byRule: { [BED_RULE]: 1 } });
      const rowE = await instanceRow(TENANT_S, BED_RULE, SOURCE_TABLE, overdueE);
      expect(rowE.status).toBe('breached');

      const rowB = await instanceRow(TENANT_S, BED_RULE, SOURCE_TABLE, escalatedB);
      expect(rowB.status).toBe('escalated');
      expect(rowB.breached_at).toBeNull();
      const rowC = await instanceRow(
        TENANT_S, 'stemi_door_to_balloon', 'stemi_activations', undatedC,
      );
      expect(rowC.status).toBe('active');
      expect(rowC.breached_at).toBeNull();
      const rowD = await instanceRow(TENANT_S, BED_RULE, SOURCE_TABLE, futureD);
      expect(rowD.status).toBe('active');

      // A third pass finds nothing — the sweep is idempotent.
      const third = await runWorkflowSlaOverdueSweep({ tenantId: TENANT_S });
      expect(third).toEqual({ breached: 0, byRule: {} });

      // Late completion of a swept row keeps the breached status (house
      // convention) while stamping completed_at once.
      const lateCompleted = await completeWorkflowSla({
        tenantId: TENANT_S,
        ruleCode: BED_RULE,
        sourceTable: SOURCE_TABLE,
        sourceId: overdueA,
      });
      expect(lateCompleted.status).toBe('breached');
      expect(lateCompleted.completed_at).not.toBeNull();
      expect(new Date(lateCompleted.breached_at).getTime())
        .toBe(new Date(rowA.due_at).getTime());
    });

    test('the sweep is tenant-scoped: another tenant\'s overdue clock is untouched', async () => {
      const foreignSource = nextSourceId();
      const started = await startWorkflowSla({
        tenantId: TENANT_W,
        ruleCode: REFERRAL_RULE,
        sourceTable: SOURCE_TABLE,
        sourceId: foreignSource,
      });
      await prisma.$executeRawUnsafe(
        `UPDATE workflow_sla_instances SET due_at = NOW() - INTERVAL '1 hour' WHERE id = $1::uuid`,
        started.id,
      );

      const result = await runWorkflowSlaOverdueSweep({ tenantId: TENANT_S });
      expect(result).toEqual({ breached: 0, byRule: {} });

      const row = await instanceRow(TENANT_W, REFERRAL_RULE, SOURCE_TABLE, foreignSource);
      expect(row.status).toBe('active');
    });
  });
});
