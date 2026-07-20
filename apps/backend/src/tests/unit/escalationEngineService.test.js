/**
 * escalationEngineService — runEscalationSweep unit tests.
 *
 * Drives the dormant-layer activation engine (design §4.3) without a live DB.
 * The engine evaluates active `escalation_rules` (scope='task') against
 * overdue tasks / breached mig-269 SLA instances and fires actions once per
 * tier, with a backfill backstop. The DB layer is mocked exactly like the
 * other workflow-service unit suites (taskService / resultsInboxService):
 * setTenantTx runs the callback with a fake tx whose $queryRawUnsafe /
 * $executeRawUnsafe are jest fns.
 *
 * Cases (design §4.3 + plan Task 2 step 1):
 *   1. marks an open task past due_at as 'overdue' (tenant-scoped UPDATE)
 *   2. sla_breach + tier-1 rule → escalate_priority bumps priority +
 *      re-notifies assignee + records metadata.escalations[{tier:1}]
 *   3. once-per-(task,rule): a second sweep does NOT re-fire (escalations
 *      already contains this rule_id)
 *   4. tier-2 notify → notificationOutbox.queue to the resolved DUTY role
 *   5. tier-3 notify + security_webhook → sendSecurityWebhook called
 *   6. acknowledged (in_progress) task is NOT escalated
 *   7. backfill: a breached critical SLA instance with no task → producer
 *      enqueueCriticalResultTask called once
 *   8. never throws: a per-task action error is logged + the sweep continues
 */

import { jest } from '@jest/globals';

// ── Mocks ────────────────────────────────────────────────────────────────
const queryRawMock = jest.fn();
const executeRawMock = jest.fn();
const fakeTx = { $queryRawUnsafe: queryRawMock, $executeRawUnsafe: executeRawMock };

const loggerErrorMock = jest.fn();
const loggerWarnMock = jest.fn();

const reassignTaskMock = jest.fn();
const transitionTaskMock = jest.fn();
const queueNotificationMock = jest.fn();
const sendSecurityWebhookMock = jest.fn();
const enqueueCriticalResultTaskMock = jest.fn();
const runTransportEscalationSweepMock = jest.fn(async () => ({ evaluated: 0, escalated: 0, outbox: 0 }));

// resolveRoleCode mirrors the REAL producer mapping (DUTY→DUTY_DOCTOR,
// LEADERSHIP→CMO). The producer's own unit suite locks that contract
// behaviourally; the engine simply reuses the exported function.
const resolveRoleCodeMock = jest.fn((hint) => {
  const token = hint == null ? '' : String(hint).trim();
  const map = { DUTY: 'DUTY_DOCTOR', LEADERSHIP: 'CMO' };
  if (!token) return 'DUTY_DOCTOR';
  return map[token] || token;
});

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryRawMock, $executeRawUnsafe: executeRawMock },
  setTenantTx: async (_tenantId, fn) => fn(fakeTx),
  setTenant: async (_tenantId, fn) => fn(fakeTx),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: loggerErrorMock, warn: loggerWarnMock, info: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  default: { reassignTask: reassignTaskMock, transitionTask: transitionTaskMock },
  reassignTask: reassignTaskMock,
  transitionTask: transitionTaskMock,
}));

jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  default: { queue: queueNotificationMock },
  notificationOutbox: { queue: queueNotificationMock },
  queue: queueNotificationMock,
}));

jest.unstable_mockModule('../../utils/securityWebhook.js', () => ({
  sendSecurityWebhook: sendSecurityWebhookMock,
}));

jest.unstable_mockModule('../../services/results/resultsInboxService.js', () => ({
  default: { enqueueCriticalResultTask: enqueueCriticalResultTaskMock, resolveRoleCode: resolveRoleCodeMock },
  enqueueCriticalResultTask: enqueueCriticalResultTaskMock,
  resolveRoleCode: resolveRoleCodeMock,
}));

jest.unstable_mockModule('../../services/patientFlow/porterTransportService.js', () => ({
  runTransportEscalationSweep: runTransportEscalationSweepMock,
}));

const { runEscalationSweep } = await import('../../services/workflow/escalationEngineService.js');

// ── Fixtures ───────────────────────────────────────────────────────────────
const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const CLINICIAN = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-06-15T12:00:00.000Z');

// A rule row as stored in escalation_rules (jsonb already parsed by pg).
function rule(extra = {}) {
  return {
    id: 5,
    tenant_id: TENANT,
    scope: 'task',
    match_filter: { task_kind: 'review', sla_key: 'critical_result_ack' },
    trigger_condition: 'sla_breach',
    trigger_window_minutes: 0,
    action_kind: 'escalate_priority',
    action_payload: { tier: 1, also_notify: 'assignee' },
    is_active: true,
    ...extra,
  };
}

// A candidate task row joined with its SLA-instance breach signal. The engine's
// candidate query returns these columns (task fields + breach_at + sla_status).
function task(extra = {}) {
  return {
    id: 77,
    tenant_id: TENANT,
    task_kind: 'review',
    title: 'Critical lab: Potassium',
    status: 'open',
    priority: 'high',
    patient_uid: PATIENT,
    assigned_to_uid: CLINICIAN,
    assigned_to_role: null,
    related_resource_type: 'lab_result',
    related_resource_id: '123',
    due_at: new Date('2026-06-15T11:30:00.000Z'),
    sla_breached_at: null,
    workflow_sla_instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    sla_completion_semantics: 'acknowledgement',
    metadata: { source: 'lab_result', sla_key: 'critical_result_ack' },
    // breach signal columns the engine's SELECT computes:
    sla_status: 'breached',
    sla_rule_code: 'critical_result_ack',
    breach_at: new Date('2026-06-15T11:45:00.000Z'),
    ...extra,
  };
}

// The engine performs, per tenant, in order:
//   q1: list distinct tenant ids with active task-scope rules  (singleton prisma)
//   then per tenant inside setTenantTx:
//     q2: UPDATE ... overdue-marking (returns affected rows)
//     q3: SELECT active rules
//     per rule: q4: SELECT candidate tasks
//     per fired task: $executeRawUnsafe metadata append
//     backfill: q5: SELECT orphan breached instances
// Tests stage queryRawMock results in that call order.

beforeEach(() => {
  queryRawMock.mockReset();
  executeRawMock.mockReset().mockResolvedValue(1);
  loggerErrorMock.mockReset();
  loggerWarnMock.mockReset();
  reassignTaskMock.mockReset();
  transitionTaskMock.mockReset();
  queueNotificationMock.mockReset().mockResolvedValue({ id: 1 });
  sendSecurityWebhookMock.mockReset();
  enqueueCriticalResultTaskMock.mockReset().mockResolvedValue({ created: true, taskId: 999 });
});

describe('runEscalationSweep', () => {
  it('marks open tasks past due_at as overdue (tenant-scoped UPDATE)', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }]) // q1 tenants
      .mockResolvedValueOnce([{ id: 77 }]) // q2 overdue-marking → 1 row
      .mockResolvedValueOnce([]) // q3 no active rules
      .mockResolvedValueOnce([]); // q5 backfill → none

    const res = await runEscalationSweep({ now: NOW });

    expect(res.markedOverdue).toBe(1);
    // The overdue-marking UPDATE flips open/blocked tasks past due_at — but NOT
    // in_progress (the acked state): flipping an acked task to the escalatable
    // 'overdue' status would re-expose it to escalation (§4.5 ack stops clock).
    const updateSql = queryRawMock.mock.calls[1][0];
    expect(updateSql).toMatch(/UPDATE\s+tasks/i);
    expect(updateSql).toMatch(/'overdue'/);
    expect(updateSql).toMatch(/due_at/i);
    expect(updateSql).not.toMatch(/'in_progress'/);
    expect(queryRawMock.mock.calls.some(([sql]) => /UPDATE\s+workflow_sla_instances/i.test(sql))).toBe(false);
  });

  it('sla_breach tier-1 → escalate_priority + re-notify assignee + records escalations[tier:1]', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }]) // q1 tenants
      .mockResolvedValueOnce([]) // q2 overdue-marking
      .mockResolvedValueOnce([rule()]) // q3 active rules → T1 escalate_priority
      .mockResolvedValueOnce([task()]) // q4 candidates for the rule
      // fireAction (audit C-3): T1 re-notify resolves the assignee uid → the
      // recipient row, then enqueues a per-recipient outbox row with a REAL id.
      .mockResolvedValueOnce([{ id: 42, uid: CLINICIAN, phone: '+919800000001', role: 'DOCTOR' }])
      .mockResolvedValueOnce([]); // q5 backfill

    const res = await runEscalationSweep({ now: NOW });

    expect(res.escalated).toBe(1);

    // priority bumped to critical via an UPDATE on the task (the metadata append
    // is the $executeRawUnsafe write). The escalations[] array is a bound
    // ::jsonb param (raw-param rules — not interpolated into SQL text).
    const appendSql = executeRawMock.mock.calls[0][0];
    const appendMetaParam = executeRawMock.mock.calls[0][1];
    expect(appendSql).toMatch(/UPDATE\s+tasks/i);
    expect(appendSql).toMatch(/metadata\s*=\s*\$1::jsonb/i);
    expect(appendSql).toMatch(/priority\s*=\s*'critical'/i);
    const appendMeta = JSON.parse(appendMetaParam);
    expect(appendMeta.escalations).toEqual([
      expect.objectContaining({ tier: 1, rule_id: 5, action: 'escalate_priority' }),
    ]);

    // also_notify:'assignee' → a notification to the RESOLVED assignee, carrying
    // the real integer recipientId (audit C-3: no null-recipient no-op).
    expect(queueNotificationMock).toHaveBeenCalledTimes(1);
    const note = queueNotificationMock.mock.calls[0][0];
    expect(note.recipientId).toBe(42);
    expect(String(note.body || note.title || '')).toMatch(/escalat|critical|review/i);
  });

  it('is idempotent: a task already escalated for this rule is NOT re-fired', async () => {
    const already = task({
      metadata: {
        source: 'lab_result', sla_key: 'critical_result_ack',
        escalations: [{ tier: 1, rule_id: 5, action: 'escalate_priority', at: '2026-06-15T11:46:00.000Z' }],
      },
    });
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }]) // q1 tenants
      .mockResolvedValueOnce([]) // q2 overdue-marking
      .mockResolvedValueOnce([rule()]) // q3 active rules
      .mockResolvedValueOnce([already]) // q4 candidate already has tier-1 for rule 5
      .mockResolvedValueOnce([]); // q5 backfill

    const res = await runEscalationSweep({ now: NOW });

    expect(res.escalated).toBe(0);
    expect(executeRawMock).not.toHaveBeenCalled(); // no metadata append
    expect(queueNotificationMock).not.toHaveBeenCalled();
  });

  it('tier-2 notify enqueues a notification to the resolved DUTY role', async () => {
    const t2 = rule({
      id: 6,
      trigger_window_minutes: 10,
      action_kind: 'notify',
      action_payload: { tier: 2, notify_role: 'DUTY' },
    });
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([t2])
      .mockResolvedValueOnce([task()]) // breach_at 11:45 + 10min = 11:55 < NOW 12:00 → fires
      // fireAction (audit C-3): notify resolves notify_role (DUTY→DUTY_DOCTOR) to
      // the active on-duty users via the EXACT-role query (non-empty → no family
      // fallback), then enqueues one outbox row per recipient with a real id.
      .mockResolvedValueOnce([{ id: 51, uid: '33333333-3333-4333-8333-333333333333', phone: '+919800000051', role: 'DUTY_DOCTOR' }])
      .mockResolvedValueOnce([]);

    const res = await runEscalationSweep({ now: NOW });

    expect(res.escalated).toBe(1);
    expect(resolveRoleCodeMock).toHaveBeenCalledWith('DUTY');
    // Resolved to a REAL recipient → exactly one outbox row, NON-NULL recipientId
    // (audit C-3: a DUTY tier reaches a human, not a null no-op).
    expect(queueNotificationMock).toHaveBeenCalledTimes(1);
    const note = queueNotificationMock.mock.calls[0][0];
    expect(note.recipientId).toBe(51);
    // role-targeted notification carries the resolved concrete role code.
    expect(JSON.stringify(note)).toMatch(/DUTY_DOCTOR/);
    // The empty-recipient fallback security webhook must NOT fire (we resolved one).
    expect(sendSecurityWebhookMock).not.toHaveBeenCalled();
    // metadata append records the tier-2 fire keyed to rule 6 (bound ::jsonb param).
    const meta = JSON.parse(executeRawMock.mock.calls[0][1]);
    expect(meta.escalations).toEqual([
      expect.objectContaining({ tier: 2, rule_id: 6, action: 'notify' }),
    ]);
  });

  it('tier-2 notify with NO resolvable recipient → pages via security webhook (never a silent no-op)', async () => {
    const t2 = rule({
      id: 6,
      trigger_window_minutes: 10,
      action_kind: 'notify',
      action_payload: { tier: 2, notify_role: 'DUTY' },
    });
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([t2])
      .mockResolvedValueOnce([task()])
      // Exact-role query → empty, family-fallback query → empty: the tenant has
      // no clinician in the role or its family.
      .mockResolvedValueOnce([]) // resolveRecipientsForRole exact
      .mockResolvedValueOnce([]) // resolveRecipientsForRole family fallback
      .mockResolvedValueOnce([]); // q5 backfill

    const res = await runEscalationSweep({ now: NOW });

    expect(res.escalated).toBe(1);
    // No outbox row (nobody to deliver to) — but the unstaffed-role escalation is
    // made LOUD via the security webhook so it is never an unheard no-op (C-3).
    expect(queueNotificationMock).not.toHaveBeenCalled();
    expect(sendSecurityWebhookMock).toHaveBeenCalledTimes(1);
    const [eventType] = sendSecurityWebhookMock.mock.calls[0];
    expect(eventType).toMatch(/CRITICAL_RESULT_UNACKED|UNACK/i);
  });

  it('does NOT fire a tier whose window has not elapsed since breach', async () => {
    const t3 = rule({
      id: 7,
      trigger_window_minutes: 30,
      action_kind: 'notify',
      action_payload: { tier: 3, notify_role: 'LEADERSHIP', security_webhook: true },
    });
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([t3])
      // breach_at 11:45 + 30min = 12:15 > NOW 12:00 → must NOT fire yet
      .mockResolvedValueOnce([task()])
      .mockResolvedValueOnce([]);

    const res = await runEscalationSweep({ now: NOW });

    expect(res.escalated).toBe(0);
    expect(sendSecurityWebhookMock).not.toHaveBeenCalled();
    expect(queueNotificationMock).not.toHaveBeenCalled();
  });

  it('tier-3 notify with security_webhook → sendSecurityWebhook fired', async () => {
    const t3 = rule({
      id: 7,
      trigger_window_minutes: 30,
      action_kind: 'notify',
      action_payload: { tier: 3, notify_role: 'LEADERSHIP', security_webhook: true },
    });
    // breach earlier so the 30-min window has elapsed by NOW.
    const breachedLongAgo = task({ breach_at: new Date('2026-06-15T11:00:00.000Z') });
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([t3])
      .mockResolvedValueOnce([breachedLongAgo])
      // notify resolves LEADERSHIP→CMO to a real recipient (exact-role query
      // non-empty → no family fallback), so the security webhook fires ONCE from
      // the rule's security_webhook flag — NOT from the empty-recipient path.
      .mockResolvedValueOnce([{ id: 61, uid: '44444444-4444-4444-8444-444444444444', phone: '+919800000061', role: 'CMO' }])
      .mockResolvedValueOnce([]);

    const res = await runEscalationSweep({ now: NOW });

    expect(res.escalated).toBe(1);
    expect(resolveRoleCodeMock).toHaveBeenCalledWith('LEADERSHIP');
    // The leadership tier reached a human (real recipientId) AND the loud final
    // signal fired exactly once (the rule flag, not a no-recipient fallback).
    expect(queueNotificationMock).toHaveBeenCalledTimes(1);
    expect(queueNotificationMock.mock.calls[0][0].recipientId).toBe(61);
    expect(sendSecurityWebhookMock).toHaveBeenCalledTimes(1);
    const [eventType] = sendSecurityWebhookMock.mock.calls[0];
    expect(eventType).toMatch(/CRITICAL_RESULT_UNACKED|UNACK/i);
  });

  it('auto_resolve action transitions the task to completed', async () => {
    const autoRule = rule({
      id: 9,
      match_filter: { task_kind: 'review' },
      action_kind: 'auto_resolve',
      action_payload: { tier: 1, reason: 'superseded' },
    });
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([autoRule])
      .mockResolvedValueOnce([task({
        workflow_sla_instance_id: null,
        sla_completion_semantics: 'none',
        sla_rule_code: null,
      })])
      .mockResolvedValueOnce([]);

    const res = await runEscalationSweep({ now: NOW });

    expect(res.autoResolved).toBe(1);
    expect(transitionTaskMock).toHaveBeenCalledTimes(1);
    expect(transitionTaskMock.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT, id: 77, nextStatus: 'completed',
    });
  });

  it('does NOT escalate an acknowledged (in_progress) task', async () => {
    // The candidate query must already exclude in_progress; assert by feeding a
    // rule but NO candidates (engine's SELECT filters acked tasks server-side).
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([rule()])
      .mockResolvedValueOnce([]) // q4 → engine SQL excluded the in_progress task
      .mockResolvedValueOnce([]);

    const res = await runEscalationSweep({ now: NOW });
    expect(res.escalated).toBe(0);
    // The candidate SELECT must exclude acked/terminal statuses.
    const candidateSql = queryRawMock.mock.calls[3][0];
    expect(candidateSql).toMatch(/status\s*=\s*'in_progress'[\s\S]+sla_completion_semantics\s*=\s*'domain_evidence'/i);
    expect(candidateSql).toMatch(/status\s+IN\s*\(/i);
    expect(candidateSql).toMatch(/s\.status\s*=\s*'active'[\s\S]+s\.due_at\s*<\s*\$2::timestamptz/i);
    expect(candidateSql).toMatch(/AND\s+s\.completed_at\s+IS\s+NULL\s+AND\s*\(/i);
  });

  it('keeps an acknowledged domain-evidence task eligible for escalation', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([rule()])
      .mockResolvedValueOnce([task({
        status: 'in_progress',
        sla_completion_semantics: 'domain_evidence',
      })])
      .mockResolvedValueOnce([{ id: 42, uid: CLINICIAN, phone: '+919800000001', role: 'DOCTOR' }])
      .mockResolvedValueOnce([]);

    const result = await runEscalationSweep({ now: NOW });

    expect(result.escalated).toBe(1);
    expect(queueNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the existing outward notification taxonomy for noncritical task rules', async () => {
    const mortuaryRule = rule({
      match_filter: { task_kind: 'review', sla_key: 'mortuary_unclaimed_body' },
      action_kind: 'notify',
      action_payload: { tier: 1, notify_role: 'MEDICAL_RECORDS' },
    });
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([mortuaryRule])
      .mockResolvedValueOnce([task({
        title: 'Unclaimed body custody follow-up',
        status: 'in_progress',
        sla_completion_semantics: 'domain_evidence',
        sla_rule_code: 'mortuary_unclaimed_body',
      })])
      .mockResolvedValueOnce([{
        id: 71,
        uid: '55555555-5555-4555-8555-555555555555',
        phone: '+919800000071',
        role: 'MEDICAL_RECORDS',
      }])
      .mockResolvedValueOnce([]);

    const result = await runEscalationSweep({ now: NOW });

    expect(result.escalated).toBe(1);
    expect(queueNotificationMock).toHaveBeenCalledWith(expect.objectContaining({
      recipientId: 71,
      title: 'Critical result escalation',
      body: expect.stringContaining('unacknowledged'),
      data: expect.objectContaining({
        kind: 'results_inbox_escalation',
        notify_role: 'MEDICAL_RECORDS',
      }),
    }));
    expect(JSON.stringify(queueNotificationMock.mock.calls[0][0]))
      .not.toMatch(/clinical_task_escalation|CLINICAL_TASK_UNACTIONED/);
  });

  it('backfill: a breached critical SLA instance with no task → producer called once', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }]) // q1 tenants
      .mockResolvedValueOnce([]) // q2 overdue-marking
      .mockResolvedValueOnce([]) // q3 no rules
      .mockResolvedValueOnce([ // q5 backfill: orphan breached instances
        {
          id: 'sla-orphan-1',
          tenant_id: TENANT,
          rule_code: 'critical_result_ack',
          patient_uid: PATIENT,
          source_table: 'lab_result',
          source_id: '456',
          priority: 'critical',
          metadata: { source: 'lab_result' },
        },
      ]);

    const res = await runEscalationSweep({ now: NOW });

    expect(res.backfilled).toBe(1);
    expect(enqueueCriticalResultTaskMock).toHaveBeenCalledTimes(1);
    const backfillSql = queryRawMock.mock.calls[3][0];
    expect(backfillSql).toMatch(/s\.completed_at\s+IS\s+NULL/i);
    expect(backfillSql).toMatch(/t\.status\s*<>\s*'cancelled'/i);
    expect(backfillSql).toMatch(/t2\.status\s*=\s*'completed'/i);
    expect(backfillSql).not.toMatch(/t2\.status\s+IN\s*\([^)]*'cancelled'/i);
    const arg = enqueueCriticalResultTaskMock.mock.calls[0][0];
    expect(arg).toMatchObject({
      tenantId: TENANT,
      patientUid: PATIENT,
      resourceType: 'lab_result',
      resourceId: '456',
    });
  });

  it('never throws: a per-task action error is logged and the sweep continues', async () => {
    const t1 = task({ id: 77 });
    const t2 = task({ id: 88, workflow_sla_instance_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([rule()])
      .mockResolvedValueOnce([t1, t2]) // two candidates
      .mockResolvedValueOnce([]);
    // First task's metadata append throws; second must still process.
    executeRawMock
      .mockRejectedValueOnce(new Error('deadlock detected'))
      .mockResolvedValueOnce(1);

    const res = await runEscalationSweep({ now: NOW });

    // The sweep did not abort: the second task was still escalated.
    expect(res.escalated).toBe(1);
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it('returns a zeroed counter set and does not throw when there are no tenants', async () => {
    queryRawMock.mockResolvedValueOnce([]); // q1 → no tenants with rules
    const res = await runEscalationSweep({ now: NOW });
    expect(res).toMatchObject({ scanned: 0, escalated: 0, autoResolved: 0, backfilled: 0 });
  });
});
