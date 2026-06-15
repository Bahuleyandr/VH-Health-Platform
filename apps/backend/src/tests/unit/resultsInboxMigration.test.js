/**
 * Migration 312 — results-inbox idempotency.
 *
 * Verifies that the additive migration installs:
 *   1. the partial unique index `uq_task_open_per_resource` on `tasks`
 *      (one OPEN task per result resource → producer ON CONFLICT DO NOTHING
 *      is race-safe), and
 *   2. the idempotent default-tenant `escalation_rules` tier seed (the three
 *      critical-result escalation tiers) so the engine has rules to act on.
 *
 * Mirrors tasksWorkflowMigration.test.js (a DB-backed assertion against the
 * QA cluster) rather than a file-read assertion, because the seed + partial
 * index are only meaningful once applied.
 */

import { Client } from 'pg';

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
        `SELECT display_name, trigger_condition, action_kind, trigger_window_minutes
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
