import { jest } from '@jest/globals';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const SENDER_UID = '30000000-0000-4000-8000-000000000001';
const RECIPIENT_UID = '40000000-0000-4000-8000-000000000001';
const OTHER_UID = '50000000-0000-4000-8000-000000000001';
const PATHWAY_ID = '60000000-0000-4000-8000-000000000001';
const HANDOFF_ID = '70000000-0000-4000-8000-000000000001';
const ENCOUNTER_ID = '80000000-0000-4000-8000-000000000001';
const CHECKSUM = 'a'.repeat(64);
const VISIT_ID = 73;

let activeTx;
let activeRuntime;
const queryRawUnsafeMock = jest.fn();
const setTenantTxMock = jest.fn(async (_tenantId, callback) => callback(activeTx));
const createTaskMock = jest.fn();
const settleTaskMock = jest.fn();
const assertTenantScopeMock = jest.fn();
const lockRuntimeMock = jest.fn();
const resolveModeMock = jest.fn();
const resolveRegistryVersionMock = jest.fn();
const appendTransitionMock = jest.fn();
const findReplayMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  isTenantTransactionClient: value => value === activeTx,
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  getTenantById: jest.fn(),
  requireTenantId: value => value,
}));
jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  createEdDestinationHandoffReviewTaskTx: createTaskMock,
  settleEdDestinationHandoffReviewTaskTx: settleTaskMock,
}));
jest.unstable_mockModule(
  '../../services/pathways/pathwayRuntimePersistence.js',
  () => ({
    assertPathwayTenantScopeTx: assertTenantScopeMock,
    lockPathwayRuntimeTx: lockRuntimeMock,
    resolvePathwayModeTx: resolveModeMock,
    resolvePathwayRuntimeRegistryVersionTx: resolveRegistryVersionMock,
  }),
);
jest.unstable_mockModule(
  '../../services/pathways/pathwayTransitionEventService.js',
  () => ({
    appendPathwayTransitionEventTx: appendTransitionMock,
    findPathwayTransitionReplayTx: findReplayMock,
  }),
);
jest.unstable_mockModule(
  '../../services/pathways/emergencyPathwayDefinition.js',
  () => ({
    compileEmergencyArrivalToAftercareDefinition: () => ({ checksum: CHECKSUM }),
  }),
);
jest.unstable_mockModule(
  '../../services/workflow/workflowRuntimeRegistry.js',
  () => ({ workflowRuntimeRegistryV5: {} }),
);

const {
  __testing__,
  decideEdDestinationHandoff,
  requestEdDestinationHandoff,
} = await import('../../services/ed/edDestinationHandoffService.js');

function activeUser(uid, role) {
  return {
    uid,
    role,
    is_active: true,
    status: 'active',
    is_deleted: false,
    deleted_at: null,
  };
}

function actor(uid, role) {
  return {
    kind: 'user',
    uid,
    roles: [role],
    primaryRole: role,
    rawRole: role,
    authorizationMode: 'authenticated_ed_handoff_route',
  };
}

function visit(overrides = {}) {
  return {
    id: VISIT_ID,
    patient_uid: PATIENT_UID,
    encounter_id: ENCOUNTER_ID,
    attending_doctor_uid: SENDER_UID,
    status: 'awaiting_disposition',
    disposition: null,
    departure_at: null,
    ...overrides,
  };
}

function runtime(handoffs = []) {
  return {
    instance: {
      id: PATHWAY_ID,
      workflow_run_id: 19,
      patient_uid: PATIENT_UID,
      pathway_key: 'emergency_arrival_to_aftercare',
      pathway_version: 1,
      source_episode_type: 'emergency_visit',
      source_episode_id: String(VISIT_ID),
      owning_clinician_uid: SENDER_UID,
      clinical_status: 'active',
      closed_at: null,
      definition_checksum: CHECKSUM,
    },
    run: {
      id: 19,
      workflow_key: 'emergency_arrival_to_aftercare',
      workflow_version: 1,
      pathway_definition_checksum: CHECKSUM,
      status: 'running',
      current_step_key: 'await_destination_acceptance',
    },
    steps: [{
      id: 31,
      step_key: 'await_destination_acceptance',
      step_kind: 'wait',
      status: 'in_progress',
    }],
    handoffs,
  };
}

function taskRow({ status = 'open', fingerprint, handoffId = HANDOFF_ID } = {}) {
  return {
    id: 91,
    tenant_id: TENANT_ID,
    workflow_run_id: null,
    workflow_step_id: null,
    task_kind: 'ed_destination_handoff_review',
    patient_uid: PATIENT_UID,
    encounter_id: null,
    related_resource_type: 'care_handoff_instance',
    related_resource_id: handoffId,
    priority: 'high',
    status,
    assigned_to_uid: null,
    assigned_to_role: 'ICU_NURSE',
    due_at: null,
    workflow_sla_instance_id: null,
    sla_completion_semantics: 'none',
    metadata: {
      task_contract: 'ed_destination_handoff_review_v1',
      care_pathway_instance_id: PATHWAY_ID,
      emergency_visit_id: VISIT_ID,
      canonical_encounter_id: ENCOUNTER_ID,
      destination: 'icu',
      request_fingerprint: fingerprint,
    },
  };
}

function handoffRow({
  status = 'requested',
  fingerprint,
  requestKey,
  handoffId = HANDOFF_ID,
} = {}) {
  return {
    id: handoffId,
    tenant_id: TENANT_ID,
    patient_uid: PATIENT_UID,
    sending_pathway_instance_id: PATHWAY_ID,
    sending_workflow_run_id: 19,
    sending_step_key: 'await_destination_acceptance',
    receiving_pathway_instance_id: null,
    receiving_workflow_run_id: null,
    receiving_step_key: null,
    handoff_type: 'ed_destination_handoff',
    source_resource_type: 'emergency_visit',
    source_resource_id: String(VISIT_ID),
    urgency_code: 'not_applicable',
    policy_due_at: null,
    sender_uid: SENDER_UID,
    sender_system_key: null,
    recipient_kind: 'role',
    intended_recipient_uid: null,
    intended_recipient_role: 'ICU_NURSE',
    intended_team_id: null,
    external_recipient_ref: null,
    status,
    decline_reason: null,
    reroute_reason: null,
    cancellation_reason: null,
    requested_at: new Date('2026-07-26T10:00:00.000Z'),
    acknowledged_at: null,
    accepted_at: status === 'accepted'
      ? new Date('2026-07-26T10:05:00.000Z')
      : null,
    accepted_by_uid: status === 'accepted' ? RECIPIENT_UID : null,
    declined_at: null,
    completed_at: null,
    originator_closed_at: null,
    cancelled_at: null,
    task_id: 91,
    idempotency_key: requestKey,
    request_reason: 'ICU monitoring is required',
    request_fingerprint: fingerprint,
    metadata: { destination: 'icu', registry_version: 5 },
  };
}

function fingerprint() {
  return __testing__.requestFingerprint({
    tenantId: TENANT_ID,
    emergencyVisitId: VISIT_ID,
    pathwayInstanceId: PATHWAY_ID,
    senderUid: SENDER_UID,
    recipientRole: 'ICU_NURSE',
    destination: 'icu',
    reason: 'ICU monitoring is required',
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  activeTx = { $queryRawUnsafe: queryRawUnsafeMock };
  activeRuntime = runtime();
  assertTenantScopeMock.mockResolvedValue(undefined);
  lockRuntimeMock.mockImplementation(async () => activeRuntime);
  resolveModeMock.mockResolvedValue('active');
  resolveRegistryVersionMock.mockResolvedValue(5);
  findReplayMock.mockResolvedValue({ replayed: false, events: [] });
  appendTransitionMock.mockResolvedValue({
    event: {
      transition_scope: 'handoff',
      transition_key: 'ed_destination_handoff_requested',
    },
  });
});

test('rejects a recipient role that cannot access the ED handoff queue', async () => {
  await expect(requestEdDestinationHandoff({
    tenantId: TENANT_ID,
    emergencyVisitId: VISIT_ID,
    destination: 'icu',
    intendedRecipientRole: 'NOT_A_REAL_ROLE',
    reason: 'ICU monitoring is required',
    idempotencyKey: 'request-key',
    actor: actor(SENDER_UID, 'DOCTOR'),
  })).rejects.toMatchObject({
    statusCode: 400,
    code: 'ED_DESTINATION_HANDOFF_RECIPIENT_ROLE_INVALID',
  });

  expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  expect(createTaskMock).not.toHaveBeenCalled();
  expect(appendTransitionMock).not.toHaveBeenCalled();
});

test('only the exact active named ED owner can request a destination handoff', async () => {
  queryRawUnsafeMock.mockImplementation(async (sql) => {
    if (sql.includes('FROM users')) return [activeUser(OTHER_UID, 'DOCTOR')];
    if (sql.includes('FROM emergency_visits')) return [visit()];
    if (sql.includes('FROM care_pathway_instances')) return [{ id: PATHWAY_ID }];
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  await expect(requestEdDestinationHandoff({
    tenantId: TENANT_ID,
    emergencyVisitId: VISIT_ID,
    destination: 'icu',
    intendedRecipientRole: 'ICU_NURSE',
    reason: 'ICU monitoring is required',
    idempotencyKey: 'request-key',
    actor: actor(OTHER_UID, 'DOCTOR'),
  })).rejects.toMatchObject({
    statusCode: 409,
    code: 'ED_DESTINATION_HANDOFF_STAGE_UNAVAILABLE',
  });

  expect(createTaskMock).not.toHaveBeenCalled();
  expect(appendTransitionMock).not.toHaveBeenCalled();
});

test.each([
  ['wrong role', HANDOFF_ID],
  ['malformed handoff id', 'not-a-uuid'],
])('%s is denied before visit PHI, replay, or mutation', async (_label, handoffId) => {
  queryRawUnsafeMock.mockImplementation(async (sql) => {
    if (sql.includes('FROM users')) return [activeUser(OTHER_UID, 'DOCTOR')];
    if (sql.includes('FROM care_handoff_instances')) return [];
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  await expect(decideEdDestinationHandoff({
    tenantId: TENANT_ID,
    emergencyVisitId: VISIT_ID,
    handoffId,
    decision: 'accept',
    idempotencyKey: 'accept-key',
    actor: actor(OTHER_UID, 'DOCTOR'),
  })).rejects.toMatchObject({
    statusCode: 403,
    code: 'ED_DESTINATION_HANDOFF_FORBIDDEN',
  });

  expect(queryRawUnsafeMock.mock.calls.some(([sql]) => (
    sql.includes('FROM emergency_visits')
  ))).toBe(false);
  expect(findReplayMock).not.toHaveBeenCalled();
  expect(settleTaskMock).not.toHaveBeenCalled();
  expect(appendTransitionMock).not.toHaveBeenCalled();
});

test('an exact active role holder accepts and atomically settles the no-SLA task', async () => {
  const requestFingerprint = fingerprint();
  const requestKey = __testing__.namespaceIdempotencyKey(
    SENDER_UID,
    'request_ed_destination_handoff',
    'request-key',
  );
  const handoff = handoffRow({
    fingerprint: requestFingerprint,
    requestKey,
  });
  const task = taskRow({ fingerprint: requestFingerprint });
  const settledTask = taskRow({
    fingerprint: requestFingerprint,
    status: 'completed',
  });
  const acceptedHandoff = handoffRow({
    status: 'accepted',
    fingerprint: requestFingerprint,
    requestKey,
  });
  activeRuntime = runtime([handoff]);
  settleTaskMock.mockResolvedValue(settledTask);
  appendTransitionMock.mockResolvedValue({
    event: {
      transition_scope: 'handoff',
      transition_key: 'ed_destination_handoff_accepted',
    },
  });
  queryRawUnsafeMock.mockImplementation(async (sql) => {
    if (sql.includes('FROM users')) {
      return [activeUser(RECIPIENT_UID, 'ICU_NURSE')];
    }
    if (sql.includes('FROM care_handoff_instances') && sql.includes('LIMIT 1')) {
      return [{
        sending_pathway_instance_id: PATHWAY_ID,
        sending_workflow_run_id: 19,
        sending_step_key: 'await_destination_acceptance',
        source_resource_id: String(VISIT_ID),
        sender_uid: SENDER_UID,
        intended_recipient_role: 'ICU_NURSE',
        task_id: 91,
      }];
    }
    if (sql.includes('FROM emergency_visits')) return [visit()];
    if (sql.includes('FROM tasks')) return [task];
    if (sql.includes('UPDATE care_handoff_instances')) return [acceptedHandoff];
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const result = await decideEdDestinationHandoff({
    tenantId: TENANT_ID,
    emergencyVisitId: VISIT_ID,
    handoffId: HANDOFF_ID,
    decision: 'accept',
    idempotencyKey: 'accept-key',
    actor: actor(RECIPIENT_UID, 'ICU_NURSE'),
  });

  expect(result).toMatchObject({
    replayed: false,
    handoff: {
      id: HANDOFF_ID,
      status: 'accepted',
      destination: 'icu',
      intended_recipient_role: 'ICU_NURSE',
      accepted_by_uid: RECIPIENT_UID,
    },
    task: {
      id: 91,
      task_kind: 'ed_destination_handoff_review',
      priority: 'high',
      status: 'completed',
      assigned_to_role: 'ICU_NURSE',
    },
    destination_source: {
      emergency_visit_id: VISIT_ID,
      source_pathway_instance_id: PATHWAY_ID,
      source_handoff_id: HANDOFF_ID,
    },
  });
  expect(settleTaskMock).toHaveBeenCalledWith(expect.objectContaining({
    handoffId: HANDOFF_ID,
    pathwayInstanceId: PATHWAY_ID,
    emergencyVisitId: VISIT_ID,
    recipientRole: 'ICU_NURSE',
    actorUid: RECIPIENT_UID,
    outcome: 'accepted',
    tx: activeTx,
  }));
  expect(appendTransitionMock).toHaveBeenCalledWith(expect.objectContaining({
    transitionKey: 'ed_destination_handoff_accepted',
    sourceResourceId: HANDOFF_ID,
  }));
});
