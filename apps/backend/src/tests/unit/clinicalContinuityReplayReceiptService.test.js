import { jest } from '@jest/globals';

const setTenantTx = jest.fn();
const evaluateClinicalContinuityActionRequest = jest.fn();
const resolveClinicalContinuityActionBinding = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({ setTenantTx }));
jest.unstable_mockModule(
  '../../services/downtime/clinicalContinuityActionRegistryService.js',
  () => ({ evaluateClinicalContinuityActionRequest })
);
jest.unstable_mockModule(
  '../../services/downtime/clinicalContinuityActionBindingRegistry.js',
  () => ({
    CLINICAL_CONTINUITY_PRIVATE_DRAFT_EFFECT: 'private_draft_storage_only',
    resolveClinicalContinuityActionBinding
  })
);

const { applyClinicalContinuityReplay, precheckClinicalContinuityReplay, __testing__ } =
  await import('../../services/downtime/clinicalContinuityReplayReceiptService.js');

const UUIDS = Object.freeze({
  actor: '10000000-0000-4000-8000-000000000001',
  context: '10000000-0000-4000-8000-000000000002',
  device: '10000000-0000-4000-8000-000000000003',
  event: '10000000-0000-4000-8000-000000000004',
  grant: '10000000-0000-4000-8000-000000000005',
  patient: '10000000-0000-4000-8000-000000000006',
  request: '10000000-0000-4000-8000-000000000007',
  tenant: '10000000-0000-4000-8000-000000000008'
});

function input(overrides = {}) {
  const transactionalHandler = jest.fn();
  const binding = Object.freeze({
    actionId: 'emr.nursing_note.draft.store',
    bindingId: 'emr.note_draft.store/v1',
    effectContract: 'private_draft_storage_only',
    fullRoutePath: '/api/v1/emr/notes/draft',
    method: 'PUT',
    schemaRecord: Object.freeze({
      checksum: '1'.repeat(64),
      id: 'emr.nursing_note.draft.store/v1',
      version: 1
    }),
    transactionalHandler
  });
  const envelope = {
    action_checksum: '2'.repeat(64),
    action_id: binding.actionId,
    action_version: 1,
    admission_id: null,
    app_version: '1.0.0',
    appointment_id: null,
    base_etag: null,
    base_revision: '0',
    cached_sources: { patient_identity: '2026-07-31T10:00:00.000Z' },
    capture_actor_uuid: UUIDS.actor,
    capture_role: 'NURSING_STAFF',
    capture_session_id: UUIDS.context,
    captured_at: '2026-07-31T10:00:00.000Z',
    client_event_id: UUIDS.event,
    clock_evidence: { trusted: true },
    command_fingerprint: '3'.repeat(64),
    device_id: UUIDS.device,
    device_posture: 'desktop',
    encounter_id: null,
    envelope_schema_version: 1,
    expires_at: '2026-08-01T10:00:00.000Z',
    facility_id: 41,
    human_review_required: false,
    idempotency_key: 'persisted-key',
    incident_id: null,
    minimum_app_version: '1.0.0',
    occurred_at: '2026-07-31T09:59:00.000Z',
    ordering_key: `draft:${UUIDS.patient}`,
    ordering_key_digest: '4'.repeat(64),
    patient_reference: UUIDS.patient,
    policy_checksum: '5'.repeat(64),
    policy_effective_from: '2026-07-31T09:00:00.000Z',
    policy_effective_until: '2026-08-01T12:00:00.000Z',
    policy_id: '10000000-0000-4000-8000-000000000009',
    policy_revocation_epoch: '1',
    policy_signing_key_id: 'policy-key',
    policy_supersedes_id: null,
    policy_version: '1',
    predecessor_client_event_id: null,
    queue_schema_version: 1,
    queued_at: '2026-07-31T10:01:00.000Z',
    registry_checksum: '6'.repeat(64),
    registry_version: '1',
    sequence: 1,
    source_cache_version: null,
    supersession_generation: 0,
    unit_id: null
  };
  return {
    authorization: {
      authorityClaims: { policyId: envelope.policy_id, policyVersion: '1' },
      requestContext: Object.freeze({ actionId: envelope.action_id })
    },
    binding,
    body: {
      content: { free_text: 'private draft' },
      note_type: 'nursing_assessment',
      patient_uid: UUIDS.patient
    },
    facilityContext: {
      contextId: UUIDS.context,
      contextRevision: '7',
      deviceId: UUIDS.device,
      facilityId: 41,
      grantId: UUIDS.grant,
      sessionJtiSha256: '7'.repeat(64)
    },
    parsed: {
      envelope,
      payloadHash: '8'.repeat(64),
      receiptFingerprint: '9'.repeat(64),
      sourceKind: 'electronic_queue'
    },
    replayActorUid: UUIDS.actor,
    replayRole: 'NURSING_STAFF',
    requestId: UUIDS.request,
    tenantId: UUIDS.tenant,
    ...overrides
  };
}

function existingReceipt(overrides = {}) {
  return {
    action_id: 'emr.nursing_note.draft.store',
    capture_actor_uid: UUIDS.actor,
    client_event_id: UUIDS.event,
    disposition: 'applied',
    draft_revision: 1n,
    draft_updated_at: new Date('2026-07-31T10:02:00.000Z'),
    facility_id: 41,
    note_draft_id: 91n,
    original_idempotency_key: 'persisted-key',
    outcome_code: 'draft_stored',
    patient_uid: UUIDS.patient,
    receipt_fingerprint: '9'.repeat(64),
    recorded_at: new Date('2026-07-31T10:02:00.000Z'),
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  evaluateClinicalContinuityActionRequest.mockResolvedValue({
    decision: 'allow',
    proceed: true
  });
});

test('precheck returns an authorized exact duplicate and appends its replay attempt', async () => {
  const tx = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    $queryRawUnsafe: jest.fn().mockResolvedValue([existingReceipt()])
  };
  setTenantTx.mockImplementation(async (_tenantId, callback, options) => {
    expect(options).toEqual({ isolationLevel: 'RepeatableRead' });
    return callback(tx);
  });

  await expect(precheckClinicalContinuityReplay(input())).resolves.toEqual({
    client_event_id: UUIDS.event,
    disposition: 'applied',
    outcome: 'draft_stored',
    replayed: true,
    resource: {
      note_draft_id: '91',
      revision: '1',
      updated_at: '2026-07-31T10:02:00.000Z'
    }
  });
  expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  expect(tx.$executeRawUnsafe.mock.calls[0][0]).toContain('clinical_continuity_replay_attempts');
});

test('precheck hides an unauthorized receipt and never returns its historical outcome', async () => {
  const tx = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    $queryRawUnsafe: jest
      .fn()
      .mockResolvedValue([
        existingReceipt({ capture_actor_uid: '20000000-0000-4000-8000-000000000001' })
      ])
  };
  setTenantTx.mockImplementation((_tenantId, callback) => callback(tx));

  await expect(precheckClinicalContinuityReplay(input())).rejects.toMatchObject({
    code: 'CONTINUITY_REPLAY_NOT_AUTHORIZED',
    statusCode: 409
  });
  expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
});

test('first apply uses the exact registered transaction handler and commits one typed draft outcome', async () => {
  const request = input();
  const draft = {
    id: 101n,
    revision: 1n,
    updated_at: new Date('2026-07-31T10:03:00.000Z')
  };
  request.binding.transactionalHandler.mockResolvedValue(draft);
  resolveClinicalContinuityActionBinding.mockReturnValue(request.binding);
  const tx = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    $queryRawUnsafe: jest
      .fn()
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([{ id: 77 }])
      .mockResolvedValueOnce([{ claimed: true }])
      .mockResolvedValueOnce([{ forbidden_effects: 0n }])
      .mockResolvedValueOnce([{ finalized: true }])
  };
  setTenantTx.mockImplementation(async (_tenantId, callback, options) => {
    expect(options).toEqual({ isolationLevel: 'Serializable' });
    return callback(tx);
  });

  await expect(applyClinicalContinuityReplay(request)).resolves.toEqual({
    client_event_id: UUIDS.event,
    disposition: 'applied',
    outcome: 'draft_stored',
    replayed: false,
    resource: {
      note_draft_id: '101',
      revision: '1',
      updated_at: '2026-07-31T10:03:00.000Z'
    }
  });
  expect(request.binding.transactionalHandler).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      authorUid: UUIDS.actor,
      patientUid: UUIDS.patient,
      tenantId: UUIDS.tenant
    }),
    { baseRevision: '0' }
  );
  const claimRecord = JSON.parse(tx.$queryRawUnsafe.mock.calls[2][2]);
  expect(claimRecord.patient_id).toBe(77);
  expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(2);
});

test('a shadow observation cannot claim a receipt or invoke the domain mutation', async () => {
  const request = input();
  resolveClinicalContinuityActionBinding.mockReturnValue(request.binding);
  evaluateClinicalContinuityActionRequest.mockResolvedValue({
    decision: 'would_allow',
    mode: 'shadow',
    proceed: false,
    reasonCode: 'CONTINUITY_ACTION_ALLOWED'
  });
  const phaseOneTx = {
    $executeRawUnsafe: jest.fn(),
    $queryRawUnsafe: jest
      .fn()
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([{ id: 77 }])
  };
  const reviewTx = { $executeRawUnsafe: jest.fn().mockResolvedValue(1) };
  setTenantTx
    .mockImplementationOnce((_tenantId, callback) => callback(phaseOneTx))
    .mockImplementationOnce((_tenantId, callback) => callback(reviewTx));

  await expect(applyClinicalContinuityReplay(request)).rejects.toMatchObject({
    code: 'CONTINUITY_ACTION_ALLOWED',
    statusCode: 409
  });
  expect(phaseOneTx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  expect(phaseOneTx.$executeRawUnsafe).not.toHaveBeenCalled();
  expect(request.binding.transactionalHandler).not.toHaveBeenCalled();
  expect(reviewTx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  expect(reviewTx.$executeRawUnsafe.mock.calls[0][0]).toContain(
    'clinical_continuity_replay_attempts'
  );
});

test('a draft CAS conflict commits needs_review without effect evidence', async () => {
  const request = input();
  request.binding.transactionalHandler.mockRejectedValue({
    code: 'CONTINUITY_REPLAY_CONCURRENCY_NEEDS_REVIEW'
  });
  resolveClinicalContinuityActionBinding.mockReturnValue(request.binding);
  const tx = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    $queryRawUnsafe: jest
      .fn()
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([{ id: 77 }])
      .mockResolvedValueOnce([{ claimed: true }])
      .mockResolvedValueOnce([{ finalized: true }])
  };
  setTenantTx.mockImplementation((_tenantId, callback) => callback(tx));

  await expect(applyClinicalContinuityReplay(request)).rejects.toMatchObject({
    code: 'CONTINUITY_REPLAY_CONCURRENCY_NEEDS_REVIEW',
    statusCode: 409
  });
  expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  expect(tx.$executeRawUnsafe.mock.calls[0][0]).toContain('clinical_continuity_replay_attempts');
});

test('an unexpected effect failure rolls back and records a separate failure attempt', async () => {
  const request = input();
  request.binding.transactionalHandler.mockResolvedValue({
    id: 101n,
    revision: 1n,
    updated_at: new Date('2026-07-31T10:03:00.000Z')
  });
  resolveClinicalContinuityActionBinding.mockReturnValue(request.binding);
  const phaseOneTx = {
    $executeRawUnsafe: jest.fn().mockRejectedValueOnce(new Error('effect evidence failed')),
    $queryRawUnsafe: jest
      .fn()
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce([{ id: 77 }])
      .mockResolvedValueOnce([{ claimed: true }])
  };
  const failureTx = { $executeRawUnsafe: jest.fn().mockResolvedValue(1) };
  setTenantTx
    .mockImplementationOnce((_tenantId, callback) => callback(phaseOneTx))
    .mockImplementationOnce((_tenantId, callback) => callback(failureTx));

  await expect(applyClinicalContinuityReplay(request)).rejects.toThrow('effect evidence failed');
  expect(setTenantTx).toHaveBeenCalledTimes(2);
  expect(failureTx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  expect(failureTx.$executeRawUnsafe.mock.calls[0][0]).toContain(
    'clinical_continuity_replay_attempts'
  );
});

test('a failed transactional authorization recheck records a post-rollback review attempt', async () => {
  const request = input();
  const phaseOneTx = {
    $executeRawUnsafe: jest.fn(),
    $queryRawUnsafe: jest.fn().mockResolvedValue([])
  };
  const reviewTx = { $executeRawUnsafe: jest.fn().mockResolvedValue(1) };
  setTenantTx
    .mockImplementationOnce((_tenantId, callback) => callback(phaseOneTx))
    .mockImplementationOnce((_tenantId, callback) => callback(reviewTx));

  await expect(applyClinicalContinuityReplay(request)).rejects.toMatchObject({
    code: 'CONTINUITY_REPLAY_FACILITY_RECHECK_FAILED',
    statusCode: 409
  });
  expect(setTenantTx).toHaveBeenCalledTimes(2);
  expect(reviewTx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  expect(reviewTx.$executeRawUnsafe.mock.calls[0]).toEqual(
    expect.arrayContaining([
      'transaction_review',
      'CONTINUITY_REPLAY_FACILITY_RECHECK_FAILED',
      'needs_review'
    ])
  );
});

test('a serializable conflict retries with the same persisted command identity', async () => {
  const request = input();
  const committed = {
    client_event_id: UUIDS.event,
    disposition: 'applied',
    outcome: 'draft_stored',
    replayed: true,
    resource: {
      note_draft_id: '101',
      revision: '1',
      updated_at: '2026-07-31T10:03:00.000Z'
    }
  };
  setTenantTx
    .mockRejectedValueOnce(Object.assign(new Error('serialization failure'), { code: 'P2034' }))
    .mockResolvedValueOnce(committed);

  await expect(applyClinicalContinuityReplay(request)).resolves.toBe(committed);
  expect(setTenantTx).toHaveBeenCalledTimes(2);
  expect(setTenantTx.mock.calls[0][0]).toBe(UUIDS.tenant);
  expect(setTenantTx.mock.calls[1][0]).toBe(UUIDS.tenant);
});

test('receipt projection carries server-derived binding and target keys, never server timestamps', () => {
  const request = input();
  const record = __testing__.receiptRecord({
    ...request,
    targetPatientId: 77
  });
  expect(record).toMatchObject({
    binding_id: 'emr.note_draft.store/v1',
    http_method: 'PUT',
    patient_id: 77,
    patient_uid: UUIDS.patient,
    source_kind: 'electronic_queue'
  });
  expect(record).not.toHaveProperty('received_at');
  expect(record).not.toHaveProperty('recorded_at');
  expect(record).not.toHaveProperty('detailed_evidence_until');
});
