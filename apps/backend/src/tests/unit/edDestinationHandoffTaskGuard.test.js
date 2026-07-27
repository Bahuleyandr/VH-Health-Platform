import { jest } from '@jest/globals';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const ACTOR_UID = '20000000-0000-4000-8000-000000000001';
const SENDER_UID = '30000000-0000-4000-8000-000000000001';
const HANDOFF_ID = '40000000-0000-4000-8000-000000000001';
const PATIENT_UID = '50000000-0000-4000-8000-000000000001';
const ENCOUNTER_ID = '60000000-0000-4000-8000-000000000001';
const PATHWAY_ID = '70000000-0000-4000-8000-000000000001';

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule(
  '../../services/idempotency/idempotencyService.js',
  () => ({ isValidIdempotencyKey: () => true }),
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
  () => ({ isPathwayExecutorCapability: () => false }),
);

const {
  createEdDestinationHandoffReviewTaskTx,
  createTask,
  reassignTask,
  transitionTask,
} = await import('../../services/workflow/taskService.js');

function protectedTask() {
  return {
    id: 91,
    tenant_id: TENANT_ID,
    workflow_run_id: null,
    workflow_step_id: null,
    parent_task_id: null,
    task_kind: 'ed_destination_handoff_review',
    title: 'Accept ED destination handoff: icu',
    description: 'Accept or decline the exact Emergency Department destination handoff.',
    patient_uid: PATIENT_UID,
    encounter_id: null,
    related_resource_type: 'care_handoff_instance',
    related_resource_id: HANDOFF_ID,
    priority: 'high',
    status: 'open',
    assigned_to_uid: null,
    assigned_to_role: 'ICU_NURSE',
    created_by: SENDER_UID,
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
      task_contract: 'ed_destination_handoff_review_v1',
      care_pathway_instance_id: PATHWAY_ID,
      emergency_visit_id: 73,
      canonical_encounter_id: ENCOUNTER_ID,
      destination: 'icu',
      request_fingerprint: 'a'.repeat(64),
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
      assignedToRole: 'DOCTOR',
      tx,
    }),
  ],
])('%s cannot mutate a typed ED destination task', async (_label, mutate) => {
  const query = jest.fn(async sql => {
    if (sql.includes('SELECT') && sql.includes('FROM tasks')) return [protectedTask()];
    throw new Error(`Unexpected mutation SQL: ${sql}`);
  });
  const tx = { $queryRawUnsafe: query };

  await expect(mutate(tx)).rejects.toMatchObject({
    statusCode: 409,
    code: 'ED_DESTINATION_HANDOFF_TASK_WORKFLOW_REQUIRED',
  });
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
});

test.each([
  [
    { taskKind: 'ed_destination_handoff_review', metadata: {} },
    'ED_DESTINATION_HANDOFF_TASK_FACTORY_REQUIRED',
  ],
  [
    {
      taskKind: 'review',
      metadata: { task_contract: 'ed_destination_handoff_review_v1' },
    },
    'TASK_CONTRACT_FACTORY_REQUIRED',
  ],
])('generic createTask rejects protected ED destination task input', async (
  protectedInput,
  code,
) => {
  const query = jest.fn();
  const tx = { $queryRawUnsafe: query };

  await expect(createTask({
    tenantId: TENANT_ID,
    title: 'Forged ED destination review',
    patientUid: PATIENT_UID,
    encounterId: ENCOUNTER_ID,
    relatedResourceType: 'care_handoff_instance',
    relatedResourceId: HANDOFF_ID,
    assignedToRole: 'ICU_NURSE',
    createdBy: SENDER_UID,
    tx,
    ...protectedInput,
  })).rejects.toMatchObject({ statusCode: 409, code });
  expect(query).not.toHaveBeenCalled();
});

test('the private factory creates one exact high-priority role task with no SLA', async () => {
  const requestFingerprint = 'a'.repeat(64);
  const factoryInput = {
    tenantId: TENANT_ID,
    handoffId: HANDOFF_ID,
    pathwayInstanceId: PATHWAY_ID,
    emergencyVisitId: 73,
    patientUid: PATIENT_UID,
    encounterId: ENCOUNTER_ID,
    recipientRole: 'ICU_NURSE',
    senderUid: SENDER_UID,
    destination: 'icu',
    requestFingerprint,
  };

  await expect(createEdDestinationHandoffReviewTaskTx(factoryInput))
    .rejects.toMatchObject({
      statusCode: 500,
      code: 'ED_DESTINATION_HANDOFF_TASK_FACTORY_TX_REQUIRED',
    });

  const expected = protectedTask();
  const query = jest.fn(async (sql, ...params) => {
    expect(sql).toContain('INSERT INTO tasks');
    expect(params).toEqual(expect.arrayContaining([
      TENANT_ID,
      'ed_destination_handoff_review',
      'Accept ED destination handoff: icu',
      'Accept or decline the exact Emergency Department destination handoff.',
      PATIENT_UID,
      'care_handoff_instance',
      HANDOFF_ID,
      'high',
      'ICU_NURSE',
      SENDER_UID,
      'none',
      JSON.stringify(expected.metadata),
    ]));
    return [expected];
  });
  const tx = { $queryRawUnsafe: query };

  await expect(createEdDestinationHandoffReviewTaskTx({
    ...factoryInput,
    tx,
  })).resolves.toEqual(expected);
  expect(query).toHaveBeenCalledTimes(1);
});
