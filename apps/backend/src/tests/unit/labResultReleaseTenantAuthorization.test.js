import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const recordClinicalAuditEventMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn();
const resolveCurrentHumanActorTxMock = jest.fn();

const __prismaDefaultMock = {
  $queryRawUnsafe: queryRawUnsafeMock,
};
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  circuitBreakerStatus: () => ({ open: false, consecutiveFailures: 0 }),
  default: __prismaDefaultMock,
  setTenantTx: async (_tenantId, fn) => fn(__prismaDefaultMock),
  setTenant: async (_tenantId, fn) => fn(__prismaDefaultMock),
  runTenantScopedTransaction: async (_client, _guc, fn) => fn(__prismaDefaultMock),
  pickTenantClient: () => __prismaDefaultMock,
  isTenantTransactionClient: () => true,
}));

jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordClinicalAuditEvent: recordClinicalAuditEventMock,
  recordCanonicalClinicalEvent: recordCanonicalClinicalEventMock,
  currentCanonicalTransactionRevision: jest.fn().mockResolvedValue(1),
}));

jest.unstable_mockModule('../../services/workflow/workflowHumanOwnerService.js', () => ({
  resolveCurrentHumanActorTx: resolveCurrentHumanActorTxMock,
}));

const {
  setResultReleaseHold,
  releaseResultNow,
} = await import('../../services/portal/portalAccessService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_UID = '11111111-1111-4111-8111-111111111111';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';

describe('lab result release tenant predicates', () => {
  beforeEach(() => {
    queryRawUnsafeMock.mockReset();
    recordClinicalAuditEventMock.mockReset();
    recordCanonicalClinicalEventMock.mockReset().mockResolvedValue({
      timeline: { id: 'timeline-1' },
      audit: { id: 'audit-1' },
    });
    resolveCurrentHumanActorTxMock.mockReset().mockResolvedValue({
      uid: ACTOR_UID,
      role: 'DOCTOR',
      queueRole: 'DOCTOR',
      rawRole: 'DOCTOR',
    });
  });

  it('sets release hold only for a result inside the caller tenant', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 44,
        patient_uid: PATIENT_UID,
        test_name: 'Hemoglobin',
        signed_off_at: new Date(),
        release_hold: false,
      }])
      .mockResolvedValueOnce([{ id: 44, release_hold: true }]);

    await setResultReleaseHold(44, {
      hold: true,
      reason: 'doctor review',
    }, {
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
      tenantId: TENANT_ID,
    });

    const load = queryRawUnsafeMock.mock.calls[0];
    expect(load[0]).toMatch(/WHERE id = \$1::int[\s\S]*tenant_id = \$2::uuid/);
    expect(load.slice(1)).toEqual([44, TENANT_ID]);

    const update = queryRawUnsafeMock.mock.calls[1];
    expect(update[0]).toMatch(/WHERE id = \$1::int[\s\S]*tenant_id = \$5::uuid/);
    expect(update[1]).toBe(44);
    expect(update[5]).toBe(TENANT_ID);

    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, resourceId: '44' }),
      { db: __prismaDefaultMock },
    );
  });

  it('early-releases only signed-off results inside the caller tenant', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: 45,
        patient_uid: PATIENT_UID,
        test_name: 'Troponin',
        signed_off_at: new Date(),
        release_hold: true,
      }])
      .mockResolvedValueOnce([{ id: 45, release_hold: false }])
      .mockResolvedValueOnce([]);

    await releaseResultNow(45, {
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
      tenantId: TENANT_ID,
    });

    const update = queryRawUnsafeMock.mock.calls[1];
    expect(update[0]).toMatch(/WHERE id = \$1::int[\s\S]*tenant_id = \$2::uuid/);
    expect(update.slice(1)).toEqual([45, TENANT_ID, true, undefined]);
  });
});
