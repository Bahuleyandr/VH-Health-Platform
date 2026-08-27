/**
 * Phase B2 — taskService unit tests.
 *
 * Drives validation, the task state machine, workflow run/step
 * lifecycle, approval quorum logic, and CRUD on escalation / SLA /
 * automation rules without a live DB.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const executeUnsafeMock = jest.fn();
const lockPathwayRuntimeTxMock = jest.fn();
const resolveCurrentHumanActorTxMock = jest.fn();
const PATHWAY_TEST_CAPABILITY = Object.freeze({ kind: 'test_pathway_executor_capability' });

const __prismaDefaultMock = {
  $queryRawUnsafe: queryUnsafeMock,
  $executeRawUnsafe: executeUnsafeMock,
  __tenantTransaction: true,
};
const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn(__prismaDefaultMock));

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: __prismaDefaultMock,
  setTenantTx: setTenantTxMock,
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
  isTenantTransactionClient: (value) => value?.__tenantTransaction === true,
}));

jest.unstable_mockModule('../../services/pathways/pathwayRuntimePersistence.js', () => ({
  lockPathwayRuntimeTx: lockPathwayRuntimeTxMock,
}));

jest.unstable_mockModule('../../services/pathways/pathwayExecutorService.js', () => ({
  isPathwayExecutorCapability: (value) => value === PATHWAY_TEST_CAPABILITY,
}));

jest.unstable_mockModule('../../services/workflow/workflowHumanOwnerService.js', () => ({
  isTaskHumanOwnerRole: () => true,
  resolveCurrentHumanActorTx: resolveCurrentHumanActorTxMock,
}));

const {
  acknowledgeColdChainTaskFromTrustedWorkflow,
  acknowledgeLabCriticalAlertTaskFromTrustedWorkflow,
  acknowledgeTask,
  claimInboxTask,
  completePathwayTaskFromRegisteredCondition,
  completePathwayTaskFromRegisteredEvidence,
  completeTaskFromDomainEvidence,
  createApproval,
  createCoveringTransferReviewTaskTx,
  createLabThresholdExceptionReviewTaskTx,
  createTask,
  createWardMedicationObligationTaskTx,
  createWorkflowDefinition,
  getTask,
  listApprovals,
  listAutomationRules,
  listEscalationRules,
  listInboxTasks,
  listSlaDefinitions,
  listTasks,
  listWorkflowDefinitions,
  listWorkflowRuns,
  listWorkflowSteps,
  postTaskComment,
  reassignTask,
  recordApprovalDecision,
  startWorkflowRun,
  supersedeAcknowledgementTaskFromTrustedWorkflow,
  transitionTask,
  transitionWorkflowRun,
  transitionWorkflowStep,
  upsertAutomationRule,
  upsertEscalationRule,
  upsertSlaDefinition,
  ENGINE_EVALUATED_ESCALATION_SCOPES,
  ENGINE_EVALUATED_ESCALATION_TRIGGERS,
  ENGINE_EXECUTABLE_ESCALATION_ACTIONS,
  __testing__,
} = await import('../../services/workflow/taskService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const USER = '11111111-1111-4111-8111-111111111111';
const APPROVER_A = '22222222-2222-4222-8222-222222222222';
const APPROVER_B = '33333333-3333-4333-8333-333333333333';
const DEFAULT_SLA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACK_RESOURCE = Object.freeze({
  related_resource_type: 'lab_result',
  related_resource_id: '1',
});
const ackSlaRow = (overrides = {}) => ({
  id: DEFAULT_SLA_ID,
  rule_code: 'critical_result_ack',
  source_table: 'lab_result',
  source_id: '1',
  due_at: new Date('2026-07-19T06:00:00.000Z'),
  ...overrides,
});
const mortuarySlaRow = (overrides = {}) => ({
  id: DEFAULT_SLA_ID,
  rule_code: 'mortuary_unclaimed_body',
  source_table: 'death_records',
  source_id: '55',
  due_at: new Date('2026-07-19T06:00:00.000Z'),
  ...overrides,
});

beforeEach(() => {
  queryUnsafeMock.mockReset();
  executeUnsafeMock.mockReset().mockResolvedValue(1);
  setTenantTxMock.mockClear();
  lockPathwayRuntimeTxMock.mockReset();
  resolveCurrentHumanActorTxMock.mockReset();
  resolveCurrentHumanActorTxMock.mockImplementation(async ({
    actorUid, authenticatedRoles, authenticatedPrimaryRole,
  }) => ({
    uid: actorUid,
    role: authenticatedPrimaryRole
      || (Array.isArray(authenticatedRoles) ? authenticatedRoles[0] : authenticatedRoles)
      || 'DOCTOR',
    queueRole: authenticatedPrimaryRole
      || (Array.isArray(authenticatedRoles) ? authenticatedRoles[0] : authenticatedRoles)
      || 'DOCTOR',
    rawRole: authenticatedPrimaryRole
      || (Array.isArray(authenticatedRoles) ? authenticatedRoles[0] : authenticatedRoles)
      || 'DOCTOR',
  }));
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

describe('createTask', () => {
  it('rejects missing title', async () => {
    await expect(createTask({ tenantId: TENANT })).rejects.toThrow(/title is required/);
  });

  it('rejects unknown task_kind', async () => {
    await expect(createTask({
      tenantId: TENANT, title: 'X', taskKind: 'spaceflight',
    })).rejects.toThrow(/task_kind must be one of/);
  });

  it('inserts an open task with default priority=normal', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open', priority: 'normal' }]);
    const row = await createTask({
      tenantId: TENANT, title: 'follow up on labs', createdBy: USER,
    });
    expect(row.status).toBe('open');
  });

  it('rejects ambiguous user-and-role assignment before querying', async () => {
    await expect(createTask({
      tenantId: TENANT,
      title: 'Ambiguous owner',
      assignedToUid: USER,
      assignedToRole: 'DOCTOR',
    })).rejects.toMatchObject({ statusCode: 400, code: 'TASK_ASSIGNMENT_AMBIGUOUS' });

    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('keeps unassigned generic tasks legal', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 2, status: 'open' }]);

    await expect(createTask({
      tenantId: TENANT,
      title: 'Unassigned administrative follow-up',
      assignedToUid: null,
      assignedToRole: null,
    })).resolves.toMatchObject({ id: 2 });

    const params = queryUnsafeMock.mock.calls[0].slice(1);
    expect(params[12]).toBeNull();
    expect(params[13]).toBeNull();
  });

  it('rejects lab threshold exception tasks outside their domain factory', async () => {
    await expect(createTask({
      tenantId: TENANT,
      title: 'Unmatched laboratory result',
      taskKind: 'review',
      relatedResourceType: 'lab_threshold_exception',
      relatedResourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      assignedToRole: 'LAB_INCHARGE',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAB_THRESHOLD_EXCEPTION_TASK_FACTORY_REQUIRED',
    });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('uses the supplied tx client instead of the default prisma', async () => {
    const txQuery = jest.fn().mockResolvedValueOnce([{ id: 9, status: 'open' }]);
    const tx = { $queryRawUnsafe: txQuery };
    const row = await createTask({
      tenantId: TENANT, title: 'critical lab', tx,
    });
    expect(row.id).toBe(9);
    // The tx client did the work; the module-level prisma mock was untouched.
    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('onConflictResourceDoNothing emits an ON CONFLICT DO NOTHING branch', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 2, status: 'open' }]);
    await createTask({
      tenantId: TENANT,
      title: 'critical lab',
      relatedResourceType: 'lab_result',
      relatedResourceId: '123',
      onConflictResourceDoNothing: true,
    });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/ON CONFLICT/i);
    expect(sql).toMatch(/DO NOTHING/i);
    // Inference is on the resource triple of the partial index.
    expect(sql).toMatch(/related_resource_type/);
    expect(sql).toMatch(/related_resource_id/);
  });

  it('onConflictResourceDoNothing returns undefined when the row already exists (no RETURNING row)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // conflict → DO NOTHING → no row returned
    const row = await createTask({
      tenantId: TENANT,
      title: 'critical lab',
      relatedResourceType: 'lab_result',
      relatedResourceId: '123',
      onConflictResourceDoNothing: true,
    });
    expect(row).toBeUndefined();
  });

  it('writes the typed task/SLA contract and the durable stage occurrence key', async () => {
    const slaId = DEFAULT_SLA_ID;
    queryUnsafeMock
      .mockResolvedValueOnce([ackSlaRow()])
      .mockResolvedValueOnce([{ id: 3, status: 'open' }]);

    await createTask({
      tenantId: TENANT,
      title: 'Acknowledge critical result',
      workflowSlaInstanceId: slaId,
      slaCompletionSemantics: 'acknowledgement',
      relatedResourceType: 'lab_result',
      relatedResourceId: '1',
      stageOccurrenceKey: 'pathway:1:stage:review:task',
    });

    const [sql, ...params] = queryUnsafeMock.mock.calls[1];
    expect(sql).toMatch(/workflow_sla_instance_id, sla_completion_semantics, stage_occurrence_key/);
    expect(params).toEqual(expect.arrayContaining([
      slaId,
      'acknowledgement',
      'pathway:1:stage:review:task',
    ]));
    expect(sql).toMatch(/SELECT sla\.due_at[\s\S]*sla\.id = \$18::uuid/);
    expect(params[15]).toBeNull();
  });

  it('rejects a typed task when its linked SLA has no canonical deadline', async () => {
    queryUnsafeMock.mockResolvedValueOnce([ackSlaRow({ due_at: null })]);

    await expect(createTask({
      tenantId: TENANT,
      title: 'Acknowledge critical result',
      workflowSlaInstanceId: DEFAULT_SLA_ID,
      slaCompletionSemantics: 'acknowledgement',
      relatedResourceType: 'lab_result',
      relatedResourceId: '1',
    })).rejects.toMatchObject({ code: 'TASK_SLA_DUE_AT_MISSING' });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO tasks/i.test(sql))).toBe(false);
  });

  it('treats an epoch-zero linked SLA deadline as present', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([ackSlaRow({ due_at: new Date(0) })])
      .mockResolvedValueOnce([{ id: 3, status: 'open' }]);

    await expect(createTask({
      tenantId: TENANT,
      title: 'Acknowledge historical critical result',
      workflowSlaInstanceId: DEFAULT_SLA_ID,
      slaCompletionSemantics: 'acknowledgement',
      relatedResourceType: 'lab_result',
      relatedResourceId: '1',
    })).resolves.toMatchObject({ id: 3 });
  });

  it('rejects any caller-supplied deadline for a typed task whose deadline is SLA-derived', async () => {
    queryUnsafeMock.mockResolvedValueOnce([ackSlaRow()]);

    await expect(createTask({
      tenantId: TENANT,
      title: 'Acknowledge critical result',
      workflowSlaInstanceId: DEFAULT_SLA_ID,
      slaCompletionSemantics: 'acknowledgement',
      relatedResourceType: 'lab_result',
      relatedResourceId: '1',
      dueAt: '2026-07-19T06:00:01.000Z',
    })).rejects.toMatchObject({ code: 'TASK_SLA_DUE_AT_DERIVED' });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO tasks/i.test(sql))).toBe(false);
  });

  it('does not bypass the SLA-derived deadline rule with an epoch-zero supplied deadline', async () => {
    queryUnsafeMock.mockResolvedValueOnce([ackSlaRow()]);

    await expect(createTask({
      tenantId: TENANT,
      title: 'Acknowledge critical result',
      workflowSlaInstanceId: DEFAULT_SLA_ID,
      slaCompletionSemantics: 'acknowledgement',
      relatedResourceType: 'lab_result',
      relatedResourceId: '1',
      dueAt: '1970-01-01T00:00:00.000Z',
    })).rejects.toMatchObject({ code: 'TASK_SLA_DUE_AT_DERIVED' });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO tasks/i.test(sql))).toBe(false);
  });

  it('preserves the exact instant from an offset deadline as an epoch query parameter', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 8, status: 'open' }]);

    await createTask({
      tenantId: TENANT,
      title: 'Timezone-safe follow-up',
      dueAt: '2026-07-19T11:30:00+05:30',
    });

    const params = queryUnsafeMock.mock.calls[0].slice(1);
    expect(queryUnsafeMock.mock.calls[0][0])
      .toMatch(/to_timestamp\(\$16::double precision \/ 1000\.0\)/);
    expect(params[15]).toBe(new Date('2026-07-19T06:00:00.000Z').getTime());
  });

  it('binds an epoch-zero untyped deadline instead of treating it as absent', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 9, status: 'open' }]);

    await createTask({
      tenantId: TENANT,
      title: 'Historical follow-up',
      dueAt: 0,
    });

    expect(queryUnsafeMock.mock.calls[0][16]).toBe(0);
  });

  it('rejects incomplete typed SLA contracts and reserved metadata aliases', async () => {
    const slaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await expect(createTask({
      tenantId: TENANT,
      title: 'Missing semantics',
      workflowSlaInstanceId: slaId,
    })).rejects.toMatchObject({ code: 'TASK_SLA_CONTRACT_INVALID' });
    await expect(createTask({
      tenantId: TENANT,
      title: 'Missing link',
      slaCompletionSemantics: 'domain_evidence',
    })).rejects.toMatchObject({ code: 'TASK_SLA_CONTRACT_INVALID' });
    await expect(createTask({
      tenantId: TENANT,
      title: 'Metadata spoof',
      metadata: { sla_instance_id: slaId },
    })).rejects.toMatchObject({ code: 'TASK_METADATA_KEY_RESERVED' });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('blocks generic materialization for a pathway-bound run but accepts the executor token', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(createTask({
      tenantId: TENANT,
      workflowRunId: 7,
      title: 'Generic bypass',
    })).rejects.toMatchObject({ code: 'PATHWAY_EXECUTOR_REQUIRED' });

    queryUnsafeMock.mockResolvedValueOnce([{ id: 7, status: 'open' }]);
    const row = await createTask({
      tenantId: TENANT,
      workflowRunId: 7,
      title: 'Executor materialization',
      executorAuthority: PATHWAY_TEST_CAPABILITY,
    });
    expect(row.id).toBe(7);
  });

  it.each([
    ['wrong resource', ackSlaRow({ source_id: 'other-result' })],
    ['unknown non-pathway rule', ackSlaRow({ rule_code: 'unregistered_task_clock' })],
  ])('rejects a typed SLA with %s before inserting', async (_label, slaRow) => {
    queryUnsafeMock.mockResolvedValueOnce([slaRow]);
    await expect(createTask({
      tenantId: TENANT,
      title: 'Wrongly linked task',
      relatedResourceType: 'lab_result',
      relatedResourceId: '1',
      workflowSlaInstanceId: DEFAULT_SLA_ID,
      slaCompletionSemantics: 'acknowledgement',
    })).rejects.toMatchObject({ code: 'TASK_SLA_SOURCE_BINDING_INVALID' });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO tasks/i.test(sql))).toBe(false);
  });

  it('binds a pathway task SLA to its exact workflow step source', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: DEFAULT_SLA_ID,
        rule_code: 'pathway_referral_response',
        source_table: 'workflow_steps',
        source_id: '91',
        due_at: new Date('2026-07-19T06:00:00.000Z'),
      }])
      .mockResolvedValueOnce([{ id: 4, status: 'open', workflow_step_id: 91 }]);

    const task = await createTask({
      tenantId: TENANT,
      workflowRunId: 7,
      workflowStepId: 91,
      title: 'Review pathway stage',
      workflowSlaInstanceId: DEFAULT_SLA_ID,
      slaCompletionSemantics: 'acknowledgement',
      executorAuthority: PATHWAY_TEST_CAPABILITY,
    });

    expect(task).toMatchObject({ id: 4, workflow_step_id: 91 });
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/source_table/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/INSERT INTO tasks/);
  });

  it('rejects a pathway task SLA linked to a different workflow step', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: DEFAULT_SLA_ID,
      rule_code: 'pathway_referral_response',
      source_table: 'workflow_steps',
      source_id: '92',
    }]);

    await expect(createTask({
      tenantId: TENANT,
      workflowRunId: 7,
      workflowStepId: 91,
      title: 'Wrongly linked pathway stage',
      workflowSlaInstanceId: DEFAULT_SLA_ID,
      slaCompletionSemantics: 'acknowledgement',
      executorAuthority: PATHWAY_TEST_CAPABILITY,
    })).rejects.toMatchObject({ code: 'TASK_SLA_SOURCE_BINDING_INVALID' });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO tasks/i.test(sql))).toBe(false);
  });
});

describe('createLabThresholdExceptionReviewTaskTx', () => {
  it('creates the exact protected high-priority laboratory owner task', async () => {
    const tx = { $queryRawUnsafe: jest.fn().mockResolvedValueOnce([{
      id: 91,
      task_kind: 'review',
      priority: 'high',
      assigned_to_role: 'LAB_INCHARGE',
    }]) };
    const exceptionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const task = await createLabThresholdExceptionReviewTaskTx({
      tenantId: TENANT,
      exceptionId,
      resultId: 44,
      patientUid: USER,
      testName: 'Potassium',
      unmatchedReason: 'unit_mismatch',
      source: 'unit_test',
      tx,
    });
    expect(task).toMatchObject({
      id: 91,
      task_kind: 'review',
      priority: 'high',
      assigned_to_role: 'LAB_INCHARGE',
    });
    const params = tx.$queryRawUnsafe.mock.calls[0].slice(1);
    expect(params[4]).toBe('review');
    expect(params[9]).toBe('lab_threshold_exception');
    expect(params[10]).toBe(exceptionId);
    expect(params[11]).toBe('high');
    expect(params[13]).toBe('LAB_INCHARGE');
    expect(JSON.parse(params[20])).toMatchObject({
      task_contract: 'lab_threshold_policy_exception_v1',
      lab_result_id: 44,
      unmatched_reason: 'unit_mismatch',
    });
  });
});

describe('createCoveringTransferReviewTaskTx', () => {
  const HANDOFF_ID = '44444444-4444-4444-8444-444444444444';
  const PATHWAY_INSTANCE_ID = '55555555-5555-4555-8555-555555555555';
  const PATIENT_UID = '66666666-6666-4666-8666-666666666666';
  const INPATIENT_ENCOUNTER_ID = '77777777-7777-4777-8777-777777777777';
  const RECIPIENT_UID = '88888888-8888-4888-8888-888888888888';
  const REQUEST_FINGERPRINT = 'a'.repeat(64);

  it('preserves an inpatient UUID encounter in exact transfer-task metadata', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 41, status: 'open' }]);

    await expect(createCoveringTransferReviewTaskTx({
      tenantId: TENANT,
      handoffId: HANDOFF_ID,
      pathwayInstanceId: PATHWAY_INSTANCE_ID,
      patientUid: PATIENT_UID,
      encounterId: INPATIENT_ENCOUNTER_ID,
      recipientUid: RECIPIENT_UID,
      senderUid: USER,
      requestFingerprint: REQUEST_FINGERPRINT,
      tx: __prismaDefaultMock,
    })).resolves.toMatchObject({ id: 41, status: 'open' });

    const [sql, ...params] = queryUnsafeMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO tasks/);
    expect(params[8]).toBeNull();
    expect(JSON.parse(params[20])).toMatchObject({
      task_contract: 'covering_clinician_transfer_review_v1',
      care_pathway_instance_id: PATHWAY_INSTANCE_ID,
      canonical_encounter_id: INPATIENT_ENCOUNTER_ID,
      request_fingerprint: REQUEST_FINGERPRINT,
    });
  });

  it('fails closed on a non-UUID canonical encounter before task creation', async () => {
    await expect(createCoveringTransferReviewTaskTx({
      tenantId: TENANT,
      handoffId: HANDOFF_ID,
      pathwayInstanceId: PATHWAY_INSTANCE_ID,
      patientUid: PATIENT_UID,
      encounterId: 17,
      recipientUid: RECIPIENT_UID,
      senderUid: USER,
      requestFingerprint: REQUEST_FINGERPRINT,
      tx: __prismaDefaultMock,
    })).rejects.toThrow('encounter_id must be a UUID');

    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });
});

describe('createWardMedicationObligationTaskTx', () => {
  const ENCOUNTER_ID = '77777777-7777-4777-8777-777777777777';

  it('keeps the legacy integer encounter column empty and preserves the canonical UUID', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: DEFAULT_SLA_ID,
        rule_code: 'ward_indent_mar_supply_reconciliation',
        source_table: 'medication_administrations',
        source_id: '81',
        due_at: new Date('2026-07-19T06:00:00.000Z'),
      }])
      .mockResolvedValueOnce([{ id: 81, status: 'open' }]);

    await expect(createWardMedicationObligationTaskTx({
      tenantId: TENANT,
      title: 'Reconcile MAR administration with ward custody',
      patientUid: USER,
      encounterId: ENCOUNTER_ID,
      relatedResourceType: 'medication_administrations',
      relatedResourceId: '81',
      assignedToRole: 'PHARMACY_INCHARGE',
      createdBy: USER,
      workflowSlaInstanceId: DEFAULT_SLA_ID,
      stageOccurrenceKey: 'ward-medication:test:mar-reconciliation',
      metadata: {
        sla_key: 'ward_indent_mar_supply_reconciliation',
        obligation_kind: 'mar_supply_reconciliation',
      },
      tx: __prismaDefaultMock,
    })).resolves.toMatchObject({ id: 81, status: 'open' });

    const [sql, ...params] = queryUnsafeMock.mock.calls[1];
    expect(sql).toMatch(/INSERT INTO tasks/);
    expect(params[8]).toBeNull();
    expect(JSON.parse(params[20])).toMatchObject({
      task_contract: 'ward_medication_obligation_v1',
      canonical_encounter_id: ENCOUNTER_ID,
      sla_key: 'ward_indent_mar_supply_reconciliation',
      obligation_kind: 'mar_supply_reconciliation',
    });
  });

  it('fails closed on a non-UUID canonical encounter before reading its SLA', async () => {
    await expect(createWardMedicationObligationTaskTx({
      tenantId: TENANT,
      title: 'Reconcile MAR administration with ward custody',
      patientUid: USER,
      encounterId: 17,
      relatedResourceType: 'medication_administrations',
      relatedResourceId: '81',
      assignedToRole: 'PHARMACY_INCHARGE',
      createdBy: USER,
      workflowSlaInstanceId: DEFAULT_SLA_ID,
      stageOccurrenceKey: 'ward-medication:test:mar-reconciliation',
      metadata: {
        sla_key: 'ward_indent_mar_supply_reconciliation',
        obligation_kind: 'mar_supply_reconciliation',
      },
      tx: __prismaDefaultMock,
    })).rejects.toThrow('encounter_id must be a UUID');

    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// acknowledgeTask + listInboxTasks (results-inbox)
// ---------------------------------------------------------------------------

describe('claimInboxTask', () => {
  const claimInput = (overrides = {}) => ({
    tenantId: TENANT,
    id: 41,
    actorUid: USER,
    actorRoles: ['DOCTOR'],
    actorPrimaryRole: 'DOCTOR',
    actorRawRole: 'DOCTOR',
    idempotencyKey: 'claim-key',
    ...overrides,
  });
  const roleTask = (overrides = {}) => ({
    id: 41,
    status: 'open',
    assigned_to_uid: null,
    assigned_to_role: 'DOCTOR',
    workflow_run_id: null,
    workflow_step_id: null,
    workflow_sla_instance_id: null,
    metadata: {},
    ...overrides,
  });

  it('claims an exact current role queue and stores only a derived receipt', async () => {
    const claimed = roleTask({
      assigned_to_uid: USER,
      assigned_to_role: null,
      metadata: {},
    });
    queryUnsafeMock
      .mockResolvedValueOnce([roleTask()])
      .mockResolvedValueOnce([claimed])
      .mockResolvedValueOnce([{ id: 1 }]);

    await expect(claimInboxTask(claimInput())).resolves.toMatchObject({
      id: 41,
      assigned_to_uid: USER,
      replayed: false,
    });

    const updateCall = queryUnsafeMock.mock.calls[1];
    expect(updateCall[0]).toMatch(/role_claim_receipt/);
    expect(updateCall[0]).toMatch(/role_claim_command_fingerprint/);
    expect(updateCall[4]).toMatch(/^task-claim-v1:[0-9a-f]{64}$/);
    expect(updateCall[8]).toMatch(/^[0-9a-f]{64}$/);
    expect(queryUnsafeMock.mock.calls.flat().join(' ')).not.toContain('claim-key');
  });

  it('replays only the exact actor, task, and derived command receipt', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([roleTask()])
      .mockImplementationOnce(async (...args) => [{
        ...roleTask(),
        assigned_to_uid: USER,
        assigned_to_role: null,
        metadata: {
          role_claim_receipt: args[4],
          role_claim_command_fingerprint: args[8],
          role_claimed_by: USER,
        },
      }])
      .mockResolvedValueOnce([{ id: 1 }]);
    const first = await claimInboxTask(claimInput());

    queryUnsafeMock.mockReset();
    queryUnsafeMock.mockResolvedValueOnce([first]);
    await expect(claimInboxTask(claimInput())).resolves.toMatchObject({ replayed: true });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('derives different receipts for the same raw key across targets', async () => {
    const receipts = [];
    for (const id of [41, 42]) {
      queryUnsafeMock.mockReset();
      queryUnsafeMock
        .mockResolvedValueOnce([roleTask({ id })])
        .mockImplementationOnce(async (...args) => {
          receipts.push(args[4]);
          return [{ ...roleTask({ id }), assigned_to_uid: USER, assigned_to_role: null }];
        })
        .mockResolvedValueOnce([{ id: 1 }]);
      await claimInboxTask(claimInput({ id }));
    }
    expect(receipts[0]).not.toBe(receipts[1]);
  });

  it('denies a losing actor without mutating the winner receipt', async () => {
    const other = APPROVER_A;
    queryUnsafeMock.mockResolvedValueOnce([roleTask({
      assigned_to_uid: USER,
      assigned_to_role: null,
      metadata: {
        role_claim_receipt: 'task-claim-v1:old',
        role_claim_command_fingerprint: 'old',
        role_claimed_by: USER,
      },
    })]);

    await expect(claimInboxTask(claimInput({ actorUid: other })))
      .rejects.toMatchObject({ statusCode: 403, code: 'TASK_CLAIM_FORBIDDEN' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('denies pathway-bound role tasks before a write', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([roleTask({ workflow_run_id: 77 })])
      .mockResolvedValueOnce([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]);

    await expect(claimInboxTask(claimInput()))
      .rejects.toMatchObject({ code: 'PATHWAY_EXECUTOR_REQUIRED' });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
  });

  it.each([
    ['active', null, true],
    ['completed', new Date('2026-07-20T00:00:00.000Z'), false],
  ])('moves %s linked SLA ownership only while the clock is live', async (
    status,
    completedAt,
    expectsSlaUpdate,
  ) => {
    const task = roleTask({
      related_resource_type: 'lab_result',
      related_resource_id: '1',
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'acknowledgement',
    });
    queryUnsafeMock
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([ackSlaRow({ status, completed_at: completedAt })])
      .mockResolvedValueOnce([{ ...task, assigned_to_uid: USER, assigned_to_role: null }]);
    if (expectsSlaUpdate) queryUnsafeMock.mockResolvedValueOnce([{ id: DEFAULT_SLA_ID }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);

    await claimInboxTask(claimInput());
    expect(queryUnsafeMock.mock.calls.some(([sql]) => (
      /UPDATE workflow_sla_instances/i.test(sql)
    ))).toBe(expectsSlaUpdate);
  });

  it('fails the claim transaction when linked SLA ownership cannot move', async () => {
    const task = roleTask({
      related_resource_type: 'lab_result',
      related_resource_id: '1',
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'acknowledgement',
    });
    queryUnsafeMock
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([ackSlaRow({ status: 'active', completed_at: null })])
      .mockResolvedValueOnce([{ ...task, assigned_to_uid: USER, assigned_to_role: null }])
      .mockResolvedValueOnce([]);

    await expect(claimInboxTask(claimInput()))
      .rejects.toMatchObject({ code: 'TASK_CLAIM_SLA_CONFLICT' });
  });

  it('denies a different claimant when a role acknowledgement already names its actor', async () => {
    queryUnsafeMock.mockResolvedValueOnce([roleTask({
      status: 'in_progress',
      metadata: {
        acknowledged_at: '2026-07-20T00:00:00.000Z',
        acknowledged_by: APPROVER_A,
        ack_contract_version: 2,
      },
    })]);

    await expect(claimInboxTask(claimInput()))
      .rejects.toMatchObject({ statusCode: 403, code: 'TASK_CLAIM_FORBIDDEN' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('lets the recorded acker claim a legacy role-owned acknowledgement without changing its receipt', async () => {
    const legacy = roleTask({
      status: 'in_progress',
      metadata: {
        acknowledged_at: '2026-07-20T00:00:00.000Z',
        acknowledged_by: USER,
        ack_contract_version: 2,
      },
    });
    queryUnsafeMock
      .mockResolvedValueOnce([legacy])
      .mockResolvedValueOnce([{
        ...legacy,
        assigned_to_uid: USER,
        assigned_to_role: null,
      }])
      .mockResolvedValueOnce([{ id: 1 }]);

    await expect(claimInboxTask(claimInput())).resolves.toMatchObject({
      assigned_to_uid: USER,
      assigned_to_role: null,
      metadata: expect.objectContaining({
        acknowledged_at: '2026-07-20T00:00:00.000Z',
        acknowledged_by: USER,
      }),
    });
  });
});

describe('acknowledgeTask', () => {
  it('blocks an alert-bound critical task on every generic caller before mutation', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'open',
      assigned_to_uid: USER,
      patient_uid: '44444444-4444-4444-8444-444444444444',
      ...ACK_RESOURCE,
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'acknowledgement',
      metadata: { lab_critical_alert_id: 91, lab_alert_generation_state: 'critical' },
    }]);

    await expect(acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER }))
      .rejects.toMatchObject({ statusCode: 409, code: 'LAB_CRITICAL_ALERT_ACK_REQUIRED' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE workflow_sla_instances/i.test(sql)))
      .toBe(false);
  });

  it('permits the transaction-only lab entrypoint after exact binding verification', async () => {
    const patientUid = '44444444-4444-4444-8444-444444444444';
    const task = {
      id: 1,
      status: 'open',
      assigned_to_uid: USER,
      patient_uid: patientUid,
      ...ACK_RESOURCE,
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'acknowledgement',
      metadata: { lab_critical_alert_id: 91, lab_alert_generation_state: 'critical' },
    };
    const txQuery = jest.fn()
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([{ id: 91 }])
      .mockResolvedValueOnce([{ ...task, status: 'in_progress', metadata: {
        ...task.metadata,
        acknowledged_at: '2026-07-19T06:00:00.000Z',
        ack_contract_version: 2,
      } }])
      .mockResolvedValueOnce([ackSlaRow()])
      .mockResolvedValueOnce([{ id: DEFAULT_SLA_ID, status: 'completed' }])
      .mockResolvedValueOnce([{ id: 10, body_kind: 'state_change' }]);
    const tx = { $queryRawUnsafe: txQuery };

    const row = await acknowledgeLabCriticalAlertTaskFromTrustedWorkflow({
      tenantId: TENANT,
      id: 1,
      alertId: 91,
      resultId: 1,
      patientUid,
      actorUid: USER,
      tx,
    });

    expect(row.status).toBe('in_progress');
    expect(txQuery.mock.calls[1][0]).toMatch(/JOIN lab_critical_alerts AS alert/i);
    expect(txQuery.mock.calls[2][0]).toMatch(/UPDATE tasks/i);
    expect(txQuery.mock.calls[4][0]).toMatch(/UPDATE workflow_sla_instances/i);
  });

  it('permits only the transaction-only lab entrypoint to acknowledge a blocked alert task', async () => {
    const patientUid = '44444444-4444-4444-8444-444444444444';
    const task = {
      id: 1,
      status: 'blocked',
      assigned_to_uid: USER,
      patient_uid: patientUid,
      ...ACK_RESOURCE,
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'acknowledgement',
      metadata: { lab_critical_alert_id: 91, lab_alert_generation_state: 'critical' },
    };
    const txQuery = jest.fn()
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([{ id: 91 }])
      .mockResolvedValueOnce([{ ...task, status: 'in_progress', metadata: {
        ...task.metadata,
        acknowledged_at: '2026-07-19T06:00:00.000Z',
        ack_contract_version: 2,
      } }])
      .mockResolvedValueOnce([ackSlaRow()])
      .mockResolvedValueOnce([{ id: DEFAULT_SLA_ID, status: 'completed' }])
      .mockResolvedValueOnce([{ id: 10, body_kind: 'state_change' }]);
    const tx = { $queryRawUnsafe: txQuery };

    const row = await acknowledgeLabCriticalAlertTaskFromTrustedWorkflow({
      tenantId: TENANT,
      id: 1,
      alertId: 91,
      resultId: 1,
      patientUid,
      actorUid: USER,
      tx,
    });

    expect(row.status).toBe('in_progress');
    expect(txQuery.mock.calls[2][0]).toMatch(
      /tasks\.status IN \('open', 'overdue', 'blocked'\)/i,
    );
    expect(txQuery.mock.calls[2][0]).toMatch(/ack_contract_version/i);
    expect(txQuery.mock.calls[2].at(-1)).toBe(2);
    expect(txQuery.mock.calls[4][0]).toMatch(/ack_contract_version/i);
    expect(txQuery.mock.calls[4].at(-1)).toBe(2);
    expect(txQuery.mock.calls[5]).toEqual(expect.arrayContaining([
      expect.stringMatching(/blocked.*in_progress/i),
    ]));
    expect(JSON.parse(txQuery.mock.calls[5][6])).toMatchObject({
      ack_contract_version: 2,
    });
  });

  it('moves open -> in_progress, stamps metadata.acknowledged_at, posts a state_change comment', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open', assigned_to_uid: USER, metadata: {} }]); // getTask
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress', metadata: { acknowledged_at: 'x' } }]); // UPDATE
    queryUnsafeMock.mockResolvedValueOnce([{ id: 10, body_kind: 'state_change' }]); // comment insert

    const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER });
    expect(row.status).toBe('in_progress');
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));

    const updateSql = queryUnsafeMock.mock.calls[1][0];
    expect(updateSql).toMatch(/UPDATE tasks/);
    expect(updateSql).toMatch(/status = /);
    expect(updateSql).toMatch(/acknowledged_at/);

    const commentSql = queryUnsafeMock.mock.calls[2][0];
    expect(commentSql).toMatch(/INSERT INTO task_comments/);
    const commentParams = queryUnsafeMock.mock.calls[2].slice(1);
    expect(commentParams).toContain('state_change');
  });

  it('acknowledges an overdue task (overdue -> in_progress)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'overdue', assigned_to_uid: USER, metadata: {} }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 11 }]);
    const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER });
    expect(row.status).toBe('in_progress');
  });

  it('does not add blocked -> in_progress to generic task acknowledgement', async () => {
    const task = { id: 1, status: 'blocked', assigned_to_uid: USER, metadata: {} };
    queryUnsafeMock
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([task]);

    await expect(acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER }))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_STATE_TRANSITION' });
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(
      /tasks\.status IN \('open', 'overdue'\)/i,
    );
    expect(queryUnsafeMock.mock.calls[1][0]).not.toMatch(/'blocked'/i);
  });

  it('uses the durable receipt instant for SLA completion and anchors a late breach at due_at', async () => {
    const task = {
      id: 1,
      status: 'open',
      assigned_to_uid: USER,
      ...ACK_RESOURCE,
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'acknowledgement',
      metadata: {},
    };
    queryUnsafeMock
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([{ ...task, status: 'in_progress' }])
      .mockResolvedValueOnce([ackSlaRow()])
      .mockResolvedValueOnce([{ id: DEFAULT_SLA_ID, status: 'completed' }])
      .mockResolvedValueOnce([{ id: 11, body_kind: 'state_change' }]);

    await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER });

    const acknowledgedAt = new Date(queryUnsafeMock.mock.calls[1][12]).toISOString();
    const slaCall = queryUnsafeMock.mock.calls[3];
    expect(slaCall[0]).toMatch(/to_timestamp\(\$7::double precision \/ 1000\.0\) > due_at/);
    expect(slaCall[0]).toMatch(/completed_at = to_timestamp\(\$7::double precision \/ 1000\.0\)/);
    expect(slaCall[0]).toMatch(/breached_at = CASE[\s\S]+THEN due_at[\s\S]+ELSE NULL/);
    expect(slaCall[0]).not.toMatch(/NOW\(\) > due_at/);
    expect(new Date(slaCall[7]).toISOString()).toBe(acknowledgedAt);
  });

  it('acknowledges domain-evidence work without stopping its SLA clock', async () => {
    const linked = {
      id: 1,
      status: 'open',
      assigned_to_uid: USER,
      related_resource_type: 'death_record',
      related_resource_id: '55',
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'domain_evidence',
      metadata: {},
    };
    queryUnsafeMock
      .mockResolvedValueOnce([linked])
      .mockResolvedValueOnce([{ ...linked, status: 'in_progress' }])
      .mockResolvedValueOnce([mortuarySlaRow()])
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([{ id: 11 }]);

    const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER });

    expect(row.status).toBe('in_progress');
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE workflow_sla_instances/i.test(sql))).toBe(false);
  });

  it('blocks generic acknowledgement of a pathway-bound task before mutation', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 1, status: 'open', workflow_run_id: 7, assigned_to_uid: USER }])
      .mockResolvedValueOnce([{ '?column?': 1 }]);

    await expect(acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER }))
      .rejects.toMatchObject({ code: 'PATHWAY_EXECUTOR_REQUIRED' });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
  });

  it('rejects acknowledgement when the typed SLA belongs to another source', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: USER,
        ...ACK_RESOURCE,
        workflow_sla_instance_id: DEFAULT_SLA_ID,
        sla_completion_semantics: 'acknowledgement',
        metadata: {},
      }])
      .mockResolvedValueOnce([{
        id: 1,
        status: 'in_progress',
        assigned_to_uid: USER,
        ...ACK_RESOURCE,
        workflow_sla_instance_id: DEFAULT_SLA_ID,
        sla_completion_semantics: 'acknowledgement',
        metadata: {},
      }])
      .mockResolvedValueOnce([ackSlaRow({ source_id: '2' })]);

    await expect(acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER }))
      .rejects.toMatchObject({ code: 'TASK_SLA_SOURCE_BINDING_INVALID' });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(true);
  });

  it('throws invalidTransition when the task is already completed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed', assigned_to_uid: USER, metadata: {} }]); // getTask
    await expect(acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER }))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_STATE_TRANSITION' });
  });

  it('idempotently repairs the linked SLA for an already-acknowledged task without re-stamping or commenting', async () => {
    const receipt = '2026-07-19T02:00:00.000Z';
    const task = {
      id: 1,
      status: 'in_progress',
      assigned_to_uid: USER,
      ...ACK_RESOURCE,
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'acknowledgement',
      metadata: {
        acknowledged_at: receipt,
        acknowledged_by: USER,
      },
    };
    queryUnsafeMock
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([ackSlaRow()])
      .mockResolvedValueOnce([{ id: DEFAULT_SLA_ID, status: 'completed' }]);

    const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER });

    expect(row.status).toBe('in_progress');
    expect(queryUnsafeMock.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringMatching(/^SELECT[\s\S]+FROM tasks/i),
      expect.stringMatching(/^SELECT[\s\S]+FROM tasks[\s\S]+FOR UPDATE/i),
      expect.stringMatching(/FROM workflow_sla_instances sla/i),
      expect.stringMatching(/UPDATE workflow_sla_instances/i),
    ]);
    const slaCall = queryUnsafeMock.mock.calls[3];
    expect(slaCall[0]).toMatch(/completed_at IS NULL/);
    expect(slaCall[0]).toMatch(/to_timestamp\(\$7::double precision \/ 1000\.0\) > due_at/);
    expect(slaCall[0]).toMatch(/completed_at = to_timestamp\(\$7::double precision \/ 1000\.0\)/);
    expect(slaCall[0]).toMatch(/THEN due_at[\s\S]+ELSE NULL/);
    expect(new Date(slaCall[7]).toISOString()).toBe(receipt);
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /INSERT INTO task_comments/i.test(sql))).toBe(false);
  });

  it.each([undefined, 'not-a-timestamp'])(
    'repairs a missing or malformed in-progress acknowledgement receipt before stopping the SLA clock',
    async (acknowledgedAt) => {
      const task = {
        id: 1,
        status: 'in_progress',
        assigned_to_uid: USER,
        ...ACK_RESOURCE,
        workflow_sla_instance_id: DEFAULT_SLA_ID,
        sla_completion_semantics: 'acknowledgement',
        metadata: acknowledgedAt === undefined ? {} : { acknowledged_at: acknowledgedAt },
      };
      queryUnsafeMock
        .mockResolvedValueOnce([task])
        .mockResolvedValueOnce([task])
        .mockResolvedValueOnce([ackSlaRow()])
        .mockResolvedValueOnce([{ ...task, metadata: { acknowledged_at: 'server-repaired' } }])
        .mockResolvedValueOnce([{ id: DEFAULT_SLA_ID, status: 'completed' }])
        .mockResolvedValueOnce([{ id: 10, body_kind: 'state_change' }]);

      const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER });

      expect(row.status).toBe('in_progress');
      const repairCall = queryUnsafeMock.mock.calls[3];
      expect(repairCall[0]).toMatch(/UPDATE tasks[\s\S]+acknowledgement_receipt_repaired/);
      expect(repairCall[0]).toMatch(/ACK_AUTHORITY_PREDICATE|assigned_to_uid/i);
      expect(repairCall[0]).toMatch(/previous_acknowledged_at/);
      expect(repairCall[0]).toMatch(/acknowledgement_receipt_repaired_from/);
      const repairedAt = new Date(repairCall[12]).toISOString();
      expect(JSON.parse(repairCall[13])).toBe(acknowledgedAt ?? null);
      expect(repairCall[14]).toBe(acknowledgedAt === undefined ? 'missing' : 'malformed');
      const slaCall = queryUnsafeMock.mock.calls[4];
      expect(new Date(slaCall[7]).toISOString()).toBe(repairedAt);
      const commentCall = queryUnsafeMock.mock.calls[5];
      expect(commentCall[0]).toMatch(/INSERT INTO task_comments/);
      expect(commentCall[4]).toMatch(/receipt repaired/);
      expect(JSON.parse(commentCall[6])).toMatchObject({
        receipt_repaired: true,
        previous_acknowledged_at: acknowledgedAt ?? null,
        repaired_from: acknowledgedAt === undefined ? 'missing' : 'malformed',
      });
    },
  );

  it.each([
    ['linked SLA', 3, 'SLA write failed'],
    ['audit comment', 4, 'comment write failed'],
  ])('propagates a %s failure through its own tenant transaction', async (_label, failingCall, message) => {
    const responses = [
      [{
        id: 1,
        status: 'open',
        assigned_to_uid: USER,
        ...ACK_RESOURCE,
        workflow_sla_instance_id: DEFAULT_SLA_ID,
        sla_completion_semantics: 'acknowledgement',
        metadata: {},
      }],
      [{
        id: 1,
        status: 'in_progress',
        ...ACK_RESOURCE,
        workflow_sla_instance_id: DEFAULT_SLA_ID,
        sla_completion_semantics: 'acknowledgement',
        metadata: {},
      }],
      [ackSlaRow()],
      [{ id: DEFAULT_SLA_ID, status: 'completed' }],
      [{ id: 10, body_kind: 'state_change' }],
    ];
    responses.forEach((response, index) => {
      if (index === failingCall) queryUnsafeMock.mockRejectedValueOnce(new Error(message));
      else queryUnsafeMock.mockResolvedValueOnce(response);
    });

    await expect(acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER }))
      .rejects.toThrow(message);
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });
});

describe('acknowledgeTask authorization', () => {
  const OTHER = '99999999-9999-4999-8999-999999999999';
  const SLA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const PATIENT = '44444444-4444-4444-8444-444444444444';

  it.each(['DUTY_DOCTOR', 'ADMIN'])(
    'rejects %s authority without an authenticated actor uid before reading the task',
    async (role) => {
      await expect(acknowledgeTask({
        tenantId: TENANT,
        id: 1,
        actorUid: null,
        actorRoles: [role],
      })).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });

      expect(queryUnsafeMock).not.toHaveBeenCalled();
    },
  );

  it('rejects a caller who is neither assignee, role-holder, nor override — and never runs the clock-stopping UPDATE', async () => {
    // Task belongs to a DIFFERENT clinician and is linked to an SLA instance.
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'open', assigned_to_uid: OTHER, assigned_to_role: 'DOCTOR',
      workflow_sla_instance_id: SLA_ID, sla_completion_semantics: 'acknowledgement', metadata: {},
    }]); // getTask
    await expect(acknowledgeTask({
      tenantId: TENANT, id: 1, actorUid: USER, actorRoles: ['NURSING_STAFF'],
    })).rejects.toMatchObject({ statusCode: 403 });
    // Only the getTask read ran: no UPDATE tasks (status flip) and therefore no
    // completeLinkedSla UPDATE — the escalation clock is NOT stopped.
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('revalidates assignee authority in the guarded UPDATE and denies a concurrent reassignment', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: USER,
        assigned_to_role: null,
        ...ACK_RESOURCE,
        workflow_sla_instance_id: SLA_ID, sla_completion_semantics: 'acknowledgement', metadata: {},
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: OTHER,
        assigned_to_role: null,
        ...ACK_RESOURCE,
        workflow_sla_instance_id: SLA_ID, sla_completion_semantics: 'acknowledgement', metadata: {},
      }]);

    await expect(acknowledgeTask({
      tenantId: TENANT,
      id: 1,
      actorUid: USER,
      actorRoles: [],
    })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    const updateCall = queryUnsafeMock.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE tasks/i);
    expect(updateCall[0]).toMatch(/'assignee'[\s\S]+assigned_to_uid/i);
    expect(updateCall.slice(1)).toEqual(expect.arrayContaining(['assignee', USER]));
    expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
  });

  it('retries the guarded update through a still-valid administrator mode after reassignment', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: USER,
        assigned_to_role: null,
        metadata: {},
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 1,
        status: 'overdue',
        assigned_to_uid: OTHER,
        assigned_to_role: null,
        metadata: {},
      }])
      .mockResolvedValueOnce([{ id: 1, status: 'in_progress', metadata: {} }])
      .mockResolvedValueOnce([{ id: 12, body_kind: 'state_change' }]);

    const row = await acknowledgeTask({
      tenantId: TENANT,
      id: 1,
      actorUid: USER,
      actorRoles: ['ADMIN'],
    });

    expect(row.status).toBe('in_progress');
    expect(queryUnsafeMock.mock.calls[1].slice(1)[2]).toBe('assignee');
    expect(queryUnsafeMock.mock.calls[3].slice(1)[2]).toBe('admin');
    expect(queryUnsafeMock.mock.calls[4][4]).toMatch(/overdue → in_progress/);
    expect(JSON.parse(queryUnsafeMock.mock.calls[4][6])).toMatchObject({
      from: 'overdue',
      to: 'in_progress',
      via: 'admin',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(5);
  });

  it('allows the assignee (by uid)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open', assigned_to_uid: USER, metadata: {} }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5 }]);
    const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER, actorRoles: [] });
    expect(row.status).toBe('in_progress');
  });

  it('allows a holder of the assigned role when there is no named assignee', async () => {
    const roleTask = {
      id: 1,
      status: 'open',
      assigned_to_uid: null,
      assigned_to_role: 'DUTY_DOCTOR',
      metadata: {},
    };
    const claimed = {
      ...roleTask,
      assigned_to_uid: USER,
      assigned_to_role: null,
      metadata: {
        role_claimed_by: USER,
        role_claimed_from_role: 'DUTY_DOCTOR',
      },
    };
    queryUnsafeMock
      .mockResolvedValueOnce([roleTask])
      .mockResolvedValueOnce([roleTask])
      .mockResolvedValueOnce([claimed])
      .mockResolvedValueOnce([{ id: 6 }])
      .mockResolvedValueOnce([{ ...claimed, status: 'in_progress' }])
      .mockResolvedValueOnce([{ id: 7 }]);
    const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER, actorRoles: ['DUTY_DOCTOR'] });
    expect(row.status).toBe('in_progress');
    expect(queryUnsafeMock.mock.calls[4].slice(1)[2]).toBe('role');
    expect(queryUnsafeMock.mock.calls[4].slice(1)[4]).toBe('DUTY_DOCTOR');
    expect(queryUnsafeMock.mock.calls[4][0]).toMatch(
      /'role'[\s\S]+assigned_to_uid IS NULL[\s\S]+assigned_to_role/i,
    );
  });

  it('does not let a matching role mask a named assignee on a corrupt dual-assigned row', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'open',
      assigned_to_uid: OTHER,
      assigned_to_role: 'DUTY_DOCTOR',
      metadata: {},
    }]);

    await expect(acknowledgeTask({
      tenantId: TENANT,
      id: 1,
      actorUid: USER,
      actorRoles: ['DUTY_DOCTOR'],
    })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a different role holder repair a malformed durable acknowledgement receipt', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'in_progress',
      assigned_to_uid: null,
      assigned_to_role: 'DOCTOR',
      metadata: {
        acknowledged_by: OTHER,
      },
    }]);

    await expect(acknowledgeTask({
      tenantId: TENANT,
      id: 1,
      actorUid: USER,
      actorRoles: ['DOCTOR'],
      actorPrimaryRole: 'DOCTOR',
      actorRawRole: 'DOCTOR',
    })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
  });

  it('denies stale role authority when a named assignee appears before the guarded update', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: null,
        assigned_to_role: 'DUTY_DOCTOR',
        metadata: {},
      }])
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: null,
        assigned_to_role: 'DUTY_DOCTOR',
        metadata: {},
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: OTHER,
        assigned_to_role: 'DUTY_DOCTOR',
        metadata: {},
      }]);

    await expect(acknowledgeTask({
      tenantId: TENANT,
      id: 1,
      actorUid: USER,
      actorRoles: ['DUTY_DOCTOR'],
    })).rejects.toMatchObject({ statusCode: 403, code: 'TASK_CLAIM_FORBIDDEN' });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
    expect(queryUnsafeMock.mock.calls[2][0]).toMatch(/UPDATE tasks/i);
  });

  it('allows an ADMIN task-administrator on any task', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open', assigned_to_uid: OTHER, assigned_to_role: 'DOCTOR', metadata: {} }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 7 }]);
    const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER, actorRoles: ['ADMIN'] });
    expect(row.status).toBe('in_progress');
  });

  it('rejects a reason-only nursing override and never updates the task or linked SLA', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: OTHER,
        assigned_to_role: 'DOCTOR',
        patient_uid: PATIENT,
        workflow_sla_instance_id: SLA_ID, sla_completion_semantics: 'acknowledgement', metadata: {},
      }])
      .mockResolvedValueOnce([{
        id: 1,
        status: 'in_progress',
        patient_uid: PATIENT,
        ...ACK_RESOURCE,
        workflow_sla_instance_id: SLA_ID, sla_completion_semantics: 'acknowledgement', metadata: {},
      }])
      .mockResolvedValueOnce([{ id: SLA_ID, status: 'completed' }])
      .mockResolvedValueOnce([{ id: 8, body_kind: 'state_change' }]);

    await expect(acknowledgeTask({
      tenantId: TENANT, id: 1, actorUid: USER, actorRoles: ['NURSING_STAFF'],
      overrideReason: 'covering for the on-call doctor',
    })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    // The task read is the only query: arbitrary text must not authorize the
    // task UPDATE or stop its linked SLA clock.
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/^SELECT[\s\S]+FROM tasks/i);
  });

  it('rejects an oversized break-glass selector before querying its table', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'open',
      assigned_to_uid: OTHER,
      assigned_to_role: 'DOCTOR',
      patient_uid: PATIENT,
      workflow_sla_instance_id: SLA_ID, sla_completion_semantics: 'acknowledgement', metadata: {},
    }]);

    await expect(acknowledgeTask({
      tenantId: TENANT,
      id: 1,
      actorUid: USER,
      actorRoles: ['CMO'],
      breakGlassId: 2_147_483_648,
    })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/^SELECT[\s\S]+FROM tasks/i);
  });

  it('does not expose the trusted-workflow override on the public acknowledgeTask entrypoint', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'open',
      assigned_to_uid: OTHER,
      related_resource_type: 'cold_chain_excursions',
      related_resource_id: '7',
      metadata: {},
    }]);

    await expect(acknowledgeTask({
      tenantId: TENANT,
      id: 1,
      actorUid: USER,
      actorRoles: ['NURSING_STAFF'],
      trustedOverride: {
        source: 'cold_chain_excursion_ack',
        reason: 'Acknowledged via cold-chain excursion acknowledgement',
        id: '7',
      },
    })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('allows a CMO override only through the exact active patient break-glass record and durably records its provenance', async () => {
    const breakGlassReason = 'Emergency coverage';
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: OTHER,
        assigned_to_role: 'DOCTOR',
        patient_uid: PATIENT,
        metadata: {},
      }])
      .mockResolvedValueOnce([{ id: 41, actor_role: 'CMO', reason: breakGlassReason }])
      .mockResolvedValueOnce([{
        id: 1,
        status: 'in_progress',
        patient_uid: PATIENT,
        metadata: {},
      }])
      .mockResolvedValueOnce([{ id: 8, body_kind: 'state_change' }]);

    const row = await acknowledgeTask({
      tenantId: TENANT,
      id: 1,
      actorUid: USER,
      actorRoles: ['CMO'],
      breakGlassId: 41,
    });

    expect(row.status).toBe('in_progress');

    const breakGlassCall = queryUnsafeMock.mock.calls.find(([sql]) => /FROM patient_access_break_glass/i.test(sql));
    expect(breakGlassCall).toBeDefined();
    expect(breakGlassCall[0]).toMatch(/tenant_id\s*=\s*\$\d+::uuid/i);
    expect(breakGlassCall[0]).toMatch(/patient_uid\s*=\s*\$\d+::uuid/i);
    expect(breakGlassCall[0]).toMatch(/actor_uid\s*=\s*\$\d+::uuid/i);
    expect(breakGlassCall[0]).toMatch(/id\s*=\s*\$\d+::(?:int|bigint)/i);
    expect(breakGlassCall[0]).toMatch(/status\s*=\s*'active'/i);
    expect(breakGlassCall[0]).toMatch(/expires_at\s*>\s*NOW\(\)/i);
    expect(breakGlassCall[0]).toMatch(/actor_role/i);
    expect(breakGlassCall[0]).toMatch(/reason/i);
    expect(breakGlassCall.slice(1)).toEqual(expect.arrayContaining([TENANT, PATIENT, USER, 41]));

    const updateCall = queryUnsafeMock.mock.calls.find(([sql]) => /UPDATE tasks/i.test(sql));
    expect(updateCall[0]).toMatch(/acknowledge_override_source/i);
    expect(updateCall[0]).toMatch(/acknowledge_override_id/i);
    expect(updateCall[0]).toMatch(/acknowledge_override_reason/i);
    expect(updateCall[0]).toMatch(/EXISTS[\s\S]+FROM patient_access_break_glass/i);
    expect(updateCall[0]).toMatch(/bg\.status\s*=\s*'active'/i);
    expect(updateCall[0]).toMatch(/bg\.expires_at\s*>\s*NOW\(\)/i);
    expect(updateCall.slice(1)).toEqual(expect.arrayContaining([
      'patient_access_break_glass',
      '41',
      breakGlassReason,
    ]));

    const commentCall = queryUnsafeMock.mock.calls.find(([sql]) => /INSERT INTO task_comments/i.test(sql));
    const commentMetadataJson = commentCall.slice(1)
      .find((value) => typeof value === 'string' && value.includes('"override_source"'));
    expect(JSON.parse(commentMetadataJson)).toMatchObject({
      via: 'override',
      override_source: 'patient_access_break_glass',
      override_id: '41',
      override_reason: breakGlassReason,
    });
  });

  it('rejects an absent or expired break-glass record without touching the task or SLA', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: OTHER,
        assigned_to_role: 'DOCTOR',
        patient_uid: PATIENT,
        workflow_sla_instance_id: SLA_ID, sla_completion_semantics: 'acknowledgement', metadata: {},
      }])
      .mockResolvedValueOnce([]);

    await expect(acknowledgeTask({
      tenantId: TENANT,
      id: 1,
      actorUid: USER,
      actorRoles: ['CMO'],
      breakGlassId: 41,
    })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/FROM patient_access_break_glass/i);
  });

  it('rejects a break-glass record whose activating role is not in the caller signed roles', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: OTHER,
        assigned_to_role: 'DOCTOR',
        patient_uid: PATIENT,
        metadata: {},
      }])
      .mockResolvedValueOnce([{
        id: 41,
        actor_role: 'MEDICAL_SUPERINTENDENT',
        reason: 'Emergency coverage',
      }]);

    await expect(acknowledgeTask({
      tenantId: TENANT,
      id: 1,
      actorUid: USER,
      actorRoles: ['CMO'],
      breakGlassId: 41,
    })).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
  });

  it('uses a supplied tx client for the task read, guarded update, linked SLA, and audit comment', async () => {
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        assigned_to_uid: USER,
        patient_uid: PATIENT,
        ...ACK_RESOURCE,
        workflow_sla_instance_id: SLA_ID, sla_completion_semantics: 'acknowledgement', metadata: {},
      }])
      .mockResolvedValueOnce([{
        id: 1,
        status: 'in_progress',
        patient_uid: PATIENT,
        ...ACK_RESOURCE,
        workflow_sla_instance_id: SLA_ID, sla_completion_semantics: 'acknowledgement', metadata: {},
      }])
      .mockResolvedValueOnce([ackSlaRow({ id: SLA_ID })])
      .mockResolvedValueOnce([{ id: SLA_ID, status: 'completed' }])
      .mockResolvedValueOnce([{ id: 9, body_kind: 'state_change' }]);
    const tx = { $queryRawUnsafe: txQuery };

    const row = await acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER, tx });

    expect(row.status).toBe('in_progress');
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queryUnsafeMock).not.toHaveBeenCalled();
    expect(txQuery).toHaveBeenCalledTimes(5);
    expect(txQuery.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringMatching(/^SELECT[\s\S]+FROM tasks/i),
      expect.stringMatching(/UPDATE tasks/i),
      expect.stringMatching(/FROM workflow_sla_instances sla/i),
      expect.stringMatching(/UPDATE workflow_sla_instances/i),
      expect.stringMatching(/INSERT INTO task_comments/i),
    ]);
  });

  it.each([
    ['linked SLA', 3, 'tx SLA write failed'],
    ['audit comment', 4, 'tx comment write failed'],
  ])('does not swallow a supplied transaction failure from the %s write', async (_label, failingCall, message) => {
    const responses = [
      [{
        id: 1,
        status: 'open',
        assigned_to_uid: USER,
        patient_uid: PATIENT,
        ...ACK_RESOURCE,
        workflow_sla_instance_id: SLA_ID, sla_completion_semantics: 'acknowledgement', metadata: {},
      }],
      [{
        id: 1,
        status: 'in_progress',
        patient_uid: PATIENT,
        ...ACK_RESOURCE,
        workflow_sla_instance_id: SLA_ID, sla_completion_semantics: 'acknowledgement', metadata: {},
      }],
      [ackSlaRow({ id: SLA_ID })],
      [{ id: SLA_ID, status: 'completed' }],
      [{ id: 9, body_kind: 'state_change' }],
    ];
    const txQuery = jest.fn();
    responses.forEach((response, index) => {
      if (index === failingCall) txQuery.mockRejectedValueOnce(new Error(message));
      else txQuery.mockResolvedValueOnce(response);
    });
    const tx = { $queryRawUnsafe: txQuery };

    await expect(acknowledgeTask({ tenantId: TENANT, id: 1, actorUid: USER, tx }))
      .rejects.toThrow(message);
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('rejects an unassigned task with no override (no assignee, no role, no admin)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open', assigned_to_uid: null, assigned_to_role: null, metadata: {} }]);
    await expect(acknowledgeTask({
      tenantId: TENANT, id: 1, actorUid: USER, actorRoles: ['DOCTOR'],
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('resolveAckAuthorization (pure) — assignee/role/admin/override modes and rejection', () => {
    const { resolveAckAuthorization } = __testing__;
    expect(resolveAckAuthorization({ assigned_to_uid: USER }, { actorUid: USER }).mode).toBe('assignee');
    expect(resolveAckAuthorization({ assigned_to_role: 'DOCTOR' }, { actorUid: OTHER, actorRoles: ['DOCTOR'] }).mode).toBe('role');
    expect(resolveAckAuthorization(
      { assigned_to_uid: OTHER },
      { actorUid: USER, actorRoles: ['ADMIN'], actorRole: 'ADMIN' },
    ).mode).toBe('admin');
    expect(() => resolveAckAuthorization(
      { assigned_to_uid: OTHER, assigned_to_role: 'DOCTOR' },
      { actorUid: USER, actorRoles: ['DOCTOR'] },
    )).toThrow(/Not authorized/);
    expect(() => resolveAckAuthorization({ assigned_to_uid: OTHER }, { actorUid: USER, actorRoles: [], overrideReason: 'why' }))
      .toThrow(/Not authorized/);
    expect(() => resolveAckAuthorization({ assigned_to_uid: OTHER }, { actorUid: USER, actorRoles: ['NURSING_STAFF'] }))
      .toThrow(/Not authorized/);
  });
});

describe('acknowledgeColdChainTaskFromTrustedWorkflow', () => {
  const OTHER = '99999999-9999-4999-8999-999999999999';

  it('records normal role authority when the responder holds the task assignment', async () => {
    const roleTask = {
      id: 55,
      status: 'open',
      assigned_to_uid: null,
      assigned_to_role: 'PHARMACY_STAFF',
      related_resource_type: 'cold_chain_excursions',
      related_resource_id: '7',
      metadata: {},
    };
    const claimed = {
      ...roleTask,
      assigned_to_uid: USER,
      assigned_to_role: null,
      metadata: {
        role_claimed_by: USER,
        role_claimed_from_role: 'PHARMACY_STAFF',
      },
    };
    const txQuery = jest.fn()
      .mockResolvedValueOnce([roleTask])
      .mockResolvedValueOnce([roleTask])
      .mockResolvedValueOnce([claimed])
      .mockResolvedValueOnce([{ id: 9, body_kind: 'state_change' }])
      .mockResolvedValueOnce([{ ...claimed, status: 'in_progress' }])
      .mockResolvedValueOnce([{ id: 10, body_kind: 'state_change' }]);
    const tx = { $queryRawUnsafe: txQuery };

    await acknowledgeColdChainTaskFromTrustedWorkflow({
      tenantId: TENANT,
      id: 55,
      actorUid: USER,
      actorRoles: ['PHARMACY_STAFF'],
      excursionId: 7,
      tx,
    });

    const updateParams = txQuery.mock.calls[4].slice(1);
    expect(updateParams[2]).toBe('role');
    expect(updateParams[4]).toBe('PHARMACY_STAFF');
    expect(updateParams[5]).toBeNull();
    expect(updateParams[9]).toBe('7');
  });

  it('binds a trusted cold-chain acknowledgement to the linked excursion and its supplied tx', async () => {
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{
        id: 55,
        status: 'open',
        assigned_to_uid: OTHER,
        related_resource_type: 'cold_chain_excursions',
        related_resource_id: '7',
        metadata: {},
      }])
      .mockResolvedValueOnce([{
        id: 55,
        status: 'in_progress',
        related_resource_type: 'cold_chain_excursions',
        related_resource_id: '7',
        metadata: {},
      }])
      .mockResolvedValueOnce([{ id: 10, body_kind: 'state_change' }]);
    const tx = { $queryRawUnsafe: txQuery };
    const row = await acknowledgeColdChainTaskFromTrustedWorkflow({
      tenantId: TENANT,
      id: 55,
      actorUid: USER,
      actorRoles: ['PHARMACY_STAFF'],
      excursionId: 7,
      tx,
    });

    expect(row.status).toBe('in_progress');
    expect(queryUnsafeMock).not.toHaveBeenCalled();
    expect(txQuery.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringMatching(/^SELECT[\s\S]+FROM tasks/i),
      expect.stringMatching(/UPDATE tasks/i),
      expect.stringMatching(/INSERT INTO task_comments/i),
    ]);
    expect(txQuery.mock.calls[1][0]).toMatch(/acknowledge_override_source/i);
    expect(txQuery.mock.calls[1].slice(1)[2]).toBe('override');
    expect(txQuery.mock.calls[1].slice(1)).toEqual(expect.arrayContaining([
      'cold_chain_excursion_ack',
      '7',
      'Acknowledged via cold-chain excursion acknowledgement',
    ]));
  });

  it('rejects a trusted cold-chain acknowledgement when the task is linked to another excursion', async () => {
    const txQuery = jest.fn().mockResolvedValueOnce([{
      id: 55,
      status: 'open',
      assigned_to_uid: OTHER,
      related_resource_type: 'cold_chain_excursions',
      related_resource_id: '8',
      metadata: {},
    }]);
    const tx = { $queryRawUnsafe: txQuery };

    await expect(acknowledgeColdChainTaskFromTrustedWorkflow({
      tenantId: TENANT,
      id: 55,
      actorUid: USER,
      excursionId: 7,
      tx,
    })).rejects.toMatchObject({ statusCode: 403 });

    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('rejects the trusted entrypoint without the caller transaction', async () => {
    await expect(acknowledgeColdChainTaskFromTrustedWorkflow({
      tenantId: TENANT,
      id: 55,
      actorUid: USER,
      excursionId: 7,
    })).rejects.toMatchObject({ statusCode: 500, code: 'TRUSTED_TASK_ACK_TRANSACTION_REQUIRED' });

    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });
});

describe('listInboxTasks', () => {
  it('filters by assignee-OR-role and open/in_progress/overdue, ordered by priority then due_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    const result = await listInboxTasks({
      tenantId: TENANT, assigneeUid: USER, roles: ['DOCTOR', 'DUTY_DOCTOR'],
    });
    expect(result.count).toBe(2);
    const sql = queryUnsafeMock.mock.calls[0][0];
    // me OR my role
    expect(sql).toMatch(/assigned_to_uid = /);
    expect(sql).toMatch(/assigned_to_role/);
    expect(sql).toMatch(/assigned_to_uid IS NULL[\s\S]+UPPER\(BTRIM\(assigned_to_role\)\) = \$3::text/);
    // inbox status set
    expect(sql).toMatch(/'open', 'in_progress', 'overdue'/);
    // ordering
    expect(sql).toMatch(/CASE inbox\.priority WHEN 'critical' THEN 0/);
    expect(sql).toMatch(/due_at/);
    expect(queryUnsafeMock.mock.calls[0][5]).toBe(true);
  });

  it('works with only an assignee and no roles', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    const result = await listInboxTasks({ tenantId: TENANT, assigneeUid: USER, roles: [] });
    expect(result.count).toBe(1);
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/assigned_to_uid = /);
  });

  it('degrades to empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "tasks" does not exist'));
    const result = await listInboxTasks({ tenantId: TENANT, assigneeUid: USER, roles: ['DOCTOR'] });
    expect(result).toEqual({ tasks: [], count: 0 });
  });

  it('fails closed for cross-sign projection after the live actor role leaves physician policy', async () => {
    resolveCurrentHumanActorTxMock.mockResolvedValueOnce({
      uid: USER,
      role: 'NURSING_STAFF',
      queueRole: 'NURSING_STAFF',
      rawRole: 'NURSING_STAFF',
    });
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      can_cross_sign: false,
    }]);

    const result = await listInboxTasks({
      tenantId: TENANT,
      assigneeUid: USER,
      roles: ['NURSING_STAFF'],
      primaryRole: 'NURSING_STAFF',
    });

    expect(result.tasks[0].can_cross_sign).toBe(false);
    const [sql, tenantId, actorUid, queueRole, limit, physicianEligible] =
      queryUnsafeMock.mock.calls[0];
    expect(sql).toContain('AND $5::boolean');
    expect(tenantId).toBe(TENANT);
    expect(actorUid).toBe(USER);
    expect(queueRole).toBe('NURSING_STAFF');
    expect(limit).toBeGreaterThan(0);
    expect(physicianEligible).toBe(false);
  });
});

describe('TASK_TRANSITIONS map', () => {
  it('open allows in_progress / blocked / completed / cancelled', () => {
    expect(__testing__.TASK_TRANSITIONS.open).toEqual(
      expect.arrayContaining(['in_progress', 'blocked', 'completed', 'cancelled']),
    );
  });
  it('completed and cancelled are terminal', () => {
    expect(__testing__.TASK_TRANSITIONS.completed).toEqual([]);
    expect(__testing__.TASK_TRANSITIONS.cancelled).toEqual([]);
  });
});

describe('workflow transition maps', () => {
  it('allows active run progress while keeping terminal runs immutable', () => {
    expect(__testing__.WORKFLOW_RUN_TRANSITIONS.started).toContain('running');
    expect(__testing__.WORKFLOW_RUN_TRANSITIONS.started).not.toContain('completed');
    expect(__testing__.WORKFLOW_RUN_TRANSITIONS.running).toContain('completed');
    expect(__testing__.WORKFLOW_RUN_TRANSITIONS.blocked).not.toContain('completed');
    expect(__testing__.WORKFLOW_RUN_TRANSITIONS.completed).toEqual([]);
    expect(__testing__.WORKFLOW_RUN_TRANSITIONS.cancelled).toEqual([]);
    expect(__testing__.WORKFLOW_RUN_TRANSITIONS.failed).toEqual([]);
  });

  it('allows pending step progress while keeping terminal steps immutable', () => {
    expect(__testing__.WORKFLOW_STEP_TRANSITIONS.pending).toContain('in_progress');
    expect(__testing__.WORKFLOW_STEP_TRANSITIONS.pending).not.toContain('completed');
    expect(__testing__.WORKFLOW_STEP_TRANSITIONS.in_progress).toContain('completed');
    expect(__testing__.WORKFLOW_STEP_TRANSITIONS.blocked).not.toContain('completed');
    expect(__testing__.WORKFLOW_STEP_TRANSITIONS.completed).toEqual([]);
    expect(__testing__.WORKFLOW_STEP_TRANSITIONS.skipped).toEqual([]);
    expect(__testing__.WORKFLOW_STEP_TRANSITIONS.failed).toEqual([]);
  });
});

describe('transitionTask', () => {
  it('rejects illegal transition (completed -> open)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed' }]);
    await expect(transitionTask({ tenantId: TENANT, id: 1, nextStatus: 'open' }))
      .rejects.toThrow(/transition/i);
  });

  it('flips open -> completed and stamps completed_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed' }]);
    const row = await transitionTask({ tenantId: TENANT, id: 1, nextStatus: 'completed' });
    expect(row.status).toBe('completed');
    const transitionCall = queryUnsafeMock.mock.calls[1];
    const sql = transitionCall[0];
    expect(sql).toMatch(/completed_at = to_timestamp\(\$\d::double precision \/ 1000\.0\)/);
    expect(typeof transitionCall[2]).toBe('number');
    expect(sql).toMatch(/AND status = \$\d/);
    expect(queryUnsafeMock.mock.calls[1]).toContain('open');
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });

  it('records cancellation_reason on cancel', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'cancelled' }]);
    await transitionTask({
      tenantId: TENANT, id: 1, nextStatus: 'cancelled', cancellationReason: 'duplicate',
    });
    const params = queryUnsafeMock.mock.calls[1].slice(1);
    expect(params).toContain('duplicate');
  });

  it('rejects cancellation while a typed linked SLA remains incomplete', async () => {
    const task = {
      id: 1,
      status: 'open',
      ...ACK_RESOURCE,
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'acknowledgement',
      metadata: {},
    };
    queryUnsafeMock
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([ackSlaRow()])
      .mockResolvedValueOnce([{ completed_at: null }]);

    await expect(transitionTask({ tenantId: TENANT, id: 1, nextStatus: 'cancelled' }))
      .rejects.toMatchObject({ code: 'TASK_LINKED_SLA_INCOMPLETE' });

    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
  });

  it('allows cancellation after the linked SLA obligation is complete without rewriting it', async () => {
    const task = {
      id: 1,
      status: 'in_progress',
      ...ACK_RESOURCE,
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'acknowledgement',
      metadata: {},
    };
    queryUnsafeMock
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([ackSlaRow()])
      .mockResolvedValueOnce([{ completed_at: new Date('2026-07-19T03:00:00.000Z') }])
      .mockResolvedValueOnce([{ ...task, status: 'cancelled' }]);

    const cancelled = await transitionTask({ tenantId: TENANT, id: 1, nextStatus: 'cancelled' });

    expect(cancelled.status).toBe('cancelled');
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE workflow_sla_instances/i.test(sql))).toBe(false);
  });

  it('requires the strict evidence entrypoint to complete domain-evidence work', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'in_progress',
      related_resource_type: 'death_record',
      related_resource_id: '55',
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'domain_evidence',
      metadata: {},
    }]);
    queryUnsafeMock.mockResolvedValueOnce([mortuarySlaRow()]);
    queryUnsafeMock.mockResolvedValueOnce([{ '?column?': 1 }]);

    await expect(transitionTask({ tenantId: TENANT, id: 1, nextStatus: 'completed' }))
      .rejects.toMatchObject({ code: 'DOMAIN_EVIDENCE_REQUIRED' });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
  });

  it.each(['acknowledgement', 'domain_evidence', 'none'])(
    'rejects a generic transition of a pathway-bound %s task before any mutation',
    async (slaCompletionSemantics) => {
      queryUnsafeMock
        .mockResolvedValueOnce([{
          id: 1,
          status: 'open',
          workflow_run_id: 7,
          workflow_step_id: 91,
          workflow_sla_instance_id: slaCompletionSemantics === 'none'
            ? null
            : DEFAULT_SLA_ID,
          sla_completion_semantics: slaCompletionSemantics,
          metadata: {},
        }])
        .mockResolvedValueOnce([{ '?column?': 1 }]);

      await expect(transitionTask({ tenantId: TENANT, id: 1, nextStatus: 'in_progress' }))
        .rejects.toMatchObject({ code: 'PATHWAY_EXECUTOR_REQUIRED' });
      expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
      expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
    },
  );

  it('refuses generic completion of an acknowledgement-tracked task with no durable receipt', async () => {
    const task = {
      id: 1,
      status: 'open',
      ...ACK_RESOURCE,
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'acknowledgement',
      metadata: {},
    };
    queryUnsafeMock
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([ackSlaRow()]);

    await expect(transitionTask({ tenantId: TENANT, id: 1, nextStatus: 'completed' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'TASK_ACKNOWLEDGEMENT_REQUIRED' });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE workflow_sla_instances/i.test(sql))).toBe(false);
  });

  it('allows completion of an acknowledgement-tracked task once the receipt is stamped', async () => {
    const task = {
      id: 1,
      status: 'in_progress',
      ...ACK_RESOURCE,
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'acknowledgement',
      metadata: { acknowledged_at: '2026-07-19T03:00:00.000Z' },
    };
    queryUnsafeMock
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([ackSlaRow()])
      .mockResolvedValueOnce([{ ...task, status: 'completed' }])
      .mockResolvedValueOnce([{ id: DEFAULT_SLA_ID, status: 'completed' }]);

    const row = await transitionTask({ tenantId: TENANT, id: 1, nextStatus: 'completed' });
    expect(row.status).toBe('completed');
  });

  it('rejects a generic transition when the typed SLA belongs to another source', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 1,
        status: 'open',
        ...ACK_RESOURCE,
        workflow_sla_instance_id: DEFAULT_SLA_ID,
        sla_completion_semantics: 'acknowledgement',
        metadata: {},
      }])
      .mockResolvedValueOnce([ackSlaRow({ source_table: 'other_resource' })]);

    await expect(transitionTask({ tenantId: TENANT, id: 1, nextStatus: 'completed' }))
      .rejects.toMatchObject({ code: 'TASK_SLA_SOURCE_BINDING_INVALID' });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
  });

  it('rejects generic acknowledgement progress even with a spoofed actor and caller-made capability', async () => {
    const task = {
      id: 1,
      status: 'open',
      assigned_to_uid: USER,
      ...ACK_RESOURCE,
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'acknowledgement',
      metadata: { acknowledgementTransitionAuthority: 'caller-controlled' },
    };
    queryUnsafeMock
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([ackSlaRow()]);

    await expect(transitionTask({
      tenantId: TENANT,
      id: 1,
      nextStatus: 'in_progress',
      actorUid: USER,
      acknowledgementTransitionAuthority: Symbol('ACKNOWLEDGEMENT_TRANSITION_AUTHORITY'),
      metadata: { acknowledged_at: new Date().toISOString() },
    })).rejects.toMatchObject({ statusCode: 409, code: 'TASK_ACKNOWLEDGEMENT_REQUIRED' });

    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
  });

  it('validates an explicitly supplied server actor before mutation', async () => {
    await expect(transitionTask({
      tenantId: TENANT, id: 1, nextStatus: 'completed', actorUid: null,
    })).rejects.toMatchObject({ statusCode: 401 });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('reports a compare-and-set loser as conflict when the tenant row still exists', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'open' }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed' }]);
    await expect(transitionTask({ tenantId: TENANT, id: 1, nextStatus: 'completed' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'TASK_TRANSITION_CONFLICT' });
  });

  it('propagates linked SLA failure through the task transition transaction', async () => {
    const task = {
      id: 1,
      status: 'open',
      ...ACK_RESOURCE,
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'acknowledgement',
      // A durable receipt so completion passes the acknowledgement gate — this
      // test is about SLA-write failure propagation, not the gate.
      metadata: { acknowledged_at: '2026-07-19T03:00:00.000Z' },
    };
    queryUnsafeMock.mockResolvedValueOnce([task]);
    queryUnsafeMock.mockResolvedValueOnce([ackSlaRow()]);
    queryUnsafeMock.mockResolvedValueOnce([{ ...task, status: 'completed' }]);
    queryUnsafeMock.mockRejectedValueOnce(new Error('SLA write failed'));

    await expect(transitionTask({ tenantId: TENANT, id: 1, nextStatus: 'completed' }))
      .rejects.toThrow('SLA write failed');
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });

  it('preserves a supplied transaction without nesting setTenantTx', async () => {
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{ id: 1, status: 'open', metadata: {} }])
      .mockResolvedValueOnce([{ id: 1, status: 'completed', metadata: {} }]);
    const tx = { $queryRawUnsafe: txQuery };

    const row = await transitionTask({
      tenantId: TENANT, id: 1, nextStatus: 'completed', tx,
    });

    expect(row.status).toBe('completed');
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });
});

describe('supersedeAcknowledgementTaskFromTrustedWorkflow', () => {
  it('uses its private capability for the blocked edge and closes only the exact critical-result binding', async () => {
    const completedAt = new Date('2026-07-19T04:00:00.000Z');
    const task = {
      id: 1,
      status: 'blocked',
      ...ACK_RESOURCE,
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'acknowledgement',
      metadata: {},
    };
    const txQuery = jest.fn()
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([ackSlaRow()])
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([{ ...task, status: 'in_progress' }])
      .mockResolvedValueOnce([{ ...task, status: 'in_progress' }])
      .mockResolvedValueOnce([{ ...task, status: 'completed', completed_at: completedAt }])
      .mockResolvedValueOnce([{ id: DEFAULT_SLA_ID, status: 'completed' }]);

    const row = await supersedeAcknowledgementTaskFromTrustedWorkflow({
      tenantId: TENANT,
      id: 1,
      relatedResourceType: 'lab_result',
      relatedResourceId: '1',
      workflowSlaInstanceId: DEFAULT_SLA_ID,
      supersededByActorUid: USER,
      tx: { $queryRawUnsafe: txQuery },
    });

    expect(row.status).toBe('completed');
    const taskUpdates = txQuery.mock.calls.filter(([sql]) => /UPDATE tasks SET/i.test(sql));
    expect(taskUpdates).toHaveLength(2);
    expect(taskUpdates[0][1]).toBe('in_progress');
    expect(taskUpdates[1][1]).toBe('completed');
    expect(taskUpdates[1][0]).toMatch(/completed_at = to_timestamp/);
    expect(txQuery.mock.calls[6][7]).toBe(taskUpdates[1][2]);
    expect(txQuery.mock.calls[6][5]).toBe(USER);
  });

  it('rejects a mismatched resource before mutating the task', async () => {
    const task = {
      id: 1,
      status: 'blocked',
      ...ACK_RESOURCE,
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'acknowledgement',
      metadata: {},
    };
    const txQuery = jest.fn()
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([ackSlaRow()]);

    await expect(supersedeAcknowledgementTaskFromTrustedWorkflow({
      tenantId: TENANT,
      id: 1,
      relatedResourceType: 'lab_result',
      relatedResourceId: 'different',
      workflowSlaInstanceId: DEFAULT_SLA_ID,
      supersededByActorUid: USER,
      tx: { $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ code: 'ACKNOWLEDGEMENT_SUPERSESSION_INVALID' });
    expect(txQuery.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
  });

  it('rejects a missing supersession actor before reading the task', async () => {
    const txQuery = jest.fn();

    await expect(supersedeAcknowledgementTaskFromTrustedWorkflow({
      tenantId: TENANT,
      id: 1,
      relatedResourceType: 'lab_result',
      relatedResourceId: '1',
      workflowSlaInstanceId: DEFAULT_SLA_ID,
      tx: { $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ statusCode: 401 });
    expect(txQuery).not.toHaveBeenCalled();
  });
});

describe('completeTaskFromDomainEvidence', () => {
  it('rejects domain evidence when the linked SLA belongs to another death record', async () => {
    const task = {
      id: 1,
      status: 'in_progress',
      related_resource_type: 'death_record',
      related_resource_id: '55',
      workflow_sla_instance_id: DEFAULT_SLA_ID,
      sla_completion_semantics: 'domain_evidence',
      metadata: {},
    };
    const txQuery = jest.fn()
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([mortuarySlaRow({ source_id: '56' })]);

    await expect(completeTaskFromDomainEvidence({
      tenantId: TENANT,
      id: 1,
      evidenceKind: 'mortuary_body_release',
      evidenceResourceType: 'body_custody_event',
      evidenceResourceId: '9',
      tx: { $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ code: 'TASK_SLA_SOURCE_BINDING_INVALID' });
    expect(txQuery.mock.calls.some(([sql]) => /body_custody_events/i.test(sql))).toBe(false);
  });

  it('validates a registered mortuary release and completes task and SLA atomically', async () => {
    const slaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const task = {
      id: 1,
      status: 'in_progress',
      related_resource_type: 'death_record',
      related_resource_id: '55',
      workflow_sla_instance_id: slaId,
      sla_completion_semantics: 'domain_evidence',
      metadata: {},
    };
    const txQuery = jest.fn()
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([mortuarySlaRow({ id: slaId })])
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([{
        id: 9n,
        event_type: 'release',
        event_at: new Date('2026-07-19T03:00:00.000Z'),
        created_at: new Date('2026-07-19T06:00:00.001Z'),
        event_at_epoch_ms: Date.parse('2026-07-19T03:00:00.000Z'),
        created_at_epoch_ms: Date.parse('2026-07-19T06:00:00.001Z'),
      }])
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([{ ...task, status: 'completed' }])
      .mockResolvedValueOnce([{ id: slaId, status: 'completed', completed_at: new Date() }])
      .mockResolvedValueOnce([{ id: 12, body_kind: 'state_change' }]);
    const tx = { $queryRawUnsafe: txQuery };

    const row = await completeTaskFromDomainEvidence({
      tenantId: TENANT,
      id: 1,
      evidenceKind: 'mortuary_body_release',
      evidenceResourceType: 'body_custody_event',
      evidenceResourceId: '9',
      actorUid: USER,
      tx,
    });

    expect(row.status).toBe('completed');
    const slaSql = txQuery.mock.calls[6][0];
    expect(slaSql).toMatch(/completed_at IS NULL/);
    expect(slaSql).toMatch(/completion_evidence/);
    expect(slaSql).toMatch(/to_timestamp\(\$7::double precision \/ 1000\.0\) > due_at/);
    expect(new Date(txQuery.mock.calls[6][7]).toISOString()).toBe('2026-07-19T06:00:00.001Z');
    expect(JSON.parse(txQuery.mock.calls[6][6])).toMatchObject({
      occurred_at: '2026-07-19T03:00:00.000Z',
      recorded_at: '2026-07-19T06:00:00.001Z',
    });
    expect(txQuery.mock.calls[3][0]).toMatch(/sla\.rule_code = 'mortuary_unclaimed_body'/);
  });

  it('rejects missing registered evidence before changing task state', async () => {
    const task = {
      id: 1,
      status: 'in_progress',
      related_resource_type: 'death_record',
      related_resource_id: '55',
      workflow_sla_instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sla_completion_semantics: 'domain_evidence',
      metadata: {},
    };
    const txQuery = jest.fn()
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([mortuarySlaRow()])
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([]);

    await expect(completeTaskFromDomainEvidence({
      tenantId: TENANT,
      id: 1,
      evidenceKind: 'mortuary_body_release',
      evidenceResourceType: 'body_custody_event',
      evidenceResourceId: '9',
      tx: { $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ code: 'DOMAIN_EVIDENCE_NOT_FOUND' });
    expect(txQuery.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
  });

  it('rejects a malformed polymorphic mortuary resource id without casting it in SQL', async () => {
    const task = {
      id: 1,
      status: 'in_progress',
      related_resource_type: 'death_record',
      related_resource_id: 'legacy:not-an-integer',
      workflow_sla_instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sla_completion_semantics: 'domain_evidence',
      metadata: {},
    };
    const txQuery = jest.fn()
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([mortuarySlaRow({ source_id: 'legacy:not-an-integer' })])
      .mockResolvedValueOnce([]);

    await expect(completeTaskFromDomainEvidence({
      tenantId: TENANT,
      id: 1,
      evidenceKind: 'mortuary_body_release',
      evidenceResourceType: 'body_custody_event',
      evidenceResourceId: '9',
      tx: { $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ code: 'TASK_SLA_SOURCE_BINDING_INVALID' });
    expect(txQuery).toHaveBeenCalledTimes(3);
    expect(txQuery.mock.calls.some(([sql]) => /body_custody_events/i.test(sql))).toBe(false);
  });

  it('does not bless a legacy generic SLA completion during evidence replay', async () => {
    const slaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const task = {
      id: 1,
      status: 'completed',
      related_resource_type: 'death_record',
      related_resource_id: '55',
      workflow_sla_instance_id: slaId,
      sla_completion_semantics: 'domain_evidence',
      metadata: {},
    };
    const txQuery = jest.fn()
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([mortuarySlaRow({ id: slaId })])
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([{
        id: 9n,
        event_type: 'release',
        event_at: new Date('2026-07-19T03:00:00.000Z'),
        created_at: new Date('2026-07-19T03:00:01.000Z'),
        event_at_epoch_ms: Date.parse('2026-07-19T03:00:00.000Z'),
        created_at_epoch_ms: Date.parse('2026-07-19T03:00:01.000Z'),
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: slaId,
        completed_at: new Date('2026-07-18T03:00:00.000Z'),
        metadata: { completed_via: 'task_ack' },
      }]);

    await expect(completeTaskFromDomainEvidence({
      tenantId: TENANT,
      id: 1,
      evidenceKind: 'mortuary_body_release',
      evidenceResourceType: 'body_custody_event',
      evidenceResourceId: '9',
      tx: { $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ code: 'SLA_DOMAIN_EVIDENCE_MISMATCH' });
  });
});

describe('completePathwayTaskFromRegisteredEvidence', () => {
  const PATHWAY_INSTANCE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const HANDLER_ID = 'test.registered_condition.v1';
  const USER_ACTOR = Object.freeze({
    kind: 'user',
    uid: USER,
    roles: Object.freeze(['DOCTOR']),
    primaryRole: 'DOCTOR',
    authorizationMode: 'assigned_clinician',
  });
  const SIGNAL = Object.freeze({
    kind: 'domain_evidence_recorded',
    payload: Object.freeze({}),
    source_resource_type: null,
    source_resource_id: null,
    occurred_at: null,
  });
  const USER_PROVENANCE = Object.freeze({
    actor_kind: 'user',
    actor_uid: USER,
    authorization_mode: 'assigned_clinician',
    override_reason: null,
    break_glass_id: null,
    signal_kind: 'domain_evidence_recorded',
    source_resource_type: null,
    source_resource_id: null,
    occurred_at: null,
  });
  const pathwayTask = (overrides = {}) => ({
    id: 1,
    status: 'in_progress',
    workflow_run_id: 7,
    workflow_step_id: 91,
    workflow_sla_instance_id: DEFAULT_SLA_ID,
    sla_completion_semantics: 'domain_evidence',
    metadata: {},
    ...overrides,
  });
  const pathwaySla = (overrides = {}) => ({
    id: DEFAULT_SLA_ID,
    rule_code: 'pathway_lab_review',
    source_table: 'workflow_steps',
    source_id: '91',
    status: 'active',
    completed_at: null,
    ...overrides,
  });
  const normalizedEvidence = {
    kind: 'pathway_registered_condition',
    handler_id: HANDLER_ID,
    decision: 'satisfied',
    resource_type: 'workflow_steps',
    resource_id: '91',
    payload: { lab_verified: true },
    provenance: USER_PROVENANCE,
  };
  const pathwayRuntime = (task) => ({
    instance: { id: PATHWAY_INSTANCE_ID, workflow_run_id: 7 },
    run: { id: 7 },
    steps: [{ id: 91, workflow_run_id: 7, step_key: 'lab_review' }],
    tasks: [task],
    definition: {
      steps: [{ step_key: 'lab_review', condition_handler: HANDLER_ID }],
    },
  });

  const complete = ({ tx, ...overrides } = {}) => completePathwayTaskFromRegisteredEvidence({
    tenantId: TENANT,
    pathwayInstanceId: PATHWAY_INSTANCE_ID,
    id: 1,
    workflowRunId: 7,
    workflowStepId: 91,
    conditionHandler: HANDLER_ID,
    evidence: { lab_verified: true },
    actor: USER_ACTOR,
    signal: SIGNAL,
    executorAuthority: PATHWAY_TEST_CAPABILITY,
    tx,
    ...overrides,
  });

  it('rejects callers without the sealed pathway-executor authority before reading the task', async () => {
    const txQuery = jest.fn();

    await expect(completePathwayTaskFromRegisteredEvidence({
      tenantId: TENANT,
      pathwayInstanceId: PATHWAY_INSTANCE_ID,
      id: 1,
      workflowRunId: 7,
      workflowStepId: 91,
      conditionHandler: HANDLER_ID,
      tx: { __tenantTransaction: true, $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ code: 'PATHWAY_EXECUTOR_REQUIRED' });
    expect(txQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['forged', { kind: 'test_pathway_executor_capability' }],
    ['copied', { ...PATHWAY_TEST_CAPABILITY }],
  ])('rejects a %s executor capability before reading pathway state', async (_label, authority) => {
    const txQuery = jest.fn();

    await expect(completePathwayTaskFromRegisteredEvidence({
      tenantId: TENANT,
      pathwayInstanceId: PATHWAY_INSTANCE_ID,
      id: 1,
      workflowRunId: 7,
      workflowStepId: 91,
      conditionHandler: HANDLER_ID,
      evidence: {},
      actor: USER_ACTOR,
      signal: SIGNAL,
      executorAuthority: authority,
      tx: { __tenantTransaction: true, $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ code: 'PATHWAY_EXECUTOR_REQUIRED' });
    expect(txQuery).not.toHaveBeenCalled();
  });

  it('rejects a pathway instance cross-wired to the supplied workflow run before mutation', async () => {
    const txQuery = jest.fn().mockResolvedValueOnce([]);

    await expect(complete({
      pathwayInstanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      tx: { __tenantTransaction: true, $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ code: 'PATHWAY_TASK_CONTEXT_MISMATCH' });
    expect(txQuery).toHaveBeenCalledTimes(1);
    expect(txQuery.mock.calls[0][0]).toMatch(/AND id = \$3::uuid/);
    expect(txQuery.mock.calls.some(([sql]) => /UPDATE (tasks|workflow_sla_instances)/i.test(sql)))
      .toBe(false);
  });

  it.each(['1x', '01', 1.5, 0])('rejects non-canonical task id %p before reading pathway state', async (id) => {
    const txQuery = jest.fn();

    await expect(complete({
      id,
      tx: { __tenantTransaction: true, $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ code: 'PATHWAY_TASK_CONTEXT_INVALID' });
    expect(txQuery).not.toHaveBeenCalled();
  });

  it('rejects a non-versioned condition handler before reading pathway state', async () => {
    const txQuery = jest.fn();

    await expect(complete({
      conditionHandler: 'registered_condition',
      tx: { __tenantTransaction: true, $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ code: 'PATHWAY_HANDLER_CONTRACT_INVALID' });
    expect(txQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['date', { value: new Date('2026-07-19T06:00:00.000Z') }],
    ['non-finite number', { value: Number.NaN }],
  ])('rejects %s evidence through the shared JSON guard', async (_label, evidence) => {
    const txQuery = jest.fn();

    await expect(complete({
      evidence,
      tx: { __tenantTransaction: true, $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ code: 'PATHWAY_HANDLER_CONTRACT_INVALID' });
    expect(txQuery).not.toHaveBeenCalled();
  });

  it('accepts an exactly 65536-byte normalized evidence document and rejects one byte more', async () => {
    const makeEvidence = (targetBytes) => {
      const normalized = {
        kind: 'pathway_registered_condition',
        handler_id: HANDLER_ID,
        decision: 'satisfied',
        resource_type: 'workflow_steps',
        resource_id: '91',
        payload: { blob: '' },
        provenance: USER_PROVENANCE,
      };
      const fixedBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
      return { blob: 'x'.repeat(targetBytes - fixedBytes) };
    };
    const exactQuery = jest.fn().mockResolvedValueOnce([]);
    await expect(complete({
      evidence: makeEvidence(65536),
      tx: { __tenantTransaction: true, $queryRawUnsafe: exactQuery },
    })).rejects.toMatchObject({ code: 'PATHWAY_TASK_CONTEXT_MISMATCH' });
    expect(exactQuery).toHaveBeenCalledTimes(1);

    const overQuery = jest.fn();
    await expect(complete({
      evidence: makeEvidence(65537),
      tx: { __tenantTransaction: true, $queryRawUnsafe: overQuery },
    })).rejects.toMatchObject({ code: 'PATHWAY_HANDLER_CONTRACT_INVALID' });
    expect(overQuery).not.toHaveBeenCalled();
  });

  it('requires the executor to supply the branded tenant transaction', async () => {
    const txQuery = jest.fn();

    await expect(complete({ tx: { $queryRawUnsafe: txQuery } }))
      .rejects.toMatchObject({ code: 'PATHWAY_RUNTIME_TX_REQUIRED' });
    expect(txQuery).not.toHaveBeenCalled();
  });

  it('rejects a pathway task whose SLA is bound to another workflow step', async () => {
    lockPathwayRuntimeTxMock.mockResolvedValueOnce(pathwayRuntime(pathwayTask()));
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }])
      .mockResolvedValueOnce([pathwaySla({ source_id: '92' })]);

    await expect(complete({
      tx: { __tenantTransaction: true, $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ code: 'TASK_SLA_SOURCE_BINDING_INVALID' });
    expect(txQuery.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
  });

  it('rejects evidence attributed to a handler other than the pinned governed step handler', async () => {
    lockPathwayRuntimeTxMock.mockResolvedValueOnce(pathwayRuntime(pathwayTask()));
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }]);

    await expect(complete({
      conditionHandler: 'test.different_condition.v1',
      tx: { __tenantTransaction: true, $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ code: 'PATHWAY_HANDLER_CONTRACT_INVALID' });
    expect(txQuery).toHaveBeenCalledTimes(1);
  });

  it('atomically completes an in-progress task and linked SLA with normalized condition evidence', async () => {
    const completedTask = pathwayTask({ status: 'completed' });
    const completedAt = new Date('2026-07-19T06:00:00.000Z');
    const completedSla = {
      ...pathwaySla(),
      status: 'completed',
      completed_at: completedAt,
      metadata: {
        completed_via: 'domain_evidence',
        completion_evidence: normalizedEvidence,
      },
      evidence_matches: true,
    };
    lockPathwayRuntimeTxMock.mockResolvedValueOnce(pathwayRuntime(pathwayTask()));
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }])
      .mockResolvedValueOnce([pathwaySla()])
      .mockResolvedValueOnce([pathwayTask()])
      .mockResolvedValueOnce([completedTask])
      .mockResolvedValueOnce([{ id: DEFAULT_SLA_ID, status: 'completed', completed_at: completedAt }])
      .mockResolvedValueOnce([completedSla])
      .mockResolvedValueOnce([{ id: 12, body_kind: 'state_change' }]);
    const tx = { __tenantTransaction: true, $queryRawUnsafe: txQuery };

    const result = await complete({ tx });

    expect(result).toEqual({
      task: completedTask,
      sla: completedSla,
      evidence: normalizedEvidence,
      previousTaskStatus: 'in_progress',
      previousSlaStatus: 'active',
      mutated: true,
    });
    expect(lockPathwayRuntimeTxMock).toHaveBeenCalledWith({
      tx,
      tenantId: TENANT,
      pathwayInstanceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    expect(txQuery.mock.calls[4][0]).toMatch(/completed_at IS NULL/);
    expect(txQuery.mock.calls[4][0]).toMatch(/completion_evidence/);
    expect(txQuery.mock.calls[4][6]).toBe(JSON.stringify(normalizedEvidence));
    expect(txQuery.mock.calls[6][0]).toMatch(/INSERT INTO task_comments/);
  });

  it('advances a blocked task through in_progress before evidence completion', async () => {
    const blockedTask = pathwayTask({ status: 'blocked' });
    const inProgressTask = pathwayTask({ status: 'in_progress' });
    const completedTask = pathwayTask({ status: 'completed' });
    const completedAt = new Date('2026-07-19T06:00:00.000Z');
    const completedSla = {
      ...pathwaySla(),
      status: 'completed',
      completed_at: completedAt,
      metadata: { completed_via: 'domain_evidence', completion_evidence: normalizedEvidence },
      evidence_matches: true,
    };
    lockPathwayRuntimeTxMock.mockResolvedValueOnce(pathwayRuntime(blockedTask));
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }])
      .mockResolvedValueOnce([pathwaySla()])
      .mockResolvedValueOnce([blockedTask])
      .mockResolvedValueOnce([inProgressTask])
      .mockResolvedValueOnce([inProgressTask])
      .mockResolvedValueOnce([completedTask])
      .mockResolvedValueOnce([{ id: DEFAULT_SLA_ID, status: 'completed', completed_at: completedAt }])
      .mockResolvedValueOnce([completedSla])
      .mockResolvedValueOnce([{ id: 13, body_kind: 'state_change' }]);

    const result = await complete({
      tx: { __tenantTransaction: true, $queryRawUnsafe: txQuery },
    });

    expect(result.task.status).toBe('completed');
    expect(txQuery.mock.calls[3][1]).toBe('in_progress');
    expect(txQuery.mock.calls[5][1]).toBe('completed');
  });

  it('propagates a strict SLA write failure before writing the audit comment', async () => {
    lockPathwayRuntimeTxMock.mockResolvedValueOnce(pathwayRuntime(pathwayTask()));
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }])
      .mockResolvedValueOnce([pathwaySla()])
      .mockResolvedValueOnce([pathwayTask()])
      .mockResolvedValueOnce([pathwayTask({ status: 'completed' })])
      .mockRejectedValueOnce(new Error('forced pathway SLA failure'));

    await expect(complete({
      tx: { __tenantTransaction: true, $queryRawUnsafe: txQuery },
    })).rejects.toThrow('forced pathway SLA failure');
    expect(txQuery).toHaveBeenCalledTimes(5);
    expect(txQuery.mock.calls.some(([sql]) => /INSERT INTO task_comments/i.test(sql))).toBe(false);
  });

  it('replays exact stored evidence without changing completed_at or duplicating the comment', async () => {
    const completedAt = new Date('2026-07-19T06:00:00.000Z');
    const completedTask = pathwayTask({ status: 'completed' });
    const completedSla = {
      ...pathwaySla(),
      status: 'completed',
      completed_at: completedAt,
      metadata: { completed_via: 'domain_evidence', completion_evidence: normalizedEvidence },
      evidence_matches: true,
    };
    lockPathwayRuntimeTxMock.mockResolvedValueOnce(pathwayRuntime(completedTask));
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }])
      .mockResolvedValueOnce([pathwaySla({ status: 'completed', completed_at: completedAt })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([completedSla]);

    const result = await complete({
      tx: { __tenantTransaction: true, $queryRawUnsafe: txQuery },
    });

    expect(result.sla.completed_at).toEqual(completedAt);
    expect(result).toMatchObject({
      previousTaskStatus: 'completed',
      previousSlaStatus: 'completed',
      mutated: false,
    });
    expect(txQuery.mock.calls[2][0]).toMatch(/completed_at IS NULL/);
    expect(txQuery).toHaveBeenCalledTimes(4);
    expect(txQuery.mock.calls.some(([sql]) => /INSERT INTO task_comments/i.test(sql))).toBe(false);
  });
});

describe('completePathwayTaskFromRegisteredCondition', () => {
  const PATHWAY_INSTANCE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const CLOSURE_EVIDENCE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const HANDLER_ID = 'op.recovery_action.v1';
  const USER_ACTOR = Object.freeze({
    kind: 'user',
    uid: USER,
    roles: Object.freeze(['DOCTOR']),
    primaryRole: 'DOCTOR',
    authorizationMode: 'assigned_clinician',
  });
  const SIGNAL = Object.freeze({
    kind: 'appointment_closure_evidence_recorded',
    payload: Object.freeze({ appointment_id: 41 }),
    source_resource_type: 'event_outbox',
    source_resource_id: '301',
    occurred_at: '2026-07-24T08:00:00.000Z',
  });
  const task = (overrides = {}) => ({
    id: 94,
    status: 'in_progress',
    workflow_run_id: 7,
    workflow_step_id: 91,
    workflow_sla_instance_id: null,
    sla_completion_semantics: 'none',
    related_resource_type: 'care_pathway_instance',
    related_resource_id: PATHWAY_INSTANCE_ID,
    metadata: { stage_key: 'recover_unattended_visit' },
    ...overrides,
  });
  const runtime = (taskState = task(), overrides = {}) => ({
    instance: { id: PATHWAY_INSTANCE_ID, workflow_run_id: 7 },
    run: {
      id: 7,
      current_step_key: 'recover_unattended_visit',
      ...overrides.run,
    },
    steps: [{
      id: 91,
      workflow_run_id: 7,
      step_key: 'recover_unattended_visit',
      step_kind: 'task',
    }],
    tasks: [taskState],
    definition: {
      steps: [{
        step_key: 'recover_unattended_visit',
        step_kind: 'task',
        condition_handler: HANDLER_ID,
        work_semantics: { sla_completion_semantics: 'none' },
      }],
    },
  });
  const complete = ({ tx, ...overrides } = {}) => (
    completePathwayTaskFromRegisteredCondition({
      tenantId: TENANT,
      pathwayInstanceId: PATHWAY_INSTANCE_ID,
      id: 94,
      workflowRunId: 7,
      workflowStepId: 91,
      conditionHandler: HANDLER_ID,
      evidenceResourceType: 'op_visit_closure_evidence',
      evidenceResourceId: CLOSURE_EVIDENCE_ID,
      evidence: { appointment_id: 41, closure_evidence_id: CLOSURE_EVIDENCE_ID },
      actor: USER_ACTOR,
      signal: SIGNAL,
      executorAuthority: PATHWAY_TEST_CAPABILITY,
      tx,
      ...overrides,
    })
  );

  it('rejects unsealed callers before reading pathway state', async () => {
    const txQuery = jest.fn();
    await expect(complete({
      executorAuthority: { kind: 'test_pathway_executor_capability' },
      tx: { __tenantTransaction: true, $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ code: 'PATHWAY_EXECUTOR_REQUIRED' });
    expect(txQuery).not.toHaveBeenCalled();
  });

  it('rejects a linked-SLA task before mutation', async () => {
    lockPathwayRuntimeTxMock.mockResolvedValueOnce(runtime(task({
      workflow_sla_instance_id: DEFAULT_SLA_ID,
    })));
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{ id: PATHWAY_INSTANCE_ID }]);
    await expect(complete({
      tx: { __tenantTransaction: true, $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ code: 'REGISTERED_CONDITION_COMPLETION_NOT_ALLOWED' });
    expect(txQuery.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
  });

  it('rejects a task that is no longer the workflow run current step', async () => {
    lockPathwayRuntimeTxMock.mockResolvedValueOnce(runtime(task(), {
      run: { current_step_key: 'await_closure_evidence' },
    }));
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{ id: PATHWAY_INSTANCE_ID }]);
    await expect(complete({
      tx: { __tenantTransaction: true, $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ code: 'PATHWAY_TASK_CONTEXT_MISMATCH' });
    expect(txQuery.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
  });

  it.each([
    ['task', { id: 95 }, null, 'PATHWAY_TASK_CONTEXT_MISMATCH'],
    ['run', { workflowRunId: 8 }, null, 'PATHWAY_TASK_CONTEXT_MISMATCH'],
    ['step', { workflowStepId: 92 }, null, 'PATHWAY_TASK_CONTEXT_MISMATCH'],
    [
      'pinned handler',
      {},
      'op.stale_recovery_action.v1',
      'PATHWAY_HANDLER_CONTRACT_INVALID',
    ],
  ])('rejects a stale or wrong %s binding before mutation', async (
    _binding,
    overrides,
    pinnedHandler,
    expectedCode,
  ) => {
    const currentRuntime = runtime(task());
    if (pinnedHandler) {
      currentRuntime.definition.steps[0].condition_handler = pinnedHandler;
    }
    lockPathwayRuntimeTxMock.mockResolvedValueOnce(currentRuntime);
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{ id: PATHWAY_INSTANCE_ID }]);

    await expect(complete({
      ...overrides,
      tx: { __tenantTransaction: true, $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({ code: expectedCode });

    expect(txQuery.mock.calls.some(([sql]) => /UPDATE tasks/i.test(sql))).toBe(false);
  });

  it.each([
    ['handler', {
      conditionHandler: 'op.unregistered_recovery_action.v1',
    }],
    ['resource type', {
      evidenceResourceType: 'workflow_steps',
    }],
    ['resource id', {
      evidenceResourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    }],
    ['payload resource id', {
      evidence: {
        appointment_id: 41,
        closure_evidence_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      },
    }],
  ])('rejects a wrong registered-condition evidence %s before reading or mutation', async (
    _binding,
    overrides,
  ) => {
    const txQuery = jest.fn();

    await expect(complete({
      ...overrides,
      tx: { __tenantTransaction: true, $queryRawUnsafe: txQuery },
    })).rejects.toMatchObject({
      code: 'PATHWAY_REGISTERED_CONDITION_EVIDENCE_INVALID',
    });

    expect(txQuery).not.toHaveBeenCalled();
    expect(lockPathwayRuntimeTxMock).not.toHaveBeenCalled();
  });

  it('completes current SLA-none work with canonical registered-condition evidence', async () => {
    const completedTask = task({ status: 'completed' });
    lockPathwayRuntimeTxMock.mockResolvedValueOnce(runtime(task()));
    const txQuery = jest.fn()
      .mockResolvedValueOnce([{ id: PATHWAY_INSTANCE_ID }])
      .mockResolvedValueOnce([task()])
      .mockResolvedValueOnce([completedTask])
      .mockResolvedValueOnce([{ id: 17, body_kind: 'state_change' }]);
    const tx = { __tenantTransaction: true, $queryRawUnsafe: txQuery };

    const result = await complete({ tx });

    expect(result).toMatchObject({
      task: completedTask,
      evidence: {
        kind: 'pathway_registered_condition',
        handler_id: HANDLER_ID,
        decision: 'satisfied',
        resource_type: 'op_visit_closure_evidence',
        resource_id: CLOSURE_EVIDENCE_ID,
        payload: {
          appointment_id: 41,
          closure_evidence_id: CLOSURE_EVIDENCE_ID,
        },
      },
      previousTaskStatus: 'in_progress',
      mutated: true,
    });
    expect(result).not.toHaveProperty('sla');
    expect(txQuery.mock.calls[2][0]).toMatch(/UPDATE tasks SET/);
    expect(txQuery.mock.calls[3][0]).toMatch(/INSERT INTO task_comments/);
    expect(JSON.parse(txQuery.mock.calls[3][6])).toEqual(expect.objectContaining({
      completion_via: 'registered_condition',
    }));
  });
});

describe('reassignTask + listTasks + postTaskComment', () => {
  it('rejects an empty reassignment instead of silently clearing both owners', async () => {
    await expect(reassignTask({
      tenantId: TENANT,
      id: 1,
    })).rejects.toMatchObject({ statusCode: 400, code: 'TASK_ASSIGNMENT_REQUIRED' });

    expect(queryUnsafeMock).not.toHaveBeenCalled();
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it('rejects reassigning to both a user and a role before reading the task', async () => {
    await expect(reassignTask({
      tenantId: TENANT,
      id: 1,
      assignedToUid: USER,
      assignedToRole: 'NURSING_STAFF',
    })).rejects.toMatchObject({ statusCode: 400, code: 'TASK_ASSIGNMENT_AMBIGUOUS' });

    expect(queryUnsafeMock).not.toHaveBeenCalled();
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it('reassigning to a named user clears any role assignment', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, workflow_run_id: null }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    await reassignTask({ tenantId: TENANT, id: 1, assignedToUid: USER });
    const sql = queryUnsafeMock.mock.calls[1][0];
    expect(sql).toMatch(/assigned_to_uid = \$\d::uuid/);
    expect(sql).toMatch(/assigned_to_role = \$\d/);
    expect(queryUnsafeMock.mock.calls[1].slice(1, 3)).toEqual([USER, null]);
  });

  it('reassigning to a role queue clears any named user assignment', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, workflow_run_id: null }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    await reassignTask({ tenantId: TENANT, id: 1, assignedToRole: 'NURSING_STAFF' });
    const sql = queryUnsafeMock.mock.calls[1][0];
    expect(sql).toMatch(/assigned_to_uid = \$1::uuid/);
    expect(sql).toMatch(/assigned_to_role = \$2/);
    expect(queryUnsafeMock.mock.calls[1].slice(1, 3)).toEqual([null, 'NURSING_STAFF']);
  });

  it('rejects an unknown role string before touching the task', async () => {
    await expect(reassignTask({
      tenantId: TENANT,
      id: 1,
      assignedToRole: 'DEFINITELY_NOT_A_ROLE',
    })).rejects.toMatchObject({ statusCode: 400, code: 'TASK_ASSIGNMENT_ROLE_UNKNOWN' });

    expect(queryUnsafeMock).not.toHaveBeenCalled();
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it('accepts human roster roles that are not present in the legacy role constants', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, workflow_run_id: null }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);

    await reassignTask({
      tenantId: TENANT,
      id: 1,
      assignedToRole: 'COMPLIANCE_OFFICER',
    });

    expect(queryUnsafeMock.mock.calls[1].slice(1, 3)).toEqual([
      null,
      'COMPLIANCE_OFFICER',
    ]);
  });

  it('keeps the established tenant administrator recovery queue assignable', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, workflow_run_id: null }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);

    await reassignTask({
      tenantId: TENANT,
      id: 1,
      assignedToRole: 'TENANT_ADMIN',
    });

    expect(queryUnsafeMock.mock.calls[1].slice(1, 3)).toEqual([
      null,
      'TENANT_ADMIN',
    ]);
  });

  it.each(['PATIENT', 'DEVICE_GATEWAY'])(
    'rejects non-human role queue %s before touching the task',
    async (assignedToRole) => {
      await expect(reassignTask({
        tenantId: TENANT,
        id: 1,
        assignedToRole,
      })).rejects.toMatchObject({
        statusCode: 400,
        code: 'TASK_ASSIGNMENT_ROLE_UNKNOWN',
      });

      expect(queryUnsafeMock).not.toHaveBeenCalled();
      expect(setTenantTxMock).not.toHaveBeenCalled();
    },
  );

  it('canonicalizes role aliases so inbox queue matching stays exact', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, workflow_run_id: null }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    await reassignTask({ tenantId: TENANT, id: 1, assignedToRole: 'nurse' });
    expect(queryUnsafeMock.mock.calls[1].slice(1, 3)).toEqual([null, 'NURSING_STAFF']);
  });

  it('mirrors reassignment onto the linked, still-open SLA instance', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      workflow_run_id: null,
      workflow_sla_instance_id: DEFAULT_SLA_ID,
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, assigned_to_uid: USER }]);

    await reassignTask({ tenantId: TENANT, id: 1, assignedToUid: USER });

    const mirror = executeUnsafeMock.mock.calls
      .find(([sql]) => /UPDATE workflow_sla_instances/i.test(sql));
    expect(mirror).toBeTruthy();
    expect(mirror[0]).toMatch(/assigned_user_uid = \$1::uuid/);
    expect(mirror[0]).toMatch(/completed_at IS NULL/);
    expect(mirror.slice(1)).toEqual([USER, null, DEFAULT_SLA_ID, TENANT]);
  });

  it('does not touch the SLA layer when the task has no linked instance', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, workflow_run_id: null }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    await reassignTask({ tenantId: TENANT, id: 1, assignedToUid: USER });
    expect(executeUnsafeMock).not.toHaveBeenCalled();
  });

  it('allows a generic task to be explicitly unassigned', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, workflow_run_id: null }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, assigned_to_uid: null, assigned_to_role: null }]);

    await reassignTask({
      tenantId: TENANT,
      id: 1,
      assignedToUid: null,
      assignedToRole: null,
    });

    expect(queryUnsafeMock.mock.calls[1].slice(1, 3)).toEqual([null, null]);
  });

  it('listTasks orders by priority then due_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    await listTasks({ tenantId: TENANT });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/CASE priority WHEN 'critical' THEN 0/);
    expect(sql).toMatch(/due_at NULLS LAST/);
  });

  it('listTasks supports overdueOnly filter', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listTasks({ tenantId: TENANT, overdueOnly: true });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/due_at < NOW\(\)/);
  });

  it('listTasks includes tasks filed under merged-away patient uids', async () => {
    const patientUid = '44444444-4444-4444-8444-444444444444';
    const mergedUid = '55555555-5555-4555-8555-555555555555';
    queryUnsafeMock
      .mockResolvedValueOnce([{ uid: patientUid }, { uid: mergedUid }])
      .mockResolvedValueOnce([{ id: 1, patient_uid: mergedUid }]);

    const result = await listTasks({ tenantId: TENANT, patientUid });

    expect(result.tasks).toHaveLength(1);
    expect(queryUnsafeMock.mock.calls[1][0]).toContain('patient_uid = ANY($2::uuid[])');
    expect(queryUnsafeMock.mock.calls[1][2]).toEqual([patientUid, mergedUid]);
  });

  it('postTaskComment requires non-empty body', async () => {
    await expect(postTaskComment({ tenantId: TENANT, taskId: 1, body: '   ' }))
      .rejects.toThrow(/body is required/);
  });

  it('postTaskComment inserts comment row', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, body: 'note' }]);
    const row = await postTaskComment({
      tenantId: TENANT, taskId: 1, authorUid: USER, body: 'note',
    });
    expect(row.id).toBe(1);
  });

  it('listTasks degrades to empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "tasks" does not exist'));
    const result = await listTasks({ tenantId: TENANT });
    expect(result).toEqual({ tasks: [], count: 0 });
  });
});

describe('getTask 404', () => {
  it('throws 404 when missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(getTask({ tenantId: TENANT, id: 999 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

// ---------------------------------------------------------------------------
// Workflow definitions + runs + steps
// ---------------------------------------------------------------------------

describe('createWorkflowDefinition', () => {
  it('rejects missing workflow_key', async () => {
    await expect(createWorkflowDefinition({ tenantId: TENANT }))
      .rejects.toThrow(/workflow_key is required/);
  });

  it('inserts a definition with default version=1', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, workflow_key: 'follow_up_v1', version: 1 }]);
    const row = await createWorkflowDefinition({
      tenantId: TENANT, workflowKey: 'follow_up_v1',
      steps: [{ step_key: 'review_lab', step_kind: 'task' }],
    });
    expect(row.version).toBe(1);
    expect(queryUnsafeMock.mock.calls[0]).toContain(false);
  });

  it('rejects active definitions until governance activation exists', async () => {
    await expect(createWorkflowDefinition({
      tenantId: TENANT,
      workflowKey: 'follow_up_v1',
      steps: [{ step_key: 'review_lab', step_kind: 'task' }],
      isActive: true,
    })).rejects.toMatchObject({ code: 'WORKFLOW_DEFINITION_ACTIVATION_UNAVAILABLE' });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('validates the complete definition contract before insert', async () => {
    await expect(createWorkflowDefinition({
      tenantId: TENANT,
      workflowKey: 'follow_up_v1',
      steps: [{ step_key: 'review_lab', step_kind: 'unsupported' }],
    })).rejects.toMatchObject({ code: 'INVALID_WORKFLOW_DEFINITION' });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('rejects stored triggers while the registered trigger set is empty', async () => {
    await expect(createWorkflowDefinition({
      tenantId: TENANT,
      workflowKey: 'follow_up_v1',
      steps: [{ step_key: 'review_lab', step_kind: 'task' }],
      triggers: [{ event_type: 'lab.result.signed_off' }],
    })).rejects.toMatchObject({ code: 'WORKFLOW_TRIGGER_ACTIVATION_UNAVAILABLE' });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('throws conflict on duplicate (key, version)', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(createWorkflowDefinition({
      tenantId: TENANT, workflowKey: 'follow_up_v1', version: 1,
      steps: [{ step_key: 'review_lab', step_kind: 'task' }],
    })).rejects.toThrow(/already exists/);
  });
});

describe('startWorkflowRun materializes steps', () => {
  it('requires an initiator before opening the tenant transaction', async () => {
    await expect(startWorkflowRun({ tenantId: TENANT, workflowDefinitionId: 99 }))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('throws 404 when definition missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]); // definition lookup
    await expect(startWorkflowRun({
      tenantId: TENANT, workflowDefinitionId: 99, initiatedBy: USER,
    }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it('materializes each definition step into workflow_steps', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, workflow_key: 'follow_up_v1', version: 1,
      is_active: true,
      steps: [
        { step_key: 'review', step_kind: 'task', display_name: 'Review' },
        { step_key: 'approve', step_kind: 'approval' },
      ],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5, status: 'started' }]); // run insert
    queryUnsafeMock.mockResolvedValueOnce([]); // step 1 insert
    queryUnsafeMock.mockResolvedValueOnce([]); // step 2 insert
    const run = await startWorkflowRun({
      tenantId: TENANT,
      workflowDefinitionId: 1,
      initiatedBy: USER,
      dueAt: '2026-07-19T11:30:00+05:30',
    });
    expect(run.id).toBe(5);
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/FOR SHARE/);
    const stepInsertSql = queryUnsafeMock.mock.calls[2][0];
    expect(stepInsertSql).toMatch(/INSERT INTO workflow_steps/);
    expect(queryUnsafeMock.mock.calls[1][0])
      .toMatch(/to_timestamp\(\$8::double precision \/ 1000\.0\)/);
    expect(queryUnsafeMock.mock.calls[1][8])
      .toBe(new Date('2026-07-19T06:00:00.000Z').getTime());
    expect(stepInsertSql)
      .toMatch(/to_timestamp\(\$8::double precision \/ 1000\.0\)/);
    expect(queryUnsafeMock.mock.calls[2][8]).toBeNull();
  });

  it('rejects an inactive definition before inserting a run', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, workflow_key: 'k', version: 1, is_active: false,
      steps: [{ step_key: 'review', step_kind: 'task' }],
    }]);
    await expect(startWorkflowRun({
      tenantId: TENANT, workflowDefinitionId: 1, initiatedBy: USER,
    }))
      .rejects.toMatchObject({ code: 'INACTIVE_WORKFLOW_DEFINITION' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects every governed definition before generic run materialization', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      workflow_key: 'governed_pathway',
      version: 1,
      is_active: true,
      has_pathway_governance: true,
      steps: [{ step_key: 'review', step_kind: 'task' }],
    }]);
    await expect(startWorkflowRun({
      tenantId: TENANT,
      workflowDefinitionId: 1,
      initiatedBy: USER,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CARE_PATHWAY_DEFINITION_REQUIRES_PATHWAY_EXECUTOR',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed stored steps before inserting a run', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, workflow_key: 'k', version: 1, is_active: true,
      steps: [null, { step_key: 'x', step_kind: 'fake' }],
    }]);
    await expect(startWorkflowRun({
      tenantId: TENANT, workflowDefinitionId: 1, initiatedBy: USER,
    }))
      .rejects.toMatchObject({ code: 'INVALID_WORKFLOW_DEFINITION' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a legacy stored definition with unregistered triggers before run insert', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      workflow_key: 'k',
      version: 1,
      is_active: true,
      steps: [{ step_key: 'review', step_kind: 'task' }],
      triggers: [{ event_type: 'lab.result.signed_off' }],
    }]);
    await expect(startWorkflowRun({
      tenantId: TENANT, workflowDefinitionId: 1, initiatedBy: USER,
    }))
      .rejects.toMatchObject({ code: 'WORKFLOW_TRIGGER_ACTIVATION_UNAVAILABLE' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('does not swallow a step materialization failure', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, workflow_key: 'k', version: 1, is_active: true,
      steps: [{ step_key: 'review', step_kind: 'task' }],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 5 }]);
    queryUnsafeMock.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));
    await expect(startWorkflowRun({
      tenantId: TENANT, workflowDefinitionId: 1, initiatedBy: USER,
    }))
      .rejects.toThrow(/duplicate key value/);
  });
});

describe('transitionWorkflowRun', () => {
  it('rejects unknown next_status', async () => {
    await expect(transitionWorkflowRun({
      tenantId: TENANT, id: 1, nextStatus: 'time_out',
    })).rejects.toThrow(/next_status must be one of/);
  });

  it('flips to completed + stamps ended_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'running' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed' }]);
    await transitionWorkflowRun({
      tenantId: TENANT, id: 1, nextStatus: 'completed', actorUid: USER,
    });
    const sql = queryUnsafeMock.mock.calls[2][0];
    expect(sql).toMatch(/ended_at = to_timestamp\(\$\d::double precision \/ 1000\.0\)/);
    expect(sql).toMatch(/AND status = \$\d/);
    expect(queryUnsafeMock.mock.calls[2]).toContain('running');
  });

  it('captures failure_reason on failure', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'running' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'failed', failure_reason: 'timeout' }]);
    await transitionWorkflowRun({
      tenantId: TENANT, id: 1, nextStatus: 'failed', failureReason: 'timeout', actorUid: USER,
    });
    const params = queryUnsafeMock.mock.calls[2].slice(1);
    expect(params).toContain('timeout');
  });

  it('requires an authenticated actor before reading the run', async () => {
    await expect(transitionWorkflowRun({ tenantId: TENANT, id: 1, nextStatus: 'completed' }))
      .rejects.toMatchObject({ statusCode: 401 });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('keeps terminal run states immutable', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed' }]);
    await expect(transitionWorkflowRun({
      tenantId: TENANT, id: 1, nextStatus: 'running', actorUid: USER,
    })).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(2);
  });

  it('reports a compare-and-set loser as conflict', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'running' }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    await expect(transitionWorkflowRun({
      tenantId: TENANT, id: 1, nextStatus: 'completed', actorUid: USER,
    })).rejects.toMatchObject({ code: 'WORKFLOW_RUN_TRANSITION_CONFLICT' });
  });

  it('blocks generic run transitions for pathway-bound runs', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(transitionWorkflowRun({
      tenantId: TENANT, id: 7, nextStatus: 'running', actorUid: USER,
    })).rejects.toMatchObject({ code: 'PATHWAY_EXECUTOR_REQUIRED' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });
});

describe('transitionWorkflowStep + listWorkflowSteps + listWorkflowRuns', () => {
  it('transitionWorkflowStep stamps completed_at on completed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, step_key: 'review', status: 'completed' }]);
    await transitionWorkflowStep({
      tenantId: TENANT, workflowRunId: 1, stepKey: 'review', nextStatus: 'completed',
      outcome: 'approved', actorUid: USER,
    });
    const sql = queryUnsafeMock.mock.calls[2][0];
    expect(sql).toMatch(/completed_at = to_timestamp\(\$\d::double precision \/ 1000\.0\)/);
    expect(sql).toMatch(/outcome = \$\d/);
    expect(sql).toMatch(/AND status = \$\d/);
  });

  it('preserves the original started_at when a blocked step resumes', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'blocked' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress' }]);

    await transitionWorkflowStep({
      tenantId: TENANT,
      workflowRunId: 1,
      stepKey: 'review',
      nextStatus: 'in_progress',
      actorUid: USER,
    });

    expect(queryUnsafeMock.mock.calls[2][0])
      .toMatch(/started_at = COALESCE\(started_at, to_timestamp\(\$\d::double precision \/ 1000\.0\)\)/);
  });

  it('requires an authenticated actor before reading the step', async () => {
    await expect(transitionWorkflowStep({
      tenantId: TENANT, workflowRunId: 1, stepKey: 'review', nextStatus: 'completed',
    })).rejects.toMatchObject({ statusCode: 401 });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('keeps terminal step states immutable', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed' }]);
    await expect(transitionWorkflowStep({
      tenantId: TENANT,
      workflowRunId: 1,
      stepKey: 'review',
      nextStatus: 'in_progress',
      actorUid: USER,
    })).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('reports a compare-and-set loser as conflict', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'in_progress' }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    await expect(transitionWorkflowStep({
      tenantId: TENANT,
      workflowRunId: 1,
      stepKey: 'review',
      nextStatus: 'completed',
      actorUid: USER,
    })).rejects.toMatchObject({ code: 'WORKFLOW_STEP_TRANSITION_CONFLICT' });
  });

  it('blocks generic step transitions for pathway-bound runs', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(transitionWorkflowStep({
      tenantId: TENANT,
      workflowRunId: 7,
      stepKey: 'review',
      nextStatus: 'in_progress',
      actorUid: USER,
    })).rejects.toMatchObject({ code: 'PATHWAY_EXECUTOR_REQUIRED' });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('listWorkflowSteps degrades to empty on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "workflow_steps" does not exist'));
    const result = await listWorkflowSteps({ tenantId: TENANT, workflowRunId: 1 });
    expect(result).toEqual({ steps: [], count: 0 });
  });

  it('listWorkflowRuns filters by status', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    await listWorkflowRuns({ tenantId: TENANT, status: 'running' });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/status = \$2/);
  });

  it('listWorkflowDefinitions filters by category', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listWorkflowDefinitions({ tenantId: TENANT, category: 'discharge' });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/category = \$2/);
  });
});

// ---------------------------------------------------------------------------
// Approvals + quorum
// ---------------------------------------------------------------------------

describe('createApproval', () => {
  it('rejects missing approval_kind', async () => {
    await expect(createApproval({ tenantId: TENANT }))
      .rejects.toThrow(/approval_kind is required/);
  });

  it('inserts pending approval with default required_approvers=1', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'pending', required_approvers: 1 }]);
    const row = await createApproval({
      tenantId: TENANT,
      approvalKind: 'discharge_clearance',
      expiresAt: '2026-07-19T11:30:00+05:30',
    });
    expect(row.required_approvers).toBe(1);
    expect(queryUnsafeMock.mock.calls[0][0])
      .toMatch(/to_timestamp\(\$10::double precision \/ 1000\.0\)/);
    expect(queryUnsafeMock.mock.calls[0][10])
      .toBe(new Date('2026-07-19T06:00:00.000Z').getTime());
  });

  it('rejects domain-owned credential grants before inserting', async () => {
    await expect(createApproval({
      tenantId: TENANT,
      approvalKind: ' CREDENTIAL_PRIVILEGE_GRANT ',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOMAIN_OWNED_APPROVAL_KIND',
    });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('rejects care pathway governance approval creation through the generic service', async () => {
    await expect(createApproval({
      tenantId: TENANT,
      approvalKind: 'care_pathway_definition_governance',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOMAIN_OWNED_APPROVAL_KIND',
    });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('writes executor materialization fields through a supplied transaction', async () => {
    const txQuery = jest.fn().mockResolvedValueOnce([{ id: 2, status: 'pending' }]);
    const row = await createApproval({
      tenantId: TENANT,
      workflowRunId: 7,
      workflowStepId: 8,
      approvalKind: 'clinical_review',
      createdBy: USER,
      materializationKey: 'pathway:1:stage:review:approval',
      executorAuthority: PATHWAY_TEST_CAPABILITY,
      tx: { $queryRawUnsafe: txQuery },
    });

    expect(row.id).toBe(2);
    expect(txQuery.mock.calls[0][0]).toMatch(/workflow_step_id[\s\S]+created_by[\s\S]+materialization_key/);
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('blocks generic approval materialization for a pathway-bound run', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(createApproval({
      tenantId: TENANT,
      workflowRunId: 7,
      approvalKind: 'clinical_review',
    })).rejects.toMatchObject({ code: 'PATHWAY_EXECUTOR_REQUIRED' });
  });
});

describe('recordApprovalDecision', () => {
  it('rejects a missing authenticated actor', async () => {
    await expect(recordApprovalDecision({ tenantId: TENANT, id: 1, decision: 'approve' }))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects invalid decision', async () => {
    await expect(recordApprovalDecision({
      tenantId: TENANT, id: 1, actorUid: APPROVER_A, decision: 'maybe',
    })).rejects.toThrow(/decision must be "approve" or "reject"/);
  });

  it('blocks generic decisions for pathway-bound approvals before mutation', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{
        id: 1,
        workflow_run_id: 7,
        status: 'pending',
        approval_kind: 'clinical_review',
        approved_by: [],
        required_approvers: 1,
        is_expired: false,
      }])
      .mockResolvedValueOnce([{ '?column?': 1 }]);

    await expect(recordApprovalDecision({
      tenantId: TENANT,
      id: 1,
      actorUid: APPROVER_A,
      decision: 'approve',
    })).rejects.toMatchObject({ code: 'PATHWAY_EXECUTOR_REQUIRED' });
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE approvals/i.test(sql))).toBe(false);
  });

  it('rejects domain-owned credential grants after the locked read and before mutation', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'pending',
      approval_kind: 'credential_privilege_grant',
      expires_at: null,
      is_expired: false,
    }]);

    await expect(recordApprovalDecision({
      tenantId: TENANT,
      id: 1,
      actorUid: APPROVER_A,
      decision: 'approve',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOMAIN_OWNED_APPROVAL_KIND',
    });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/approval_kind/);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/expires_at/);
    expect(queryUnsafeMock.mock.calls[0][0])
      .toMatch(/expires_at\s+IS\s+NOT\s+NULL\s+AND\s+expires_at\s*<=\s*NOW\(\)/i);
  });

  it('rejects care pathway governance decisions after the locked read and before mutation', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'pending',
      approval_kind: 'care_pathway_definition_governance',
      expires_at: null,
      is_expired: false,
    }]);

    await expect(recordApprovalDecision({
      tenantId: TENANT,
      id: 1,
      actorUid: APPROVER_A,
      decision: 'approve',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'DOMAIN_OWNED_APPROVAL_KIND',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
    expect(queryUnsafeMock.mock.calls.some(([sql]) => /UPDATE approvals/i.test(sql))).toBe(false);
  });

  it('rejects an expired pending approval using the database expiry result', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'pending',
      approval_kind: 'discharge_clearance',
      approved_by: [],
      required_approvers: 1,
      expires_at: '2026-07-18T00:00:00.000Z',
      is_expired: true,
    }]);

    await expect(recordApprovalDecision({
      tenantId: TENANT,
      id: 1,
      actorUid: APPROVER_A,
      decision: 'approve',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'APPROVAL_EXPIRED',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('rejects when already decided', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'approved' }]);
    await expect(recordApprovalDecision({
      tenantId: TENANT, id: 1, actorUid: APPROVER_A, decision: 'approve',
    })).rejects.toThrow(/already approved/);
    expect(queryUnsafeMock.mock.calls[0][0]).toMatch(/FOR UPDATE/);
  });

  it('rejects double-approve from same approver', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'pending', required_approvers: 2,
      approved_by: [{ uid: APPROVER_A, at: new Date().toISOString() }],
    }]);
    await expect(recordApprovalDecision({
      tenantId: TENANT, id: 1, actorUid: APPROVER_A, decision: 'approve',
    })).rejects.toThrow(/already approved this gate/);
  });

  it('rejects a mixed-case UUID replay from the same approver', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'pending',
      required_approvers: 2,
      approved_by: [{ uid: APPROVER_A.toUpperCase(), at: new Date().toISOString() }],
    }]);
    await expect(recordApprovalDecision({
      tenantId: TENANT,
      id: 1,
      actorUid: APPROVER_A,
      decision: 'approve',
    })).rejects.toThrow(/already approved this gate/);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('keeps pending status until quorum reached', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'pending', required_approvers: 2, approved_by: [],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'pending', approved_by: [{ uid: APPROVER_A }] }]);
    const row = await recordApprovalDecision({
      tenantId: TENANT, id: 1, actorUid: APPROVER_A, decision: 'approve',
    });
    expect(row.status).toBe('pending');
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/status = 'pending'/);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/decided_by = \$3::uuid/);
    expect(queryUnsafeMock.mock.calls[1][3]).toBeNull();
  });

  it('flips to approved when quorum met', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'pending', required_approvers: 2,
      approved_by: [{ uid: APPROVER_A, at: new Date().toISOString() }],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'approved' }]);
    const row = await recordApprovalDecision({
      tenantId: TENANT, id: 1, actorUid: APPROVER_B, decision: 'approve',
    });
    expect(row.status).toBe('approved');
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/decided_by = \$3::uuid/);
    expect(queryUnsafeMock.mock.calls[1]).toContain(APPROVER_B);
  });

  it('reject path stamps decided_at + rejection_reason', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'pending', required_approvers: 2, approved_by: [],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'rejected' }]);
    await recordApprovalDecision({
      tenantId: TENANT, id: 1, actorUid: APPROVER_A, decision: 'reject',
      rejectionReason: 'incomplete chart',
    });
    const params = queryUnsafeMock.mock.calls[1].slice(1);
    expect(params).toContain('incomplete chart');
    expect(params).toContain(APPROVER_A);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/decided_by = \$2::uuid/);
  });

  it('enforces required_role inside the locked transaction', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'pending',
      required_approvers: 1,
      required_role: 'CMO',
      approved_by: [],
    }]);
    await expect(recordApprovalDecision({
      tenantId: TENANT,
      id: 1,
      actorUid: APPROVER_A,
      actorRoles: ['DOCTOR'],
      decision: 'approve',
    })).rejects.toMatchObject({ statusCode: 403 });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('allows ADMIN and SUPER_ADMIN to administer a role-gated approval', async () => {
    for (const role of ['ADMIN', 'SUPER_ADMIN']) {
      queryUnsafeMock.mockResolvedValueOnce([{
        id: 1,
        status: 'pending',
        required_approvers: 1,
        required_role: 'CMO',
        approved_by: [],
      }]);
      queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'approved' }]);
      const row = await recordApprovalDecision({
        tenantId: TENANT,
        id: 1,
        actorUid: APPROVER_A,
        actorRoles: [role],
        decision: 'approve',
      });
      expect(row.status).toBe('approved');
    }
  });

  it('allows a holder of required_role to approve', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1,
      status: 'pending',
      required_approvers: 1,
      required_role: 'CMO',
      approved_by: [],
    }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'approved' }]);
    const row = await recordApprovalDecision({
      tenantId: TENANT,
      id: 1,
      actorUid: APPROVER_A,
      actorRoles: ['cmo'],
      decision: 'approve',
    });
    expect(row.status).toBe('approved');
  });

  it('listApprovals filters by workflow_run_id', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listApprovals({ tenantId: TENANT, workflowRunId: 5 });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/workflow_run_id = \$2/);
  });
});

// ---------------------------------------------------------------------------
// Escalation rules + SLA + automation rules
// ---------------------------------------------------------------------------

describe('escalation / SLA / automation upserts', () => {
  it('upsertEscalationRule rejects unknown action_kind', async () => {
    await expect(upsertEscalationRule({
      tenantId: TENANT, displayName: 'X', triggerCondition: 'sla_breach', actionKind: 'magic',
    })).rejects.toThrow(/action_kind must be one of/);
  });

  it('upsertEscalationRule inserts new rule when id is null', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, display_name: 'X' }]);
    const row = await upsertEscalationRule({
      tenantId: TENANT, displayName: 'X',
      triggerCondition: 'sla_breach', actionKind: 'notify',
    });
    expect(row.id).toBe(1);
  });

  it('upsertEscalationRule updates when id provided', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 7, display_name: 'X', is_active: false }]);
    const row = await upsertEscalationRule({
      tenantId: TENANT, id: 7, displayName: 'X',
      triggerCondition: 'sla_breach', actionKind: 'notify', isActive: false,
    });
    expect(row.is_active).toBe(false);
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/UPDATE escalation_rules/);
  });

  it.each([
    ['scope', { scope: 'approval' }, 'ESCALATION_RULE_SCOPE_UNAVAILABLE'],
    ['trigger', { triggerCondition: 'on_status_change' }, 'ESCALATION_RULE_TRIGGER_UNAVAILABLE'],
    ['action', { actionKind: 'webhook' }, 'ESCALATION_RULE_ACTION_UNAVAILABLE'],
  ])('refuses to activate a rule with an %s no engine evaluates', async (_label, extra, code) => {
    await expect(upsertEscalationRule({
      tenantId: TENANT,
      displayName: 'X',
      triggerCondition: 'sla_breach',
      actionKind: 'notify',
      ...extra,
    })).rejects.toMatchObject({ statusCode: 400, code });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });

  it('still stores not-yet-evaluated config as an inactive draft', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 2, action_kind: 'webhook', is_active: false }]);
    const row = await upsertEscalationRule({
      tenantId: TENANT,
      displayName: 'X',
      scope: 'approval',
      triggerCondition: 'on_status_change',
      actionKind: 'webhook',
      isActive: false,
    });
    expect(row.is_active).toBe(false);
  });

  it('pins the engine-evaluated escalation subsets to what the sweep implements', () => {
    // escalationEngineService.test.js pins the identical action list from the
    // engine side; together the two assertions fail CI if either module drifts.
    expect(ENGINE_EVALUATED_ESCALATION_SCOPES).toEqual(['task']);
    expect(ENGINE_EVALUATED_ESCALATION_TRIGGERS).toEqual(['sla_breach', 'pending_too_long']);
    expect(ENGINE_EXECUTABLE_ESCALATION_ACTIONS)
      .toEqual(['notify', 'reassign', 'escalate_priority', 'auto_resolve']);
  });

  it('upsertSlaDefinition rejects missing target_minutes', async () => {
    await expect(upsertSlaDefinition({ tenantId: TENANT, slaKey: 'x' }))
      .rejects.toThrow(/target_minutes is required/);
  });

  it('upsertSlaDefinition rejects warn_at_pct out of range', async () => {
    await expect(upsertSlaDefinition({
      tenantId: TENANT, slaKey: 'x', targetMinutes: 30, warnAtPct: 150,
    })).rejects.toThrow(/warn_at_pct must be <= 100/);
  });

  it('upsertAutomationRule rejects missing event_type', async () => {
    await expect(upsertAutomationRule({
      tenantId: TENANT, displayName: 'X', actionKind: 'notify',
    })).rejects.toThrow(/event_type is required/);
  });

  it('listEscalationRules + listSlaDefinitions + listAutomationRules degrade on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "escalation_rules" does not exist'));
    expect(await listEscalationRules({ tenantId: TENANT })).toEqual({ rules: [], count: 0 });
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "sla_definitions" does not exist'));
    expect(await listSlaDefinitions({ tenantId: TENANT })).toEqual({ slas: [], count: 0 });
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "automation_rules" does not exist'));
    expect(await listAutomationRules({ tenantId: TENANT })).toEqual({ rules: [], count: 0 });
  });
});
