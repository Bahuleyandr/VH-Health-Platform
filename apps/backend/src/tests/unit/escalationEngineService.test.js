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

// The fan-out cap is resolved at module load, so overriding it BEFORE the import
// both shrinks these fixtures to something readable and proves the env knob is
// actually wired. The default (500) and the clamp are asserted separately below.
process.env.ESCALATION_RECIPIENT_FANOUT_CAP = '3';

const { runEscalationSweep, __testing__ } = await import('../../services/workflow/escalationEngineService.js');

// Unset it again the moment the constant has been captured. jest runs test files
// sequentially in ONE process (maxWorkers: 1 / --runInBand), so process.env
// mutations outlive the file that made them — left set, this would silently
// re-cap escalationRecipientFanout.deep.test.js at 3 and break assertions that
// have nothing to do with this suite.
delete process.env.ESCALATION_RECIPIENT_FANOUT_CAP;
// The metrics module is pure in-process counters with no DB or network, so it is
// deliberately NOT mocked: asserting on the real serializer proves the counter is
// actually wired to the scrape output, not merely that a spy was called.
const { serializeEscalationMetrics } = await import('../../observability/escalationMetrics.js');

const CAP = __testing__.RECIPIENT_FANOUT_CAP;

// Read one labelled counter out of the Prometheus exposition text. Counters are
// process-global and accumulate across tests in this file, so every assertion
// below is a before/after DELTA rather than an absolute value.
function counterValue(name, labels) {
  const labelPart = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
  const line = `${name}{${labelPart}}`;
  const match = serializeEscalationMetrics()
    .split('\n')
    .find((l) => l.startsWith(`${line} `));
  return match ? Number(match.slice(line.length + 1)) : 0;
}

// A page of resolved recipients as the engine's SELECT returns it: the page rows
// PLUS the COUNT(*) OVER () total that reports how many matched before LIMIT.
function recipientPage({ size, totalMatched, role }) {
  return Array.from({ length: size }, (_, i) => ({
    id: 1000 + i,
    uid: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
    phone: `+9198${String(i).padStart(8, '0')}`,
    role,
    total_matched: totalMatched,
  }));
}

function claimed(taskRow) {
  return [{ outcome: 'claimed', task: taskRow }];
}

const NO_RANKING = [{ ranking_control: null, observed_mapping_count: 0 }];

function queryCallMatching(pattern, index = 0) {
  return queryRawMock.mock.calls.filter(([sql]) => pattern.test(sql))[index];
}

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

describe('eligibility semantic mirror', () => {
  it('preserves exact task-kind, priority, and SLA-key match semantics', () => {
    const row = task({ task_kind: 'review', priority: 'high', sla_rule_code: 'critical_result_ack' });
    expect(__testing__.matchesFilter(row, {})).toBe(true);
    expect(__testing__.matchesFilter(row, {
      task_kind: 'review', priority: 'high', sla_key: 'critical_result_ack',
    })).toBe(true);
    expect(__testing__.matchesFilter(row, { task_kind: 'Review' })).toBe(false);
    expect(__testing__.matchesFilter(row, { priority: 'critical' })).toBe(false);
    expect(__testing__.matchesFilter(row, { sla_key: 'other' })).toBe(false);
    expect(__testing__.matchesFilter({ ...row, sla_rule_code: null }, { sla_key: 'null' }))
      .toBe(false);
  });

  it('keeps pending and SLA trigger windows inclusive at the captured-clock boundary', () => {
    const pendingRule = rule({ trigger_condition: 'pending_too_long', trigger_window_minutes: 10 });
    expect(__testing__.triggerHolds(task({
      created_at: new Date(NOW.getTime() - 10 * 60_000),
    }), pendingRule, NOW)).toBe(true);
    expect(__testing__.triggerHolds(task({
      created_at: new Date(NOW.getTime() - 10 * 60_000 + 1),
    }), pendingRule, NOW)).toBe(false);

    const slaRule = rule({ trigger_condition: 'sla_breach', trigger_window_minutes: 10 });
    expect(__testing__.triggerHolds(task({
      breach_at: new Date(NOW.getTime() - 10 * 60_000),
    }), slaRule, NOW)).toBe(true);
    expect(__testing__.triggerHolds(task({
      breach_at: new Date(NOW.getTime() - 10 * 60_000 + 1),
    }), slaRule, NOW)).toBe(false);
  });

  it('recognizes a fired marker only for the same numeric rule identity', () => {
    const metadata = { escalations: [{ rule_id: '5' }, { rule_id: 8 }] };
    expect(__testing__.alreadyFired(metadata, 5)).toBe(true);
    expect(__testing__.alreadyFired(metadata, '8')).toBe(true);
    expect(__testing__.alreadyFired(metadata, 9)).toBe(false);
    expect(__testing__.alreadyFired({ escalations: null }, 5)).toBe(false);
  });
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
    // The overdue-marking UPDATE flips ONLY open tasks past due_at. Not
    // in_progress (the acked state — re-flipping would re-expose acked work to
    // escalation, §4.5), and not blocked: blocked→overdue is no TASK_TRANSITIONS
    // edge, and overdue→completed is, so the flip would let blocked work be
    // completed without ever unblocking. Blocked tasks still escalate via the
    // candidate SQL's own status list.
    const updateSql = queryRawMock.mock.calls[1][0];
    expect(updateSql).toMatch(/UPDATE\s+tasks/i);
    expect(updateSql).toMatch(/status = 'open'/);
    expect(updateSql).toMatch(/'overdue'/);
    expect(updateSql).toMatch(/due_at/i);
    expect(updateSql).not.toMatch(/'in_progress'/);
    expect(updateSql).not.toMatch(/'blocked'/);
    expect(queryRawMock.mock.calls.some(([sql]) => /UPDATE\s+workflow_sla_instances/i.test(sql))).toBe(false);
  });

  it('skips a rule whose action_kind has no executor without consuming the tier', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }]) // q1 tenants
      .mockResolvedValueOnce([]) // q2 overdue-marking
      .mockResolvedValueOnce([rule({ action_kind: 'webhook' })]) // q3 active rules
      .mockResolvedValueOnce([]); // q5 backfill

    const res = await runEscalationSweep({ now: NOW });

    expect(res.escalated).toBe(0);
    expect(res.scanned).toBe(0);
    // No candidate paging, no claim, and above all NO fired marker: the tier
    // stays live instead of being silently swallowed by a no-op action.
    expect(queryRawMock.mock.calls.some(([sql]) => /FROM tasks t\s/i.test(sql))).toBe(false);
    expect(executeRawMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('no executor'),
      expect.objectContaining({ tenantId: TENANT, ruleId: 5, actionKind: 'webhook' }),
    );
  });

  it('pins the executable action kinds to the CRUD activation gate', () => {
    // taskService.test.js pins ENGINE_EXECUTABLE_ESCALATION_ACTIONS to the same
    // list from the CRUD side; together the two assertions catch drift.
    expect([...__testing__.ENGINE_SUPPORTED_ACTION_KINDS].sort()).toEqual(
      ['auto_resolve', 'escalate_priority', 'notify', 'reassign'],
    );
    expect(Object.isFrozen(__testing__.ENGINE_SUPPORTED_ACTION_KINDS)).toBe(true);
    expect(() => __testing__.ENGINE_SUPPORTED_ACTION_KINDS.push('webhook')).toThrow(TypeError);
  });

  it('sla_breach tier-1 → escalate_priority + re-notify assignee + records escalations[tier:1]', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }]) // q1 tenants
      .mockResolvedValueOnce([]) // q2 overdue-marking
      .mockResolvedValueOnce([rule()]) // q3 active rules → T1 escalate_priority
      .mockResolvedValueOnce([task()]) // q4 candidates for the rule
      .mockResolvedValueOnce(claimed(task())) // Phase 1 one-task claim
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

  it.each([
    {
      label: 'OP-to-inpatient review task',
      taskKind: 'op_to_inpatient_transfer_review',
      relatedResourceType: 'care_handoff_instance',
      taskContract: 'op_to_inpatient_transfer_review_v1',
    },
    {
      label: 'covering-transfer review task',
      taskKind: 'pathway_owner_transfer_review',
      relatedResourceType: 'care_handoff_instance',
      taskContract: 'covering_clinician_transfer_review_v1',
    },
    {
      label: 'pending-result tracking task',
      taskKind: 'follow_up',
      relatedResourceType: 'discharge_pending_result_handoff',
      taskContract: 'discharge_pending_result_tracking_v1',
    },
    {
      label: 'pending-result owner-action task',
      taskKind: 'review',
      relatedResourceType: 'discharge_pending_result_action',
      taskContract: 'discharge_pending_result_action_v1',
    },
  ])('broad pending_too_long priority rules cannot rewrite a $label', async ({
    taskKind,
    relatedResourceType,
    taskContract,
  }) => {
    const broadRule = rule({
      match_filter: {},
      trigger_condition: 'pending_too_long',
      trigger_window_minutes: 1,
    });
    const protectedTask = task({
      task_kind: taskKind,
      title: 'Review protected S4 work',
      priority: 'normal',
      related_resource_type: relatedResourceType,
      related_resource_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      due_at: null,
      workflow_sla_instance_id: null,
      sla_completion_semantics: 'none',
      sla_rule_code: null,
      breach_at: null,
      created_at: new Date('2026-06-15T11:00:00.000Z'),
      metadata: { task_contract: taskContract },
    });
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([broadRule])
      .mockResolvedValueOnce([protectedTask])
      .mockResolvedValueOnce(claimed(protectedTask))
      .mockResolvedValueOnce([]);

    const result = await runEscalationSweep({ now: NOW });

    expect(result).toMatchObject({ scanned: 1, escalated: 0 });
    expect(executeRawMock).not.toHaveBeenCalled();
    expect(queueNotificationMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'escalation sweep: per-task atomic action failed',
      expect.objectContaining({ tenantId: TENANT, taskId: 77, ruleId: 5 }),
    );
  });

  it('keeps priority escalation available for ordinary pathway-owned tasks', async () => {
    const broadRule = rule({
      match_filter: { task_kind: 'follow_up' },
      trigger_condition: 'pending_too_long',
      trigger_window_minutes: 1,
      action_payload: { tier: 1 },
    });
    const pathwayTask = task({
      task_kind: 'follow_up',
      priority: 'normal',
      related_resource_type: 'care_pathway_instance',
      related_resource_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      due_at: null,
      workflow_run_id: 17,
      workflow_step_id: 171,
      workflow_sla_instance_id: null,
      sla_completion_semantics: 'none',
      sla_rule_code: null,
      breach_at: null,
      created_at: new Date('2026-06-15T11:00:00.000Z'),
      metadata: {
        stage_key: 'recover_unattended_visit',
        materialization_kind: 'task',
      },
    });
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([broadRule])
      .mockResolvedValueOnce([pathwayTask])
      .mockResolvedValueOnce(claimed(pathwayTask))
      .mockResolvedValueOnce([]);

    const result = await runEscalationSweep({ now: NOW });

    expect(result.escalated).toBe(1);
    expect(executeRawMock).toHaveBeenCalledTimes(1);
    expect(executeRawMock.mock.calls[0][0]).toMatch(/priority\s*=\s*'critical'/i);
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
      .mockResolvedValueOnce([]) // SQL excludes the already-fired marker before LIMIT
      .mockResolvedValueOnce([]); // q5 backfill

    const res = await runEscalationSweep({ now: NOW });

    expect(res.escalated).toBe(0);
    expect(executeRawMock).not.toHaveBeenCalled(); // no metadata append
    expect(queueNotificationMock).not.toHaveBeenCalled();
    expect(queryRawMock.mock.calls[3][0]).toMatch(/NOT EXISTS[\s\S]+rule_id[\s\S]+LIMIT/i);
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
      .mockResolvedValueOnce(claimed(task()))
      .mockResolvedValueOnce(NO_RANKING)
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

  it('does not consume the once-only tier when the durable enqueue is not confirmed', async () => {
    const t2 = rule({
      id: 6,
      trigger_window_minutes: 10,
      action_kind: 'notify',
      action_payload: { tier: 2, notify_role: 'DUTY' },
    });
    queueNotificationMock.mockResolvedValueOnce(null);
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([t2])
      .mockResolvedValueOnce([task()])
      .mockResolvedValueOnce(claimed(task()))
      .mockResolvedValueOnce(NO_RANKING)
      .mockResolvedValueOnce([{
        id: 51,
        uid: '33333333-3333-4333-8333-333333333333',
        phone: '+919800000051',
        role: 'DUTY_DOCTOR',
      }])
      .mockResolvedValueOnce([]);

    const result = await runEscalationSweep({ now: NOW });

    expect(result.escalated).toBe(0);
    expect(queueNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: 51, tenantId: TENANT }),
      expect.objectContaining({ strict: true }),
    );
    expect(executeRawMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'escalation sweep: per-task atomic action failed',
      expect.objectContaining({ tenantId: TENANT, taskId: 77, ruleId: 6 }),
    );
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
      .mockResolvedValueOnce(claimed(task()))
      .mockResolvedValueOnce(NO_RANKING)
      // Exact-role query → empty, family-fallback query → empty: the tenant has
      // no clinician in the role or its family.
      .mockResolvedValueOnce([]) // resolveRecipientsForRole exact
      .mockResolvedValueOnce([]) // resolveRecipientsForRole family fallback
      .mockResolvedValueOnce([]); // q5 backfill

    const res = await runEscalationSweep({ now: NOW });

    expect(res.escalated).toBe(0);
    // No outbox row (nobody to deliver to) — but the unstaffed-role escalation is
    // made LOUD via the security webhook, and the once-only tier remains live.
    expect(queueNotificationMock).not.toHaveBeenCalled();
    expect(executeRawMock).not.toHaveBeenCalled();
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
      // SQL excludes the task because its 30-minute window has not elapsed.
      .mockResolvedValueOnce([])
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
      .mockResolvedValueOnce(claimed(breachedLongAgo))
      .mockResolvedValueOnce(NO_RANKING)
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
      .mockResolvedValueOnce(claimed(task({
        workflow_sla_instance_id: null,
        sla_completion_semantics: 'none',
        sla_rule_code: null,
      })))
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
      .mockResolvedValueOnce(claimed(task({
        status: 'in_progress',
        sla_completion_semantics: 'domain_evidence',
      })))
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
      .mockResolvedValueOnce(claimed(task({
        title: 'Unclaimed body custody follow-up',
        status: 'in_progress',
        sla_completion_semantics: 'domain_evidence',
        sla_rule_code: 'mortuary_unclaimed_body',
      })))
      .mockResolvedValueOnce(NO_RANKING)
      .mockResolvedValueOnce([{
        id: 71,
        uid: '55555555-5555-4555-8555-555555555555',
        phone: '+919800000071',
        role: 'MEDICAL_RECORDS',
      }])
      .mockResolvedValueOnce([]);

    const result = await runEscalationSweep({ now: NOW });

    expect(result.escalated).toBe(1);
    expect(queueNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: 71,
        title: 'Critical result escalation',
        body: expect.stringContaining('unacknowledged'),
        data: expect.objectContaining({
          kind: 'results_inbox_escalation',
          notify_role: 'MEDICAL_RECORDS',
        }),
      }),
      expect.objectContaining({ strict: true }),
    );
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
    const backfillSql = queryCallMatching(/FROM workflow_sla_instances s/)[0];
    expect(backfillSql).toMatch(/s\.completed_at\s+IS\s+NULL/i);
    expect(backfillSql).toMatch(/task\.status\s*<>\s*'cancelled'/i);
    expect(backfillSql).toMatch(/completed_task\.status\s*=\s*'completed'/i);
    expect(backfillSql).not.toMatch(/completed_task\.status\s+IN\s*\([^)]*'cancelled'/i);
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
      .mockResolvedValueOnce(claimed(t1))
      .mockResolvedValueOnce([{ id: 42, uid: CLINICIAN, phone: '+919800000001', role: 'DOCTOR' }])
      .mockResolvedValueOnce(claimed(t2))
      .mockResolvedValueOnce([{ id: 42, uid: CLINICIAN, phone: '+919800000001', role: 'DOCTOR' }])
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

describe('shared SQL-complete eligibility and one-task claim shape', () => {
  it.each([
    ['sla_breach', { task_kind: 'review', priority: 'critical', sla_key: 'critical_result_ack' }],
    ['pending_too_long', { task_kind: 'follow_up', priority: 'high' }],
  ])('keeps %s filters, window, and fired marker before Phase-0 LIMIT', async (
    triggerCondition,
    matchFilter,
  ) => {
    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([]) };
    await __testing__.readEligibleCandidatePage(tx, {
      tenantId: TENANT,
      ruleRow: rule({ trigger_condition: triggerCondition, match_filter: matchFilter }),
      clock: NOW,
      cap: 17,
    });
    const [sql, ...params] = tx.$queryRawUnsafe.mock.calls[0];
    const limitAt = sql.indexOf('LIMIT $8::int');
    expect(limitAt).toBeGreaterThan(0);
    for (const predicate of ['$4::text', '$5::text', '$6::text', 'make_interval', 'NOT EXISTS']) {
      expect(sql.indexOf(predicate)).toBeGreaterThan(0);
      expect(sql.indexOf(predicate)).toBeLessThan(limitAt);
    }
    expect(sql).not.toMatch(/FOR\s+(UPDATE|NO KEY UPDATE)/i);
    expect(params).toHaveLength(8);
    expect(params.at(-1)).toBe(17);
  });

  it('reuses the eligibility fragment in both Phase-1 arms and locks only one task', async () => {
    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([{ outcome: 'stale', task: null }]) };
    await __testing__.claimEligibleCandidate(tx, {
      tenantId: TENANT,
      taskId: 77,
      ruleRow: rule(),
      clock: NOW,
    });
    const [sql, ...params] = tx.$queryRawUnsafe.mock.calls[0];
    expect((sql.match(/NOT EXISTS \(/g) || []).length).toBeGreaterThanOrEqual(3);
    expect((sql.match(/make_interval\(mins => \$3::int\)/g) || [])).toHaveLength(2);
    expect((sql.match(/t\.id = \$8::bigint/g) || [])).toHaveLength(2);
    expect(sql).toMatch(/FOR NO KEY UPDATE OF t SKIP LOCKED/i);
    expect(sql).not.toMatch(/FOR UPDATE/i);
    expect(params.at(-1)).toBe(77);
  });

  it('prevents taskService from upgrading the claimed task to FOR UPDATE', async () => {
    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValue([]) };
    const taskMutationTx = __testing__.noKeyUpdateTaskMutationTx(tx);
    await taskMutationTx.$queryRawUnsafe(
      `SELECT id, tenant_id FROM tasks
        WHERE id = $1 AND tenant_id = $2::uuid
        FOR UPDATE`,
      77,
      TENANT,
    );
    await taskMutationTx.$queryRawUnsafe(
      `SELECT id FROM workflow_sla_instances
        WHERE id = $1::uuid
        FOR UPDATE`,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );

    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toMatch(/FOR NO KEY UPDATE$/i);
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).not.toMatch(/FOR UPDATE$/i);
    expect(tx.$queryRawUnsafe.mock.calls[1][0]).toMatch(/FOR UPDATE$/i);
  });

  it('treats a stale Phase-0 candidate as a no-op without a lock-skip signal', async () => {
    const before = counterValue('vhhealth_escalation_candidate_lock_skipped_total', {
      trigger_condition: 'pending_too_long',
    });
    const pendingRule = rule({
      trigger_condition: 'pending_too_long',
      trigger_window_minutes: 0,
      match_filter: { task_kind: 'review' },
    });
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([pendingRule])
      .mockResolvedValueOnce([task()])
      .mockResolvedValueOnce([{ outcome: 'stale', task: null }])
      .mockResolvedValueOnce([]);

    const result = await runEscalationSweep({ now: NOW });

    expect(result).toMatchObject({ scanned: 1, escalated: 0, autoResolved: 0 });
    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      'escalation sweep: eligible task claims skipped due to task-row contention',
      expect.anything(),
    );
    expect(counterValue('vhhealth_escalation_candidate_lock_skipped_total', {
      trigger_condition: 'pending_too_long',
    })).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Recipient fan-out honesty.
//
// Before this change both arms of resolveRecipientsForRole ended in a bare
// `LIMIT 50` with `ORDER BY id`: recipient 51+ was dropped from a critical-result
// page with no warning, no metric, and no clinically meaningful ordering to say
// WHICH 50 survived. Dropping staff from a critical-result escalation is
// clinical-safety-adjacent, so the cap is now named + configurable, the order is
// a documented availability proxy, and every trim is logged AND counted.
// ---------------------------------------------------------------------------

const TRIM_METRIC = 'vhhealth_escalation_recipients_trimmed_total';
const PAGE_FULL_METRIC = 'vhhealth_escalation_candidate_page_full_total';
const TRIM_WARNING = 'escalation notify: recipient fan-out exceeded cap — tail of the role was NOT notified';

// A tier-2 notify rule whose window has elapsed by NOW — the shortest path to
// exercising resolveRecipientsForRole through the real sweep.
function notifyRule(extra = {}) {
  return rule({
    id: 6,
    trigger_window_minutes: 10,
    action_kind: 'notify',
    action_payload: { tier: 2, notify_role: 'DUTY' },
    ...extra,
  });
}

describe('escalation recipient fan-out cap', () => {
  it('pages with the configured cap, not a hardcoded 50, ordered by a documented availability proxy', async () => {
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([notifyRule()])
      .mockResolvedValueOnce([task()])
      .mockResolvedValueOnce(claimed(task()))
      .mockResolvedValueOnce(NO_RANKING)
      .mockResolvedValueOnce(recipientPage({ size: 1, totalMatched: 1, role: 'DUTY_DOCTOR' }))
      .mockResolvedValueOnce([]);

    await runEscalationSweep({ now: NOW });

    const [sql, , , boundCap] = queryCallMatching(/FROM users[\s\S]+role = \$2/);
    // The magic number is gone and the bound is a real parameter.
    expect(sql).not.toMatch(/LIMIT\s+50\b/i);
    expect(sql).toMatch(/LIMIT\s+\$3::int/i);
    expect(boundCap).toBe(CAP);
    // COUNT(*) OVER () is evaluated before LIMIT, so it reports the TRUE match
    // count — that is what makes the dropped count exact rather than a guess.
    expect(sql).toMatch(/COUNT\(\*\)\s+OVER\s*\(\)\s+AS\s+total_matched/i);
    // Never-signed-in accounts sort last, so a trim sheds the least reachable
    // clinicians first; id ASC makes the order total and therefore deterministic.
    expect(sql).toMatch(/ORDER BY\s+last_sign_in_at\s+DESC\s+NULLS\s+LAST,\s*id\s+ASC/i);
    expect(sql).not.toMatch(/ORDER BY\s+id\s*\n/i);
  });

  it('exact-role arm over the cap → warns with the exact dropped count and counts the trim', async () => {
    const dropped = 7;
    const before = counterValue(TRIM_METRIC, { role: 'DUTY_DOCTOR', arm: 'exact' });
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([notifyRule()])
      .mockResolvedValueOnce([task()])
      .mockResolvedValueOnce(claimed(task()))
      .mockResolvedValueOnce(NO_RANKING)
      // A full page (LIMIT CAP returned CAP rows) while CAP + 7 users matched.
      .mockResolvedValueOnce(recipientPage({
        size: CAP, totalMatched: CAP + dropped, role: 'DUTY_DOCTOR',
      }))
      .mockResolvedValueOnce([]);

    const res = await runEscalationSweep({ now: NOW });

    // The tier still fires and still pages everyone it could.
    expect(res.escalated).toBe(1);
    expect(queueNotificationMock).toHaveBeenCalledTimes(CAP);

    // ...but the seven it could NOT page are stated, not inferred from silence.
    expect(loggerWarnMock).toHaveBeenCalledWith(TRIM_WARNING, expect.objectContaining({
      tenantId: TENANT,
      role: 'DUTY_DOCTOR',
      arm: 'exact',
      matched: CAP + dropped,
      notified: CAP,
      dropped,
      cap: CAP,
    }));
    expect(counterValue(TRIM_METRIC, { role: 'DUTY_DOCTOR', arm: 'exact' }))
      .toBe(before + dropped);
  });

  it('family-fallback arm over the cap → warns and counts under the family arm label', async () => {
    const dropped = 5;
    const before = counterValue(TRIM_METRIC, { role: 'DUTY_DOCTOR', arm: 'family' });
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([notifyRule()])
      .mockResolvedValueOnce([task()])
      .mockResolvedValueOnce(claimed(task()))
      .mockResolvedValueOnce(NO_RANKING)
      // Nobody holds DUTY_DOCTOR exactly → widen to DOCTOR_TIERS, which overflows.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(recipientPage({
        size: CAP, totalMatched: CAP + dropped, role: 'DOCTOR',
      }))
      .mockResolvedValueOnce([]);

    await runEscalationSweep({ now: NOW });

    expect(loggerWarnMock).toHaveBeenCalledWith(TRIM_WARNING, expect.objectContaining({
      role: 'DUTY_DOCTOR', arm: 'family', dropped,
    }));
    expect(counterValue(TRIM_METRIC, { role: 'DUTY_DOCTOR', arm: 'family' }))
      .toBe(before + dropped);
    // The widened query is capped and ordered identically to the exact arm.
    const [familySql, , , boundCap] = queryCallMatching(/role\s*=\s*ANY\(\$2::text\[\]\)/i);
    expect(familySql).toMatch(/role\s*=\s*ANY\(\$2::text\[\]\)/i);
    expect(familySql).not.toMatch(/LIMIT\s+50\b/i);
    expect(boundCap).toBe(CAP);
  });

  it('a role that fits under the cap is delivered whole, with no warning and no metric movement', async () => {
    const before = counterValue(TRIM_METRIC, { role: 'DUTY_DOCTOR', arm: 'exact' });
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([notifyRule()])
      .mockResolvedValueOnce([task()])
      .mockResolvedValueOnce(claimed(task()))
      .mockResolvedValueOnce(NO_RANKING)
      .mockResolvedValueOnce(recipientPage({ size: 3, totalMatched: 3, role: 'DUTY_DOCTOR' }))
      .mockResolvedValueOnce([]);

    await runEscalationSweep({ now: NOW });

    expect(queueNotificationMock).toHaveBeenCalledTimes(3);
    expect(loggerWarnMock).not.toHaveBeenCalledWith(TRIM_WARNING, expect.anything());
    expect(counterValue(TRIM_METRIC, { role: 'DUTY_DOCTOR', arm: 'exact' })).toBe(before);
  });

  it('a full candidate-task page is reported, because tasks behind it go unevaluated', async () => {
    // The candidate page is ordered by a stable t.id ASC and the once-per-rule
    // guard runs in JS AFTER the page is fetched, so already-fired tasks keep
    // their slots: a tenant sitting on `limit` escalatable tasks starves
    // everything behind them rather than deferring it to the next sweep.
    const limit = 2;
    const before = counterValue(PAGE_FULL_METRIC, { trigger_condition: 'sla_breach' });
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([notifyRule()])
      .mockResolvedValueOnce([task({ id: 77 }), task({ id: 78 })]) // page came back FULL
      .mockResolvedValueOnce(claimed(task({ id: 77 })))
      .mockResolvedValueOnce(NO_RANKING)
      .mockResolvedValueOnce(recipientPage({ size: 1, totalMatched: 1, role: 'DUTY_DOCTOR' }))
      .mockResolvedValueOnce(claimed(task({ id: 78 })))
      .mockResolvedValueOnce(NO_RANKING)
      .mockResolvedValueOnce(recipientPage({ size: 1, totalMatched: 1, role: 'DUTY_DOCTOR' }))
      .mockResolvedValueOnce([]);

    await runEscalationSweep({ now: NOW, limit });

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'escalation sweep: candidate page full — tasks beyond the page were NOT evaluated',
      expect.objectContaining({ tenantId: TENANT, ruleId: 6, triggerCondition: 'sla_breach', cap: limit }),
    );
    expect(counterValue(PAGE_FULL_METRIC, { trigger_condition: 'sla_breach' })).toBe(before + 1);
  });

  it('a page with no total_matched column reports nothing dropped', async () => {
    // Every pre-existing case in this file mocks the resolver query and returns
    // rows WITHOUT the COUNT(*) OVER () column. Those pages were never truncated,
    // so the correct answer is "nothing dropped" — this pins that the fallback
    // cannot start manufacturing phantom warnings on a partial row shape.
    const before = counterValue(TRIM_METRIC, { role: 'DUTY_DOCTOR', arm: 'exact' });
    queryRawMock
      .mockResolvedValueOnce([{ tenant_id: TENANT }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([notifyRule()])
      .mockResolvedValueOnce([task()])
      .mockResolvedValueOnce(claimed(task()))
      .mockResolvedValueOnce(NO_RANKING)
      .mockResolvedValueOnce([{ id: 51, uid: CLINICIAN, phone: '+919800000051', role: 'DUTY_DOCTOR' }])
      .mockResolvedValueOnce([]);

    await runEscalationSweep({ now: NOW });

    expect(queueNotificationMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).not.toHaveBeenCalledWith(TRIM_WARNING, expect.anything());
    expect(counterValue(TRIM_METRIC, { role: 'DUTY_DOCTOR', arm: 'exact' })).toBe(before);
  });

  it('honours the ESCALATION_RECIPIENT_FANOUT_CAP override set before module load', () => {
    expect(CAP).toBe(3);
  });

  it('clampFanoutCap defaults, clamps to the ceiling, and rejects nonsense', () => {
    const { clampFanoutCap } = __testing__;
    expect(clampFanoutCap('250')).toBe(250);
    expect(clampFanoutCap(undefined)).toBe(500); // documented default
    expect(clampFanoutCap('')).toBe(500);
    expect(clampFanoutCap('not-a-number')).toBe(500);
    expect(clampFanoutCap('0')).toBe(500);
    expect(clampFanoutCap('-5')).toBe(500);
    expect(clampFanoutCap('999999')).toBe(5000); // ceiling
  });
});
