import { jest } from '@jest/globals';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const ACTOR_UID = '20000000-0000-4000-8000-000000000001';
const OTHER_UID = '30000000-0000-4000-8000-000000000001';
const HANDOFF_ID = '40000000-0000-4000-8000-000000000001';

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
jest.unstable_mockModule(
  '../../services/pathways/pathwayExecutorService.js',
  () => ({
    isPathwayExecutorCapability: () => false,
  }),
);

const {
  createOpInpatientTransferReviewTaskTx,
  createTask,
  reassignTask,
  transitionTask,
} = await import(
  '../../services/workflow/taskService.js'
);

function protectedTask() {
  return {
    id: 91,
    tenant_id: TENANT_ID,
    workflow_run_id: null,
    workflow_step_id: null,
    parent_task_id: null,
    task_kind: 'op_to_inpatient_transfer_review',
    title: 'Review OP-to-inpatient transfer request',
    description: null,
    patient_uid: '50000000-0000-4000-8000-000000000001',
    encounter_id: null,
    related_resource_type: 'care_handoff_instance',
    related_resource_id: HANDOFF_ID,
    priority: 'normal',
    status: 'open',
    assigned_to_uid: ACTOR_UID,
    assigned_to_role: null,
    created_by: OTHER_UID,
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
      task_contract: 'op_to_inpatient_transfer_review_v1',
    },
  };
}

test.each([
  [
    'generic status transition',
    tx => transitionTask({
      tenantId: TENANT_ID,
      id: 91,
      nextStatus: 'completed',
      actorUid: ACTOR_UID,
      tx,
    }),
  ],
  [
    'generic reassignment',
    tx => reassignTask({
      tenantId: TENANT_ID,
      id: 91,
      assignedToUid: OTHER_UID,
      tx,
    }),
  ],
])('%s cannot mutate a typed OP-to-inpatient review task', async (_label, mutate) => {
  const query = jest.fn(async sql => {
    if (sql.includes('SELECT') && sql.includes('FROM tasks')) return [protectedTask()];
    throw new Error(`Unexpected mutation SQL: ${sql}`);
  });
  const tx = { $queryRawUnsafe: query };

  await expect(mutate(tx)).rejects.toMatchObject({
    statusCode: 409,
    code: 'OP_INPATIENT_TRANSFER_TASK_WORKFLOW_REQUIRED',
  });
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
});

test.each([
  [
    'protected task kind',
    {
      taskKind: 'op_to_inpatient_transfer_review',
      metadata: {},
    },
    'OP_INPATIENT_TRANSFER_TASK_FACTORY_REQUIRED',
  ],
  [
    'protected task contract',
    {
      taskKind: 'review',
      metadata: {
        task_contract: 'op_to_inpatient_transfer_review_v1',
      },
    },
    'TASK_CONTRACT_FACTORY_REQUIRED',
  ],
])('generic createTask rejects an OP-to-inpatient %s', async (
  _label,
  protectedInput,
  code,
) => {
  const query = jest.fn();
  const tx = { $queryRawUnsafe: query };

  await expect(createTask({
    tenantId: TENANT_ID,
    title: 'Forged OP transfer review',
    patientUid: '50000000-0000-4000-8000-000000000001',
    relatedResourceType: 'care_handoff_instance',
    relatedResourceId: HANDOFF_ID,
    assignedToUid: ACTOR_UID,
    createdBy: OTHER_UID,
    tx,
    ...protectedInput,
  })).rejects.toMatchObject({
    statusCode: 409,
    code,
  });
  expect(query).not.toHaveBeenCalled();
});

test('the private factory requires a transaction and creates the exact protected task', async () => {
  const patientUid = '50000000-0000-4000-8000-000000000001';
  const pathwayInstanceId = '60000000-0000-4000-8000-000000000001';
  const requestFingerprint = 'a'.repeat(64);
  const expected = {
    ...protectedTask(),
    patient_uid: patientUid,
    related_resource_id: HANDOFF_ID,
    assigned_to_uid: ACTOR_UID,
    created_by: OTHER_UID,
    description: 'Accept the exact originating outpatient transfer before admission.',
    metadata: {
      task_contract: 'op_to_inpatient_transfer_review_v1',
      care_pathway_instance_id: pathwayInstanceId,
      source_appointment_id: 73,
      request_fingerprint: requestFingerprint,
    },
  };
  const factoryInput = {
    tenantId: TENANT_ID,
    handoffId: HANDOFF_ID,
    pathwayInstanceId,
    sourceAppointmentId: 73,
    patientUid,
    recipientUid: ACTOR_UID,
    senderUid: OTHER_UID,
    requestFingerprint,
  };

  await expect(createOpInpatientTransferReviewTaskTx(factoryInput))
    .rejects.toMatchObject({
      statusCode: 500,
      code: 'OP_INPATIENT_TRANSFER_TASK_FACTORY_TX_REQUIRED',
    });

  const query = jest.fn(async (sql, ...params) => {
    expect(sql).toContain('INSERT INTO tasks');
    expect(params).toEqual(expect.arrayContaining([
      TENANT_ID,
      'op_to_inpatient_transfer_review',
      'Review OP-to-inpatient transfer request',
      'Accept the exact originating outpatient transfer before admission.',
      patientUid,
      'care_handoff_instance',
      HANDOFF_ID,
      'normal',
      ACTOR_UID,
      OTHER_UID,
      'none',
      JSON.stringify(expected.metadata),
    ]));
    return [expected];
  });
  const tx = { $queryRawUnsafe: query };

  await expect(createOpInpatientTransferReviewTaskTx({
    ...factoryInput,
    tx,
  })).resolves.toEqual(expected);
  expect(query).toHaveBeenCalledTimes(1);
});
