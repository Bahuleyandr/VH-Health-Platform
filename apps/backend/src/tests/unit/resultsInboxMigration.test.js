/**
 * Migration 312 — results-inbox idempotency.
 *
 * Verifies that the additive migration installs:
 *   1. the partial unique index `uq_task_open_per_resource` on `tasks`
 *      (one OPEN task per result resource → producer ON CONFLICT DO NOTHING
 *      is race-safe), and
 *   2. the idempotent default-tenant `escalation_rules` tier seed (the three
 *      critical-result escalation tiers) so the engine has rules to act on.
 *      The seed filters on the SLA the producer attaches
 *      (`sla_key='critical_result_ack'`) and deliberately does NOT pin
 *      `priority`, so BOTH critical- and high-severity ack-tasks escalate.
 *
 * It also proves (3) the producer's `ON CONFLICT … DO NOTHING` predicate
 * actually infers the REAL partial index at runtime: the unit-level mocks in
 * taskService.test.js can only prove the SQL contains the clause — a malformed
 * predicate (column/where mismatch vs the index) throws 42P10 only against live
 * Postgres, and that would mean a critical result silently producing no task.
 *
 * Mirrors tasksWorkflowMigration.test.js (a DB-backed assertion against the
 * QA cluster) rather than a file-read assertion, because the seed + partial
 * index are only meaningful once applied.
 */

import { Client } from 'pg';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import * as taskService from '../../services/workflow/taskService.js';

const url = process.env.DATABASE_URL
  || 'postgresql://qa_writer:qa_writer_local@127.0.0.1:55432/vhhealth_test';

const DEFAULT_TENANT = '00000000-0000-4000-8000-000000000001';

describe('migration 312 — results-inbox idempotency + escalation tier seed', () => {
  test('partial unique index uq_task_open_per_resource exists', async () => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      const r = await c.query(
        `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_task_open_per_resource'`,
      );
      expect(r.rows.length).toBe(1);
      const def = r.rows[0].indexdef;
      // Keyed on the resource triple, partial on open-ish statuses.
      expect(def).toMatch(/related_resource_type/);
      expect(def).toMatch(/related_resource_id/);
      expect(def).toMatch(/UNIQUE/i);
      expect(def).toMatch(/WHERE/i);
    } finally {
      await c.end();
    }
  });

  test('critical-result escalation tiers seeded for default tenant', async () => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      const r = await c.query(
        `SELECT display_name, trigger_condition, action_kind, trigger_window_minutes, match_filter
           FROM escalation_rules
          WHERE tenant_id = $1::uuid
            AND display_name LIKE 'Critical result %'
          ORDER BY trigger_window_minutes`,
        [DEFAULT_TENANT],
      );
      expect(r.rows.length).toBeGreaterThanOrEqual(3);
      // Every seeded tier fires on the mig-269 SLA breach clock.
      for (const row of r.rows) {
        expect(row.trigger_condition).toBe('sla_breach');
        // Keyed off the SLA the producer attaches — and deliberately NOT pinned
        // to priority, so high-severity ack-tasks escalate too (the T1
        // escalate_priority action bumps priority anyway).
        expect(row.match_filter).toMatchObject({
          task_kind: 'review',
          sla_key: 'critical_result_ack',
        });
        expect(row.match_filter.priority).toBeUndefined();
      }
      // Tier windows escalate (0 → later windows).
      const windows = r.rows.map((row) => row.trigger_window_minutes);
      expect(windows[0]).toBe(0);
      expect(windows[windows.length - 1]).toBeGreaterThan(0);
    } finally {
      await c.end();
    }
  });

  test('escalation tier seed is idempotent (no duplicate display_names)', async () => {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      const r = await c.query(
        `SELECT display_name, COUNT(*)::int AS n
           FROM escalation_rules
          WHERE tenant_id = $1::uuid
            AND display_name LIKE 'Critical result %'
          GROUP BY display_name
         HAVING COUNT(*) > 1`,
        [DEFAULT_TENANT],
      );
      expect(r.rows).toEqual([]);
    } finally {
      await c.end();
    }
  });
});

describe('migration 312 — producer ON CONFLICT infers the REAL partial index', () => {
  // A per-run unique resource id so a prior crashed run cannot collide and a
  // stale OPEN row cannot mask the "first insert creates" assertion.
  const RELATED_RESOURCE_ID = `idem-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  let createdTaskId = null;

  afterAll(async () => {
    if (createdTaskId != null) {
      await prisma
        .$executeRawUnsafe('DELETE FROM tasks WHERE id = $1', createdTaskId)
        .catch(() => {});
    }
    await prisma.$disconnect().catch(() => {});
  });

  test('first createTask returns a row, second (same resource) is a no-op (undefined)', async () => {
    // Both inserts run inside ONE tenant-scoped tx so the first OPEN task is
    // visible to the second insert's ON CONFLICT predicate. If the predicate
    // does not resolve against uq_task_open_per_resource, Postgres throws 42P10
    // ("no unique or exclusion constraint matching the ON CONFLICT") — which the
    // mocked unit tests cannot catch. A green run proves the inference is valid.
    const { first, second } = await setTenantTx(DEFAULT_TENANT, async (tx) => {
      const firstRow = await taskService.createTask({
        tenantId: DEFAULT_TENANT,
        tx,
        taskKind: 'review',
        title: 'idem-test',
        relatedResourceType: 'lab_result',
        relatedResourceId: RELATED_RESOURCE_ID,
        priority: 'critical',
        onConflictResourceDoNothing: true,
      });
      const secondRow = await taskService.createTask({
        tenantId: DEFAULT_TENANT,
        tx,
        taskKind: 'review',
        title: 'idem-test',
        relatedResourceType: 'lab_result',
        relatedResourceId: RELATED_RESOURCE_ID,
        priority: 'critical',
        onConflictResourceDoNothing: true,
      });
      return { first: firstRow, second: secondRow };
    });

    // 1st insert created the OPEN task.
    expect(first).toBeDefined();
    expect(first.id).toBeDefined();
    createdTaskId = first.id; // for teardown
    // 2nd insert for the same open resource → ON CONFLICT DO NOTHING → no row.
    expect(second).toBeUndefined();
  });
});
