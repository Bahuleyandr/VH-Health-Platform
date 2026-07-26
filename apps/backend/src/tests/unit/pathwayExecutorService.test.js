import { jest } from '@jest/globals';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';
const ACTOR_UID = '33333333-3333-4333-8333-333333333333';
const OTHER_ACTOR_UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INSTANCE_ID = '44444444-4444-4444-8444-444444444444';
const CHILD_ID = '55555555-5555-4555-8555-555555555555';
const INVALID_NAMED_OWNER_INPUTS = Object.freeze([
  ['empty', ''],
  ['whitespace-only', '   '],
  ['malformed', 'not-a-uuid'],
  ['non-string', 42],
]);
const TX = Object.freeze({ $queryRawUnsafe: jest.fn(), $executeRawUnsafe: jest.fn() });

const setTenantTxMock = jest.fn(async (_tenantId, fn) => fn(TX));
const startWorkflowSlaMock = jest.fn();
const createTaskMock = jest.fn();
const createApprovalMock = jest.fn();
const completeRegisteredConditionMock = jest.fn();
const completeEvidenceMock = jest.fn();
const appendEventMock = jest.fn();
const appendBatchMock = jest.fn(async (input) => {
  const events = [];
  for (const [effectOrdinal, intent] of input.intents.entries()) {
    const result = await appendEventMock({
      ...input,
      ...intent,
      effectOrdinal,
    });
    events.push(result.event);
  }
  return { events, replayed: false };
});
const findReplayMock = jest.fn();
const acquireStartLocksMock = jest.fn();
const assertReplayPinMock = jest.fn();
const assertPatientContextMock = jest.fn();
const assertTenantScopeMock = jest.fn();
const findActiveEpisodeMock = jest.fn();
const findInstanceByKeyMock = jest.fn();
const getInstanceMock = jest.fn();
const getTransitionLedgerStateMock = jest.fn();
const insertRuntimeMock = jest.fn();
const loadDefinitionMock = jest.fn();
const lockRuntimeMock = jest.fn();
const preflightSlaRulesMock = jest.fn();
const resolveModeMock = jest.fn();
const resolveRuntimeRegistryVersionMock = jest.fn();
const transitionRunMock = jest.fn();
const transitionStepMock = jest.fn();
const activateInstanceMock = jest.fn();
const closeInstanceMock = jest.fn();

let runtime;
let childDefinition;

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  isTenantTransactionClient: (value) => value === TX,
  setTenantTx: setTenantTxMock,
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  startWorkflowSla: startWorkflowSlaMock,
}));

jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  completePathwayTaskFromRegisteredCondition: completeRegisteredConditionMock,
  completePathwayTaskFromRegisteredEvidence: completeEvidenceMock,
  createTask: createTaskMock,
  createApproval: createApprovalMock,
}));

jest.unstable_mockModule('../../services/pathways/pathwayTransitionEventService.js', () => ({
  appendPathwayTransitionEventTx: appendEventMock,
  appendPathwayTransitionEventsBatchTx: appendBatchMock,
  findPathwayTransitionReplayTx: findReplayMock,
}));

jest.unstable_mockModule('../../services/pathways/pathwayRuntimePersistence.js', () => ({
  acquirePathwayStartLocksTx: acquireStartLocksMock,
  activatePathwayInstanceCasTx: activateInstanceMock,
  assertPathwayPatientContextTx: assertPatientContextMock,
  assertPathwayReplayDefinitionPinTx: assertReplayPinMock,
  assertPathwayTenantScopeTx: assertTenantScopeMock,
  closePathwayInstanceCasTx: closeInstanceMock,
  findActivePathwayEpisodeTx: findActiveEpisodeMock,
  findPathwayInstanceByIdempotencyTx: findInstanceByKeyMock,
  getCarePathwayInstanceTx: getInstanceMock,
  getPathwayTransitionLedgerStateTx: getTransitionLedgerStateMock,
  insertPathwayRuntimeTx: insertRuntimeMock,
  loadGovernedPathwayDefinitionTx: loadDefinitionMock,
  lockPathwayRuntimeTx: lockRuntimeMock,
  preflightPathwaySlaRulesTx: preflightSlaRulesMock,
  resolvePathwayModeTx: resolveModeMock,
  resolvePathwayRuntimeRegistryVersionTx: resolveRuntimeRegistryVersionMock,
  transitionPathwayRunCasTx: transitionRunMock,
  transitionPathwayStepCasTx: transitionStepMock,
}));

const { compileWorkflowDefinition } = await import(
  '../../services/workflow/workflowDefinitionCompiler.js'
);
const {
  createRegisteredWorkflowSystemActor,
  createWorkflowRuntimeRegistry,
} = await import('../../services/workflow/workflowRuntimeRegistry.js');
const {
  completePathwayTaskAndExecuteFromRegisteredCondition,
  completePathwayTaskAndExecuteFromRegisteredEvidence,
  createPathwayActivationEvidenceCapabilityForTests,
  executePathwayCommand,
  isPathwayExecutorCapability,
  startCarePathwayInstance,
} = await import('../../services/pathways/pathwayExecutorService.js');

function userActor() {
  return {
    kind: 'user',
    uid: ACTOR_UID,
    roles: ['NURSING_STAFF', 'DOCTOR'],
    primaryRole: 'NURSING_STAFF',
    rawRole: 'NURSING_STAFF',
    authorizationMode: 'authenticated_pathway_route',
  };
}

function sealedSignalContext(overrides = {}) {
  return {
    sourceResourceType: 'event_outbox',
    sourceResourceId: '91',
    occurredAt: '2026-07-19T10:00:00Z',
    ...overrides,
  };
}

let nextRegistryVersion = 900;

function registryFor({ condition = null, action = null, fanout = null } = {}) {
  return createWorkflowRuntimeRegistry({
    version: nextRegistryVersion++,
    conditions: condition ? [['synthetic.condition.v1', condition]] : [],
    actions: action ? [['synthetic.action.v1', action]] : [],
    childFanouts: fanout ? [['synthetic.child.v1', fanout]] : [],
    systemActors: ['synthetic.projector.v1'],
  });
}

function makeDefinition(raw, registry) {
  const compiled = compileWorkflowDefinition(raw, { registry });
  return {
    id: raw.workflow_key === 'synthetic_child' ? 22 : 11,
    workflow_key: raw.workflow_key,
    version: raw.version || 1,
    governance_id: '77777777-7777-4777-8777-777777777777',
    steps: raw.steps,
    triggers: raw.triggers || [],
    defaults: raw.defaults || {},
    definition_checksum: compiled.checksum,
    governance_status: 'approved',
    is_active: true,
  };
}

function makeChildDefinition(registry, { id, stepCount }) {
  const definition = makeDefinition({
    workflow_key: 'synthetic_child',
    steps: Array.from({ length: stepCount }, (_unused, index) => ({
      step_key: `child_task_${index}`,
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: {
        task_kind: 'review',
        priority: 'normal',
        sla_completion_semantics: 'none',
      },
    })),
  }, registry);
  return { ...definition, id };
}

function makeRuntime(raw, registry, { status = 'started' } = {}) {
  const definition = makeDefinition(raw, registry);
  const compiled = compileWorkflowDefinition(raw, { registry });
  const started = status === 'started';
  const steps = compiled.steps.map((step, index) => ({
    id: 100 + index,
    tenant_id: TENANT,
    workflow_run_id: 77,
    step_key: step.step_key,
    step_kind: step.step_kind,
    display_name: step.display_name,
    assigned_role: step.assigned_role,
    ordering: index,
    status: started ? 'pending' : index === 0 ? (status === 'blocked' ? 'blocked' : 'in_progress') : 'pending',
    outcome: null,
    metadata: step.metadata,
  }));
  return {
    instance: {
      id: INSTANCE_ID,
      tenant_id: TENANT,
      workflow_run_id: 77,
      workflow_definition_id: definition.id,
      definition_governance_id: definition.governance_id,
      definition_checksum: definition.definition_checksum,
      patient_uid: PATIENT,
      encounter_id: null,
      pathway_key: raw.workflow_key,
      pathway_version: raw.version || 1,
      source_episode_type: 'synthetic_episode',
      source_episode_id: 'episode-1',
      owning_clinician_uid: ACTOR_UID,
      accountable_role: 'DOCTOR',
      clinical_status: started ? 'planned' : 'active',
      closed_at: null,
      metadata: {},
    },
    run: {
      id: 77,
      tenant_id: TENANT,
      workflow_definition_id: definition.id,
      workflow_key: raw.workflow_key,
      workflow_version: raw.version || 1,
      pathway_governance_id: definition.governance_id,
      pathway_definition_checksum: definition.definition_checksum,
      status,
      current_step_key: started ? null : steps[0].step_key,
    },
    steps,
    tasks: [],
    approvals: [],
    handoffs: [],
    slas: [],
    children: [],
    childRuntimeGraphs: [],
    definition,
  };
}

function command(overrides = {}) {
  return {
    tenantId: TENANT,
    pathwayInstanceId: INSTANCE_ID,
    idempotencyKey: 'command_key_1',
    signal: { kind: 'evaluate' },
    actor: userActor(),
    tx: TX,
    ...overrides,
  };
}

function installRuntimeMocks() {
  findReplayMock.mockImplementation(async ({ commandFingerprint }) => ({
    replayed: false,
    events: [],
    commandFingerprint,
    pathwayInstance: runtime.instance,
  }));
  lockRuntimeMock.mockImplementation(async () => runtime);
  getInstanceMock.mockImplementation(async () => runtime);
  transitionRunMock.mockImplementation(async (input) => ({
    ...runtime.run,
    status: input.nextStatus,
    current_step_key: input.nextCurrentStepKey,
  }));
  transitionStepMock.mockImplementation(async (input) => {
    const step = runtime.steps.find((candidate) => Number(candidate.id) === Number(input.stepId));
    return { ...step, status: input.nextStatus, outcome: input.outcome || null };
  });
  activateInstanceMock.mockImplementation(async () => ({
    ...runtime.instance,
    clinical_status: 'active',
  }));
  closeInstanceMock.mockImplementation(async () => ({
    ...runtime.instance,
    clinical_status: 'completed',
    completion_outcome: 'workflow_completed',
    closed_at: new Date().toISOString(),
  }));
  appendEventMock.mockImplementation(async (input) => ({
    replayed: false,
    event: {
      id: `event-${input.effectOrdinal}`,
      effect_ordinal: input.effectOrdinal,
      transition_scope: input.transitionScope,
      transition_key: input.transitionKey,
      workflow_step_id: input.workflowStepId ?? null,
      previous_state: input.previousState ?? {},
      new_state: input.newState ?? {},
      event_payload: input.eventPayload ?? {},
      metadata: input.metadata ?? {},
    },
  }));
  createTaskMock.mockImplementation(async (input) => ({
    id: 700 + createTaskMock.mock.calls.length,
    workflow_run_id: input.workflowRunId,
    workflow_step_id: input.workflowStepId,
    status: 'open',
    assigned_to_role: input.assignedToRole,
    workflow_sla_instance_id: input.workflowSlaInstanceId,
    sla_completion_semantics: input.slaCompletionSemantics,
    due_at: input.dueAt ?? null,
  }));
  createApprovalMock.mockImplementation(async (input) => ({
    id: 800,
    workflow_run_id: input.workflowRunId,
    workflow_step_id: input.workflowStepId,
    task_id: input.taskId,
    status: 'pending',
  }));
}

function installCompletedDomainEvidenceRuntime(registry, workflowKey) {
  runtime = makeRuntime({
    workflow_key: workflowKey,
    steps: [{
      step_key: 'verify',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.condition.v1',
      work_semantics: {
        task_kind: 'verification',
        priority: 'high',
        sla_completion_semantics: 'domain_evidence',
        sla_rule_code: 'synthetic_domain_evidence',
      },
    }],
  }, registry, { status: 'running' });
  runtime.tasks = [{
    id: 701,
    tenant_id: TENANT,
    workflow_run_id: 77,
    workflow_step_id: 100,
    status: 'completed',
    workflow_sla_instance_id: '99999999-9999-4999-8999-999999999999',
    sla_completion_semantics: 'domain_evidence',
  }];
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
}

function completedDomainEvidence(provenance) {
  return {
    task: { id: 701, status: 'completed' },
    sla: { id: '99999999-9999-4999-8999-999999999999', status: 'completed' },
    previousTaskStatus: 'open',
    previousSlaStatus: 'active',
    mutated: true,
    evidence: {
      kind: 'pathway_registered_condition',
      handler_id: 'synthetic.condition.v1',
      decision: 'satisfied',
      resource_type: 'workflow_steps',
      resource_id: '100',
      payload: { verified: true },
      provenance,
    },
  };
}

const REPLAY_BRANCHES = Object.freeze([
  'start',
  'command',
  'registered_evidence',
  'registered_condition',
]);

function replayEventsForBranch(branch, snapshot, provenance) {
  const metadata = {
    pathway_runtime: { mode: 'shadow', result_snapshot: snapshot },
  };
  if (!['registered_evidence', 'registered_condition'].includes(branch)) {
    return [{ metadata }];
  }
  const registeredCondition = branch === 'registered_condition';
  return [{
    metadata,
    transition_scope: 'task',
    transition_key: registeredCondition
      ? 'registered_condition_task_completed'
      : 'domain_evidence_task_completed',
    workflow_step_id: 100,
    event_payload: {
      task_id: 701,
      ...(registeredCondition ? {} : {
        workflow_sla_instance_id: '99999999-9999-4999-8999-999999999999',
      }),
      evidence: {
        kind: 'pathway_registered_condition',
        handler_id: 'synthetic.condition.v1',
        decision: 'satisfied',
        resource_type: registeredCondition
          ? 'op_visit_closure_evidence'
          : 'workflow_steps',
        resource_id: registeredCondition
          ? '88888888-8888-4888-8888-888888888888'
          : '100',
        provenance,
      },
    },
  }, {
    metadata: {},
    transition_scope: 'step',
    transition_key: 'step_completed',
    workflow_step_id: 100,
    event_payload: {
      decision: 'task_completed',
      evidence: {
        ...(registeredCondition ? {} : { domain_evidence_satisfied: true }),
        task_id: 701,
      },
    },
  }];
}

async function invokeOwnedReplay({
  branch,
  currentOwnerUid = ACTOR_UID,
  ownerAvailable = true,
  actorKind = 'user',
}) {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_owned_replay',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'NURSING_STAFF',
      work_semantics: {
        task_kind: 'review',
        priority: 'normal',
        sla_completion_semantics: 'none',
      },
    }],
  }, registry, {
    status: ['registered_evidence', 'registered_condition'].includes(branch)
      ? 'running'
      : 'started',
  });
  runtime.instance.owning_clinician_uid = currentOwnerUid;
  const actor = actorKind === 'system'
    ? createRegisteredWorkflowSystemActor({
      registry,
      systemKey: 'synthetic.projector.v1',
      sourceEventId: '8801',
      causationId: 'outbox:8801',
      signalContext: sealedSignalContext(),
    })
    : userActor();
  const snapshot = {
    ...runtime.instance,
    steps: runtime.steps,
    tasks: runtime.tasks,
    approvals: runtime.approvals,
    handoffs: runtime.handoffs,
  };
  const provenance = actorKind === 'system'
    ? { actor_kind: 'system', system_key: 'synthetic.projector.v1', source_event_id: '8801' }
    : { actor_kind: 'user', actor_uid: ACTOR_UID };
  const events = replayEventsForBranch(branch, snapshot, provenance);
  findReplayMock.mockResolvedValueOnce({
    replayed: true,
    events,
    pathwayInstance: runtime.instance,
  });
  if (currentOwnerUid) {
    if (actorKind === 'user') {
      TX.$queryRawUnsafe.mockResolvedValueOnce([
        { uid: ACTOR_UID, role: 'NURSING_STAFF' },
      ]);
    }
    TX.$queryRawUnsafe.mockResolvedValueOnce(
      ownerAvailable ? [{ uid: currentOwnerUid, role: 'DOCTOR' }] : [],
    );
  }

  if (branch === 'start') {
    findInstanceByKeyMock.mockResolvedValueOnce(runtime.instance);
    return startCarePathwayInstance({
      tenantId: TENANT,
      workflowDefinitionId: 11,
      patientUid: PATIENT,
      pathwayKey: 'synthetic_owned_replay',
      sourceEpisodeType: actorKind === 'system' ? 'investigation_order' : 'patient',
      sourceEpisodeId: actorKind === 'system' ? 'order-8801' : PATIENT,
      owningClinicianUid: ACTOR_UID,
      accountableRole: 'NURSING_STAFF',
      triggerKind: actorKind === 'system' ? 'event' : 'manual',
      idempotencyKey: 'owned_replay_start_1',
      actor,
      registry,
    });
  }
  if (branch === 'command') {
    return executePathwayCommand(command({
      registry,
      actor,
      idempotencyKey: 'owned_replay_command_1',
    }));
  }
  if (branch === 'registered_condition') {
    return completePathwayTaskAndExecuteFromRegisteredCondition({
      ...command({
        registry,
        actor,
        idempotencyKey: 'owned_replay_condition_1',
      }),
      taskId: 701,
      workflowRunId: 77,
      workflowStepId: 100,
      conditionHandler: 'synthetic.condition.v1',
      evidenceResourceType: 'op_visit_closure_evidence',
      evidenceResourceId: '88888888-8888-4888-8888-888888888888',
      evidence: { verified: true },
    });
  }
  return completePathwayTaskAndExecuteFromRegisteredEvidence({
    ...command({
      registry,
      actor,
      idempotencyKey: 'owned_replay_evidence_1',
    }),
    taskId: 701,
    workflowRunId: 77,
    workflowStepId: 100,
    conditionHandler: 'synthetic.condition.v1',
    evidence: { verified: true },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  TX.$queryRawUnsafe.mockResolvedValue([{ uid: ACTOR_UID, role: 'NURSING_STAFF' }]);
  TX.$executeRawUnsafe.mockResolvedValue(0);
  resolveModeMock.mockResolvedValue('shadow');
  findActiveEpisodeMock.mockResolvedValue(null);
  findInstanceByKeyMock.mockResolvedValue(null);
  assertTenantScopeMock.mockResolvedValue(undefined);
  assertPatientContextMock.mockResolvedValue(undefined);
  acquireStartLocksMock.mockResolvedValue(undefined);
  assertReplayPinMock.mockResolvedValue(undefined);
  startWorkflowSlaMock.mockResolvedValue(null);
  preflightSlaRulesMock.mockResolvedValue([]);
  getTransitionLedgerStateMock.mockResolvedValue({ eventCount: 0, maxSequence: 0 });
});

it.each(REPLAY_BRANCHES)(
  'rejects %s replay when the current named owner is no longer eligible',
  async (branch) => {
    await expect(invokeOwnedReplay({
      branch,
      ownerAvailable: false,
    })).rejects.toMatchObject({ code: 'PATHWAY_NAMED_OWNER_UNAVAILABLE' });
    expect(assertReplayPinMock).not.toHaveBeenCalled();
    expect(resolveModeMock).not.toHaveBeenCalled();
    expect(lockRuntimeMock).not.toHaveBeenCalled();
    expect(completeEvidenceMock).not.toHaveBeenCalled();
    expect(completeRegisteredConditionMock).not.toHaveBeenCalled();
    expect(createTaskMock).not.toHaveBeenCalled();
  },
);

it.each(REPLAY_BRANCHES)(
  'rejects %s replay by the former actor after current ownership changed',
  async (branch) => {
    await expect(invokeOwnedReplay({
      branch,
      currentOwnerUid: OTHER_ACTOR_UID,
    })).rejects.toMatchObject({ code: 'PATHWAY_SIGNAL_NOT_OWNED' });
    expect(TX.$queryRawUnsafe.mock.calls[1][2]).toBe(OTHER_ACTOR_UID);
    expect(assertReplayPinMock).not.toHaveBeenCalled();
    expect(resolveModeMock).not.toHaveBeenCalled();
    expect(lockRuntimeMock).not.toHaveBeenCalled();
    expect(completeEvidenceMock).not.toHaveBeenCalled();
    expect(completeRegisteredConditionMock).not.toHaveBeenCalled();
  },
);

it.each(REPLAY_BRANCHES)(
  'allows %s replay for the current eligible named owner without running effects',
  async (branch) => {
    await expect(invokeOwnedReplay({ branch })).resolves.toMatchObject({ replayed: true });
    expect(assertReplayPinMock).toHaveBeenCalledTimes(1);
    expect(resolveModeMock).not.toHaveBeenCalled();
    expect(lockRuntimeMock).not.toHaveBeenCalled();
    expect(completeEvidenceMock).not.toHaveBeenCalled();
    expect(completeRegisteredConditionMock).not.toHaveBeenCalled();
    expect(createTaskMock).not.toHaveBeenCalled();
  },
);

it.each(REPLAY_BRANCHES)(
  'allows sealed system %s replay after current named-owner eligibility is verified',
  async (branch) => {
    await expect(invokeOwnedReplay({
      branch,
      actorKind: 'system',
    })).resolves.toMatchObject({ replayed: true });
    expect(assertReplayPinMock).toHaveBeenCalledTimes(1);
    expect(resolveModeMock).not.toHaveBeenCalled();
    expect(lockRuntimeMock).not.toHaveBeenCalled();
    expect(completeEvidenceMock).not.toHaveBeenCalled();
    expect(completeRegisteredConditionMock).not.toHaveBeenCalled();
    expect(createTaskMock).not.toHaveBeenCalled();
  },
);

it('fails closed for production active mode but accepts an identity-sealed test capability', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_task',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  runtime.instance.encounter_id = '66666666-6666-4666-8666-666666666666';
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');

  await expect(executePathwayCommand(command({ registry }))).rejects.toMatchObject({
    code: 'PATHWAY_ACTIVE_EXECUTION_UNAVAILABLE',
  });
  const capability = createPathwayActivationEvidenceCapabilityForTests();
  await expect(executePathwayCommand(command({
    registry,
    activationEvidenceCapability: capability,
  }))).resolves.toMatchObject({ replayed: false, mode: 'active' });
  expect(createTaskMock).toHaveBeenCalledTimes(1);
  expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
    metadata: expect.objectContaining({
      canonical_encounter_id: '66666666-6666-4666-8666-666666666666',
    }),
  }));
  expect(createTaskMock.mock.calls[0][0]).not.toHaveProperty('encounterId');
});

it('completes registered evidence and executes it through one branded transaction', async () => {
  const registry = registryFor({
    condition: {
      stepKinds: ['task'],
      decisionCodes: ['blocked', 'satisfied'],
      evaluate: async () => ({ decision: 'satisfied', evidence: { verified: true } }),
    },
  });
  runtime = makeRuntime({
    workflow_key: 'synthetic_combined_evidence',
    steps: [{
      step_key: 'verify',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.condition.v1',
      work_semantics: {
        task_kind: 'verification',
        priority: 'high',
        sla_completion_semantics: 'domain_evidence',
        sla_rule_code: 'synthetic_domain_evidence',
      },
    }],
  }, registry, { status: 'running' });
  runtime.tasks = [{
    id: 701,
    tenant_id: TENANT,
    workflow_run_id: 77,
    workflow_step_id: 100,
    status: 'completed',
    workflow_sla_instance_id: '99999999-9999-4999-8999-999999999999',
    sla_completion_semantics: 'domain_evidence',
  }];
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  const completionEvidence = {
    kind: 'pathway_registered_condition',
    handler_id: 'synthetic.condition.v1',
    decision: 'satisfied',
    resource_type: 'workflow_steps',
    resource_id: '100',
    payload: { blob: '' },
    provenance: { actor_kind: 'user', actor_uid: ACTOR_UID },
  };
  completionEvidence.payload.blob = 'x'.repeat(
    65536 - Buffer.byteLength(JSON.stringify(completionEvidence), 'utf8'),
  );
  expect(Buffer.byteLength(JSON.stringify(completionEvidence), 'utf8')).toBe(65536);
  completeEvidenceMock.mockResolvedValue({
    task: { id: 701, status: 'completed' },
    sla: { id: '99999999-9999-4999-8999-999999999999', status: 'completed' },
    previousTaskStatus: 'open',
    previousSlaStatus: 'active',
    mutated: true,
    evidence: completionEvidence,
  });

  await completePathwayTaskAndExecuteFromRegisteredEvidence({
    ...command({
      registry,
      activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
    }),
    taskId: 701,
    workflowRunId: 77,
    workflowStepId: 100,
    conditionHandler: 'synthetic.condition.v1',
    evidence: completionEvidence.payload,
  });

  expect(completeEvidenceMock).toHaveBeenCalledWith(expect.objectContaining({
    tenantId: TENANT,
    id: 701,
    pathwayInstanceId: INSTANCE_ID,
    workflowRunId: 77,
    workflowStepId: 100,
    actor: expect.objectContaining({ uid: ACTOR_UID }),
    signal: expect.objectContaining({ kind: 'evaluate' }),
    tx: TX,
  }));
  const authority = completeEvidenceMock.mock.calls[0][0].executorAuthority;
  expect(isPathwayExecutorCapability(authority)).toBe(true);
  expect(Object.isFrozen(authority)).toBe(true);
  expect(findReplayMock).toHaveBeenCalledTimes(2);
  expect(findReplayMock.mock.invocationCallOrder[0]).toBeLessThan(
    completeEvidenceMock.mock.invocationCallOrder[0],
  );
  expect(completeEvidenceMock.mock.invocationCallOrder[0]).toBeLessThan(
    findReplayMock.mock.invocationCallOrder[1],
  );
  const canonicalTaskEvent = appendEventMock.mock.calls
    .map(([event]) => event)
    .find((event) => event.transitionKey === 'domain_evidence_task_completed');
  expect(canonicalTaskEvent.eventPayload.evidence).toEqual(expect.objectContaining({
    handler_id: 'synthetic.condition.v1',
    evidence_fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
  }));
  expect(canonicalTaskEvent.eventPayload.evidence).not.toHaveProperty('payload');
  expect(Buffer.byteLength(JSON.stringify(canonicalTaskEvent.eventPayload), 'utf8'))
    .toBeLessThanOrEqual(65536);
  expect(setTenantTxMock).not.toHaveBeenCalled();
});

it('completes a current no-SLA task only through registered condition evidence', async () => {
  const registry = registryFor({
    condition: {
      stepKinds: ['task'],
      decisionCodes: ['blocked', 'satisfied'],
      evaluate: async () => ({
        decision: 'satisfied',
        evidence: { closure_evidence_valid: true },
      }),
    },
  });
  runtime = makeRuntime({
    workflow_key: 'synthetic_registered_condition',
    steps: [{
      step_key: 'recover',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.condition.v1',
      work_semantics: {
        task_kind: 'follow_up',
        priority: 'normal',
        sla_completion_semantics: 'none',
      },
    }],
  }, registry, { status: 'running' });
  runtime.tasks = [{
    id: 701,
    tenant_id: TENANT,
    workflow_run_id: 77,
    workflow_step_id: 100,
    status: 'completed',
    workflow_sla_instance_id: null,
    sla_completion_semantics: 'none',
  }];
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  const completionEvidence = {
    kind: 'pathway_registered_condition',
    handler_id: 'synthetic.condition.v1',
    decision: 'satisfied',
    resource_type: 'op_visit_closure_evidence',
    resource_id: '88888888-8888-4888-8888-888888888888',
    payload: { closure_evidence_valid: true },
    provenance: { actor_kind: 'user', actor_uid: ACTOR_UID },
  };
  completeRegisteredConditionMock.mockResolvedValue({
    task: { id: 701, status: 'completed' },
    previousTaskStatus: 'open',
    mutated: true,
    evidence: completionEvidence,
  });

  await completePathwayTaskAndExecuteFromRegisteredCondition({
    ...command({
      registry,
      activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
    }),
    taskId: 701,
    workflowRunId: 77,
    workflowStepId: 100,
    conditionHandler: 'synthetic.condition.v1',
    evidenceResourceType: 'op_visit_closure_evidence',
    evidenceResourceId: '88888888-8888-4888-8888-888888888888',
    evidence: completionEvidence.payload,
  });

  expect(completeRegisteredConditionMock).toHaveBeenCalledWith(expect.objectContaining({
    tenantId: TENANT,
    id: 701,
    pathwayInstanceId: INSTANCE_ID,
    workflowRunId: 77,
    workflowStepId: 100,
    evidenceResourceType: 'op_visit_closure_evidence',
    evidenceResourceId: '88888888-8888-4888-8888-888888888888',
    tx: TX,
  }));
  const authority = completeRegisteredConditionMock.mock.calls[0][0].executorAuthority;
  expect(isPathwayExecutorCapability(authority)).toBe(true);
  const canonicalTaskEvent = appendEventMock.mock.calls
    .map(([event]) => event)
    .find((event) => event.transitionKey === 'registered_condition_task_completed');
  expect(canonicalTaskEvent).toMatchObject({
    workflowSlaInstanceId: null,
    eventPayload: {
      task_id: 701,
      evidence: {
        resource_type: 'op_visit_closure_evidence',
        resource_id: '88888888-8888-4888-8888-888888888888',
      },
    },
  });
  expect(canonicalTaskEvent.eventPayload).not.toHaveProperty('workflow_sla_instance_id');
  expect(closeInstanceMock).toHaveBeenCalledTimes(1);
});

it('rolls back registered-condition task completion when the governed condition stays blocked', async () => {
  const registry = registryFor({
    condition: {
      stepKinds: ['task'],
      decisionCodes: ['blocked', 'satisfied'],
      evaluate: async () => ({
        decision: 'blocked',
        evidence: { closure_evidence_valid: false },
      }),
    },
  });
  runtime = makeRuntime({
    workflow_key: 'synthetic_registered_condition_blocked',
    steps: [{
      step_key: 'recover',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.condition.v1',
      work_semantics: {
        task_kind: 'follow_up',
        priority: 'normal',
        sla_completion_semantics: 'none',
      },
    }],
  }, registry, { status: 'running' });
  runtime.tasks = [{
    id: 701,
    tenant_id: TENANT,
    workflow_run_id: 77,
    workflow_step_id: 100,
    status: 'completed',
    workflow_sla_instance_id: null,
    sla_completion_semantics: 'none',
  }];
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  completeRegisteredConditionMock.mockResolvedValue({
    task: { id: 701, status: 'completed' },
    previousTaskStatus: 'open',
    mutated: true,
    evidence: {
      kind: 'pathway_registered_condition',
      handler_id: 'synthetic.condition.v1',
      decision: 'satisfied',
      resource_type: 'op_visit_closure_evidence',
      resource_id: '88888888-8888-4888-8888-888888888888',
      payload: { closure_evidence_valid: true },
      provenance: { actor_kind: 'user', actor_uid: ACTOR_UID },
    },
  });

  await expect(completePathwayTaskAndExecuteFromRegisteredCondition({
    ...command({
      registry,
      activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
      tx: null,
    }),
    taskId: 701,
    workflowRunId: 77,
    workflowStepId: 100,
    conditionHandler: 'synthetic.condition.v1',
    evidenceResourceType: 'op_visit_closure_evidence',
    evidenceResourceId: '88888888-8888-4888-8888-888888888888',
    evidence: { closure_evidence_valid: true },
  })).rejects.toMatchObject({
    code: 'PATHWAY_REGISTERED_CONDITION_POSTCONDITION_FAILED',
  });

  expect(setTenantTxMock).toHaveBeenCalledTimes(1);
  expect(completeRegisteredConditionMock).toHaveBeenCalledWith(expect.objectContaining({ tx: TX }));
  expect(appendBatchMock).toHaveBeenCalledWith(expect.objectContaining({ tx: TX }));
  expect(appendEventMock).toHaveBeenCalledWith(expect.objectContaining({
    tx: TX,
    transitionKey: 'registered_condition_task_completed',
  }));
  expect(appendEventMock).toHaveBeenCalledWith(expect.objectContaining({
    tx: TX,
    transitionKey: 'step_blocked',
  }));
  expect(closeInstanceMock).not.toHaveBeenCalled();
});

it('keeps a combined user command bound to its pre-mutation normalized envelope', async () => {
  const registry = registryFor({
    condition: {
      stepKinds: ['task'],
      decisionCodes: ['blocked', 'satisfied'],
      evaluate: async () => ({ decision: 'satisfied', evidence: { verified: true } }),
    },
  });
  installCompletedDomainEvidenceRuntime(registry, 'synthetic_captured_user_envelope');
  const actor = userActor();
  const signal = { kind: 'evaluate', payload: { version: 'original' } };
  const request = {
    ...command({
      registry,
      actor,
      signal,
      idempotencyKey: 'captured_user_key',
      activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
    }),
    taskId: 701,
    workflowRunId: 77,
    workflowStepId: 100,
    conditionHandler: 'synthetic.condition.v1',
    evidence: { verified: true },
  };
  completeEvidenceMock.mockImplementation(async () => {
    actor.uid = OTHER_ACTOR_UID;
    signal.kind = 'caller_mutated';
    signal.payload.version = 'mutated';
    request.idempotencyKey = 'mutated_user_key';
    request.activationEvidenceCapability = null;
    return completedDomainEvidence({ actor_kind: 'user', actor_uid: ACTOR_UID });
  });

  await expect(
    completePathwayTaskAndExecuteFromRegisteredEvidence(request),
  ).resolves.toMatchObject({ replayed: false, mode: 'active' });

  const [preMutationReplay, innerReplay] = findReplayMock.mock.calls.map(([input]) => input);
  expect(innerReplay.idempotencyKey).toBe(preMutationReplay.idempotencyKey);
  expect(innerReplay.commandFingerprint).toBe(preMutationReplay.commandFingerprint);
  expect(completeEvidenceMock).toHaveBeenCalledWith(expect.objectContaining({
    actor: expect.objectContaining({ uid: ACTOR_UID }),
    signal: expect.objectContaining({
      kind: 'evaluate',
      payload: { version: 'original' },
    }),
  }));
  expect(appendBatchMock).toHaveBeenCalledWith(expect.objectContaining({
    idempotencyKey: preMutationReplay.idempotencyKey,
    commandFingerprint: preMutationReplay.commandFingerprint,
    actor: expect.objectContaining({ uid: ACTOR_UID }),
  }));
  expect(appendEventMock.mock.calls.every(([event]) => (
    event.eventPayload.signal_kind === 'evaluate'
  ))).toBe(true);
});

it('keeps sealed system provenance bound to the captured combined command envelope', async () => {
  const registry = registryFor({
    condition: {
      stepKinds: ['task'],
      decisionCodes: ['blocked', 'satisfied'],
      evaluate: async () => ({ decision: 'satisfied', evidence: { verified: true } }),
    },
  });
  installCompletedDomainEvidenceRuntime(registry, 'synthetic_captured_system_envelope');
  const originalActor = createRegisteredWorkflowSystemActor({
    registry,
    systemKey: 'synthetic.projector.v1',
    sourceEventId: 501,
    causationId: 'captured-system-causation',
    signalContext: sealedSignalContext(),
  });
  const replacementActor = createRegisteredWorkflowSystemActor({
    registry,
    systemKey: 'synthetic.projector.v1',
    sourceEventId: 502,
    causationId: 'mutated-system-causation',
    signalContext: sealedSignalContext({
      sourceResourceId: '92',
      occurredAt: '2026-07-19T10:01:00Z',
    }),
  });
  const request = {
    ...command({
      registry,
      actor: originalActor,
      signal: { kind: 'evaluate', payload: { version: 'original' } },
      idempotencyKey: 'captured_system_key',
      activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
    }),
    taskId: 701,
    workflowRunId: 77,
    workflowStepId: 100,
    conditionHandler: 'synthetic.condition.v1',
    evidence: { verified: true },
  };
  completeEvidenceMock.mockImplementation(async () => {
    request.actor = replacementActor;
    request.signal = { kind: 'caller_mutated', payload: { version: 'mutated' } };
    request.idempotencyKey = 'mutated_system_key';
    request.activationEvidenceCapability = null;
    return completedDomainEvidence({
      actor_kind: 'system',
      system_key: 'synthetic.projector.v1',
      source_event_id: '501',
    });
  });

  await expect(
    completePathwayTaskAndExecuteFromRegisteredEvidence(request),
  ).resolves.toMatchObject({ replayed: false, mode: 'active' });

  const [preMutationReplay, innerReplay] = findReplayMock.mock.calls.map(([input]) => input);
  expect(innerReplay.idempotencyKey).toBe(preMutationReplay.idempotencyKey);
  expect(innerReplay.commandFingerprint).toBe(preMutationReplay.commandFingerprint);
  expect(completeEvidenceMock.mock.calls[0][0].actor).toBe(originalActor);
  expect(completeEvidenceMock.mock.calls[0][0].signal).toEqual(expect.objectContaining({
    kind: 'evaluate',
    source_resource_type: 'event_outbox',
    source_resource_id: '91',
    occurred_at: '2026-07-19T10:00:00.000Z',
  }));
  expect(appendBatchMock).toHaveBeenCalledWith(expect.objectContaining({
    idempotencyKey: preMutationReplay.idempotencyKey,
    commandFingerprint: preMutationReplay.commandFingerprint,
    occurredAt: '2026-07-19T10:00:00.000Z',
    actor: originalActor,
  }));
  expect(appendEventMock.mock.calls.every(([event]) => (
    event.eventPayload.signal_kind === 'evaluate'
  ))).toBe(true);
});

it('suppresses task materialization in shadow while recording the suppression', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_shadow_task',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  installRuntimeMocks();

  const result = await executePathwayCommand(command({ registry }));
  expect(result.events.map((event) => event.transition_key)).toContain('task_materialization_suppressed');
  expect(createTaskMock).not.toHaveBeenCalled();
  expect(createApprovalMock).not.toHaveBeenCalled();
});

it('derives a human task deadline only from its linked SLA and verifies the exact match', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_sla_deadline',
    steps: [{
      step_key: 'acknowledge',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: {
        task_kind: 'review',
        priority: 'high',
        sla_completion_semantics: 'acknowledgement',
        sla_rule_code: 'synthetic_acknowledgement',
      },
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  startWorkflowSlaMock.mockResolvedValue({
    id: '99999999-9999-4999-8999-999999999999',
    due_at: '2026-07-19T12:30:00+05:30',
  });
  createTaskMock.mockImplementationOnce(async (input) => ({
    id: 701,
    workflow_run_id: input.workflowRunId,
    workflow_step_id: input.workflowStepId,
    workflow_sla_instance_id: input.workflowSlaInstanceId,
    sla_completion_semantics: input.slaCompletionSemantics,
    status: 'open',
    due_at: '2026-07-19T07:00:00.000Z',
  }));

  await executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }));
  expect(startWorkflowSlaMock).toHaveBeenCalledWith(
    expect.objectContaining({
      assignedRoleCodes: [],
      assignedUserUid: ACTOR_UID,
      metadata: expect.objectContaining({
        task_materialization_contract: 'application_atomic_v1',
      }),
    }),
    { db: TX },
  );
  expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
    assignedToUid: ACTOR_UID,
    assignedToRole: null,
    workflowSlaInstanceId: '99999999-9999-4999-8999-999999999999',
  }));
  expect(createTaskMock.mock.calls[0][0]).not.toHaveProperty('dueAt');
  expect(runtime.tasks[0].due_at).toBe('2026-07-19T07:00:00.000Z');
});

it('uses role-only routing for an unnamed pathway owner across the task and SLA', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_role_queue',
    steps: [{
      step_key: 'acknowledge',
      step_kind: 'task',
      assigned_role: 'NURSING_STAFF',
      work_semantics: {
        task_kind: 'review',
        priority: 'high',
        sla_completion_semantics: 'acknowledgement',
        sla_rule_code: 'synthetic_acknowledgement',
      },
    }],
  }, registry);
  runtime.instance.owning_clinician_uid = null;
  runtime.instance.accountable_role = 'NURSING_STAFF';
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  startWorkflowSlaMock.mockResolvedValue({
    id: '99999999-9999-4999-8999-999999999999',
    due_at: '2026-07-19T07:00:00.000Z',
  });
  createTaskMock.mockImplementationOnce(async (input) => ({
    id: 701,
    workflow_run_id: input.workflowRunId,
    workflow_step_id: input.workflowStepId,
    workflow_sla_instance_id: input.workflowSlaInstanceId,
    sla_completion_semantics: input.slaCompletionSemantics,
    assigned_to_uid: input.assignedToUid,
    assigned_to_role: input.assignedToRole,
    status: 'open',
    due_at: '2026-07-19T07:00:00.000Z',
  }));

  await executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }));

  expect(startWorkflowSlaMock).toHaveBeenCalledWith(expect.objectContaining({
    assignedRoleCodes: ['NURSING_STAFF'],
    assignedUserUid: null,
  }), { db: TX });
  expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
    assignedToUid: null,
    assignedToRole: 'NURSING_STAFF',
  }));
});

it('does not let a matching role mask a named pathway owner', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_named_owner',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  installRuntimeMocks();

  await expect(executePathwayCommand(command({
    registry,
    actor: { ...userActor(), uid: OTHER_ACTOR_UID },
  }))).rejects.toMatchObject({ code: 'PATHWAY_SIGNAL_NOT_OWNED' });
  expect(transitionRunMock).not.toHaveBeenCalled();
  expect(createTaskMock).not.toHaveBeenCalled();
});

it('revalidates a named owner before materializing the next human stage', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_unavailable_owner',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  TX.$queryRawUnsafe
    .mockResolvedValueOnce([{ uid: ACTOR_UID, role: 'NURSING_STAFF' }])
    .mockResolvedValueOnce([]);

  await expect(executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }))).rejects.toMatchObject({ code: 'PATHWAY_NAMED_OWNER_UNAVAILABLE' });
  expect(startWorkflowSlaMock).not.toHaveBeenCalled();
  expect(createTaskMock).not.toHaveBeenCalled();
});

it('rejects a stale named-owner command before executing a non-human stage', async () => {
  const evaluate = jest.fn(async () => ({ decision: 'satisfied', evidence: [] }));
  const registry = registryFor({
    condition: {
      stepKinds: ['wait'],
      decisionCodes: ['blocked', 'satisfied'],
      evaluate,
    },
  });
  runtime = makeRuntime({
    workflow_key: 'synthetic_stale_named_owner',
    steps: [{
      step_key: 'wait_for_evidence',
      step_kind: 'wait',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.condition.v1',
    }],
  }, registry, { status: 'running' });
  installRuntimeMocks();
  TX.$queryRawUnsafe
    .mockResolvedValueOnce([{ uid: ACTOR_UID, role: 'NURSING_STAFF' }])
    .mockResolvedValueOnce([]);

  await expect(executePathwayCommand(command({ registry }))).rejects.toMatchObject({
    code: 'PATHWAY_NAMED_OWNER_UNAVAILABLE',
  });
  expect(evaluate).not.toHaveBeenCalled();
  expect(transitionStepMock).not.toHaveBeenCalled();
});

it('rolls back when a materialized task deadline differs from its linked SLA', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_sla_deadline_mismatch',
    steps: [{
      step_key: 'acknowledge',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: {
        task_kind: 'review',
        priority: 'high',
        sla_completion_semantics: 'acknowledgement',
        sla_rule_code: 'synthetic_acknowledgement',
      },
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  startWorkflowSlaMock.mockResolvedValue({
    id: '99999999-9999-4999-8999-999999999999',
    due_at: '2026-07-19T07:00:00.000Z',
  });
  createTaskMock.mockImplementationOnce(async (input) => ({
    id: 701,
    workflow_run_id: input.workflowRunId,
    workflow_step_id: input.workflowStepId,
    workflow_sla_instance_id: input.workflowSlaInstanceId,
    sla_completion_semantics: input.slaCompletionSemantics,
    status: 'open',
    due_at: '2026-07-19T07:01:00.000Z',
  }));

  await expect(executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }))).rejects.toMatchObject({ code: 'PATHWAY_TASK_SLA_DUE_AT_MISMATCH' });
  expect(appendBatchMock).not.toHaveBeenCalled();
});

it('materializes a task-first approval and links the approval to that task', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_approval',
    steps: [{
      step_key: 'approve',
      step_kind: 'approval',
      work_semantics: {
        approval_kind: 'synthetic_governance',
        required_approvers: 1,
        task_kind: 'review',
        priority: 'normal',
        sla_completion_semantics: 'none',
      },
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');

  await executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }));
  expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
    stageOccurrenceKey: `${INSTANCE_ID}:approve:approval_task`,
  }));
  expect(createApprovalMock).toHaveBeenCalledWith(expect.objectContaining({
    taskId: expect.any(Number),
    materializationKey: `${INSTANCE_ID}:approve:approval`,
    requiredRole: 'DOCTOR',
  }));
  for (const transitionKey of ['task_materialized', 'approval_materialized']) {
    expect(appendEventMock).toHaveBeenCalledWith(expect.objectContaining({
      transitionKey,
      workflowStepId: 100,
    }));
  }
});

it('gives conditions only frozen read snapshots and preserves primary actor role', async () => {
  const evaluate = jest.fn(async (context) => {
    expect(context).not.toHaveProperty('tx');
    expect(context).not.toHaveProperty('query');
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.instance)).toBe(true);
    expect(Object.isFrozen(context.tasks)).toBe(true);
    expect(transitionRunMock).not.toHaveBeenCalled();
    expect(transitionStepMock).not.toHaveBeenCalled();
    return { decision: 'satisfied', evidence: [] };
  });
  const registry = registryFor({
    condition: {
      stepKinds: ['wait'],
      decisionCodes: ['blocked', 'satisfied'],
      evaluate,
    },
  });
  runtime = makeRuntime({
    workflow_key: 'synthetic_wait',
    steps: [{
      step_key: 'wait_for_evidence',
      step_kind: 'wait',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.condition.v1',
    }],
  }, registry, { status: 'running' });
  installRuntimeMocks();

  await executePathwayCommand(command({ registry }));
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(appendEventMock).toHaveBeenCalledWith(expect.objectContaining({
    actor: expect.objectContaining({ primaryRole: 'NURSING_STAFF' }),
    registry,
  }));
});

it('executes an active registered action once and completes its one-step run', async () => {
  const execute = jest.fn(async () => ({ outcome: 'recorded' }));
  const registry = registryFor({
    action: { stepKinds: ['automation'], execute },
  });
  runtime = makeRuntime({
    workflow_key: 'synthetic_action',
    steps: [{
      step_key: 'record_marker',
      step_kind: 'automation',
      assigned_role: 'DOCTOR',
      action_handler: 'synthetic.action.v1',
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');

  await executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }));
  expect(execute).toHaveBeenCalledTimes(1);
  expect(transitionStepMock).toHaveBeenCalledWith(expect.objectContaining({ nextStatus: 'completed' }));
  expect(closeInstanceMock).toHaveBeenCalledTimes(1);
});

it('gives an action only frozen data and no transaction or query capability', async () => {
  const execute = jest.fn(async (context) => {
    expect(context).not.toHaveProperty('tx');
    expect(Object.values(context).some(
      (value) => typeof value?.$queryRawUnsafe === 'function',
    )).toBe(false);
    expect(Object.isFrozen(context.instance)).toBe(true);
    expect(Object.isFrozen(context.instance.metadata)).toBe(true);
    expect(Object.isFrozen(context.run)).toBe(true);
    expect(Object.isFrozen(context.step)).toBe(true);
    expect(() => { context.instance.metadata.compromised = true; }).toThrow(TypeError);
    expect(() => { context.run.status = 'completed'; }).toThrow(TypeError);
    expect(() => { context.step.status = 'failed'; }).toThrow(TypeError);
    return { outcome: 'recorded' };
  });
  const registry = registryFor({
    action: { stepKinds: ['automation'], execute },
  });
  runtime = makeRuntime({
    workflow_key: 'synthetic_frozen_action',
    steps: [{
      step_key: 'record_marker',
      step_kind: 'automation',
      assigned_role: 'DOCTOR',
      action_handler: 'synthetic.action.v1',
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');

  await executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }));
  expect(execute).toHaveBeenCalledTimes(1);
  expect(runtime.instance.metadata).not.toHaveProperty('compromised');
  expect(runtime.run.status).toBe('completed');
  expect(runtime.steps[0].status).toBe('completed');
});

it('rejects a trusted action that mutates any executor-owned runtime row through its transaction', async () => {
  const execute = jest.fn(async () => ({ outcome: 'recorded' }));
  const registry = registryFor({ action: { stepKinds: ['automation'], execute } });
  runtime = makeRuntime({
    workflow_key: 'synthetic_action_runtime_mutation',
    steps: [{
      step_key: 'record_marker',
      step_kind: 'automation',
      assigned_role: 'DOCTOR',
      action_handler: 'synthetic.action.v1',
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  let lockCount = 0;
  lockRuntimeMock.mockImplementation(async () => {
    lockCount += 1;
    if (lockCount <= 2) return runtime;
    return { ...runtime, tasks: [{ id: 999, status: 'open', workflow_step_id: 100 }] };
  });

  await expect(executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }))).rejects.toMatchObject({ code: 'PATHWAY_ACTION_RUNTIME_MUTATION_FORBIDDEN' });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(appendBatchMock).not.toHaveBeenCalled();
});

it('rejects a trusted action that mutates its governed definition evidence', async () => {
  const execute = jest.fn(async () => ({ outcome: 'recorded' }));
  const registry = registryFor({ action: { stepKinds: ['automation'], execute } });
  runtime = makeRuntime({
    workflow_key: 'synthetic_action_definition_mutation',
    steps: [{
      step_key: 'record_marker',
      step_kind: 'automation',
      assigned_role: 'DOCTOR',
      action_handler: 'synthetic.action.v1',
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  let lockCount = 0;
  lockRuntimeMock.mockImplementation(async () => {
    lockCount += 1;
    return lockCount <= 2
      ? runtime
      : { ...runtime, definition: { ...runtime.definition, definition_checksum: '0'.repeat(64) } };
  });

  await expect(executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }))).rejects.toMatchObject({ code: 'PATHWAY_ACTION_RUNTIME_MUTATION_FORBIDDEN' });
  expect(appendBatchMock).not.toHaveBeenCalled();
});

it('rejects a trusted action that mutates a materialized child run, step or task graph', async () => {
  const execute = jest.fn(async () => ({ outcome: 'recorded' }));
  const registry = registryFor({ action: { stepKinds: ['automation'], execute } });
  runtime = makeRuntime({
    workflow_key: 'synthetic_action_child_graph_mutation',
    steps: [{
      step_key: 'record_marker',
      step_kind: 'automation',
      assigned_role: 'DOCTOR',
      action_handler: 'synthetic.action.v1',
    }],
  }, registry);
  const childInstance = {
    id: CHILD_ID,
    tenant_id: TENANT,
    workflow_run_id: 88,
    parent_instance_id: INSTANCE_ID,
    clinical_status: 'active',
  };
  runtime.children = [childInstance];
  runtime.childRuntimeGraphs = [{
    instance: childInstance,
    run: { id: 88, status: 'running', current_step_key: 'child_review' },
    steps: [{ id: 188, workflow_run_id: 88, step_key: 'child_review', status: 'in_progress' }],
    tasks: [{ id: 288, workflow_run_id: 88, workflow_step_id: 188, status: 'open' }],
  }];
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  let lockCount = 0;
  lockRuntimeMock.mockImplementation(async () => {
    lockCount += 1;
    if (lockCount <= 2) return runtime;
    return {
      ...runtime,
      childRuntimeGraphs: [{
        instance: childInstance,
        run: { ...runtime.childRuntimeGraphs[0].run, status: 'completed' },
        steps: [{ ...runtime.childRuntimeGraphs[0].steps[0], status: 'completed' }],
        tasks: [{ ...runtime.childRuntimeGraphs[0].tasks[0], status: 'completed' }],
      }],
    };
  });

  await expect(executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }))).rejects.toMatchObject({ code: 'PATHWAY_ACTION_RUNTIME_MUTATION_FORBIDDEN' });
  expect(appendBatchMock).not.toHaveBeenCalled();
});

it('rejects a trusted action that changes transition ledger count or sequence', async () => {
  const execute = jest.fn(async () => ({ outcome: 'recorded' }));
  const registry = registryFor({ action: { stepKinds: ['automation'], execute } });
  runtime = makeRuntime({
    workflow_key: 'synthetic_action_ledger_mutation',
    steps: [{
      step_key: 'record_marker',
      step_kind: 'automation',
      assigned_role: 'DOCTOR',
      action_handler: 'synthetic.action.v1',
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  getTransitionLedgerStateMock
    .mockResolvedValueOnce({ eventCount: 0, maxSequence: 0 })
    .mockResolvedValueOnce({ eventCount: 1, maxSequence: 1 });

  await expect(executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }))).rejects.toMatchObject({ code: 'PATHWAY_ACTION_RUNTIME_MUTATION_FORBIDDEN' });
  expect(appendBatchMock).not.toHaveBeenCalled();
});

it('validates the authoritative post-handler runtime instead of a stale pre-reload object', async () => {
  const execute = jest.fn(async () => ({ outcome: 'recorded' }));
  const registry = registryFor({ action: { stepKinds: ['automation'], execute } });
  runtime = makeRuntime({
    workflow_key: 'synthetic_action_post_reload_graph',
    steps: [{
      step_key: 'record_marker',
      step_kind: 'automation',
      assigned_role: 'DOCTOR',
      action_handler: 'synthetic.action.v1',
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  let lockCount = 0;
  lockRuntimeMock.mockImplementation(async () => {
    lockCount += 1;
    if (lockCount === 1) return runtime;
    return {
      ...runtime,
      instance: { ...runtime.instance },
      run: { ...runtime.run },
      steps: runtime.steps.map((step) => ({ ...step })),
      children: [...runtime.children],
      tasks: [...runtime.tasks],
      approvals: [...runtime.approvals],
      handoffs: [...runtime.handoffs],
      slas: [...runtime.slas],
    };
  });
  transitionStepMock.mockImplementation(async (input) => {
    const step = runtime.steps.find((candidate) => Number(candidate.id) === Number(input.stepId));
    return {
      ...step,
      step_key: input.nextStatus === 'completed' ? 'tampered_after_reload' : step.step_key,
      status: input.nextStatus,
      outcome: input.outcome || null,
    };
  });

  await expect(executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }))).rejects.toMatchObject({ code: 'PATHWAY_GRAPH_INVALID' });
  expect(appendBatchMock).not.toHaveBeenCalled();
});

it('materializes a registered child once and waits on the same durable child on the next command', async () => {
  const fanout = jest.fn(async (context) => {
    expect(context).not.toHaveProperty('tx');
    expect(Object.isFrozen(context.instance)).toBe(true);
    return [{
      workflowDefinitionId: 22,
      pathwayKey: 'synthetic_child',
      sourceEpisodeType: 'synthetic_child_episode',
      sourceEpisodeId: 'child-episode-1',
      accountableRole: 'DOCTOR',
    }];
  });
  const registry = registryFor({
    fanout: { stepKinds: ['subworkflow'], resolve: fanout },
  });
  runtime = makeRuntime({
    workflow_key: 'synthetic_parent',
    steps: [{
      step_key: 'launch_child',
      step_kind: 'subworkflow',
      assigned_role: 'DOCTOR',
      child_rules: [{
        rule_key: 'child_rule',
        fanout_handler: 'synthetic.child.v1',
        child_pathway_key: 'synthetic_child',
        relationship: 'blocking',
      }],
    }],
  }, registry);
  childDefinition = makeDefinition({
    workflow_key: 'synthetic_child',
    steps: [{
      step_key: 'child_review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  loadDefinitionMock.mockImplementation(async ({ workflowDefinitionId }) => {
    expect(workflowDefinitionId).toBe(22);
    return childDefinition;
  });
  insertRuntimeMock.mockImplementation(async (input) => ({
    instance: {
      id: CHILD_ID,
      tenant_id: TENANT,
      workflow_run_id: 88,
      patient_uid: PATIENT,
      encounter_id: null,
      pathway_key: 'synthetic_child',
      pathway_version: 1,
      clinical_status: 'planned',
      metadata: input.metadata,
    },
    run: { id: 88, status: 'started' },
    steps: [],
  }));

  const capability = createPathwayActivationEvidenceCapabilityForTests();
  await executePathwayCommand(command({
    registry,
    activationEvidenceCapability: capability,
  }));
  expect(insertRuntimeMock).toHaveBeenCalledTimes(1);
  expect(fanout).toHaveBeenCalledTimes(1);
  expect(acquireStartLocksMock).toHaveBeenCalledWith(expect.objectContaining({
    waitForLocks: false,
  }));

  await executePathwayCommand(command({
    registry,
    idempotencyKey: 'command_key_2',
    activationEvidenceCapability: capability,
  }));
  expect(insertRuntimeMock).toHaveBeenCalledTimes(1);
  expect(fanout).toHaveBeenCalledTimes(1);
});

it('binds the full start request into the replay fingerprint', async () => {
  const registry = registryFor();
  resolveModeMock.mockResolvedValue('off');
  const existing = {
    id: INSTANCE_ID,
    patient_uid: PATIENT,
    pathway_key: 'synthetic_start',
    source_episode_type: 'patient',
    source_episode_id: PATIENT,
  };
  findInstanceByKeyMock.mockResolvedValue(existing);
  getInstanceMock.mockResolvedValue(existing);
  const fingerprints = [];
  findReplayMock.mockImplementation(async (input) => {
    fingerprints.push(input.commandFingerprint);
    return {
      replayed: true,
      events: [{
        metadata: {
          pathway_runtime: { mode: 'shadow', result_snapshot: existing },
        },
      }],
    };
  });
  const base = {
    tenantId: TENANT,
    workflowDefinitionId: 11,
    patientUid: PATIENT,
    pathwayKey: 'synthetic_start',
    sourceEpisodeType: 'patient',
    sourceEpisodeId: PATIENT,
    accountableRole: 'NURSING_STAFF',
    idempotencyKey: 'start_key_1',
    actor: userActor(),
    registry,
  };
  await startCarePathwayInstance({ ...base, metadata: { revision: 1 } });
  await startCarePathwayInstance({ ...base, metadata: { revision: 2 } });
  expect(fingerprints[0]).not.toBe(fingerprints[1]);
  expect(resolveModeMock).not.toHaveBeenCalled();
});

it('rejects a fresh pathway start while mode is off before runtime persistence or effects', async () => {
  const evaluate = jest.fn();
  const execute = jest.fn();
  const resolve = jest.fn();
  const registry = registryFor({
    condition: {
      stepKinds: ['automation'],
      decisionCodes: ['blocked', 'satisfied'],
      evaluate,
    },
    action: { stepKinds: ['automation'], execute },
    fanout: { stepKinds: ['automation'], resolve },
  });
  resolveModeMock.mockResolvedValue('off');

  await expect(startCarePathwayInstance({
    tenantId: TENANT,
    workflowDefinitionId: 11,
    patientUid: PATIENT,
    pathwayKey: 'synthetic_start_off',
    sourceEpisodeType: 'patient',
    sourceEpisodeId: PATIENT,
    accountableRole: 'NURSING_STAFF',
    idempotencyKey: 'start_off_key_1',
    actor: userActor(),
    registry,
  })).rejects.toMatchObject({ code: 'PATHWAY_MODE_OFF' });

  expect(acquireStartLocksMock).toHaveBeenCalledTimes(1);
  expect(findInstanceByKeyMock).toHaveBeenCalledTimes(1);
  expect(findReplayMock).not.toHaveBeenCalled();
  expect(resolveModeMock).toHaveBeenCalledTimes(1);
  expect(assertPatientContextMock).not.toHaveBeenCalled();
  expect(findActiveEpisodeMock).not.toHaveBeenCalled();
  expect(loadDefinitionMock).not.toHaveBeenCalled();
  expect(preflightSlaRulesMock).not.toHaveBeenCalled();
  expect(insertRuntimeMock).not.toHaveBeenCalled();
  expect(transitionRunMock).not.toHaveBeenCalled();
  expect(transitionStepMock).not.toHaveBeenCalled();
  expect(activateInstanceMock).not.toHaveBeenCalled();
  expect(closeInstanceMock).not.toHaveBeenCalled();
  expect(createTaskMock).not.toHaveBeenCalled();
  expect(createApprovalMock).not.toHaveBeenCalled();
  expect(startWorkflowSlaMock).not.toHaveBeenCalled();
  expect(appendEventMock).not.toHaveBeenCalled();
  expect(appendBatchMock).not.toHaveBeenCalled();
  expect(completeEvidenceMock).not.toHaveBeenCalled();
  expect(evaluate).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
});

it('rejects a fresh pathway command while mode is off before runtime persistence or effects', async () => {
  const evaluate = jest.fn();
  const execute = jest.fn();
  const resolve = jest.fn();
  const registry = registryFor({
    condition: {
      stepKinds: ['automation'],
      decisionCodes: ['blocked', 'satisfied'],
      evaluate,
    },
    action: { stepKinds: ['automation'], execute },
    fanout: { stepKinds: ['automation'], resolve },
  });
  runtime = makeRuntime({
    workflow_key: 'synthetic_command_off',
    steps: [{
      step_key: 'automate',
      step_kind: 'automation',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.condition.v1',
      action_handler: 'synthetic.action.v1',
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('off');

  await expect(executePathwayCommand(command({ registry }))).rejects.toMatchObject({
    code: 'PATHWAY_MODE_OFF',
  });

  expect(findReplayMock).toHaveBeenCalledTimes(1);
  expect(resolveModeMock).toHaveBeenCalledTimes(1);
  expect(lockRuntimeMock).not.toHaveBeenCalled();
  expect(getInstanceMock).not.toHaveBeenCalled();
  expect(transitionRunMock).not.toHaveBeenCalled();
  expect(transitionStepMock).not.toHaveBeenCalled();
  expect(activateInstanceMock).not.toHaveBeenCalled();
  expect(closeInstanceMock).not.toHaveBeenCalled();
  expect(insertRuntimeMock).not.toHaveBeenCalled();
  expect(createTaskMock).not.toHaveBeenCalled();
  expect(createApprovalMock).not.toHaveBeenCalled();
  expect(startWorkflowSlaMock).not.toHaveBeenCalled();
  expect(appendEventMock).not.toHaveBeenCalled();
  expect(appendBatchMock).not.toHaveBeenCalled();
  expect(completeEvidenceMock).not.toHaveBeenCalled();
  expect(evaluate).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
});

it('preflights governed SLA rules before inserting any pathway runtime row', async () => {
  const registry = registryFor();
  const definition = makeDefinition({
    workflow_key: 'synthetic_sla_start',
    steps: [{
      step_key: 'acknowledge',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: {
        task_kind: 'review',
        priority: 'high',
        sla_completion_semantics: 'acknowledgement',
        sla_rule_code: 'synthetic_acknowledgement',
      },
    }],
  }, registry);
  loadDefinitionMock.mockResolvedValue(definition);
  preflightSlaRulesMock.mockRejectedValue(Object.assign(new Error('disabled rule'), {
    code: 'PATHWAY_SLA_RULE_UNAVAILABLE',
  }));

  await expect(startCarePathwayInstance({
    tenantId: TENANT,
    workflowDefinitionId: definition.id,
    patientUid: PATIENT,
    pathwayKey: 'synthetic_sla_start',
    sourceEpisodeType: 'patient',
    sourceEpisodeId: PATIENT,
    accountableRole: 'NURSING_STAFF',
    idempotencyKey: 'sla_preflight_start_1',
    actor: userActor(),
    registry,
  })).rejects.toMatchObject({ code: 'PATHWAY_SLA_RULE_UNAVAILABLE' });
  expect(preflightSlaRulesMock).toHaveBeenCalledWith(expect.objectContaining({
    tx: TX,
    tenantId: TENANT,
    compiledDefinition: expect.objectContaining({ workflow_key: 'synthetic_sla_start' }),
  }));
  expect(insertRuntimeMock).not.toHaveBeenCalled();
  expect(appendEventMock).not.toHaveBeenCalled();
});

it('server-stamps user commands but permits registered system event chronology', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_chronology',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  installRuntimeMocks();
  await expect(executePathwayCommand(command({
    registry,
    signal: { kind: 'evaluate', occurred_at: '2026-07-19T10:00:00Z' },
  }))).rejects.toMatchObject({ code: 'PATHWAY_USER_OCCURRED_AT_FORBIDDEN' });

  const systemActor = createRegisteredWorkflowSystemActor({
    registry,
    systemKey: 'synthetic.projector.v1',
    sourceEventId: '91',
    signalContext: sealedSignalContext(),
  });
  await expect(executePathwayCommand(command({
    registry,
    actor: systemActor,
    signal: { kind: 'evaluate' },
  }))).resolves.toMatchObject({ replayed: false });
  expect(appendEventMock).toHaveBeenCalledWith(expect.objectContaining({
    occurredAt: '2026-07-19T10:00:00.000Z',
  }));
});

it('fingerprints equivalent sealed BIGINT system event ids identically for replay', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_system_replay',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  installRuntimeMocks();
  const bigintActor = createRegisteredWorkflowSystemActor({
    registry,
    systemKey: 'synthetic.projector.v1',
    sourceEventId: 42n,
    causationId: 'outbox:42',
    signalContext: sealedSignalContext(),
  });
  const first = await executePathwayCommand(command({ registry, actor: bigintActor }));
  const firstFingerprint = findReplayMock.mock.calls[0][0].commandFingerprint;
  findReplayMock.mockResolvedValueOnce({
    replayed: true,
    events: first.events,
    pathwayInstance: runtime.instance,
  });
  const stringActor = createRegisteredWorkflowSystemActor({
    registry,
    systemKey: 'synthetic.projector.v1',
    sourceEventId: '00042',
    causationId: 'outbox:42',
    signalContext: sealedSignalContext(),
  });
  const replayed = await executePathwayCommand(command({ registry, actor: stringActor }));
  const replayFingerprint = findReplayMock.mock.calls[1][0].commandFingerprint;

  expect(replayFingerprint).toBe(firstFingerprint);
  expect(replayed).toMatchObject({ replayed: true, events: first.events });
});

it('namespaces idempotency by actor class, user, operation and business target', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_idempotency_namespace',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  runtime.instance.owning_clinician_uid = null;
  runtime.instance.accountable_role = 'NURSING_STAFF';
  installRuntimeMocks();
  const rawKey = 'caller-visible-retry-key';
  const otherUser = {
    ...userActor(),
    uid: '77777777-7777-4777-8777-777777777777',
  };
  const otherInstance = '88888888-8888-4888-8888-888888888888';
  const systemActor = createRegisteredWorkflowSystemActor({
    registry,
    systemKey: 'synthetic.projector.v1',
    sourceEventId: '9191',
    causationId: 'outbox:9191',
    signalContext: sealedSignalContext(),
  });

  await executePathwayCommand(command({ registry, idempotencyKey: rawKey }));
  await executePathwayCommand(command({ registry, idempotencyKey: rawKey, actor: otherUser }));
  await executePathwayCommand(command({
    registry,
    idempotencyKey: rawKey,
    pathwayInstanceId: otherInstance,
  }));
  await executePathwayCommand(command({ registry, idempotencyKey: rawKey, actor: systemActor }));

  const keys = findReplayMock.mock.calls.map(([input]) => input.idempotencyKey);
  expect(keys[0]).toMatch(new RegExp(`^u:${ACTOR_UID}:[a-f0-9]{64}$`));
  expect(keys[1]).toMatch(/^u:77777777-7777-4777-8777-777777777777:[a-f0-9]{64}$/);
  expect(keys[2]).toMatch(new RegExp(`^u:${ACTOR_UID}:[a-f0-9]{64}$`));
  expect(keys[3]).toMatch(/^s:[a-f0-9]{64}$/);
  expect(keys[2]).toBe(keys[0]);
  expect(findReplayMock.mock.calls[2][0].commandFingerprint).not.toBe(
    findReplayMock.mock.calls[0][0].commandFingerprint,
  );
  expect(new Set(keys).size).toBe(3);
  expect(keys.every((key) => key.length <= 200 && !key.includes(rawKey))).toBe(true);
});

it('deduplicates one sealed system event across raw keys but fingerprints lineage changes', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_system_event_namespace',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  installRuntimeMocks();
  const actorFor = (causationId) => createRegisteredWorkflowSystemActor({
    registry,
    systemKey: 'synthetic.projector.v1',
    sourceEventId: '9292',
    causationId,
    signalContext: sealedSignalContext(),
  });

  const first = await executePathwayCommand(command({
    registry,
    actor: actorFor('outbox:9292'),
    idempotencyKey: 'raw-system-key-a',
  }));
  findReplayMock.mockResolvedValueOnce({
    replayed: true,
    events: first.events,
    pathwayInstance: runtime.instance,
  });
  await expect(executePathwayCommand(command({
    registry,
    actor: actorFor('outbox:9292'),
    idempotencyKey: 'raw-system-key-b',
  }))).resolves.toMatchObject({ replayed: true });
  await executePathwayCommand(command({
    registry,
    actor: actorFor('changed-causation'),
    idempotencyKey: 'raw-system-key-c',
  }));

  const calls = findReplayMock.mock.calls.map(([input]) => input);
  expect(calls[1].idempotencyKey).toBe(calls[0].idempotencyKey);
  expect(calls[1].commandFingerprint).toBe(calls[0].commandFingerprint);
  expect(calls[2].idempotencyKey).toBe(calls[0].idempotencyKey);
  expect(calls[2].commandFingerprint).not.toBe(calls[0].commandFingerprint);
});

it('accepts the exact JSON byte ceiling and rejects one byte beyond it before database access', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_json_budget',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  installRuntimeMocks();
  const maxBytes = 65536;
  const emptyBytes = Buffer.byteLength(JSON.stringify({ value: '' }), 'utf8');
  const exactValue = 'a'.repeat(maxBytes - emptyBytes);

  await expect(executePathwayCommand(command({
    registry,
    signal: { kind: 'evaluate', payload: { value: exactValue } },
  }))).resolves.toMatchObject({ replayed: false });
  jest.clearAllMocks();
  await expect(executePathwayCommand(command({
    registry,
    signal: { kind: 'evaluate', payload: { value: `${exactValue}a` } },
  }))).rejects.toMatchObject({ code: 'PATHWAY_JSON_LIMIT_EXCEEDED' });
  expect(findReplayMock).not.toHaveBeenCalled();
});

it('rejects a vacuous blocking child fan-out', async () => {
  const registry = registryFor({
    fanout: { stepKinds: ['subworkflow'], resolve: async () => [] },
  });
  runtime = makeRuntime({
    workflow_key: 'synthetic_empty_child',
    steps: [{
      step_key: 'launch_child',
      step_kind: 'subworkflow',
      assigned_role: 'DOCTOR',
      child_rules: [{
        rule_key: 'blocking_child',
        fanout_handler: 'synthetic.child.v1',
        child_pathway_key: 'synthetic_child',
        relationship: 'blocking',
      }],
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  await expect(executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }))).rejects.toMatchObject({ code: 'PATHWAY_BLOCKING_CHILD_REQUIRED' });
  expect(insertRuntimeMock).not.toHaveBeenCalled();
});

it('rejects a system actor sealed by a different registry and an unbranded supplied tx', async () => {
  const registryA = registryFor();
  const registryB = registryFor();
  const actor = createRegisteredWorkflowSystemActor({
    registry: registryA,
    systemKey: 'synthetic.projector.v1',
    sourceEventId: '1',
    signalContext: sealedSignalContext(),
  });
  await expect(executePathwayCommand(command({ registry: registryB, actor }))).rejects.toMatchObject({
    code: 'PATHWAY_SYSTEM_ACTOR_NOT_REGISTERED',
  });
  await expect(executePathwayCommand(command({
    registry: registryA,
    tx: { $queryRawUnsafe: jest.fn() },
  }))).rejects.toMatchObject({ code: 'PATHWAY_RUNTIME_TX_REQUIRED' });
});

it('resolves an omitted command registry from the persisted creation-event pin', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_persisted_registry_command',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  installRuntimeMocks();
  resolveRuntimeRegistryVersionMock.mockResolvedValue(registry.version);

  await expect(executePathwayCommand(command({
    registry: undefined,
  }))).resolves.toMatchObject({ replayed: false, mode: 'shadow' });
  expect(resolveRuntimeRegistryVersionMock).toHaveBeenCalledWith({
    tx: TX,
    tenantId: TENANT,
    pathwayInstanceId: INSTANCE_ID,
  });
  expect(lockRuntimeMock).toHaveBeenCalledTimes(1);
});

it('resolves an omitted registered-evidence registry from the persisted creation-event pin', async () => {
  const registry = registryFor({
    condition: {
      stepKinds: ['task'],
      decisionCodes: ['blocked', 'satisfied'],
      evaluate: async () => ({ decision: 'satisfied', evidence: { verified: true } }),
    },
  });
  installCompletedDomainEvidenceRuntime(registry, 'synthetic_persisted_registry_evidence');
  resolveRuntimeRegistryVersionMock.mockResolvedValue(registry.version);
  completeEvidenceMock.mockResolvedValue(
    completedDomainEvidence({ actor_kind: 'user', actor_uid: ACTOR_UID }),
  );

  await expect(completePathwayTaskAndExecuteFromRegisteredEvidence({
    ...command({
      registry: undefined,
      activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
    }),
    taskId: 701,
    workflowRunId: 77,
    workflowStepId: 100,
    conditionHandler: 'synthetic.condition.v1',
    evidence: { verified: true },
  })).resolves.toMatchObject({ replayed: false, mode: 'active' });
  expect(resolveRuntimeRegistryVersionMock).toHaveBeenCalledWith({
    tx: TX,
    tenantId: TENANT,
    pathwayInstanceId: INSTANCE_ID,
  });
  expect(completeEvidenceMock).toHaveBeenCalledTimes(1);
});

it('fails closed when an omitted command registry has an unknown persisted version', async () => {
  resolveRuntimeRegistryVersionMock.mockResolvedValue(999_999);

  await expect(executePathwayCommand(command({
    registry: undefined,
  }))).rejects.toMatchObject({
    code: 'PATHWAY_RUNTIME_REGISTRY_PIN_UNKNOWN',
  });
  expect(findReplayMock).not.toHaveBeenCalled();
  expect(lockRuntimeMock).not.toHaveBeenCalled();
});

it('resolves an omitted start registry from the governed definition checksum', async () => {
  const registry = registryFor();
  const definition = makeDefinition({
    workflow_key: 'synthetic_registry_resolved_start',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'NURSING_STAFF',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  loadDefinitionMock.mockResolvedValue(definition);
  insertRuntimeMock.mockResolvedValue({
    instance: {
      id: INSTANCE_ID,
      patient_uid: PATIENT,
      workflow_run_id: 77,
      pathway_key: definition.workflow_key,
      clinical_status: 'planned',
    },
    run: { id: 77, status: 'started' },
    steps: [],
  });
  appendEventMock.mockResolvedValue({
    event: { id: 'registry-resolved-start-event' },
    replayed: false,
  });

  await expect(startCarePathwayInstance({
    tenantId: TENANT,
    workflowDefinitionId: definition.id,
    patientUid: PATIENT,
    pathwayKey: definition.workflow_key,
    sourceEpisodeType: 'patient',
    sourceEpisodeId: PATIENT,
    triggerKind: 'manual',
    idempotencyKey: 'registry_resolved_start_1',
    actor: userActor(),
    tx: TX,
  })).resolves.toMatchObject({ replayed: false, mode: 'shadow' });
  expect(loadDefinitionMock).toHaveBeenCalledTimes(2);
  expect(appendEventMock).toHaveBeenCalledWith(expect.objectContaining({
    registry,
    metadata: expect.objectContaining({
      pathway_runtime: expect.objectContaining({
        registry_version: registry.version,
        definition_checksum: definition.definition_checksum,
      }),
    }),
  }));
});

it('rejects user-selected command lineage while permitting sealed system lineage', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_lineage',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  installRuntimeMocks();

  await expect(executePathwayCommand(command({
    registry,
    signal: {
      kind: 'evaluate',
      source_resource_type: 'event_outbox',
      source_resource_id: '91',
    },
  }))).rejects.toMatchObject({ code: 'PATHWAY_USER_SOURCE_LINEAGE_FORBIDDEN' });
  expect(findReplayMock).not.toHaveBeenCalled();

  const systemActor = createRegisteredWorkflowSystemActor({
    registry,
    systemKey: 'synthetic.projector.v1',
    sourceEventId: '91',
    signalContext: sealedSignalContext(),
  });
  await expect(executePathwayCommand(command({
    registry,
    actor: systemActor,
    signal: {
      kind: 'evaluate',
      source_resource_type: 'spoofed_resource',
      source_resource_id: 'spoofed-id',
    },
  }))).rejects.toMatchObject({ code: 'PATHWAY_SYSTEM_SIGNAL_CONTEXT_SPOOFED' });
  expect(findReplayMock).not.toHaveBeenCalled();
  await executePathwayCommand(command({
    registry,
    actor: systemActor,
    signal: { kind: 'evaluate' },
  }));
  expect(appendEventMock).toHaveBeenCalledWith(expect.objectContaining({
    sourceResourceType: 'event_outbox',
    sourceResourceId: '91',
  }));
});

it('keeps system start episode identity independent from sealed event lineage', async () => {
  const registry = registryFor();
  const definition = makeDefinition({
    workflow_key: 'synthetic_system_start',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  const actor = createRegisteredWorkflowSystemActor({
    registry,
    systemKey: 'synthetic.projector.v1',
    sourceEventId: '501',
    causationId: 'outbox:501',
    signalContext: sealedSignalContext({
      sourceResourceType: 'diagnostic_report',
      sourceResourceId: 'result-77',
      occurredAt: '2026-07-19T12:30:00+05:30',
    }),
  });
  const base = {
    tenantId: TENANT,
    workflowDefinitionId: definition.id,
    patientUid: PATIENT,
    pathwayKey: 'synthetic_system_start',
    sourceEpisodeType: 'investigation_order',
    sourceEpisodeId: 'order-44',
    accountableRole: 'DOCTOR',
    triggerKind: 'event',
    idempotencyKey: 'system_start_501',
    actor,
    registry,
  };
  await expect(startCarePathwayInstance({
    ...base,
    triggerKind: 'manual',
  })).rejects.toMatchObject({ code: 'PATHWAY_SYSTEM_START_TRIGGER_INVALID' });
  await expect(startCarePathwayInstance({
    ...base,
    triggerPayload: { source_resource_id: 'spoofed-result' },
  })).rejects.toMatchObject({ code: 'PATHWAY_SYSTEM_SIGNAL_CONTEXT_SPOOFED' });
  await expect(startCarePathwayInstance({
    ...base,
    actor: { ...actor },
  })).rejects.toMatchObject({ code: 'PATHWAY_SYSTEM_ACTOR_NOT_REGISTERED' });
  expect(acquireStartLocksMock).not.toHaveBeenCalled();

  loadDefinitionMock.mockResolvedValue(definition);
  insertRuntimeMock.mockResolvedValue({
    instance: {
      id: INSTANCE_ID,
      patient_uid: PATIENT,
      workflow_run_id: 77,
      pathway_key: 'synthetic_system_start',
      clinical_status: 'planned',
    },
    run: { id: 77, status: 'started' },
    steps: [],
  });
  appendEventMock.mockResolvedValue({ event: { id: 'system-start-event' }, replayed: false });
  await startCarePathwayInstance(base);

  expect(insertRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
    sourceEpisodeType: 'investigation_order',
    sourceEpisodeId: 'order-44',
  }));
  expect(appendEventMock).toHaveBeenCalledWith(expect.objectContaining({
    sourceResourceType: 'diagnostic_report',
    sourceResourceId: 'result-77',
    occurredAt: '2026-07-19T07:00:00.000Z',
  }));
});

it.each(INVALID_NAMED_OWNER_INPUTS)(
  'rejects a supplied %s named owner before registered-system start fallback',
  async (_label, owningClinicianUid) => {
    const registry = registryFor();
    const actor = createRegisteredWorkflowSystemActor({
      registry,
      systemKey: 'synthetic.projector.v1',
      sourceEventId: '502',
      causationId: 'outbox:502',
      signalContext: sealedSignalContext(),
    });

    await expect(startCarePathwayInstance({
      tenantId: TENANT,
      workflowDefinitionId: 11,
      patientUid: PATIENT,
      pathwayKey: 'synthetic_invalid_system_owner',
      sourceEpisodeType: 'investigation_order',
      sourceEpisodeId: 'order-45',
      owningClinicianUid,
      accountableRole: 'NURSING_STAFF',
      triggerKind: 'event',
      idempotencyKey: 'system_invalid_owner_1',
      actor,
      registry,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PATHWAY_NAMED_OWNER_UNAVAILABLE',
    });
    expect(acquireStartLocksMock).not.toHaveBeenCalled();
    expect(assertPatientContextMock).not.toHaveBeenCalled();
  },
);

it('enforces canonical user start source and rejects unregistered parent links', async () => {
  const registry = registryFor();
  const base = {
    tenantId: TENANT,
    workflowDefinitionId: 11,
    patientUid: PATIENT,
    pathwayKey: 'synthetic_start_context',
    sourceEpisodeType: 'patient',
    sourceEpisodeId: PATIENT,
    accountableRole: 'NURSING_STAFF',
    idempotencyKey: 'start_context_1',
    actor: userActor(),
    registry,
  };
  await expect(startCarePathwayInstance({
    ...base,
    sourceEpisodeType: 'investigation_order',
    sourceEpisodeId: '44',
  })).rejects.toMatchObject({ code: 'PATHWAY_SOURCE_CONTEXT_MISMATCH' });
  await expect(startCarePathwayInstance({
    ...base,
    parentInstanceId: INSTANCE_ID,
  })).rejects.toMatchObject({ code: 'PATHWAY_PARENT_LINK_NOT_REGISTERED' });
  await expect(startCarePathwayInstance({
    ...base,
    owningClinicianUid: '77777777-7777-4777-8777-777777777777',
  })).rejects.toMatchObject({ code: 'PATHWAY_MANUAL_OWNER_FORBIDDEN' });
  await expect(startCarePathwayInstance({
    ...base,
    owningTeamId: 42,
  })).rejects.toMatchObject({ code: 'PATHWAY_MANUAL_TEAM_FORBIDDEN' });
  await expect(startCarePathwayInstance({
    ...base,
    accountableRole: 'DOCTOR',
  })).rejects.toMatchObject({ code: 'PATHWAY_MANUAL_ACCOUNTABLE_ROLE_FORBIDDEN' });
  expect(acquireStartLocksMock).not.toHaveBeenCalled();
  expect(findInstanceByKeyMock).not.toHaveBeenCalled();
});

it.each(INVALID_NAMED_OWNER_INPUTS)(
  'rejects a supplied %s named owner before manual caller ownership fallback',
  async (_label, owningClinicianUid) => {
    const registry = registryFor();
    await expect(startCarePathwayInstance({
      tenantId: TENANT,
      workflowDefinitionId: 11,
      patientUid: PATIENT,
      pathwayKey: 'synthetic_invalid_manual_owner',
      sourceEpisodeType: 'patient',
      sourceEpisodeId: PATIENT,
      owningClinicianUid,
      accountableRole: 'NURSING_STAFF',
      idempotencyKey: 'manual_invalid_owner_1',
      actor: userActor(),
      registry,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'PATHWAY_NAMED_OWNER_UNAVAILABLE',
    });
    expect(acquireStartLocksMock).not.toHaveBeenCalled();
    expect(assertPatientContextMock).not.toHaveBeenCalled();
  },
);

it.each([
  ['explicit null', null],
  ['route-shaped omitted undefined', undefined],
])('derives manual ownership for %s from authenticated user context', async (_label, ownerInput) => {
  const registry = registryFor();
  const definition = makeDefinition({
    workflow_key: 'synthetic_derived_manual_owner',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'NURSING_STAFF',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  loadDefinitionMock.mockResolvedValue(definition);
  insertRuntimeMock.mockResolvedValue({
    instance: {
      id: INSTANCE_ID,
      patient_uid: PATIENT,
      workflow_run_id: 77,
      pathway_key: 'synthetic_derived_manual_owner',
      clinical_status: 'planned',
    },
    run: { id: 77, status: 'started' },
    steps: [],
  });
  appendEventMock.mockResolvedValue({ event: { id: 'start-event' }, replayed: false });

  await startCarePathwayInstance({
    tenantId: TENANT,
    workflowDefinitionId: definition.id,
    patientUid: PATIENT,
    pathwayKey: 'synthetic_derived_manual_owner',
    sourceEpisodeType: 'patient',
    sourceEpisodeId: PATIENT,
    owningClinicianUid: ownerInput,
    idempotencyKey: 'derived_manual_owner_1',
    actor: userActor(),
    registry,
  });
  expect(assertPatientContextMock).toHaveBeenCalledWith(expect.objectContaining({
    owningClinicianUid: ACTOR_UID,
  }));
  expect(insertRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
    owningClinicianUid: ACTOR_UID,
    owningTeamId: null,
    accountableRole: 'NURSING_STAFF',
  }));
});

it('does not let a condition exception abandon active human work', async () => {
  const evaluate = jest.fn(async () => ({ decision: 'abnormal', evidence: { reason: 'changed' } }));
  const registry = registryFor({
    condition: {
      stepKinds: ['task'],
      decisionCodes: ['blocked', 'satisfied', 'abnormal'],
      evaluate,
    },
  });
  runtime = makeRuntime({
    workflow_key: 'synthetic_human_exception',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.condition.v1',
      exception_transitions: [{ decision_code: 'abnormal', target_step_key: 'follow_up' }],
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }, {
      step_key: 'follow_up',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry, { status: 'running' });
  runtime.tasks.push({
    id: 701,
    workflow_run_id: 77,
    workflow_step_id: 100,
    status: 'open',
    assigned_to_role: 'DOCTOR',
  });
  installRuntimeMocks();

  await expect(executePathwayCommand(command({ registry }))).rejects.toMatchObject({
    code: 'PATHWAY_HUMAN_WORK_STILL_ACTIVE',
  });
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(transitionRunMock).not.toHaveBeenCalled();
  expect(appendEventMock).not.toHaveBeenCalled();
});

it('keeps satisfied domain evidence task-first until the persisted task is completed', async () => {
  const evaluate = jest.fn(async () => ({
    decision: 'satisfied',
    evidence: { kind: 'verified_result', resource_type: 'lab_result', resource_id: '42' },
  }));
  const registry = registryFor({
    condition: {
      stepKinds: ['task'],
      decisionCodes: ['blocked', 'satisfied'],
      evaluate,
    },
  });
  runtime = makeRuntime({
    workflow_key: 'synthetic_domain_task_first',
    steps: [{
      step_key: 'verify_result',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.condition.v1',
      work_semantics: {
        task_kind: 'verification',
        priority: 'high',
        sla_completion_semantics: 'domain_evidence',
        sla_rule_code: 'synthetic_domain_evidence',
      },
    }],
  }, registry, { status: 'running' });
  runtime.tasks.push({
    id: 701,
    workflow_run_id: 77,
    workflow_step_id: 100,
    workflow_sla_instance_id: '99999999-9999-4999-8999-999999999999',
    sla_completion_semantics: 'domain_evidence',
    status: 'open',
    assigned_to_role: 'DOCTOR',
  });
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');

  await executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }));
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(transitionStepMock).not.toHaveBeenCalled();
  expect(closeInstanceMock).not.toHaveBeenCalled();
  expect(appendEventMock).toHaveBeenCalledWith(expect.objectContaining({
    transitionKey: 'task_waiting',
    workflowStepId: 100,
  }));
});

it('advances a domain-evidence task only after persisted completion and fresh satisfied evidence', async () => {
  let decision = 'satisfied';
  const evaluate = jest.fn(async () => ({
    decision,
    evidence: { kind: 'verified_result', resource_type: 'lab_result', resource_id: '42' },
  }));
  const registry = registryFor({
    condition: {
      stepKinds: ['task'],
      decisionCodes: ['blocked', 'satisfied'],
      evaluate,
    },
  });
  const rawDefinition = {
    workflow_key: 'synthetic_domain_reverify',
    steps: [{
      step_key: 'verify_result',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.condition.v1',
      work_semantics: {
        task_kind: 'verification',
        priority: 'high',
        sla_completion_semantics: 'domain_evidence',
        sla_rule_code: 'synthetic_domain_evidence',
      },
    }],
  };
  runtime = makeRuntime(rawDefinition, registry, { status: 'running' });
  runtime.tasks.push({
    id: 701,
    workflow_run_id: 77,
    workflow_step_id: 100,
    workflow_sla_instance_id: '99999999-9999-4999-8999-999999999999',
    sla_completion_semantics: 'domain_evidence',
    status: 'completed',
    assigned_to_role: 'DOCTOR',
  });
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');

  decision = 'blocked';
  await executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }));
  expect(closeInstanceMock).not.toHaveBeenCalled();
  expect(appendEventMock).toHaveBeenCalledWith(expect.objectContaining({
    transitionKey: 'domain_evidence_waiting',
  }));

  jest.clearAllMocks();
  runtime = makeRuntime(rawDefinition, registry, { status: 'running' });
  runtime.tasks.push({
    id: 701,
    workflow_run_id: 77,
    workflow_step_id: 100,
    workflow_sla_instance_id: '99999999-9999-4999-8999-999999999999',
    sla_completion_semantics: 'domain_evidence',
    status: 'completed',
    assigned_to_role: 'DOCTOR',
  });
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  decision = 'satisfied';
  await executePathwayCommand(command({
    registry,
    idempotencyKey: 'domain_reverify_satisfied',
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }));
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(closeInstanceMock).toHaveBeenCalledTimes(1);
});

it('evaluates an initial condition before effects and skips a rejected action branch', async () => {
  const evaluate = jest.fn(async () => ({ decision: 'abnormal', evidence: { class: 'abnormal' } }));
  const execute = jest.fn(async () => ({ unsafe: true }));
  const registry = registryFor({
    condition: {
      stepKinds: ['automation'],
      decisionCodes: ['blocked', 'satisfied', 'abnormal'],
      evaluate,
    },
    action: { stepKinds: ['automation'], execute },
  });
  runtime = makeRuntime({
    workflow_key: 'synthetic_conditioned_action',
    steps: [{
      step_key: 'classify',
      step_kind: 'automation',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.condition.v1',
      action_handler: 'synthetic.action.v1',
      exception_transitions: [{ decision_code: 'abnormal', target_step_key: 'manual_review' }],
    }, {
      step_key: 'manual_review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'high', sla_completion_semantics: 'none' },
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');

  await executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }));
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
  expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({ workflowStepId: 101 }));
});

it('CAS-skips every intervening step before activating a forward-exception target', async () => {
  const evaluate = jest.fn(async () => ({ decision: 'abnormal', evidence: { class: 'abnormal' } }));
  const execute = jest.fn(async () => ({ unsafe: true }));
  const registry = registryFor({
    condition: {
      stepKinds: ['automation'],
      decisionCodes: ['blocked', 'satisfied', 'abnormal'],
      evaluate,
    },
    action: { stepKinds: ['automation'], execute },
  });
  runtime = makeRuntime({
    workflow_key: 'synthetic_long_forward_exception',
    steps: [{
      step_key: 'classify',
      step_kind: 'automation',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.condition.v1',
      action_handler: 'synthetic.action.v1',
      exception_transitions: [{ decision_code: 'abnormal', target_step_key: 'abnormal_review' }],
    }, {
      step_key: 'normal_review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }, {
      step_key: 'normal_approval',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }, {
      step_key: 'abnormal_review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'high', sla_completion_semantics: 'none' },
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');

  await executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }));
  const skipCalls = transitionStepMock.mock.calls
    .map(([input]) => input)
    .filter((input) => input.nextStatus === 'skipped');
  expect(skipCalls).toEqual([
    expect.objectContaining({ stepId: 101, outcome: 'forward_exception_bypassed' }),
    expect.objectContaining({ stepId: 102, outcome: 'forward_exception_bypassed' }),
  ]);
  expect(runtime.steps.map((step) => step.status)).toEqual([
    'completed', 'skipped', 'skipped', 'in_progress',
  ]);
  for (const workflowStepId of [101, 102]) {
    expect(appendEventMock).toHaveBeenCalledWith(expect.objectContaining({
      transitionKey: 'step_skipped',
      workflowStepId,
    }));
  }
  expect(execute).not.toHaveBeenCalled();
  expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({ workflowStepId: 103 }));
});

it('continues from a satisfied wait into destination task materialization', async () => {
  const evaluate = jest.fn(async () => ({ decision: 'satisfied', evidence: { ready: true } }));
  const registry = registryFor({
    condition: {
      stepKinds: ['wait'],
      decisionCodes: ['blocked', 'satisfied'],
      evaluate,
    },
  });
  runtime = makeRuntime({
    workflow_key: 'synthetic_wait_to_task',
    steps: [{
      step_key: 'wait_for_ready',
      step_kind: 'wait',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.condition.v1',
    }, {
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');

  await executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }));
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({ workflowStepId: 101 }));
});

it('continues from a completed task into task-first approval materialization', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_task_to_approval',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }, {
      step_key: 'approve',
      step_kind: 'approval',
      assigned_role: 'DOCTOR',
      work_semantics: {
        approval_kind: 'synthetic_gate',
        required_approvers: 1,
        required_role: 'DOCTOR',
        task_kind: 'review',
        priority: 'normal',
        sla_completion_semantics: 'none',
      },
    }],
  }, registry, { status: 'running' });
  runtime.tasks.push({
    id: 701,
    workflow_run_id: 77,
    workflow_step_id: 100,
    status: 'completed',
    assigned_to_role: 'DOCTOR',
  });
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');

  await executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }));
  expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({ workflowStepId: 101 }));
  expect(createApprovalMock).toHaveBeenCalledWith(expect.objectContaining({ workflowStepId: 101 }));
});

it('rejects ownership transfer until destination acceptance evidence exists', () => {
  const fanout = jest.fn(async () => []);
  const registry = registryFor({ fanout: { stepKinds: ['subworkflow'], resolve: fanout } });
  expect(() => makeRuntime({
    workflow_key: 'synthetic_ownership_transfer',
    steps: [{
      step_key: 'transfer',
      step_kind: 'subworkflow',
      assigned_role: 'DOCTOR',
      child_rules: [{
        rule_key: 'destination',
        fanout_handler: 'synthetic.child.v1',
        child_pathway_key: 'synthetic_child',
        relationship: 'ownership_transferring',
      }],
    }],
  }, registry)).toThrow(/unavailable until destination acceptance/);
  expect(fanout).not.toHaveBeenCalled();
});

it('requires a concrete owner for a non-blocking named-owner child', async () => {
  const fanout = jest.fn(async () => [{
    workflowDefinitionId: 22,
    pathwayKey: 'synthetic_child',
    sourceEpisodeType: 'synthetic_child_episode',
    sourceEpisodeId: 'child-episode-1',
    accountableRole: 'DOCTOR',
  }]);
  const registry = registryFor({ fanout: { stepKinds: ['subworkflow'], resolve: fanout } });
  runtime = makeRuntime({
    workflow_key: 'synthetic_named_owner',
    steps: [{
      step_key: 'launch',
      step_kind: 'subworkflow',
      assigned_role: 'DOCTOR',
      child_rules: [{
        rule_key: 'named_child',
        fanout_handler: 'synthetic.child.v1',
        child_pathway_key: 'synthetic_child',
        relationship: 'nonblocking_with_named_owner',
      }],
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');

  await expect(executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }))).rejects.toMatchObject({ code: 'PATHWAY_CHILD_OWNER_REQUIRED' });
  expect(insertRuntimeMock).not.toHaveBeenCalled();
});

it('ignores a failed informational child when the blocking child completed', async () => {
  const fanout = jest.fn(async () => []);
  const registry = registryFor({ fanout: { stepKinds: ['subworkflow'], resolve: fanout } });
  runtime = makeRuntime({
    workflow_key: 'synthetic_mixed_children',
    steps: [{
      step_key: 'children',
      step_kind: 'subworkflow',
      assigned_role: 'DOCTOR',
      child_rules: [{
        rule_key: 'blocking_child',
        fanout_handler: 'synthetic.child.v1',
        child_pathway_key: 'synthetic_child',
        relationship: 'blocking',
      }, {
        rule_key: 'information_only',
        fanout_handler: 'synthetic.child.v1',
        child_pathway_key: 'synthetic_child',
        relationship: 'informational',
      }],
    }],
  }, registry, { status: 'running' });
  runtime.children = [{
    id: CHILD_ID,
    clinical_status: 'completed',
    metadata: { parent_stage_key: 'children', child_rule_key: 'blocking_child' },
  }, {
    id: '77777777-7777-4777-8777-777777777777',
    clinical_status: 'entered_in_error',
    metadata: { parent_stage_key: 'children', child_rule_key: 'information_only' },
  }];
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');

  await executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }));
  expect(fanout).not.toHaveBeenCalled();
  expect(closeInstanceMock).toHaveBeenCalledTimes(1);
  expect(transitionRunMock).not.toHaveBeenCalledWith(expect.objectContaining({ nextStatus: 'blocked' }));
});

it('replays the committed result snapshot rather than a newer mutable bundle', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_replay_snapshot',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  installRuntimeMocks();

  const first = await executePathwayCommand(command({ registry }));
  expect(getInstanceMock).toHaveBeenCalledTimes(1);
  resolveModeMock.mockClear();
  resolveModeMock.mockResolvedValue('off');
  runtime.instance = { ...runtime.instance, clinical_status: 'completed' };
  runtime.run = { ...runtime.run, status: 'completed', current_step_key: null };
  findReplayMock.mockResolvedValueOnce({
    replayed: true,
    events: first.events,
    pathwayInstance: runtime.instance,
  });

  const replayed = await executePathwayCommand(command({ registry }));
  expect(replayed.replayed).toBe(true);
  expect(replayed.instance).toEqual(first.instance);
  expect(replayed.events).toEqual(first.events);
  expect(getInstanceMock).toHaveBeenCalledTimes(1);
  expect(resolveModeMock).not.toHaveBeenCalled();
});

it('rejects a corrupted started graph before any state mutation', async () => {
  const registry = registryFor();
  runtime = makeRuntime({
    workflow_key: 'synthetic_corrupt_graph',
    steps: [{
      step_key: 'review',
      step_kind: 'task',
      assigned_role: 'DOCTOR',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  runtime.steps[0].status = 'completed';
  installRuntimeMocks();

  await expect(executePathwayCommand(command({ registry }))).rejects.toMatchObject({
    code: 'PATHWAY_GRAPH_INVALID',
  });
  expect(transitionRunMock).not.toHaveBeenCalled();
});

it('isolates condition evidence loading in a rolled-back savepoint', async () => {
  const loadEvidence = jest.fn(async (context) => {
    expect(context.tx).toBe(TX);
    expect(Object.isFrozen(context.instance)).toBe(true);
    await context.tx.$queryRawUnsafe('UPDATE synthetic_domain_evidence SET seen = TRUE');
    return { observed: 'outer_uncommitted_row' };
  });
  const evaluate = jest.fn(async (context) => {
    expect(context).not.toHaveProperty('tx');
    expect(context.loadedEvidence).toEqual({ observed: 'outer_uncommitted_row' });
    expect(Object.isFrozen(context.loadedEvidence)).toBe(true);
    return { decision: 'satisfied', evidence: context.loadedEvidence };
  });
  const registry = registryFor({
    condition: {
      stepKinds: ['wait'],
      decisionCodes: ['blocked', 'satisfied'],
      loadEvidence,
      evaluate,
    },
  });
  runtime = makeRuntime({
    workflow_key: 'synthetic_loaded_evidence',
    steps: [{
      step_key: 'wait',
      step_kind: 'wait',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.condition.v1',
    }],
  }, registry, { status: 'running' });
  installRuntimeMocks();

  await executePathwayCommand(command({ registry }));
  expect(loadEvidence).toHaveBeenCalledTimes(1);
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(TX.$executeRawUnsafe.mock.calls.map(([sql]) => sql)).toEqual([
    'SAVEPOINT care_pathway_condition_evidence',
    'ROLLBACK TO SAVEPOINT care_pathway_condition_evidence',
    'RELEASE SAVEPOINT care_pathway_condition_evidence',
  ]);
});

it('evaluates a blocked condition before action materialization', async () => {
  const evaluate = jest.fn(async () => ({ decision: 'blocked', evidence: { ready: false } }));
  const execute = jest.fn(async () => ({ unsafe: true }));
  const registry = registryFor({
    condition: {
      stepKinds: ['automation'],
      decisionCodes: ['blocked', 'satisfied'],
      evaluate,
    },
    action: { stepKinds: ['automation'], execute },
  });
  runtime = makeRuntime({
    workflow_key: 'synthetic_blocked_action',
    steps: [{
      step_key: 'act',
      step_kind: 'automation',
      assigned_role: 'DOCTOR',
      condition_handler: 'synthetic.condition.v1',
      action_handler: 'synthetic.action.v1',
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');

  await executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }));
  expect(evaluate).toHaveBeenCalledTimes(1);
  expect(execute).not.toHaveBeenCalled();
  expect(createTaskMock).not.toHaveBeenCalled();
  expect(transitionRunMock).toHaveBeenCalledWith(expect.objectContaining({ nextStatus: 'blocked' }));
});

it('prevalidates fan-out bounds before starting any child', async () => {
  const fanout = jest.fn(async () => Array.from({ length: 33 }, (_unused, index) => ({
    workflowDefinitionId: 22,
    pathwayKey: 'synthetic_child',
    sourceEpisodeType: 'synthetic_child_episode',
    sourceEpisodeId: `child-${index}`,
    accountableRole: 'DOCTOR',
  })));
  const registry = registryFor({ fanout: { stepKinds: ['subworkflow'], resolve: fanout } });
  runtime = makeRuntime({
    workflow_key: 'synthetic_fanout_cap',
    steps: [{
      step_key: 'children',
      step_kind: 'subworkflow',
      assigned_role: 'DOCTOR',
      child_rules: [{
        rule_key: 'bounded_children',
        fanout_handler: 'synthetic.child.v1',
        child_pathway_key: 'synthetic_child',
        relationship: 'informational',
      }],
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');

  await expect(executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }))).rejects.toMatchObject({ code: 'PATHWAY_CHILD_FANOUT_LIMIT_EXCEEDED' });
  expect(insertRuntimeMock).not.toHaveBeenCalled();
  expect(appendEventMock).not.toHaveBeenCalled();
});

it('runs a long deterministic automation chain without recursive stack growth', async () => {
  const execute = jest.fn(async () => ({ recorded: true }));
  const registry = registryFor({ action: { stepKinds: ['automation'], execute } });
  runtime = makeRuntime({
    workflow_key: 'synthetic_long_automation',
    steps: Array.from({ length: 100 }, (_unused, index) => ({
      step_key: `action_${index}`,
      step_kind: 'automation',
      assigned_role: 'DOCTOR',
      action_handler: 'synthetic.action.v1',
    })),
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');

  await executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }));
  expect(execute).toHaveBeenCalledTimes(100);
  expect(closeInstanceMock).toHaveBeenCalledTimes(1);
  expect(appendEventMock.mock.calls.length).toBeLessThanOrEqual(512);
});

it('lets a registered child fan-out inherit parent authorization for a different owner', async () => {
  const OTHER_OWNER = '88888888-8888-4888-8888-888888888888';
  const fanout = jest.fn(async () => [{
    workflowDefinitionId: 22,
    pathwayKey: 'synthetic_child',
    sourceEpisodeType: 'synthetic_child_episode',
    sourceEpisodeId: 'child-owned-elsewhere',
    owningClinicianUid: OTHER_OWNER,
    accountableRole: 'CONSULTANT',
  }]);
  const registry = registryFor({ fanout: { stepKinds: ['subworkflow'], resolve: fanout } });
  runtime = makeRuntime({
    workflow_key: 'synthetic_authorized_child',
    steps: [{
      step_key: 'launch',
      step_kind: 'subworkflow',
      assigned_role: 'NURSING_STAFF',
      child_rules: [{
        rule_key: 'named_child',
        fanout_handler: 'synthetic.child.v1',
        child_pathway_key: 'synthetic_child',
        relationship: 'nonblocking_with_named_owner',
      }],
    }],
  }, registry);
  childDefinition = makeDefinition({
    workflow_key: 'synthetic_child',
    steps: [{
      step_key: 'child_review',
      step_kind: 'task',
      assigned_role: 'CONSULTANT',
      work_semantics: { task_kind: 'review', priority: 'normal', sla_completion_semantics: 'none' },
    }],
  }, registry);
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  loadDefinitionMock.mockResolvedValue(childDefinition);
  insertRuntimeMock.mockResolvedValue({
    instance: {
      id: CHILD_ID,
      patient_uid: PATIENT,
      pathway_key: 'synthetic_child',
      clinical_status: 'planned',
      metadata: { parent_stage_key: 'launch', child_rule_key: 'named_child' },
    },
    run: { id: 88, status: 'started' },
    steps: [],
  });
  const actor = {
    kind: 'user',
    uid: ACTOR_UID,
    roles: ['NURSING_STAFF'],
    primaryRole: 'NURSING_STAFF',
    rawRole: 'NURSING_STAFF',
    authorizationMode: 'authenticated_pathway_route',
  };

  await executePathwayCommand(command({
    registry,
    actor,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }));
  expect(insertRuntimeMock).toHaveBeenCalledWith(expect.objectContaining({
    owningClinicianUid: OTHER_OWNER,
    accountableRole: 'CONSULTANT',
  }));
});

it.each(INVALID_NAMED_OWNER_INPUTS)(
  'rejects a supplied %s named owner before trusted-child ownership fallback',
  async (_label, owningClinicianUid) => {
    const fanout = jest.fn(async () => [{
      workflowDefinitionId: 22,
      pathwayKey: 'synthetic_child',
      sourceEpisodeType: 'synthetic_child_episode',
      sourceEpisodeId: 'child-invalid-owner',
      owningClinicianUid,
      accountableRole: 'NURSING_STAFF',
    }]);
    const registry = registryFor({ fanout: { stepKinds: ['subworkflow'], resolve: fanout } });
    runtime = makeRuntime({
      workflow_key: 'synthetic_invalid_child_owner',
      steps: [{
        step_key: 'launch',
        step_kind: 'subworkflow',
        assigned_role: 'NURSING_STAFF',
        child_rules: [{
          rule_key: 'invalid_named_child',
          fanout_handler: 'synthetic.child.v1',
          child_pathway_key: 'synthetic_child',
          relationship: 'informational',
        }],
      }],
    }, registry);
    installRuntimeMocks();
    resolveModeMock.mockResolvedValue('active');

    await expect(executePathwayCommand(command({
      registry,
      activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
    }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'PATHWAY_NAMED_OWNER_UNAVAILABLE',
    });
    expect(fanout).toHaveBeenCalledTimes(1);
    expect(acquireStartLocksMock).not.toHaveBeenCalled();
    expect(insertRuntimeMock).not.toHaveBeenCalled();
  },
);

it('allows exactly 512 compiled child workflow steps in one sealed parent command budget', async () => {
  const childInputs = [21, 22, 23, 24].map((workflowDefinitionId, index) => ({
    workflowDefinitionId,
    pathwayKey: 'synthetic_child',
    sourceEpisodeType: 'synthetic_child_episode',
    sourceEpisodeId: `child-budget-${index}`,
    accountableRole: 'DOCTOR',
  }));
  const fanout = jest.fn(async () => childInputs);
  const registry = registryFor({ fanout: { stepKinds: ['subworkflow'], resolve: fanout } });
  runtime = makeRuntime({
    workflow_key: 'synthetic_child_step_budget_exact',
    steps: [{
      step_key: 'dispatch',
      step_kind: 'subworkflow',
      assigned_role: 'DOCTOR',
      child_rules: [{
        rule_key: 'budgeted_children',
        fanout_handler: 'synthetic.child.v1',
        child_pathway_key: 'synthetic_child',
        relationship: 'informational',
      }],
    }],
  }, registry);
  const definitions = new Map(childInputs.map(({ workflowDefinitionId }) => [
    workflowDefinitionId,
    makeChildDefinition(registry, { id: workflowDefinitionId, stepCount: 128 }),
  ]));
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  loadDefinitionMock.mockImplementation(async ({ workflowDefinitionId }) => (
    definitions.get(workflowDefinitionId)
  ));
  insertRuntimeMock.mockImplementation(async (input) => {
    const suffix = String(insertRuntimeMock.mock.calls.length).padStart(12, '0');
    return {
      instance: {
        id: `55555555-5555-4555-8555-${suffix}`,
        tenant_id: TENANT,
        workflow_run_id: 80 + insertRuntimeMock.mock.calls.length,
        patient_uid: PATIENT,
        pathway_key: 'synthetic_child',
        pathway_version: 1,
        clinical_status: 'planned',
        metadata: input.metadata,
      },
      run: { id: 80 + insertRuntimeMock.mock.calls.length, status: 'started' },
      steps: [],
    };
  });

  await expect(executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }))).resolves.toMatchObject({ replayed: false });
  expect(insertRuntimeMock).toHaveBeenCalledTimes(4);
  expect(loadDefinitionMock).toHaveBeenCalledTimes(4);
});

it('rejects the 513th compiled child workflow step before its child insert', async () => {
  const childInputs = [31, 32, 33, 34, 35].map((workflowDefinitionId, index) => ({
    workflowDefinitionId,
    pathwayKey: 'synthetic_child',
    sourceEpisodeType: 'synthetic_child_episode',
    sourceEpisodeId: `child-over-budget-${index}`,
    accountableRole: 'DOCTOR',
  }));
  const fanout = jest.fn(async () => childInputs);
  const registry = registryFor({ fanout: { stepKinds: ['subworkflow'], resolve: fanout } });
  runtime = makeRuntime({
    workflow_key: 'synthetic_child_step_budget_over',
    steps: [{
      step_key: 'dispatch',
      step_kind: 'subworkflow',
      assigned_role: 'DOCTOR',
      child_rules: [{
        rule_key: 'budgeted_children',
        fanout_handler: 'synthetic.child.v1',
        child_pathway_key: 'synthetic_child',
        relationship: 'informational',
      }],
    }],
  }, registry);
  const definitions = new Map(childInputs.map(({ workflowDefinitionId }, index) => [
    workflowDefinitionId,
    makeChildDefinition(registry, {
      id: workflowDefinitionId,
      stepCount: index < 4 ? 128 : 1,
    }),
  ]));
  installRuntimeMocks();
  resolveModeMock.mockResolvedValue('active');
  loadDefinitionMock.mockImplementation(async ({ workflowDefinitionId }) => (
    definitions.get(workflowDefinitionId)
  ));
  insertRuntimeMock.mockImplementation(async (input) => {
    const suffix = String(insertRuntimeMock.mock.calls.length).padStart(12, '0');
    return {
      instance: {
        id: `66666666-6666-4666-8666-${suffix}`,
        tenant_id: TENANT,
        workflow_run_id: 90 + insertRuntimeMock.mock.calls.length,
        patient_uid: PATIENT,
        pathway_key: 'synthetic_child',
        pathway_version: 1,
        clinical_status: 'planned',
        metadata: input.metadata,
      },
      run: { id: 90 + insertRuntimeMock.mock.calls.length, status: 'started' },
      steps: [],
    };
  });

  await expect(executePathwayCommand(command({
    registry,
    activationEvidenceCapability: createPathwayActivationEvidenceCapabilityForTests(),
  }))).rejects.toMatchObject({ code: 'PATHWAY_CHILD_WORKFLOW_STEP_LIMIT_EXCEEDED' });
  expect(loadDefinitionMock).toHaveBeenCalledTimes(5);
  expect(insertRuntimeMock).toHaveBeenCalledTimes(4);
  expect(closeInstanceMock).not.toHaveBeenCalled();
  expect(appendEventMock).not.toHaveBeenCalledWith(expect.objectContaining({
    pathwayInstanceId: INSTANCE_ID,
  }));
});
