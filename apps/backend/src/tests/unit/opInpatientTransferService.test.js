import { jest } from '@jest/globals';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const SENDER_UID = '30000000-0000-4000-8000-000000000001';
const RECIPIENT_UID = '40000000-0000-4000-8000-000000000001';
const OTHER_RECIPIENT_UID = '50000000-0000-4000-8000-000000000001';
const PATHWAY_ID = '60000000-0000-4000-8000-000000000001';
const HANDOFF_ID = '70000000-0000-4000-8000-000000000001';
const APPOINTMENT_UID = '80000000-0000-4000-8000-000000000001';
const CHECKSUM = 'a'.repeat(64);
const APPOINTMENT_ID = 73;

let activeTx;
let activeRuntime;
const queryRawUnsafeMock = jest.fn();
const setTenantTxMock = jest.fn(async (_tenantId, callback) => callback(activeTx));
const createReviewTaskMock = jest.fn();
const settleTaskMock = jest.fn();
const assertTenantScopeMock = jest.fn();
const lockRuntimeMock = jest.fn();
const resolveModeMock = jest.fn();
const resolveRegistryVersionMock = jest.fn();
const appendTransitionMock = jest.fn();
const findReplayMock = jest.fn();
const lockAppointmentMock = jest.fn();

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
  createOpInpatientTransferReviewTaskTx: createReviewTaskMock,
  settleOpInpatientTransferReviewTaskTx: settleTaskMock,
}));
jest.unstable_mockModule(
  '../../services/workflow/workflowHumanOwnerService.js',
  () => ({
    isPathwayNamedClinicalOwnerRole: role => [
      'DOCTOR',
      'CONSULTANT',
      'JUNIOR_DOCTOR',
      'SENIOR_DOCTOR',
      'ANAESTHETIST',
    ].includes(String(role || '').toUpperCase()),
  }),
);
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
  '../../services/appointment/appointmentLifecycleService.js',
  () => ({
    lockAppointmentForLifecycleTx: lockAppointmentMock,
  }),
);
jest.unstable_mockModule(
  '../../services/pathways/opPathwayDefinition.js',
  () => ({
    compileOpContactToRecoveryDefinition: () => ({ checksum: CHECKSUM }),
  }),
);
jest.unstable_mockModule(
  '../../services/workflow/workflowRuntimeRegistry.js',
  () => ({
    workflowRuntimeRegistryV4: {},
  }),
);

const {
  __testing__,
  acceptOpInpatientTransfer,
  requestOpInpatientTransfer,
} = await import('../../services/appointment/opInpatientTransferService.js');

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
    authorizationMode: 'authenticated_appointment_transfer_route',
  };
}

function appointment(overrides = {}) {
  return {
    id: APPOINTMENT_ID,
    uid: APPOINTMENT_UID,
    patient_uid: PATIENT_UID,
    tenant_id: TENANT_ID,
    status: 'COMPLETED',
    advised_for_admission_at: new Date('2026-07-23T10:00:00.000Z'),
    ...overrides,
  };
}

function runtime(handoffs = [], overrides = {}) {
  return {
    instance: {
      id: PATHWAY_ID,
      workflow_run_id: 19,
      patient_uid: PATIENT_UID,
      pathway_key: 'op_contact_to_recovery',
      pathway_version: 1,
      source_episode_type: 'appointment',
      source_episode_id: String(APPOINTMENT_ID),
      owning_clinician_uid: SENDER_UID,
      clinical_status: 'active',
      closed_at: null,
      definition_checksum: CHECKSUM,
    },
    run: {
      id: 19,
      workflow_key: 'op_contact_to_recovery',
      workflow_version: 1,
      pathway_definition_checksum: CHECKSUM,
      status: 'running',
      current_step_key: 'await_closure_evidence',
    },
    steps: [{
      id: 31,
      step_key: 'await_closure_evidence',
      step_kind: 'wait',
      status: 'in_progress',
    }],
    handoffs,
    ...overrides,
  };
}

function taskRow({
  status = 'open',
  fingerprint,
  handoffId = HANDOFF_ID,
} = {}) {
  return {
    id: 91,
    tenant_id: TENANT_ID,
    workflow_run_id: null,
    workflow_step_id: null,
    task_kind: 'op_to_inpatient_transfer_review',
    title: 'Review OP-to-inpatient transfer request',
    description: 'Accept the exact originating outpatient transfer before admission.',
    patient_uid: PATIENT_UID,
    encounter_id: null,
    related_resource_type: 'care_handoff_instance',
    related_resource_id: handoffId,
    priority: 'normal',
    status,
    assigned_to_uid: RECIPIENT_UID,
    assigned_to_role: null,
    created_by: SENDER_UID,
    due_at: null,
    completed_at: status === 'completed'
      ? new Date('2026-07-23T10:05:00.000Z')
      : null,
    cancelled_at: null,
    cancellation_reason: null,
    workflow_sla_instance_id: null,
    sla_completion_semantics: 'none',
    metadata: {
      task_contract: 'op_to_inpatient_transfer_review_v1',
      care_pathway_instance_id: PATHWAY_ID,
      source_appointment_id: APPOINTMENT_ID,
      request_fingerprint: fingerprint,
    },
  };
}

function handoffRow({
  status = 'requested',
  fingerprint,
  requestKey,
  accepted = status === 'accepted',
  handoffId = HANDOFF_ID,
} = {}) {
  return {
    id: handoffId,
    tenant_id: TENANT_ID,
    patient_uid: PATIENT_UID,
    sending_pathway_instance_id: PATHWAY_ID,
    sending_workflow_run_id: 19,
    sending_step_key: 'await_closure_evidence',
    receiving_pathway_instance_id: null,
    receiving_workflow_run_id: null,
    receiving_step_key: null,
    handoff_type: 'op_to_inpatient_transfer',
    source_resource_type: 'appointment',
    source_resource_id: String(APPOINTMENT_ID),
    urgency_code: 'not_applicable',
    policy_due_at: null,
    sender_uid: SENDER_UID,
    sender_system_key: null,
    recipient_kind: 'user',
    intended_recipient_uid: RECIPIENT_UID,
    intended_recipient_role: null,
    intended_team_id: null,
    external_recipient_ref: null,
    status,
    decline_reason: null,
    cancellation_reason: null,
    requested_at: new Date('2026-07-23T10:01:00.000Z'),
    acknowledged_at: null,
    accepted_at: accepted ? new Date('2026-07-23T10:05:00.000Z') : null,
    accepted_by_uid: accepted ? RECIPIENT_UID : null,
    declined_at: null,
    completed_at: null,
    originator_closed_at: null,
    cancelled_at: null,
    task_id: 91,
    idempotency_key: requestKey,
    request_reason: 'Needs monitored inpatient treatment',
    request_fingerprint: fingerprint,
    metadata: {},
  };
}

function requestFingerprint(reason = 'Needs monitored inpatient treatment') {
  return __testing__.requestFingerprint({
    tenantId: TENANT_ID,
    appointmentId: APPOINTMENT_ID,
    pathwayInstanceId: PATHWAY_ID,
    senderUid: SENDER_UID,
    recipientUid: RECIPIENT_UID,
    reason,
  });
}

function requestKey(rawKey = 'request-key') {
  return __testing__.namespaceIdempotencyKey(
    SENDER_UID,
    'request_op_to_inpatient_transfer',
    rawKey,
  );
}

function defaultQuery(sql) {
  if (sql.includes('uid = ANY($2::uuid[])')) {
    return [
      activeUser(SENDER_UID, 'DOCTOR'),
      activeUser(RECIPIENT_UID, 'CONSULTANT'),
    ];
  }
  if (sql.includes('FROM care_pathway_instances')) return [{ id: PATHWAY_ID }];
  throw new Error(`Unexpected SQL: ${sql}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  activeTx = { $queryRawUnsafe: queryRawUnsafeMock };
  activeRuntime = runtime();
  queryRawUnsafeMock.mockImplementation(defaultQuery);
  assertTenantScopeMock.mockResolvedValue(undefined);
  lockAppointmentMock.mockResolvedValue(appointment());
  lockRuntimeMock.mockImplementation(async () => activeRuntime);
  resolveModeMock.mockResolvedValue('active');
  resolveRegistryVersionMock.mockResolvedValue(4);
  findReplayMock.mockResolvedValue({ replayed: false, events: [] });
  appendTransitionMock.mockResolvedValue({
    event: {
      id: '90000000-0000-4000-8000-000000000001',
      transition_scope: 'handoff',
      transition_key: 'op_to_inpatient_transfer_requested',
      actor_uid: SENDER_UID,
      canonical_timeline_event_id: '90000000-0000-4000-8000-000000000009',
      metadata: { request_fingerprint: 'do-not-return' },
    },
  });
});

test('request atomically binds an exact no-SLA recipient task and typed handoff', async () => {
  const fingerprint = requestFingerprint();
  const key = requestKey();
  createReviewTaskMock.mockImplementation(async input => taskRow({
    fingerprint,
    handoffId: input.handoffId,
  }));
  queryRawUnsafeMock.mockImplementation(async (sql, ...params) => {
    if (sql.includes('uid = ANY($2::uuid[])')) return defaultQuery(sql);
    if (sql.includes('FROM care_pathway_instances')) return [{ id: PATHWAY_ID }];
    if (sql.includes('INSERT INTO care_handoff_instances')) {
      return [handoffRow({
        fingerprint,
        requestKey: key,
        handoffId: params[0],
      })];
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const result = await requestOpInpatientTransfer({
    tenantId: TENANT_ID,
    appointmentId: APPOINTMENT_ID,
    intendedRecipientUid: RECIPIENT_UID,
    reason: ' Needs monitored inpatient treatment ',
    idempotencyKey: 'request-key',
    actor: actor(SENDER_UID, 'DOCTOR'),
  });

  expect(result.replayed).toBe(false);
  expect(result.admission_source).toEqual(expect.objectContaining({
    appointment_id: APPOINTMENT_ID,
    source_pathway_instance_id: PATHWAY_ID,
    accepted_recipient_uid: null,
  }));
  expect(result.admission_source.source_handoff_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
  );
  expect(Object.keys(result)).not.toContain('__patient_uid');
  expect(result.__patient_uid).toBe(PATIENT_UID);
  expect(result.handoff).toEqual({
    id: result.admission_source.source_handoff_id,
    status: 'requested',
    requested_at: expect.any(Date),
    accepted_at: null,
  });
  expect(result.task).toEqual({
    id: 91,
    task_kind: 'op_to_inpatient_transfer_review',
    priority: 'normal',
    status: 'open',
  });
  expect(result.transition).toEqual({
    transition_key: 'op_to_inpatient_transfer_requested',
    occurred_at: null,
  });
  const responseJson = JSON.stringify(result);
  for (const forbidden of [
    'tenant_id',
    'patient_uid',
    'metadata',
    'idempotency_key',
    'request_fingerprint',
    'actor_uid',
    'canonical_timeline_event_id',
  ]) {
    expect(responseJson).not.toContain(forbidden);
  }
  expect(createReviewTaskMock).toHaveBeenCalledWith({
    tenantId: TENANT_ID,
    handoffId: result.admission_source.source_handoff_id,
    pathwayInstanceId: PATHWAY_ID,
    sourceAppointmentId: APPOINTMENT_ID,
    patientUid: PATIENT_UID,
    recipientUid: RECIPIENT_UID,
    senderUid: SENDER_UID,
    requestFingerprint: fingerprint,
    tx: activeTx,
  });
  expect(appendTransitionMock).toHaveBeenCalledWith(expect.objectContaining({
    transitionScope: 'handoff',
    transitionKey: 'op_to_inpatient_transfer_requested',
    sourceResourceType: 'care_handoff_instance',
    sourceResourceId: result.admission_source.source_handoff_id,
    commandFingerprint: fingerprint,
  }));
});

test('same exact request replays without another task, handoff, or transition write', async () => {
  const fingerprint = requestFingerprint();
  const key = requestKey();
  const task = taskRow({ fingerprint });
  const handoff = handoffRow({ fingerprint, requestKey: key });
  activeRuntime = runtime([handoff]);
  findReplayMock.mockResolvedValue({
    replayed: true,
    events: [{
      transition_scope: 'handoff',
      transition_key: 'op_to_inpatient_transfer_requested',
    }],
  });
  queryRawUnsafeMock.mockImplementation(async (sql) => {
    if (sql.includes('uid = ANY($2::uuid[])')) return defaultQuery(sql);
    if (sql.includes('FROM care_pathway_instances')) return [{ id: PATHWAY_ID }];
    if (sql.includes('FROM tasks')) return [task];
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const result = await requestOpInpatientTransfer({
    tenantId: TENANT_ID,
    appointmentId: APPOINTMENT_ID,
    intendedRecipientUid: RECIPIENT_UID,
    reason: 'Needs monitored inpatient treatment',
    idempotencyKey: 'request-key',
    actor: actor(SENDER_UID, 'DOCTOR'),
  });

  expect(result.replayed).toBe(true);
  expect(createReviewTaskMock).not.toHaveBeenCalled();
  expect(appendTransitionMock).not.toHaveBeenCalled();
  expect(queryRawUnsafeMock.mock.calls.some(([sql]) => (
    sql.includes('INSERT INTO care_handoff_instances')
  ))).toBe(false);
});

test('same request key with a changed command conflicts before any mutation', async () => {
  findReplayMock.mockRejectedValue(
    Object.assign(new Error('reused'), {
      statusCode: 409,
      code: 'PATHWAY_IDEMPOTENCY_KEY_REUSED',
    }),
  );

  await expect(requestOpInpatientTransfer({
    tenantId: TENANT_ID,
    appointmentId: APPOINTMENT_ID,
    intendedRecipientUid: RECIPIENT_UID,
    reason: 'Different reason',
    idempotencyKey: 'request-key',
    actor: actor(SENDER_UID, 'DOCTOR'),
  })).rejects.toMatchObject({
    statusCode: 409,
    code: 'PATHWAY_IDEMPOTENCY_KEY_REUSED',
  });

  expect(lockAppointmentMock).toHaveBeenCalledTimes(1);
  expect(findReplayMock).toHaveBeenCalledTimes(1);
  expect(createReviewTaskMock).not.toHaveBeenCalled();
  expect(appendTransitionMock).not.toHaveBeenCalled();
});

test.each([
  ['wrong recipient', HANDOFF_ID],
  ['malformed handoff id', 'not-a-uuid'],
])('%s is denied before replay, appointment PHI, or mutation', async (_label, handoffId) => {
  queryRawUnsafeMock.mockImplementation(async (sql) => {
    if (sql.includes('uid = $2::uuid')) {
      return [activeUser(OTHER_RECIPIENT_UID, 'CONSULTANT')];
    }
    if (sql.includes('FROM care_handoff_instances')) return [];
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  await expect(acceptOpInpatientTransfer({
    tenantId: TENANT_ID,
    appointmentId: APPOINTMENT_ID,
    handoffId,
    idempotencyKey: 'accept-key',
    actor: actor(OTHER_RECIPIENT_UID, 'CONSULTANT'),
  })).rejects.toMatchObject({
    statusCode: 403,
    code: 'OP_INPATIENT_TRANSFER_FORBIDDEN',
  });

  expect(findReplayMock).not.toHaveBeenCalled();
  expect(lockAppointmentMock).not.toHaveBeenCalled();
  expect(settleTaskMock).not.toHaveBeenCalled();
  expect(appendTransitionMock).not.toHaveBeenCalled();
});

test('exact recipient acceptance CAS-settles the task and returns admission lineage', async () => {
  const fingerprint = requestFingerprint();
  const handoff = handoffRow({
    fingerprint,
    requestKey: requestKey(),
  });
  const task = taskRow({ fingerprint });
  const settledTask = taskRow({ fingerprint, status: 'completed' });
  const acceptedHandoff = handoffRow({
    fingerprint,
    requestKey: requestKey(),
    status: 'accepted',
  });
  activeRuntime = runtime([handoff]);
  settleTaskMock.mockResolvedValue(settledTask);
  appendTransitionMock.mockResolvedValue({
    event: {
      id: '90000000-0000-4000-8000-000000000002',
      transition_scope: 'handoff',
      transition_key: 'op_to_inpatient_transfer_accepted',
      actor_uid: RECIPIENT_UID,
      canonical_timeline_event_id: '90000000-0000-4000-8000-000000000009',
      metadata: { request_fingerprint: 'do-not-return' },
    },
  });
  queryRawUnsafeMock.mockImplementation(async (sql) => {
    if (sql.includes('uid = $2::uuid')) {
      return [activeUser(RECIPIENT_UID, 'CONSULTANT')];
    }
    if (sql.includes('FROM care_handoff_instances') && sql.includes('LIMIT 1')) {
      return [{
        sending_pathway_instance_id: PATHWAY_ID,
        sending_workflow_run_id: 19,
        sending_step_key: 'await_closure_evidence',
        source_resource_id: String(APPOINTMENT_ID),
        sender_uid: SENDER_UID,
        intended_recipient_uid: RECIPIENT_UID,
        task_id: 91,
      }];
    }
    if (sql.includes('uid = ANY($2::uuid[])')) return defaultQuery(sql);
    if (sql.includes('FROM tasks')) return [task];
    if (sql.includes('UPDATE care_handoff_instances')) return [acceptedHandoff];
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const result = await acceptOpInpatientTransfer({
    tenantId: TENANT_ID,
    appointmentId: APPOINTMENT_ID,
    handoffId: HANDOFF_ID,
    idempotencyKey: 'accept-key',
    actor: actor(RECIPIENT_UID, 'CONSULTANT'),
  });

  expect(result.replayed).toBe(false);
  expect(result.admission_source).toEqual({
    appointment_id: APPOINTMENT_ID,
    source_pathway_instance_id: PATHWAY_ID,
    source_handoff_id: HANDOFF_ID,
    accepted_recipient_uid: RECIPIENT_UID,
  });
  expect(result.handoff).toEqual({
    id: HANDOFF_ID,
    status: 'accepted',
    requested_at: expect.any(Date),
    accepted_at: expect.any(Date),
  });
  expect(result.task).toEqual({
    id: 91,
    task_kind: 'op_to_inpatient_transfer_review',
    priority: 'normal',
    status: 'completed',
  });
  const responseJson = JSON.stringify(result);
  for (const forbidden of [
    'tenant_id',
    'patient_uid',
    'metadata',
    'idempotency_key',
    'request_fingerprint',
    'actor_uid',
    'canonical_timeline_event_id',
  ]) {
    expect(responseJson).not.toContain(forbidden);
  }
  expect(settleTaskMock).toHaveBeenCalledWith(expect.objectContaining({
    id: 91,
    handoffId: HANDOFF_ID,
    pathwayInstanceId: PATHWAY_ID,
    appointmentId: APPOINTMENT_ID,
    patientUid: PATIENT_UID,
    requestFingerprint: fingerprint,
    recipientUid: RECIPIENT_UID,
    actorUid: RECIPIENT_UID,
    tx: activeTx,
  }));
  expect(appendTransitionMock).toHaveBeenCalledWith(expect.objectContaining({
    transitionKey: 'op_to_inpatient_transfer_accepted',
    sourceResourceId: HANDOFF_ID,
  }));
});

test('same exact acceptance replays without another task or handoff mutation', async () => {
  const fingerprint = requestFingerprint();
  const handoff = handoffRow({
    fingerprint,
    requestKey: requestKey(),
    status: 'accepted',
  });
  const task = taskRow({ fingerprint, status: 'completed' });
  activeRuntime = runtime([handoff]);
  findReplayMock.mockResolvedValue({
    replayed: true,
    events: [{
      transition_scope: 'handoff',
      transition_key: 'op_to_inpatient_transfer_accepted',
    }],
  });
  queryRawUnsafeMock.mockImplementation(async (sql) => {
    if (sql.includes('uid = $2::uuid')) {
      return [activeUser(RECIPIENT_UID, 'CONSULTANT')];
    }
    if (sql.includes('FROM care_handoff_instances') && sql.includes('LIMIT 1')) {
      return [{
        sending_pathway_instance_id: PATHWAY_ID,
        sending_workflow_run_id: 19,
        sending_step_key: 'await_closure_evidence',
        source_resource_id: String(APPOINTMENT_ID),
        sender_uid: SENDER_UID,
        intended_recipient_uid: RECIPIENT_UID,
        task_id: 91,
      }];
    }
    if (sql.includes('uid = ANY($2::uuid[])')) return defaultQuery(sql);
    if (sql.includes('FROM tasks')) return [task];
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const result = await acceptOpInpatientTransfer({
    tenantId: TENANT_ID,
    appointmentId: APPOINTMENT_ID,
    handoffId: HANDOFF_ID,
    idempotencyKey: 'accept-key',
    actor: actor(RECIPIENT_UID, 'CONSULTANT'),
  });

  expect(result.replayed).toBe(true);
  expect(result.admission_source.accepted_recipient_uid).toBe(RECIPIENT_UID);
  expect(settleTaskMock).not.toHaveBeenCalled();
  expect(appendTransitionMock).not.toHaveBeenCalled();
  expect(queryRawUnsafeMock.mock.calls.some(([sql]) => (
    sql.includes('UPDATE care_handoff_instances')
  ))).toBe(false);
});

test('an already accepted transfer with another accept key conflicts without mutation', async () => {
  const fingerprint = requestFingerprint();
  const handoff = handoffRow({
    fingerprint,
    requestKey: requestKey(),
    status: 'accepted',
  });
  const task = taskRow({ fingerprint, status: 'completed' });
  activeRuntime = runtime([handoff]);
  queryRawUnsafeMock.mockImplementation(async (sql) => {
    if (sql.includes('uid = $2::uuid')) {
      return [activeUser(RECIPIENT_UID, 'CONSULTANT')];
    }
    if (sql.includes('FROM care_handoff_instances') && sql.includes('LIMIT 1')) {
      return [{
        sending_pathway_instance_id: PATHWAY_ID,
        sending_workflow_run_id: 19,
        sending_step_key: 'await_closure_evidence',
        source_resource_id: String(APPOINTMENT_ID),
        sender_uid: SENDER_UID,
        intended_recipient_uid: RECIPIENT_UID,
        task_id: 91,
      }];
    }
    if (sql.includes('uid = ANY($2::uuid[])')) return defaultQuery(sql);
    if (sql.includes('FROM tasks')) return [task];
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  await expect(acceptOpInpatientTransfer({
    tenantId: TENANT_ID,
    appointmentId: APPOINTMENT_ID,
    handoffId: HANDOFF_ID,
    idempotencyKey: 'different-accept-key',
    actor: actor(RECIPIENT_UID, 'CONSULTANT'),
  })).rejects.toMatchObject({
    statusCode: 409,
  });

  expect(settleTaskMock).not.toHaveBeenCalled();
  expect(appendTransitionMock).not.toHaveBeenCalled();
});
