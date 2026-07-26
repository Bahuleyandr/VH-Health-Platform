import { jest } from '@jest/globals';

let activeTx;
const setTenantTxMock = jest.fn(async (_tenantId, callback) => callback(activeTx));
const recordCanonicalClinicalEventMock = jest.fn();
const publishEventMock = jest.fn();
const createTaskMock = jest.fn();
const createTrackingTaskMock = jest.fn();
const reassignPendingResultTasksMock = jest.fn();
const supersedePendingResultOwnerActionTaskMock = jest.fn();
const settlePendingResultTasksFromDiagnosticActionMock = jest.fn();
const settlePendingResultTasksFromOwnerCrossSignMock = jest.fn();
const signDocumentTxMock = jest.fn();
const resolvePathwayModeTxMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  isTenantTransactionClient: (value) => Boolean(value?.$queryRawUnsafe),
  setTenantTx: setTenantTxMock,
}));
jest.unstable_mockModule(
  '../../services/clinical/canonicalClinicalPlatformService.js',
  () => ({
    recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  }),
);
jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: publishEventMock,
}));
jest.unstable_mockModule('../../services/clinical/documentIntegrityService.js', () => ({
  signDocumentTx: signDocumentTxMock,
}));
jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  createPendingResultOwnerActionTaskTx: createTaskMock,
  createPendingResultTrackingTaskTx: createTrackingTaskMock,
  reassignPendingResultTasksForAcceptedCoveringHandoffTx:
    reassignPendingResultTasksMock,
  settlePendingResultTasksFromDiagnosticActionTx:
    settlePendingResultTasksFromDiagnosticActionMock,
  settlePendingResultTasksFromOwnerCrossSignTx:
    settlePendingResultTasksFromOwnerCrossSignMock,
  supersedePendingResultOwnerActionTaskFromGenerationTx:
    supersedePendingResultOwnerActionTaskMock,
}));
jest.unstable_mockModule(
  '../../services/pathways/pathwayRuntimePersistence.js',
  () => ({
    resolvePathwayModeTx: resolvePathwayModeTxMock,
  }),
);

const {
  getInpatientDischargeEvidence,
  linkPendingResultOwnerActionsForGenerationTx,
  publishInpatientDiagnosticResourceLinkedTx,
  recordFollowUpException,
  recordPendingResultHandoff,
  recordPendingResultOwnerCrossSign,
  recordPendingResultSummaryInclusion,
  recordPostDischargeContact,
  recordPrimaryPhysicianChangeTx,
  settlePendingResultOwnerActionsForDiagnosticActionTx,
} = await import('../../services/emr/inpatientPathwayDomainService.js');
const {
  INPATIENT_PATHWAY_RUNTIME_HANDLERS,
  loadInpatientPathwayEvidence,
} = await import('../../services/pathways/inpatientPathwayHandlers.js');
const {
  sha256ClinicalJson,
} = await import('../../services/diagnostics/diagnosticClassification.js');

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const ACTOR_UID = '30000000-0000-4000-8000-000000000001';
const OTHER_PHYSICIAN_UID = '40000000-0000-4000-8000-000000000001';
const TRANSFERRED_OWNER_UID = '41000000-0000-4000-8000-000000000001';
const HANDOFF_ID = '50000000-0000-4000-8000-000000000001';
const REFERENCE_ID = '60000000-0000-4000-8000-000000000001';
const ASSIGNMENT_ID = '70000000-0000-4000-8000-000000000001';
const GENERATION_ID = '80000000-0000-4000-8000-000000000001';
const NEXT_GENERATION_ID = '80000000-0000-4000-8000-000000000002';
const PATHWAY_ID = '90000000-0000-4000-8000-000000000001';
const COVERING_HANDOFF_ID = 'a0000000-0000-4000-8000-000000000002';
const NEXT_ASSIGNMENT_ID = 'a0000000-0000-4000-8000-000000000003';
const OWNER_ACTION_ID = '81000000-0000-4000-8000-000000000001';
const DIAGNOSTIC_ACTION_ID = '82000000-0000-4000-8000-000000000001';
const CROSS_SIGN_ACTION_ID = '83000000-0000-4000-8000-000000000001';
const SIGNATURE_ID = '84000000-0000-4000-8000-000000000001';
const SNAPSHOT_SHA256 = 'a'.repeat(64);
const CROSS_SIGN_IDEMPOTENCY_KEY = 'pending-result-cross-sign:17:1';
const CROSS_SIGN_ATTESTATION =
  'I attest that I reviewed this complete signed diagnostic generation and the recorded diagnostic disposition as the named discharge follow-up physician.';

function admissionRow(overrides = {}) {
  return {
    id: 17,
    tenant_id: TENANT_ID,
    patient_uid: PATIENT_UID,
    encounter_id: null,
    status: 'admitted',
    admitting_doctor: OTHER_PHYSICIAN_UID,
    attending_doctor: OTHER_PHYSICIAN_UID,
    source_appointment_id: null,
    source_pathway_instance_id: null,
    source_handoff_id: null,
    ...overrides,
  };
}

function assignmentRow(physicianUid = ACTOR_UID, overrides = {}) {
  return {
    id: ASSIGNMENT_ID,
    assignment_version: 1,
    physician_uid: physicianUid,
    assignment_source: 'attending_physician',
    physician_name: 'Named physician',
    physician_role: 'DOCTOR',
    physician_is_active: true,
    physician_status: 'active',
    physician_is_deleted: false,
    physician_deleted_at: null,
    ...overrides,
  };
}

function pendingHandoff(overrides = {}) {
  return {
    id: HANDOFF_ID,
    tenant_id: TENANT_ID,
    admission_id: 17,
    patient_uid: PATIENT_UID,
    resource_reference_id: REFERENCE_ID,
    source_type: 'lab_result',
    source_id: '73',
    patient_safe_label: 'Complete blood count',
    result_status: 'pending',
    primary_physician_assignment_id: ASSIGNMENT_ID,
    named_physician_uid: ACTOR_UID,
    task_id: 91,
    handoff_state: 'pending',
    discharge_summary_id: 44,
    summary_included_at: new Date('2026-07-23T08:00:00.000Z'),
    resolution_generation_id: null,
    resolution_action_id: null,
    resolved_at: null,
    resolved_by_uid: null,
    created_at: new Date('2026-07-23T07:00:00.000Z'),
    updated_at: new Date('2026-07-23T08:00:00.000Z'),
    workflow_run_id: 'a0000000-0000-4000-8000-000000000001',
    signer_uid: OTHER_PHYSICIAN_UID,
    signer_role: 'DOCTOR',
    admission_encounter_id: null,
    ...overrides,
  };
}

function actionTaskRow(overrides = {}) {
  return {
    id: 101,
    task_kind: 'review',
    title: 'Review Complete blood count',
    description: 'A result pending at discharge is now available for the named physician.',
    status: 'open',
    patient_uid: PATIENT_UID,
    assigned_to_uid: ACTOR_UID,
    assigned_to_role: null,
    created_by: OTHER_PHYSICIAN_UID,
    related_resource_type: 'discharge_pending_result_action',
    related_resource_id: `${HANDOFF_ID}:${GENERATION_ID}`,
    parent_task_id: 91,
    metadata: {
      task_contract: 'discharge_pending_result_action_v1',
      handoff_id: HANDOFF_ID,
      generation_id: GENERATION_ID,
      predecessor_generation_id: null,
      predecessor_owner_action_id: null,
      predecessor_resolution_action_id: null,
      rearm_source_action_id: null,
    },
    created_at: new Date('2026-07-23T09:00:00.000Z'),
    updated_at: new Date('2026-07-23T09:00:00.000Z'),
    ...overrides,
  };
}

function generationRow(overrides = {}) {
  return {
    id: GENERATION_ID,
    tenant_id: TENANT_ID,
    patient_uid: PATIENT_UID,
    admission_id: 17,
    source_kind: 'lab_panel',
    source_episode_key: 'investigation:73',
    source_version: 1n,
    predecessor_generation_id: null,
    signer_uid: OTHER_PHYSICIAN_UID,
    signer_role: 'DOCTOR',
    ...overrides,
  };
}

function ownerActionRow(overrides = {}) {
  return {
    id: '81000000-0000-4000-8000-000000000001',
    tenant_id: TENANT_ID,
    handoff_id: HANDOFF_ID,
    admission_id: 17,
    patient_uid: PATIENT_UID,
    generation_id: GENERATION_ID,
    predecessor_generation_id: null,
    predecessor_owner_action_id: null,
    predecessor_resolution_action_id: null,
    rearm_source_action_id: null,
    task_id: 101,
    owner_uid: ACTOR_UID,
    source_outbox_event_id: 901,
    canonical_timeline_event_id: 'b0000000-0000-4000-8000-000000000001',
    canonical_audit_event_id: 'c0000000-0000-4000-8000-000000000001',
    recorded_at: new Date('2026-07-23T09:00:00.000Z'),
    idempotency_key: `pending-result-owner-action:${HANDOFF_ID}:${GENERATION_ID}`,
    task_status: 'open',
    related_resource_type: 'discharge_pending_result_action',
    related_resource_id: `${HANDOFF_ID}:${GENERATION_ID}`,
    task_patient_uid: PATIENT_UID,
    assigned_to_uid: ACTOR_UID,
    assigned_to_role: null,
    parent_task_id: 91,
    created_by: OTHER_PHYSICIAN_UID,
    task_kind: 'review',
    title: 'Review Complete blood count',
    description: 'A result pending at discharge is now available for the named physician.',
    task_created_at: new Date('2026-07-23T09:00:00.000Z'),
    task_updated_at: new Date('2026-07-23T09:00:00.000Z'),
    task_metadata: {
      task_contract: 'discharge_pending_result_action_v1',
      handoff_id: HANDOFF_ID,
      generation_id: GENERATION_ID,
      predecessor_generation_id: null,
      predecessor_owner_action_id: null,
      predecessor_resolution_action_id: null,
      rearm_source_action_id: null,
    },
    ...overrides,
  };
}

function liveActorRow(role = 'DOCTOR', overrides = {}) {
  return {
    uid: ACTOR_UID,
    role,
    is_active: true,
    status: 'active',
    is_deleted: false,
    deleted_at: null,
    ...overrides,
  };
}

function authorizedCrossSignHandoff(overrides = {}) {
  return pendingHandoff({
    handoff_state: 'result_available',
    result_status: 'available',
    resolution_generation_id: GENERATION_ID,
    pathway_instance_id: PATHWAY_ID,
    encounter_id: null,
    actor_name: 'Named physician',
    actor_role: 'DOCTOR',
    actor_is_active: true,
    actor_status: 'active',
    actor_is_deleted: false,
    actor_deleted_at: null,
    ...overrides,
  });
}

function crossSignContext(overrides = {}) {
  return {
    ...ownerActionRow(),
    snapshot_sha256: SNAPSHOT_SHA256,
    classification: 'abnormal',
    signer_uid: OTHER_PHYSICIAN_UID,
    signer_role: 'DOCTOR',
    action_task_status: 'open',
    action_task_kind: 'review',
    action_parent_task_id: 91,
    action_patient_uid: PATIENT_UID,
    action_resource_type: 'discharge_pending_result_action',
    action_resource_id: `${HANDOFF_ID}:${GENERATION_ID}`,
    action_assigned_to_uid: ACTOR_UID,
    action_assigned_to_role: null,
    action_workflow_run_id: null,
    action_workflow_step_id: null,
    action_sla_id: null,
    action_sla_semantics: 'none',
    tracking_task_status: 'open',
    tracking_task_kind: 'follow_up',
    tracking_parent_task_id: null,
    tracking_patient_uid: PATIENT_UID,
    tracking_resource_type: 'discharge_pending_result_handoff',
    tracking_resource_id: HANDOFF_ID,
    tracking_assigned_to_uid: ACTOR_UID,
    tracking_assigned_to_role: null,
    tracking_workflow_run_id: null,
    tracking_workflow_step_id: null,
    tracking_sla_id: null,
    tracking_sla_semantics: 'none',
    diagnostic_action_id: DIAGNOSTIC_ACTION_ID,
    diagnostic_action_kind: 'doctor_disposition',
    diagnostic_disposition: 'treated',
    diagnostic_signature_id: SIGNATURE_ID,
    diagnostic_action_occurred_at: new Date('2026-07-23T09:30:00.000Z'),
    ...overrides,
  };
}

function crossSignRequestSha256() {
  return sha256ClinicalJson({
    admission_id: 17,
    handoff_id: HANDOFF_ID,
    generation_id: GENERATION_ID,
    diagnostic_action_id: DIAGNOSTIC_ACTION_ID,
    generation_snapshot_sha256: SNAPSHOT_SHA256,
    attestation: CROSS_SIGN_ATTESTATION,
  });
}

function crossSignActionRow(overrides = {}) {
  return {
    id: CROSS_SIGN_ACTION_ID,
    patient_uid: PATIENT_UID,
    generation_id: GENERATION_ID,
    pathway_instance_id: PATHWAY_ID,
    task_id: 101,
    action_kind: 'discharge_owner_cross_sign',
    generation_snapshot_sha256: SNAPSHOT_SHA256,
    actor_uid: ACTOR_UID,
    actor_role: 'DOCTOR',
    downstream_resource_type: 'discharge_pending_result_handoff',
    downstream_resource_id: HANDOFF_ID,
    idempotency_key: CROSS_SIGN_IDEMPOTENCY_KEY,
    request_sha256: crossSignRequestSha256(),
    predecessor_action_id: DIAGNOSTIC_ACTION_ID,
    signature_id: SIGNATURE_ID,
    canonical_timeline_event_id: 'b0000000-0000-4000-8000-000000000001',
    canonical_audit_event_id: 'c0000000-0000-4000-8000-000000000001',
    handoff_id: HANDOFF_ID,
    admission_id: 17,
    tracking_task_id: 91,
    current_handoff_state: 'resolved',
    owner_action_id: OWNER_ACTION_ID,
    ...overrides,
  };
}

function pendingSettlementRow(actionKind, overrides = {}) {
  return {
    ...pendingHandoff({
      handoff_state: 'result_available',
      result_status: 'available',
      resolution_generation_id: GENERATION_ID,
    }),
    encounter_id: null,
    owner_action_id: OWNER_ACTION_ID,
    generation_id: GENERATION_ID,
    action_task_id: 101,
    action_kind: actionKind,
    actor_uid: actionKind === 'doctor_disposition' ? ACTOR_UID : null,
    actor_role: actionKind === 'doctor_disposition' ? 'DOCTOR' : null,
    signature_id: actionKind === 'doctor_disposition' ? SIGNATURE_ID : null,
    generation_snapshot_sha256: SNAPSHOT_SHA256,
    ...overrides,
  };
}

beforeEach(() => {
  activeTx = null;
  jest.clearAllMocks();
  resolvePathwayModeTxMock.mockResolvedValue('active');
  recordCanonicalClinicalEventMock.mockResolvedValue({
    timeline: { id: 'b0000000-0000-4000-8000-000000000001' },
    audit: { id: 'c0000000-0000-4000-8000-000000000001' },
  });
  publishEventMock.mockResolvedValue({ id: 901 });
  createTaskMock.mockResolvedValue(actionTaskRow());
  createTrackingTaskMock.mockResolvedValue({
    id: 91,
    status: 'open',
  });
  reassignPendingResultTasksMock.mockResolvedValue({
    tracking_task_ids: [91],
    action_task_ids: [92],
  });
  supersedePendingResultOwnerActionTaskMock.mockResolvedValue(
    actionTaskRow({ status: 'cancelled' }),
  );
  settlePendingResultTasksFromDiagnosticActionMock.mockResolvedValue({
    action_task_id: 101,
    tracking_task_id: 91,
    replayed: false,
  });
  settlePendingResultTasksFromOwnerCrossSignMock.mockResolvedValue({
    action_task_id: 101,
    tracking_task_id: 91,
    replayed: false,
  });
  signDocumentTxMock.mockResolvedValue({
    id: 'd0000000-0000-4000-8000-000000000001',
  });
});

describe('inpatient diagnostic source discharge serialization', () => {
  it('rejects a new source link after the admission has reached a terminal state', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM admissions')) {
          return [admissionRow({ status: 'discharged' })];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    await expect(publishInpatientDiagnosticResourceLinkedTx({
      tx,
      tenantId: TENANT_ID,
      admissionId: 17,
      patientUid: PATIENT_UID,
      resourceType: 'investigation',
      resourceId: 73,
    })).rejects.toMatchObject({
      code: 'INPATIENT_DIAGNOSTIC_ADMISSION_NOT_ACTIVE',
    });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('allows a result generation after discharge to resolve an existing source', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM admissions')) {
          return [admissionRow({ status: 'discharged' })];
        }
        if (sql.includes('FROM diagnostic_result_generations AS resource')) {
          return [{ resource_id: GENERATION_ID }];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    await expect(publishInpatientDiagnosticResourceLinkedTx({
      tx,
      tenantId: TENANT_ID,
      admissionId: 17,
      patientUid: PATIENT_UID,
      resourceType: 'diagnostic_result_generation',
      resourceId: GENERATION_ID,
    })).resolves.toEqual({ id: 901 });
    expect(publishEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admission.diagnostic_resource_linked',
      payload: expect.objectContaining({
        admission_id: 17,
        resource_type: 'diagnostic_result_generation',
      }),
    }));
  });

  it('deterministically loses the discharge race and rolls back a late source link', async () => {
    let admissionStatus = 'admitted';
    let releaseAdmissionLock;
    let reachedAdmissionLock;
    const admissionLockReached = new Promise((resolve) => {
      reachedAdmissionLock = resolve;
    });
    const dischargeCommitted = new Promise((resolve) => {
      releaseAdmissionLock = resolve;
    });
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM admissions')) {
          reachedAdmissionLock();
          await dischargeCommitted;
          return [admissionRow({ status: admissionStatus })];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    const lateProducer = publishInpatientDiagnosticResourceLinkedTx({
      tx,
      tenantId: TENANT_ID,
      admissionId: 17,
      patientUid: PATIENT_UID,
      resourceType: 'radiology_order',
      resourceId: 73,
    });
    await admissionLockReached;
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(publishEventMock).not.toHaveBeenCalled();

    admissionStatus = 'discharged';
    releaseAdmissionLock();
    await expect(lateProducer).rejects.toMatchObject({
      code: 'INPATIENT_DIAGNOSTIC_ADMISSION_NOT_ACTIVE',
    });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(publishEventMock).not.toHaveBeenCalled();
  });
});

describe('inpatient pending-result generation correlation', () => {
  it('creates the exact owner action and fills the handoff once in the producer transaction', async () => {
    const handoff = pendingHandoff();
    const query = jest.fn(async (sql) => {
      if (sql.includes('SELECT generation.id, generation.tenant_id')) {
        return [generationRow()];
      }
      if (sql.includes('FROM diagnostic_result_generations AS successor')) return [];
      if (sql.includes('WITH RECURSIVE exact_generation AS')) return [handoff];
      if (sql.includes('WITH RECURSIVE generation_ancestry AS')) {
        return [{ id: GENERATION_ID }];
      }
      if (sql.includes('FROM discharge_pending_result_owner_actions AS action')) return [];
      if (
        sql.includes('FROM tasks')
        && sql.includes("related_resource_type = 'discharge_pending_result_action'")
      ) return [];
      if (sql.includes('UPDATE discharge_pending_result_handoffs')) {
        return [{
          ...handoff,
          handoff_state: 'result_available',
          result_status: 'available',
          resolution_generation_id: GENERATION_ID,
        }];
      }
      if (sql.includes('INSERT INTO discharge_pending_result_owner_actions')) {
        return [ownerActionRow()];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const result = await linkPendingResultOwnerActionsForGenerationTx({
      tx: { $queryRawUnsafe: query },
      tenantId: TENANT_ID,
      generationId: GENERATION_ID,
    });

    expect(result).toHaveLength(1);
    expect(result[0].handoff).not.toHaveProperty('tenant_id');
    expect(result[0].handoff).not.toHaveProperty('patient_uid');
    expect(result[0].handoff.resolution_generation_id).toBe(GENERATION_ID);
    expect(result[0].owner_action).toMatchObject({
      handoff_id: HANDOFF_ID,
      generation_id: GENERATION_ID,
      predecessor_generation_id: null,
      task_id: 101,
    });
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      handoffId: HANDOFF_ID,
      generationId: GENERATION_ID,
      parentTaskId: 91,
      ownerUid: ACTOR_UID,
      rearmReason: null,
      tx: expect.any(Object),
    }));
    expect(query.mock.calls.some(([sql]) => sql.includes(
      'handoff.admission_id = generation.admission_id',
    ))).toBe(true);
    expect(query.mock.calls.some(([sql]) => (
      sql.includes("item.source_table = 'lab_results'")
    ))).toBe(true);
    expect(query.mock.calls.some(([sql]) => (
      sql.includes("handoff_state = 'pending'")
      && sql.includes('resolution_generation_id IS NULL')
      && sql.includes('clock_timestamp()')
    ))).toBe(true);
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'discharge.pending_result_available',
        payload: expect.objectContaining({
          handoff_id: HANDOFF_ID,
          generation_id: GENERATION_ID,
          action_task_id: 101,
        }),
      }),
      expect.objectContaining({ db: expect.any(Object), strict: true }),
    );
    expect(publishEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'discharge.pending_result_available',
      payload: expect.objectContaining({
        handoff_id: HANDOFF_ID,
        generation_id: GENERATION_ID,
        action_task_id: 101,
      }),
    }));
  });

  it('replays the same generation without creating a duplicate owner action', async () => {
    const query = jest.fn(async (sql) => {
      if (sql.includes('SELECT generation.id, generation.tenant_id')) {
        return [generationRow()];
      }
      if (sql.includes('FROM diagnostic_result_generations AS successor')) return [];
      if (sql.includes('WITH RECURSIVE exact_generation AS')) {
        return [pendingHandoff({
          handoff_state: 'result_available',
          result_status: 'available',
          resolution_generation_id: GENERATION_ID,
        })];
      }
      if (sql.includes('WITH RECURSIVE generation_ancestry AS')) {
        return [{ id: GENERATION_ID }];
      }
      if (sql.includes('FROM discharge_pending_result_owner_actions AS action')) {
        return [ownerActionRow()];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    const result = await linkPendingResultOwnerActionsForGenerationTx({
      tx: { $queryRawUnsafe: query },
      tenantId: TENANT_ID,
      generationId: GENERATION_ID,
    });

    expect(result).toHaveLength(1);
    expect(result[0].action_task).toMatchObject({
      id: 101,
      related_resource_id: `${HANDOFF_ID}:${GENERATION_ID}`,
    });
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(5);
  });

  it('proves the exact action-task winner when the conflict-safe insert is a no-op', async () => {
    const handoff = pendingHandoff();
    let taskReads = 0;
    createTaskMock.mockResolvedValueOnce(undefined);
    const query = jest.fn(async (sql) => {
      if (sql.includes('SELECT generation.id, generation.tenant_id')) {
        return [generationRow()];
      }
      if (sql.includes('FROM diagnostic_result_generations AS successor')) return [];
      if (sql.includes('WITH RECURSIVE exact_generation AS')) return [handoff];
      if (sql.includes('WITH RECURSIVE generation_ancestry AS')) {
        return [{ id: GENERATION_ID }];
      }
      if (sql.includes('FROM discharge_pending_result_owner_actions AS action')) return [];
      if (sql.includes('FROM tasks')) {
        taskReads += 1;
        return taskReads === 1 ? [] : [actionTaskRow()];
      }
      if (sql.includes('UPDATE discharge_pending_result_handoffs')) {
        return [{
          ...handoff,
          handoff_state: 'result_available',
          result_status: 'available',
          resolution_generation_id: GENERATION_ID,
        }];
      }
      if (sql.includes('INSERT INTO discharge_pending_result_owner_actions')) {
        return [ownerActionRow()];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const result = await linkPendingResultOwnerActionsForGenerationTx({
      tx: { $queryRawUnsafe: query },
      tenantId: TENANT_ID,
      generationId: GENERATION_ID,
    });
    expect(result[0].action_task).toMatchObject({ id: 101 });
    expect(taskReads).toBe(2);
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      createdBy: OTHER_PHYSICIAN_UID,
      handoffId: HANDOFF_ID,
      generationId: GENERATION_ID,
      predecessorGenerationId: null,
      predecessorOwnerActionId: null,
      rearmReason: null,
    }));
  });

  it('rejects an old generation after a correction has created a successor', async () => {
    const query = jest.fn(async (sql) => {
      if (sql.includes('SELECT generation.id, generation.tenant_id')) {
        return [generationRow()];
      }
      if (sql.includes('FROM diagnostic_result_generations AS successor')) {
        return [{ id: NEXT_GENERATION_ID }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(linkPendingResultOwnerActionsForGenerationTx({
      tx: { $queryRawUnsafe: query },
      tenantId: TENANT_ID,
      generationId: GENERATION_ID,
    })).rejects.toMatchObject({
      code: 'INPATIENT_PENDING_RESULT_GENERATION_NOT_CURRENT',
    });
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it.each([
    ['without an owner transfer', ACTOR_UID],
    ['after an accepted owner transfer', TRANSFERRED_OWNER_UID],
  ])(
    'supersedes the prior task and appends a corrected leaf owner action %s',
    async (_label, currentOwnerUid) => {
      const correctedTask = actionTaskRow({
        id: 102,
        description: 'A corrected result pending at discharge is available for the named physician.',
        related_resource_id: `${HANDOFF_ID}:${NEXT_GENERATION_ID}`,
        assigned_to_uid: currentOwnerUid,
        metadata: {
          task_contract: 'discharge_pending_result_action_v1',
          handoff_id: HANDOFF_ID,
          generation_id: NEXT_GENERATION_ID,
          predecessor_generation_id: GENERATION_ID,
          predecessor_owner_action_id: '81000000-0000-4000-8000-000000000001',
          predecessor_resolution_action_id: null,
          rearm_source_action_id: null,
        },
      });
      createTaskMock.mockResolvedValueOnce(correctedTask);
      const handoff = pendingHandoff({
        handoff_state: 'result_available',
        result_status: 'available',
        resolution_generation_id: GENERATION_ID,
        named_physician_uid: currentOwnerUid,
      });
      const query = jest.fn(async (sql) => {
        if (sql.includes('SELECT generation.id, generation.tenant_id')) {
          return [generationRow({
            id: NEXT_GENERATION_ID,
            source_version: 2n,
            predecessor_generation_id: GENERATION_ID,
          })];
        }
        if (sql.includes('FROM diagnostic_result_generations AS successor')) return [];
        if (sql.includes('WITH RECURSIVE exact_generation AS')) return [handoff];
        if (sql.includes('WITH RECURSIVE generation_ancestry AS')) {
          return [{ id: NEXT_GENERATION_ID }];
        }
        if (sql.includes('FROM discharge_pending_result_owner_actions AS action')) {
          return [ownerActionRow({
            owner_uid: ACTOR_UID,
            assigned_to_uid: currentOwnerUid,
          })];
        }
        if (sql.includes('FROM tasks')) return [];
        if (sql.includes('INSERT INTO discharge_pending_result_owner_actions')) {
          return [ownerActionRow({
            id: '81000000-0000-4000-8000-000000000002',
            generation_id: NEXT_GENERATION_ID,
            predecessor_generation_id: GENERATION_ID,
            predecessor_owner_action_id:
              '81000000-0000-4000-8000-000000000001',
            task_id: 102,
            owner_uid: currentOwnerUid,
            assigned_to_uid: currentOwnerUid,
            source_outbox_event_id: 901,
            idempotency_key:
              `pending-result-owner-action:${HANDOFF_ID}:${NEXT_GENERATION_ID}`,
          })];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      });

      const result = await linkPendingResultOwnerActionsForGenerationTx({
        tx: { $queryRawUnsafe: query },
        tenantId: TENANT_ID,
        generationId: NEXT_GENERATION_ID,
      });
      expect(supersedePendingResultOwnerActionTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 101,
          handoffId: HANDOFF_ID,
          generationId: GENERATION_ID,
          supersedingGenerationId: NEXT_GENERATION_ID,
          patientUid: PATIENT_UID,
          ownerUid: currentOwnerUid,
          parentTaskId: 91,
          actorUid: OTHER_PHYSICIAN_UID,
          tx: expect.any(Object),
        }),
      );
      expect(result[0]).toMatchObject({
        handoff: { resolution_generation_id: GENERATION_ID },
        action_task: {
          id: 102,
          related_resource_id: `${HANDOFF_ID}:${NEXT_GENERATION_ID}`,
        },
        owner_action: {
          generation_id: NEXT_GENERATION_ID,
          predecessor_generation_id: GENERATION_ID,
          task_id: 102,
          owner_uid: currentOwnerUid,
        },
      });
      expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
        handoffId: HANDOFF_ID,
        generationId: NEXT_GENERATION_ID,
        ownerUid: currentOwnerUid,
        predecessorGenerationId: GENERATION_ID,
        predecessorOwnerActionId:
          '81000000-0000-4000-8000-000000000001',
        rearmReason: 'corrected_generation',
      }));
      expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
        expect.objectContaining({
          eventStatus: 'result_rearmed',
          payload: expect.objectContaining({
            generation_id: NEXT_GENERATION_ID,
            predecessor_generation_id: GENERATION_ID,
            action_task_id: 102,
          }),
        }),
        expect.objectContaining({ db: expect.any(Object), strict: true }),
      );
    },
  );

  it('rejects a generation from another diagnostic episode for a generation-source handoff', async () => {
    const handoff = pendingHandoff({
      source_type: 'diagnostic_result_generation',
      source_id: GENERATION_ID,
    });
    const query = jest.fn(async (sql) => {
      if (sql.includes('SELECT generation.id, generation.tenant_id')) {
        return [generationRow({
          id: NEXT_GENERATION_ID,
          source_episode_key: 'investigation:999',
        })];
      }
      if (sql.includes('FROM diagnostic_result_generations AS successor')) return [];
      if (sql.includes('WITH RECURSIVE exact_generation AS')) return [handoff];
      if (sql.includes('WITH RECURSIVE generation_ancestry AS')) return [];
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(linkPendingResultOwnerActionsForGenerationTx({
      tx: { $queryRawUnsafe: query },
      tenantId: TENANT_ID,
      generationId: NEXT_GENERATION_ID,
    })).rejects.toMatchObject({
      code: 'INPATIENT_PENDING_RESULT_GENERATION_MISMATCH',
    });
    expect(createTaskMock).not.toHaveBeenCalled();
  });
});

describe('inpatient pending-result named-owner cross-sign', () => {
  const input = () => ({
    generation_id: GENERATION_ID,
    diagnostic_action_id: DIAGNOSTIC_ACTION_ID,
    generation_snapshot_sha256: SNAPSHOT_SHA256,
    attested: true,
    idempotencyKey: CROSS_SIGN_IDEMPOTENCY_KEY,
  });
  const actor = (overrides = {}) => ({
    tenantId: TENANT_ID,
    uid: ACTOR_UID,
    role: 'DOCTOR',
    ...overrides,
  });

  it('rejects arbitrary cross-sign metadata before entering a tenant transaction', async () => {
    await expect(recordPendingResultOwnerCrossSign(
      17,
      HANDOFF_ID,
      { ...input(), metadata: { approval: true } },
      actor(),
    )).rejects.toMatchObject({
      statusCode: 400,
      code: 'INPATIENT_PENDING_RESULT_CROSS_SIGN_INPUT_INVALID',
    });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing handoff', ACTOR_UID],
    ['a guessed handoff owned by another physician', OTHER_PHYSICIAN_UID],
  ])('authorizes before replay lookup and returns the same generic denial for %s', async (
    _label,
    actorUid,
  ) => {
    const seenSql = [];
    activeTx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        seenSql.push(sql);
        if (sql.includes('JOIN users AS actor')) return [];
        throw new Error(`Replay lookup ran before authorization: ${sql}`);
      }),
    };

    await expect(recordPendingResultOwnerCrossSign(
      17,
      HANDOFF_ID,
      input(),
      actor({ uid: actorUid }),
    )).rejects.toMatchObject({
      statusCode: 403,
      code: 'INPATIENT_PENDING_RESULT_CROSS_SIGN_FORBIDDEN',
      message:
        'Only the live named discharge follow-up physician may cross-sign this pending result',
    });
    expect(seenSql).toHaveLength(1);
    expect(seenSql[0]).toContain('JOIN users AS actor');
    expect(seenSql[0]).toContain('FOR UPDATE OF handoff');
  });

  it('rejects a formerly eligible named owner after their live role changes', async () => {
    activeTx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('JOIN users AS actor')) {
          return [authorizedCrossSignHandoff({
            actor_role: 'NURSING_STAFF',
          })];
        }
        throw new Error(`Replay lookup ran after ineligible live role: ${sql}`);
      }),
    };

    await expect(recordPendingResultOwnerCrossSign(
      17,
      HANDOFF_ID,
      input(),
      actor({ role: 'NURSING_STAFF' }),
    )).rejects.toMatchObject({
      statusCode: 403,
      code: 'INPATIENT_PENDING_RESULT_CROSS_SIGN_FORBIDDEN',
    });
    expect(activeTx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it('denies the immutable historical owner after the live handoff transfers', async () => {
    activeTx = {
      $queryRawUnsafe: jest.fn(async (sql, ...params) => {
        if (sql.includes('JOIN users AS actor')) {
          expect(params[3]).toBe(OTHER_PHYSICIAN_UID);
          expect(params[4]).toBe(OTHER_PHYSICIAN_UID);
          return [];
        }
        throw new Error(`Replay lookup ran after former-owner denial: ${sql}`);
      }),
    };

    await expect(recordPendingResultOwnerCrossSign(
      17,
      HANDOFF_ID,
      input(),
      actor({ uid: OTHER_PHYSICIAN_UID }),
    )).rejects.toMatchObject({
      statusCode: 403,
      code: 'INPATIENT_PENDING_RESULT_CROSS_SIGN_FORBIDDEN',
    });
    expect(activeTx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
    expect(settlePendingResultTasksFromOwnerCrossSignMock).not.toHaveBeenCalled();
  });

  it('uses current handoff and task ownership after transfer without rewriting owner history', async () => {
    let contextQuery = null;
    const query = jest.fn(async (sql, ...params) => {
      if (sql.includes('JOIN users AS actor')) {
        return [authorizedCrossSignHandoff()];
      }
      if (sql.includes('action.idempotency_key = $2::text')) return [];
      if (sql.includes('prior_action.action_kind')) {
        contextQuery = { sql, params };
        return [crossSignContext({ owner_uid: OTHER_PHYSICIAN_UID })];
      }
      if (sql.includes('INSERT INTO diagnostic_result_actions')) {
        return [crossSignActionRow({
          id: params[0],
          signature_id: params[13],
          canonical_timeline_event_id: params[14],
          canonical_audit_event_id: params[15],
        })];
      }
      if (sql.includes('UPDATE discharge_pending_result_handoffs')) {
        return [authorizedCrossSignHandoff({
          handoff_state: 'resolved',
          result_status: 'reviewed',
          resolved_at: new Date('2026-07-23T10:00:00.000Z'),
          resolved_by_uid: ACTOR_UID,
          resolution_action_id: params[5],
        })];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    activeTx = { $queryRawUnsafe: query };

    const result = await recordPendingResultOwnerCrossSign(
      17,
      HANDOFF_ID,
      input(),
      actor(),
    );

    expect(result).toMatchObject({
      owner_action_id: OWNER_ACTION_ID,
      handoff_state: 'resolved',
      replayed: false,
    });
    expect(contextQuery).toEqual({
      sql: expect.not.stringContaining('owner_action.owner_uid'),
      params: [
        TENANT_ID,
        HANDOFF_ID,
        17,
        PATIENT_UID,
        GENERATION_ID,
        91,
        DIAGNOSTIC_ACTION_ID,
      ],
    });
    expect(settlePendingResultTasksFromOwnerCrossSignMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerActionId: OWNER_ACTION_ID,
        actorUid: ACTOR_UID,
      }),
    );
  });

  it('atomically appends the signed receipt, resolves the handoff, and settles exact tasks', async () => {
    const query = jest.fn(async (sql, ...params) => {
      if (sql.includes('JOIN users AS actor')) {
        return [authorizedCrossSignHandoff()];
      }
      if (sql.includes('action.idempotency_key = $2::text')) return [];
      if (sql.includes('prior_action.action_kind')) return [crossSignContext()];
      if (sql.includes('INSERT INTO diagnostic_result_actions')) {
        return [crossSignActionRow({
          id: params[0],
          signature_id: params[13],
          canonical_timeline_event_id: params[14],
          canonical_audit_event_id: params[15],
        })];
      }
      if (sql.includes('UPDATE discharge_pending_result_handoffs')) {
        return [authorizedCrossSignHandoff({
          handoff_state: 'resolved',
          result_status: 'reviewed',
          resolved_at: new Date('2026-07-23T10:00:00.000Z'),
          resolved_by_uid: ACTOR_UID,
          resolution_action_id: params[5],
        })];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    activeTx = { $queryRawUnsafe: query };

    const result = await recordPendingResultOwnerCrossSign(
      17,
      HANDOFF_ID,
      input(),
      actor(),
    );

    expect(result).toMatchObject({
      admission_id: 17,
      handoff_id: HANDOFF_ID,
      generation_id: GENERATION_ID,
      diagnostic_action_id: DIAGNOSTIC_ACTION_ID,
      pathway_instance_id: PATHWAY_ID,
      owner_action_id: OWNER_ACTION_ID,
      action_task_id: 101,
      tracking_task_id: 91,
      handoff_state: 'resolved',
      current_handoff_state: 'resolved',
      generation_snapshot_sha256: SNAPSHOT_SHA256,
      request_sha256: crossSignRequestSha256(),
      replayed: false,
    });
    expect(result.id).toBe(result.resolution_action_id);
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'discharge.pending_result_resolved',
        eventStatus: 'owner_cross_signed',
        resourceType: 'discharge_pending_result_handoff',
        resourceTable: 'discharge_pending_result_handoffs',
        resourceId: HANDOFF_ID,
        payload: expect.objectContaining({
          handoff_id: HANDOFF_ID,
          generation_id: GENERATION_ID,
          diagnostic_action_id: DIAGNOSTIC_ACTION_ID,
          owner_action_id: OWNER_ACTION_ID,
          action_task_id: 101,
          tracking_task_id: 91,
        }),
      }),
      expect.objectContaining({ db: activeTx, strict: true }),
    );
    expect(signDocumentTxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        documentType: 'diagnostic_result_action',
        documentId: result.id,
        signatureId: result.signature_id,
        canonicalAuditResourceTable: 'discharge_pending_result_handoffs',
        canonicalAuditResourceId: HANDOFF_ID,
      }),
      expect.objectContaining({
        actorUid: ACTOR_UID,
        actorRole: 'DOCTOR',
      }),
      { tx: activeTx },
    );
    expect(publishEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'discharge.pending_result_resolved',
      aggregateType: 'discharge_pending_result_handoff',
      aggregateId: HANDOFF_ID,
      payload: expect.objectContaining({
        resolution_action_id: result.id,
        action_task_id: 101,
        tracking_task_id: 91,
      }),
    }));
    expect(settlePendingResultTasksFromOwnerCrossSignMock).toHaveBeenCalledWith(
      expect.objectContaining({
        handoffId: HANDOFF_ID,
        generationId: GENERATION_ID,
        ownerActionId: OWNER_ACTION_ID,
        crossSignActionId: result.id,
        actionTaskId: 101,
        trackingTaskId: 91,
        actorUid: ACTOR_UID,
        tx: activeTx,
      }),
    );
  });

  it('replays an immutable historical receipt after rearm without touching current tasks', async () => {
    const seenSql = [];
    activeTx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        seenSql.push(sql);
        if (sql.includes('JOIN users AS actor')) {
          return [authorizedCrossSignHandoff({
            task_id: 191,
            handoff_state: 'result_available',
            result_status: 'available',
          })];
        }
        if (sql.includes('action.idempotency_key = $2::text')) {
          return [crossSignActionRow({
            tracking_task_id: 91,
            current_handoff_state: 'result_available',
          })];
        }
        throw new Error(`Historical replay attempted a current-state mutation: ${sql}`);
      }),
    };

    const result = await recordPendingResultOwnerCrossSign(
      17,
      HANDOFF_ID,
      input(),
      actor(),
    );

    expect(result).toMatchObject({
      resolution_action_id: CROSS_SIGN_ACTION_ID,
      action_task_id: 101,
      tracking_task_id: 91,
      handoff_state: 'resolved',
      current_handoff_state: 'result_available',
      replayed: true,
    });
    expect(seenSql).toHaveLength(2);
    expect(seenSql[1]).toContain('tracking_task.id = action_task.parent_task_id');
    expect(seenSql[1]).toContain('tracking_task.id AS tracking_task_id');
    expect(seenSql[1]).not.toContain('handoff.task_id AS tracking_task_id');
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
    expect(signDocumentTxMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(settlePendingResultTasksFromOwnerCrossSignMock).not.toHaveBeenCalled();
  });

  it('rejects a stale generation hash before appending canonical evidence', async () => {
    activeTx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('JOIN users AS actor')) return [authorizedCrossSignHandoff()];
        if (sql.includes('action.idempotency_key = $2::text')) return [];
        if (sql.includes('prior_action.action_kind')) {
          return [crossSignContext({ snapshot_sha256: 'b'.repeat(64) })];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    await expect(recordPendingResultOwnerCrossSign(
      17,
      HANDOFF_ID,
      input(),
      actor(),
    )).rejects.toMatchObject({
      code: 'INPATIENT_PENDING_RESULT_CROSS_SIGN_GENERATION_STALE',
    });
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
    expect(signDocumentTxMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a stale or superseded generation',
      null,
      'INPATIENT_PENDING_RESULT_CROSS_SIGN_NOT_ACTIONABLE',
    ],
    [
      'a mismatched current task binding',
      crossSignContext({ action_parent_task_id: 191 }),
      'INPATIENT_PENDING_RESULT_CROSS_SIGN_TASK_CONFLICT',
    ],
  ])('rejects %s without settlement', async (_label, context, expectedCode) => {
    activeTx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('JOIN users AS actor')) return [authorizedCrossSignHandoff()];
        if (sql.includes('action.idempotency_key = $2::text')) return [];
        if (sql.includes('prior_action.action_kind')) return context ? [context] : [];
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    await expect(recordPendingResultOwnerCrossSign(
      17,
      HANDOFF_ID,
      input(),
      actor(),
    )).rejects.toMatchObject({ code: expectedCode });
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
    expect(settlePendingResultTasksFromOwnerCrossSignMock).not.toHaveBeenCalled();
  });
});

describe('inpatient pending-result authoritative diagnostic settlement', () => {
  it.each([
    ['normal auto-close', 'normal_auto_closed', null, 'normal_auto_closed', 'normal'],
    [
      'same-owner doctor disposition',
      'doctor_disposition',
      ACTOR_UID,
      'ordering_owner_disposition',
      'reviewed',
    ],
  ])('atomically settles %s and its exact task pair', async (
    _label,
    actionKind,
    expectedResolvedBy,
    expectedEventStatus,
    expectedResultStatus,
  ) => {
    const query = jest.fn(async (sql, ...params) => {
      if (sql.includes('FROM diagnostic_result_actions AS diagnostic_action')) {
        return [pendingSettlementRow(actionKind)];
      }
      if (sql.includes('UPDATE discharge_pending_result_handoffs')) {
        expect(params[4]).toBe(expectedResolvedBy);
        expect(params[6]).toBe(expectedResultStatus);
        return [{ id: HANDOFF_ID }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const tx = { $queryRawUnsafe: query };

    const result = await settlePendingResultOwnerActionsForDiagnosticActionTx({
      tx,
      tenantId: TENANT_ID,
      diagnosticActionId: DIAGNOSTIC_ACTION_ID,
    });

    expect(result).toEqual([expect.objectContaining({
      handoff_id: HANDOFF_ID,
      generation_id: GENERATION_ID,
      owner_action_id: OWNER_ACTION_ID,
      resolution_action_id: DIAGNOSTIC_ACTION_ID,
      resolved_by_uid: expectedResolvedBy,
      action_task_id: 101,
      tracking_task_id: 91,
      replayed: false,
    })]);
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'discharge.pending_result_resolved',
        eventStatus: expectedEventStatus,
        sourceTable: 'diagnostic_result_actions',
        sourceId: DIAGNOSTIC_ACTION_ID,
        resourceType: 'discharge_pending_result_handoff',
        resourceTable: 'discharge_pending_result_handoffs',
        resourceId: HANDOFF_ID,
        actorUid: expectedResolvedBy,
        payload: {
          admission_id: 17,
          handoff_id: HANDOFF_ID,
          generation_id: GENERATION_ID,
          owner_action_id: OWNER_ACTION_ID,
          action_task_id: 101,
          tracking_task_id: 91,
          resolution_action_id: DIAGNOSTIC_ACTION_ID,
        },
      }),
      { db: tx, strict: true },
    );
    expect(publishEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'discharge.pending_result_resolved',
      aggregateType: 'discharge_pending_result_handoff',
      aggregateId: HANDOFF_ID,
      payload: expect.objectContaining({
        handoff_id: HANDOFF_ID,
        resolution_action_id: DIAGNOSTIC_ACTION_ID,
        canonical_timeline_event_id:
          'b0000000-0000-4000-8000-000000000001',
        canonical_audit_event_id:
          'c0000000-0000-4000-8000-000000000001',
        admission_lineage_version: 1,
      }),
    }));
    expect(settlePendingResultTasksFromDiagnosticActionMock).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      handoffId: HANDOFF_ID,
      generationId: GENERATION_ID,
      ownerActionId: OWNER_ACTION_ID,
      diagnosticActionId: DIAGNOSTIC_ACTION_ID,
      actionTaskId: 101,
      trackingTaskId: 91,
      patientUid: PATIENT_UID,
      tx,
    });
  });

  it('leaves a different-owner doctor disposition available for named-owner cross-sign', async () => {
    const query = jest.fn(async (sql) => {
      expect(sql).toContain(
        'diagnostic_action.actor_uid = handoff.named_physician_uid',
      );
      return [];
    });
    const tx = { $queryRawUnsafe: query };

    await expect(settlePendingResultOwnerActionsForDiagnosticActionTx({
      tx,
      tenantId: TENANT_ID,
      diagnosticActionId: DIAGNOSTIC_ACTION_ID,
    })).resolves.toEqual([]);
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(settlePendingResultTasksFromDiagnosticActionMock).not.toHaveBeenCalled();
  });

  it('repairs exact task settlement on diagnostic-action replay without duplicating evidence', async () => {
    const query = jest.fn(async () => [pendingSettlementRow('normal_auto_closed', {
      handoff_state: 'resolved',
      result_status: 'normal',
      resolution_action_id: DIAGNOSTIC_ACTION_ID,
      resolved_at: new Date('2026-07-23T10:00:00.000Z'),
      resolved_by_uid: null,
    })]);
    const tx = { $queryRawUnsafe: query };
    settlePendingResultTasksFromDiagnosticActionMock.mockResolvedValueOnce({
      action_task_id: 101,
      tracking_task_id: 91,
      replayed: true,
    });

    const result = await settlePendingResultOwnerActionsForDiagnosticActionTx({
      tx,
      tenantId: TENANT_ID,
      diagnosticActionId: DIAGNOSTIC_ACTION_ID,
    });

    expect(result).toEqual([expect.objectContaining({
      resolution_action_id: DIAGNOSTIC_ACTION_ID,
      replayed: true,
    })]);
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('inpatient evidence mutation replay safety', () => {
  it('rejects a new pending-result handoff after discharge under the admission lock', async () => {
    activeTx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM admissions')) {
          return [admissionRow({ status: 'discharged' })];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    await expect(recordPendingResultHandoff(17, {
      source_type: 'lab_result',
      source_id: '73',
      resource_reference_id: REFERENCE_ID,
    }, {
      tenantId: TENANT_ID,
      uid: ACTOR_UID,
      role: 'DOCTOR',
    })).rejects.toMatchObject({
      code: 'INPATIENT_PENDING_RESULT_ADMISSION_NOT_ACTIVE',
    });
    expect(activeTx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(createTaskMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('authorizes the actor before reading a post-discharge contact replay', async () => {
    const seenSql = [];
    activeTx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        seenSql.push(sql);
        if (sql.includes('FROM admissions')) {
          return [admissionRow({ status: 'discharged' })];
        }
        if (sql.includes('FROM inpatient_primary_physician_assignments')) {
          return [assignmentRow(OTHER_PHYSICIAN_UID)];
        }
        if (sql.includes('FROM users')) return [liveActorRow('NURSING_STAFF')];
        throw new Error(`Replay lookup ran before authorization: ${sql}`);
      }),
    };

    await expect(recordPostDischargeContact(17, {
      event_kind: 'attempt',
      contact_source: 'manual',
      contact_channel: 'phone',
      idempotency_key: 'contact-1',
    }, {
      tenantId: TENANT_ID,
      uid: ACTOR_UID,
      role: 'NURSING_STAFF',
    })).rejects.toMatchObject({ code: 'INPATIENT_EVIDENCE_FORBIDDEN' });
    expect(seenSql.some((sql) => sql.includes('post_discharge_contact_events'))).toBe(false);
  });

  it.each(['lama', 'expired'])(
    'keeps an exceptional %s departure out of the ordinary contact path',
    async (status) => {
      activeTx = {
        $queryRawUnsafe: jest.fn(async (sql) => {
          if (sql.includes('FROM admissions')) return [admissionRow({ status })];
          throw new Error(`Unexpected SQL: ${sql}`);
        }),
      };

      await expect(recordPostDischargeContact(17, {
        event_kind: 'attempt',
        contact_source: 'manual',
        contact_channel: 'phone',
        idempotency_key: `contact-${status}`,
      }, {
        tenantId: TENANT_ID,
        uid: ACTOR_UID,
        role: 'DOCTOR',
      })).rejects.toMatchObject({
        code: 'POST_DISCHARGE_CONTACT_EXCEPTIONAL_DEPARTURE',
      });
      expect(activeTx.$queryRawUnsafe).toHaveBeenCalledTimes(1);
      expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
      expect(publishEventMock).not.toHaveBeenCalled();
    },
  );

  it('rejects a follow-up exception key reused with a different reason', async () => {
    activeTx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM admissions')) {
          return [admissionRow({ attending_doctor: ACTOR_UID })];
        }
        if (sql.includes('FROM inpatient_primary_physician_assignments')) {
          return [assignmentRow()];
        }
        if (sql.includes('FROM users')) return [liveActorRow()];
        if (sql.includes('FROM clinical_timeline_events')) {
          return [{ id: 'timeline', actor_uid: ACTOR_UID, reason: 'Original reason' }];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    await expect(recordFollowUpException(17, {
      reason: 'Different reason',
      idempotency_key: 'exception-1',
    }, {
      tenantId: TENANT_ID,
      uid: ACTOR_UID,
      role: 'DOCTOR',
    })).rejects.toMatchObject({
      code: 'INPATIENT_FOLLOW_UP_EXCEPTION_IDEMPOTENCY_CONFLICT',
    });
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('does not silently replace a different signed summary', async () => {
    activeTx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM admissions')) return [admissionRow()];
        if (sql.includes('FROM discharge_pending_result_handoffs')) {
          return [pendingHandoff({ discharge_summary_id: 44 })];
        }
        if (sql.includes('FROM inpatient_primary_physician_assignments')) {
          return [assignmentRow()];
        }
        if (sql.includes('FROM users')) return [liveActorRow()];
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    await expect(recordPendingResultSummaryInclusion(17, HANDOFF_ID, {
      discharge_summary_id: 45,
    }, {
      tenantId: TENANT_ID,
      uid: ACTOR_UID,
      role: 'DOCTOR',
    })).rejects.toMatchObject({
      code: 'INPATIENT_PENDING_RESULT_SUMMARY_SUPERSESSION_REQUIRED',
    });
  });

  it('rejects arbitrary public handoff metadata before opening a transaction', async () => {
    await expect(recordPendingResultHandoff(17, {
      source_type: 'lab_result',
      source_id: '73',
      resource_reference_id: REFERENCE_ID,
      metadata: { internal: true },
    }, {
      tenantId: TENANT_ID,
      uid: ACTOR_UID,
      role: 'DOCTOR',
    })).rejects.toMatchObject({
      code: 'INPATIENT_PENDING_RESULT_METADATA_NOT_ALLOWED',
    });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it('rejects a terminal source before creating pending-result work', async () => {
    activeTx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM admissions')) return [admissionRow()];
        if (sql.includes('FROM inpatient_primary_physician_assignments')) {
          return [assignmentRow()];
        }
        if (sql.includes('FROM users')) return [liveActorRow()];
        if (sql.includes('FROM care_pathway_resource_references AS reference')) {
          return [{
            id: REFERENCE_ID,
            resource_type: 'lab_result',
            resource_id: '73',
          }];
        }
        if (sql.includes('FROM (') && sql.includes('FROM lab_results AS source')) {
          return [{
            source_type: 'lab_result',
            source_id: '73',
            status: 'final',
            patient_safe_label: 'Complete blood count',
            terminal: true,
            requires_safety_action: false,
            safety_action_complete: false,
          }];
        }
        if (sql.includes('FROM discharge_pending_result_handoffs')) return [];
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    await expect(recordPendingResultHandoff(17, {
      source_type: 'lab_result',
      source_id: '73',
      resource_reference_id: REFERENCE_ID,
    }, {
      tenantId: TENANT_ID,
      uid: ACTOR_UID,
      role: 'DOCTOR',
    })).rejects.toMatchObject({ code: 'INPATIENT_PENDING_RESULT_SOURCE_TERMINAL' });
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('revalidates a conflicting post-discharge contact winner before publishing', async () => {
    let contactReads = 0;
    const seenSql = [];
    activeTx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        seenSql.push(sql);
        if (sql.includes('FROM admissions')) {
          return [admissionRow({ status: 'discharged' })];
        }
        if (sql.includes('FROM inpatient_primary_physician_assignments')) {
          return [assignmentRow()];
        }
        if (sql.includes('FROM users')) return [liveActorRow()];
        if (sql.includes('pg_advisory_xact_lock')) return [{ locked: true }];
        if (sql.includes('FROM post_discharge_contact_events')) {
          contactReads += 1;
          return contactReads === 1
            ? []
            : [{
                id: HANDOFF_ID,
                admission_id: 17,
                patient_uid: PATIENT_UID,
                event_kind: 'outcome',
                contact_source: 'manual',
                contact_channel: 'phone',
                outcome_code: 'different',
                policy_rule_code: null,
                patient_safe_summary: null,
                recorded_by_uid: ACTOR_UID,
                recorded_by_system_key: null,
                occurred_at: new Date(),
              }];
        }
        if (sql.includes('INSERT INTO post_discharge_contact_events')) return [];
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    await expect(recordPostDischargeContact(17, {
      event_kind: 'attempt',
      contact_source: 'manual',
      contact_channel: 'phone',
      idempotency_key: 'contact-race',
    }, {
      tenantId: TENANT_ID,
      uid: ACTOR_UID,
      role: 'DOCTOR',
    })).rejects.toMatchObject({ code: 'POST_DISCHARGE_CONTACT_IDEMPOTENCY_CONFLICT' });
    expect(seenSql.find((sql) => sql.includes('pg_advisory_xact_lock')))
      .toContain('IS NULL');
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied registered-policy recorder identity', async () => {
    await expect(recordPostDischargeContact(17, {
      event_kind: 'attempt',
      contact_source: 'registered_policy',
      contact_channel: 'phone',
      policy_rule_code: 'policy.followup',
      recorded_by_system_key: 'forged.system.v1',
      idempotency_key: 'forged-policy',
    }, {
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({ code: 'POST_DISCHARGE_CONTACT_METADATA_NOT_ALLOWED' });
    expect(setTenantTxMock).not.toHaveBeenCalled();
  });

  it.each([
    ['deactivated', [], 'MEDICAL_SUPERINTENDENT'],
    ['deleted', [], 'MEDICAL_SUPERINTENDENT'],
    ['demoted', [liveActorRow('DOCTOR')], 'MEDICAL_SUPERINTENDENT'],
  ])('rejects a %s privileged JWT before contact replay', async (_label, actorRows, claimedRole) => {
    const seenSql = [];
    activeTx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        seenSql.push(sql);
        if (sql.includes('FROM admissions')) {
          return [admissionRow({ status: 'discharged' })];
        }
        if (sql.includes('FROM inpatient_primary_physician_assignments')) {
          return [assignmentRow(OTHER_PHYSICIAN_UID)];
        }
        if (sql.includes('FROM users')) return actorRows;
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };
    await expect(recordPostDischargeContact(17, {
      event_kind: 'attempt',
      contact_source: 'manual',
      contact_channel: 'phone',
      idempotency_key: `stale-${_label}`,
    }, {
      tenantId: TENANT_ID,
      uid: ACTOR_UID,
      role: claimedRole,
    })).rejects.toMatchObject({
      code: _label === 'demoted'
        ? 'INPATIENT_EVIDENCE_FORBIDDEN'
        : 'INPATIENT_EVIDENCE_ACTOR_UNAVAILABLE',
    });
    expect(seenSql.some((sql) => sql.includes('post_discharge_contact_events'))).toBe(false);
  });

  it('rejects evidence when the assigned physician has become unavailable', async () => {
    activeTx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM admissions')) {
          return [admissionRow({ status: 'discharged' })];
        }
        if (sql.includes('FROM inpatient_primary_physician_assignments')) {
          return [assignmentRow(ACTOR_UID, { physician_is_active: false })];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };
    await expect(recordPostDischargeContact(17, {
      event_kind: 'attempt',
      contact_source: 'manual',
      contact_channel: 'phone',
      idempotency_key: 'inactive-assignment',
    }, {
      tenantId: TENANT_ID,
      uid: ACTOR_UID,
      role: 'DOCTOR',
    })).rejects.toMatchObject({ code: 'INPATIENT_PRIMARY_PHYSICIAN_UNAVAILABLE' });
  });

  it('rejects a handoff replay when the patient-safe label or author changes', async () => {
    activeTx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM admissions')) return [admissionRow()];
        if (sql.includes('FROM inpatient_primary_physician_assignments')) {
          return [assignmentRow()];
        }
        if (sql.includes('FROM users')) return [liveActorRow()];
        if (sql.includes('FROM care_pathway_resource_references AS reference')) {
          return [{
            id: REFERENCE_ID,
            resource_type: 'lab_result',
            resource_id: '73',
            workflow_run_id: 'a0000000-0000-4000-8000-000000000001',
          }];
        }
        if (sql.includes('FROM (') && sql.includes('FROM lab_results AS source')) {
          return [{
            source_type: 'lab_result',
            source_id: '73',
            status: 'pending',
            patient_safe_label: 'Complete blood count',
            terminal: false,
            requires_safety_action: false,
            safety_action_complete: false,
          }];
        }
        if (sql.includes('FROM discharge_pending_result_handoffs')) {
          return [pendingHandoff({
            idempotency_key: 'lab_result:73',
            patient_safe_label: 'Original label',
            created_by_uid: OTHER_PHYSICIAN_UID,
          })];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    await expect(recordPendingResultHandoff(17, {
      source_type: 'lab_result',
      source_id: '73',
      resource_reference_id: REFERENCE_ID,
      patient_safe_label: 'Changed label',
    }, {
      tenantId: TENANT_ID,
      uid: ACTOR_UID,
      role: 'DOCTOR',
    })).rejects.toMatchObject({
      code: 'INPATIENT_PENDING_RESULT_IDEMPOTENCY_CONFLICT',
    });
    expect(createTaskMock).not.toHaveBeenCalled();
  });
});

describe('inpatient primary physician and handler fail-closed behavior', () => {
  it('returns the exact current same-physician assignment without new evidence', async () => {
    const current = assignmentRow(ACTOR_UID);
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql, ...args) => {
        if (sql.includes('FROM users')) {
          return [{
            uid: args[1],
            name: 'Physician',
            role: 'DOCTOR',
          }];
        }
        if (sql.includes('FROM inpatient_primary_physician_assignments')) {
          return [current];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    await expect(recordPrimaryPhysicianChangeTx({
      tx,
      admission: admissionRow({ attending_doctor: ACTOR_UID }),
      physicianUid: ACTOR_UID,
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
      mode: 'active',
    })).resolves.toEqual({
      mode: 'active',
      assignment: current,
      idempotent_replay: true,
    });
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
    expect(publishEventMock).not.toHaveBeenCalled();
  });

  it('atomically moves every live pending-result task and handoff after an accepted transfer', async () => {
    const prior = assignmentRow(ACTOR_UID);
    const next = assignmentRow(TRANSFERRED_OWNER_UID, {
      id: NEXT_ASSIGNMENT_ID,
      assignment_version: 2,
      assignment_source: 'accepted_covering_handoff',
      accepted_handoff_id: COVERING_HANDOFF_ID,
      supersedes_assignment_id: ASSIGNMENT_ID,
    });
    const query = jest.fn(async (sql, ...args) => {
      if (sql.includes('FROM users')) {
        return [{
          uid: args[1],
          name: 'Transferred physician',
          role: 'DOCTOR',
        }];
      }
      if (sql.includes('FROM inpatient_primary_physician_assignments')) {
        return [prior];
      }
      if (sql.includes('FROM care_handoff_instances AS handoff')) {
        return [{
          id: COVERING_HANDOFF_ID,
          accepted_by_uid: TRANSFERRED_OWNER_UID,
          intended_recipient_uid: TRANSFERRED_OWNER_UID,
          accepted_at: new Date('2026-07-23T09:30:00.000Z'),
        }];
      }
      if (sql.includes('INSERT INTO inpatient_primary_physician_assignments')) {
        return [next];
      }
      if (
        sql.includes('FROM discharge_pending_result_handoffs')
        && sql.includes('FOR UPDATE')
      ) {
        return [{ id: HANDOFF_ID, task_id: 91 }];
      }
      if (sql.includes('UPDATE discharge_pending_result_handoffs')) return [];
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const tx = { $queryRawUnsafe: query };

    await expect(recordPrimaryPhysicianChangeTx({
      tx,
      admission: admissionRow({
        attending_doctor: TRANSFERRED_OWNER_UID,
      }),
      physicianUid: TRANSFERRED_OWNER_UID,
      acceptedHandoffId: COVERING_HANDOFF_ID,
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
      mode: 'active',
    })).resolves.toEqual({
      mode: 'active',
      assignment: next,
    });

    const handoffUpdateIndex = query.mock.calls.findIndex(([sql]) => (
      sql.includes('UPDATE discharge_pending_result_handoffs')
    ));
    expect(reassignPendingResultTasksMock).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      admissionId: 17,
      patientUid: PATIENT_UID,
      priorAssignmentId: ASSIGNMENT_ID,
      assignmentId: NEXT_ASSIGNMENT_ID,
      acceptedHandoffId: COVERING_HANDOFF_ID,
      priorPhysicianUid: ACTOR_UID,
      physicianUid: TRANSFERRED_OWNER_UID,
      actorUid: ACTOR_UID,
      tx,
    });
    expect(handoffUpdateIndex).toBeGreaterThan(-1);
    expect(
      reassignPendingResultTasksMock.mock.invocationCallOrder[0],
    ).toBeLessThan(query.mock.invocationCallOrder[handoffUpdateIndex]);
    expect(query.mock.calls[handoffUpdateIndex]).toEqual(
      expect.arrayContaining([
        expect.stringContaining('primary_physician_assignment_id = $4::uuid'),
        NEXT_ASSIGNMENT_ID,
        TRANSFERRED_OWNER_UID,
      ]),
    );
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'admission.primary_physician.reassigned',
        eventStatus: 'accepted',
        payload: expect.objectContaining({
          physician_uid: TRANSFERRED_OWNER_UID,
          accepted_handoff_id: COVERING_HANDOFF_ID,
          supersedes_assignment_id: ASSIGNMENT_ID,
        }),
      }),
      expect.objectContaining({ db: tx, strict: true }),
    );
  });

  it('establishes a missing initial assignment before enforcing handoff reassignment', async () => {
    let assignmentReads = 0;
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql, ...args) => {
        if (sql.includes('FROM users')) {
          return [{
            uid: args[1],
            name: 'Physician',
            role: 'DOCTOR',
          }];
        }
        if (sql.includes('FROM inpatient_primary_physician_assignments')) {
          assignmentReads += 1;
          return [];
        }
        if (sql.includes('INSERT INTO inpatient_primary_physician_assignments')) {
          return [assignmentRow(OTHER_PHYSICIAN_UID)];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    await expect(recordPrimaryPhysicianChangeTx({
      tx,
      admission: admissionRow(),
      physicianUid: ACTOR_UID,
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
      mode: 'active',
    })).rejects.toMatchObject({
      code: 'INPATIENT_ACCEPTED_COVERING_HANDOFF_REQUIRED',
    });
    expect(assignmentReads).toBe(2);
  });

  it('blocks discharge evidence while exact diagnostic lineage is incomplete', async () => {
    const completeEvidence = {
      primary_physician_is_viable: true,
      discharge_summary_signed: true,
      patient_guardian_instructions_recorded: true,
      escalation_contact_recorded: true,
      equipment_home_care_plan_recorded: true,
      discharge_destination_recorded: true,
      transport_plan_recorded: true,
      medication_reconciliation_completed: true,
      follow_up_appointment_id: 12,
      follow_up_exception_recorded: false,
      unhanded_pending_result_count: 0,
      invalid_pending_result_handoff_count: 0,
      unresolved_diagnostic_safety_action_count: 0,
      diagnostic_lineage_complete: false,
    };
    await expect(
      INPATIENT_PATHWAY_RUNTIME_HANDLERS.dischargeEvidence.evaluate({
        loadedEvidence: completeEvidence,
      }),
    ).resolves.toMatchObject({ decision: 'blocked' });
    await expect(
      INPATIENT_PATHWAY_RUNTIME_HANDLERS.dischargeEvidence.evaluate({
        loadedEvidence: {
          ...completeEvidence,
          diagnostic_lineage_complete: true,
        },
      }),
    ).resolves.toMatchObject({ decision: 'satisfied' });
  });

  it.each([
    'patient_guardian_instructions_recorded',
    'escalation_contact_recorded',
    'equipment_home_care_plan_recorded',
    'discharge_destination_recorded',
    'transport_plan_recorded',
  ])('keeps discharge evidence blocked when %s is missing', async (missingField) => {
    const completeEvidence = {
      primary_physician_is_viable: true,
      discharge_summary_signed: true,
      patient_guardian_instructions_recorded: true,
      escalation_contact_recorded: true,
      equipment_home_care_plan_recorded: true,
      discharge_destination_recorded: true,
      transport_plan_recorded: true,
      medication_reconciliation_completed: true,
      follow_up_appointment_id: 12,
      follow_up_exception_recorded: false,
      unhanded_pending_result_count: 0,
      invalid_pending_result_handoff_count: 0,
      unresolved_diagnostic_safety_action_count: 0,
      diagnostic_lineage_complete: true,
    };
    completeEvidence[missingField] = false;

    await expect(
      INPATIENT_PATHWAY_RUNTIME_HANDLERS.dischargeEvidence.evaluate({
        loadedEvidence: completeEvidence,
      }),
    ).resolves.toMatchObject({ decision: 'blocked' });
  });

  it.each(['lama', 'expired'])(
    'does not silently finalize the normal pathway for a %s departure',
    async (status) => {
      const departureEvidence = {
        admission_status: status,
        discharged_at_recorded: true,
        post_discharge_contact_count: 1,
      };
      await expect(
        INPATIENT_PATHWAY_RUNTIME_HANDLERS.dischargeCompletion.evaluate({
          loadedEvidence: departureEvidence,
        }),
      ).resolves.toMatchObject({
        decision: 'blocked',
        evidence: {
          exceptional_departure_requires_governed_reconciliation: true,
        },
      });
      await expect(
        INPATIENT_PATHWAY_RUNTIME_HANDLERS.postDischargeContact.evaluate({
          loadedEvidence: departureEvidence,
          tasks: [],
          handoffs: [],
        }),
      ).resolves.toMatchObject({
        decision: 'blocked',
        evidence: {
          exceptional_departure_requires_governed_reconciliation: true,
        },
      });
    },
  );

  it('restricts runtime handoff counts to exact nonterminal sources while retaining safety gates', async () => {
    let capturedSql = '';
    const tx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        capturedSql = sql;
        return [{
          id: 17,
          patient_uid: PATIENT_UID,
          admission_status: 'admitted',
          primary_physician_is_viable: true,
          unhanded_pending_result_count: 0,
          invalid_pending_result_handoff_count: 0,
          unresolved_diagnostic_safety_action_count: 0,
          diagnostic_lineage_expected_source_count: 1,
          diagnostic_lineage_current_reference_count: 1,
          diagnostic_lineage_missing_reference_count: 0,
          diagnostic_lineage_orphan_reference_count: 0,
        }];
      }),
    };
    await loadInpatientPathwayEvidence({
      tx,
      tenantId: TENANT_ID,
      instance: {
        id: PATHWAY_ID,
        source_episode_type: 'admission',
        source_episode_id: '17',
      },
    });
    expect(capturedSql).toContain('source.terminal IS NOT TRUE');
    expect(capturedSql).toContain("UPPER(COALESCE(source.status, '')) IN ('COMPLETED', 'CANCELLED')");
    expect(capturedSql).toContain('source.requires_safety_action IS TRUE');
    expect(capturedSql).toContain('source.safety_action_complete IS NOT TRUE');
    expect(capturedSql).toContain(
      "LOWER(section.section_key) = 'patient_guardian_instructions'",
    );
    expect(capturedSql).toContain("LOWER(section.section_key) = 'escalation_contact'");
    expect(capturedSql).toContain(
      "LOWER(section.section_key) = 'required_equipment_home_care'",
    );
    expect(capturedSql).toContain("LOWER(section.section_key) = 'discharge_destination'");
    expect(capturedSql).toContain("LOWER(section.section_key) = 'transport_plan'");
    expect(capturedSql).toContain("STRPOS(LOWER(section.body), '[placeholder') = 0");
  });

  it('fails closed when an exact admission-linked source has not been projected', async () => {
    activeTx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM admissions')) {
          return [admissionRow({ attending_doctor: ACTOR_UID })];
        }
        if (sql.includes('FROM care_pathway_instances')) {
          return [{
            id: PATHWAY_ID,
            workflow_run_id: 'a0000000-0000-4000-8000-000000000001',
            patient_uid: PATIENT_UID,
            owning_clinician_uid: ACTOR_UID,
            clinical_status: 'active',
          }];
        }
        if (sql.includes('FROM inpatient_primary_physician_assignments')) {
          return [assignmentRow()];
        }
        if (
          sql.includes('FROM care_pathway_resource_references AS reference')
          && sql.includes("relationship_kind = 'child_action'")
        ) return [];
        if (
          sql.includes('FROM care_pathway_resource_references AS reference')
          && sql.includes("resource_type = 'admission'")
        ) return [{ id: 'd0000000-0000-4000-8000-000000000001' }];
        if (sql.includes('FROM (') && sql.includes('FROM lab_results AS source')) {
          return [{
            source_type: 'lab_result',
            source_id: '73',
            status: 'pending',
            patient_safe_label: 'Complete blood count',
            terminal: false,
            requires_safety_action: false,
            safety_action_complete: false,
          }];
        }
        if (sql.includes('FROM discharge_pending_result_handoffs AS handoff')) return [];
        if (sql.includes('FROM discharge_summaries')) return [];
        if (sql.includes('FROM medication_reconciliations')) return [];
        if (sql.includes('FROM follow_up_plans AS plan')) return [];
        if (sql.includes('FROM clinical_timeline_events AS timeline')) return [];
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    const result = await getInpatientDischargeEvidence(17, { tenantId: TENANT_ID });
    expect(result.pending_results).toMatchObject({
      projection_ready: false,
      references_found: 0,
      references_expected: 1,
      missing_reference_count: 1,
      unresolved_reference_count: 0,
      reconciliation_debt: [{
        code: 'PENDING_RESULT_REFERENCE_MISSING',
        source_type: 'lab_result',
        source_id: '73',
      }],
    });
    expect(result.pending_results.items[0]).toMatchObject({
      source_type: 'lab_result',
      source_id: '73',
      blocking: true,
      blocker_codes: ['PENDING_RESULT_REFERENCE_MISSING'],
    });
    expect(result.active_blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'PENDING_RESULT_PROJECTION_NOT_READY' }),
    ]));
  });

  it.each([
    ['normal', false, ACTOR_UID, ACTOR_UID, false, null, null],
    ['abnormal', true, ACTOR_UID, ACTOR_UID, false, null, null],
    [
      'normal with an unapplied accepted owner transfer',
      false,
      TRANSFERRED_OWNER_UID,
      ACTOR_UID,
      true,
      null,
      null,
    ],
    [
      'normal with a split admission attending',
      false,
      ACTOR_UID,
      TRANSFERRED_OWNER_UID,
      true,
      null,
      null,
    ],
    [
      'normal with a fully applied accepted owner transfer',
      false,
      TRANSFERRED_OWNER_UID,
      TRANSFERRED_OWNER_UID,
      false,
      {
        id: NEXT_ASSIGNMENT_ID,
        assignment_version: 2,
        assignment_source: 'accepted_covering_handoff',
        accepted_handoff_id: COVERING_HANDOFF_ID,
        supersedes_assignment_id: ASSIGNMENT_ID,
      },
      true,
    ],
    [
      'normal with an unproven accepted owner transfer',
      false,
      TRANSFERRED_OWNER_UID,
      TRANSFERRED_OWNER_UID,
      true,
      {
        id: NEXT_ASSIGNMENT_ID,
        assignment_version: 2,
        assignment_source: 'accepted_covering_handoff',
        accepted_handoff_id: COVERING_HANDOFF_ID,
        supersedes_assignment_id: ASSIGNMENT_ID,
      },
      false,
    ],
  ])(
    'evaluates a terminal %s generation with exact projection',
    async (
      classification,
      requiresSafetyAction,
      pathwayOwnerUid,
      admissionAttendingUid,
      expectOwnerDivergence,
      assignmentOverrides,
      acceptedHandoffProven,
    ) => {
      activeTx = {
        $queryRawUnsafe: jest.fn(async (sql) => {
          if (sql.includes('FROM admissions')) {
            return [admissionRow({ attending_doctor: admissionAttendingUid })];
          }
          if (sql.includes('FROM care_pathway_instances')) {
            return [{
              id: PATHWAY_ID,
              workflow_run_id: 'a0000000-0000-4000-8000-000000000001',
              patient_uid: PATIENT_UID,
              owning_clinician_uid: pathwayOwnerUid,
              clinical_status: 'active',
            }];
          }
          if (sql.includes('FROM inpatient_primary_physician_assignments')) {
            return [assignmentRow(
              assignmentOverrides ? TRANSFERRED_OWNER_UID : ACTOR_UID,
              assignmentOverrides || {},
            )];
          }
          if (sql.includes('FROM care_handoff_instances AS handoff')) {
            return acceptedHandoffProven ? [{ '?column?': 1 }] : [];
          }
          if (
            sql.includes('FROM care_pathway_resource_references AS reference')
            && sql.includes("relationship_kind = 'child_action'")
          ) {
            return [{
              id: REFERENCE_ID,
              resource_type: 'diagnostic_result_generation',
              resource_id: GENERATION_ID,
              relationship_kind: 'child_action',
              evidence_state: 'open',
            }];
          }
          if (
            sql.includes('FROM care_pathway_resource_references AS reference')
            && sql.includes("resource_type = 'admission'")
          ) {
            return [{ id: 'd0000000-0000-4000-8000-000000000001' }];
          }
          if (sql.includes('FROM (') && sql.includes('diagnostic_result_generations AS source')) {
            return [{
              source_type: 'diagnostic_result_generation',
              source_id: GENERATION_ID,
              status: classification,
              patient_safe_label: 'Diagnostic result',
              terminal: true,
              requires_safety_action: requiresSafetyAction,
              safety_action_complete: true,
            }];
          }
          if (sql.includes('FROM discharge_pending_result_handoffs AS handoff')) return [];
          if (sql.includes('FROM discharge_summaries')) {
            return [{
              id: 44,
              status: 'signed',
              signed_by: ACTOR_UID,
              signed_at: new Date(),
              patient_guardian_instructions_section_id: 81,
              escalation_contact_section_id: 82,
              required_equipment_home_care_section_id: 83,
              discharge_destination_section_id: 84,
              transport_plan_section_id: 85,
            }];
          }
          if (sql.includes('FROM medication_reconciliations')) {
            return [{ id: 'reconciliation', status: 'completed' }];
          }
          if (sql.includes('FROM follow_up_plans AS plan')) {
            return [{ id: 12, appointment_id: 13, status: 'scheduled' }];
          }
          if (sql.includes('FROM clinical_timeline_events AS timeline')) return [];
          throw new Error(`Unexpected SQL: ${sql}`);
        }),
      };

      const result = await getInpatientDischargeEvidence(17, { tenantId: TENANT_ID });
      expect(result.pending_results).toMatchObject({
        projection_ready: true,
        references_found: 1,
        references_expected: 1,
        missing_reference_count: 0,
        unresolved_reference_count: 0,
        items: [],
      });
      expect(result.active_blockers).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'PENDING_RESULT_HANDOFF_INCOMPLETE' }),
      ]));
      if (expectOwnerDivergence) {
        expect(result.active_blockers).toEqual([
          expect.objectContaining({
            type: 'INPATIENT_OWNER_ASSIGNMENT_DIVERGED',
          }),
        ]);
      } else {
        expect(result.active_blockers).toEqual([]);
      }
    },
  );

  it.each([
    [
      'patient/guardian instructions',
      'patient_guardian_instructions_section_id',
      'PATIENT_GUARDIAN_INSTRUCTIONS_REQUIRED',
    ],
    ['escalation contact', 'escalation_contact_section_id', 'ESCALATION_CONTACT_REQUIRED'],
    [
      'equipment/home-care plan',
      'required_equipment_home_care_section_id',
      'EQUIPMENT_HOME_CARE_PLAN_REQUIRED',
    ],
    ['discharge destination', 'discharge_destination_section_id', 'DISCHARGE_DESTINATION_REQUIRED'],
    ['transport plan', 'transport_plan_section_id', 'TRANSPORT_PLAN_REQUIRED'],
  ])('fails closed when the signed summary omits %s', async (_label, missingField, blockerType) => {
    const completeSummary = {
      id: 44,
      status: 'signed',
      signed_by: ACTOR_UID,
      signed_at: new Date(),
      patient_guardian_instructions_section_id: 81,
      escalation_contact_section_id: 82,
      required_equipment_home_care_section_id: 83,
      discharge_destination_section_id: 84,
      transport_plan_section_id: 85,
    };
    completeSummary[missingField] = null;
    activeTx = {
      $queryRawUnsafe: jest.fn(async (sql) => {
        if (sql.includes('FROM admissions')) {
          return [admissionRow({ attending_doctor: ACTOR_UID })];
        }
        if (sql.includes('FROM care_pathway_instances')) {
          return [{
            id: PATHWAY_ID,
            workflow_run_id: 'a0000000-0000-4000-8000-000000000001',
            patient_uid: PATIENT_UID,
            owning_clinician_uid: ACTOR_UID,
            clinical_status: 'active',
          }];
        }
        if (sql.includes('FROM inpatient_primary_physician_assignments')) {
          return [assignmentRow()];
        }
        if (
          sql.includes('FROM care_pathway_resource_references AS reference')
          && sql.includes("relationship_kind = 'child_action'")
        ) return [];
        if (
          sql.includes('FROM care_pathway_resource_references AS reference')
          && sql.includes("resource_type = 'admission'")
        ) return [{ id: 'd0000000-0000-4000-8000-000000000001' }];
        if (sql.includes('FROM (') && sql.includes('diagnostic_result_generations AS source')) {
          return [];
        }
        if (sql.includes('FROM discharge_pending_result_handoffs AS handoff')) return [];
        if (sql.includes('FROM discharge_summaries')) return [completeSummary];
        if (sql.includes('FROM medication_reconciliations')) {
          return [{ id: 'reconciliation', status: 'completed' }];
        }
        if (sql.includes('FROM follow_up_plans AS plan')) {
          return [{ id: 12, appointment_id: 13, status: 'scheduled' }];
        }
        if (sql.includes('FROM clinical_timeline_events AS timeline')) return [];
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    };

    const result = await getInpatientDischargeEvidence(17, { tenantId: TENANT_ID });
    expect(result.active_blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: blockerType }),
    ]));
  });
});
