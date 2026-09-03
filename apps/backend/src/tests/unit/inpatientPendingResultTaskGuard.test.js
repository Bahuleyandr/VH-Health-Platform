import { jest } from '@jest/globals';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const OWNER_UID = '30000000-0000-4000-8000-000000000001';
const ACTOR_UID = '40000000-0000-4000-8000-000000000001';
const OTHER_UID = '50000000-0000-4000-8000-000000000001';
const HANDOFF_ID = '60000000-0000-4000-8000-000000000001';
const GENERATION_ID = '70000000-0000-4000-8000-000000000001';
const NEXT_GENERATION_ID = '70000000-0000-4000-8000-000000000002';
const OWNER_ACTION_ID = '71000000-0000-4000-8000-000000000001';
const CROSS_SIGN_ACTION_ID = '72000000-0000-4000-8000-000000000001';
const PRIOR_RESOLUTION_ACTION_ID = '73000000-0000-4000-8000-000000000001';
const REARM_SOURCE_ACTION_ID = '74000000-0000-4000-8000-000000000001';
const PRIOR_ASSIGNMENT_ID = '80000000-0000-4000-8000-000000000001';
const ASSIGNMENT_ID = '80000000-0000-4000-8000-000000000002';
const ACCEPTED_HANDOFF_ID = '90000000-0000-4000-8000-000000000001';

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule(
  '../../services/idempotency/idempotencyService.js',
  () => ({
    isValidIdempotencyKey: () => true,
  }),
);
jest.unstable_mockModule('../../services/security/breakGlassService.js', () => ({
  roleCanBreakGlass: () => false,
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: value => value,
}));
jest.unstable_mockModule(
  '../../services/workflow/workflowHumanOwnerService.js',
  () => ({
    isTaskHumanOwnerRole: () => true,
    resolveCurrentHumanActorTx: jest.fn(),
  }),
);

const {
  createPendingResultOwnerActionTaskTx,
  createPendingResultTrackingTaskTx,
  createTask,
  reassignTask,
  reassignPendingResultTasksForAcceptedCoveringHandoffTx,
  settlePendingResultTasksFromDiagnosticActionTx,
  settlePendingResultTasksFromOwnerCrossSignTx,
  supersedePendingResultOwnerActionTaskFromGenerationTx,
  transitionTask,
} = await import('../../services/workflow/taskService.js');

function protectedTask(overrides = {}) {
  return {
    id: 101,
    tenant_id: TENANT_ID,
    workflow_run_id: null,
    workflow_step_id: null,
    parent_task_id: 91,
    task_kind: 'review',
    title: 'Review pending discharge result',
    description: null,
    patient_uid: PATIENT_UID,
    encounter_id: null,
    related_resource_type: 'discharge_pending_result_action',
    related_resource_id: `${HANDOFF_ID}:${GENERATION_ID}`,
    priority: 'normal',
    status: 'open',
    assigned_to_uid: OWNER_UID,
    assigned_to_role: null,
    created_by: ACTOR_UID,
    due_at: null,
    completed_at: null,
    cancelled_at: null,
    cancellation_reason: null,
    sla_definition_id: null,
    sla_breached_at: null,
    workflow_sla_instance_id: null,
    sla_completion_semantics: 'none',
    stage_occurrence_key: null,
    metadata: {
      handoff_id: HANDOFF_ID,
      generation_id: GENERATION_ID,
      relationship_kind: 'child_action',
    },
    ...overrides,
  };
}

function trackingTask(overrides = {}) {
  return protectedTask({
    id: 91,
    parent_task_id: null,
    task_kind: 'follow_up',
    title: 'Track pending discharge result',
    related_resource_type: 'discharge_pending_result_handoff',
    related_resource_id: HANDOFF_ID,
    metadata: {
      handoff_id: HANDOFF_ID,
      relationship_kind: 'child_action',
    },
    ...overrides,
  });
}

function coveringTransferTask(overrides = {}) {
  return protectedTask({
    id: 92,
    parent_task_id: null,
    task_kind: 'pathway_owner_transfer_review',
    title: 'Review covering-clinician transfer',
    related_resource_type: 'care_handoff_instance',
    related_resource_id: ACCEPTED_HANDOFF_ID,
    metadata: {
      task_contract: 'covering_clinician_transfer_review_v1',
    },
    ...overrides,
  });
}

function opInpatientTransferTask(overrides = {}) {
  return coveringTransferTask({
    id: 93,
    task_kind: 'op_to_inpatient_transfer_review',
    title: 'Review OP-to-inpatient transfer',
    metadata: {
      task_contract: 'op_to_inpatient_transfer_review_v1',
    },
    ...overrides,
  });
}

const protectedContracts = [
  {
    label: 'pending-result owner-action',
    task: protectedTask,
    code: 'INPATIENT_PENDING_RESULT_ACTION_TASK_WORKFLOW_REQUIRED',
  },
  {
    label: 'pending-result tracking',
    task: trackingTask,
    code: 'INPATIENT_PENDING_RESULT_HANDOFF_TASK_WORKFLOW_REQUIRED',
  },
  {
    label: 'covering-transfer review',
    task: coveringTransferTask,
    code: 'COVERING_TRANSFER_TASK_WORKFLOW_REQUIRED',
  },
  {
    label: 'OP-to-inpatient transfer review',
    task: opInpatientTransferTask,
    code: 'OP_INPATIENT_TRANSFER_TASK_WORKFLOW_REQUIRED',
  },
];

describe('pending-result task creation authority', () => {
  test.each([
    {
      label: 'tracking resource',
      input: {
        taskKind: 'follow_up',
        relatedResourceType: 'discharge_pending_result_handoff',
        relatedResourceId: HANDOFF_ID,
      },
      code: 'INPATIENT_PENDING_RESULT_TASK_FACTORY_REQUIRED',
    },
    {
      label: 'owner-action resource',
      input: {
        taskKind: 'review',
        relatedResourceType: 'discharge_pending_result_action',
        relatedResourceId: `${HANDOFF_ID}:${GENERATION_ID}`,
      },
      code: 'INPATIENT_PENDING_RESULT_TASK_FACTORY_REQUIRED',
    },
    {
      label: 'covering-transfer kind',
      input: {
        taskKind: 'pathway_owner_transfer_review',
        relatedResourceType: 'care_handoff_instance',
        relatedResourceId: ACCEPTED_HANDOFF_ID,
      },
      code: 'COVERING_TRANSFER_TASK_FACTORY_REQUIRED',
    },
    {
      label: 'OP-to-inpatient transfer kind',
      input: {
        taskKind: 'op_to_inpatient_transfer_review',
        relatedResourceType: 'care_handoff_instance',
        relatedResourceId: ACCEPTED_HANDOFF_ID,
      },
      code: 'OP_INPATIENT_TRANSFER_TASK_FACTORY_REQUIRED',
    },
    {
      label: 'caller-defined task contract',
      input: {
        taskKind: 'general',
        relatedResourceType: 'care_handoff_instance',
        relatedResourceId: ACCEPTED_HANDOFF_ID,
        metadata: { task_contract: 'covering_clinician_transfer_review_v1' },
      },
      code: 'TASK_CONTRACT_FACTORY_REQUIRED',
    },
  ])('generic creation rejects a protected $label', async ({ input, code }) => {
    const query = jest.fn();

    await expect(createTask({
      tenantId: TENANT_ID,
      title: 'Forged domain-owned task',
      patientUid: PATIENT_UID,
      assignedToUid: OWNER_UID,
      createdBy: ACTOR_UID,
      protectedTaskCreationAuthority: Symbol('forged-domain-authority'),
      tx: { $queryRawUnsafe: query },
      ...input,
    })).rejects.toMatchObject({
      statusCode: 409,
      code,
    });
    expect(query).not.toHaveBeenCalled();
  });

  test('the tx-only tracking factory emits the exact protected task contract', async () => {
    const query = jest.fn(async (sql, ...params) => {
      if (sql.includes('INSERT INTO tasks')) {
        return [trackingTask({
          metadata: JSON.parse(params[20]),
        })];
      }
      throw new Error(`Unexpected factory SQL: ${sql}`);
    });
    const tx = { $queryRawUnsafe: query };

    await expect(createPendingResultTrackingTaskTx({
      tenantId: TENANT_ID,
      handoffId: HANDOFF_ID,
      admissionId: 51,
      patientUid: PATIENT_UID,
      sourceType: 'lab_result',
      sourceId: 'lab-result-1',
      patientSafeLabel: 'Pending potassium result',
      ownerUid: OWNER_UID,
      createdBy: ACTOR_UID,
      tx,
    })).resolves.toMatchObject({
      task_kind: 'follow_up',
      related_resource_type: 'discharge_pending_result_handoff',
      related_resource_id: HANDOFF_ID,
    });
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO tasks'));
    expect(insert).toBeDefined();
    expect(insert[4]).toBeNull();
    expect(insert[5]).toBe('follow_up');
    expect(insert[10]).toBe('discharge_pending_result_handoff');
    expect(insert[11]).toBe(HANDOFF_ID);
    expect(JSON.parse(insert[21])).toMatchObject({
      admission_id: 51,
      source_type: 'lab_result',
      source_id: 'lab-result-1',
      correlation_contract: 'pending_result_tracking_v1',
    });
  });

  test('the tx-only owner-action factory binds a reopened action to its typed predecessor', async () => {
    const query = jest.fn(async (sql, ...params) => {
      if (sql.includes('AS workflow_run_id') && sql.includes('FROM tasks task')) {
        return [{ workflow_run_id: null }];
      }
      if (sql.includes('INSERT INTO tasks')) {
        return [protectedTask({
          related_resource_id: `${HANDOFF_ID}:${GENERATION_ID}:${OWNER_ACTION_ID}`,
          metadata: JSON.parse(params[20]),
        })];
      }
      throw new Error(`Unexpected factory SQL: ${sql}`);
    });
    const tx = { $queryRawUnsafe: query };

    await expect(createPendingResultOwnerActionTaskTx({
      tenantId: TENANT_ID,
      handoffId: HANDOFF_ID,
      generationId: GENERATION_ID,
      admissionId: 51,
      patientUid: PATIENT_UID,
      parentTaskId: 91,
      patientSafeLabel: 'Corrected potassium result',
      sourceType: 'lab_result',
      sourceId: 'lab-result-1',
      ownerUid: OWNER_UID,
      createdBy: ACTOR_UID,
      predecessorOwnerActionId: OWNER_ACTION_ID,
      predecessorResolutionActionId: PRIOR_RESOLUTION_ACTION_ID,
      rearmSourceActionId: REARM_SOURCE_ACTION_ID,
      rearmReason: 'doctor_reopened',
      tx,
    })).resolves.toMatchObject({
      task_kind: 'review',
      parent_task_id: 91,
      related_resource_type: 'discharge_pending_result_action',
      related_resource_id: `${HANDOFF_ID}:${GENERATION_ID}:${OWNER_ACTION_ID}`,
    });
    const insert = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO tasks'));
    expect(insert).toBeDefined();
    expect(insert[4]).toBe(91);
    expect(insert[5]).toBe('review');
    expect(insert[10]).toBe('discharge_pending_result_action');
    expect(insert[11]).toBe(`${HANDOFF_ID}:${GENERATION_ID}:${OWNER_ACTION_ID}`);
    expect(JSON.parse(insert[21])).toMatchObject({
      admission_id: 51,
      handoff_id: HANDOFF_ID,
      generation_id: GENERATION_ID,
      predecessor_generation_id: null,
      predecessor_owner_action_id: OWNER_ACTION_ID,
      predecessor_resolution_action_id: PRIOR_RESOLUTION_ACTION_ID,
      rearm_source_action_id: REARM_SOURCE_ACTION_ID,
      task_contract: 'discharge_pending_result_action_v1',
      correlation_contract: 'pending_result_owner_action_v2',
      rearm_reason: 'doctor_reopened',
    });
  });

  test('the owner-action factory rejects a doctor-reopen without exact lineage receipts', async () => {
    const query = jest.fn();

    await expect(createPendingResultOwnerActionTaskTx({
      tenantId: TENANT_ID,
      handoffId: HANDOFF_ID,
      generationId: GENERATION_ID,
      admissionId: 51,
      patientUid: PATIENT_UID,
      parentTaskId: 91,
      patientSafeLabel: 'Potassium result',
      sourceType: 'lab_result',
      sourceId: 'lab-result-1',
      ownerUid: OWNER_UID,
      createdBy: ACTOR_UID,
      predecessorOwnerActionId: OWNER_ACTION_ID,
      rearmReason: 'doctor_reopened',
      tx: { $queryRawUnsafe: query },
    })).rejects.toMatchObject({
      statusCode: 400,
      code: 'INPATIENT_PENDING_RESULT_TASK_FACTORY_LINEAGE_INVALID',
    });
    expect(query).not.toHaveBeenCalled();
  });
});

describe.each(protectedContracts)('$label task authority', ({
  task: taskFixture,
  code,
}) => {
  test.each([
    ['generic cancellation', (tx, id) => transitionTask({
      tenantId: TENANT_ID,
      id,
      nextStatus: 'cancelled',
      cancellationReason: 'Administrative cancellation',
      actorUid: ACTOR_UID,
      tx,
    })],
    ['generic completion', (tx, id) => transitionTask({
      tenantId: TENANT_ID,
      id,
      nextStatus: 'completed',
      actorUid: ACTOR_UID,
      tx,
    })],
    ['generic reassignment', (tx, id) => reassignTask({
      tenantId: TENANT_ID,
      id,
      assignedToUid: OTHER_UID,
      tx,
    })],
  ])('%s is rejected', async (_label, mutate) => {
    const task = taskFixture();
    const query = jest.fn(async sql => {
      if (sql.includes('SELECT') && sql.includes('FROM tasks')) {
        return [task];
      }
      throw new Error(`Unexpected mutation SQL: ${sql}`);
    });
    const tx = { $queryRawUnsafe: query };

    await expect(mutate(tx, task.id)).rejects.toMatchObject({
      statusCode: 409,
      code,
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
  });

  test('caller-supplied transition authority cannot manufacture access', async () => {
    const task = taskFixture();
    const query = jest.fn(async sql => {
      if (sql.includes('SELECT') && sql.includes('FROM tasks')) {
        return [task];
      }
      throw new Error(`Unexpected mutation SQL: ${sql}`);
    });
    const tx = { $queryRawUnsafe: query };

    await expect(transitionTask({
      tenantId: TENANT_ID,
      id: task.id,
      nextStatus: 'cancelled',
      cancellationReason: 'Forged authority',
      actorUid: ACTOR_UID,
      pendingResultOwnerActionTaskAuthority:
        Symbol('PENDING_RESULT_OWNER_ACTION_TASK_AUTHORITY'),
      pendingResultTrackingTaskAuthority:
        Symbol('PENDING_RESULT_TASK_TRANSFER_AUTHORITY'),
      tx,
    })).rejects.toMatchObject({
      statusCode: 409,
      code,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('caller-supplied reassignment authority cannot manufacture access', async () => {
    const task = taskFixture();
    const query = jest.fn(async sql => {
      if (sql.includes('SELECT') && sql.includes('FROM tasks')) {
        return [task];
      }
      throw new Error(`Unexpected mutation SQL: ${sql}`);
    });
    const tx = { $queryRawUnsafe: query };

    await expect(reassignTask({
      tenantId: TENANT_ID,
      id: task.id,
      assignedToUid: OTHER_UID,
      pendingResultTaskTransferAuthority:
        Symbol('PENDING_RESULT_TASK_TRANSFER_AUTHORITY'),
      tx,
    })).rejects.toMatchObject({
      statusCode: 409,
      code,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

test.each([
  ['generic cancellation', (tx) => transitionTask({
    tenantId: TENANT_ID,
    id: 94,
    nextStatus: 'cancelled',
    cancellationReason: 'Administrative cancellation',
    actorUid: ACTOR_UID,
    executorAuthority: Symbol('forged_pathway_executor_capability'),
    tx,
  })],
  ['generic completion', (tx) => transitionTask({
    tenantId: TENANT_ID,
    id: 94,
    nextStatus: 'completed',
    actorUid: ACTOR_UID,
    executorAuthority: Symbol('forged_pathway_executor_capability'),
    tx,
  })],
  ['generic reassignment', (tx) => reassignTask({
    tenantId: TENANT_ID,
    id: 94,
    assignedToUid: OTHER_UID,
    executorAuthority: Symbol('forged_pathway_executor_capability'),
    tx,
  })],
])('%s cannot mutate the OP recovery workflow task', async (_label, mutate) => {
  const task = protectedTask({
    id: 94,
    workflow_run_id: 7,
    workflow_step_id: 71,
    parent_task_id: null,
    task_kind: 'follow_up',
    title: 'Review unattended outpatient visit',
    related_resource_type: 'care_pathway_instance',
    related_resource_id: HANDOFF_ID,
    metadata: {
      stage_key: 'recover_unattended_visit',
      materialization_kind: 'task',
    },
  });
  const query = jest.fn(async (sql) => {
    if (sql.includes('FROM tasks')) return [task];
    if (sql.includes('FROM care_pathway_instances')) return [{ '?column?': 1 }];
    throw new Error(`Unexpected OP recovery mutation SQL: ${sql}`);
  });
  const tx = { $queryRawUnsafe: query };

  await expect(mutate(tx)).rejects.toMatchObject({
    statusCode: 409,
    code: 'PATHWAY_EXECUTOR_REQUIRED',
  });
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE tasks'))).toBe(false);
});

test('an exact accepted covering handoff reassigns the tracking and current action tasks', async () => {
  const reassignedIds = [];
  const query = jest.fn(async (sql, ...params) => {
    if (sql.includes('SELECT assignment.id')) {
      return [{ id: ASSIGNMENT_ID }];
    }
    if (sql.includes('FROM discharge_pending_result_handoffs AS handoff')) {
      return [{
        ...trackingTask(),
        handoff_id: HANDOFF_ID,
        task_id: 91,
        primary_physician_assignment_id: PRIOR_ASSIGNMENT_ID,
        named_physician_uid: OWNER_UID,
      }];
    }
    if (sql.includes('FROM discharge_pending_result_owner_actions AS action')) {
      return [{
        ...protectedTask(),
        handoff_id: HANDOFF_ID,
        generation_id: GENERATION_ID,
        task_id: 101,
      }];
    }
    if (sql.includes('SELECT') && sql.includes('FROM tasks')) {
      return [Number(params[0]) === 91 ? trackingTask() : protectedTask()];
    }
    if (sql.includes('UPDATE tasks SET')) {
      const taskId = Number(params[2]);
      reassignedIds.push(taskId);
      const task = taskId === 91 ? trackingTask() : protectedTask();
      return [{ ...task, assigned_to_uid: OTHER_UID }];
    }
    throw new Error(`Unexpected mutation SQL: ${sql}`);
  });
  const tx = { $queryRawUnsafe: query };

  await expect(reassignPendingResultTasksForAcceptedCoveringHandoffTx({
    tenantId: TENANT_ID,
    admissionId: 51,
    patientUid: PATIENT_UID,
    priorAssignmentId: PRIOR_ASSIGNMENT_ID,
    assignmentId: ASSIGNMENT_ID,
    acceptedHandoffId: ACCEPTED_HANDOFF_ID,
    priorPhysicianUid: OWNER_UID,
    physicianUid: OTHER_UID,
    actorUid: ACTOR_UID,
    tx,
  })).resolves.toEqual({
    tracking_task_ids: [91],
    action_task_ids: [101],
  });
  expect(reassignedIds).toEqual([91, 101]);
  expect(query.mock.calls.some(([sql]) => (
    sql.includes('assignment.assignment_source =')
    && sql.includes('coverage.status =')
    && sql.includes('pathway.owning_clinician_uid = assignment.physician_uid')
  ))).toBe(true);
});

test('accepted-transfer reassignment fails closed on a terminal current action task', async () => {
  const query = jest.fn(async sql => {
    if (sql.includes('SELECT assignment.id')) {
      return [{ id: ASSIGNMENT_ID }];
    }
    if (sql.includes('FROM discharge_pending_result_handoffs AS handoff')) {
      return [{
        ...trackingTask(),
        handoff_id: HANDOFF_ID,
        task_id: 91,
        primary_physician_assignment_id: PRIOR_ASSIGNMENT_ID,
        named_physician_uid: OWNER_UID,
      }];
    }
    if (sql.includes('FROM discharge_pending_result_owner_actions AS action')) {
      return [{
        ...protectedTask({ status: 'completed' }),
        handoff_id: HANDOFF_ID,
        generation_id: GENERATION_ID,
        task_id: 101,
      }];
    }
    throw new Error(`Unexpected mutation SQL: ${sql}`);
  });
  const tx = { $queryRawUnsafe: query };

  await expect(reassignPendingResultTasksForAcceptedCoveringHandoffTx({
    tenantId: TENANT_ID,
    admissionId: 51,
    patientUid: PATIENT_UID,
    priorAssignmentId: PRIOR_ASSIGNMENT_ID,
    assignmentId: ASSIGNMENT_ID,
    acceptedHandoffId: ACCEPTED_HANDOFF_ID,
    priorPhysicianUid: OWNER_UID,
    physicianUid: OTHER_UID,
    actorUid: ACTOR_UID,
    tx,
  })).rejects.toMatchObject({
    statusCode: 409,
    code: 'INPATIENT_PENDING_RESULT_TASK_REASSIGNMENT_BINDING_INVALID',
  });
  expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE tasks SET'))).toBe(false);
});

function settlementBinding(overrides = {}) {
  return {
    cross_sign_action_id: CROSS_SIGN_ACTION_ID,
    signature_id: '73000000-0000-4000-8000-000000000001',
    canonical_timeline_event_id: '74000000-0000-4000-8000-000000000001',
    canonical_audit_event_id: '75000000-0000-4000-8000-000000000001',
    prior_action_id: '76000000-0000-4000-8000-000000000001',
    prior_action_kind: 'doctor_disposition',
    prior_signature_id: '77000000-0000-4000-8000-000000000001',
    owner_action_id: OWNER_ACTION_ID,
    owner_uid: OWNER_UID,
    predecessor_owner_action_id: null,
    predecessor_generation_id: null,
    handoff_id: HANDOFF_ID,
    admission_id: 51,
    patient_uid: PATIENT_UID,
    named_physician_uid: OWNER_UID,
    tracking_task_id: 91,
    handoff_state: 'resolved',
    resolution_action_id: CROSS_SIGN_ACTION_ID,
    resolved_by_uid: OWNER_UID,
    pathway_instance_id: '78000000-0000-4000-8000-000000000001',
    action_task_id: 101,
    action_task_kind: 'review',
    action_parent_task_id: 91,
    action_patient_uid: PATIENT_UID,
    action_resource_type: 'discharge_pending_result_action',
    action_resource_id: `${HANDOFF_ID}:${GENERATION_ID}`,
    action_assigned_to_uid: OWNER_UID,
    action_assigned_to_role: null,
    action_workflow_run_id: null,
    action_workflow_step_id: null,
    action_sla_id: null,
    action_sla_semantics: 'none',
    action_task_status: 'open',
    tracking_task_kind: 'follow_up',
    tracking_parent_task_id: null,
    tracking_patient_uid: PATIENT_UID,
    tracking_resource_type: 'discharge_pending_result_handoff',
    tracking_resource_id: HANDOFF_ID,
    tracking_assigned_to_uid: OWNER_UID,
    tracking_assigned_to_role: null,
    tracking_workflow_run_id: null,
    tracking_workflow_step_id: null,
    tracking_sla_id: null,
    tracking_sla_semantics: 'none',
    tracking_task_status: 'open',
    ...overrides,
  };
}

function settlementInput(tx) {
  return {
    tenantId: TENANT_ID,
    handoffId: HANDOFF_ID,
    generationId: GENERATION_ID,
    ownerActionId: OWNER_ACTION_ID,
    crossSignActionId: CROSS_SIGN_ACTION_ID,
    actionTaskId: 101,
    trackingTaskId: 91,
    patientUid: PATIENT_UID,
    actorUid: OWNER_UID,
    tx,
  };
}

function diagnosticSettlementBinding(overrides = {}) {
  return {
    action_kind: 'doctor_disposition',
    actor_uid: OWNER_UID,
    signature_id: '73000000-0000-4000-8000-000000000001',
    predecessor_generation_id: null,
    predecessor_owner_action_id: null,
    rearm_source_action_id: null,
    named_physician_uid: OWNER_UID,
    resolved_by_uid: OWNER_UID,
    action_task_id: 101,
    action_task_kind: 'review',
    action_parent_task_id: 91,
    action_patient_uid: PATIENT_UID,
    action_resource_type: 'discharge_pending_result_action',
    action_resource_id: `${HANDOFF_ID}:${GENERATION_ID}`,
    action_assigned_to_uid: OWNER_UID,
    action_assigned_to_role: null,
    action_workflow_run_id: null,
    action_workflow_step_id: null,
    action_sla_id: null,
    action_sla_semantics: 'none',
    action_task_status: 'open',
    tracking_task_id: 91,
    tracking_task_kind: 'follow_up',
    tracking_parent_task_id: null,
    tracking_patient_uid: PATIENT_UID,
    tracking_resource_type: 'discharge_pending_result_handoff',
    tracking_resource_id: HANDOFF_ID,
    tracking_assigned_to_uid: OWNER_UID,
    tracking_assigned_to_role: null,
    tracking_workflow_run_id: null,
    tracking_workflow_step_id: null,
    tracking_sla_id: null,
    tracking_sla_semantics: 'none',
    tracking_task_status: 'open',
    ...overrides,
  };
}

function diagnosticSettlementInput(tx) {
  return {
    tenantId: TENANT_ID,
    handoffId: HANDOFF_ID,
    generationId: GENERATION_ID,
    ownerActionId: OWNER_ACTION_ID,
    diagnosticActionId: CROSS_SIGN_ACTION_ID,
    actionTaskId: 101,
    trackingTaskId: 91,
    patientUid: PATIENT_UID,
    tx,
  };
}

function diagnosticSettlementTx(binding) {
  const transitionedIds = [];
  const query = jest.fn(async (sql, ...params) => {
    if (sql.includes('FROM diagnostic_result_actions AS diagnostic_action')) {
      return binding == null ? [] : [binding];
    }
    if (sql.includes('SELECT') && sql.includes('FROM tasks')) {
      const id = Number(params[0]);
      return [id === 101 ? protectedTask() : trackingTask()];
    }
    if (sql.includes('UPDATE tasks SET')) {
      const id = Number(params[1]);
      transitionedIds.push(id);
      return [{
        ...(id === 101 ? protectedTask() : trackingTask()),
        status: 'completed',
        completed_at: new Date('2026-07-23T12:00:00.000Z'),
      }];
    }
    throw new Error(`Unexpected settlement SQL: ${sql}`);
  });
  return {
    transitionedIds,
    tx: { $queryRawUnsafe: query },
  };
}

test.each([
  {
    label: 'the signed named-owner disposition',
    binding: diagnosticSettlementBinding(),
  },
  {
    label: 'a normal authoritative auto-close',
    binding: diagnosticSettlementBinding({
      action_kind: 'normal_auto_closed',
      actor_uid: null,
      signature_id: null,
      resolved_by_uid: null,
    }),
  },
])('$label atomically settles both pending-result tasks', async ({
  binding,
}) => {
  const { transitionedIds, tx } = diagnosticSettlementTx(binding);

  await expect(settlePendingResultTasksFromDiagnosticActionTx(
    diagnosticSettlementInput(tx),
  )).resolves.toEqual({
    action_task_id: 101,
    tracking_task_id: 91,
    replayed: false,
  });
  expect(transitionedIds).toEqual([101, 91]);
  const transitionUpdates = tx.$queryRawUnsafe.mock.calls.filter(
    ([sql]) => sql.includes('UPDATE tasks SET'),
  );
  expect(transitionUpdates).toHaveLength(2);
  const authorityQuery = tx.$queryRawUnsafe.mock.calls[0][0];
  expect(authorityQuery).toContain(
    "diagnostic_action.action_kind = 'doctor_disposition'",
  );
  expect(authorityQuery).toContain(
    "diagnostic_action.action_kind = 'normal_auto_closed'",
  );
});

test('a different-owner doctor disposition cannot settle named-owner tasks', async () => {
  const { transitionedIds, tx } = diagnosticSettlementTx(null);

  await expect(settlePendingResultTasksFromDiagnosticActionTx(
    diagnosticSettlementInput(tx),
  )).rejects.toMatchObject({
    statusCode: 409,
    code: 'INPATIENT_PENDING_RESULT_TASK_SETTLEMENT_BINDING_INVALID',
  });
  expect(transitionedIds).toEqual([]);
  const authorityQuery = tx.$queryRawUnsafe.mock.calls[0][0];
  expect(authorityQuery).toContain(
    'diagnostic_action.actor_uid = owner_action.owner_uid',
  );
  expect(authorityQuery).toContain(
    'diagnostic_action.actor_uid = handoff.named_physician_uid',
  );
  expect(authorityQuery).toContain(
    'successor.predecessor_owner_action_id = owner_action.id',
  );
  expect(authorityQuery).toContain(
    'successor_generation.predecessor_generation_id',
  );
});

test('diagnostic settlement rejects a partial terminal task pair', async () => {
  const { transitionedIds, tx } = diagnosticSettlementTx(
    diagnosticSettlementBinding({
      action_task_status: 'completed',
      tracking_task_status: 'open',
    }),
  );

  await expect(settlePendingResultTasksFromDiagnosticActionTx(
    diagnosticSettlementInput(tx),
  )).rejects.toMatchObject({
    statusCode: 409,
    code: 'INPATIENT_PENDING_RESULT_TASK_SETTLEMENT_STATE_INVALID',
  });
  expect(transitionedIds).toEqual([]);
});

test('an exact signed named-owner action atomically completes child and tracking tasks', async () => {
  const transitionedIds = [];
  const query = jest.fn(async (sql, ...params) => {
    if (sql.includes('FROM diagnostic_result_actions AS cross_sign')) {
      return [settlementBinding()];
    }
    if (sql.includes('SELECT') && sql.includes('FROM tasks')) {
      const id = Number(params[0]);
      return [id === 101 ? protectedTask() : trackingTask()];
    }
    if (sql.includes('UPDATE tasks SET')) {
      const id = Number(params[1]);
      transitionedIds.push(id);
      return [{
        ...(id === 101 ? protectedTask() : trackingTask()),
        status: 'completed',
        completed_at: new Date('2026-07-23T12:00:00.000Z'),
      }];
    }
    throw new Error(`Unexpected settlement SQL: ${sql}`);
  });
  const tx = { $queryRawUnsafe: query };

  await expect(settlePendingResultTasksFromOwnerCrossSignTx(
    settlementInput(tx),
  )).resolves.toEqual({
    action_task_id: 101,
    tracking_task_id: 91,
    replayed: false,
  });
  expect(transitionedIds).toEqual([101, 91]);
  const authorityQuery = query.mock.calls.find(([sql]) => (
    sql.includes('FROM diagnostic_result_actions AS cross_sign')
  ))?.[0];
  expect(authorityQuery).toContain('owner_action.owner_uid = cross_sign.actor_uid');
  expect(authorityQuery).toContain('cross_sign.actor_uid = $9::uuid');
  expect(authorityQuery).toContain('handoff.resolution_action_id = cross_sign.id');
  expect(authorityQuery).toContain('successor.predecessor_owner_action_id = owner_action.id');
  expect(authorityQuery).toContain('successor_generation.predecessor_generation_id');
});

test('pending-result settlement rejects a partial terminal state without mutating either task', async () => {
  const query = jest.fn(async (sql) => {
    if (sql.includes('FROM diagnostic_result_actions AS cross_sign')) {
      return [settlementBinding({
        action_task_status: 'completed',
        tracking_task_status: 'open',
      })];
    }
    throw new Error(`Unexpected settlement SQL: ${sql}`);
  });
  const tx = { $queryRawUnsafe: query };

  await expect(settlePendingResultTasksFromOwnerCrossSignTx(
    settlementInput(tx),
  )).rejects.toMatchObject({
    statusCode: 409,
    code: 'INPATIENT_PENDING_RESULT_TASK_SETTLEMENT_STATE_INVALID',
  });
  expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE tasks SET'))).toBe(false);
});

test('pending-result settlement fails closed when the exact current lineage is absent', async () => {
  const query = jest.fn(async (sql) => {
    if (sql.includes('FROM diagnostic_result_actions AS cross_sign')) return [];
    throw new Error(`Unexpected settlement SQL: ${sql}`);
  });
  const tx = { $queryRawUnsafe: query };

  await expect(settlePendingResultTasksFromOwnerCrossSignTx(
    settlementInput(tx),
  )).rejects.toMatchObject({
    statusCode: 409,
    code: 'INPATIENT_PENDING_RESULT_TASK_SETTLEMENT_BINDING_INVALID',
  });
  expect(query).toHaveBeenCalledTimes(1);
});

test('an already completed exact settlement replays without reopening task mutation', async () => {
  const query = jest.fn(async (sql) => {
    if (sql.includes('FROM diagnostic_result_actions AS cross_sign')) {
      return [settlementBinding({
        action_task_status: 'completed',
        tracking_task_status: 'completed',
      })];
    }
    throw new Error(`Unexpected settlement SQL: ${sql}`);
  });
  const tx = { $queryRawUnsafe: query };

  await expect(settlePendingResultTasksFromOwnerCrossSignTx(
    settlementInput(tx),
  )).resolves.toEqual({
    action_task_id: 101,
    tracking_task_id: 91,
    replayed: true,
  });
  expect(query).toHaveBeenCalledTimes(1);
});

test('a directly corrected generation can cancel the exact predecessor action', async () => {
  let taskReads = 0;
  const query = jest.fn(async sql => {
    if (sql.includes('SELECT') && sql.includes('FROM tasks')) {
      taskReads += 1;
      return [protectedTask()];
    }
    if (sql.includes('FROM discharge_pending_result_owner_actions AS action')) {
      return [{ id: '80000000-0000-4000-8000-000000000001' }];
    }
    if (sql.includes('UPDATE tasks SET')) {
      return [protectedTask({
        status: 'cancelled',
        cancelled_at: new Date('2026-07-23T10:00:00.000Z'),
        cancellation_reason:
          'Superseded by a corrected diagnostic generation',
      })];
    }
    throw new Error(`Unexpected mutation SQL: ${sql}`);
  });
  const tx = { $queryRawUnsafe: query };

  await expect(supersedePendingResultOwnerActionTaskFromGenerationTx({
    tenantId: TENANT_ID,
    id: 101,
    handoffId: HANDOFF_ID,
    generationId: GENERATION_ID,
    supersedingGenerationId: NEXT_GENERATION_ID,
    patientUid: PATIENT_UID,
    ownerUid: OWNER_UID,
    parentTaskId: 91,
    actorUid: ACTOR_UID,
    tx,
  })).resolves.toMatchObject({
    id: 101,
    status: 'cancelled',
    assigned_to_uid: OWNER_UID,
  });
  expect(taskReads).toBe(2);
  const updateCall = query.mock.calls.find(([sql]) => (
    sql.includes('UPDATE tasks SET')
  ));
  expect(updateCall).toBeDefined();
  expect(updateCall[0]).toContain('AND status =');
  expect(updateCall).toContain(
    'Superseded by a corrected diagnostic generation',
  );
  expect(query.mock.calls.some(([sql]) => (
    sql.includes('successor.predecessor_generation_id = action.generation_id')
    && sql.includes('action_successor.predecessor_owner_action_id = action.id')
    && sql.includes('newer_generation.predecessor_generation_id')
    && sql.includes('handoff.named_physician_uid = $6::uuid')
    && !sql.includes('action.owner_uid = $6::uuid')
  ))).toBe(true);
});

test('the governed correction bridge rejects a mismatched owner binding', async () => {
  const query = jest.fn(async sql => {
    if (sql.includes('SELECT') && sql.includes('FROM tasks')) {
      return [protectedTask({ assigned_to_uid: OTHER_UID })];
    }
    throw new Error(`Unexpected mutation SQL: ${sql}`);
  });
  const tx = { $queryRawUnsafe: query };

  await expect(supersedePendingResultOwnerActionTaskFromGenerationTx({
    tenantId: TENANT_ID,
    id: 101,
    handoffId: HANDOFF_ID,
    generationId: GENERATION_ID,
    supersedingGenerationId: NEXT_GENERATION_ID,
    patientUid: PATIENT_UID,
    ownerUid: OWNER_UID,
    parentTaskId: 91,
    actorUid: ACTOR_UID,
    tx,
  })).rejects.toMatchObject({
    statusCode: 409,
    code: 'INPATIENT_PENDING_RESULT_ACTION_TASK_BINDING_INVALID',
  });
  expect(query).toHaveBeenCalledTimes(1);
});

test('the governed correction bridge rejects a non-current successor binding', async () => {
  const query = jest.fn(async sql => {
    if (sql.includes('SELECT') && sql.includes('FROM tasks')) {
      return [protectedTask()];
    }
    if (sql.includes('FROM discharge_pending_result_owner_actions AS action')) {
      return [];
    }
    throw new Error(`Unexpected mutation SQL: ${sql}`);
  });
  const tx = { $queryRawUnsafe: query };

  await expect(supersedePendingResultOwnerActionTaskFromGenerationTx({
    tenantId: TENANT_ID,
    id: 101,
    handoffId: HANDOFF_ID,
    generationId: GENERATION_ID,
    supersedingGenerationId: NEXT_GENERATION_ID,
    patientUid: PATIENT_UID,
    ownerUid: OWNER_UID,
    parentTaskId: 91,
    actorUid: ACTOR_UID,
    tx,
  })).rejects.toMatchObject({
    statusCode: 409,
    code: 'INPATIENT_PENDING_RESULT_ACTION_TASK_BINDING_INVALID',
  });
  expect(query).toHaveBeenCalledTimes(2);
});
