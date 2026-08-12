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
const { runEscalationSweep, __testing__ } = await import(
  '../services/workflow/escalationEngineService.js'
);
const { serializeEscalationMetrics } = await import('../observability/escalationMetrics.js');
const logger = (await import('../logging/logger.js')).default;

const TENANT_ID = 'd6700000-0000-4000-8000-00000000fa01';
const CLOCK = new Date('2026-08-04T10:00:00.000Z');
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

function counterValue(name, labels) {
  const labelPart = Object.entries(labels).map(([key, value]) => `${key}="${value}"`).join(',');
  const prefix = `${name}{${labelPart}} `;
  const line = serializeEscalationMetrics().split('\n').find((item) => item.startsWith(prefix));
  return line ? Number(line.slice(prefix.length)) : 0;
}

async function insertRule(client, {
  taskKind,
  windowMinutes = 0,
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
        'pending_too_long', $4::integer, $5::text, $6::jsonb, TRUE)
     RETURNING id`,
    [TENANT_ID, displayName, taskKind, windowMinutes, actionKind, JSON.stringify(actionPayload)],
  );
  return result.rows[0].id;
}

async function insertTask(client, {
  taskKind,
  createdAt = new Date(CLOCK.getTime() - 2 * 60 * 60_000),
  title = taskKind,
} = {}) {
  const result = await client.query(
    `INSERT INTO tasks
       (tenant_id, task_kind, title, status, priority, created_at, updated_at,
        metadata, sla_completion_semantics)
     VALUES
       ($1::uuid, $2::text, $3::text, 'open', 'normal', $4::timestamptz,
        $4::timestamptz, '{}'::jsonb, 'none')
     RETURNING id`,
    [TENANT_ID, taskKind, title, createdAt.toISOString()],
  );
  return result.rows[0].id;
}

async function taskState(client, taskId) {
  const result = await client.query(
    `SELECT priority, status, assigned_to_uid, assigned_to_role, metadata
       FROM tasks
      WHERE tenant_id = $1::uuid AND id = $2::bigint`,
    [TENANT_ID, taskId],
  );
  return result.rows[0];
}

async function ruleState(client, ruleId) {
  const result = await client.query(
    `SELECT id, tenant_id, scope, match_filter, trigger_condition,
            trigger_window_minutes, action_kind, action_payload, is_active
       FROM escalation_rules
      WHERE tenant_id = $1::uuid AND id = $2::bigint`,
    [TENANT_ID, ruleId],
  );
  return result.rows[0];
}

function asPrismaTx(client) {
  return {
    $queryRawUnsafe: async (sql, ...params) => (await client.query(sql, params)).rows,
    $executeRawUnsafe: async (sql, ...params) => (await client.query(sql, params)).rowCount,
  };
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
    await client.query('DELETE FROM users WHERE tenant_id = $1::uuid', [TENANT_ID]);
    await client.query('DELETE FROM tenants WHERE id = $1::uuid', [TENANT_ID]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

describeIfDb('escalation sweep advancement fairness (deep, real PostgreSQL)', () => {
  const owner = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });

  beforeAll(async () => {
    await owner.connect();
    await cleanup(owner);
    await owner.query(
      `INSERT INTO tenants (id, slug, name, region, compliance_profile, status)
       VALUES ($1::uuid, $2::text, 'Escalation advancement proof', 'IN', 'DPDP', 'active')`,
      [TENANT_ID, `escalation-advance-${randomUUID()}`],
    );
  }, HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await owner.query('DELETE FROM task_comments WHERE tenant_id = $1::uuid', [TENANT_ID]);
    await owner.query('DELETE FROM tasks WHERE tenant_id = $1::uuid', [TENANT_ID]);
    await owner.query('DELETE FROM escalation_rules WHERE tenant_id = $1::uuid', [TENANT_ID]);
    await owner.query('DELETE FROM users WHERE tenant_id = $1::uuid', [TENANT_ID]);
    queueNotificationMock.mockReset();
    queueNotificationMock.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await cleanup(owner);
    await owner.end();
    await prisma.$disconnect().catch(() => {});
  }, HOOK_TIMEOUT_MS);

  test('filter and trigger-window eligibility happen before LIMIT, so the later match fires', async () => {
    const otherRuleId = await insertRule(owner, {
      taskKind: 'general',
      displayName: 'Different filter proof',
    });
    const targetRuleId = await insertRule(owner, {
      taskKind: 'review',
      windowMinutes: 60,
      displayName: 'Later eligible target proof',
    });

    const otherTaskIds = [];
    for (let index = 0; index < 3; index += 1) {
      otherTaskIds.push(await insertTask(owner, {
        taskKind: 'general',
        title: `Different rule head task ${index}`,
      }));
    }
    const parkedByWindowIds = [];
    for (let index = 0; index < 3; index += 1) {
      parkedByWindowIds.push(await insertTask(owner, {
        taskKind: 'review',
        createdAt: new Date(CLOCK.getTime() - 5 * 60_000),
        title: `Matching filter but trigger window not reached ${index}`,
      }));
    }
    const laterEligibleId = await insertTask(owner, {
      taskKind: 'review',
      createdAt: new Date(CLOCK.getTime() - 2 * 60 * 60_000),
      title: 'Later matching task must fire',
    });

    const result = await runEscalationSweep({ now: CLOCK, limit: 2 });

    const later = await taskState(owner, laterEligibleId);
    expect(firedForRule(later, targetRuleId)).toHaveLength(1);
    expect(later.priority).toBe('critical');
    for (const parkedId of parkedByWindowIds) {
      expect(firedForRule(await taskState(owner, parkedId), targetRuleId)).toHaveLength(0);
    }
    expect(result.escalated).toBe(3);

    const otherStates = [];
    for (const id of otherTaskIds) otherStates.push(await taskState(owner, id));
    expect(otherStates.filter((task) => firedForRule(task, otherRuleId).length === 1)).toHaveLength(2);
  }, 60000);

  test('a cap-sized already-fired head is SQL-excluded so the later task fires', async () => {
    const ruleId = await insertRule(owner, {
      taskKind: 'consent',
      displayName: 'Already-fired advancement proof',
    });
    const alreadyFiredIds = [
      await insertTask(owner, { taskKind: 'consent', title: 'Already fired A' }),
      await insertTask(owner, { taskKind: 'consent', title: 'Already fired B' }),
    ];
    for (const taskId of alreadyFiredIds) {
      await owner.query(
        `UPDATE tasks
            SET metadata = jsonb_build_object(
                  'escalations',
                  jsonb_build_array(jsonb_build_object('rule_id', $3::bigint, 'tier', 1))
                )
          WHERE tenant_id = $1::uuid AND id = $2::bigint`,
        [TENANT_ID, taskId, ruleId],
      );
    }
    const laterTaskId = await insertTask(owner, {
      taskKind: 'consent',
      title: 'Later task behind fired head',
    });

    const result = await runEscalationSweep({ now: CLOCK, limit: 2 });

    expect(result.escalated).toBe(1);
    expect(firedForRule(await taskState(owner, laterTaskId), ruleId)).toHaveLength(1);
    for (const taskId of alreadyFiredIds) {
      expect(firedForRule(await taskState(owner, taskId), ruleId)).toHaveLength(1);
    }
  }, 60000);

  test('two concurrent sweeps append exactly one marker and perform one action', async () => {
    const ruleId = await insertRule(owner, {
      taskKind: 'verification',
      displayName: 'Concurrent exact-once proof',
    });
    const taskId = await insertTask(owner, { taskKind: 'verification' });

    const results = await Promise.all([
      runEscalationSweep({ now: CLOCK, limit: 10 }),
      runEscalationSweep({ now: CLOCK, limit: 10 }),
    ]);
    const task = await taskState(owner, taskId);

    expect(firedForRule(task, ruleId)).toHaveLength(1);
    expect(task.priority).toBe('critical');
    expect(results.reduce((sum, result) => sum + result.escalated, 0)).toBe(1);

    const replay = await runEscalationSweep({ now: CLOCK, limit: 10 });
    expect(replay.escalated).toBe(0);
    expect(firedForRule(await taskState(owner, taskId), ruleId)).toHaveLength(1);
  }, 60000);

  test('concurrent owners may claim different tasks without duplicate markers', async () => {
    const ruleId = await insertRule(owner, {
      taskKind: 'review',
      displayName: 'Distinct concurrent claim proof',
    });
    const ruleRow = await ruleState(owner, ruleId);
    const taskIds = [
      await insertTask(owner, { taskKind: 'review', title: 'Concurrent claim A' }),
      await insertTask(owner, { taskKind: 'review', title: 'Concurrent claim B' }),
    ];
    const clients = taskIds.map(() => new Client({ connectionString: ownerDatabaseUrl(databaseUrl) }));
    await Promise.all(clients.map((client) => client.connect()));
    await Promise.all(clients.map((client) => client.query('BEGIN')));
    try {
      const claims = await Promise.all(taskIds.map((taskId, index) => (
        __testing__.claimEligibleCandidate(asPrismaTx(clients[index]), {
          tenantId: TENANT_ID,
          taskId,
          ruleRow,
          clock: CLOCK,
        })
      )));
      expect(claims.map((claim) => claim.outcome)).toEqual(['claimed', 'claimed']);
      await Promise.all(clients.map((client) => client.query('COMMIT')));
    } catch (error) {
      await Promise.all(clients.map((client) => client.query('ROLLBACK').catch(() => {})));
      throw error;
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }

    const states = [];
    for (const taskId of taskIds) states.push(await taskState(owner, taskId));
    expect(states.map((task) => firedForRule(task, ruleId).length)).toEqual([1, 1]);
  }, 60000);

  test('a Phase-0 candidate made ineligible before claim is stale, not lock-skipped', async () => {
    const ruleId = await insertRule(owner, {
      taskKind: 'verification',
      displayName: 'Stale Phase-0 proof',
    });
    const ruleRow = await ruleState(owner, ruleId);
    const taskId = await insertTask(owner, { taskKind: 'verification' });
    const page = await __testing__.readEligibleCandidatePage(asPrismaTx(owner), {
      tenantId: TENANT_ID,
      ruleRow,
      clock: CLOCK,
      cap: 10,
    });
    expect(page.map((row) => Number(row.id))).toContain(Number(taskId));

    await owner.query(
      `UPDATE tasks
          SET status = 'completed', updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint`,
      [TENANT_ID, taskId],
    );
    const before = counterValue('vhhealth_escalation_candidate_lock_skipped_total', {
      trigger_condition: 'pending_too_long',
    });
    const claim = await __testing__.claimEligibleCandidate(asPrismaTx(owner), {
      tenantId: TENANT_ID,
      taskId,
      ruleRow,
      clock: CLOCK,
    });
    expect(claim.outcome).toBe('stale');
    expect(counterValue('vhhealth_escalation_candidate_lock_skipped_total', {
      trigger_condition: 'pending_too_long',
    })).toBe(before);
  }, 60000);

  test('a rolled-back owner leaves no marker and the next sweep retries', async () => {
    const ruleId = await insertRule(owner, {
      taskKind: 'admin',
      displayName: 'Rollback retry proof',
    });
    const ruleRow = await ruleState(owner, ruleId);
    const taskId = await insertTask(owner, { taskKind: 'admin' });
    const claimant = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    await claimant.connect();
    await claimant.query('BEGIN');
    try {
      const claim = await __testing__.claimEligibleCandidate(asPrismaTx(claimant), {
        tenantId: TENANT_ID,
        taskId,
        ruleRow,
        clock: CLOCK,
      });
      expect(claim.outcome).toBe('claimed');
      expect(firedForRule(await taskState(claimant, taskId), ruleId)).toHaveLength(1);
    } finally {
      await claimant.query('ROLLBACK').catch(() => {});
      await claimant.end();
    }

    expect(firedForRule(await taskState(owner, taskId), ruleId)).toHaveLength(0);
    const retry = await runEscalationSweep({ now: CLOCK, limit: 10 });
    expect(retry.escalated).toBe(1);
    expect(firedForRule(await taskState(owner, taskId), ruleId)).toHaveLength(1);
  }, 60000);

  test('durable notification enqueue and the fired marker commit together', async () => {
    const rule = await owner.query(
      `INSERT INTO escalation_rules
         (tenant_id, display_name, scope, match_filter, trigger_condition,
          trigger_window_minutes, action_kind, action_payload, is_active)
       VALUES
         ($1::uuid, 'Post-commit lock release proof', 'task',
          jsonb_build_object('task_kind', 'general'), 'pending_too_long', 0,
          'notify', jsonb_build_object('tier', 2, 'notify_role', 'DUTY'), TRUE)
       RETURNING id`,
      [TENANT_ID],
    );
    const ruleId = rule.rows[0].id;
    const taskId = await insertTask(owner, { taskKind: 'general' });
    await owner.query(
      `INSERT INTO users
         (uid, phone, name, role, is_active, tenant_id, updated_at, last_sign_in_at)
       VALUES
         ('d6710000-0000-4000-8000-00000000fa01'::uuid, '+91970000fa01',
          'Post commit recipient', 'DUTY_DOCTOR', TRUE, $1::uuid, NOW(), NOW())`,
      [TENANT_ID],
    );

    queueNotificationMock.mockResolvedValueOnce({ id: 'durable-notification-1' });
    const result = await runEscalationSweep({ now: CLOCK, limit: 10 });
    expect(result.escalated).toBe(1);
    expect(firedForRule(await taskState(owner, taskId), ruleId)).toHaveLength(1);
    expect(queueNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        sourceEventKey: expect.stringMatching(
          new RegExp(`^workflow-escalation:${taskId}:${ruleId}:\\d+$`),
        ),
      }),
      expect.objectContaining({ strict: true }),
    );
  }, 60000);

  test('a child-documentation FK FOR KEY SHARE lock is compatible with the task claim', async () => {
    const ruleId = await insertRule(owner, {
      taskKind: 'admin',
      displayName: 'FK key-share compatibility proof',
    });
    const taskId = await insertTask(owner, { taskKind: 'admin' });
    const documentation = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    const warnSpy = jest.spyOn(logger, 'warn');
    await documentation.connect();
    await documentation.query('BEGIN');
    try {
      await documentation.query(
        `INSERT INTO task_comments (tenant_id, task_id, body, body_kind)
         VALUES ($1::uuid, $2::bigint, 'Active documentation proof', 'comment')`,
        [TENANT_ID, taskId],
      );

      await runEscalationSweep({ now: CLOCK, limit: 10 });
      const task = await taskState(owner, taskId);
      expect(firedForRule(task, ruleId)).toHaveLength(1);
      expect(task.priority).toBe('critical');
      expect(warnSpy).not.toHaveBeenCalledWith(
        'escalation sweep: eligible task claims skipped due to task-row contention',
        expect.objectContaining({ tenantId: TENANT_ID, ruleId }),
      );
    } finally {
      await documentation.query('ROLLBACK').catch(() => {});
      await documentation.end();
      warnSpy.mockRestore();
    }
  }, 60000);

  test('the reassign state-machine reread retains NO KEY UPDATE under an FK key-share lock', async () => {
    const ruleId = await insertRule(owner, {
      taskKind: 'admin',
      displayName: 'Reassign FK key-share compatibility proof',
      actionKind: 'reassign',
      actionPayload: { tier: 1, notify_role: 'DUTY' },
    });
    const taskId = await insertTask(owner, { taskKind: 'admin' });
    const documentation = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    const warnSpy = jest.spyOn(logger, 'warn');
    await documentation.connect();
    await documentation.query('BEGIN');
    let sweep;
    try {
      await documentation.query(
        `INSERT INTO task_comments (tenant_id, task_id, body, body_kind)
         VALUES ($1::uuid, $2::bigint, 'Active reassign documentation proof', 'comment')`,
        [TENANT_ID, taskId],
      );
      sweep = runEscalationSweep({ now: CLOCK, limit: 10 });
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('reassign claim blocked behind an FK key-share lock')),
          10000,
        );
        sweep.then((value) => {
          clearTimeout(timer);
          resolve(value);
        }, (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      const task = await taskState(owner, taskId);
      expect(result.escalated).toBe(1);
      expect(task.assigned_to_uid).toBeNull();
      expect(task.assigned_to_role).toBe('DUTY_DOCTOR');
      expect(firedForRule(task, ruleId)).toHaveLength(1);
      expect(warnSpy).not.toHaveBeenCalledWith(
        'escalation sweep: eligible task claims skipped due to task-row contention',
        expect.objectContaining({ tenantId: TENANT_ID, ruleId }),
      );
    } finally {
      await documentation.query('ROLLBACK').catch(() => {});
      await documentation.end();
      await sweep?.catch(() => {});
      warnSpy.mockRestore();
    }
  }, 60000);

  test('a conflicting task-row writer is skipped audibly and evaluated on the next sweep', async () => {
    const ruleId = await insertRule(owner, {
      taskKind: 'consent',
      displayName: 'Audible contention proof',
    });
    const taskId = await insertTask(owner, { taskKind: 'consent' });
    const writer = new Client({ connectionString: ownerDatabaseUrl(databaseUrl) });
    const warnSpy = jest.spyOn(logger, 'warn');
    const before = counterValue('vhhealth_escalation_candidate_lock_skipped_total', {
      trigger_condition: 'pending_too_long',
    });
    await writer.connect();
    await writer.query('BEGIN');
    try {
      await writer.query(
        'UPDATE tasks SET updated_at = updated_at WHERE tenant_id = $1::uuid AND id = $2::bigint',
        [TENANT_ID, taskId],
      );
      const skipped = await runEscalationSweep({ now: CLOCK, limit: 10 });
      const whileLocked = await taskState(owner, taskId);
      expect(skipped.scanned).toBeGreaterThanOrEqual(1);
      expect(firedForRule(whileLocked, ruleId)).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        'escalation sweep: eligible task claims skipped due to task-row contention',
        expect.objectContaining({
          tenantId: TENANT_ID,
          ruleId,
          triggerCondition: 'pending_too_long',
          skippedLocked: 1,
        }),
      );
      expect(counterValue('vhhealth_escalation_candidate_lock_skipped_total', {
        trigger_condition: 'pending_too_long',
      })).toBe(before + 1);
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      await writer.end();
      warnSpy.mockRestore();
    }

    await runEscalationSweep({ now: CLOCK, limit: 10 });
    const afterRelease = await taskState(owner, taskId);
    expect(firedForRule(afterRelease, ruleId)).toHaveLength(1);
    expect(afterRelease.priority).toBe('critical');
  }, 60000);
});

void jest;
