import { jest } from '@jest/globals';

const queryRawUnsafeMock = jest.fn();
const recordClinicalAuditEventMock = jest.fn();
const recordCanonicalClinicalEventMock = jest.fn();
const resolveCurrentHumanActorTxMock = jest.fn();
const publishEventMock = jest.fn();

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

jest.unstable_mockModule('../../services/events/eventOutboxService.js', () => ({
  publishEvent: publishEventMock,
}));

const {
  setResultReleaseHold,
  releaseResultNow,
  setStructuredDiagnosticReleaseHold,
  releaseStructuredDiagnosticResultNow,
  getDiagnosticGenerationReleaseDecisionTx,
} = await import('../../services/portal/portalAccessService.js');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_UID = '11111111-1111-4111-8111-111111111111';
const PATIENT_UID = '22222222-2222-4222-8222-222222222222';
const GENERATION_ID = '33333333-3333-4333-8333-333333333333';

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
    publishEventMock.mockReset().mockResolvedValue({ id: 1 });
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

  it('authorizes a structured-release actor before looking up the generation', async () => {
    resolveCurrentHumanActorTxMock.mockRejectedValueOnce(new Error('forbidden'));

    await expect(setStructuredDiagnosticReleaseHold(GENERATION_ID, {
      hold: true,
      reason: 'Specialist review',
    }, {
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
      tenantId: TENANT_ID,
    })).rejects.toThrow('forbidden');

    expect(queryRawUnsafeMock).not.toHaveBeenCalled();
  });

  it('uses tenant and version predicates when holding a structured result', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        generation_id: GENERATION_ID,
        patient_uid: PATIENT_UID,
        source_kind: 'radiology_report',
        source_version: 1n,
        classification: 'normal',
        signed_at: new Date(),
        release_hold: false,
        state_version: 3n,
        superseded: false,
        normal_auto_closed: false,
        doctor_disposition_recorded: false,
      }])
      .mockResolvedValueOnce([{
        release_hold: true,
        release_hold_reason: 'Specialist review',
        state_version: 4n,
      }]);

    const result = await setStructuredDiagnosticReleaseHold(GENERATION_ID, {
      hold: true,
      reason: 'Specialist review',
    }, {
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
      tenantId: TENANT_ID,
    });

    const update = queryRawUnsafeMock.mock.calls[1];
    expect(update[0]).toMatch(/tenant_id = \$1::uuid[\s\S]*generation_id = \$2::uuid[\s\S]*state_version = \$6::bigint/);
    expect(update.slice(1)).toEqual([
      TENANT_ID,
      GENERATION_ID,
      true,
      ACTOR_UID,
      'Specialist review',
      3n,
    ]);
    expect(result).toMatchObject({
      generation_id: GENERATION_ID,
      release_hold: true,
      state_version: 4,
    });
  });

  it('does not hide a structured result after it is patient-visible', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      generation_id: GENERATION_ID,
      patient_uid: PATIENT_UID,
      source_kind: 'radiology_report',
      source_version: 1n,
      classification: 'normal',
      signed_at: new Date(),
      release_hold: false,
      state_version: 2n,
      superseded: false,
      normal_auto_closed: true,
      doctor_disposition_recorded: false,
      patient_visible: true,
    }]);

    await expect(setStructuredDiagnosticReleaseHold(GENERATION_ID, {
      hold: true,
      reason: 'Retract an already visible result',
    }, {
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({
      code: 'DIAGNOSTIC_RELEASE_REVERSAL_POLICY_REQUIRED',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('blocks abnormal patient release until doctor disposition exists', async () => {
    queryRawUnsafeMock.mockResolvedValueOnce([{
      generation_id: GENERATION_ID,
      patient_uid: PATIENT_UID,
      source_kind: 'anatomical_pathology_report',
      source_version: 1n,
      classification: 'abnormal',
      signed_at: new Date(),
      release_hold: false,
      state_version: 1n,
      superseded: false,
      normal_auto_closed: false,
      doctor_disposition_recorded: false,
    }]);

    await expect(releaseStructuredDiagnosticResultNow(GENERATION_ID, {
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
      tenantId: TENANT_ID,
    })).rejects.toMatchObject({
      code: 'DIAGNOSTIC_RELEASE_DOCTOR_DISPOSITION_REQUIRED',
    });

    expect(queryRawUnsafeMock).toHaveBeenCalledTimes(1);
    expect(recordCanonicalClinicalEventMock).not.toHaveBeenCalled();
  });

  it('publishes normal release eligibility only after the atomic release evidence', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        generation_id: GENERATION_ID,
        patient_uid: PATIENT_UID,
        source_kind: 'radiology_report',
        source_version: 1n,
        classification: 'normal',
        signed_at: new Date(),
        release_hold: true,
        state_version: 1n,
        superseded: false,
        normal_auto_closed: false,
        doctor_disposition_recorded: false,
      }])
      .mockResolvedValueOnce([{
        release_hold: false,
        released_to_patient_at: new Date(),
        state_version: 2n,
      }]);

    await releaseStructuredDiagnosticResultNow(GENERATION_ID, {
      actorUid: ACTOR_UID,
      actorRole: 'DOCTOR',
      tenantId: TENANT_ID,
    });

    expect(recordCanonicalClinicalEventMock).toHaveBeenCalledTimes(1);
    expect(publishEventMock).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'diagnostic.result.release_became_eligible',
      aggregateId: GENERATION_ID,
      patientUid: PATIENT_UID,
      tenantId: TENANT_ID,
    }));
  });

  it('fails closed as unsupported when a structured generation has no release row', async () => {
    queryRawUnsafeMock
      .mockResolvedValueOnce([{
        id: GENERATION_ID,
        patient_uid: PATIENT_UID,
        source_kind: 'radiology_report',
        classification: 'normal',
        item_count: 1,
      }])
      .mockResolvedValueOnce([{
        generation_id: null,
        release_visible: false,
      }]);

    const decision = await getDiagnosticGenerationReleaseDecisionTx({
      tx: __prismaDefaultMock,
      tenantId: TENANT_ID,
      generationId: GENERATION_ID,
    });

    expect(decision).toMatchObject({
      outcome: 'unsupported_source',
      release_state_present: false,
    });
  });
});
