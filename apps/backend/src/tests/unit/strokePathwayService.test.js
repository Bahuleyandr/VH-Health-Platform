import { jest } from '@jest/globals';

const queryUnsafeMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn(async () => ({ timeline: null, audit: null }));
const hasActivePrivilegeMock = jest.fn(async () => ({ allowed: true, privilege_key: 'stroke_thrombolysis_approver' }));

const prismaMock = { $queryRawUnsafe: queryUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: prismaMock,
  setTenantTx: async (_tenantId, fn) => fn(prismaMock),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
}));

jest.unstable_mockModule('../../services/staff/credentialingService.js', () => ({
  hasActivePrivilege: hasActivePrivilegeMock,
}));

const stroke = await import('../../services/clinical/strokePathwayService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const PATIENT_UID = '11111111-1111-4111-8111-111111111111';
const ENCOUNTER_ID = '22222222-2222-4222-8222-222222222222';
const STAFF_UID = '33333333-3333-4333-8333-333333333333';

function enabledSettings(overrides = {}) {
  return {
    tenant_id: TENANT_ID,
    enabled: true,
    clock_definition_source: 'Owner stroke clock SOP',
    clock_definition_version: '2026.07',
    nihss_source: 'Owner NIHSS SOP',
    nihss_version: '2026.07',
    thrombolysis_protocol_source: 'Owner thrombolysis SOP',
    thrombolysis_protocol_version: '2026.07',
    thrombolysis_approver_privilege_key: 'stroke_thrombolysis_approver',
    door_to_ct_target_minutes: 20,
    door_to_needle_target_minutes: 60,
    thrombolysis_protocol_attachment_refs: [],
    nihss_attachment_refs: [],
    ...overrides,
  };
}

function activationRow(overrides = {}) {
  return {
    id: 41,
    activation_uid: '44444444-4444-4444-8444-444444444444',
    tenant_id: TENANT_ID,
    patient_uid: PATIENT_UID,
    encounter_id: ENCOUNTER_ID,
    status: 'active',
    door_time_at: '2026-07-08T10:00:00.000Z',
    activated_at: '2026-07-08T10:01:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  queryUnsafeMock.mockReset();
  recordCanonicalClinicalEventMock.mockClear();
  hasActivePrivilegeMock.mockReset();
  hasActivePrivilegeMock.mockResolvedValue({ allowed: true, privilege_key: 'stroke_thrombolysis_approver' });
  stroke.__testing__.cacheDelete(TENANT_ID);
});

describe('strokePathwayService helpers', () => {
  it('computes NIHSS total as the arithmetic sum of operator item scores', () => {
    expect(stroke.computeNihssTotal([
      { item: 'loc', score: 1 },
      { item: 'gaze', score: 0 },
      { item: 'motor_arm_left', score: 3 },
      { item: 'language', score: 2 },
    ])).toBe(6);
    expect(stroke.computeNihssTotal({
      loc: 1,
      gaze: { score: 0 },
      motor_arm_left: { score: 3 },
      language: 2,
    })).toBe(6);
  });

  it('rejects non-numeric NIHSS item scores', () => {
    expect(() => stroke.computeNihssTotal([{ item: 'loc', score: 'unknown' }]))
      .toThrow(/non-negative integer/);
  });

  it('validates activation clock order', () => {
    expect(() => stroke.validateActivationClock({
      last_known_well_at: '2026-07-08T10:05:00.000Z',
      door_time_at: '2026-07-08T10:00:00.000Z',
      activated_at: '2026-07-08T10:01:00.000Z',
    })).toThrow(/Last-known-well/);
    expect(stroke.validateActivationClock({
      last_known_well_at: '2026-07-08T09:30:00.000Z',
      arrived_at: '2026-07-08T09:55:00.000Z',
      door_time_at: '2026-07-08T10:00:00.000Z',
      activated_at: '2026-07-08T10:01:00.000Z',
    })).toMatchObject({ doorTimeAt: '2026-07-08T10:00:00.000Z' });
  });

  it('enforces activation status transitions', () => {
    expect(stroke.assertActivationStatusTransition('active', 'imaging')).toBe('imaging');
    expect(() => stroke.assertActivationStatusTransition('closed', 'imaging'))
      .toThrow(/Invalid state transition/);
  });
});

describe('strokePathwayService fail-closed gates', () => {
  it('fails NIHSS sign-off when source/version metadata is absent', async () => {
    queryUnsafeMock.mockResolvedValueOnce([enabledSettings({ nihss_source: null, nihss_version: null })]);

    await expect(stroke.recordNihssAssessment({
      tenantId: TENANT_ID,
      activationId: 41,
      itemScores: [{ score: 1 }],
      signoffStatus: 'signed',
      actorUid: STAFF_UID,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'STROKE_NIHSS_SOURCE_REQUIRED',
    });
    expect(queryUnsafeMock).toHaveBeenCalledTimes(1);
  });

  it('fails thrombolysis approval when owner privilege key is not configured', async () => {
    queryUnsafeMock.mockResolvedValueOnce([enabledSettings({ thrombolysis_approver_privilege_key: null })]);

    await expect(stroke.recordThrombolysisDecision({
      tenantId: TENANT_ID,
      activationId: 41,
      decisionStatus: 'approved',
      actorUid: STAFF_UID,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'STROKE_THROMBOLYSIS_PRIVILEGE_NOT_CONFIGURED',
    });
    expect(hasActivePrivilegeMock).not.toHaveBeenCalled();
  });

  it('fails thrombolysis approval when the approver lacks the configured active privilege', async () => {
    queryUnsafeMock.mockResolvedValueOnce([enabledSettings()]);
    hasActivePrivilegeMock.mockResolvedValueOnce({
      allowed: false,
      reason: 'privilege_not_held',
      privilege_key: 'stroke_thrombolysis_approver',
    });

    await expect(stroke.recordThrombolysisDecision({
      tenantId: TENANT_ID,
      activationId: 41,
      decisionStatus: 'approved',
      actorUid: STAFF_UID,
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'STROKE_THROMBOLYSIS_PRIVILEGE_REQUIRED',
    });
    expect(hasActivePrivilegeMock).toHaveBeenCalledWith(
      STAFF_UID,
      'stroke_thrombolysis_approver',
      { tenantId: TENANT_ID },
    );
  });
});

describe('strokePathwayService writes', () => {
  it('captures eligibility and contraindication payloads without embedding protocol criteria', async () => {
    queryUnsafeMock
      .mockResolvedValueOnce([enabledSettings()])
      .mockResolvedValueOnce([activationRow()])
      .mockResolvedValueOnce([{ id: 9, decision_status: 'pending_approval' }]);

    const result = await stroke.recordThrombolysisDecision({
      tenantId: TENANT_ID,
      activationId: 41,
      decisionStatus: 'pending_approval',
      eligibilityPayload: { ownerChecklist: { documented: true } },
      contraindicationPayload: { ownerExclusions: ['recent_surgery_reviewed'] },
      dosePayload: { ownerDoseSheetRef: 'r2://tenant/stroke-dose.pdf' },
      patientFamilyDocumentation: { discussed_with: 'daughter' },
      actorUid: STAFF_UID,
    });

    expect(result.id).toBe(9);
    const [sql, ...params] = queryUnsafeMock.mock.calls[2];
    expect(sql).toMatch(/INSERT INTO stroke_thrombolysis_decisions/);
    expect(JSON.parse(params[6])).toEqual({ ownerChecklist: { documented: true } });
    expect(JSON.parse(params[7])).toEqual({ ownerExclusions: ['recent_surgery_reviewed'] });
    expect(JSON.parse(params[8])).toEqual({ ownerDoseSheetRef: 'r2://tenant/stroke-dose.pdf' });
    expect(JSON.parse(params[13])).toEqual({ discussed_with: 'daughter' });
    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'stroke.thrombolysis.decision',
        sourceTable: 'stroke_thrombolysis_decisions',
      }),
      expect.objectContaining({ db: prismaMock }),
    );
  });
});
