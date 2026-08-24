/**
 * Escalation sweep blocked-status gate (audit E-L6, deep, real PostgreSQL).
 *
 * The sweep's overdue pass used to raw-UPDATE `status IN ('open','blocked')`
 * to 'overdue'. TASK_TRANSITIONS allows blocked → in_progress|cancelled ONLY,
 * and overdue → completed is a sanctioned edge — so the flip let a blocked
 * task be completed without ever leaving blocked through a sanctioned edge.
 *
 * Pins the fix that landed with PR #782 (merged engine): only 'open' tasks
 * flip to 'overdue'; a blocked task past its due_at keeps its status while
 * REMAINING escalation-eligible (blocked is in ESCALATABLE_STATUSES, so tiers
 * still fire on it without a status change).
 *
 * Seeding note: tenant discovery reads `tenants WHERE status = 'active'`, so a
 * tenant with tasks but no rules is swept too — its overdue pass and backfill
 * backstop run, only the per-rule tiers are skipped. (It used to read DISTINCT
 * tenant_id FROM escalation_rules, which skipped such a tenant entirely; the
 * suite still seeds a rule so the with-rules path stays covered.)
 *
 * Assertions here are plain status/metadata reads with no RLS or trigger
 * dependency, so the suite follows escalationSweepAdvancement.deep.test.js and
 * runs on the default (owner) connection.
 */

import { randomUUID } from 'node:crypto';

import { jest } from '@jest/globals';
import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

jest.unstable_mockModule('../services/patientFlow/porterTransportService.js', () => ({
  runTransportEscalationSweep: jest.fn(async () => ({ scanned: 0, breached: 0, notified: 0 })),
}));

const queueNotificationMock = jest.fn(async () => {});
jest.unstable_mockModule('../utils/notifications/notificationOutbox.js', () => ({
  default: { queue: queueNotificationMock },
  notificationOutbox: { queue: queueNotificationMock },
  queue: queueNotificationMock,
}));

const prisma = (await import('../lib/prisma.js')).default;
const { runEscalationSweep } = await import('../services/workflow/escalationEngineService.js');

const TENANT_ID = 'd6700000-0000-4000-8000-00000000fb01';
const CLOCK = new Date('2026-08-09T10:00:00.000Z');
const HOOK_TIMEOUT_MS = 120000;

function ownerDatabaseUrl(value) {
  if (!value) return value;
  const url = new URL(value);
  if (url.hostname === '127.0.0.1' && url.port === '55432') {
    url.username = 'postgres';
    url.password = '';
  }
  return url.toString();
}

async function insertRule(client, {
  taskKind,
  displayName = taskKind,
  actionKind = 'escalate_priority',
  actionPayload = { tier: 1 },
} = {}) {
  const result = await client.query(
    `INSERT INTO escalation_rules
       (tenant_id, display_name, scope, match_filter, trigger_condition,
        trigger_window_minutes, action_kind, action_payload, is_active)
     VALUES
       ($1::uuid, $2::text, 'task', jsonb_build_object('task_kind', $3::text),
        'pending_too_long', 0, $4::text, $5::jsonb, TRUE)
     RETURNING id`,
    [TENANT_ID, displayName, taskKind, actionKind, JSON.stringify(actionPayload)],
  );
  return result.rows[0].id;
}

async function insertTask(client, {
  taskKind,
  status,
  title = taskKind,
  dueAt = new Date(CLOCK.getTime() - 60 * 60_000),
  createdAt = new Date(CLOCK.getTime() - 2 * 60 * 60_000),
} = {}) {
  const result = await client.query(
    `INSERT INTO tasks
       (tenant_id, task_kind, title, status, priority, due_at, created_at,
        updated_at, metadata, sla_completion_semantics)
     VALUES
       ($1::uuid, $2::text, $3::text, $4::text, 'normal', $5::timestamptz,
        $6::timestamptz, $6::timestamptz, '{}'::jsonb, 'none')
     RETURNING id`,
    [TENANT_ID, taskKind, title, status, dueAt.toISOString(), createdAt.toISOString()],
  );
  return result.rows[0].id;
}

async function taskState(client, taskId) {
  const result = await client.query(
    `SELECT status, priority, metadata
       FROM tasks
      WHERE tenant_id = $1::uuid AND id = $2::bigint`,
    [TENANT_ID, taskId],
  );
  return result.rows[0];
}

function firedForRule(task, ruleId) {
  return (task?.metadata?.escalations || [])
    .filter((entry) => Number(entry.rule_id) === Number(ruleId));
}

async function cleanup(client) {
  await client.query('BEGIN');
  try {
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query('DELETE FROM task_comments WHERE tenant_id = $1::uuid', [TENANT_ID]);
    await client.query('DELETE FROM tasks WHERE tenant_id = $1::uuid', [TENANT_ID]);
    await client.query('DELETE FROM escalation_rules WHERE tenant_id = $1::uuid', [TENANT_ID]);
    await client.query('DELETE FROM tenants WHERE id = $1::uuid', [TENANT_ID]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

describeIfDb('escalation sweep blocked-status gate (deep, real PostgreSQL)', () => {
  const owner = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });

  beforeAll(async () => {
    await owner.connect();
    await cleanup(owner);
    await owner.query(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, $2::text, 'Blocked gate proof', 'IN', 'DPDP', 'active')`,
      [TENANT_ID, `escalation-blocked-gate-${randomUUID()}`],
    );
  }, HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await owner.query('DELETE FROM task_comments WHERE tenant_id = $1::uuid', [TENANT_ID]);
    await owner.query('DELETE FROM tasks WHERE tenant_id = $1::uuid', [TENANT_ID]);
    await owner.query('DELETE FROM escalation_rules WHERE tenant_id = $1::uuid', [TENANT_ID]);
    queueNotificationMock.mockReset();
    queueNotificationMock.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await cleanup(owner);
    await owner.end();
    await prisma.$disconnect().catch(() => {});
  }, HOOK_TIMEOUT_MS);

  test('the overdue pass flips open tasks but never blocked tasks', async () => {
    // Rule filter matches nothing here. It no longer has to exist for tenant
    // discovery — the sweep enumerates every ACTIVE tenant now, precisely so the
    // rule-independent overdue pass runs for tenants without rules — but it is
    // kept so this case still exercises the with-rules path end to end.
    await insertRule(owner, {
      taskKind: 'unrelated_kind',
      displayName: 'Tenant discovery seed',
    });
    const blockedId = await insertTask(owner, {
      taskKind: 'review',
      status: 'blocked',
      title: 'Blocked task past due',
    });
    const openId = await insertTask(owner, {
      taskKind: 'review',
      status: 'open',
      title: 'Open task past due',
    });

    const result = await runEscalationSweep({ now: CLOCK, limit: 10 });

    // Positive control: the pass still marks the open task overdue...
    expect((await taskState(owner, openId)).status).toBe('overdue');
    // markedOverdue is a FLEET counter and the sweep now visits every active
    // tenant, so it is no longer this suite's exclusive property — another
    // suite's tenant sharing the database can legitimately add to it. The
    // per-task status assertions above and below are the exact proof.
    expect(result.markedOverdue).toBeGreaterThanOrEqual(1);
    // ...but the blocked task keeps its status: blocked has no sanctioned
    // edge to overdue, and overdue→completed would bypass the blocked gate.
    expect((await taskState(owner, blockedId)).status).toBe('blocked');
  }, 60000);

  test('a blocked task stays escalation-eligible without a status change', async () => {
    const ruleId = await insertRule(owner, {
      taskKind: 'consent',
      displayName: 'Blocked eligibility proof',
    });
    const blockedId = await insertTask(owner, {
      taskKind: 'consent',
      status: 'blocked',
      title: 'Blocked but escalatable',
    });

    const result = await runEscalationSweep({ now: CLOCK, limit: 10 });

    const task = await taskState(owner, blockedId);
    // The tier fired (marker + priority bump)...
    expect(result.escalated).toBe(1);
    expect(firedForRule(task, ruleId)).toHaveLength(1);
    expect(task.priority).toBe('critical');
    // ...while the status machine was not violated.
    expect(task.status).toBe('blocked');
  }, 60000);

  test('a second sweep does not erode the blocked status either', async () => {
    await insertRule(owner, {
      taskKind: 'unrelated_kind',
      displayName: 'Tenant discovery seed (replay)',
    });
    const blockedId = await insertTask(owner, {
      taskKind: 'review',
      status: 'blocked',
      title: 'Blocked task replay proof',
    });

    await runEscalationSweep({ now: CLOCK, limit: 10 });
    await runEscalationSweep({
      now: new Date(CLOCK.getTime() + 30 * 60_000),
      limit: 10,
    });

    expect((await taskState(owner, blockedId)).status).toBe('blocked');
  }, 60000);
});

void jest;
