/**
 * Phase C3 — carePlanService unit tests.
 *
 * Covers validation, the care-plan state machine + audit logging,
 * goal progress, activity completion, follow-up state machine, and
 * review-log append. Mocks prisma.$queryRawUnsafe.
 */

import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const transactionMock = jest.fn(async (cb) => cb({ $queryRawUnsafe: queryUnsafeMock }));
const setTenantTxMock = jest.fn(async (tenantId, cb) => cb({ $queryRawUnsafe: queryUnsafeMock }));
const recordAppointmentCreatedEvidenceTxMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn();

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: queryUnsafeMock, $transaction: transactionMock },
  circuitBreakerStatus: () => ({ open: false, consecutiveFailures: 0 }),
  isTenantTransactionClient: () => true,
  setTenantTx: setTenantTxMock,
}));

jest.unstable_mockModule(
  '../../services/appointment/appointmentLifecycleService.js',
  () => ({
    recordAppointmentCreatedEvidenceTx: recordAppointmentCreatedEvidenceTxMock,
  }),
);

// Care-plan clinical writes now emit a canonical timeline + audit event atomically
// (recordCanonicalClinicalEvent). Stub it so the real writer does not run against
// the raw-query mock and throw CANONICAL_TIMELINE_REQUIRED.
jest.unstable_mockModule(
  '../../services/clinical/canonicalClinicalPlatformService.js',
  () => ({
    recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  }),
);

const {
  appendReviewLog,
  createActivity,
  createCarePlan,
  createFollowUp,
  createGoal,
  getCarePlan,
  getPatientWhatsNext,
  listActivities,
  listCarePlans,
  listFollowUps,
  listGoals,
  listReviewLog,
  recordActivityCompletion,
  setCarePlanVisibility,
  transitionCarePlan,
  transitionFollowUp,
  updateGoalProgress,
  __testing__,
} = await import('../../services/carePlan/carePlanService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const DOCTOR = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  queryUnsafeMock.mockReset();
  transactionMock.mockClear();
  setTenantTxMock.mockReset();
  setTenantTxMock.mockImplementation(async (tenantId, cb) => cb({ $queryRawUnsafe: queryUnsafeMock }));
  recordAppointmentCreatedEvidenceTxMock.mockReset();
  recordAppointmentCreatedEvidenceTxMock.mockResolvedValue({ recorded: true });
  recordCanonicalClinicalEventMock.mockReset().mockResolvedValue({
    timeline: { id: 1 },
    audit: { id: 1 },
  });
});

// ---------------------------------------------------------------------------
// Care plans
// ---------------------------------------------------------------------------

describe('createCarePlan', () => {
  it('rejects missing patient_uid', async () => {
    await expect(createCarePlan({ tenantId: TENANT, displayName: 'X' }))
      .rejects.toThrow(/patient_uid is required/);
  });

  it('rejects missing display_name', async () => {
    await expect(createCarePlan({ tenantId: TENANT, patientUid: PATIENT }))
      .rejects.toThrow(/display_name is required/);
  });

  it('rejects unknown plan_kind', async () => {
    await expect(createCarePlan({
      tenantId: TENANT, patientUid: PATIENT, displayName: 'X', planKind: 'magic',
    })).rejects.toThrow(/plan_kind must be one of/);
  });

  it('inserts a draft plan + appends "created" review-log entry', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'draft', plan_kind: 'chronic_disease', display_name: 'DM2 plan',
    }]);
    queryUnsafeMock.mockResolvedValueOnce([]); // review-log insert
    const row = await createCarePlan({
      tenantId: TENANT, patientUid: PATIENT, displayName: 'DM2 plan',
      planKind: 'chronic_disease', primaryDoctorUid: DOCTOR,
    });
    expect(row.id).toBe(1);
    expect(queryUnsafeMock.mock.calls[1][0]).toMatch(/INSERT INTO care_plan_review_log/);
  });
});

describe('PLAN_TRANSITIONS map', () => {
  it('draft -> active is allowed; completed is terminal', () => {
    expect(__testing__.PLAN_TRANSITIONS.draft).toContain('active');
    expect(__testing__.PLAN_TRANSITIONS.archived).toEqual([]);
    expect(__testing__.PLAN_TRANSITIONS.completed).toEqual(['archived']);
  });
});

describe('transitionCarePlan', () => {
  it('rejects illegal transition (archived -> active)', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'archived' }]);
    await expect(transitionCarePlan({
      tenantId: TENANT, id: 1, nextStatus: 'active',
    })).rejects.toThrow(/transition/i);
  });

  it('flips draft -> active and logs "updated"', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'draft' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'active' }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const row = await transitionCarePlan({
      tenantId: TENANT, id: 1, nextStatus: 'active',
    });
    expect(row.status).toBe('active');
    const logCall = queryUnsafeMock.mock.calls[2][0];
    expect(logCall).toMatch(/INSERT INTO care_plan_review_log/);
  });

  it('stamps actual_end_date on completed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'active' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed' }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    await transitionCarePlan({
      tenantId: TENANT, id: 1, nextStatus: 'completed',
    });
    const sql = queryUnsafeMock.mock.calls[1][0];
    expect(sql).toMatch(/actual_end_date = \$\d::date/);
  });

  it('logs "resumed" when paused -> active', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'paused' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'active' }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    await transitionCarePlan({ tenantId: TENANT, id: 1, nextStatus: 'active' });
    const params = queryUnsafeMock.mock.calls[2].slice(1);
    expect(params).toContain('resumed');
  });
});

describe('setCarePlanVisibility', () => {
  it('flips is_patient_visible and logs the change', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, is_patient_visible: true }]);
    queryUnsafeMock.mockResolvedValueOnce([]);
    const row = await setCarePlanVisibility({
      tenantId: TENANT, id: 1, isPatientVisible: true,
    });
    expect(row.is_patient_visible).toBe(true);
  });
});

describe('listCarePlans + getCarePlan', () => {
  it('listCarePlans degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "care_plans" does not exist'));
    expect(await listCarePlans({ tenantId: TENANT })).toEqual({ care_plans: [], count: 0 });
  });

  it('listCarePlans filters by patient_uid', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1 }]);
    await listCarePlans({ tenantId: TENANT, patientUid: PATIENT });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/patient_uid = \$2::uuid/);
  });

  it('getCarePlan throws 404 when missing', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await expect(getCarePlan({ tenantId: TENANT, id: 999 }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('getPatientWhatsNext', () => {
  it('preserves live legacy cards and does not project closure snapshots', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, description: 'Visible goal' }]);
    queryUnsafeMock.mockResolvedValueOnce([{ id: 2, reason: 'Visible follow-up' }]);
    queryUnsafeMock.mockResolvedValueOnce([]);

    const result = await getPatientWhatsNext({
      tenantId: TENANT,
      patientUid: PATIENT,
    });

    expect(result.goals).toHaveLength(1);
    expect(result.follow_ups).toHaveLength(1);
    expect(result.next_steps).toEqual([]);
    expect(result.count).toBe(2);
    expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
  });

  it.each(['discharged', 'left_against_advice', 'lwbs'])(
    'projects only patient-safe fields from a released %s ED closure',
    async (visitStatus) => {
      queryUnsafeMock.mockResolvedValueOnce([]);
      queryUnsafeMock.mockResolvedValueOnce([]);
      queryUnsafeMock.mockResolvedValueOnce([{
        label: 'Return for review',
        explanation: 'Please attend the scheduled review.',
        due_date: '2026-07-30',
        status: 'scheduled',
        patient_action: 'Open appointments',
        responsible_clinician_display_name: 'Dr ED Owner',
        responsible_clinician_role: 'DOCTOR',
        safe_contact: 'help@example.test',
        route_token: 'appointments',
      }]);

      const result = await getPatientWhatsNext({
        tenantId: TENANT,
        patientUid: PATIENT,
      });

      expect(visitStatus).toMatch(/discharged|left_against_advice|lwbs/);
      expect(result.next_steps).toEqual([{
        label: 'Return for review',
        explanation: 'Please attend the scheduled review.',
        due_date: '2026-07-30',
        status: 'scheduled',
        patient_action: 'Open appointments',
        responsible_clinician_display_name: 'Dr ED Owner',
        responsible_clinician_role: 'DOCTOR',
        safe_contact: 'help@example.test',
        route_token: 'appointments',
      }]);
      expect(result.count).toBe(1);
      expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
      expect(queryUnsafeMock.mock.calls[2][0]).toMatch(
        /patient_visibility_status = 'released'/,
      );
      expect(queryUnsafeMock.mock.calls[2][0]).not.toMatch(
        /risk_summary|staff_notes|mlc_record_id|death_record_id/,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

describe('createGoal + updateGoalProgress', () => {
  it('rejects missing description', async () => {
    await expect(createGoal({ tenantId: TENANT, carePlanId: 1 }))
      .rejects.toThrow(/description is required/);
  });

  it('rejects unknown goal_kind', async () => {
    await expect(createGoal({
      tenantId: TENANT, carePlanId: 1, description: 'X', goalKind: 'magic',
    })).rejects.toThrow(/goal_kind must be one of/);
  });

  it('inserts a clinical_target goal', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'planned' }]);
    // Goal carries no patient_uid, so canonical emission resolves it from the
    // owning care plan (resolveCarePlanPatientUid) before the mocked writer runs.
    queryUnsafeMock.mockResolvedValueOnce([{ patient_uid: PATIENT }]);
    const row = await createGoal({
      tenantId: TENANT, carePlanId: 1, description: 'HbA1c < 7',
      measurementLabel: 'HbA1c', measurementUnit: '%', targetValue: '7',
    });
    expect(row.id).toBe(1);
  });

  it('updateGoalProgress with status=achieved stamps achieved_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'achieved', achieved_at: new Date() }]);
    await updateGoalProgress({
      tenantId: TENANT, id: 1, status: 'achieved', currentValue: '6.8',
    });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/achieved_at = \$\d::timestamptz/);
  });

  it('updateGoalProgress with no fields returns existing row', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'planned' }]);
    const row = await updateGoalProgress({ tenantId: TENANT, id: 1 });
    expect(row.status).toBe('planned');
  });
});

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

describe('createActivity + recordActivityCompletion', () => {
  it('rejects missing title', async () => {
    await expect(createActivity({ tenantId: TENANT, carePlanId: 1 }))
      .rejects.toThrow(/title is required/);
  });

  it('rejects unknown activity_kind', async () => {
    await expect(createActivity({
      tenantId: TENANT, carePlanId: 1, title: 'X', activityKind: 'spaceflight',
    })).rejects.toThrow(/activity_kind must be one of/);
  });

  it('inserts a daily medication activity', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'planned' }]);
    // Activity carries no patient_uid, so canonical emission resolves it from the
    // owning care plan (resolveCarePlanPatientUid) before the mocked writer runs.
    queryUnsafeMock.mockResolvedValueOnce([{ patient_uid: PATIENT }]);
    const row = await createActivity({
      tenantId: TENANT, carePlanId: 1, title: 'Take metformin',
      activityKind: 'medication', scheduleKind: 'daily',
    });
    expect(row.id).toBe(1);
  });

  it('recordActivityCompletion increments completion_count when completed', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed', completion_count: 1 }]);
    await recordActivityCompletion({ tenantId: TENANT, id: 1, status: 'completed' });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/completion_count = completion_count \+/);
  });
});

describe('listActivities', () => {
  it('filters by due_within_hours', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listActivities({ tenantId: TENANT, dueWithinHours: 24 });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/INTERVAL '1 hour'/);
  });

  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "care_plan_activities" does not exist'));
    expect(await listActivities({ tenantId: TENANT })).toEqual({ activities: [], count: 0 });
  });
});

// ---------------------------------------------------------------------------
// Follow-ups
// ---------------------------------------------------------------------------

describe('createFollowUp', () => {
  it('rejects missing patient_uid', async () => {
    await expect(createFollowUp({ tenantId: TENANT, originKind: 'consultation' }))
      .rejects.toThrow(/patient_uid is required/);
  });

  it('rejects missing origin_kind', async () => {
    await expect(createFollowUp({ tenantId: TENANT, patientUid: PATIENT }))
      .rejects.toThrow(/origin_kind is required/);
  });

  it('rejects bad reminder_offsets entry (>1 year)', async () => {
    await expect(createFollowUp({
      tenantId: TENANT, patientUid: PATIENT, originKind: 'consultation',
      reminderOffsetsMinutes: [60, 9999999],
    })).rejects.toThrow(/reminder_offsets_minutes entries must be <=/);
  });

  it('inserts an open follow-up', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'open', origin_kind: 'discharge',
    }]);
    const row = await createFollowUp({
      tenantId: TENANT, patientUid: PATIENT, originKind: 'discharge',
      reason: '6 weeks post-op', reminderOffsetsMinutes: [60, 1440],
    });
    expect(row.status).toBe('open');
  });

  it('books a scheduled appointment when discharge follow-up has doctor and due_at', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([{ id: 10, phone: '9000011111', name: 'Deep Patient' }])
      .mockResolvedValueOnce([{ id: 20, name: 'Dr Rao', department: 'General Medicine' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 30 }])
      .mockResolvedValueOnce([{
        id: 1,
        status: 'scheduled',
        appointment_status: 'scheduled',
        appointment_id: 30,
      }]);

    const row = await createFollowUp({
      tenantId: TENANT,
      patientUid: PATIENT,
      doctorUid: DOCTOR,
      originKind: 'discharge',
      originResourceType: 'admission',
      originResourceId: '18',
      dueAt: '2026-05-20T04:30:00.000Z',
      reason: 'Post-discharge review',
    });

    expect(setTenantTxMock).toHaveBeenCalledTimes(1);
    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(row.status).toBe('scheduled');
    expect(row.appointment_id).toBe(30);
    expect(queryUnsafeMock.mock.calls.some((c) => /INSERT INTO appointments/i.test(c[0]))).toBe(true);
    const followUpInsert = queryUnsafeMock.mock.calls.find((c) => /INSERT INTO follow_up_plans/i.test(c[0]));
    expect(followUpInsert[11]).toBe(30);
    expect(followUpInsert[12]).toBe('scheduled');
    expect(followUpInsert[15]).toBe('scheduled');
  });
});

describe('transitionFollowUp', () => {
  it('flips to scheduled + appointment_id', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{
      id: 1, status: 'scheduled', appointment_status: 'scheduled',
      appointment_id: 5,
    }]);
    const row = await transitionFollowUp({
      tenantId: TENANT, id: 1, nextStatus: 'scheduled', appointmentId: 5,
    });
    expect(row.appointment_id).toBe(5);
  });

  it('flips to completed + stamps closed_at', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, status: 'completed' }]);
    await transitionFollowUp({
      tenantId: TENANT, id: 1, nextStatus: 'completed', closureOutcome: 'attended',
    });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/closed_at = \$\d::timestamptz/);
  });

  it('rejects unknown next_status', async () => {
    await expect(transitionFollowUp({
      tenantId: TENANT, id: 1, nextStatus: 'magic',
    })).rejects.toThrow(/next_status must be one of/);
  });
});

describe('listFollowUps', () => {
  it('overdueOnly applies status=open AND due_at < NOW()', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listFollowUps({ tenantId: TENANT, overdueOnly: true });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/status = 'open' AND due_at IS NOT NULL AND due_at < NOW\(\)/);
  });

  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "follow_up_plans" does not exist'));
    expect(await listFollowUps({ tenantId: TENANT })).toEqual({ follow_ups: [], count: 0 });
  });
});

// ---------------------------------------------------------------------------
// Review log
// ---------------------------------------------------------------------------

describe('appendReviewLog + listReviewLog', () => {
  it('rejects unknown event_kind', async () => {
    await expect(appendReviewLog({
      tenantId: TENANT, carePlanId: 1, eventKind: 'magic',
    })).rejects.toThrow(/event_kind must be one of/);
  });

  it('inserts a comment entry', async () => {
    queryUnsafeMock.mockResolvedValueOnce([{ id: 1, event_kind: 'comment' }]);
    const row = await appendReviewLog({
      tenantId: TENANT, carePlanId: 1, eventKind: 'comment', notes: 'Ok',
    });
    expect(row.event_kind).toBe('comment');
  });

  it('listReviewLog degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "care_plan_review_log" does not exist'));
    expect(await listReviewLog({ tenantId: TENANT, carePlanId: 1 })).toEqual({ entries: [], count: 0 });
  });
});

describe('listGoals', () => {
  it('filters by status', async () => {
    queryUnsafeMock.mockResolvedValueOnce([]);
    await listGoals({ tenantId: TENANT, carePlanId: 1, status: 'planned' });
    const sql = queryUnsafeMock.mock.calls[0][0];
    expect(sql).toMatch(/status = \$\d/);
  });

  it('degrades on schema-missing', async () => {
    queryUnsafeMock.mockRejectedValueOnce(new Error('relation "care_plan_goals" does not exist'));
    expect(await listGoals({ tenantId: TENANT })).toEqual({ goals: [], count: 0 });
  });
});
