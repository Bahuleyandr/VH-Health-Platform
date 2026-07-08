import { jest } from '@jest/globals';

const txQueryRawUnsafeMock = jest.fn();
const readOnlyQueryRawUnsafeMock = jest.fn();
const setTenantTxMock = jest.fn();
const createTaskMock = jest.fn();
const notificationQueueMock = jest.fn();

const txClient = { $queryRawUnsafe: txQueryRawUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: { $queryRawUnsafe: jest.fn() },
  prismaReadOnly: { $queryRawUnsafe: readOnlyQueryRawUnsafeMock },
  setTenantTx: setTenantTxMock,
}));

jest.unstable_mockModule('../../services/tenant/tenantService.js', () => ({
  requireTenantId: (tenantId) => {
    if (!tenantId) throw new Error('tenant required');
    return tenantId;
  },
}));

jest.unstable_mockModule('../../services/workflow/taskService.js', () => ({
  createTask: createTaskMock,
}));

jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  notificationOutbox: { queue: notificationQueueMock },
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  getNpsDashboard,
  npsBucket,
  submitNpsResponse,
  __testing__,
} = await import('../../services/feedback/npsService.js');

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

function responseRow(overrides = {}) {
  return {
    id: '901',
    tenant_id: TENANT,
    patient_uid: PATIENT,
    feedback_id: null,
    appointment_id: 42,
    encounter_type: 'appointment',
    encounter_ref: '42',
    score: 4,
    nps_bucket: 'detractor',
    channel: 'app',
    consent_id: 12,
    comment: 'unsafe discharge process',
    comment_redaction_status: 'not_reviewed',
    comment_redaction_metadata: {},
    department_id: 7,
    department_display_name: 'Cardiology',
    doctor_id: 8,
    doctor_display_name: 'Dr Rao',
    service_line: 'Cardiology',
    submitted_at: '2026-07-08T10:00:00.000Z',
    created_at: '2026-07-08T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  txQueryRawUnsafeMock.mockReset();
  readOnlyQueryRawUnsafeMock.mockReset();
  setTenantTxMock.mockReset().mockImplementation(async (_tenantId, fn) => fn(txClient));
  createTaskMock.mockReset().mockResolvedValue({ id: 88, status: 'open' });
  notificationQueueMock.mockReset().mockResolvedValue({ id: 501, status: 'PENDING' });
});

describe('NPS buckets', () => {
  it.each([
    [0, 'detractor'],
    [6, 'detractor'],
    [7, 'passive'],
    [8, 'passive'],
    [9, 'promoter'],
    [10, 'promoter'],
  ])('classifies score %s as %s', (score, bucket) => {
    expect(npsBucket(score)).toBe(bucket);
  });

  it.each([-1, 11, 'x'])('rejects invalid score %p', (score) => {
    expect(() => npsBucket(score)).toThrow(/score must/);
  });
});

describe('submitNpsResponse', () => {
  it('stores a tenant-scoped detractor response, creates service recovery, and notifies quality owners', async () => {
    txQueryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 42,
        patient_uid: PATIENT,
        doctor_id: 8,
        doctor_user_name: 'Dr Rao',
        department: 'Cardiology',
      }])
      .mockResolvedValueOnce([{ uid: PATIENT }])
      .mockResolvedValueOnce([responseRow()]);
    readOnlyQueryRawUnsafeMock.mockResolvedValueOnce([{ id: 201 }, { id: 202 }]);

    const result = await submitNpsResponse({
      tenantId: TENANT,
      patientUid: PATIENT,
      appointmentId: 42,
      score: 4,
      consentId: 12,
      comment: 'unsafe discharge process',
      createdBy: USER,
    });

    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    const insertCall = txQueryRawUnsafeMock.mock.calls.find((call) => /INSERT INTO feedback_nps_responses/i.test(call[0]));
    expect(insertCall).toBeTruthy();
    expect(insertCall[0]).toContain('tenant_id, patient_uid');
    expect(insertCall[1]).toBe(TENANT);
    expect(insertCall[2]).toBe(PATIENT);
    expect(insertCall[7]).toBe(4);
    expect(insertCall[8]).toBe('detractor');

    expect(createTaskMock).toHaveBeenCalledTimes(1);
    expect(createTaskMock.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      taskKind: 'review',
      relatedResourceType: 'feedback_nps_response',
      relatedResourceId: '901',
      priority: 'critical',
      assignedToRole: 'QUALITY_OFFICER',
      patientUid: PATIENT,
      tx: txClient,
      onConflictResourceDoNothing: true,
    });

    expect(readOnlyQueryRawUnsafeMock.mock.calls[0][0]).toMatch(/role IN \('QUALITY_OFFICER', 'ADMIN', 'SUPER_ADMIN'\)/);
    expect(notificationQueueMock).toHaveBeenCalledTimes(2);
    expect(notificationQueueMock.mock.calls[0][0]).toMatchObject({
      type: 'in_app',
      recipientId: 201,
      title: 'NPS service recovery required',
      data: {
        tenant_id: TENANT,
        kind: 'service_recovery',
        task_id: 88,
        nps_response_id: '901',
      },
    });
    expect(result.response.nps_bucket).toBe('detractor');
    expect(result.recoveryTask).toEqual({ id: 88, status: 'open' });
    expect(result.recoveryNotification).toHaveLength(2);
  });

  it('does not create service recovery for a promoter response', async () => {
    txQueryRawUnsafeMock
      .mockResolvedValueOnce([{ uid: PATIENT }])
      .mockResolvedValueOnce([responseRow({
        appointment_id: null,
        score: 10,
        nps_bucket: 'promoter',
        comment: null,
      })]);

    const result = await submitNpsResponse({
      tenantId: TENANT,
      patientUid: PATIENT,
      score: 10,
      createdBy: USER,
    });

    expect(createTaskMock).not.toHaveBeenCalled();
    expect(notificationQueueMock).not.toHaveBeenCalled();
    expect(result.response.nps_bucket).toBe('promoter');
    expect(result.recoveryTask).toBeNull();
  });
});

describe('getNpsDashboard', () => {
  it('converts Decimal-like values and preserves sample-size suppression flags', async () => {
    readOnlyQueryRawUnsafeMock
      .mockResolvedValueOnce([{
        response_count: 6n,
        request_count: 12,
        promoter_count: 4,
        passive_count: 1,
        detractor_count: 1,
        nps_score: { toNumber: () => 50 },
        response_rate: { toNumber: () => 50 },
        minimum_sample_size: 5,
        sample_visible: true,
      }])
      .mockResolvedValueOnce([{
        day: '2026-07-08',
        response_count: 2,
        request_count: 5,
        promoter_count: 1,
        passive_count: 0,
        detractor_count: 1,
        nps_score: null,
        response_rate: { toNumber: () => 40 },
        minimum_sample_size: 5,
        sample_visible: false,
      }])
      .mockResolvedValueOnce([{
        dimension_type: 'department',
        dimension_key: '7',
        dimension_label: 'Cardiology',
        response_count: 2,
        request_count: 0,
        promoter_count: 1,
        passive_count: 0,
        detractor_count: 1,
        nps_score: null,
        response_rate: null,
        minimum_sample_size: 5,
        sample_visible: false,
      }])
      .mockResolvedValueOnce([]);

    const dashboard = await getNpsDashboard({ tenantId: TENANT, days: 30, minimumSampleSize: 5 });

    expect(dashboard.overall.nps_score).toBe(50);
    expect(dashboard.overall.response_rate).toBe(50);
    expect(dashboard.trend[0]).toMatchObject({
      day: '2026-07-08',
      response_count: 2,
      nps_score: null,
      response_rate: 40,
      sample_visible: false,
    });
    expect(dashboard.breakdowns[0]).toMatchObject({
      dimension_type: 'department',
      dimension_key: '7',
      sample_visible: false,
    });
  });

  it('keeps the metric shaper from serializing Decimal internals', () => {
    expect(__testing__.shapeMetricRow({
      response_count: 1n,
      nps_score: { toNumber: () => -12.5 },
      response_rate: { toNumber: () => 33.3 },
      sample_visible: false,
    })).toMatchObject({
      response_count: 1,
      nps_score: -12.5,
      response_rate: 33.3,
      sample_visible: false,
    });
  });
});
