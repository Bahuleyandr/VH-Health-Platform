import { jest } from '@jest/globals';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const CLINICIAN_UID = '20000000-0000-4000-8000-000000000001';
const PATIENT_UID = '30000000-0000-4000-8000-000000000001';
const ENCOUNTER_ID = '40000000-0000-4000-8000-000000000001';
const PATHWAY_ID = '50000000-0000-4000-8000-000000000001';

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
  createEdClosureReviewTaskTx,
  createTask,
} = await import('../../services/workflow/taskService.js');

function closureTask() {
  return {
    id: 91,
    tenant_id: TENANT_ID,
    task_kind: 'ed_closure_review',
    title: 'Complete ED destination or closure evidence for visit #73',
    description:
      'Record the exact destination acceptance, patient-safe aftercare, recovery outcome, or death/MLC/mortuary evidence for this ED visit.',
    patient_uid: PATIENT_UID,
    encounter_id: null,
    related_resource_type: 'emergency_visit_closure',
    related_resource_id: '73',
    priority: 'normal',
    status: 'open',
    assigned_to_uid: CLINICIAN_UID,
    assigned_to_role: null,
    due_at: null,
    workflow_sla_instance_id: null,
    sla_completion_semantics: 'none',
    metadata: {
      task_contract: 'ed_closure_review_v1',
      emergency_visit_id: 73,
      canonical_encounter_id: ENCOUNTER_ID,
      care_pathway_instance_id: PATHWAY_ID,
      created_by_system_key: 'emergency.pathway_projector.v2',
      supersedes_task_id: null,
      closure_evidence_revision: 1,
    },
  };
}

test.each([
  [
    { taskKind: 'ed_closure_review', metadata: {} },
    'ED_CLOSURE_TASK_FACTORY_REQUIRED',
  ],
  [
    {
      taskKind: 'review',
      metadata: { task_contract: 'ed_closure_review_v1' },
    },
    'TASK_CONTRACT_FACTORY_REQUIRED',
  ],
])('generic createTask rejects protected ED closure task input', async (
  protectedInput,
  code,
) => {
  const query = jest.fn();
  const tx = { $queryRawUnsafe: query };

  await expect(createTask({
    tenantId: TENANT_ID,
    title: 'Forged ED closure review',
    patientUid: PATIENT_UID,
    relatedResourceType: 'emergency_visit_closure',
    relatedResourceId: '73',
    assignedToUid: CLINICIAN_UID,
    tx,
    ...protectedInput,
  })).rejects.toMatchObject({ statusCode: 409, code });
  expect(query).not.toHaveBeenCalled();
});

test('the private factory creates one exact clinician task with no SLA', async () => {
  const factoryInput = {
    tenantId: TENANT_ID,
    pathwayInstanceId: PATHWAY_ID,
    emergencyVisitId: 73,
    patientUid: PATIENT_UID,
    encounterId: ENCOUNTER_ID,
    assignedToUid: CLINICIAN_UID,
    evidenceRevision: 1,
  };

  await expect(createEdClosureReviewTaskTx(factoryInput))
    .rejects.toMatchObject({
      statusCode: 500,
      code: 'ED_CLOSURE_TASK_FACTORY_TX_REQUIRED',
    });

  const expected = closureTask();
  const query = jest.fn(async (sql, ...params) => {
    expect(sql).toContain('INSERT INTO tasks');
    expect(params).toEqual(expect.arrayContaining([
      TENANT_ID,
      'ed_closure_review',
      'Complete ED destination or closure evidence for visit #73',
      PATIENT_UID,
      'emergency_visit_closure',
      '73',
      'normal',
      CLINICIAN_UID,
      'none',
      JSON.stringify(expected.metadata),
    ]));
    return [expected];
  });
  const tx = { $queryRawUnsafe: query };

  await expect(createEdClosureReviewTaskTx({
    ...factoryInput,
    tx,
  })).resolves.toEqual(expected);
  expect(query).toHaveBeenCalledTimes(1);
});
