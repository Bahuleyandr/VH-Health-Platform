import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const createTaskMock = jest.fn();

const prismaMock = { $queryRawUnsafe: queryUnsafeMock };
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
  setTenant: async (_tenantId, fn) => fn(prismaMock),
}));
jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  createTask: createTaskMock,
}));

const {
  closeTeleconsultFollowUpLoop,
  createTeleconsultFollowUpFromCompletion,
  normalizeTeleconsultCompletionFacts,
  __testing__,
} = await import('../../services/engagement/teleconsultFollowUpService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const DOCTOR = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

function settings(overrides = {}) {
  return {
    id: 1,
    tenant_id: TENANT,
    enabled: true,
    consent_type: 'teleconsult_followup',
    patient_route: '/appointments',
    secure_message_route: '/portal/messages',
    staff_task_role: 'DOCTOR',
    trigger_defaults: __testing__.DEFAULT_TRIGGER_DEFAULTS,
    metadata: {},
    ...overrides,
  };
}

function consult(overrides = {}) {
  return {
    id: 99,
    tenant_id: TENANT,
    appointment_id: 777,
    patient_uid: PATIENT,
    doctor_uid: DOCTOR,
    status: 'completed',
    scheduled_start: '2026-07-08T10:00:00.000Z',
    actual_end: '2026-07-08T10:30:00.000Z',
    metadata: {},
    ...overrides,
  };
}

function loop(overrides = {}) {
  return {
    id: 5001,
    tenant_id: TENANT,
    source_type: 'teleconsultation',
    source_ref: '99',
    appointment_id: 777,
    patient_uid: PATIENT,
    owner_uid: DOCTOR,
    loop_type: 'clinician_follow_up_due_date',
    status: 'scheduled',
    consent_type: 'teleconsult_followup',
    due_policy: {},
    due_at: '2026-07-12T09:00:00.000Z',
    safe_link_path: '/appointments',
    metadata: {},
  };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  createTaskMock.mockReset();
  createTaskMock.mockResolvedValue({ id: 7001, status: 'open' });
});

describe('normalizeTeleconsultCompletionFacts', () => {
  it('requires signed or clinician-approved source facts', () => {
    expect(() => normalizeTeleconsultCompletionFacts({ prescription_created: true }))
      .toThrow(/signed or clinician-approved/i);
  });

  it('rejects unreviewed AI draft and transcript fields', () => {
    expect(() => normalizeTeleconsultCompletionFacts({
      approved: true,
      ai_note_draft: { plan: { follow_up: 'tomorrow' } },
    })).toThrow(/AI draft or transcript/i);

    expect(() => normalizeTeleconsultCompletionFacts({
      source_status: 'signed',
      transcript: 'raw patient chat',
    })).toThrow(/AI draft or transcript/i);
  });

  it('normalizes approved completion facts', () => {
    const facts = normalizeTeleconsultCompletionFacts({
      source_status: 'signed',
      follow_up_due_date: '2026-07-12T09:00:00.000Z',
      investigation_order_count: 2,
    });
    expect(facts.follow_up_due_at).toBe('2026-07-12T09:00:00.000Z');
    expect(facts.investigation_ordered).toBe(true);
  });
});

describe('createTeleconsultFollowUpFromCompletion', () => {
  it('honors clinician-selected due date before default triggers and gates patient outreach on consent', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([settings()])
      .mockResolvedValueOnce([consult()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 42, consent_type: 'teleconsult_followup' }])
      .mockResolvedValueOnce([loop()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 8001,
        step_kind: 'staff_task',
        status: 'scheduled',
        staff_task_id: 7001,
        result: { task_id: 7001 },
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 8002,
        step_kind: 'patient_outreach',
        status: 'scheduled',
        suppression_reason: null,
        safe_link_path: '/appointments',
        result: {
          consent_id: 42,
          route: '/appointments',
          message_policy: 'generic_follow_up_only',
        },
      }])
      .mockResolvedValueOnce([]);

    const result = await createTeleconsultFollowUpFromCompletion({
      tenantId: TENANT,
      teleconsultationId: 99,
      actorUid: ACTOR,
      completionFacts: {
        source_status: 'signed',
        follow_up_due_date: '2026-07-12T09:00:00.000Z',
        investigation_ordered: true,
      },
    });

    expect(result.created).toBe(true);
    expect(result.loop.loop_type).toBe('clinician_follow_up_due_date');
    expect(result.consent.status).toBe('fresh');
    expect(result.steps[1]).toMatchObject({
      step_kind: 'patient_outreach',
      status: 'scheduled',
      safe_link_path: '/appointments',
    });
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      taskKind: 'follow_up',
      dueAt: '2026-07-12T09:00:00.000Z',
      relatedResourceType: 'engagement_follow_up_loop',
      onConflictResourceDoNothing: true,
    }));
    const insertLoopCall = queryUnsafeMock.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO engagement_follow_up_loops'));
    expect(insertLoopCall).toBeTruthy();
    expect(insertLoopCall).toContain('clinician_follow_up_due_date');
    expect(insertLoopCall).toContain('2026-07-12T09:00:00.000Z');
  });

  it('suppresses patient outreach when consent is missing but still creates the staff task', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([settings()])
      .mockResolvedValueOnce([consult()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([loop({ loop_type: 'secure_message_fallback', safe_link_path: '/portal/messages' })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 8001, step_kind: 'staff_task', status: 'scheduled', staff_task_id: 7001 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 8002,
        step_kind: 'secure_message_fallback',
        status: 'suppressed',
        suppression_reason: 'teleconsult_followup_consent_missing',
        safe_link_path: '/portal/messages',
      }])
      .mockResolvedValueOnce([]);

    const result = await createTeleconsultFollowUpFromCompletion({
      tenantId: TENANT,
      teleconsultationId: 99,
      completionFacts: {
        approved: true,
        secure_message_fallback_unresolved: true,
      },
    });

    expect(result.created).toBe(true);
    expect(result.task).toMatchObject({ id: 7001 });
    expect(result.consent).toEqual({
      status: 'missing',
      consent_type: 'teleconsult_followup',
    });
    expect(result.steps[1]).toMatchObject({
      step_kind: 'secure_message_fallback',
      status: 'suppressed',
      suppression_reason: 'teleconsult_followup_consent_missing',
      safe_link_path: '/portal/messages',
    });
  });

  it('fails closed when the tenant follow-up flag is not enabled', async () => {
    queryUnsafeMock.mockResolvedValueOnce([settings({ enabled: false })]);

    const result = await createTeleconsultFollowUpFromCompletion({
      tenantId: TENANT,
      teleconsultationId: 99,
      completionFacts: { approved: true },
    });

    expect(result).toEqual({ created: false, reason: 'tenant_follow_up_flag_disabled' });
    expect(createTaskMock).not.toHaveBeenCalled();
  });
});

describe('closeTeleconsultFollowUpLoop', () => {
  it('closes active loops and writes an audit event', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 5001, status: 'scheduled' }])
      .mockResolvedValueOnce([{
        ...loop(),
        status: 'completed',
        close_reason: 'patient_completed_follow_up',
        closed_by: ACTOR,
      }])
      .mockResolvedValueOnce([]);

    const result = await closeTeleconsultFollowUpLoop({
      tenantId: TENANT,
      id: 5001,
      nextStatus: 'completed',
      closeReason: 'patient_completed_follow_up',
      actorUid: ACTOR,
    });

    expect(result).toMatchObject({
      id: 5001,
      status: 'completed',
      close_reason: 'patient_completed_follow_up',
    });
    const eventCall = queryUnsafeMock.mock.calls.find((call) =>
      String(call[0]).includes('INSERT INTO engagement_follow_up_events'));
    expect(eventCall).toBeTruthy();
    expect(eventCall).toContain('closed');
    expect(eventCall).toContain('scheduled');
    expect(eventCall).toContain('completed');
    expect(eventCall).toContain('patient_completed_follow_up');
  });
});
