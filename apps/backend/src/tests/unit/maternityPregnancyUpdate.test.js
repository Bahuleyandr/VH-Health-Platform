import { jest } from '@jest/globals';

const TENANT = '00000000-0000-4000-8000-000000000001';
const PATIENT = '11111111-1111-4111-8111-111111111111';
const OTHER_PATIENT = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';

const queryRawUnsafeMock = jest.fn();
const setTenantTxMock = jest.fn(async (_tenantId, callback) => callback(txMock));
const currentCanonicalTransactionRevisionMock = jest.fn(async () => '8124');
const recordCanonicalClinicalEventMock = jest.fn(async () => ({
  timeline: { id: 1 },
  audit: { id: 2 },
}));

const txMock = { $queryRawUnsafe: queryRawUnsafeMock };

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: txMock,
  isTenantTransactionClient: (client) => client === txMock,
  pickTenantClient: () => txMock,
  runTenantScopedTransaction: async (_client, _tenantId, callback) => callback(txMock),
  setTenant: async (_tenantId, callback) => callback(txMock),
  setTenantTx: setTenantTxMock,
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  currentCanonicalTransactionRevision: currentCanonicalTransactionRevisionMock,
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  recordClinicalAuditEvent: jest.fn(),
}));

jest.unstable_mockModule('../../services/clinical/canonicalOperationalBridgeService.js', () => ({
  safeCanonical: jest.fn(),
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

jest.unstable_mockModule('../../utils/clinical/vitalSignMonitor.js', () => ({
  checkVitalAnomalies: jest.fn(),
}));

jest.unstable_mockModule('../../utils/dateUtils.js', () => ({
  istDateString: () => '2026-06-02',
}));

jest.unstable_mockModule('../../utils/notifications/notificationOutbox.js', () => ({
  default: {},
}));

jest.unstable_mockModule('../../utils/notifications/clinicalAlertFanout.js', () => ({
  queueClinicalAlertFanout: jest.fn(),
}));

jest.unstable_mockModule('../../services/maternity/newbornIdentity.js', () => ({
  assertExclusiveNewbornLink: jest.fn(),
  assertNewbornIdentitySubject: jest.fn(),
  IDENTITY_MINTING_OUTCOMES: new Set(),
  NEWBORN_OUTCOMES: new Set(),
  newbornIdentityInvalid: jest.fn(),
  newbornIdentityRequired: jest.fn(),
}));

jest.unstable_mockModule('../../services/staff/credentialingService.js', () => ({
  assertPrivilegeForGate: jest.fn(),
  isGateEnabled: () => false,
  privilegeKey: (value) => value,
}));

const { updatePregnancy } = await import('../../services/maternity/maternityService.js');

function pregnancyRow(overrides = {}) {
  return {
    id: 41,
    tenant_id: TENANT,
    patient_uid: PATIENT,
    lmp_date: new Date('2026-01-01T00:00:00.000Z'),
    edd_date: new Date('2026-10-08T00:00:00.000Z'),
    gravida: 2,
    parity: 1,
    living_children: 1,
    abortions: 0,
    blood_group: 'O',
    rh_factor: 'positive',
    high_risk: false,
    high_risk_reasons: null,
    notes: null,
    status: 'ongoing',
    updated_at: new Date('2026-06-01T00:00:00.000Z'),
    ...overrides,
  };
}

function arrangeUpdate({ updatedRows = [pregnancyRow({
  lmp_date: new Date('2026-01-15T00:00:00.000Z'),
  high_risk: true,
  high_risk_reasons: ['prior pre-eclampsia'],
  updated_at: new Date('2026-06-02T00:00:00.000Z'),
})], lockedPatientUid = PATIENT } = {}) {
  queryRawUnsafeMock
    .mockResolvedValueOnce([{ patient_uid: PATIENT }])
    .mockResolvedValueOnce([{
      uid: PATIENT,
      is_pregnant: false,
      pregnancy_lmp_date: null,
    }])
    .mockResolvedValueOnce([pregnancyRow({ patient_uid: lockedPatientUid })])
    .mockResolvedValueOnce(updatedRows);
  if (updatedRows.length) {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      is_pregnant: true,
      pregnancy_lmp_date: updatedRows[0].lmp_date,
    }]);
  }
}

beforeEach(() => {
  queryRawUnsafeMock.mockReset();
  setTenantTxMock.mockClear();
  currentCanonicalTransactionRevisionMock.mockClear();
  recordCanonicalClinicalEventMock.mockReset().mockResolvedValue({
    timeline: { id: 1 },
    audit: { id: 2 },
  });
});

describe('maternityService.updatePregnancy', () => {
  it('derives tenant and patient truth from locked stored rows and emits one atomic canonical revision', async () => {
    const updated = pregnancyRow({
      lmp_date: new Date('2026-01-15T00:00:00.000Z'),
      high_risk: true,
      high_risk_reasons: ['prior pre-eclampsia'],
      updated_at: new Date('2026-06-02T00:00:00.000Z'),
    });
    arrangeUpdate({ updatedRows: [updated] });

    await expect(updatePregnancy({
      tenantId: TENANT,
      id: 41,
      patient_uid: OTHER_PATIENT,
      actor_uid: OTHER_PATIENT,
      actor_role: 'SUPER_ADMIN',
      lmp_date: '2026-01-15',
      high_risk: true,
      high_risk_reasons: ['prior pre-eclampsia'],
    }, {
      actorUid: ACTOR,
      actorRole: 'NURSING_STAFF',
    })).resolves.toEqual(updated);

    expect(setTenantTxMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
    expect(queryRawUnsafeMock.mock.calls[0][0]).toMatch(/FROM maternity_pregnancies/);
    expect(queryRawUnsafeMock.mock.calls[0].slice(1)).toEqual([TENANT, 41]);
    expect(queryRawUnsafeMock.mock.calls[1][0]).toMatch(/FROM users[\s\S]*role = 'PATIENT'[\s\S]*FOR UPDATE/);
    expect(queryRawUnsafeMock.mock.calls[1].slice(1)).toEqual([TENANT, PATIENT]);
    expect(queryRawUnsafeMock.mock.calls[2][0]).toMatch(/FROM maternity_pregnancies[\s\S]*FOR UPDATE/);
    expect(queryRawUnsafeMock.mock.calls[3][0]).toMatch(/IS DISTINCT FROM/);
    expect(queryRawUnsafeMock.mock.calls[4][0]).toMatch(/UPDATE users/);
    expect(queryRawUnsafeMock.mock.calls[4].slice(1)).toEqual([PATIENT, TENANT]);

    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledTimes(1);
    const [event, options] = recordCanonicalClinicalEventMock.mock.calls[0];
    expect(event).toMatchObject({
      tenantId: TENANT,
      patientUid: PATIENT,
      eventType: 'maternity.pregnancy_updated',
      eventStatus: 'ongoing',
      sourceTable: 'maternity_pregnancies',
      sourceId: 41,
      resourceType: 'pregnancy',
      resourceId: 41,
      actorUid: ACTOR,
      actorRole: 'NURSING_STAFF',
      visibleToPatient: false,
      payload: {
        pregnancy_id: 41,
        updated_fields: ['lmp_date', 'high_risk', 'high_risk_reasons'],
      },
      metadata: {
        updated_fields: ['lmp_date', 'high_risk', 'high_risk_reasons'],
      },
    });
    expect(event).not.toHaveProperty('patient_uid');
    expect(event.payload).not.toHaveProperty('actor_uid');
    expect(event.timelineIdempotencyKey).toMatch(
      /^maternity_pregnancies:41:updated:[a-f0-9]{32}:tx:8124$/,
    );
    expect(options).toEqual({ db: txMock, strict: true });
  });

  it.each([
    '1suffix',
    ' 1',
    '1 ',
    '1.0',
    '+1',
    '-1',
    '0',
    '01',
    '2147483648',
  ])('rejects non-canonical or out-of-int4 pregnancy id %p before SQL', async (id) => {
    await expect(updatePregnancy({
      tenantId: TENANT,
      id,
      notes: 'must not reach SQL',
    }, {
      actorUid: ACTOR,
      actorRole: 'NURSING_STAFF',
    })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/positive integer/i),
    });

    expect(setTenantTxMock).not.toHaveBeenCalled();
    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('treats an exact retry as a no-op without projection, revision, or canonical writes', async () => {
    arrangeUpdate({ updatedRows: [] });

    const result = await updatePregnancy({
      tenantId: TENANT,
      id: 41,
      lmp_date: '2026-01-01',
    }, {
      actorUid: ACTOR,
      actorRole: 'NURSING_STAFF',
    });

    expect(result).toEqual(pregnancyRow());
    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(4);
    expect(currentCanonicalTransactionRevisionMock).not.toHaveBeenCalled();
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('fails closed if the stored patient assignment changes while locks are acquired', async () => {
    arrangeUpdate({ lockedPatientUid: OTHER_PATIENT });

    await expect(updatePregnancy({
      tenantId: TENANT,
      id: 41,
      notes: 'corrected',
    }, {
      actorUid: ACTOR,
      actorRole: 'NURSING_STAFF',
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'MATERNITY_PREGNANCY_PATIENT_CHANGED',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(3);
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('propagates canonical failure so the tenant transaction rolls back the correction and projection', async () => {
    arrangeUpdate();
    const failure = Object.assign(new Error('canonical timeline required'), {
      code: 'CANONICAL_TIMELINE_REQUIRED',
    });
    recordCanonicalClinicalEventMock.mockRejectedValueOnce(failure);

    await expect(updatePregnancy({
      tenantId: TENANT,
      id: 41,
      lmp_date: '2026-01-15',
    }, {
      actorUid: ACTOR,
      actorRole: 'NURSING_STAFF',
    })).rejects.toMatchObject({ code: 'CANONICAL_TIMELINE_REQUIRED' });

    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'maternity.pregnancy_updated' }),
      { db: txMock, strict: true },
    );
  });
});
