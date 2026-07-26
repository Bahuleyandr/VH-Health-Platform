import { jest } from '@jest/globals';

const TENANT_ID = '10000000-0000-4000-8000-000000000001';
const PATIENT_UID = '20000000-0000-4000-8000-000000000001';
const PHYSICIAN_UID = '21000000-0000-4000-8000-000000000001';
const GENERATION_ID = '40000000-0000-4000-8000-000000000001';
const DIAGNOSTIC_ACTION_ID = '50000000-0000-4000-8000-000000000001';
const APPOINTMENT_ID = 71;

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: jest.fn(),
}));
jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  getTenantById: jest.fn(),
  requireTenantId: value => value,
}));

const { __testing__ } = await import(
  '../../services/appointment/opPathwayWorkService.js'
);

function resultAvailableRow(overrides = {}) {
  return {
    admission_id: 73,
    handoff_id: '30000000-0000-4000-8000-000000000001',
    source_type: 'lab_result',
    patient_safe_label: 'Complete blood count',
    result_status: 'available',
    handoff_state: 'result_available',
    named_physician_uid: PHYSICIAN_UID,
    resolution_action_id: null,
    resolved_at: null,
    resolved_by_uid: null,
    owner_uid: PHYSICIAN_UID,
    owner_name: 'Dr Meera Rao',
    owner_role: 'DOCTOR',
    tracking_task_id: 91,
    tracking_task_status: 'in_progress',
    owner_action_id: '31000000-0000-4000-8000-000000000001',
    generation_id: GENERATION_ID,
    generation_snapshot_sha256: 'a'.repeat(64),
    diagnostic_classification: 'abnormal',
    action_task_id: 92,
    action_task_status: 'open',
    action_task_match_count: 1,
    diagnostic_action_id: DIAGNOSTIC_ACTION_ID,
    diagnostic_action_kind: 'doctor_disposition',
    diagnostic_disposition: 'treated',
    diagnostic_action_occurred_at: '2026-07-23T08:20:00.000Z',
    diagnostic_action_match_count: 1,
    can_cross_sign: true,
    tenant_id: TENANT_ID,
    patient_uid: PATIENT_UID,
    source_id: '41',
    metadata: { internal: true },
    ...overrides,
  };
}

test('projects only allowlisted staff-safe fields from the exact admission-origin follow-up', async () => {
  const query = jest.fn(async () => [resultAvailableRow()]);
  const result = await __testing__.listPriorAdmissionPendingResultsTx(
    { $queryRawUnsafe: query },
    {
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      appointmentId: APPOINTMENT_ID,
      appointmentStatus: 'CONFIRMED',
      actorUid: PHYSICIAN_UID,
      actorRole: 'DOCTOR',
    },
  );

  expect(result).toEqual([
    {
      admission_id: 73,
      handoff_id: '30000000-0000-4000-8000-000000000001',
      source_type: 'lab_result',
      patient_safe_label: 'Complete blood count',
      result_status: 'available',
      handoff_state: 'result_available',
      requires_action: true,
      can_cross_sign: true,
      named_owner: {
        uid: PHYSICIAN_UID,
        display_name: 'Dr Meera Rao',
        role: 'DOCTOR',
      },
      generation_id: GENERATION_ID,
      generation_snapshot_sha256: 'a'.repeat(64),
      diagnostic_classification: 'abnormal',
      diagnostic_action_id: DIAGNOSTIC_ACTION_ID,
      diagnostic_action_kind: 'doctor_disposition',
      diagnostic_disposition: 'treated',
      diagnostic_action_occurred_at: '2026-07-23T08:20:00.000Z',
      resolution_action_id: null,
      resolved_at: null,
      resolved_by_uid: null,
      tracking_task: {
        id: 91,
        status: 'in_progress',
      },
      action_task: {
        id: 92,
        status: 'open',
      },
      task: {
        id: 92,
        status: 'open',
      },
      route: 'investigations',
    },
  ]);
  expect(JSON.stringify(result)).not.toMatch(
    /tenant_id|patient_uid|source_id|metadata|owner_action_id|actor_uid|clinical_note/,
  );

  const [sql, ...params] = query.mock.calls[0];
  expect(sql).toContain("admission.status IN ('discharged', 'lama')");
  expect(sql).toContain('admission.discharged_at IS NOT NULL');
  expect(sql).toContain("handoff.handoff_state = ANY($4::text[])");
  expect(sql).toContain('plan.patient_uid = handoff.patient_uid');
  expect(sql).toContain('plan.appointment_id = $5::integer');
  expect(sql).toContain("plan.origin_kind = 'admission'");
  expect(sql).toContain("plan.origin_resource_type = 'admission'");
  expect(sql).toContain('plan.origin_resource_id = admission.id::text');
  expect(sql).toContain('follow_up_patient.uid = $2::uuid');
  expect(sql).toContain(
    "tracking_task.related_resource_type =\n            'discharge_pending_result_handoff'",
  );
  expect(sql).toContain(
    "task.related_resource_type =\n                 'discharge_pending_result_action'",
  );
  expect(sql).toContain(
    'FROM discharge_pending_result_owner_actions AS owner_action',
  );
  expect(sql).toContain(
    'owner_action.generation_id::text',
  );
  expect(sql).toContain(
    'task.assigned_to_uid = handoff.named_physician_uid',
  );
  expect(sql).toContain(
    'owner_action.owner_uid = handoff.named_physician_uid',
  );
  expect(sql).toContain(
    'generation.classification AS diagnostic_classification',
  );
  expect(sql).toContain(
    'diagnostic_action.disposition AS diagnostic_disposition',
  );
  expect(sql).toContain(
    'diagnostic_action.occurred_at AS diagnostic_action_occurred_at',
  );
  expect(sql).not.toContain('action.clinical_note');
  expect(sql).not.toContain(
    "handoff.id::text || ':' ||\n                 handoff.resolution_generation_id::text",
  );
  expect(params.slice(0, 2)).toEqual([TENANT_ID, PATIENT_UID]);
  expect(params[3]).toEqual(['pending', 'result_available', 'resolved']);
  expect(params[4]).toBe(APPOINTMENT_ID);
  expect(params[6]).toBe(PHYSICIAN_UID);
  expect(params[7]).toBe('DOCTOR');
});

test('projects the corrected-generation owner-action leaf instead of the anchor task', async () => {
  const correctedGenerationId = '40000000-0000-4000-8000-000000000002';
  const query = jest.fn(async () => [
    resultAvailableRow({
      action_task_id: 193,
      action_task_status: 'open',
      generation_id: correctedGenerationId,
      generation_snapshot_sha256: 'b'.repeat(64),
      anchor_action_task_id: 92,
      anchor_action_task_status: 'cancelled',
      anchor_generation_id: '40000000-0000-4000-8000-000000000001',
    }),
  ]);
  const result = await __testing__.listPriorAdmissionPendingResultsTx(
    { $queryRawUnsafe: query },
    {
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      appointmentId: APPOINTMENT_ID,
      appointmentStatus: 'CONFIRMED',
    },
  );

  expect(result[0].task).toEqual({ id: 193, status: 'open' });
  expect(result[0].generation_id).toBe(correctedGenerationId);
  expect(JSON.stringify(result)).not.toMatch(
    /anchor_action_task|anchor_generation_id/,
  );

  const sql = query.mock.calls[0][0];
  expect(sql).toMatch(
    /successor_action\.predecessor_owner_action_id\s*=\s*owner_action\.id/,
  );
  expect(sql).not.toMatch(
    /successor_action\.predecessor_generation_id\s*=\s*owner_action\.generation_id/,
  );
  expect(sql).toContain(
    'successor_generation.predecessor_generation_id =\n                      generation.id',
  );
  expect(sql).toContain(
    'owner_action.predecessor_generation_id IS NOT NULL',
  );
  expect(sql).toContain(
    'generation.predecessor_generation_id =\n                              owner_action.predecessor_generation_id',
  );
  expect(sql).toContain(
    'predecessor_action.generation_id =\n                              owner_action.predecessor_generation_id',
  );
  expect(sql).toContain(
    "task.metadata ->> 'task_contract' =\n                 'discharge_pending_result_action_v1'",
  );
  expect(sql).toContain(
    'ORDER BY owner_action.recorded_at DESC, owner_action.id DESC',
  );
});

test('projects a same-generation v2 reopen of a corrected generation as the exact latest leaf', async () => {
  const query = jest.fn(async () => [
    resultAvailableRow({
      action_task_id: 294,
      action_task_status: 'open',
      predecessor_action_task_id: 193,
      predecessor_action_task_status: 'completed',
      generation_id: '40000000-0000-4000-8000-000000000002',
      generation_snapshot_sha256: 'c'.repeat(64),
      diagnostic_generation_predecessor_id:
        '40000000-0000-4000-8000-000000000001',
      owner_action_predecessor_generation_id: null,
      predecessor_owner_action_id: '50000000-0000-4000-8000-000000000001',
    }),
  ]);
  const result = await __testing__.listPriorAdmissionPendingResultsTx(
    { $queryRawUnsafe: query },
    {
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      appointmentId: APPOINTMENT_ID,
      appointmentStatus: 'CONFIRMED',
    },
  );

  expect(result[0].task).toEqual({ id: 294, status: 'open' });
  expect(JSON.stringify(result)).not.toMatch(
    /predecessor_action_task|predecessor_owner_action_id/,
  );

  const sql = query.mock.calls[0][0];
  expect(sql).toContain(
    'owner_action.predecessor_owner_action_id IS NOT NULL',
  );
  expect(sql).toContain(
    'owner_action.predecessor_generation_id IS NULL',
  );
  expect(sql).toContain(
    'FROM discharge_pending_result_owner_actions AS\n                          predecessor_action',
  );
  expect(sql).toContain(
    'predecessor_action.id =\n                          owner_action.predecessor_owner_action_id',
  );
  expect(sql).toContain(
    'predecessor_action.generation_id =\n                              owner_action.generation_id',
  );
  expect(sql).toContain(
    'owner_action.predecessor_resolution_action_id\n                              IS NOT NULL',
  );
  expect(sql).toContain(
    'owner_action.rearm_source_action_id IS NOT NULL',
  );
  expect(sql).toContain(
    "rearm_action.action_kind =\n                                   'doctor_reopened'",
  );
  expect(sql).toContain(
    'rearm_action.predecessor_action_id =\n                                   predecessor_resolution.id',
  );
  expect(sql).toContain(
    'WHEN owner_action.rearm_source_action_id IS NOT NULL',
  );
  expect(sql).toContain(
    "task.metadata ->> 'predecessor_owner_action_id'\n                 IS NOT DISTINCT FROM",
  );
  expect(sql).toContain(
    "task.metadata ->> 'predecessor_resolution_action_id'\n                 IS NOT DISTINCT FROM",
  );
  expect(sql).toContain(
    "task.metadata ->> 'rearm_source_action_id'\n                 IS NOT DISTINCT FROM",
  );
  expect(sql).toMatch(
    /successor_action\.predecessor_owner_action_id\s*=\s*owner_action\.id/,
  );
  expect(sql).toContain(
    'task.parent_task_id = handoff.task_id',
  );
  expect(sql).toContain(
    'task.assigned_to_uid = handoff.named_physician_uid',
  );
});

test('uses the reassigned current task owner after a post-result physician transfer', async () => {
  const query = jest.fn(async () => [
    resultAvailableRow({
      named_physician_uid: '50000000-0000-4000-8000-000000000002',
      owner_uid: '50000000-0000-4000-8000-000000000002',
      owner_name: 'Dr Current Recipient',
      owner_role: 'DOCTOR',
      action_task_id: 193,
      action_task_status: 'open',
      owner_action_owner_uid: '50000000-0000-4000-8000-000000000001',
      current_named_physician_uid: '50000000-0000-4000-8000-000000000002',
    }),
  ]);
  const result = await __testing__.listPriorAdmissionPendingResultsTx(
    { $queryRawUnsafe: query },
    {
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      appointmentId: APPOINTMENT_ID,
      appointmentStatus: 'CONFIRMED',
    },
  );

  expect(result[0]).toMatchObject({
    named_owner: {
      uid: '50000000-0000-4000-8000-000000000002',
      display_name: 'Dr Current Recipient',
      role: 'DOCTOR',
    },
    task: { id: 193, status: 'open' },
  });
  expect(JSON.stringify(result)).not.toMatch(
    /owner_action_owner_uid|current_named_physician_uid/,
  );

  const sql = query.mock.calls[0][0];
  expect(sql).toContain(
    'task.assigned_to_uid = handoff.named_physician_uid',
  );
  expect(sql).not.toContain(
    'task.assigned_to_uid = owner_action.owner_uid',
  );
  expect(sql).toContain(
    'owner_action.owner_uid = handoff.named_physician_uid',
  );
});

test('keeps non-owner and same-owner dispositions read-only', async () => {
  const query = jest.fn(async () => [
    resultAvailableRow({ can_cross_sign: false }),
    resultAvailableRow({
      handoff_id: '30000000-0000-4000-8000-000000000002',
      can_cross_sign: false,
    }),
  ]);
  const result = await __testing__.listPriorAdmissionPendingResultsTx(
    { $queryRawUnsafe: query },
    {
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      appointmentId: APPOINTMENT_ID,
      appointmentStatus: 'CONFIRMED',
      actorUid: '21000000-0000-4000-8000-000000000009',
      actorRole: 'DOCTOR',
    },
  );

  expect(result.map(item => item.can_cross_sign)).toEqual([false, false]);
  const sql = query.mock.calls[0][0];
  expect(sql).toContain('owner.uid = $7::uuid');
  expect(sql).toContain(
    'diagnostic_action.actor_uid <> handoff.named_physician_uid',
  );
  expect(sql).toContain('tracking_task.status = ANY($10::text[])');
  expect(sql).toContain('action_task.status = ANY($10::text[])');
});

test('projects resolved normal work as read-only with exact resolution state', async () => {
  const resolutionActionId = '60000000-0000-4000-8000-000000000001';
  const resolvedAt = '2026-07-23T08:30:00.000Z';
  const query = jest.fn(async () => [
    resultAvailableRow({
      result_status: 'reviewed',
      handoff_state: 'resolved',
      resolution_action_id: resolutionActionId,
      resolved_at: resolvedAt,
      resolved_by_uid: null,
      tracking_task_status: 'completed',
      action_task_status: 'completed',
      diagnostic_classification: 'normal',
      diagnostic_action_id: null,
      diagnostic_action_kind: null,
      diagnostic_disposition: null,
      diagnostic_action_occurred_at: null,
      diagnostic_action_match_count: 0,
      can_cross_sign: false,
    }),
  ]);
  const result = await __testing__.listPriorAdmissionPendingResultsTx(
    { $queryRawUnsafe: query },
    {
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      appointmentId: APPOINTMENT_ID,
      appointmentStatus: 'CONFIRMED',
      actorUid: PHYSICIAN_UID,
      actorRole: 'DOCTOR',
    },
  );

  expect(result[0]).toMatchObject({
    handoff_state: 'resolved',
    requires_action: false,
    can_cross_sign: false,
    diagnostic_classification: 'normal',
    diagnostic_action_id: null,
    diagnostic_action_kind: null,
    diagnostic_disposition: null,
    diagnostic_action_occurred_at: null,
    resolution_action_id: resolutionActionId,
    resolved_at: resolvedAt,
    resolved_by_uid: null,
    tracking_task: { id: 91, status: 'completed' },
    action_task: { id: 92, status: 'completed' },
    task: { id: 92, status: 'completed' },
  });
});

test('projects pending handoff work without manufacturing generation evidence', async () => {
  const query = jest.fn(async () => [
    resultAvailableRow({
      result_status: 'awaiting_result',
      handoff_state: 'pending',
      owner_action_id: null,
      generation_id: null,
      generation_snapshot_sha256: null,
      diagnostic_classification: null,
      action_task_id: null,
      action_task_status: null,
      action_task_match_count: 0,
      diagnostic_action_id: null,
      diagnostic_action_kind: null,
      diagnostic_disposition: null,
      diagnostic_action_occurred_at: null,
      diagnostic_action_match_count: 0,
      can_cross_sign: false,
    }),
  ]);
  const result = await __testing__.listPriorAdmissionPendingResultsTx(
    { $queryRawUnsafe: query },
    {
      tenantId: TENANT_ID,
      patientUid: PATIENT_UID,
      appointmentId: APPOINTMENT_ID,
      appointmentStatus: 'CONFIRMED',
      actorUid: PHYSICIAN_UID,
      actorRole: 'DOCTOR',
    },
  );

  expect(result[0]).toMatchObject({
    handoff_state: 'pending',
    requires_action: false,
    can_cross_sign: false,
    generation_id: null,
    generation_snapshot_sha256: null,
    diagnostic_classification: null,
    diagnostic_action_id: null,
    diagnostic_action_kind: null,
    diagnostic_disposition: null,
    diagnostic_action_occurred_at: null,
    tracking_task: { id: 91, status: 'in_progress' },
    action_task: null,
    task: { id: 91, status: 'in_progress' },
  });
});

test.each(['CANCELLED', 'NO_SHOW', 'RESCHEDULED'])(
  'excludes %s appointments without reading prior-admission work',
  async (appointmentStatus) => {
    const query = jest.fn();
    await expect(
      __testing__.listPriorAdmissionPendingResultsTx(
        { $queryRawUnsafe: query },
        {
          tenantId: TENANT_ID,
          patientUid: PATIENT_UID,
          appointmentId: APPOINTMENT_ID,
          appointmentStatus,
        },
      ),
    ).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  },
);

test('fails closed when result availability has ambiguous exact action tasks', async () => {
  const query = jest.fn(async () => [
    resultAvailableRow({ action_task_match_count: 2 }),
  ]);
  await expect(
    __testing__.listPriorAdmissionPendingResultsTx(
      { $queryRawUnsafe: query },
      {
        tenantId: TENANT_ID,
        patientUid: PATIENT_UID,
        appointmentId: APPOINTMENT_ID,
        appointmentStatus: 'CONFIRMED',
      },
    ),
  ).rejects.toMatchObject({
    statusCode: 409,
    code: 'OP_FOLLOW_UP_PENDING_RESULT_TASK_AMBIGUOUS',
  });
});

test('fails closed when result availability has no exact current action task', async () => {
  const query = jest.fn(async () => [
    resultAvailableRow({
      action_task_id: null,
      action_task_status: null,
      action_task_match_count: 0,
    }),
  ]);
  await expect(
    __testing__.listPriorAdmissionPendingResultsTx(
      { $queryRawUnsafe: query },
      {
        tenantId: TENANT_ID,
        patientUid: PATIENT_UID,
        appointmentId: APPOINTMENT_ID,
        appointmentStatus: 'CONFIRMED',
      },
    ),
  ).rejects.toMatchObject({
    statusCode: 409,
    code: 'OP_FOLLOW_UP_PENDING_RESULT_TASK_AMBIGUOUS',
  });
});

test('fails closed when signed doctor-disposition evidence is ambiguous', async () => {
  const query = jest.fn(async () => [
    resultAvailableRow({ diagnostic_action_match_count: 2 }),
  ]);
  await expect(
    __testing__.listPriorAdmissionPendingResultsTx(
      { $queryRawUnsafe: query },
      {
        tenantId: TENANT_ID,
        patientUid: PATIENT_UID,
        appointmentId: APPOINTMENT_ID,
        appointmentStatus: 'CONFIRMED',
      },
    ),
  ).rejects.toMatchObject({
    statusCode: 409,
    code: 'OP_FOLLOW_UP_PENDING_RESULT_DISPOSITION_AMBIGUOUS',
  });
});
