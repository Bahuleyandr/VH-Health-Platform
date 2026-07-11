import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn(async () => ({
  timeline: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  audit: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
}));
const emitCodeStemiMock = jest.fn();
const prismaMock = { $queryRawUnsafe: queryUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenant: async (_tenantId, fn) => fn(prismaMock),
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.unstable_mockModule('../../utils/websocket/realtimeEmitter.js', () => ({
  emitCodeStemi: emitCodeStemiMock,
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
}));

const stemi = await import('../../services/clinical/stemiPathwayService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const ENCOUNTER_ID = '22222222-2222-4222-8222-222222222222';
const STAFF_UID = '33333333-3333-4333-8333-333333333333';

function activationRow(overrides = {}) {
  return {
    id: 41,
    activation_uid: '44444444-4444-4444-8444-444444444444',
    tenant_id: TENANT_ID,
    patient_uid: PATIENT_UID,
    encounter_id: ENCOUNTER_ID,
    activation_source: 'clinician',
    status: 'lab_notified',
    ...overrides,
  };
}

function enabledSettings() {
  return {
    tenant_id: TENANT_ID,
    enabled: true,
    clock_definition_source: 'Owner STEMI clock SOP',
    clock_definition_version: '2026.07',
    clock_definition_attachment_refs: [],
    activation_criteria_source: 'Owner STEMI activation SOP',
    activation_criteria_version: '2026.07',
    activation_criteria: {},
    notification_role_codes: ['CATH_LAB_INCHARGE', 'CATH_LAB_STAFF'],
  };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  recordCanonicalClinicalEventMock.mockClear();
  emitCodeStemiMock.mockClear();
  stemi.__testing__.settingsCacheDelete(TENANT_ID);
});

describe('stemiPathwayService activation clocks', () => {
  it('derives door_time_at from the linked ED visit for the exact staff action payload', () => {
    const input = {
      patient_uid: PATIENT_UID,
      emergency_visit_id: 17,
      activation_source: 'clinician',
      activated_at: '2026-07-11T10:05:00.000Z',
    };

    expect(stemi.resolveActivationClock(input, {
      activationSource: 'clinician',
      edArrivalAt: '2026-07-11T10:00:00.000Z',
    })).toMatchObject({
      doorTimeAt: '2026-07-11T10:00:00.000Z',
      activatedAt: '2026-07-11T10:05:00.000Z',
    });
  });

  it('rejects an explicit door clock that disagrees with the ED visit', () => {
    expect(() => stemi.resolveActivationClock({
      activation_source: 'clinician',
      door_time_at: '2026-07-11T10:01:00.000Z',
      activated_at: '2026-07-11T10:05:00.000Z',
    }, {
      activationSource: 'clinician',
      edArrivalAt: '2026-07-11T10:00:00.000Z',
    })).toThrow(/does not match/);
  });

  it('keeps the door clock pending for a pre-hospital activation', () => {
    expect(stemi.validateActivationClock({
      activation_source: 'prehospital_handover',
      activated_at: '2026-07-11T09:30:00.000Z',
    })).toMatchObject({ doorTimeAt: null });
  });

  it('requires door time for a non-prehospital activation without an ED arrival fallback', () => {
    expect(() => stemi.validateActivationClock({
      activation_source: 'clinician',
      activated_at: '2026-07-11T09:30:00.000Z',
    })).toThrow(/door_time_at is required/);
  });

  it('binds ISO clocks to raw SQL as Date values without local-time shifting', () => {
    const value = stemi.__testing__.dbTimestamp('2026-07-11T10:00:00.000Z');
    expect(value).toBeInstanceOf(Date);
    expect(value.toISOString()).toBe('2026-07-11T10:00:00.000Z');
  });
});

describe('stemiPathwayService lifecycle', () => {
  it('enforces the ordered activation lifecycle', () => {
    expect(stemi.assertActivationTransition('activated', 'lab_notified')).toBe('lab_notified');
    expect(stemi.assertActivationTransition('lab_notified', 'in_lab')).toBe('in_lab');
    expect(stemi.assertActivationTransition('in_lab', 'device_deployed')).toBe('device_deployed');
    expect(stemi.assertActivationTransition('device_deployed', 'completed')).toBe('completed');
    expect(() => stemi.assertActivationTransition('activated', 'completed'))
      .toThrow(/Invalid state transition/);
  });

  it('requires a stand-down reason', () => {
    expect(() => stemi.assertActivationTransition('lab_notified', 'stood_down'))
      .toThrow(/stand_down_reason is required/);
    expect(stemi.assertActivationTransition('lab_notified', 'stood_down', 'False activation'))
      .toBe('stood_down');
  });

  it('requires milestone events for clinical progress instead of direct status mutation', async () => {
    await expect(stemi.updateActivationStatus({
      tenantId: TENANT_ID,
      id: 41,
      status: 'completed',
      actorUid: STAFF_UID,
    })).rejects.toMatchObject({ code: 'STEMI_STATUS_EVENT_REQUIRED' });
    expect(queryUnsafeMock).not.toHaveBeenCalled();
  });
});

describe('stemiPathwayService trusted evidence and fan-out inputs', () => {
  it('keeps canonical milestone identity fields authoritative over client payload fields', () => {
    expect(stemi.buildPathwayCanonicalPayload({
      activation_id: 999,
      sequence_number: 999,
      event_type: 'disposition',
      workflow_sla_instance_id: 'spoofed',
      note: 'clinician supplied',
    }, {
      activationId: 41,
      sequenceNumber: 3,
      eventType: 'ecg_acquired',
      workflowSlaInstanceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    })).toEqual({
      activation_id: 41,
      sequence_number: 3,
      event_type: 'ecg_acquired',
      workflow_sla_instance_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      note: 'clinician supplied',
    });
  });

  it('accepts only canonical cath-lab roles for notification fan-out', () => {
    expect(stemi.__testing__.normalizeCathNotificationRoleCodes([
      'CATH_LAB_INCHARGE',
      'CATH_LAB_STAFF',
    ])).toEqual(['CATH_LAB_INCHARGE', 'CATH_LAB_STAFF']);
    expect(() => stemi.__testing__.normalizeCathNotificationRoleCodes(['HOUSEKEEPING_STAFF']))
      .toThrow(/only cath-lab roles/);
  });
});

describe('stemiPathwayService clinical context integrity', () => {
  test.each([
    ['cross-patient', [{ id: ENCOUNTER_ID, patient_uid: '99999999-9999-4999-8999-999999999999' }], 'STEMI_ENCOUNTER_CONTEXT_MISMATCH'],
    ['cross-tenant or missing', [], 'STEMI_ENCOUNTER_NOT_FOUND'],
  ])('rejects a %s encounter before any activation write', async (_label, encounterRows, code) => {
    queryUnsafeMock
      .mockResolvedValueOnce([enabledSettings()])
      .mockResolvedValueOnce([{ uid: PATIENT_UID }])
      .mockResolvedValueOnce(encounterRows);

    await expect(stemi.createActivation({
      tenantId: TENANT_ID,
      actorUid: STAFF_UID,
      actorRole: 'DOCTOR',
      patient_uid: PATIENT_UID,
      encounter_id: ENCOUNTER_ID,
      activation_source: 'clinician',
      door_time_at: '2026-07-11T10:00:00.000Z',
      activated_at: '2026-07-11T10:01:00.000Z',
    })).rejects.toMatchObject({ code });

    expect(queryUnsafeMock).toHaveBeenCalledTimes(3);
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });
});

describe('stemiPathwayService team acknowledgement', () => {
  it('records acknowledgement only for a durable notified team member', async () => {
    const notification = {
      id: 55,
      activation_id: 41,
      staff_uid: STAFF_UID,
      role_code: 'CATH_LAB_STAFF',
      notification_status: 'notified',
    };
    queryUnsafeMock
      .mockResolvedValueOnce([activationRow()])
      .mockResolvedValueOnce([notification])
      .mockResolvedValueOnce([{ ...notification, notification_status: 'acknowledged' }]);

    const result = await stemi.acknowledgeActivation({
      tenantId: TENANT_ID,
      activationId: 41,
      actorUid: STAFF_UID,
      actorRole: 'CATH_LAB_STAFF',
      acknowledgementNote: 'En route',
    });

    expect(result.notification_status).toBe('acknowledged');
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'stemi.team.acknowledged',
        sourceTable: 'stemi_team_notifications',
        actorUid: STAFF_UID,
      }),
      expect.objectContaining({ db: prismaMock }),
    );
    expect(emitCodeStemiMock).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'team-acknowledged',
      tenantId: TENANT_ID,
    }));
  });

  it('rejects acknowledgement by a user outside the notified team', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([activationRow()])
      .mockResolvedValueOnce([]);

    await expect(stemi.acknowledgeActivation({
      tenantId: TENANT_ID,
      activationId: 41,
      actorUid: STAFF_UID,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'STEMI_TEAM_MEMBERSHIP_REQUIRED',
    });
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });
});
