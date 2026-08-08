// PR #770 riders (re-derived findings pass):
//
// F-M1 residual — the SLA emitters (startWorkflowSla / completeWorkflowSla)
// used the same silent DEFAULT_TENANT_ID fallback the timeline/audit writers
// had: an emit inside setTenantTx(tenant B) with no explicit tenantId stamped
// (and completed against) the default tenant. They now resolve tenant as
// explicit → transaction-local app.current_tenant_id GUC → fail-closed
// default fallback, like the other canonical writers.
//
// F-L4 — completeWorkflowSla had no terminal-state guard: re-completing an
// already-completed SLA after due_at recomputed the CASE and flipped
// 'completed' to 'breached'. Terminal rows ('completed'/'cancelled') are now
// never re-touched and re-completion idempotently returns the existing row;
// 'breached'/'escalated' stay completable (house convention —
// resultsInboxService, death certification) with their status preserved.
//
// Requires a reachable Postgres (DATABASE_URL). Skipped if none configured.

import { randomUUID } from 'crypto';
import prisma, { setTenantTx } from '../lib/prisma.js';
import {
  completeWorkflowSla,
  startWorkflowSla,
} from '../services/clinical/canonicalClinicalPlatformService.js';

const DB = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB ? describe : describe.skip;

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';
// Global rule (tenant_id NULL, enabled, 30-minute target) seeded by migration
// 269 — outside the lab-critical-alert and care-pathway scoped guard families.
const RULE = 'bed_cleaning_turnaround';
const SOURCE_TABLE = 'sla_guard_test';
const MARK = `SLA-GUARD-${process.pid}-${Date.now()}`;
let seq = 0;

const TENANT_B = randomUUID();

function nextSourceId() {
  return `${MARK}.${++seq}`;
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM workflow_sla_instances WHERE source_table = $1`,
    SOURCE_TABLE,
  ).catch(() => {});
}

d('workflow SLA tenant stamping + terminal-state guard (F-M1 residual, F-L4)', () => {
  beforeAll(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('SLA start/complete without an explicit tenant stamp the transaction tenant, not the default', async () => {
    const sourceId = nextSourceId();
    const priorDefaultTenant = process.env.ALLOW_DEFAULT_TENANT;
    process.env.ALLOW_DEFAULT_TENANT = 'false';
    let started;
    let completed;
    try {
      ({ started, completed } = await setTenantTx(TENANT_B, async (tx) => {
        const startedRow = await startWorkflowSla({
          // No tenantId on purpose: the transaction tenant must win even when
          // default-tenant fallback is disabled.
          ruleCode: RULE,
          patientUid: randomUUID(),
          sourceTable: SOURCE_TABLE,
          sourceId,
        }, { db: tx });
        const completedRow = await completeWorkflowSla({
          ruleCode: RULE,
          sourceTable: SOURCE_TABLE,
          sourceId,
        }, { db: tx });
        return { started: startedRow, completed: completedRow };
      }));
    } finally {
      if (priorDefaultTenant === undefined) delete process.env.ALLOW_DEFAULT_TENANT;
      else process.env.ALLOW_DEFAULT_TENANT = priorDefaultTenant;
    }

    expect(started?.tenant_id).toBe(TENANT_B);
    expect(started?.tenant_id).not.toBe(DEFAULT_TENANT);
    expect(started?.status).toBe('active');
    expect(completed?.tenant_id).toBe(TENANT_B);
    expect(completed?.status).toBe('completed');
  });

  test('re-completion after due_at never flips a completed SLA to breached', async () => {
    const sourceId = nextSourceId();
    const started = await startWorkflowSla({
      tenantId: TENANT_B,
      ruleCode: RULE,
      patientUid: randomUUID(),
      sourceTable: SOURCE_TABLE,
      sourceId,
    });
    expect(started?.status).toBe('active');

    const first = await completeWorkflowSla({
      tenantId: TENANT_B,
      ruleCode: RULE,
      sourceTable: SOURCE_TABLE,
      sourceId,
    });
    expect(first?.status).toBe('completed');
    expect(first?.completed_at).toBeTruthy();

    // Simulate the clock passing due_at, then re-complete: the terminal-state
    // guard must return the existing row unchanged instead of recomputing the
    // status CASE (which used to flip completed -> breached).
    await prisma.$executeRawUnsafe(
      `UPDATE workflow_sla_instances
          SET due_at = NOW() - INTERVAL '1 hour'
        WHERE id = $1::uuid`,
      started.id,
    );

    const second = await completeWorkflowSla({
      tenantId: TENANT_B,
      ruleCode: RULE,
      sourceTable: SOURCE_TABLE,
      sourceId,
    });
    expect(second?.id).toBe(first.id); // idempotent same-result readback
    expect(second?.status).toBe('completed');
    expect(new Date(second.completed_at).getTime()).toBe(new Date(first.completed_at).getTime());

    const persisted = await prisma.$queryRawUnsafe(
      `SELECT status, breached_at FROM workflow_sla_instances WHERE id = $1::uuid`,
      started.id,
    );
    expect(persisted[0].status).toBe('completed');
    expect(persisted[0].breached_at).toBeNull();
  });

  test('late completion of a monitor-breached SLA preserves the breached status and stamps completed_at once', async () => {
    const sourceId = nextSourceId();
    const started = await startWorkflowSla({
      tenantId: TENANT_B,
      ruleCode: RULE,
      patientUid: randomUUID(),
      sourceTable: SOURCE_TABLE,
      sourceId,
    });

    // Simulate an escalation monitor having marked the instance breached.
    await prisma.$executeRawUnsafe(
      `UPDATE workflow_sla_instances
          SET status = 'breached',
              breached_at = NOW(),
              due_at = NOW() - INTERVAL '1 hour'
        WHERE id = $1::uuid`,
      started.id,
    );

    const completed = await completeWorkflowSla({
      tenantId: TENANT_B,
      ruleCode: RULE,
      sourceTable: SOURCE_TABLE,
      sourceId,
    });
    expect(completed?.status).toBe('breached'); // status preserved, not recomputed
    expect(completed?.completed_at).toBeTruthy();

    const again = await completeWorkflowSla({
      tenantId: TENANT_B,
      ruleCode: RULE,
      sourceTable: SOURCE_TABLE,
      sourceId,
    });
    expect(again?.status).toBe('breached');
    expect(new Date(again.completed_at).getTime())
      .toBe(new Date(completed.completed_at).getTime()); // stamped once
  });
});
