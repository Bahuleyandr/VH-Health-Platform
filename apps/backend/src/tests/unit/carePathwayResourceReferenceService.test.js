import { jest } from '@jest/globals';

import {
  CARE_PATHWAY_RESOURCE_TYPES,
  __testing__,
  appendPathwayResourceReferenceTx,
  resolvePathwayResourceTx,
  supersedePathwayResourceReferenceTx,
} from '../../services/pathways/carePathwayResourceReferenceService.js';
import {
  createRegisteredWorkflowSystemActor,
  workflowRuntimeRegistryV4,
} from '../../services/workflow/workflowRuntimeRegistry.js';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PATIENT_UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PATHWAY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REFERENCE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OWNER_UID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const HANDOFF_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const OCCURRED_AT = '2026-07-23T12:00:00.000Z';

function registeredSystemActor() {
  return createRegisteredWorkflowSystemActor({
    registry: workflowRuntimeRegistryV4,
    systemKey: 'op.pathway_projector.v1',
    sourceEventId: '9001',
    causationId: 'event_outbox:9001',
    signalContext: {
      sourceResourceType: 'event_outbox',
      sourceResourceId: '9001',
      occurredAt: OCCURRED_AT,
    },
  });
}

function input(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    pathwayInstanceId: PATHWAY_ID,
    patientUid: PATIENT_UID,
    resourceType: 'appointment',
    relationshipKind: 'closure_evidence',
    evidenceState: 'open',
    resourceId: '42',
    sourceOutboxEventId: '9001',
    actor: registeredSystemActor(),
    occurredAt: OCCURRED_AT,
    idempotencyKey: 'op:42:root-reference',
    metadata: { event_type: 'appointment.created' },
    ...overrides,
  };
}

function storedRow(overrides = {}) {
  return {
    id: REFERENCE_ID,
    tenant_id: TENANT_ID,
    pathway_instance_id: PATHWAY_ID,
    patient_uid: PATIENT_UID,
    resource_type: 'appointment',
    relationship_kind: 'closure_evidence',
    evidence_state: 'open',
    resource_id: '42',
    accepted_owner_uid: null,
    task_id: null,
    handoff_id: null,
    source_outbox_event_id: 9001n,
    canonical_timeline_event_id: null,
    canonical_audit_event_id: null,
    actor_uid: null,
    actor_system_key: 'op.pathway_projector.v1',
    occurred_at: new Date(OCCURRED_AT),
    recorded_at: new Date(OCCURRED_AT),
    idempotency_key: 'op:42:root-reference',
    superseded_reference_id: null,
    metadata: { event_type: 'appointment.created' },
    ...overrides,
  };
}

describe('carePathwayResourceReferenceService', () => {
  test('freezes the exact migration-595 resource vocabulary and fixed resolvers', () => {
    expect(CARE_PATHWAY_RESOURCE_TYPES).toEqual([
      'appointment',
      'admission',
      'e_prescription',
      'clinical_order',
      'investigation',
      'lab_result',
      'radiology_order',
      'anatomical_pathology_case',
      'diagnostic_result_generation',
      'referral',
      'follow_up_plan',
      'clinical_note',
      'discharge_summary',
      'discharge_consult',
    ]);
    expect(Object.keys(__testing__.RESOURCE_RESOLVERS)).toEqual(
      CARE_PATHWAY_RESOURCE_TYPES,
    );
    expect(__testing__.RESOURCE_RESOLVERS.appointment.sql).toContain(
      'patient.id = resource.patient_id',
    );
    expect(__testing__.RESOURCE_RESOLVERS.investigation.sql).toContain(
      'resource.patient_uid',
    );
    expect(__testing__.RESOURCE_RESOLVERS.anatomical_pathology_case).toMatchObject({
      idKind: 'int8',
    });
    expect(__testing__.RESOURCE_RESOLVERS.diagnostic_result_generation).toMatchObject({
      idKind: 'uuid',
    });
  });

  test('rejects unknown types before issuing SQL', async () => {
    const tx = { $queryRawUnsafe: jest.fn() };
    await expect(resolvePathwayResourceTx(tx, {
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      resourceType: 'arbitrary_table',
      resourceId: '1',
    })).rejects.toMatchObject({
      code: 'CARE_PATHWAY_RESOURCE_TYPE_UNSUPPORTED',
    });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('rejects missing, cross-tenant, and wrong-patient resources uniformly', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        { patient_uid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
      ]),
    };
    await expect(resolvePathwayResourceTx(tx, {
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      resourceType: 'appointment',
      resourceId: '42',
    })).rejects.toMatchObject({
      code: 'CARE_PATHWAY_RESOURCE_UNAVAILABLE',
    });
  });

  test('resolves the exact tenant and patient with a canonical resource id', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([
        { patient_uid: PATIENT_UID.toUpperCase() },
      ]),
    };
    await expect(resolvePathwayResourceTx(tx, {
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      resourceType: 'appointment',
      resourceId: '00042',
    })).resolves.toEqual({
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      resourceType: 'appointment',
      resourceId: '42',
    });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FROM appointments AS resource'),
      TENANT_ID,
      '42',
    );
  });

  test.each([
    [{ actorUid: null, actor: null }],
    [{
      actorUid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      actor: registeredSystemActor(),
    }],
  ])('requires actor UID XOR registered system actor', async (actor) => {
    const tx = { $queryRawUnsafe: jest.fn() };
    await expect(appendPathwayResourceReferenceTx(tx, input(actor)))
      .rejects.toMatchObject({
        code: 'CARE_PATHWAY_RESOURCE_REFERENCE_ACTOR_INVALID',
      });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('rejects a forged system actor before issuing SQL', async () => {
    const tx = { $queryRawUnsafe: jest.fn() };
    await expect(appendPathwayResourceReferenceTx(tx, input({
      actor: Object.freeze({
        kind: 'system',
        systemKey: 'op.pathway_projector.v1',
        sourceEventId: '9001',
      }),
    }))).rejects.toMatchObject({
      code: 'CARE_PATHWAY_RESOURCE_REFERENCE_SYSTEM_ACTOR_NOT_REGISTERED',
    });
    expect(tx.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('appends a resolved reference and returns a non-replay result', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ patient_uid: PATIENT_UID }])
        .mockResolvedValueOnce([storedRow()]),
    };
    await expect(appendPathwayResourceReferenceTx(tx, input())).resolves.toMatchObject({
      id: REFERENCE_ID,
      replayed: false,
    });
    const insertCall = tx.$queryRawUnsafe.mock.calls[1];
    expect(insertCall[0]).toContain('INSERT INTO care_pathway_resource_references');
    expect(insertCall.slice(1, 8)).toEqual([
      TENANT_ID,
      PATHWAY_ID,
      PATIENT_UID,
      'appointment',
      'closure_evidence',
      'open',
      '42',
    ]);
  });

  test('rejects a same-tenant task that is not the exact accepted ownership task', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ patient_uid: PATIENT_UID }])
        .mockResolvedValueOnce([]),
    };
    await expect(appendPathwayResourceReferenceTx(tx, input({
      evidenceState: 'ownership_accepted',
      acceptedOwnerUid: OWNER_UID,
      taskId: 77,
      idempotencyKey: 'op:42:ownership:task',
    }))).rejects.toMatchObject({
      code: 'CARE_PATHWAY_RESOURCE_REFERENCE_OWNERSHIP_INVALID',
    });
    const taskCall = tx.$queryRawUnsafe.mock.calls[1];
    expect(taskCall[0]).toContain('pathway.workflow_run_id = task.workflow_run_id');
    expect(taskCall[0]).toContain('task.related_resource_type = $5::text');
    expect(taskCall[0]).toContain('task.assigned_to_uid = $7::uuid');
    expect(taskCall[0]).toContain("task.status = 'completed'");
    expect(taskCall[0]).toContain('task.completed_at IS NOT NULL');
    expect(taskCall[0]).not.toMatch(/\b(?:in_progress|blocked|overdue)\b/);
    expect(taskCall.slice(1)).toEqual([
      TENANT_ID,
      77,
      PATIENT_UID,
      PATHWAY_ID,
      'appointment',
      '42',
      OWNER_UID,
    ]);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  test('rejects a same-tenant handoff that is not the exact accepted ownership handoff', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ patient_uid: PATIENT_UID }])
        .mockResolvedValueOnce([]),
    };
    await expect(appendPathwayResourceReferenceTx(tx, input({
      evidenceState: 'ownership_accepted',
      acceptedOwnerUid: OWNER_UID,
      handoffId: HANDOFF_ID,
      idempotencyKey: 'op:42:ownership:handoff',
    }))).rejects.toMatchObject({
      code: 'CARE_PATHWAY_RESOURCE_REFERENCE_OWNERSHIP_INVALID',
    });
    const handoffCall = tx.$queryRawUnsafe.mock.calls[1];
    expect(handoffCall[0]).toContain(
      'handoff.sending_pathway_instance_id = $4::uuid',
    );
    expect(handoffCall[0]).toContain('handoff.source_resource_type = $5::text');
    expect(handoffCall[0]).toContain(
      'handoff.accepted_by_uid = $7::uuid',
    );
    expect(handoffCall[0]).toContain(
      "handoff.status IN ('accepted', 'completed', 'closed_loop')",
    );
    expect(handoffCall.slice(1)).toEqual([
      TENANT_ID,
      HANDOFF_ID,
      PATIENT_UID,
      PATHWAY_ID,
      'appointment',
      '42',
      OWNER_UID,
      null,
    ]);
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  test('appends ownership evidence only after exact task and handoff validation', async () => {
    const ownershipRow = storedRow({
      evidence_state: 'ownership_accepted',
      accepted_owner_uid: OWNER_UID,
      task_id: 77,
      handoff_id: HANDOFF_ID,
      idempotency_key: 'op:42:ownership:accepted',
    });
    const tx = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ patient_uid: PATIENT_UID }])
        .mockResolvedValueOnce([{ id: 77 }])
        .mockResolvedValueOnce([{ id: HANDOFF_ID }])
        .mockResolvedValueOnce([ownershipRow]),
    };
    await expect(appendPathwayResourceReferenceTx(tx, input({
      evidenceState: 'ownership_accepted',
      acceptedOwnerUid: OWNER_UID,
      taskId: 77,
      handoffId: HANDOFF_ID,
      idempotencyKey: 'op:42:ownership:accepted',
    }))).resolves.toMatchObject({
      accepted_owner_uid: OWNER_UID,
      task_id: 77,
      handoff_id: HANDOFF_ID,
      replayed: false,
    });
    expect(tx.$queryRawUnsafe.mock.calls[2][0]).toContain(
      'OR handoff.task_id = $8::integer',
    );
    expect(tx.$queryRawUnsafe.mock.calls[3][0]).toContain(
      'INSERT INTO care_pathway_resource_references',
    );
  });

  test('replays only when the stored idempotent request is byte-equivalent in meaning', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ patient_uid: PATIENT_UID }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([storedRow()]),
    };
    await expect(appendPathwayResourceReferenceTx(tx, input())).resolves.toMatchObject({
      id: REFERENCE_ID,
      replayed: true,
    });
  });

  test('rejects an idempotency key reused for different evidence', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([{ patient_uid: PATIENT_UID }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([storedRow({ evidence_state: 'completed' })]),
    };
    await expect(appendPathwayResourceReferenceTx(tx, input()))
      .rejects.toMatchObject({
        code: 'CARE_PATHWAY_RESOURCE_REFERENCE_IDEMPOTENCY_CONFLICT',
      });
  });

  test('supersedes only the exact live tenant/pathway/patient resource identity', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn()
        .mockResolvedValueOnce([storedRow()])
        .mockResolvedValueOnce([{ patient_uid: PATIENT_UID }])
        .mockResolvedValueOnce([storedRow({
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          evidence_state: 'completed',
          idempotency_key: 'op:42:root-reference:completed',
          superseded_reference_id: REFERENCE_ID,
        })]),
    };
    await expect(supersedePathwayResourceReferenceTx(tx, input({
      supersededReferenceId: REFERENCE_ID,
      evidenceState: 'completed',
      idempotencyKey: 'op:42:root-reference:completed',
    }))).resolves.toMatchObject({
      replayed: false,
      superseded_reference_id: REFERENCE_ID,
    });
    expect(tx.$queryRawUnsafe).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('successor.superseded_reference_id = reference.id'),
      TENANT_ID,
      REFERENCE_ID,
      PATHWAY_ID,
      PATIENT_UID,
    );
  });
});
