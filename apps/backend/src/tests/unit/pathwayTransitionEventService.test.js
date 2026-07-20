import { jest } from '@jest/globals';

const recordCanonicalClinicalEvent = jest.fn();
const tenantTransactionClients = new WeakSet();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  isTenantTransactionClient: value => tenantTransactionClients.has(value)
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: value => value
}));

const {
  appendPathwayTransitionEventTx,
  appendPathwayTransitionEventsBatchTx,
  findPathwayTransitionReplayTx
} = await import('../../services/pathways/pathwayTransitionEventService.js');
const { createRegisteredWorkflowSystemActor, createWorkflowRuntimeRegistry } =
  await import('../../services/workflow/workflowRuntimeRegistry.js');

const TENANT_ID = '1abcdeff-1111-4111-8111-111111111111';
const INSTANCE_ID = '2abcdeff-2222-4222-8222-222222222222';
const OTHER_INSTANCE_ID = '2aaaaaaa-2222-4222-8222-222222222222';
const PATIENT_UID = '33333333-3333-4333-8333-333333333333';
const ENCOUNTER_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR_UID = '55555555-5555-4555-8555-555555555555';
const SLA_ID = '66666666-6666-4666-8666-666666666666';
const TIMELINE_ID = '77777777-7777-4777-8777-777777777777';
const AUDIT_ID = '88888888-8888-4888-8888-888888888888';
const FINGERPRINT = 'a'.repeat(64);
const OTHER_FINGERPRINT = 'b'.repeat(64);
const IDEMPOTENCY_KEY = 'pathway-command:source:42';

function sealedSignalContext() {
  return {
    sourceResourceType: 'event_outbox',
    sourceResourceId: '42',
    occurredAt: '2026-07-19T10:00:00Z'
  };
}

const INSTANCE = Object.freeze({
  id: INSTANCE_ID,
  tenant_id: TENANT_ID,
  workflow_run_id: 12,
  patient_uid: PATIENT_UID,
  encounter_id: ENCOUNTER_ID,
  pathway_key: 'synthetic_pathway',
  pathway_version: 1,
  source_episode_type: 'synthetic_order',
  source_episode_id: 'order-42',
  patient_visibility_status: 'hidden',
  clinical_status: 'active',
  metadata: {}
});

const USER_ACTOR = Object.freeze({
  kind: 'user',
  uid: ACTOR_UID,
  roles: ['doctor', 'CLINICAL_STAFF', 'doctor'],
  authorizationMode: 'assigned_user'
});

function existingEvent(overrides = {}) {
  return {
    id: '99999999-9999-4999-8999-999999999999',
    tenant_id: TENANT_ID,
    pathway_instance_id: INSTANCE_ID,
    idempotency_key: IDEMPOTENCY_KEY,
    command_fingerprint: FINGERPRINT,
    effect_ordinal: 0,
    sequence_number: 1,
    ...overrides
  };
}

function createTx({
  instance = INSTANCE,
  events = [],
  nextSequence = 1,
  insertResult = null
} = {}) {
  const tx = {
    $queryRawUnsafe: jest.fn(async (sql, ...params) => {
      if (sql.includes('FROM care_pathway_instances')) return instance ? [instance] : [];
      if (sql.includes('pg_advisory_xact_lock')) return [{ command_locked: null }];
      if (sql.includes('ORDER BY effect_ordinal ASC')) return events;
      if (sql.includes('MAX(sequence_number)')) return [{ next_sequence: nextSequence }];
      if (sql.includes('INSERT INTO care_pathway_transition_events')) {
        return [
          insertResult || {
            id: params[0],
            tenant_id: params[1],
            pathway_instance_id: params[2],
            patient_uid: params[3],
            workflow_run_id: params[4],
            sequence_number: params[5],
            effect_ordinal: params[21]
          }
        ];
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    })
  };
  tenantTransactionClients.add(tx);
  return tx;
}

function appendInput(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    pathwayInstanceId: INSTANCE_ID,
    workflowRunId: 12,
    workflowStepId: 7,
    idempotencyKey: IDEMPOTENCY_KEY,
    commandFingerprint: FINGERPRINT,
    effectOrdinal: 0,
    transitionScope: 'step',
    transitionKey: 'step.completed',
    stageKey: 'review_result',
    previousState: { status: 'running' },
    newState: { status: 'completed' },
    sourceResourceType: 'lab_result',
    sourceResourceId: 'result-42',
    workflowSlaInstanceId: SLA_ID,
    occurredAt: '2026-07-19T10:00:00.000Z',
    actor: USER_ACTOR,
    eventPayload: { decision: 'satisfied' },
    metadata: { pathway_mode: 'shadow' },
    ...overrides
  };
}

function batchIntent(ordinal, overrides = {}) {
  return {
    workflowStepId: 7 + ordinal,
    transitionScope: 'step',
    transitionKey: `step.effect_${ordinal}`,
    stageKey: `stage_${ordinal}`,
    previousState: { status: ordinal === 0 ? 'running' : 'pending' },
    newState: { status: 'completed' },
    sourceResourceType: 'lab_result',
    sourceResourceId: `result-${ordinal}`,
    workflowSlaInstanceId: SLA_ID,
    eventPayload: { ordinal },
    metadata: { pathway_mode: 'shadow' },
    ...overrides
  };
}

function batchInput(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    pathwayInstanceId: INSTANCE_ID,
    workflowRunId: 12,
    idempotencyKey: IDEMPOTENCY_KEY,
    commandFingerprint: FINGERPRINT,
    occurredAt: '2026-07-19T10:00:00.000Z',
    actor: USER_ACTOR,
    intents: [batchIntent(0), batchIntent(1)],
    ...overrides
  };
}

function sqlCalls(tx, fragment) {
  return tx.$queryRawUnsafe.mock.calls.filter(([sql]) => sql.includes(fragment));
}

beforeEach(() => {
  jest.clearAllMocks();
  recordCanonicalClinicalEvent.mockResolvedValue({
    timeline: { id: TIMELINE_ID },
    audit: { id: AUDIT_ID }
  });
});

describe('pathway transition replay', () => {
  it('requires an existing transaction', async () => {
    await expect(
      findPathwayTransitionReplayTx({
        tenantId: TENANT_ID.toUpperCase(),
        pathwayInstanceId: INSTANCE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        commandFingerprint: FINGERPRINT
      })
    ).rejects.toMatchObject({
      statusCode: 500,
      code: 'PATHWAY_TRANSITION_TX_REQUIRED'
    });

    const singleton = {
      $queryRawUnsafe: jest.fn(),
      $transaction: jest.fn()
    };
    await expect(
      findPathwayTransitionReplayTx({
        tx: singleton,
        tenantId: TENANT_ID,
        pathwayInstanceId: INSTANCE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        commandFingerprint: FINGERPRINT
      })
    ).rejects.toMatchObject({
      statusCode: 500,
      code: 'PATHWAY_TRANSITION_TX_REQUIRED'
    });
    expect(singleton.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('locks the instance and command key before reporting a miss', async () => {
    const tx = createTx();

    await expect(
      findPathwayTransitionReplayTx({
        tx,
        tenantId: TENANT_ID,
        pathwayInstanceId: INSTANCE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        commandFingerprint: FINGERPRINT
      })
    ).resolves.toEqual({
      pathwayInstance: INSTANCE,
      events: [],
      event: null,
      replayed: false
    });

    expect(tx.$queryRawUnsafe.mock.calls).toHaveLength(3);
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(tx.$queryRawUnsafe.mock.calls[1][0]).toContain('pg_advisory_xact_lock');
    expect(tx.$queryRawUnsafe.mock.calls[1][1]).toBe(`${TENANT_ID}:${IDEMPOTENCY_KEY}`);
    expect(tx.$queryRawUnsafe.mock.calls[2][0]).toContain('ORDER BY effect_ordinal ASC');
  });

  it('conflicts when a command key is reused with different input', async () => {
    const tx = createTx({ events: [existingEvent()] });

    await expect(
      findPathwayTransitionReplayTx({
        tx,
        tenantId: TENANT_ID,
        pathwayInstanceId: INSTANCE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        commandFingerprint: OTHER_FINGERPRINT
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PATHWAY_IDEMPOTENCY_KEY_REUSED'
    });
  });

  it('conflicts when a tenant command key is bound to another instance', async () => {
    const tx = createTx({
      events: [existingEvent({ pathway_instance_id: OTHER_INSTANCE_ID })]
    });

    await expect(
      findPathwayTransitionReplayTx({
        tx,
        tenantId: TENANT_ID,
        pathwayInstanceId: INSTANCE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        commandFingerprint: FINGERPRINT
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PATHWAY_IDEMPOTENCY_KEY_REUSED'
    });
  });

  it('canonicalizes UUID case before matching committed replay evidence', async () => {
    const prior = existingEvent();
    const tx = createTx({ events: [prior] });

    await expect(
      findPathwayTransitionReplayTx({
        tx,
        tenantId: TENANT_ID.toUpperCase(),
        pathwayInstanceId: INSTANCE_ID.toUpperCase(),
        idempotencyKey: IDEMPOTENCY_KEY,
        commandFingerprint: FINGERPRINT,
        effectOrdinal: 0
      })
    ).resolves.toMatchObject({ replayed: true, event: prior });
    expect(tx.$queryRawUnsafe.mock.calls[0][1]).toBe(TENANT_ID);
    expect(tx.$queryRawUnsafe.mock.calls[0][2]).toBe(INSTANCE_ID);
  });

  it('rejects a corrupt non-contiguous committed effect group', async () => {
    const tx = createTx({ events: [existingEvent({ effect_ordinal: 1 })] });

    await expect(
      findPathwayTransitionReplayTx({
        tx,
        tenantId: TENANT_ID,
        pathwayInstanceId: INSTANCE_ID,
        idempotencyKey: IDEMPOTENCY_KEY,
        commandFingerprint: FINGERPRINT
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PATHWAY_EFFECT_SEQUENCE_INVALID'
    });
  });
});

describe('pathway transition batch append', () => {
  it('loads replay and sequence state once for a large contiguous batch', async () => {
    const tx = createTx({ nextSequence: 41 });
    const intents = Array.from({ length: 64 }, (_, ordinal) => batchIntent(ordinal));

    const result = await appendPathwayTransitionEventsBatchTx(batchInput({ tx, intents }));

    expect(result.replayed).toBe(false);
    expect(result.events).toHaveLength(64);
    expect(result.events.map(event => event.sequence_number)).toEqual(
      Array.from({ length: 64 }, (_, index) => 41 + index)
    );
    expect(result.events.map(event => event.effect_ordinal)).toEqual(
      Array.from({ length: 64 }, (_, index) => index)
    );
    expect(sqlCalls(tx, 'ORDER BY effect_ordinal ASC')).toHaveLength(1);
    expect(sqlCalls(tx, 'MAX(sequence_number)')).toHaveLength(1);
    expect(sqlCalls(tx, 'INSERT INTO care_pathway_transition_events')).toHaveLength(64);
    expect(recordCanonicalClinicalEvent).toHaveBeenCalledTimes(64);
  });

  it('fails before the next canonical write when a batch exhausts integer sequences', async () => {
    const tx = createTx({ nextSequence: 2_147_483_647 });

    await expect(appendPathwayTransitionEventsBatchTx(batchInput({ tx }))).rejects.toMatchObject({
      statusCode: 500,
      code: 'PATHWAY_TRANSITION_SEQUENCE_FAILED'
    });
    expect(sqlCalls(tx, 'ORDER BY effect_ordinal ASC')).toHaveLength(1);
    expect(sqlCalls(tx, 'MAX(sequence_number)')).toHaveLength(1);
    expect(sqlCalls(tx, 'INSERT INTO care_pathway_transition_events')).toHaveLength(1);
    expect(recordCanonicalClinicalEvent).toHaveBeenCalledTimes(1);
  });

  it('returns only a complete replay group without sequence or evidence writes', async () => {
    const prior = [
      existingEvent(),
      existingEvent({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        effect_ordinal: 1,
        sequence_number: 2
      })
    ];
    const tx = createTx({ events: prior });

    await expect(appendPathwayTransitionEventsBatchTx(batchInput({ tx }))).resolves.toEqual({
      events: prior,
      replayed: true,
      pathwayInstance: INSTANCE
    });
    expect(sqlCalls(tx, 'ORDER BY effect_ordinal ASC')).toHaveLength(1);
    expect(sqlCalls(tx, 'MAX(sequence_number)')).toHaveLength(0);
    expect(sqlCalls(tx, 'INSERT INTO care_pathway_transition_events')).toHaveLength(0);
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  it('fails closed on a partial replay group instead of resuming effects', async () => {
    const tx = createTx({ events: [existingEvent()] });

    await expect(appendPathwayTransitionEventsBatchTx(batchInput({ tx }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'PATHWAY_TRANSITION_BATCH_REPLAY_INCOMPLETE'
    });
    expect(sqlCalls(tx, 'ORDER BY effect_ordinal ASC')).toHaveLength(1);
    expect(sqlCalls(tx, 'MAX(sequence_number)')).toHaveLength(0);
    expect(sqlCalls(tx, 'INSERT INTO care_pathway_transition_events')).toHaveLength(0);
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  it('preserves replay fingerprint conflicts before any canonical write', async () => {
    const tx = createTx({
      events: [existingEvent(), existingEvent({ effect_ordinal: 1, sequence_number: 2 })]
    });

    await expect(
      appendPathwayTransitionEventsBatchTx(
        batchInput({
          tx,
          commandFingerprint: OTHER_FINGERPRINT
        })
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PATHWAY_IDEMPOTENCY_KEY_REUSED'
    });
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  it('prevalidates every intent and owns effect ordinals before database access', async () => {
    const tx = createTx();

    await expect(
      appendPathwayTransitionEventsBatchTx(
        batchInput({
          tx,
          intents: [batchIntent(0), batchIntent(1, { sourceResourceId: null })]
        })
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'PATHWAY_TRANSITION_SOURCE_PAIR_REQUIRED'
    });
    await expect(
      appendPathwayTransitionEventsBatchTx(
        batchInput({
          tx,
          intents: [batchIntent(0, { effectOrdinal: 7 })]
        })
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'PATHWAY_TRANSITION_BATCH_ORDINAL_FORBIDDEN'
    });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });
});

describe('pathway transition append', () => {
  it('enforces exact JSON byte ceilings before durable transition writes', async () => {
    const maxBytes = 65536;
    const emptyBytes = Buffer.byteLength(JSON.stringify({ value: '' }), 'utf8');
    const exact = { value: 'a'.repeat(maxBytes - emptyBytes) };
    const exactTx = createTx();
    await expect(appendPathwayTransitionEventTx(appendInput({
      tx: exactTx,
      previousState: exact
    }))).resolves.toMatchObject({ replayed: false });

    const overTx = createTx();
    await expect(appendPathwayTransitionEventTx(appendInput({
      tx: overTx,
      previousState: { value: `${exact.value}a` }
    }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'PATHWAY_TRANSITION_JSON_LIMIT_EXCEEDED'
    });
    expect(overTx.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEvent).toHaveBeenCalledTimes(1);
  });

  it('rechecks composed canonical metadata and rejects sparse or BigInt JSON', async () => {
    const metadataOverhead = Buffer.byteLength(JSON.stringify({ value: '' }), 'utf8');
    const compositeTx = createTx();
    await expect(appendPathwayTransitionEventTx(appendInput({
      tx: compositeTx,
      metadata: { value: 'a'.repeat(65536 - metadataOverhead) }
    }))).rejects.toMatchObject({ code: 'PATHWAY_TRANSITION_JSON_LIMIT_EXCEEDED' });
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();

    const sparse = new Array(1);
    await expect(appendPathwayTransitionEventTx(appendInput({
      tx: createTx(),
      eventPayload: { sparse }
    }))).rejects.toMatchObject({ code: 'PATHWAY_TRANSITION_BAD_JSON' });
    await expect(appendPathwayTransitionEventTx(appendInput({
      tx: createTx(),
      eventPayload: { unsafe_bigint: 42n }
    }))).rejects.toMatchObject({ code: 'PATHWAY_TRANSITION_BAD_JSON' });
  });

  it('normalizes a non-UTC instant once across canonical, payload, and transition writes', async () => {
    const tx = createTx();
    const expectedInstant = '2026-07-19T04:30:00.000Z';

    await appendPathwayTransitionEventTx(
      appendInput({
        tx,
        occurredAt: '2026-07-19T10:00:00+05:30'
      })
    );

    const [canonicalInput] = recordCanonicalClinicalEvent.mock.calls[0];
    expect(canonicalInput.occurredAt).toBe(expectedInstant);
    expect(canonicalInput.payload.occurred_at).toBe(expectedInstant);
    const insertCall = sqlCalls(tx, 'INSERT INTO care_pathway_transition_events')[0];
    expect(insertCall[19]).toBe(expectedInstant);
  });

  it('writes authoritative immutable evidence and its strict canonical pair', async () => {
    const tx = createTx({ nextSequence: 3 });
    const eventPayload = {
      tenant_id: 'spoofed-tenant',
      pathway_instance_id: OTHER_INSTANCE_ID,
      patient_uid: OTHER_INSTANCE_ID,
      actor_uid: OTHER_INSTANCE_ID,
      sequence_number: 999,
      transition_scope: 'pathway',
      command_fingerprint: OTHER_FINGERPRINT,
      effect_ordinal: 99,
      canonical_timeline_event_id: OTHER_INSTANCE_ID,
      canonical_audit_event_id: OTHER_INSTANCE_ID,
      decision: 'satisfied'
    };

    const result = await appendPathwayTransitionEventTx(
      appendInput({
        tx,
        eventPayload,
        metadata: {
          pathway_mode: 'shadow',
          command_fingerprint: OTHER_FINGERPRINT,
          provenance: { kind: 'spoofed' }
        }
      })
    );

    expect(result).toMatchObject({
      replayed: false,
      pathwayInstance: INSTANCE,
      event: {
        tenant_id: TENANT_ID,
        pathway_instance_id: INSTANCE_ID,
        patient_uid: PATIENT_UID,
        workflow_run_id: 12,
        sequence_number: 3,
        effect_ordinal: 0
      }
    });
    expect(recordCanonicalClinicalEvent).toHaveBeenCalledTimes(1);
    const [canonicalInput, canonicalOptions] = recordCanonicalClinicalEvent.mock.calls[0];
    expect(canonicalOptions).toEqual({ db: tx, strict: true });
    expect(canonicalInput).toMatchObject({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      encounterId: ENCOUNTER_ID,
      sourceTable: 'care_pathway_transition_events',
      eventType: 'care_pathway.transition',
      action: 'care_pathway.transition',
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
      visibleToPatient: false,
      beforeState: { status: 'running' },
      afterState: { status: 'completed' },
      payload: {
        tenant_id: TENANT_ID,
        pathway_instance_id: INSTANCE_ID,
        patient_uid: PATIENT_UID,
        actor_uid: ACTOR_UID,
        workflow_run_id: 12,
        workflow_step_id: 7,
        sequence_number: 3,
        transition_scope: 'step',
        transition_key: 'step.completed',
        command_fingerprint: FINGERPRINT,
        effect_ordinal: 0,
        decision: 'satisfied'
      },
      metadata: {
        pathway_mode: 'shadow',
        command_fingerprint: FINGERPRINT,
        effect_ordinal: 0,
        provenance: {
          kind: 'user',
          roles: ['DOCTOR', 'CLINICAL_STAFF'],
          primary_role: 'DOCTOR',
          authorization_mode: 'assigned_user',
          override_reason: null,
          break_glass_id: null
        }
      }
    });
    expect(canonicalInput.sourceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(canonicalInput.payload).not.toHaveProperty('canonical_timeline_event_id');
    expect(canonicalInput.payload).not.toHaveProperty('canonical_audit_event_id');
    expect(canonicalInput.timelineIdempotencyKey).toBe(
      `care_pathway_transition_events:${canonicalInput.sourceId}:timeline`
    );
    expect(canonicalInput.auditIdempotencyKey).toBe(
      `care_pathway_transition_events:${canonicalInput.sourceId}:audit`
    );

    const insertCall = sqlCalls(tx, 'INSERT INTO care_pathway_transition_events')[0];
    expect(insertCall).toBeDefined();
    expect(insertCall.slice(1, 7)).toEqual([
      canonicalInput.sourceId,
      TENANT_ID,
      INSTANCE_ID,
      PATIENT_UID,
      12,
      3
    ]);
    expect(insertCall[16]).toBe(ACTOR_UID);
    expect(insertCall[17]).toBeNull();
    expect(insertCall[18]).toBe('DOCTOR');
    expect(insertCall[23]).toBe(TIMELINE_ID);
    expect(insertCall[24]).toBe(AUDIT_ID);
    expect(JSON.parse(insertCall[25])).toEqual(canonicalInput.payload);
    expect(JSON.parse(insertCall[26])).toEqual(canonicalInput.metadata);
  });

  it('returns an existing ordinal without canonical or insert writes', async () => {
    const prior = existingEvent();
    const tx = createTx({ events: [prior] });

    await expect(appendPathwayTransitionEventTx(appendInput({ tx }))).resolves.toEqual({
      event: prior,
      replayed: true,
      pathwayInstance: INSTANCE
    });
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
    expect(sqlCalls(tx, 'MAX(sequence_number)')).toHaveLength(0);
    expect(sqlCalls(tx, 'INSERT INTO care_pathway_transition_events')).toHaveLength(0);
  });

  it('appends only the next contiguous effect ordinal', async () => {
    const tx = createTx({ events: [existingEvent()] });

    await expect(
      appendPathwayTransitionEventTx(
        appendInput({
          tx,
          effectOrdinal: 2
        })
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PATHWAY_EFFECT_ORDINAL_GAP'
    });
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  it('rejects a mismatched workflow run before sequence or canonical writes', async () => {
    const tx = createTx();

    await expect(
      appendPathwayTransitionEventTx(
        appendInput({
          tx,
          workflowRunId: 13
        })
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PATHWAY_RUN_CONTEXT_MISMATCH'
    });
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
    expect(sqlCalls(tx, 'MAX(sequence_number)')).toHaveLength(0);
  });

  it('fails closed when either canonical reference is absent', async () => {
    const tx = createTx();
    recordCanonicalClinicalEvent.mockResolvedValue({
      timeline: { id: TIMELINE_ID },
      audit: null
    });

    await expect(appendPathwayTransitionEventTx(appendInput({ tx }))).rejects.toMatchObject({
      statusCode: 500,
      code: 'PATHWAY_CANONICAL_WRITE_FAILED'
    });
    expect(sqlCalls(tx, 'INSERT INTO care_pathway_transition_events')).toHaveLength(0);
  });

  it('requires schema-supported scopes and a complete typed source pair', async () => {
    const tx = createTx();

    await expect(
      appendPathwayTransitionEventTx(
        appendInput({
          tx,
          transitionScope: 'workflow_step'
        })
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'PATHWAY_TRANSITION_BAD_SCOPE'
    });
    await expect(
      appendPathwayTransitionEventTx(
        appendInput({
          tx,
          sourceResourceId: null
        })
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'PATHWAY_TRANSITION_SOURCE_PAIR_REQUIRED'
    });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('requires explicit user authorization provenance and override reason', async () => {
    const tx = createTx();

    await expect(
      appendPathwayTransitionEventTx(
        appendInput({
          tx,
          actor: { kind: 'user', uid: ACTOR_UID, roles: ['DOCTOR'] }
        })
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'PATHWAY_TRANSITION_FIELD_REQUIRED'
    });
    await expect(
      appendPathwayTransitionEventTx(
        appendInput({
          tx,
          actor: {
            kind: 'user',
            uid: ACTOR_UID,
            roles: ['ADMIN'],
            authorizationMode: 'audited_override'
          }
        })
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'PATHWAY_TRANSITION_OVERRIDE_REASON_REQUIRED'
    });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('requires and records active patient-access break-glass provenance', async () => {
    const tx = createTx();
    const incompleteActor = {
      kind: 'user',
      uid: ACTOR_UID,
      roles: ['DOCTOR'],
      authorizationMode: 'patient_access_break_glass',
      overrideReason: 'Emergency review'
    };

    await expect(
      appendPathwayTransitionEventTx(
        appendInput({
          tx,
          actor: incompleteActor
        })
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'PATHWAY_TRANSITION_BREAK_GLASS_CONTEXT_REQUIRED'
    });
    await expect(
      appendPathwayTransitionEventTx(
        appendInput({
          tx,
          actor: { ...incompleteActor, breakGlassId: 0 }
        })
      )
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'PATHWAY_TRANSITION_BAD_INTEGER'
    });

    await appendPathwayTransitionEventTx(
      appendInput({
        tx,
        actor: { ...incompleteActor, breakGlassId: 42 }
      })
    );
    expect(recordCanonicalClinicalEvent.mock.calls[0][0].metadata.provenance).toEqual({
      kind: 'user',
      roles: ['DOCTOR'],
      primary_role: 'DOCTOR',
      authorization_mode: 'patient_access_break_glass',
      override_reason: 'Emergency review',
      break_glass_id: 42
    });
  });

  it('attributes a multi-role transition to the authenticated primary role', async () => {
    const tx = createTx();

    await appendPathwayTransitionEventTx(
      appendInput({
        tx,
        actor: {
          kind: 'user',
          uid: ACTOR_UID,
          roles: ['DOCTOR', 'NURSING_STAFF'],
          primaryRole: 'NURSING_STAFF',
          authorizationMode: 'assigned_user'
        }
      })
    );

    const [canonicalInput] = recordCanonicalClinicalEvent.mock.calls[0];
    expect(canonicalInput.actorRole).toBe('NURSING_STAFF');
    expect(canonicalInput.metadata.provenance).toMatchObject({
      roles: ['DOCTOR', 'NURSING_STAFF'],
      primary_role: 'NURSING_STAFF'
    });
    const insertCall = sqlCalls(tx, 'INSERT INTO care_pathway_transition_events')[0];
    expect(insertCall[18]).toBe('NURSING_STAFF');
  });

  it('rejects a primary role that is noncanonical or absent from actor roles', async () => {
    const tx = createTx();

    for (const primaryRole of ['nursing_staff', 'NURSING_STAFF']) {
      await expect(
        appendPathwayTransitionEventTx(
          appendInput({
            tx,
            actor: {
              kind: 'user',
              uid: ACTOR_UID,
              roles: ['DOCTOR'],
              primaryRole,
              authorizationMode: 'assigned_user'
            }
          })
        )
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'PATHWAY_TRANSITION_BAD_PRIMARY_ROLE'
      });
    }
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('rejects an unsealed or copied system actor before database access', async () => {
    const tx = createTx();
    const registry = createWorkflowRuntimeRegistry({
      version: 101,
      systemActors: ['synthetic.projector.v1']
    });
    const sealedActor = createRegisteredWorkflowSystemActor({
      registry,
      systemKey: 'synthetic.projector.v1',
      sourceEventId: '42',
      causationId: 'event-outbox:42',
      signalContext: sealedSignalContext()
    });

    for (const actor of [
      {
        kind: 'system',
        systemKey: 'synthetic.projector.v1',
        sourceEventId: '42',
        causationId: 'event-outbox:42'
      },
      { ...sealedActor }
    ]) {
      await expect(
        appendPathwayTransitionEventTx(
          appendInput({
            tx,
            actor,
            registry
          })
        )
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'PATHWAY_SYSTEM_ACTOR_NOT_REGISTERED'
      });
    }
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('binds a sealed system actor to the exact command registry', async () => {
    const tx = createTx();
    const registryA = createWorkflowRuntimeRegistry({
      version: 102,
      systemActors: ['synthetic.projector.v1']
    });
    const registryB = createWorkflowRuntimeRegistry({
      version: 103,
      systemActors: ['synthetic.projector.v1']
    });
    const actor = createRegisteredWorkflowSystemActor({
      registry: registryA,
      systemKey: 'synthetic.projector.v1',
      sourceEventId: '42',
      signalContext: sealedSignalContext()
    });

    for (const registry of [undefined, registryB]) {
      await expect(
        appendPathwayTransitionEventTx(
          appendInput({
            tx,
            actor,
            ...(registry ? { registry } : {})
          })
        )
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'PATHWAY_SYSTEM_ACTOR_NOT_REGISTERED'
      });
    }
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('records sealed system provenance without attributing a user', async () => {
    const tx = createTx();
    const registry = createWorkflowRuntimeRegistry({
      version: 104,
      systemActors: ['synthetic.projector.v1']
    });
    const actor = createRegisteredWorkflowSystemActor({
      registry,
      systemKey: 'synthetic.projector.v1',
      sourceEventId: '9223372036854775807',
      causationId: 'event-outbox:9223372036854775807',
      signalContext: sealedSignalContext()
    });

    await appendPathwayTransitionEventTx(appendInput({ tx, actor, registry }));

    const [canonicalInput] = recordCanonicalClinicalEvent.mock.calls[0];
    expect(canonicalInput).toMatchObject({ actorUid: null, actorRole: null });
    expect(canonicalInput.metadata.provenance).toEqual({
      kind: 'system',
      system_key: 'synthetic.projector.v1',
      source_event_id: '9223372036854775807',
      causation_id: 'event-outbox:9223372036854775807'
    });
    const insertCall = sqlCalls(tx, 'INSERT INTO care_pathway_transition_events')[0];
    expect(insertCall[16]).toBeNull();
    expect(insertCall[17]).toBe('synthetic.projector.v1');
    expect(insertCall[18]).toBeNull();
  });

  it('rejects unsafe numeric system event ids without losing BIGINT precision', async () => {
    const tx = createTx();
    const registry = createWorkflowRuntimeRegistry({
      version: 105,
      systemActors: ['synthetic.projector.v1']
    });
    expect(() =>
      createRegisteredWorkflowSystemActor({
        registry,
        systemKey: 'synthetic.projector.v1',
        sourceEventId: Number.MAX_SAFE_INTEGER + 1,
        signalContext: sealedSignalContext()
      })
    ).toThrow(/safe non-negative integer/);
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEvent).not.toHaveBeenCalled();
  });

  it('rejects system event ids above the PostgreSQL BIGINT range', async () => {
    const tx = createTx();
    const registry = createWorkflowRuntimeRegistry({
      version: 106,
      systemActors: ['synthetic.projector.v1']
    });
    expect(() =>
      createRegisteredWorkflowSystemActor({
        registry,
        systemKey: 'synthetic.projector.v1',
        sourceEventId: '9223372036854775808',
        signalContext: sealedSignalContext()
      })
    ).toThrow(/exceeds PostgreSQL BIGINT/);
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});
